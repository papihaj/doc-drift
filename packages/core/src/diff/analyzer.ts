import type { Octokit } from "@octokit/rest";
import {
  DiffTooLargeError,
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubServerError,
  PRNotFoundError,
} from "../errors.js";
import { MAX_DIFF_BYTES } from "../drift/schemas.js";

export interface ParsedDiff {
  files: DiffFile[];
  rawDiff: string;
  truncated: boolean;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

export class DiffAnalyzer {
  constructor(private readonly octokit: Octokit) {}

  async fetch(owner: string, repo: string, pullNumber: number): Promise<ParsedDiff> {
    const files = await this.fetchPRFiles(owner, repo, pullNumber);

    const rawParts: string[] = [];
    let totalBytes = 0;
    let truncated = false;
    const parsedFiles: DiffFile[] = [];

    for (const file of files) {
      const patch = file.patch ?? "";
      const bytes = Buffer.byteLength(patch, "utf8");

      if (totalBytes + bytes > MAX_DIFF_BYTES) {
        truncated = true;
        break;
      }

      totalBytes += bytes;
      rawParts.push(`--- a/${file.filename}\n+++ b/${file.filename}\n${patch}`);
      parsedFiles.push({
        path: file.filename,
        status: file.status as DiffFile["status"],
        additions: file.additions,
        deletions: file.deletions,
        patch,
      });
    }

    if (parsedFiles.length === 0 && files.length > 0) {
      throw new DiffTooLargeError(totalBytes);
    }

    return {
      files: parsedFiles,
      rawDiff: rawParts.join("\n"),
      truncated,
    };
  }

  private async fetchPRFiles(owner: string, repo: string, pullNumber: number) {
    try {
      const { data } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      return data;
    } catch (err: unknown) {
      if (isOctokitError(err)) {
        if (err.status === 401) throw new GitHubAuthError("Invalid GitHub token", err);
        if (err.status === 403 && isRateLimit(err)) {
          const reset = new Date((err.response?.headers["x-ratelimit-reset"] as number) * 1000);
          throw new GitHubRateLimitError(reset, err);
        }
        if (err.status === 404) throw new PRNotFoundError(`PR #${pullNumber} not found in ${owner}/${repo}`, err);
        if (err.status >= 500) throw new GitHubServerError(`GitHub server error: ${err.status}`, err);
      }
      throw err;
    }
  }
}

function isOctokitError(err: unknown): err is { status: number; response?: { headers: Record<string, unknown> } } {
  return typeof err === "object" && err !== null && "status" in err;
}

function isRateLimit(err: { response?: { headers: Record<string, unknown> } }): boolean {
  return err.response?.headers["x-ratelimit-remaining"] === "0";
}
