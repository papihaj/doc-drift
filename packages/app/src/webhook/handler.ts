import { createHmac, timingSafeEqual } from "crypto";
import type { Context } from "hono";
import { InvalidWebhookSignatureError, PayloadTooLargeError } from "@docdrift/core";

const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

export interface PRWebhookPayload {
  action: "opened" | "synchronize" | "reopened";
  number: number;
  pull_request: {
    number: number;
    draft: boolean;
    head: { sha: string; repo: { fork: boolean } | null };
  };
  repository: {
    name: string;
    owner: { login: string };
  };
  installation?: { id: number };
}

export async function validateWebhookSignature(
  c: Context,
  secret: string,
): Promise<{ raw: string; payload: PRWebhookPayload }> {
  const signature = c.req.header("x-hub-signature-256");
  if (!signature) throw new InvalidWebhookSignatureError("Missing X-Hub-Signature-256 header");

  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError("Webhook payload exceeds size limit");
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new InvalidWebhookSignatureError("Signature mismatch");
  }

  const payload = JSON.parse(rawBody) as PRWebhookPayload;
  return { raw: rawBody, payload };
}

export function isPREvent(eventName: string | undefined, action: string): boolean {
  return (
    eventName === "pull_request" &&
    (action === "opened" || action === "synchronize" || action === "reopened")
  );
}
