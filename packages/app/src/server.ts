import { Hono } from "hono";
import { InvalidWebhookSignatureError, PayloadTooLargeError } from "@docdrift/core";
import { validateWebhookSignature, isPREvent } from "./webhook/handler.js";
import { analyzePR } from "./jobs/analyze-pr.js";

const WEBHOOK_SECRET = process.env["WEBHOOK_SECRET"] ?? "";
const ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"] ?? "";
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"] ?? "";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/webhook", async (c) => {
  const eventName = c.req.header("x-github-event");

  let payload;
  try {
    ({ payload } = await validateWebhookSignature(c, WEBHOOK_SECRET));
  } catch (err) {
    if (err instanceof InvalidWebhookSignatureError) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (err instanceof PayloadTooLargeError) {
      return c.json({ error: "Payload too large" }, 413);
    }
    throw err;
  }

  if (!isPREvent(eventName, payload.action)) {
    return c.json({ status: "ignored" });
  }

  const pr = payload.pull_request;
  if (pr.draft) {
    return c.json({ status: "ignored", reason: "draft PR" });
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const idempotencyKey = `${owner}/${repo}#${pr.number}@${pr.head.sha}`;

  // Fire-and-forget: respond immediately, process async
  void analyzePR({
    owner,
    repo,
    pullNumber: pr.number,
    headSha: pr.head.sha,
    isFork: pr.head.repo?.fork ?? false,
    githubToken: GITHUB_TOKEN,
    anthropicApiKey: ANTHROPIC_API_KEY,
    idempotencyKey,
  }).then((result) => {
    console.log(JSON.stringify({
      event: "analysis.completed",
      idempotencyKey,
      ...result,
    }));
  }).catch((err: unknown) => {
    console.error(JSON.stringify({
      event: "analysis.failed",
      idempotencyKey,
      error: err instanceof Error ? err.message : String(err),
    }));
  });

  return c.json({ status: "queued", idempotencyKey });
});

const port = Number(process.env["PORT"] ?? 3000);
console.log(JSON.stringify({ event: "server.started", port }));

export default {
  port,
  fetch: app.fetch,
};
