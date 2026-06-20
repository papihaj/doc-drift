import type { DriftAnalysis, ScaffoldOutput } from "../drift/schemas.js";

export interface LLMProvider {
  analyze(prompt: string): Promise<DriftAnalysis>;
  scaffold(prompt: string): Promise<ScaffoldOutput>;
  readonly modelId: string;
}
