export { DiffAnalyzer } from "./diff/analyzer.js";
export type { ParsedDiff, DiffFile } from "./diff/analyzer.js";
export { chunkDiff } from "./diff/chunker.js";
export type { DiffChunk } from "./diff/chunker.js";

export { DocRetriever } from "./docs/retriever.js";
export type { DocFile } from "./docs/retriever.js";
export { ConfluenceRetriever } from "./docs/confluence.js";
export type { ConfluenceConfig } from "./docs/confluence.js";
export { ConfluenceWriter } from "./docs/confluence-writer.js";
export type { CreatedPage } from "./docs/confluence-writer.js";
export { markdownToStorage } from "./docs/markdown-to-storage.js";

export { DriftDetector } from "./drift/detector.js";
export type { DetectionResult } from "./drift/detector.js";
export { buildDriftPrompt } from "./drift/prompt.js";
export {
  FindingSchema,
  DriftAnalysisSchema,
  ScaffoldSuggestionSchema,
  ScaffoldOutputSchema,
  SeveritySchema,
  CONFIDENCE_THRESHOLD,
  MAX_FINDINGS_PER_PR,
} from "./drift/schemas.js";
export type { Finding, DriftAnalysis, ScaffoldSuggestion, ScaffoldOutput, Severity } from "./drift/schemas.js";

export { buildPRComment } from "./suggestions/builder.js";
export type { ConfluenceOptions } from "./suggestions/builder.js";
export { buildScaffoldPrompt } from "./drift/prompt.js";

export type { LLMProvider } from "./llm/interface.js";
export { AnthropicProvider } from "./llm/anthropic.js";
export { OllamaProvider } from "./llm/ollama.js";

export * from "./errors.js";
