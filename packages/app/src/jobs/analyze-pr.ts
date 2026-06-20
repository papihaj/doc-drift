import { Octokit } from "@octokit/rest";
import {
  AnthropicProvider,
  DiffAnalyzer,
  DocRetriever,
  DriftDetector,
  buildPRComment,
  LLMProviderError,
  LLMTimeoutError,
  PRNotFoundError,
} from "@docdrift/core";

const DOCDRIFT_COMMENT_MARKER = "<!-- docdrift-analysis -->";

export interface AnalyzePRJob {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  isFork: boolean;
  githubToken: string;
  anthropicApiKey: string;
  idempotencyKey: string;
}

export interface JobResult {
  status: "complete" | "failed" | "degraded" | "skipped";
  findingsCount: number;
  durationMs: number;
  error?: string;
}

export async function analyzePR(job: AnalyzePRJob): Promise<JobResult> {
  const start = Date.now();
  const { owner, repo, pullNumber, headSha, isFork, githubToken, anthropicApiKey } = job;

  const octokit = new Octokit({ auth: githubToken });
  const llm = new AnthropicProvider(anthropicApiKey);
  const analyzer = new DiffAnalyzer(octokit);
  const retriever = new DocRetriever(octokit);
  const detector = new DriftDetector(llm);

  try {
    const diff = await analyzer.fetch(owner, repo, pullNumber);

    if (diff.files.length === 0) {
      return { status: "skipped", findingsCount: 0, durationMs: Date.now() - start };
    }

    const docs = await retriever.fetch(owner, repo, headSha, diff.files);

    if (docs.length === 0) {
      return { status: "skipped", findingsCount: 0, durationMs: Date.now() - start };
    }

    const result = await detector.detect(diff.files, docs);

    const isFirst = await checkIsFirstRun(octokit, owner, repo, pullNumber);
    const comment = `${DOCDRIFT_COMMENT_MARKER}\n${buildPRComment(result, isFirst)}`;

    if (!isFork) {
      await upsertComment(octokit, owner, repo, pullNumber, comment);
    }

    return {
      status: "complete",
      findingsCount: result.findings.length,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    if (err instanceof PRNotFoundError) {
      return { status: "skipped", findingsCount: 0, durationMs: Date.now() - start };
    }

    if (err instanceof LLMTimeoutError || err instanceof LLMProviderError) {
      if (!isFork) {
        await upsertComment(
          octokit,
          owner,
          repo,
          pullNumber,
          `${DOCDRIFT_COMMENT_MARKER}\n> DocDrift is temporarily unavailable. Analysis will run on the next push.`,
        ).catch(() => {});
      }
      return {
        status: "degraded",
        findingsCount: 0,
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }

    return {
      status: "failed",
      findingsCount: 0,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

async function checkIsFirstRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<boolean> {
  const { data } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 50,
  });
  return !data.some((c) => c.body?.includes(DOCDRIFT_COMMENT_MARKER));
}

async function upsertComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
): Promise<void> {
  const { data } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 50,
  });

  const existing = data.find((c) => c.body?.includes(DOCDRIFT_COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
  }
}
