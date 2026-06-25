import type { LLMProvider } from "./interface.js";
import type { DriftAnalysis, ScaffoldOutput } from "../drift/schemas.js";

/**
 * Wraps two providers: tries primary first, falls back to secondary on any error.
 * Useful for HuggingFace (primary) → Anthropic (fallback) setups.
 */
export class FallbackProvider implements LLMProvider {
  get modelId(): string {
    return `${this.primary.modelId}→${this.secondary.modelId}`;
  }

  constructor(
    private readonly primary: LLMProvider,
    private readonly secondary: LLMProvider,
  ) {}

  async analyze(prompt: string): Promise<DriftAnalysis> {
    try {
      return await this.primary.analyze(prompt);
    } catch {
      return this.secondary.analyze(prompt);
    }
  }

  async scaffold(prompt: string): Promise<ScaffoldOutput> {
    try {
      return await this.primary.scaffold(prompt);
    } catch {
      return this.secondary.scaffold(prompt);
    }
  }
}
