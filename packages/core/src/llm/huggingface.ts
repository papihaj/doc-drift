import { DriftAnalysisSchema, ScaffoldOutputSchema, LLM_TIMEOUT_MS, LLM_SCAFFOLD_TIMEOUT_MS } from "../drift/schemas.js";
import {
  LLMEmptyResponseError,
  LLMParseError,
  LLMProviderError,
  LLMRateLimitError,
  LLMTimeoutError,
} from "../errors.js";
import type { LLMProvider } from "./interface.js";
import type { DriftAnalysis, ScaffoldOutput } from "../drift/schemas.js";

const HF_ROUTER_BASE = "https://router.huggingface.co";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Pro:novita";

interface HuggingFaceOptions {
  /** API key. Falls back to HF_TOKEN env var. */
  apiKey?: string;
  /**
   * Model in "org/name:provider" format.
   * The ":provider" suffix selects the HuggingFace router (e.g. "novita", "together").
   * Defaults to "deepseek-ai/DeepSeek-V4-Pro:novita".
   */
  model?: string;
  /** Override the router base URL (useful for testing). */
  baseUrl?: string;
}

interface OpenAICompatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class HuggingFaceProvider implements LLMProvider {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly modelName: string;

  constructor({ apiKey, model = DEFAULT_MODEL, baseUrl }: HuggingFaceOptions = {}) {
    const key = apiKey ?? process.env["HF_TOKEN"] ?? "";
    if (!key) throw new Error("HuggingFace API key required — set HF_TOKEN or pass apiKey");

    this.apiKey = key;
    this.modelId = model;

    // "org/model:provider" → provider selects the HF router segment
    const colonIdx = model.lastIndexOf(":");
    const provider = colonIdx !== -1 ? model.slice(colonIdx + 1) : "novita";
    this.modelName = colonIdx !== -1 ? model.slice(0, colonIdx) : model;

    const base = (baseUrl ?? HF_ROUTER_BASE).replace(/\/$/, "");
    this.endpoint = `${base}/${provider}/v1/chat/completions`;
  }

  async analyze(prompt: string): Promise<DriftAnalysis> {
    const raw = await this.chat(prompt, LLM_TIMEOUT_MS);
    const parsed = DriftAnalysisSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMParseError(JSON.stringify(raw), parsed.error);
    }
    return parsed.data;
  }

  async scaffold(prompt: string): Promise<ScaffoldOutput> {
    const raw = await this.chat(prompt, LLM_SCAFFOLD_TIMEOUT_MS);
    const parsed = ScaffoldOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMParseError(JSON.stringify(raw), parsed.error);
    }
    return parsed.data;
  }

  private async chat(prompt: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 8192,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LLMTimeoutError(`HuggingFace request timed out after ${timeoutMs}ms`);
      }
      throw new LLMProviderError(`Cannot reach HuggingFace at ${this.endpoint}`, err);
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 429) {
      throw new LLMRateLimitError("HuggingFace rate limit hit");
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LLMProviderError(`HuggingFace HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    let data: OpenAICompatResponse;
    try {
      data = (await response.json()) as OpenAICompatResponse;
    } catch (err) {
      throw new LLMParseError("HuggingFace response was not valid JSON", err);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new LLMEmptyResponseError(`HuggingFace model ${this.modelId} returned empty content`);
    }

    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch (err) {
      throw new LLMParseError(
        `HuggingFace model ${this.modelId} returned non-JSON: ${content.slice(0, 200)}`,
        err,
      );
    }
  }
}
