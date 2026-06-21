import type { Finding, ScaffoldSuggestion } from "../drift/schemas.js";
import type { DetectionResult } from "../drift/detector.js";
import type { TemplateType } from "../templates/types.js";
import { TEMPLATES } from "../templates/types.js";

const SEVERITY_EMOJI: Record<Finding["severity"], string> = {
  high: "🔴",
  medium: "🟡",
  low: "🔵",
};

export interface ConfluenceOptions {
  confluenceConfigured: boolean;
  confluenceUrl?: string;
  confluenceSpaceKey?: string;
  confluenceEmpty?: boolean;
  confluenceSuggestions?: import("../drift/schemas.js").ScaffoldSuggestion[];
  createdPages?: { title: string; url: string; wasUpdated?: boolean }[];
  plannedTemplates?: TemplateType[];      // shown as preview on PR before merge
  dryRunPages?: { title: string; content: string }[];  // preview mode: content shown, not created
}

export function buildPRComment(result: DetectionResult, isFirstRun: boolean, confluence?: ConfluenceOptions): string {
  const parts: string[] = [];

  if (isFirstRun) {
    const confluenceNote = buildConfluenceOnboardingNote(confluence);
    parts.push(
      `> **DocDrift is now watching your docs.** It checks: API signature changes, renamed endpoints, added/removed parameters, and config changes that affect documented behavior. It does not rewrite docs automatically — you decide what to apply.${confluenceNote}\n`,
    );
  }

  parts.push(`## DocDrift Analysis\n`);

  if (result.scaffoldSuggestions !== undefined) {
    parts.push(...buildScaffoldSection(result.scaffoldSuggestions));
    if (confluence?.confluenceEmpty) {
      parts.push(buildConfluenceEmptyNote(confluence));
    }
    const durationSec = (result.durationMs / 1000).toFixed(1);
    parts.push(`\n---\n_Analyzed in ${durationSec}s · ${result.modelId}_`);
    return parts.join("\n");
  }

  if (result.findings.length === 0) {
    parts.push(
      `✅ **No drift detected.** DocDrift checked ${result.checkedDocFiles.length} doc file${result.checkedDocFiles.length !== 1 ? "s" : ""} — all up to date.\n`,
    );
    if (confluence?.confluenceEmpty) {
      parts.push(buildConfluenceEmptyNote(confluence));
    }
  } else {
    const high = result.findings.filter((f) => f.severity === "high").length;
    const medium = result.findings.filter((f) => f.severity === "medium").length;
    const low = result.findings.filter((f) => f.severity === "low").length;

    const counts = [
      high > 0 ? `${high} high` : null,
      medium > 0 ? `${medium} medium` : null,
      low > 0 ? `${low} low` : null,
    ]
      .filter(Boolean)
      .join(", ");

    parts.push(`**${result.findings.length} documentation drift finding${result.findings.length !== 1 ? "s" : ""} detected** (${counts})\n`);

    for (const finding of result.findings) {
      parts.push(formatFinding(finding));
    }

    if (confluence?.confluenceEmpty) {
      parts.push(buildConfluenceEmptyNote(confluence));
    }
  }

  const durationSec = (result.durationMs / 1000).toFixed(1);
  parts.push(
    `\n---\n_Analyzed in ${durationSec}s · ${result.checkedDocFiles.length} doc file${result.checkedDocFiles.length !== 1 ? "s" : ""} checked · ${result.modelId}_`,
  );

  return parts.join("\n");
}

function buildConfluenceEmptyNote(confluence: ConfluenceOptions): string {
  const spaceLabel = confluence.confluenceSpaceKey ? ` \`${confluence.confluenceSpaceKey}\`` : "";
  const spaceUrl = confluence.confluenceUrl ?? "your Confluence space";

  // Dry-run mode: show full content, don't create
  if (confluence.dryRunPages && confluence.dryRunPages.length > 0) {
    const parts: string[] = [
      ``,
      `---`,
      `## 📋 Confluence Page Preview (dry-run mode)`,
      ``,
      `DocDrift would create ${confluence.dryRunPages.length} page${confluence.dryRunPages.length !== 1 ? "s" : ""} in your Confluence space${spaceLabel}. Set \`confluence-preview: false\` to create them automatically.\n`,
    ];
    for (const p of confluence.dryRunPages) {
      parts.push(`<details><summary>📄 ${p.title}</summary>\n\n${p.content}\n\n</details>\n`);
    }
    return parts.join("\n");
  }

  // Pages were auto-created (or updated) — show links
  if (confluence.createdPages && confluence.createdPages.length > 0) {
    const pages = confluence.createdPages;
    const created = pages.filter((p) => !p.wasUpdated);
    const updated = pages.filter((p) => p.wasUpdated);
    const parts: string[] = [``, `---`, `## 📘 Confluence Pages`, ``];

    if (created.length > 0) {
      parts.push(`**Created** ${created.length} new page${created.length !== 1 ? "s" : ""} in your Confluence space${spaceLabel}:\n`);
      for (const p of created) parts.push(`- 📄 [${p.title}](${p.url})`);
    }
    if (updated.length > 0) {
      if (created.length > 0) parts.push(``);
      parts.push(`**Updated** ${updated.length} existing page${updated.length !== 1 ? "s" : ""}:\n`);
      for (const p of updated) parts.push(`- 🔄 [${p.title}](${p.url})`);
    }
    return parts.join("\n");
  }

  // PR preview — planned templates, not yet created
  if (confluence.plannedTemplates && confluence.plannedTemplates.length > 0) {
    const labels = confluence.plannedTemplates.map((t) => TEMPLATES[t]?.label ?? t);
    const parts: string[] = [
      ``,
      `---`,
      `## 📋 DocDrift will create when this PR merges`,
      ``,
      `Based on the changes in this PR, DocDrift will create the following Confluence pages in space${spaceLabel}:\n`,
    ];
    for (const label of labels) parts.push(`- 📄 ${label}`);
    parts.push(`\n_Override with \`doc-template: architecture|api-reference|setup-guide|release-notes|migration-guide\` or preview with \`confluence-preview: true\`._`);
    return parts.join("\n");
  }

  if (!confluence.confluenceSuggestions || confluence.confluenceSuggestions.length === 0) {
    return `\n> **No Confluence pages found** for these changes in space${spaceLabel}. Consider adding documentation at ${spaceUrl}.`;
  }

  const suggestions = confluence.confluenceSuggestions;
  const parts: string[] = [
    ``,
    `---`,
    `## 📘 Suggested Confluence Pages`,
    ``,
    `No pages found in your Confluence space${spaceLabel} matching these changes. DocDrift suggests creating ${suggestions.length} page${suggestions.length !== 1 ? "s" : ""} in [${spaceUrl}](${spaceUrl}):\n`,
  ];

  for (const s of suggestions) {
    parts.push(`### 📄 ${s.filename}`);
    parts.push(`_${s.rationale}_\n`);
    if (s.content.trim()) {
      parts.push(s.content);
    }
    parts.push(``);
  }

  return parts.join("\n");
}

function buildConfluenceOnboardingNote(confluence?: ConfluenceOptions): string {
  if (!confluence) {
    return (
      `\n>\n> **Have a Confluence space?** Add \`confluence-url\` and \`confluence-api-token\` to your DocDrift workflow to automatically sync drift fixes to your Confluence pages.`
    );
  }
  if (confluence.confluenceConfigured && confluence.confluenceUrl) {
    return `\n>\n> **Confluence sync enabled** — DocDrift will update pages at \`${confluence.confluenceUrl}\` when drift is applied.`;
  }
  return (
    `\n>\n> **Have a Confluence space?** Add \`confluence-url\` and \`confluence-api-token\` to your DocDrift workflow to automatically sync drift fixes to your Confluence pages.`
  );
}

function buildScaffoldSection(suggestions: ScaffoldSuggestion[]): string[] {
  if (suggestions.length === 0) {
    return [
      `📄 **No existing documentation found.** DocDrift could not generate scaffold suggestions for this diff — the changes may not contain enough signal. Consider adding a README to get started.\n`,
    ];
  }

  const parts: string[] = [
    `📄 **No existing documentation found.** DocDrift generated ${suggestions.length} starter doc stub${suggestions.length !== 1 ? "s" : ""} based on this PR. Review and commit the ones that fit.\n`,
  ];

  for (const suggestion of suggestions) {
    parts.push(formatScaffoldSuggestion(suggestion));
  }

  return parts;
}

function formatScaffoldSuggestion(suggestion: ScaffoldSuggestion): string {
  return [
    `### 📝 \`${suggestion.filename}\``,
    `_${suggestion.rationale}_`,
    ``,
    `\`\`\`markdown`,
    suggestion.content,
    `\`\`\``,
    ``,
  ].join("\n");
}

function formatFinding(finding: Finding): string {
  const emoji = SEVERITY_EMOJI[finding.severity];
  const confidence = Math.round(finding.confidence * 100);

  return [
    `### ${emoji} ${finding.issue}`,
    `**File:** \`${finding.docFile}\` · **Confidence:** ${confidence}%`,
    ``,
    finding.explanation,
    ``,
    `**Suggested update:**`,
    `\`\`\`diff`,
    finding.suggestedUpdate,
    `\`\`\``,
    ``,
  ].join("\n");
}
