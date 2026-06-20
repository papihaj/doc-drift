import * as core from "@actions/core";
import * as github from "@actions/github";
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
  GitHubAuthError,
  NoDriftableDocsError,
} from "@docdrift/core";

const DOCDRIFT_COMMENT_MARKER = "<!-- docdrift-analysis -->";

async function run(): Promise<void> {
  const ctx = github.context;

  if (ctx.eventName !== "pull_request") {
    core.info("DocDrift only runs on pull_request events. Skipping.");
    return;
  }

  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.setFailed("No pull_request payload found.");
    return;
  }

  if (pr.draft) {
    core.info("Draft PR detected. Skipping DocDrift analysis.");
    return;
  }

  const { owner, repo } = ctx.repo;
  const pullNumber = pr.number;
  const headSha = pr.head.sha as string;
  const isFork = pr.head.repo?.fork === true;

  const token = core.getInput("github-token", { required: true });
  const apiKey = core.getInput("anthropic-api-key", { required: true });
  const modelId = core.getInput("model") || undefined;

  const octokit = new Octokit({ auth: token });
  const llm = new AnthropicProvider(apiKey, modelId);

  const analyzer = new DiffAnalyzer(octokit);
  const retriever = new DocRetriever(octokit);
  const detector = new DriftDetector(llm);

  try {
    core.info(`Fetching diff for PR #${pullNumber}...`);
    const diff = await analyzer.fetch(owner, repo, pullNumber);

    if (diff.files.length === 0) {
      core.info("No changed files found. Skipping analysis.");
      core.setOutput("findings-count", "0");
      return;
    }

    if (diff.truncated) {
      core.warning(`Diff truncated — analyzing first ${diff.files.length} changed files.`);
    }

    core.info(`Fetching relevant doc files...`);
    const docs = await retriever.fetch(owner, repo, headSha, diff.files);

    if (docs.length === 0) {
      core.info("No documentation files found in this repository. Skipping analysis.");
      core.setOutput("findings-count", "0");
      return;
    }

    core.info(`Analyzing ${diff.files.length} changed files against ${docs.length} doc files...`);
    const result = await detector.detect(diff.files, docs);

    core.info(`Found ${result.findings.length} drift findings in ${result.durationMs}ms.`);
    core.setOutput("findings-count", String(result.findings.length));

    const isFirstRun = await checkIsFirstRun(octokit, owner, repo, pullNumber);
    const comment = `${DOCDRIFT_COMMENT_MARKER}\n${buildPRComment(result, isFirstRun)}`;

    if (isFork) {
      core.info("PR is from a fork — skipping comment (insufficient permissions). Findings logged above.");
      core.info(comment);
      return;
    }

    await upsertComment(octokit, owner, repo, pullNumber, comment);
    core.info("DocDrift analysis posted to PR.");
  } catch (err) {
    if (err instanceof PRNotFoundError || err instanceof GitHubAuthError) {
      core.setFailed(`DocDrift config error: ${(err as Error).message}`);
      return;
    }
    if (err instanceof LLMTimeoutError || err instanceof LLMProviderError) {
      core.warning(`DocDrift temporarily unavailable: ${(err as Error).message}`);
      if (!isFork) {
        await upsertComment(
          octokit,
          owner,
          repo,
          pullNumber,
          `${DOCDRIFT_COMMENT_MARKER}\n> DocDrift is temporarily unavailable. Analysis will run on the next push.`,
        );
      }
      return;
    }
    throw err;
  }
}

async function checkIsFirstRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<boolean> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 50,
  });
  return !comments.some((c) => c.body?.includes(DOCDRIFT_COMMENT_MARKER));
}

async function upsertComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
): Promise<void> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 50,
  });

  const existing = comments.find((c) => c.body?.includes(DOCDRIFT_COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
