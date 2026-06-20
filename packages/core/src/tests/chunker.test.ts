import { describe, it, expect } from "vitest";
import { chunkDiff } from "../diff/chunker.js";
import type { DiffFile } from "../diff/analyzer.js";

function makeFile(path: string, patchSize: number): DiffFile {
  return {
    path,
    status: "modified",
    additions: 10,
    deletions: 5,
    patch: "x".repeat(patchSize),
  };
}

describe("chunkDiff", () => {
  it("returns single chunk for small diffs", () => {
    const files = [makeFile("a.ts", 100), makeFile("b.ts", 200)];
    const chunks = chunkDiff(files);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.files).toHaveLength(2);
  });

  it("returns empty chunks for empty input", () => {
    expect(chunkDiff([])).toHaveLength(0);
  });

  it("splits into multiple chunks when context limit would be exceeded", () => {
    const bigPatch = "x".repeat(90_000 * 4);
    const files = [makeFile("a.ts", bigPatch.length), makeFile("b.ts", 100)];
    const chunks = chunkDiff(files);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("never puts an empty chunk in the result", () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile(`file${i}.ts`, 50));
    const chunks = chunkDiff(files);
    for (const chunk of chunks) {
      expect(chunk.files.length).toBeGreaterThan(0);
    }
  });

  it("preserves all files across chunks", () => {
    const bigPatch = "x".repeat(90_000 * 4);
    const files = [
      makeFile("a.ts", bigPatch.length),
      makeFile("b.ts", bigPatch.length),
      makeFile("c.ts", 50),
    ];
    const chunks = chunkDiff(files);
    const allFiles = chunks.flatMap((c) => c.files);
    expect(allFiles.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
