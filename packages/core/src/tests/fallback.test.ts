import { describe, it, expect, vi } from "vitest";
import { FallbackProvider } from "../llm/fallback.js";
import type { LLMProvider } from "../llm/interface.js";
import type { DriftAnalysis, ScaffoldOutput } from "../drift/schemas.js";

const emptyDrift: DriftAnalysis = { findings: [], summary: "ok", checkedDocFiles: [] };
const emptyScaffold: ScaffoldOutput = { suggestedDocs: [], summary: "ok" };

function makeProvider(overrides: Partial<LLMProvider> & { modelId: string }): LLMProvider {
  return {
    analyze: vi.fn().mockResolvedValue(emptyDrift),
    scaffold: vi.fn().mockResolvedValue(emptyScaffold),
    ...overrides,
  };
}

describe("FallbackProvider", () => {
  describe("modelId", () => {
    it("combines primary and secondary model IDs with →", () => {
      const p = new FallbackProvider(
        makeProvider({ modelId: "hf-model" }),
        makeProvider({ modelId: "claude-haiku" }),
      );
      expect(p.modelId).toBe("hf-model→claude-haiku");
    });
  });

  describe("analyze()", () => {
    it("returns primary result when primary succeeds", async () => {
      const primary = makeProvider({ modelId: "primary", analyze: vi.fn().mockResolvedValue(emptyDrift) });
      const secondary = makeProvider({ modelId: "secondary" });
      const p = new FallbackProvider(primary, secondary);

      await p.analyze("prompt");
      expect(primary.analyze).toHaveBeenCalledOnce();
      expect(secondary.analyze).not.toHaveBeenCalled();
    });

    it("falls back to secondary when primary throws", async () => {
      const primary = makeProvider({ modelId: "primary", analyze: vi.fn().mockRejectedValue(new Error("primary down")) });
      const secondary = makeProvider({ modelId: "secondary" });
      const p = new FallbackProvider(primary, secondary);

      const result = await p.analyze("prompt");
      expect(secondary.analyze).toHaveBeenCalledOnce();
      expect(result).toEqual(emptyDrift);
    });

    it("propagates secondary error when both fail", async () => {
      const primary = makeProvider({ modelId: "primary", analyze: vi.fn().mockRejectedValue(new Error("primary down")) });
      const secondary = makeProvider({ modelId: "secondary", analyze: vi.fn().mockRejectedValue(new Error("secondary down")) });
      const p = new FallbackProvider(primary, secondary);

      await expect(p.analyze("prompt")).rejects.toThrow("secondary down");
    });

    it("passes the same prompt to secondary on fallback", async () => {
      const primary = makeProvider({ modelId: "primary", analyze: vi.fn().mockRejectedValue(new Error("down")) });
      const secondary = makeProvider({ modelId: "secondary" });
      const p = new FallbackProvider(primary, secondary);

      await p.analyze("my specific prompt");
      expect(secondary.analyze).toHaveBeenCalledWith("my specific prompt");
    });
  });

  describe("scaffold()", () => {
    it("returns primary result when primary succeeds", async () => {
      const primary = makeProvider({ modelId: "primary" });
      const secondary = makeProvider({ modelId: "secondary" });
      const p = new FallbackProvider(primary, secondary);

      await p.scaffold("prompt");
      expect(primary.scaffold).toHaveBeenCalledOnce();
      expect(secondary.scaffold).not.toHaveBeenCalled();
    });

    it("falls back to secondary when primary scaffold throws", async () => {
      const primary = makeProvider({ modelId: "primary", scaffold: vi.fn().mockRejectedValue(new Error("scaffold fail")) });
      const secondary = makeProvider({ modelId: "secondary" });
      const p = new FallbackProvider(primary, secondary);

      const result = await p.scaffold("prompt");
      expect(secondary.scaffold).toHaveBeenCalledOnce();
      expect(result).toEqual(emptyScaffold);
    });
  });
});
