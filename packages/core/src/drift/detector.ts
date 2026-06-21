import type { LLMProvider } from "../llm/interface.js";
import type { DiffFile } from "../diff/analyzer.js";
import type { DocFile } from "../docs/retriever.js";
import { buildDriftPrompt, buildScaffoldPrompt } from "./prompt.js";
import { chunkDiff } from "../diff/chunker.js";
import {
  CONFIDENCE_THRESHOLD,
  MAX_FINDINGS_PER_PR,
  LLM_RETRY_ATTEMPTS,
} from "./schemas.js";
import type { DriftAnalysis, Finding, ScaffoldSuggestion } from "./schemas.js";
import { LLMParseError, LLMProviderError, LLMTimeoutError } from "../errors.js";

// Files in these paths are unlikely to need hand-written documentation.
const NO_SCAFFOLD_PATTERNS = [
  /^\.github\//,
  /^\.husky\//,
  /^node_modules\//,
  /\.(test|spec)\.(ts|tsx|js|jsx)$/,
  /\/__tests__\//,
  /\/fixtures\//,
  /^(\.eslintrc|\.prettierrc|\.editorconfig|tsconfig|jest\.config|vitest\.config|vite\.config)/,
  /\.(lock|toml)$/,
  /^(package|package-lock|pnpm-lock|yarn\.lock|composer\.lock)\.json$/,
  /^(tsconfig|jsconfig|\.eslintrc|\.prettierrc|babel\.config|rollup\.config|webpack\.config)\.json$/,
];

export interface DetectionResult {
  findings: Finding[];
  checkedDocFiles: string[];
  chunksAnalyzed: number;
  modelId: string;
  durationMs: number;
  scaffoldSuggestions?: ScaffoldSuggestion[];
}

export class DriftDetector {
  constructor(
    private readonly llm: LLMProvider,
    private readonly scaffoldEnabled: boolean = true,
  ) {}

  async detect(diffFiles: DiffFile[], docFiles: DocFile[]): Promise<DetectionResult> {
    if (docFiles.length === 0) {
      if (this.scaffoldEnabled && !shouldSkipScaffold(diffFiles)) {
        return this.runScaffold(diffFiles);
      }
      return {
        findings: [],
        checkedDocFiles: [],
        chunksAnalyzed: 0,
        modelId: this.llm.modelId,
        durationMs: 0,
      };
    }

    const start = Date.now();
    const chunks = chunkDiff(diffFiles);
    const allFindings: Finding[] = [];
    const checkedDocPaths = new Set(docFiles.map((d) => d.path));

    for (const chunk of chunks) {
      const prompt = buildDriftPrompt(chunk.files, docFiles);
      const analysis = await this.callWithRetry(prompt);
      allFindings.push(...analysis.findings);
    }

    const filtered = allFindings
      .filter((f) => f.confidence >= CONFIDENCE_THRESHOLD)
      .sort((a, b) => {
        const severityOrder = { high: 0, medium: 1, low: 2 };
        return (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2);
      })
      .slice(0, MAX_FINDINGS_PER_PR);

    return {
      findings: filtered,
      checkedDocFiles: [...checkedDocPaths],
      chunksAnalyzed: chunks.length,
      modelId: this.llm.modelId,
      durationMs: Date.now() - start,
    };
  }

  private async runScaffold(diffFiles: DiffFile[]): Promise<DetectionResult> {
    const start = Date.now();
    const chunks = chunkDiff(diffFiles);
    // Use only the first chunk — scaffold only needs to understand code shape.
    const firstChunk = chunks[0];
    if (!firstChunk) {
      return { findings: [], checkedDocFiles: [], chunksAnalyzed: 0, modelId: this.llm.modelId, durationMs: 0 };
    }

    const prompt = buildScaffoldPrompt(firstChunk.files);
    const output = await this.callScaffoldWithRetry(prompt);

    return {
      findings: [],
      checkedDocFiles: [],
      chunksAnalyzed: 1,
      modelId: this.llm.modelId,
      durationMs: Date.now() - start,
      scaffoldSuggestions: output.suggestedDocs,
    };
  }

  private async callWithRetry(prompt: string, attempt = 0): Promise<DriftAnalysis> {
    try {
      return await this.llm.analyze(prompt);
    } catch (err) {
      const isRetryable =
        err instanceof LLMTimeoutError ||
        (err instanceof LLMParseError && attempt < LLM_RETRY_ATTEMPTS) ||
        (err instanceof LLMProviderError && attempt < LLM_RETRY_ATTEMPTS);

      if (isRetryable && attempt < LLM_RETRY_ATTEMPTS) {
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
        return this.callWithRetry(prompt, attempt + 1);
      }

      throw err;
    }
  }

  private async callScaffoldWithRetry(prompt: string, attempt = 0): ReturnType<LLMProvider["scaffold"]> {
    try {
      return await this.llm.scaffold(prompt);
    } catch (err) {
      const isRetryable =
        err instanceof LLMTimeoutError ||
        (err instanceof LLMParseError && attempt < LLM_RETRY_ATTEMPTS) ||
        (err instanceof LLMProviderError && attempt < LLM_RETRY_ATTEMPTS);

      if (isRetryable && attempt < LLM_RETRY_ATTEMPTS) {
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
        return this.callScaffoldWithRetry(prompt, attempt + 1);
      }

      throw err;
    }
  }
}

function shouldSkipScaffold(diffFiles: DiffFile[]): boolean {
  return diffFiles.every((f) => NO_SCAFFOLD_PATTERNS.some((p) => p.test(f.path)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
