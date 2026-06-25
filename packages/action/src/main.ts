import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import {
  AnthropicProvider,
  HuggingFaceProvider,
  FallbackProvider,
  DiffAnalyzer,
  DocRetriever,
  ConfluenceRetriever,
  ConfluenceWriter,
  DriftDetector,
  buildPRComment,
  buildTemplatePrompt,
  classifyChange,
  LLMProviderError,
  LLMTimeoutError,
  LLMParseError,
  PRNotFoundError,
  GitHubAuthError,
  LLMRateLimitError,
  GitHubRateLimitError,
} from "@docdrift/core";
import type { LLMProvider, LayoutRecommendation } from "@docdrift/core";

const DOCDRIFT_COMMENT_MARKER = "<!-- docdrift-analysis -->";

async function run(): Promise<void> {
  const ctx = github.context;
  const isPR = ctx.eventName === "pull_request";
  const isPush = ctx.eventName === "push";
  const isComment = ctx.eventName === "issue_comment";

  if (!isPR && !isPush && !isComment) {
    core.info(`DocDrift only runs on pull_request, push, and issue_comment events. Got: ${ctx.eventName}. Skipping.`);
    return;
  }

  const { owner, repo } = ctx.repo;
  const token = core.getInput("github-token", { required: true });

  if (isComment) {
    await runCommentEvent({ ctx, octokit: new Octokit({ auth: token }), owner, repo });
    return;
  }
  const hfKey = core.getInput("huggingface-api-key") || undefined;
  const anthropicKey = core.getInput("anthropic-api-key") || undefined;
  const modelId = core.getInput("model") || undefined;
  const confluenceUrl = core.getInput("confluence-url") || undefined;
  const confluenceEmail = core.getInput("confluence-email") || undefined;
  const confluenceToken = core.getInput("confluence-api-token") || undefined;
  const confluenceSpaceKey = core.getInput("confluence-space-key") || undefined;
  const confluenceParentPageId = core.getInput("confluence-parent-page-id") || undefined;
  const confluencePreview = core.getInput("confluence-preview") === "true";
  const docTemplate = core.getInput("doc-template") || "auto";
  const releaseTagPrefix = core.getInput("release-tag-prefix") || "v";
  const scaffoldEnabled = core.getInput("scaffold-missing-docs") !== "false";
  const confluenceConfigured = !!(confluenceUrl && confluenceToken);

  if (!hfKey && !anthropicKey) {
    core.setFailed("Either huggingface-api-key or anthropic-api-key is required.");
    return;
  }

  const llm = buildLLMProvider({ hfKey, anthropicKey, modelId });

  const octokit = new Octokit({ auth: token });
  const analyzer = new DiffAnalyzer(octokit);

  if (isPush) {
    await runPushEvent({ ctx, octokit, analyzer, llm, owner, repo, confluenceConfigured, confluenceUrl, confluenceToken, confluenceEmail, confluenceSpaceKey, confluenceParentPageId, confluencePreview, releaseTagPrefix });
    return;
  }

  // --- PR flow ---
  const pr = ctx.payload.pull_request;
  if (!pr) { core.setFailed("No pull_request payload found."); return; }
  if (pr.draft) { core.info("Draft PR detected. Skipping."); return; }

  const pullNumber = pr.number as number;
  const headSha = pr.head.sha as string;
  const isFork = pr.head.repo?.fork === true;
  const branchName = (pr.head.ref as string) ?? "";
  const prLabels: string[] = ((pr.labels as { name: string }[]) ?? []).map((l) => l.name);

  const retriever = new DocRetriever(octokit);
  const confluenceRetriever = confluenceConfigured
    ? new ConfluenceRetriever({ baseUrl: confluenceUrl!, apiToken: confluenceToken!, email: confluenceEmail, spaceKey: confluenceSpaceKey })
    : null;
  const detector = new DriftDetector(llm, scaffoldEnabled);

  try {
    core.info(`Fetching diff for PR #${pullNumber}...`);
    const diff = await analyzer.fetch(owner, repo, pullNumber);

    if (diff.files.length === 0) {
      core.info("No changed files found. Skipping.");
      core.setOutput("findings-count", "0");
      return;
    }

    if (diff.truncated) {
      core.warning(`Diff truncated — analyzing first ${diff.files.length} files.`);
    }

    // Classify what kind of docs this PR needs
    const selectedTemplates = classifyChange(branchName, prLabels, diff.files, docTemplate);
    if (selectedTemplates.length > 0) {
      core.info(`Template classification: ${selectedTemplates.join(", ")} (branch: ${branchName}, labels: ${prLabels.join(", ") || "none"})`);
    }

    core.info("Fetching relevant doc files...");
    const [repoDocs, confluenceDocs] = await Promise.all([
      retriever.fetch(owner, repo, headSha, diff.files),
      confluenceRetriever ? confluenceRetriever.fetch(diff.files) : Promise.resolve([]),
    ]);

    if (confluenceDocs.length > 0) {
      core.info(`Fetched ${confluenceDocs.length} Confluence page(s).`);
    }

    const docs = [...repoDocs, ...confluenceDocs];
    if (docs.length === 0 && !scaffoldEnabled) {
      core.info("No documentation found and scaffold-missing-docs is disabled. Skipping.");
      core.setOutput("findings-count", "0");
      return;
    }

    core.info(`Analyzing ${diff.files.length} changed files against ${docs.length} doc file(s)...`);
    const result = await detector.detect(diff.files, docs);
    core.info(`Found ${result.findings.length} drift findings in ${result.durationMs}ms.`);
    core.setOutput("findings-count", String(result.findings.length));

    const confluenceEmpty = confluenceConfigured && confluenceDocs.length === 0;
    if (confluenceConfigured && confluenceDocs.length > 0) {
      core.info(`Confluence: found ${confluenceDocs.length} existing page(s) — will update if templates match.`);
    }
    if (!confluenceConfigured) {
      core.info("Confluence: not configured. Skipping page creation.");
    }

    // Fetch space structure to produce a layout recommendation before creating pages
    let layoutRecommendation: LayoutRecommendation | undefined;
    if (confluenceConfigured && confluenceSpaceKey && confluenceRetriever && selectedTemplates.length > 0) {
      const structure = await confluenceRetriever.fetchSpaceStructure(confluenceSpaceKey);
      if (structure) {
        layoutRecommendation = confluenceRetriever.recommendLayout(structure, diff.files);
        core.info(`Confluence layout recommendation: ${layoutRecommendation.recommendation} — ${layoutRecommendation.rationale}`);
      }
    }

    // Check if the user already replied with a layout choice in a prior comment
    const layoutChoice = await getLayoutChoiceFromComments(octokit, owner, repo, pullNumber);
    if (layoutChoice) {
      core.info(`Confluence layout choice from PR comment: ${layoutChoice}`);
      layoutRecommendation = undefined; // user chose — no longer show the prompt
    }

    let createdPages: { title: string; url: string; wasUpdated?: boolean }[] = [];
    let dryRunPages: { title: string; content: string }[] = [];
    let confluenceSuggestions = result.scaffoldSuggestions;

    if (confluenceConfigured && selectedTemplates.length > 0) {
      if (!confluenceSpaceKey) {
        core.warning("confluence-space-key is required to create pages. Add it to your workflow.");
      } else {
        core.info(`Confluence: generating ${selectedTemplates.length} page(s) using templates: ${selectedTemplates.join(", ")}...`);
        const writer = makeConfluenceWriter(confluenceUrl!, confluenceToken!, confluenceEmail, confluenceSpaceKey);

        for (const templateType of selectedTemplates) {
          try {
            const prompt = buildTemplatePrompt(templateType, diff.files, result.findings);
            const output = await llm.scaffold(prompt);

            for (const suggestion of output.suggestedDocs) {
              if (confluencePreview) {
                dryRunPages.push({ title: suggestion.filename, content: suggestion.content });
                core.info(`Confluence (dry-run): would create "${suggestion.filename}"`);
              } else {
                const page = await writer.upsertPage(suggestion.filename, suggestion.content, confluenceSpaceKey, confluenceParentPageId);
                createdPages.push({ title: page.title, url: page.url, wasUpdated: page.wasUpdated });
                core.info(`Confluence: ${page.wasUpdated ? "updated" : "created"} "${page.title}" — ${page.url}`);
              }
            }
          } catch (templateErr) {
            const detail = templateErr instanceof LLMParseError
              ? templateErr.raw
              : templateErr instanceof Error ? templateErr.message : String(templateErr);
            core.warning(`Template "${templateType}" failed: ${detail}`);
          }
        }

        if (!confluencePreview) {
          core.info(`Confluence: ${createdPages.length} page(s) created/updated.`);
        }
      }
    } else if (confluenceConfigured && selectedTemplates.length === 0) {
      core.info("Confluence: no templates selected for this PR (fix/patch branch). No pages created.");
    }

    const isFirstRun = await checkIsFirstRun(octokit, owner, repo, pullNumber);
    const comment = `${DOCDRIFT_COMMENT_MARKER}\n${buildPRComment(result, isFirstRun, {
      confluenceConfigured,
      confluenceUrl,
      confluenceSpaceKey,
      confluenceEmpty,
      confluenceSuggestions,
      createdPages,
      dryRunPages: dryRunPages.length > 0 ? dryRunPages : undefined,
      plannedTemplates: confluenceEmpty && confluenceConfigured && !confluenceSpaceKey ? selectedTemplates : undefined,
      layoutRecommendation,
    })}`;

    if (isFork) {
      core.info("Fork PR — skipping comment. Findings logged above.");
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
    if (err instanceof LLMTimeoutError || err instanceof LLMProviderError || err instanceof LLMRateLimitError) {
      core.warning(`DocDrift temporarily unavailable: ${(err as Error).message}`);
      if (!isFork) {
        await upsertComment(octokit, owner, repo, pullNumber,
          `${DOCDRIFT_COMMENT_MARKER}\n> DocDrift is temporarily unavailable. Analysis will run on the next push.`);
      }
      return;
    }
    if (err instanceof GitHubRateLimitError) {
      const resetAt = (err as InstanceType<typeof GitHubRateLimitError>).resetAt;
      core.warning(`GitHub rate limit hit. Resets at ${resetAt.toISOString()}.`);
      return;
    }
    throw err;
  }
}

async function runPushEvent(opts: {
  ctx: typeof github.context;
  octokit: Octokit;
  analyzer: DiffAnalyzer;
  llm: LLMProvider;
  owner: string;
  repo: string;
  confluenceConfigured: boolean;
  confluenceUrl?: string;
  confluenceToken?: string;
  confluenceEmail?: string;
  confluenceSpaceKey?: string;
  confluenceParentPageId?: string;
  confluencePreview: boolean;
  releaseTagPrefix: string;
}): Promise<void> {
  const { ctx, octokit, analyzer, llm, owner, repo, confluenceConfigured, confluenceUrl, confluenceToken, confluenceEmail, confluenceSpaceKey, confluenceParentPageId, confluencePreview, releaseTagPrefix } = opts;

  // Only run on pushes to default branch or release branches
  const pushedBranch = ctx.ref.replace("refs/heads/", "");
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const isDefaultBranch = pushedBranch === repoData.default_branch;
  const isReleaseBranch = /^(main|master|release\/.+)$/.test(pushedBranch);

  if (!isDefaultBranch && !isReleaseBranch) {
    core.info(`Push to ${pushedBranch} — not default branch or release branch. Skipping release notes.`);
    return;
  }

  if (!confluenceConfigured) {
    core.info("Push event: Confluence not configured. Release notes require confluence-url and confluence-api-token.");
    return;
  }

  if (!confluenceSpaceKey) {
    core.warning("Push event: confluence-space-key is required to create release notes. Add it to your workflow.");
    return;
  }

  core.info(`Push to ${pushedBranch} — generating release notes since last release tag (prefix: "${releaseTagPrefix}")...`);

  let diff, release;
  try {
    ({ diff, release } = await analyzer.fetchSinceTag(owner, repo, ctx.sha, releaseTagPrefix));
  } catch (err) {
    core.warning(`Could not fetch diff since last release: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (diff.files.length === 0) {
    core.info("No changed files since last release. Skipping release notes.");
    return;
  }

  core.info(`Release notes: ${diff.files.length} files changed since ${release.tagName}. ${release.mergedPRs.length} PR(s) merged.`);

  const prompt = buildTemplatePrompt("release-notes", diff.files, [], {
    version: release.version,
    mergedPRs: release.mergedPRs,
  });

  let output;
  try {
    output = await llm.scaffold(prompt);
  } catch (err) {
    const detail = err instanceof LLMParseError ? err.raw : err instanceof Error ? err.message : String(err);
    core.warning(`Release notes generation failed: ${detail}`);
    return;
  }

  if (!output.suggestedDocs.length) {
    core.info("No customer-visible changes detected. Skipping release notes page creation.");
    return;
  }

  const writer = makeConfluenceWriter(confluenceUrl!, confluenceToken!, confluenceEmail, confluenceSpaceKey);

  for (const suggestion of output.suggestedDocs) {
    if (confluencePreview) {
      core.info(`Release notes (dry-run): would create "${suggestion.filename}" — content logged below.`);
      core.info(suggestion.content.slice(0, 2000));
    } else {
      try {
        const page = await writer.upsertPage(suggestion.filename, suggestion.content, confluenceSpaceKey, confluenceParentPageId);
        core.info(`Release notes: ${page.wasUpdated ? "updated" : "created"} "${page.title}" — ${page.url}`);
      } catch (pageErr) {
        core.warning(`Failed to create release notes page "${suggestion.filename}": ${pageErr instanceof Error ? pageErr.message : String(pageErr)}`);
      }
    }
  }
}

function makeConfluenceWriter(
  url: string,
  token: string,
  email: string | undefined,
  spaceKey: string | undefined,
): ConfluenceWriter {
  return new ConfluenceWriter({
    baseUrl: url,
    apiToken: token,
    ...(email ? { email } : {}),
    ...(spaceKey ? { spaceKey } : {}),
  });
}

/** Paginates through all PR comments to find the DocDrift marker (avoids per_page:50 miss). */
async function findDocDriftComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ id: number } | null> {
  let page = 1;
  while (true) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner, repo, issue_number: pullNumber, per_page: 100, page,
    });
    const found = comments.find((c) => c.body?.includes(DOCDRIFT_COMMENT_MARKER));
    if (found) return { id: found.id };
    if (comments.length < 100) return null;
    page++;
  }
}

async function checkIsFirstRun(octokit: Octokit, owner: string, repo: string, pullNumber: number): Promise<boolean> {
  const existing = await findDocDriftComment(octokit, owner, repo, pullNumber);
  return existing === null;
}

async function upsertComment(octokit: Octokit, owner: string, repo: string, pullNumber: number, body: string): Promise<void> {
  const existing = await findDocDriftComment(octokit, owner, repo, pullNumber);
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
  }
}

/** Handles `/docdrift single-page` or `/docdrift multi-page` replies on PR comments. */
async function runCommentEvent(opts: {
  ctx: typeof github.context;
  octokit: Octokit;
  owner: string;
  repo: string;
}): Promise<void> {
  const { ctx, octokit, owner, repo } = opts;
  const comment = ctx.payload.comment as { body?: string; user?: { login: string } } | undefined;
  const issue = ctx.payload.issue as { number?: number; pull_request?: unknown } | undefined;

  // Only handle comments on PRs (not regular issues)
  if (!issue?.pull_request || !issue.number) {
    core.info("issue_comment: not a PR comment. Skipping.");
    return;
  }

  const body = comment?.body ?? "";
  const choice = body.match(/\/docdrift\s+(single-page|multi-page)/i)?.[1]?.toLowerCase();
  if (!choice) {
    core.info("issue_comment: no /docdrift command found. Skipping.");
    return;
  }

  // Verify commenter has write/maintain/admin access
  const actor = comment?.user?.login ?? "";
  const { data: perm } = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner, repo, username: actor,
  });
  const allowedPerms = ["write", "maintain", "admin"];
  if (!allowedPerms.includes(perm.permission)) {
    core.info(`issue_comment: ${actor} has permission "${perm.permission}" — not authorised to set layout. Skipping.`);
    return;
  }

  core.info(`Confluence layout choice "${choice}" from @${actor} on PR #${issue.number}.`);
  // Post an acknowledgement comment — actual page creation happens on next PR push
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue.number,
    body: `> DocDrift received your layout choice: **${choice}**. Pages will be created using the **${choice === "single-page" ? "single comprehensive page" : "multiple focused pages"}** layout on the next commit push to this PR.`,
  });
}

/**
 * Scans PR comments for a prior `/docdrift single-page|multi-page` reply.
 * Returns the chosen layout or null if no choice has been made.
 */
async function getLayoutChoiceFromComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<"single-page" | "multi-page" | null> {
  let page = 1;
  while (true) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner, repo, issue_number: pullNumber, per_page: 100, page,
    });
    for (const c of comments) {
      const match = c.body?.match(/\/docdrift\s+(single-page|multi-page)/i);
      if (match) return match[1]!.toLowerCase() as "single-page" | "multi-page";
    }
    if (comments.length < 100) break;
    page++;
  }
  return null;
}

function buildLLMProvider(opts: {
  hfKey: string | undefined;
  anthropicKey: string | undefined;
  modelId: string | undefined;
}): LLMProvider {
  const { hfKey, anthropicKey, modelId } = opts;

  if (hfKey) {
    const hfModel = modelId ?? "deepseek-ai/DeepSeek-V4-Pro:novita";
    const hfProvider = new HuggingFaceProvider({ apiKey: hfKey, model: hfModel });
    if (anthropicKey) {
      const anthropicProvider = new AnthropicProvider(anthropicKey, "claude-haiku-4-5-20251001");
      core.info(`Using HuggingFace (${hfModel}) with Anthropic fallback`);
      return new FallbackProvider(hfProvider, anthropicProvider);
    }
    core.info(`Using HuggingFace (${hfModel})`);
    return hfProvider;
  }

  const anthropicModel = modelId ?? "claude-haiku-4-5-20251001";
  core.info(`Using Anthropic (${anthropicModel})`);
  return new AnthropicProvider(anthropicKey!, anthropicModel);
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
