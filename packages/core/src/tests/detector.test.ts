import { describe, it, expect, vi, beforeEach } from "vitest";
import { DriftDetector } from "../drift/detector.js";
import type { LLMProvider } from "../llm/interface.js";
import type { DiffFile } from "../diff/analyzer.js";
import type { DocFile } from "../docs/retriever.js";
import type { DriftAnalysis, ScaffoldOutput } from "../drift/schemas.js";
import { LLMParseError, LLMTimeoutError } from "../errors.js";

const srcFile: DiffFile = {
  path: "src/api/users.ts",
  status: "modified",
  additions: 10,
  deletions: 2,
  patch: "-export function createUser(name: string)\n+export function createUser(name: string, role: string)",
};

const configFile: DiffFile = {
  path: ".github/workflows/ci.yml",
  status: "modified",
  additions: 3,
  deletions: 1,
  patch: "+  node-version: '20'",
};

const testFile: DiffFile = {
  path: "src/api/users.test.ts",
  status: "added",
  additions: 30,
  deletions: 0,
  patch: "+it('creates user', () => {})",
};

const docFile: DocFile = { path: "docs/api.md", content: "# API\ncreateUser(name)" };

const driftAnalysis: DriftAnalysis = {
  findings: [
    {
      docFile: "docs/api.md",
      codeFile: "src/api/users.ts",
      issue: "createUser signature changed",
      explanation: "role parameter is now required",
      suggestedUpdate: "-createUser(name)\n+createUser(name, role)",
      severity: "high",
      confidence: 0.95,
    },
  ],
  summary: "One breaking API change",
  checkedDocFiles: ["docs/api.md"],
};

const scaffoldOutput: ScaffoldOutput = {
  suggestedDocs: [
    {
      filename: "README.md",
      content: "# Project\n\nA user management API.",
      rationale: "No README found; top-level overview needed",
    },
  ],
  summary: "Suggested a README",
};

function makeMockLLM(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    modelId: "claude-sonnet-4-6",
    analyze: vi.fn().mockResolvedValue(driftAnalysis),
    scaffold: vi.fn().mockResolvedValue(scaffoldOutput),
    ...overrides,
  };
}

describe("DriftDetector", () => {
  describe("drift detection (docs present)", () => {
    it("calls analyze and returns findings filtered by confidence", async () => {
      const llm = makeMockLLM();
      const detector = new DriftDetector(llm);
      const result = await detector.detect([srcFile], [docFile]);

      expect(llm.analyze).toHaveBeenCalledOnce();
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.issue).toBe("createUser signature changed");
      expect(result.scaffoldSuggestions).toBeUndefined();
    });

    it("returns zero findings when LLM finds none", async () => {
      const llm = makeMockLLM({
        analyze: vi.fn().mockResolvedValue({ findings: [], summary: "", checkedDocFiles: [] }),
      });
      const detector = new DriftDetector(llm);
      const result = await detector.detect([srcFile], [docFile]);

      expect(result.findings).toHaveLength(0);
      expect(result.checkedDocFiles).toContain("docs/api.md");
    });

    it("filters findings below confidence threshold", async () => {
      const lowConfidence: DriftAnalysis = {
        findings: [{ ...driftAnalysis.findings[0]!, confidence: 0.5 }],
        summary: "",
        checkedDocFiles: [],
      };
      const llm = makeMockLLM({ analyze: vi.fn().mockResolvedValue(lowConfidence) });
      const detector = new DriftDetector(llm);
      const result = await detector.detect([srcFile], [docFile]);

      expect(result.findings).toHaveLength(0);
    });

    it("sorts findings high → medium → low", async () => {
      const mixed: DriftAnalysis = {
        findings: [
          { ...driftAnalysis.findings[0]!, severity: "low", confidence: 0.8, issue: "low" },
          { ...driftAnalysis.findings[0]!, severity: "high", confidence: 0.9, issue: "high" },
          { ...driftAnalysis.findings[0]!, severity: "medium", confidence: 0.85, issue: "medium" },
        ],
        summary: "",
        checkedDocFiles: [],
      };
      const llm = makeMockLLM({ analyze: vi.fn().mockResolvedValue(mixed) });
      const detector = new DriftDetector(llm);
      const result = await detector.detect([srcFile], [docFile]);

      expect(result.findings.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
    });

    it("does not call scaffold when docs are present", async () => {
      const llm = makeMockLLM();
      const detector = new DriftDetector(llm, true);
      await detector.detect([srcFile], [docFile]);

      expect(llm.scaffold).not.toHaveBeenCalled();
    });

    it("reports checkedDocFiles and chunksAnalyzed", async () => {
      const llm = makeMockLLM();
      const detector = new DriftDetector(llm);
      const result = await detector.detect([srcFile], [docFile]);

      expect(result.checkedDocFiles).toContain("docs/api.md");
      expect(result.chunksAnalyzed).toBeGreaterThan(0);
      expect(result.modelId).toBe("claude-sonnet-4-6");
    });
  });

  describe("scaffold mode (no docs)", () => {
    it("calls scaffold when no docs found and scaffoldEnabled", async () => {
      const llm = makeMockLLM();
      const detector = new DriftDetector(llm, true);
      const result = await detector.detect([srcFile], []);

      expect(llm.scaffold).toHaveBeenCalledOnce();
      expect(llm.analyze).not.toHaveBeenCalled();
      expect(result.scaffoldSuggestions).toHaveLength(1);
      expect(result.scaffoldSuggestions![0]!.filename).toBe("README.md");
    });

    it("skips scaffold when scaffoldEnabled is false", async () => {
      const llm = makeMockLLM();
      const detector = new DriftDetector(llm, false);
      const result = await detector.detect([srcFile], []);

      expect(llm.scaffold).not.toHaveBeenCalled();
      expect(result.findings).toHaveLength(0);
      expect(result.scaffoldSuggestions).toBeUndefined();
    });


    it("runs scaffold when at least one file is a source file", async () => {
      const llm = makeMockLLM();
      const detector = new DriftDetector(llm, true);
      const result = await detector.detect([srcFile, configFile], []);

      expect(llm.scaffold).toHaveBeenCalledOnce();
      expect(result.scaffoldSuggestions).toBeDefined();
    });

    it("handles empty suggestedDocs from LLM without throwing", async () => {
      const llm = makeMockLLM({
        scaffold: vi.fn().mockResolvedValue({ suggestedDocs: [], summary: "nothing to suggest" }),
      });
      const detector = new DriftDetector(llm, true);
      const result = await detector.detect([srcFile], []);

      expect(result.scaffoldSuggestions).toEqual([]);
    });

    it("returns durationMs from scaffold call", async () => {
      const llm = makeMockLLM();
      const detector = new DriftDetector(llm, true);
      const result = await detector.detect([srcFile], []);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("scaffoldConfluence", () => {
    it("returns empty array when LLM returns {} (Haiku empty tool call, default kicks in)", async () => {
      const llm = makeMockLLM({
        scaffold: vi.fn().mockResolvedValue({ suggestedDocs: [], summary: "" }),
      });
      const detector = new DriftDetector(llm);
      const result = await detector.scaffoldConfluence([srcFile], []);

      expect(result).toEqual([]);
    });

    it("returns suggestions when LLM provides page outlines", async () => {
      const llm = makeMockLLM({
        scaffold: vi.fn().mockResolvedValue({
          suggestedDocs: [
            { filename: "Architecture Overview", content: "- Overview\n- Setup\n- API", rationale: "No arch doc" },
          ],
          summary: "Suggested 1 Confluence page",
        }),
      });
      const detector = new DriftDetector(llm);
      const result = await detector.scaffoldConfluence([srcFile], []);

      expect(result).toHaveLength(1);
      expect(result[0]!.filename).toBe("Architecture Overview");
      expect(result[0]!.content).toContain("- Overview");
    });

    it("returns empty array when LLM returns only summary and no suggestedDocs", async () => {
      const llm = makeMockLLM({
        scaffold: vi.fn().mockResolvedValue({
          suggestedDocs: [],
          summary: "Three comprehensive Confluence pages documenting...",
        }),
      });
      const detector = new DriftDetector(llm);
      const result = await detector.scaffoldConfluence([srcFile], []);

      expect(result).toEqual([]);
    });

    it("passes findings context to the scaffold prompt", async () => {
      const scaffold = vi.fn().mockResolvedValue({ suggestedDocs: [], summary: "" });
      const llm = makeMockLLM({ scaffold });
      const detector = new DriftDetector(llm);
      const findings = driftAnalysis.findings;
      await detector.scaffoldConfluence([srcFile], findings);

      expect(scaffold).toHaveBeenCalledOnce();
      const promptArg: string = scaffold.mock.calls[0][0];
      expect(promptArg).toContain("createUser signature changed");
    });
  });

  describe("retry behavior", () => {
    it("retries analyze on LLMParseError up to limit", async () => {
      const analyze = vi
        .fn()
        .mockRejectedValueOnce(new LLMParseError("bad"))
        .mockRejectedValueOnce(new LLMParseError("bad"))
        .mockResolvedValueOnce(driftAnalysis);

      const llm = makeMockLLM({ analyze });
      const detector = new DriftDetector(llm);
      const result = await detector.detect([srcFile], [docFile]);

      expect(analyze).toHaveBeenCalledTimes(3);
      expect(result.findings).toHaveLength(1);
    });

    it("throws after exhausting retries on analyze", async () => {
      const analyze = vi.fn().mockRejectedValue(new LLMParseError("bad"));
      const llm = makeMockLLM({ analyze });
      const detector = new DriftDetector(llm);

      await expect(detector.detect([srcFile], [docFile])).rejects.toBeInstanceOf(LLMParseError);
    });

    it("retries scaffold on LLMTimeoutError", async () => {
      const scaffold = vi
        .fn()
        .mockRejectedValueOnce(new LLMTimeoutError("timeout"))
        .mockResolvedValueOnce(scaffoldOutput);

      const llm = makeMockLLM({ scaffold });
      const detector = new DriftDetector(llm, true);
      const result = await detector.detect([srcFile], []);

      expect(scaffold).toHaveBeenCalledTimes(2);
      expect(result.scaffoldSuggestions).toHaveLength(1);
    });

    it("throws after exhausting retries on scaffold", async () => {
      const scaffold = vi.fn().mockRejectedValue(new LLMParseError("bad"));
      const llm = makeMockLLM({ scaffold });
      const detector = new DriftDetector(llm, true);

      await expect(detector.detect([srcFile], [])).rejects.toBeInstanceOf(LLMParseError);
    });
  });
});
