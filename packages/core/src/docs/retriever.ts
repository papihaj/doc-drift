import type { Octokit } from "@octokit/rest";
import { DocFormatError, GitHubRateLimitError, GitHubServerError } from "../errors.js";
import { MAX_PARALLEL_DOC_FETCHES } from "../drift/schemas.js";
import type { DiffFile } from "../diff/analyzer.js";

const DOC_PATTERNS = [
  /^README(\.\w+)?$/i,
  /^docs?\/.+\.mdx?$/i,
  /^\.?openapi\.(ya?ml|json)$/i,
  /^swagger\.(ya?ml|json)$/i,
  /^CHANGELOG(\.\w+)?$/i,
  /^CONTRIBUTING(\.\w+)?$/i,
  // additional common doc locations
  /^pages\/.+\.mdx?$/i,
  /^(website|site)\/docs?\/.+\.mdx?$/i,
  /^content\/.+\.mdx?$/i,
  /^wiki\/.+\.md$/i,
  /^src\/.+\.md$/i,
  /^(ARCHITECTURE|DESIGN|API|GUIDE|INSTALL|SETUP|USAGE)(\.\w+)?$/i,
];

const MAX_DOC_FILE_BYTES = 200 * 1024;

export interface DocFile {
  path: string;
  content: string;
}

export class DocRetriever {
  constructor(private readonly octokit: Octokit) {}

  async fetch(
    owner: string,
    repo: string,
    ref: string,
    changedFiles: DiffFile[],
  ): Promise<DocFile[]> {
    const docPaths = await this.discoverDocFiles(owner, repo, ref);

    const relevant = this.rankByRelevance(docPaths, changedFiles);
    const toFetch = relevant.slice(0, 20);

    const results = await this.fetchInBatches(owner, repo, ref, toFetch);
    return results.filter((d): d is DocFile => d !== null);
  }

  private async discoverDocFiles(owner: string, repo: string, ref: string): Promise<string[]> {
    try {
      const { data } = await this.octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: "1",
      });

      return (data.tree ?? [])
        .filter((item) => item.type === "blob" && item.path && DOC_PATTERNS.some((p) => p.test(item.path!)))
        .map((item) => item.path!);
    } catch (err) {
      if (isOctokitError(err)) {
        if (err.status === 403 && isRateLimit(err)) {
          const reset = new Date((err.response?.headers["x-ratelimit-reset"] as number) * 1000);
          throw new GitHubRateLimitError(reset, err);
        }
        if (err.status >= 500) throw new GitHubServerError(`GitHub server error: ${err.status}`, err);
      }
      throw err;
    }
  }

  private rankByRelevance(docPaths: string[], changedFiles: DiffFile[]): string[] {
    const changedDirs = new Set(changedFiles.map((f) => f.path.split("/")[0]));

    return [...docPaths].sort((a, b) => {
      const aDir = a.split("/")[0];
      const bDir = b.split("/")[0];
      const aMatch = changedDirs.has(aDir ?? "") ? 1 : 0;
      const bMatch = changedDirs.has(bDir ?? "") ? 1 : 0;
      return bMatch - aMatch;
    });
  }

  private async fetchInBatches(
    owner: string,
    repo: string,
    ref: string,
    paths: string[],
  ): Promise<(DocFile | null)[]> {
    const results: (DocFile | null)[] = [];

    for (let i = 0; i < paths.length; i += MAX_PARALLEL_DOC_FETCHES) {
      const batch = paths.slice(i, i + MAX_PARALLEL_DOC_FETCHES);
      const batchResults = await Promise.all(
        batch.map((path) => this.fetchFile(owner, repo, ref, path)),
      );
      results.push(...batchResults);
    }

    return results;
  }

  private async fetchFile(
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ): Promise<DocFile | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({ owner, repo, path, ref });

      if (Array.isArray(data) || data.type !== "file") return null;
      if (data.size > MAX_DOC_FILE_BYTES) return null;

      const content = Buffer.from(data.content, "base64").toString("utf8");
      return { path, content };
    } catch (err) {
      if (isOctokitError(err) && err.status === 404) return null;
      if (isOctokitError(err) && err.status === 403 && isRateLimit(err)) {
        const reset = new Date((err.response?.headers["x-ratelimit-reset"] as number) * 1000);
        throw new GitHubRateLimitError(reset, err);
      }
      throw new DocFormatError(path, err);
    }
  }
}

function isOctokitError(err: unknown): err is { status: number; response?: { headers: Record<string, unknown> } } {
  return typeof err === "object" && err !== null && "status" in err;
}

function isRateLimit(err: { response?: { headers: Record<string, unknown> } }): boolean {
  return err.response?.headers["x-ratelimit-remaining"] === "0";
}
