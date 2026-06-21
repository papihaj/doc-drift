import Anthropic from "@anthropic-ai/sdk";
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

export class AnthropicProvider implements LLMProvider {
  readonly modelId = "claude-haiku-4-5-20251001";

  private readonly client: Anthropic;

  constructor(apiKey: string, modelId?: string) {
    this.client = new Anthropic({ apiKey });
    if (modelId) {
      (this as { modelId: string }).modelId = modelId;
    }
  }

  async analyze(prompt: string): Promise<DriftAnalysis> {
    let raw = "";

    try {
      const response = await Promise.race([
        this.client.messages.create({
          model: this.modelId,
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
          tools: [
            {
              name: "report_drift",
              description: "Report documentation drift findings for a pull request",
              input_schema: {
                type: "object" as const,
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
          ],
          tool_choice: { type: "any" },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new LLMTimeoutError("LLM call timed out")), LLM_TIMEOUT_MS),
        ),
      ]);

      const toolUse = response.content.find((b) => b.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") {
        throw new LLMEmptyResponseError("LLM did not call report_drift tool");
      }

      raw = JSON.stringify(toolUse.input);
      const parsed = DriftAnalysisSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        throw new LLMParseError(`Schema validation failed: ${JSON.stringify(parsed.error.flatten())} — raw: ${raw.slice(0, 500)}`, parsed.error);
      }

      return parsed.data;
    } catch (err) {
      if (err instanceof LLMTimeoutError || err instanceof LLMEmptyResponseError || err instanceof LLMParseError) {
        throw err;
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMRateLimitError("Anthropic rate limit hit", err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LLMProviderError(`Anthropic API error: ${err.message}`, err);
      }
      throw new LLMProviderError("Unexpected LLM error", err);
    }
  }

  async scaffold(prompt: string): Promise<ScaffoldOutput> {
    let raw = "";

    try {
      const response = await Promise.race([
        this.client.messages.create({
          model: this.modelId,
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
          tools: [
            {
              name: "suggest_docs",
              description: "Suggest initial documentation files for an undocumented codebase",
              input_schema: {
                type: "object" as const,
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
          ],
          tool_choice: { type: "any" },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new LLMTimeoutError("LLM scaffold call timed out")), LLM_SCAFFOLD_TIMEOUT_MS),
        ),
      ]);

      const toolUse = response.content.find((b) => b.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") {
        throw new LLMEmptyResponseError("LLM did not call suggest_docs tool");
      }

      raw = JSON.stringify(toolUse.input);
      const parsed = ScaffoldOutputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        throw new LLMParseError(`Schema validation failed: ${JSON.stringify(parsed.error.flatten())} — raw: ${raw.slice(0, 500)}`, parsed.error);
      }

      return parsed.data;
    } catch (err) {
      if (err instanceof LLMTimeoutError || err instanceof LLMEmptyResponseError || err instanceof LLMParseError) {
        throw err;
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMRateLimitError("Anthropic rate limit hit", err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LLMProviderError(`Anthropic API error: ${err.message}`, err);
      }
      throw new LLMProviderError("Unexpected LLM error", err);
    }
  }
}
