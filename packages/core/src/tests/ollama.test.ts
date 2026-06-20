import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "../llm/ollama.js";
import { LLMEmptyResponseError, LLMParseError, LLMProviderError, LLMTimeoutError } from "../errors.js";

const validDriftPayload = {
  findings: [
    {
      docFile: "docs/api.md",
      codeFile: "src/api.ts",
      issue: "signature changed",
      explanation: "role param added",
      suggestedUpdate: "-fn()\n+fn(role)",
      severity: "high",
      confidence: 0.9,
    },
  ],
  summary: "one finding",
  checkedDocFiles: ["docs/api.md"],
};

const validScaffoldPayload = {
  suggestedDocs: [
    { filename: "README.md", content: "# Project", rationale: "no README found" },
  ],
  summary: "suggested a README",
};

function ollamaResponse(toolName: string, args: Record<string, unknown>) {
  return {
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: toolName, arguments: args } }],
    },
    done: true,
  };
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("OllamaProvider", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = mockFetch(ollamaResponse("report_drift", validDriftPayload));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("constructor defaults", () => {
    it("defaults to gpt-oss model", () => {
      const provider = new OllamaProvider();
      expect(provider.modelId).toBe("gpt-oss");
    });

    it("accepts custom model name", () => {
      const provider = new OllamaProvider({ model: "gpt-oss:120b" });
      expect(provider.modelId).toBe("gpt-oss:120b");
    });

    it("defaults to localhost when no apiKey", () => {
      const provider = new OllamaProvider();
      provider.analyze("test").catch(() => {});
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/chat");
    });

    it("defaults to cloud base URL when apiKey is provided", () => {
      const provider = new OllamaProvider({ apiKey: "test-key" });
      provider.analyze("test").catch(() => {});
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ollama.com/api/chat");
    });

    it("reads apiKey from OLLAMA_API_KEY env var", () => {
      vi.stubEnv("OLLAMA_API_KEY", "env-key");
      const provider = new OllamaProvider();
      provider.analyze("test").catch(() => {});
      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer env-key");
      vi.unstubAllEnvs();
    });

    it("sends Authorization header when apiKey is set", () => {
      const provider = new OllamaProvider({ apiKey: "my-key" });
      provider.analyze("test").catch(() => {});
      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-key");
    });

    it("does not send Authorization header when no apiKey", () => {
      const provider = new OllamaProvider();
      provider.analyze("test").catch(() => {});
      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("strips trailing slash from baseUrl", () => {
      const provider = new OllamaProvider({ baseUrl: "http://localhost:11434/" });
      provider.analyze("test").catch(() => {});
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/chat");
    });
  });

  describe("analyze()", () => {
    it("calls /api/chat with report_drift tool", async () => {
      const provider = new OllamaProvider();
      await provider.analyze("some prompt");

      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("http://localhost:11434/api/chat");
      const body = JSON.parse(opts.body as string);
      expect(body.tools[0].function.name).toBe("report_drift");
      expect(body.stream).toBe(false);
    });

    it("returns validated DriftAnalysis", async () => {
      const provider = new OllamaProvider();
      const result = await provider.analyze("prompt");

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.severity).toBe("high");
    });

    it("throws LLMEmptyResponseError when no tool_calls in response", async () => {
      fetchSpy = mockFetch({ message: { role: "assistant", content: "I can help!", tool_calls: [] }, done: true });
      vi.stubGlobal("fetch", fetchSpy);

      const provider = new OllamaProvider();
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMEmptyResponseError);
    });

    it("throws LLMParseError when tool arguments fail schema validation", async () => {
      fetchSpy = mockFetch(ollamaResponse("report_drift", { findings: "not-an-array" }));
      vi.stubGlobal("fetch", fetchSpy);

      const provider = new OllamaProvider();
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMParseError);
    });

    it("throws LLMProviderError on non-200 response", async () => {
      fetchSpy = mockFetch({ error: "model not found" }, 404);
      vi.stubGlobal("fetch", fetchSpy);

      const provider = new OllamaProvider();
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMProviderError);
    });

    it("throws LLMProviderError with local hint when local server is down", async () => {
      fetchSpy = vi.fn().mockRejectedValue(Object.assign(new Error("ECONNREFUSED"), { name: "Error" }));
      vi.stubGlobal("fetch", fetchSpy);

      const provider = new OllamaProvider();
      await expect(provider.analyze("prompt")).rejects.toThrow("ollama serve");
    });

    it("throws LLMProviderError with cloud hint when cloud request fails", async () => {
      fetchSpy = vi.fn().mockRejectedValue(Object.assign(new Error("network failure"), { name: "Error" }));
      vi.stubGlobal("fetch", fetchSpy);

      const provider = new OllamaProvider({ apiKey: "test-key" });
      await expect(provider.analyze("prompt")).rejects.toThrow("OLLAMA_API_KEY");
    });

    it("throws LLMTimeoutError on abort", async () => {
      fetchSpy = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
      vi.stubGlobal("fetch", fetchSpy);

      const provider = new OllamaProvider();
      await expect(provider.analyze("prompt")).rejects.toBeInstanceOf(LLMTimeoutError);
    });
  });

  describe("scaffold()", () => {
    beforeEach(() => {
      fetchSpy = mockFetch(ollamaResponse("suggest_docs", validScaffoldPayload));
      vi.stubGlobal("fetch", fetchSpy);
    });

    it("calls /api/chat with suggest_docs tool", async () => {
      const provider = new OllamaProvider();
      await provider.scaffold("some prompt");

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      expect(body.tools[0].function.name).toBe("suggest_docs");
    });

    it("returns validated ScaffoldOutput", async () => {
      const provider = new OllamaProvider();
      const result = await provider.scaffold("prompt");

      expect(result.suggestedDocs).toHaveLength(1);
      expect(result.suggestedDocs[0]!.filename).toBe("README.md");
    });

    it("throws LLMParseError when scaffold arguments fail schema", async () => {
      fetchSpy = mockFetch(ollamaResponse("suggest_docs", { suggestedDocs: "wrong" }));
      vi.stubGlobal("fetch", fetchSpy);

      const provider = new OllamaProvider();
      await expect(provider.scaffold("prompt")).rejects.toBeInstanceOf(LLMParseError);
    });
  });
});
