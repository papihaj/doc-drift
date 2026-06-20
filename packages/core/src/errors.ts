export class DocDriftError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class GitHubAuthError extends DocDriftError {}
export class GitHubRateLimitError extends DocDriftError {
  constructor(
    public readonly resetAt: Date,
    cause?: unknown,
  ) {
    super(`GitHub rate limit exceeded, resets at ${resetAt.toISOString()}`, cause);
  }
}
export class GitHubServerError extends DocDriftError {}
export class PRNotFoundError extends DocDriftError {}
export class DiffTooLargeError extends DocDriftError {
  constructor(public readonly sizeBytes: number) {
    super(`Diff size ${sizeBytes} bytes exceeds maximum allowed`);
  }
}
export class NoDriftableDocsError extends DocDriftError {}
export class DocFormatError extends DocDriftError {
  constructor(public readonly filePath: string, cause?: unknown) {
    super(`Cannot parse doc file: ${filePath}`, cause);
  }
}

export class LLMTimeoutError extends DocDriftError {}
export class LLMRateLimitError extends DocDriftError {}
export class LLMProviderError extends DocDriftError {}
export class LLMParseError extends DocDriftError {
  constructor(
    public readonly raw: string,
    cause?: unknown,
  ) {
    super("LLM returned a response that failed schema validation", cause);
  }
}
export class LLMEmptyResponseError extends DocDriftError {}
export class ContextWindowError extends DocDriftError {
  constructor(public readonly estimatedTokens: number) {
    super(`Prompt exceeds context window (~${estimatedTokens} tokens)`);
  }
}

export class InvalidFindingError extends DocDriftError {}
export class InsufficientPermissionsError extends DocDriftError {}
export class InvalidWebhookSignatureError extends DocDriftError {}
export class PayloadTooLargeError extends DocDriftError {}
