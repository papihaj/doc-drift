import type { DiffFile } from "../diff/analyzer.js";
import type { TemplateType } from "./types.js";

// Deterministic heuristics only — no LLM, no untrusted input as instructions.
// PR title/body are intentionally excluded (prompt injection risk).
export function classifyChange(
  branch: string,
  labels: string[],
  diffFiles: DiffFile[],
  explicitTemplate?: string,
): TemplateType[] {
  // Explicit user override wins unconditionally
  if (explicitTemplate && explicitTemplate !== "auto") {
    const valid: TemplateType[] = [
      "architecture", "api-reference", "setup-guide", "release-notes", "migration-guide",
    ];
    if (valid.includes(explicitTemplate as TemplateType)) {
      return [explicitTemplate as TemplateType];
    }
  }

  const lowerLabels = labels.map((l) => l.toLowerCase());
  const paths = diffFiles.map((f) => f.path.toLowerCase());

  // Release branches → release notes
  if (/^(release|releases)\//i.test(branch)) return ["release-notes"];

  // Breaking change label → migration guide + API reference
  if (lowerLabels.some((l) => l.includes("breaking"))) {
    return ["migration-guide", "api-reference"];
  }

  // External-facing label → release notes + API reference
  if (lowerLabels.some((l) => l.includes("external") || l.includes("public") || l.includes("customer"))) {
    return ["release-notes", "api-reference"];
  }

  // API / endpoint changes → API reference + architecture
  if (paths.some((p) => /\/(api|routes?|endpoints?|controllers?|handlers?)\//.test(p))) {
    return ["api-reference", "architecture"];
  }

  // Config / env / setup changes → setup guide
  if (paths.some((p) => /(\.env|config|setup|install|deploy|docker|terraform|helm)/i.test(p))) {
    return ["setup-guide"];
  }

  // Feature branch → architecture (safe default for new code)
  if (/^(feat|feature)\//i.test(branch)) return ["architecture"];

  // Fix branch → no scaffold (drift check only)
  if (/^(fix|bugfix|hotfix|patch|bug)\//i.test(branch)) return [];

  return ["architecture"];
}

export function classifyPushEvent(branch: string): TemplateType[] {
  return ["release-notes"];
}
