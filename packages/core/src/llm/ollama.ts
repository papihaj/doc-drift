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

interface OllamaResponse {
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

export class OllamaProvider implements LLMProvider {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor({ baseUrl, model = "gpt-oss:20b", apiKey }: OllamaOptions = {}) {
    this.apiKey = apiKey ?? process.env["OLLAMA_API_KEY"];
    const defaultUrl = this.apiKey ? CLOUD_BASE_URL : LOCAL_BASE_URL;
    this.baseUrl = (baseUrl ?? defaultUrl).replace(/\/$/, "");
    this.modelId = model;
  }

  async analyze(prompt: string): Promise<DriftAnalysis> {
    const raw = await this.chat(prompt);
    const parsed = DriftAnalysisSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMParseError(JSON.stringify(raw), parsed.error);
    }
    return parsed.data;
  }

  async scaffold(prompt: string): Promise<ScaffoldOutput> {
    const raw = await this.chat(prompt);
    const parsed = ScaffoldOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMParseError(JSON.stringify(raw), parsed.error);
    }
    return parsed.data;
  }

  private async chat(prompt: string): Promise<Record<string, unknown>> {
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
          format: "json",
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

    const content = data.message?.content;
    if (!content) {
      throw new LLMEmptyResponseError(`Ollama model ${this.modelId} returned empty content`);
    }

    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch (err) {
      throw new LLMParseError(
        `Ollama model ${this.modelId} returned non-JSON content: ${content.slice(0, 200)}`,
        err,
      );
    }
  }
}
