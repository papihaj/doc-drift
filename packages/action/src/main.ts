import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import {
  AnthropicProvider,
  OllamaProvider,
  DiffAnalyzer,
  DocRetriever,
  DriftDetector,
  buildPRComment,
  LLMProviderError,
  LLMTimeoutError,
  PRNotFoundError,
  GitHubAuthError,
} from "@docdrift/core";
import type { LLMProvider } from "@docdrift/core";

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
  const anthropicKey = core.getInput("anthropic-api-key");
  const ollamaKey = core.getInput("ollama-api-key");
  const modelId = core.getInput("model") || undefined;
  const scaffoldEnabled = core.getInput("scaffold-missing-docs") !== "false";
  const confluenceUrl = core.getInput("confluence-url") || undefined;
  const confluenceToken = core.getInput("confluence-api-token") || undefined;
  const confluenceConfigured = !!(confluenceUrl && confluenceToken);

  let llm: LLMProvider;
  if (ollamaKey) {
    llm = new OllamaProvider({ apiKey: ollamaKey, model: modelId ?? "gpt-oss" });
    core.info(`Using Ollama provider (${modelId ?? "gpt-oss"}) via ollama.com`);
  } else if (anthropicKey) {
    llm = new AnthropicProvider(anthropicKey, modelId);
    core.info(`Using Anthropic provider (${modelId ?? "claude-sonnet-4-6"})`);
  } else {
    core.setFailed("Either anthropic-api-key or ollama-api-key must be provided.");
    return;
  }

  const octokit = new Octokit({ auth: token });

  const analyzer = new DiffAnalyzer(octokit);
  const retriever = new DocRetriever(octokit);
  const detector = new DriftDetector(llm, scaffoldEnabled);

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

    if (docs.length === 0 && scaffoldEnabled) {
      core.info("No documentation files found. Running scaffold mode to suggest starter docs...");
    } else if (docs.length === 0) {
      core.info("No documentation files found. Skipping analysis (scaffold-missing-docs is disabled).");
      core.setOutput("findings-count", "0");
      return;
    } else {
      core.info(`Analyzing ${diff.files.length} changed files against ${docs.length} doc files...`);
    }
    const result = await detector.detect(diff.files, docs);

    core.info(`Found ${result.findings.length} drift findings in ${result.durationMs}ms.`);
    core.setOutput("findings-count", String(result.findings.length));

    const isFirstRun = await checkIsFirstRun(octokit, owner, repo, pullNumber);
    const comment = `${DOCDRIFT_COMMENT_MARKER}\n${buildPRComment(result, isFirstRun, { confluenceConfigured, confluenceUrl })}`;

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
