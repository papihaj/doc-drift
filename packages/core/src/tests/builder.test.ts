import { describe, it, expect } from "vitest";
import { buildPRComment } from "../suggestions/builder.js";
import type { DetectionResult } from "../drift/detector.js";

const baseResult: DetectionResult = {
  findings: [],
  checkedDocFiles: ["docs/api.md", "README.md"],
  chunksAnalyzed: 1,
  modelId: "claude-sonnet-4-6",
  durationMs: 4200,
};

const findingResult: DetectionResult = {
  ...baseResult,
  findings: [
    {
      docFile: "docs/api.md",
      codeFile: "src/api/users.ts",
      issue: "createUser signature changed",
      explanation: "The role parameter is now required.",
      suggestedUpdate: "-createUser(name)\n+createUser(name, role)",
      severity: "high",
      confidence: 0.95,
    },
    {
      docFile: "docs/auth.md",
      codeFile: "src/auth/session.ts",
      issue: "Session TTL changed from 24h to 1h",
      explanation: "Session tokens now expire faster.",
      suggestedUpdate: "-TTL: 24 hours\n+TTL: 1 hour",
      severity: "medium",
      confidence: 0.82,
    },
  ],
};

describe("buildPRComment", () => {
  it("shows clean message when no findings", () => {
    const comment = buildPRComment(baseResult, false);
    expect(comment).toContain("No drift detected");
    expect(comment).toContain("2 doc files");
  });

  it("shows finding count when drift found", () => {
    const comment = buildPRComment(findingResult, false);
    expect(comment).toContain("2 documentation drift findings");
  });

  it("includes severity emoji for high findings", () => {
    const comment = buildPRComment(findingResult, false);
    expect(comment).toContain("🔴");
  });

  it("includes severity emoji for medium findings", () => {
    const comment = buildPRComment(findingResult, false);
    expect(comment).toContain("🟡");
  });

  it("includes copyable diff block for each finding", () => {
    const comment = buildPRComment(findingResult, false);
    expect(comment).toContain("```diff");
    expect(comment).toContain("createUser(name, role)");
  });

  it("includes analysis metadata footer", () => {
    const comment = buildPRComment(baseResult, false);
    expect(comment).toContain("4.2s");
    expect(comment).toContain("claude-sonnet-4-6");
  });

  it("shows first-run onboarding message when isFirstRun is true", () => {
    const comment = buildPRComment(baseResult, true);
    expect(comment).toContain("DocDrift is now watching");
  });

  it("does not show onboarding message on subsequent runs", () => {
    const comment = buildPRComment(baseResult, false);
    expect(comment).not.toContain("DocDrift is now watching");
  });

  it("includes confidence percentage", () => {
    const comment = buildPRComment(findingResult, false);
    expect(comment).toContain("95%");
  });
});

describe("buildPRComment — scaffold mode", () => {
  const scaffoldResult: DetectionResult = {
    findings: [],
    checkedDocFiles: [],
    chunksAnalyzed: 1,
    modelId: "claude-sonnet-4-6",
    durationMs: 3100,
    scaffoldSuggestions: [
      {
        filename: "README.md",
        content: "# Project\n\nA user management API.",
        rationale: "No README found; top-level overview needed",
      },
    ],
  };

  const emptyScaffoldResult: DetectionResult = {
    ...scaffoldResult,
    scaffoldSuggestions: [],
  };

  it("shows scaffold header when scaffoldSuggestions is present", () => {
    const comment = buildPRComment(scaffoldResult, false);
    expect(comment).toContain("No existing documentation found");
  });

  it("shows suggested filename", () => {
    const comment = buildPRComment(scaffoldResult, false);
    expect(comment).toContain("README.md");
  });

  it("includes rationale for each suggestion", () => {
    const comment = buildPRComment(scaffoldResult, false);
    expect(comment).toContain("No README found");
  });

  it("includes suggested content in a code block", () => {
    const comment = buildPRComment(scaffoldResult, false);
    expect(comment).toContain("```markdown");
    expect(comment).toContain("A user management API.");
  });

  it("includes metadata footer with duration and model", () => {
    const comment = buildPRComment(scaffoldResult, false);
    expect(comment).toContain("3.1s");
    expect(comment).toContain("claude-sonnet-4-6");
  });

  it("does not show drift findings section in scaffold mode", () => {
    const comment = buildPRComment(scaffoldResult, false);
    expect(comment).not.toContain("documentation drift findings");
    expect(comment).not.toContain("No drift detected");
  });

  it("shows fallback message when LLM returns empty suggestedDocs", () => {
    const comment = buildPRComment(emptyScaffoldResult, false);
    expect(comment).toContain("No existing documentation found");
    expect(comment).toContain("Consider adding a README");
  });

  it("shows onboarding message in scaffold mode when isFirstRun", () => {
    const comment = buildPRComment(scaffoldResult, true);
    expect(comment).toContain("DocDrift is now watching");
  });
});

describe("buildPRComment — Confluence suggestions", () => {
  const confluenceOptions = {
    confluenceConfigured: true,
    confluenceUrl: "https://myorg.atlassian.net/wiki",
    confluenceSpaceKey: "ENG",
    confluenceEmpty: true,
  };

  it("renders suggestion title and inline bullet content", () => {
    const comment = buildPRComment(baseResult, false, {
      ...confluenceOptions,
      confluenceSuggestions: [
        {
          filename: "Architecture Overview",
          content: "- Overview\n- Component diagram\n- Configuration",
          rationale: "No architecture doc found",
        },
      ],
    });
    expect(comment).toContain("📘 Suggested Confluence Pages");
    expect(comment).toContain("Architecture Overview");
    expect(comment).toContain("- Overview");
    expect(comment).toContain("No architecture doc found");
    expect(comment).not.toContain("```markdown");
  });

  it("shows fallback message when suggestions array is empty", () => {
    const comment = buildPRComment(baseResult, false, {
      ...confluenceOptions,
      confluenceSuggestions: [],
    });
    expect(comment).toContain("No Confluence pages found");
    expect(comment).not.toContain("📘 Suggested Confluence Pages");
  });

  it("skips content block when suggestion content is empty string", () => {
    const comment = buildPRComment(baseResult, false, {
      ...confluenceOptions,
      confluenceSuggestions: [
        { filename: "API Reference", content: "", rationale: "API endpoints added" },
      ],
    });
    expect(comment).toContain("API Reference");
    expect(comment).toContain("API endpoints added");
  });

  it("renders multiple suggestions", () => {
    const comment = buildPRComment(baseResult, false, {
      ...confluenceOptions,
      confluenceSuggestions: [
        { filename: "Page One", content: "- Section A", rationale: "reason one" },
        { filename: "Page Two", content: "- Section B", rationale: "reason two" },
      ],
    });
    expect(comment).toContain("Page One");
    expect(comment).toContain("Page Two");
    expect(comment).toContain("creating 2 pages");
  });

  it("shows fallback note when confluenceEmpty but no suggestions provided", () => {
    const comment = buildPRComment(baseResult, false, {
      ...confluenceOptions,
      confluenceSuggestions: undefined,
    });
    expect(comment).toContain("No Confluence pages found");
  });
});
