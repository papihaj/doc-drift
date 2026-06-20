import type { DiffFile } from "./analyzer.js";

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 90_000;

export interface DiffChunk {
  files: DiffFile[];
  estimatedTokens: number;
}

export function chunkDiff(files: DiffFile[]): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let current: DiffFile[] = [];
  let currentTokens = 0;

  for (const file of files) {
    const tokens = Math.ceil(file.patch.length / CHARS_PER_TOKEN);

    if (currentTokens + tokens > MAX_TOKENS && current.length > 0) {
      chunks.push({ files: current, estimatedTokens: currentTokens });
      current = [];
      currentTokens = 0;
    }

    current.push(file);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    chunks.push({ files: current, estimatedTokens: currentTokens });
  }

  return chunks;
}
