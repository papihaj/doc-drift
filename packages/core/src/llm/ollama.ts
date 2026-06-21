import { DriftAnalysisSchema, ScaffoldOutputSchema, LLM_TIMEOUT_MS } from "../drift/schemas.js";
import {
  LLMEmptyResponseError,
  LLMParseError,
  LLMProviderError,
  LLMTimeoutError,
} from "../errors.js";
import type { LLMProvider } from "./interface.js";
import type { DriftAnalysis, ScaffoldOutput } from "../drift/schemas.js";

const LOCAL_BASE_URL = "http://localhost:11434";
const CLOUD_BASE_URL = "https://ollama.com";

interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  /** API key for ollama.com cloud inference. Falls back to OLLAMA_API_KEY env var. */
  apiKey?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        // Ollama returns arguments as a parsed object, not a JSON string.
        arguments: Record<string, unknown>;
      };
    }>;
  };
  done: boolean;
}

const REPORT_DRIFT_TOOL: OllamaTool = {
  type: "function",
  function: {
    name: "report_drift",
    description: "Report documentation drift findings for a pull request",
    parameters: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              docFile: { type: "string" },
              codeFile: { type: "string" },
              issue: { type: "string" },
              explanation: { type: "string" },
              suggestedUpdate: { type: "string" },
              severity: { type: "string", enum: ["high", "medium", "low"] },
              confidence: { type: "number" },
            },
            required: ["docFile", "codeFile", "issue", "explanation", "suggestedUpdate", "severity", "confidence"],
          },
        },
        summary: { type: "string" },
        checkedDocFiles: { type: "array", items: { type: "string" } },
      },
      required: ["findings", "summary", "checkedDocFiles"],
    },
  },
};

const SUGGEST_DOCS_TOOL: OllamaTool = {
  type: "function",
  function: {
    name: "suggest_docs",
    description: "Suggest initial documentation files for an undocumented codebase",
    parameters: {
      type: "object",
      properties: {
        suggestedDocs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["filename", "content", "rationale"],
          },
        },
        summary: { type: "string" },
      },
      required: ["suggestedDocs", "summary"],
    },
  },
};

export class OllamaProvider implements LLMProvider {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor({ baseUrl, model = "gpt-oss:20b", apiKey }: OllamaOptions = {}) {
    this.apiKey = apiKey ?? process.env["OLLAMA_API_KEY"];
    // When a key is present, default to cloud; otherwise default to local.
    const defaultUrl = this.apiKey ? CLOUD_BASE_URL : LOCAL_BASE_URL;
    this.baseUrl = (baseUrl ?? defaultUrl).replace(/\/$/, "");
    this.modelId = model;
  }

  async analyze(prompt: string): Promise<DriftAnalysis> {
    const raw = await this.chat(prompt, REPORT_DRIFT_TOOL);
    const parsed = DriftAnalysisSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMParseError(JSON.stringify(raw), parsed.error);
    }
    return parsed.data;
  }

  async scaffold(prompt: string): Promise<ScaffoldOutput> {
    const raw = await this.chat(prompt, SUGGEST_DOCS_TOOL);
    const parsed = ScaffoldOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMParseError(JSON.stringify(raw), parsed.error);
    }
    return parsed.data;
  }

  private async chat(prompt: string, tool: OllamaTool): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const isCloud = this.baseUrl === CLOUD_BASE_URL;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.modelId,
          messages: [{ role: "user", content: prompt }],
          tools: [tool],
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LLMTimeoutError("Ollama request timed out");
      }
      const hint = isCloud
        ? "Check your OLLAMA_API_KEY and network connection."
        : "Is the local server running? (ollama serve)";
      throw new LLMProviderError(`Cannot reach Ollama at ${this.baseUrl}. ${hint}`, err);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LLMProviderError(`Ollama HTTP ${response.status}: ${body}`);
    }

    let data: OllamaResponse;
    try {
      data = (await response.json()) as OllamaResponse;
    } catch (err) {
      throw new LLMParseError("Ollama response was not valid JSON", err);
    }

    const toolCall = data.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new LLMEmptyResponseError(
        `Ollama model ${this.modelId} did not call the ${tool.function.name} tool`,
      );
    }

    // Ollama returns arguments as a parsed object (not a JSON string).
    return toolCall.function.arguments;
  }
}
