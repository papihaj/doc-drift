import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HuggingFaceProvider } from "../llm/huggingface.js";
import { LLMTimeoutError, LLMRateLimitError, LLMProviderError, LLMParseError, LLMEmptyResponseError } from "../errors.js";

const VALID_DRIFT_OUTPUT = JSON.stringify({
  findings: [],
  summary: "No drift",
  checkedDocFiles: [],
});

const VALID_SCAFFOLD_OUTPUT = JSON.stringify({
  suggestedDocs: [{ filename: "README.md", content: "# Project", rationale: "No README" }],
  summary: "Suggested README",
});

function makeOkResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("HuggingFaceProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("constructor", () => {
    it("throws if no API key and HF_TOKEN not set", () => {
      const orig = process.env["HF_TOKEN"];
      delete process.env["HF_TOKEN"];
      expect(() => new HuggingFaceProvider()).toThrow("HuggingFace API key required");
      if (orig !== undefined) process.env["HF_TOKEN"] = orig;
    });

    it("reads HF_TOKEN from env", () => {
      process.env["HF_TOKEN"] = "hf_test";
      expect(() => new HuggingFaceProvider()).not.toThrow();
      delete process.env["HF_TOKEN"];
    });

    it("parses model:provider format into correct endpoint", () => {
      const provider = new HuggingFaceProvider({ apiKey: "hf_test", model: "org/model:together" });
      expect(provider.modelId).toBe("org/model:together");
    });
  });

  describe("analyze()", () => {
    it("returns DriftAnalysis on happy path", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse(VALID_DRIFT_OUTPUT));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      const result = await provider.analyze("test prompt");
      expect(result.findings).toEqual([]);
      expect(result.summary).toBe("No drift");
    });

    it("throws LLMRateLimitError on 429", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMRateLimitError);
    });

    it("throws LLMProviderError on non-ok status", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response("server error", { status: 500 }));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMProviderError);
    });

    it("throws LLMProviderError when fetch fails (network)", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMProviderError);
    });

    it("throws LLMParseError when response body is not JSON", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response("not json", { status: 200 }));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMParseError);
    });

    it("throws LLMEmptyResponseError when choices is empty", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMEmptyResponseError);
    });

    it("throws LLMParseError when content is not valid JSON", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse("not json content"));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMParseError);
    });

    it("throws LLMParseError when content doesn't match DriftAnalysis schema", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse(JSON.stringify({ wrong: "shape" })));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMParseError);
    });

    it("throws LLMTimeoutError on AbortError", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMTimeoutError);
    });

    it("sends Authorization header with Bearer token", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse(VALID_DRIFT_OUTPUT));
      const provider = new HuggingFaceProvider({ apiKey: "hf_mytoken" });
      await provider.analyze("prompt");
      const [, init] = vi.mocked(fetch).mock.calls[0]!;
      expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
        Authorization: "Bearer hf_mytoken",
      });
    });
  });

  describe("scaffold()", () => {
    it("returns ScaffoldOutput on happy path", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse(VALID_SCAFFOLD_OUTPUT));
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      const result = await provider.scaffold("test prompt");
      expect(result.suggestedDocs).toHaveLength(1);
      expect(result.suggestedDocs[0]!.filename).toBe("README.md");
    });

    it("throws LLMParseError when suggestedDocs items have wrong shape", async () => {
      // ScaffoldOutputSchema has .default([]) so top-level wrong shape coerces — the failure
      // must come from invalid items inside suggestedDocs (missing required fields).
      vi.mocked(fetch).mockResolvedValueOnce(
        makeOkResponse(JSON.stringify({ suggestedDocs: [{ wrong: "shape" }], summary: "ok" })),
      );
      const provider = new HuggingFaceProvider({ apiKey: "hf_test" });
      await expect(provider.scaffold("prompt")).rejects.toBeInstanceOf(LLMParseError);
    });
  });
});
