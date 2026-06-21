import { z } from "zod";

export const SeveritySchema = z.enum(["high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ScaffoldSuggestionSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1).max(16000),
  rationale: z.string().min(1).max(500),
});
export type ScaffoldSuggestion = z.infer<typeof ScaffoldSuggestionSchema>;

export const ScaffoldOutputSchema = z.object({
  suggestedDocs: z.array(ScaffoldSuggestionSchema),
  summary: z.string().max(500),
});
export type ScaffoldOutput = z.infer<typeof ScaffoldOutputSchema>;

export const FindingSchema = z.object({
  docFile: z.string().min(1),
  codeFile: z.string().min(1),
  issue: z.string().min(1).max(500),
  explanation: z.string().min(1).max(2000),
  suggestedUpdate: z.string().min(1).max(3000),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const DriftAnalysisSchema = z.object({
  findings: z.array(FindingSchema),
  summary: z.string().max(500),
  checkedDocFiles: z.array(z.string()),
});
export type DriftAnalysis = z.infer<typeof DriftAnalysisSchema>;

export const CONFIDENCE_THRESHOLD = 0.7;
export const MAX_FINDINGS_PER_PR = 10;
export const MAX_DIFF_BYTES = 10 * 1024 * 1024;
export const MAX_PARALLEL_DOC_FETCHES = 5;
export const LLM_TIMEOUT_MS = 30_000;
export const LLM_RETRY_ATTEMPTS = 2;
