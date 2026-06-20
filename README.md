# DocDrift

Detect documentation drift on every pull request. DocDrift checks whether your code changes made existing documentation stale — and posts findings as PR comments so nothing ships undocumented.

If a repo has no documentation at all, DocDrift generates starter doc stubs based on the PR diff so you can add them in the same PR.

---

## How it works

```
Pull request opened / updated
         │
         ▼
  Fetch doc files from repo
  (README, docs/*.md, openapi.yaml, ...)
         │
    ┌────┴────────────────────┐
    │                         │
 docs found               no docs found
    │                         │
    ▼                         ▼
Analyze diff vs docs    Generate doc stubs
(drift detection)       (scaffold mode)
    │                         │
    └──────────┬──────────────┘
               │
       Post PR comment
```

DocDrift is distributed as:

- **GitHub Action** — free, runs in your CI, no server required
- **GitHub App** — SaaS tier with persistence and a dashboard (coming soon)

Both share the same `@docdrift/core` analysis library.

---

## Quick start (GitHub Action)

### 1. Add the workflow

Create `.github/workflows/docdrift.yml` in your repo:

```yaml
name: DocDrift

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  docdrift:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: docdrift/docdrift@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 2. Add your Anthropic API key

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

- Name: `ANTHROPIC_API_KEY`
- Value: your key from [console.anthropic.com](https://console.anthropic.com)

### 3. Add a DocDrift section to your repo's README

Paste this into your project's README so contributors and AI agents know DocDrift is active:

````markdown
## Documentation

This repo uses [DocDrift](https://github.com/papihaj/doc-drift) to keep documentation in sync with code changes.

**For contributors:** DocDrift runs on every PR. If your code change affects documented behavior (API signatures, config options, endpoints), update the relevant doc file in the same PR. DocDrift will flag anything you miss and suggest the exact diff to apply.

**For AI coding agents:** Before generating code that calls internal APIs or uses config, read the doc files in `docs/` and `README.md` first — they reflect the current behavior. If DocDrift posted a comment on this PR, apply the suggested doc updates before marking your task complete.

Doc files this repo tracks:
- `README.md` — project overview and usage
- `docs/` — API reference and guides
- `openapi.yaml` — HTTP API schema (if present)
````

### 4. Open a pull request

DocDrift posts a comment on every PR with findings. On a repo with no docs yet, it generates starter doc stubs instead.

---

## Configuration

All inputs are optional except `anthropic-api-key`.

| Input | Default | Description |
|---|---|---|
| `anthropic-api-key` | — | Anthropic API key. Required when using the Anthropic provider. |
| `github-token` | `${{ github.token }}` | GitHub token for reading diffs and posting comments. The default token is sufficient for most repos. |
| `model` | `claude-sonnet-4-6` | Model to use for analysis. Set to `gpt-oss` or `gpt-oss:120b` when using Ollama. |
| `confidence-threshold` | `0.7` | Minimum confidence score (0–1) for a finding to be reported. Raise this to reduce noise; lower it to catch more potential drift. |
| `scaffold-missing-docs` | `true` | When no doc files exist, generate starter documentation stubs as a PR comment. Set to `false` to disable. |

### Example with all options

```yaml
- uses: docdrift/docdrift@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    model: claude-sonnet-4-6
    confidence-threshold: "0.8"
    scaffold-missing-docs: "true"
```

---

## Running with Ollama (free, no Anthropic key)

DocDrift supports [gpt-oss](https://ollama.com/library/gpt-oss) via Ollama as a free alternative to the Anthropic API.

### Option A: Local (runs on your machine)

```bash
ollama pull gpt-oss        # 20B model, 14GB RAM
ollama pull gpt-oss:120b   # 120B model, 65GB RAM
ollama serve               # must be running before analysis starts
```

```typescript
import { OllamaProvider, DriftDetector } from "@docdrift/core";

// No key needed — talks to localhost:11434 automatically
const llm = new OllamaProvider();
const detector = new DriftDetector(llm);
```

### Option B: Ollama Cloud (API key, no local GPU needed)

Create an API key at [ollama.com/settings/keys](https://ollama.com/settings/keys), then:

```bash
export OLLAMA_API_KEY=your_key_here
```

```typescript
import { OllamaProvider, DriftDetector } from "@docdrift/core";

// Reads OLLAMA_API_KEY from env, routes to https://ollama.com/api automatically
const llm = new OllamaProvider({ model: "gpt-oss:120b" });
const detector = new DriftDetector(llm);
```

| Variant | RAM needed | Best for |
|---|---|---|
| `gpt-oss` / `gpt-oss:20b` | 16GB | Local development |
| `gpt-oss:120b` | 80GB | Cloud or high-memory machines |

---

## What DocDrift checks

DocDrift detects **high-confidence** mismatches between code changes and documentation. It focuses on:

- API signature changes (added/removed/renamed parameters)
- Renamed functions, methods, or endpoints
- Changed behavior flags or configuration defaults
- Added or removed endpoints

It does **not** report vague suggestions, stylistic improvements, or speculative changes.

### Doc files DocDrift reads

```
README.md / README.*
docs/**/*.md
openapi.yaml / openapi.json / swagger.yaml / swagger.json
CHANGELOG.*
CONTRIBUTING.*
```

---

## PR comment format

**When drift is found:**

```
## DocDrift Analysis

2 documentation drift findings detected (1 high, 1 medium)

### 🔴 createUser signature changed
**File:** `docs/api.md` · **Confidence:** 95%

The `role` parameter is now required but the docs still show the old signature.

**Suggested update:**
```diff
-createUser(name)
+createUser(name, role)
` ` `

---
_Analyzed in 4.2s · 2 doc files checked · claude-sonnet-4-6_
```

**When no docs exist (scaffold mode):**

```
## DocDrift Analysis

📄 No existing documentation found. DocDrift generated 1 starter doc stub based on this PR.

### 📝 `README.md`
_No README found; top-level overview needed_

` ` `markdown
# Project

A user management API.
` ` `
```

**When docs are up to date:**

```
✅ No drift detected. DocDrift checked 3 doc files — all up to date.
```

---

## Fork PRs

DocDrift posts a **status check** on fork PRs (no comment) because GitHub Actions do not have write access to fork PR comments. The check passes or fails based on whether high-severity drift is found.

---

## Permissions

The action requires:

```yaml
permissions:
  pull-requests: write   # post PR comments
  contents: read         # read doc files and diff
```

---

## For AI agents

> This section is written for AI coding assistants integrating DocDrift into a codebase or automation workflow. It covers the full programmatic API with types and error contracts.

### What DocDrift returns

Every analysis produces a `DetectionResult`:

```typescript
interface DetectionResult {
  findings: Finding[];              // drift findings, sorted high→medium→low, max 10
  checkedDocFiles: string[];        // doc file paths that were read
  chunksAnalyzed: number;           // number of diff chunks sent to the LLM
  modelId: string;                  // model that ran the analysis
  durationMs: number;               // wall-clock time for the LLM call(s)
  scaffoldSuggestions?: ScaffoldSuggestion[]; // only present when no docs exist
}

interface Finding {
  docFile: string;          // path of the doc file that needs updating
  codeFile: string;         // path of the changed code file that caused the drift
  issue: string;            // one-line summary of the mismatch
  explanation: string;      // detailed explanation
  suggestedUpdate: string;  // suggested doc patch in diff format
  severity: "high" | "medium" | "low";
  confidence: number;       // 0–1, only findings >= 0.7 are returned
}

interface ScaffoldSuggestion {
  filename: string;   // suggested path for the new doc file (e.g. "README.md")
  content: string;    // full markdown content to write
  rationale: string;  // one-line explanation of why this file is needed
}
```

**Decision rule for agents:**
- `scaffoldSuggestions` is present → no docs exist; suggestions are starter content to commit
- `findings.length > 0` → docs exist but are stale; each finding has a `suggestedUpdate` diff to apply
- `findings.length === 0` and no `scaffoldSuggestions` → docs are up to date; no action needed

### Full pipeline (with GitHub)

```typescript
import { Octokit } from "@octokit/rest";
import {
  DiffAnalyzer,
  DocRetriever,
  DriftDetector,
  AnthropicProvider,   // or OllamaProvider
  buildPRComment,
} from "@docdrift/core";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const llm = new AnthropicProvider(process.env.ANTHROPIC_API_KEY!);

// scaffoldEnabled=true (default): generates doc stubs when no docs found
const detector = new DriftDetector(llm, true);

const diffFiles = await new DiffAnalyzer(octokit).analyze(owner, repo, prNumber);
const docFiles  = await new DocRetriever(octokit).fetch(owner, repo, headSha, diffFiles);
const result    = await detector.detect(diffFiles, docFiles);

// isFirstRun=true adds an onboarding message to the comment
const comment = buildPRComment(result, isFirstRun);
```

### Without GitHub (raw diff + doc content)

If you already have the diff and docs as strings (e.g. from a local git repo), skip `DiffAnalyzer` and `DocRetriever` and call `DriftDetector` directly with the raw types:

```typescript
import {
  DriftDetector,
  OllamaProvider,
} from "@docdrift/core";
import type { DiffFile, DocFile } from "@docdrift/core";

const llm = new OllamaProvider({ model: "gpt-oss" });
const detector = new DriftDetector(llm, true);

const diffFiles: DiffFile[] = [
  {
    path: "src/api/users.ts",
    status: "modified",       // "added" | "modified" | "removed" | "renamed"
    additions: 10,
    deletions: 2,
    patch: "-createUser(name)\n+createUser(name, role)",
  },
];

const docFiles: DocFile[] = [
  { path: "docs/api.md", content: "# API\ncreateUser(name)" },
];

const result = await detector.detect(diffFiles, docFiles);

if (result.scaffoldSuggestions) {
  // no docs exist — result.scaffoldSuggestions is an array of files to create
  for (const s of result.scaffoldSuggestions) {
    console.log(`Create ${s.filename}:\n${s.content}`);
  }
} else if (result.findings.length > 0) {
  // docs are stale — each finding has a suggestedUpdate diff
  for (const f of result.findings) {
    console.log(`[${f.severity}] ${f.docFile}: ${f.issue}`);
    console.log(f.suggestedUpdate);
  }
} else {
  console.log("Docs are up to date.");
}
```

### LLM providers

| Provider | Import | When to use |
|---|---|---|
| `AnthropicProvider` | `new AnthropicProvider(apiKey, modelId?)` | Default. Highest quality. Requires `ANTHROPIC_API_KEY`. |
| `OllamaProvider` | `new OllamaProvider({ model?, baseUrl?, apiKey? })` | Free local (no key) or Ollama Cloud (set `OLLAMA_API_KEY`). |

Both implement the same `LLMProvider` interface and are interchangeable. You can inject a mock for testing:

```typescript
import type { LLMProvider } from "@docdrift/core";

const mockLlm: LLMProvider = {
  modelId: "mock",
  analyze: async () => ({ findings: [], summary: "", checkedDocFiles: [] }),
  scaffold: async () => ({ suggestedDocs: [], summary: "" }),
};
```

### Error types

All errors extend `DocDriftError`. Catch specific subclasses for retry or fallback logic:

```typescript
import {
  LLMTimeoutError,    // LLM call exceeded 30s — safe to retry
  LLMRateLimitError,  // provider rate limit — back off before retrying
  LLMParseError,      // LLM returned malformed output — retry once, then skip
  LLMProviderError,   // generic provider error (network, API error)
  GitHubRateLimitError,  // GitHub API rate limit; .resetAt is a Date
  DiffTooLargeError,     // diff exceeded size limit
} from "@docdrift/core";

try {
  const result = await detector.detect(diffFiles, docFiles);
} catch (err) {
  if (err instanceof LLMTimeoutError) { /* retry */ }
  if (err instanceof GitHubRateLimitError) { /* wait until err.resetAt */ }
}
```

`DriftDetector` already retries `LLMTimeoutError`, `LLMParseError`, and `LLMProviderError` up to 2 times with exponential backoff. You only need to handle errors that bubble out after retries are exhausted.

### Scaffold mode skip logic

DocDrift skips the scaffold LLM call (even when `scaffoldEnabled=true`) if **all** changed files match these patterns — they're unlikely to need hand-written docs:

```
.github/**
.husky/**
*.test.ts / *.spec.ts / __tests__/**
*.config.ts / *.json / *.yaml / *.toml
```

If your diff only contains CI, test, or config files, `result.scaffoldSuggestions` will be `undefined` and no LLM call is made.

---

## Using `@docdrift/core` directly (quick reference)

```typescript
import {
  DriftDetector,
  AnthropicProvider,
  OllamaProvider,
  buildPRComment,
} from "@docdrift/core";

// Anthropic (cloud)
const llm = new AnthropicProvider(process.env.ANTHROPIC_API_KEY!);

// Ollama local
const llm = new OllamaProvider();

// Ollama cloud
const llm = new OllamaProvider({ model: "gpt-oss:120b" }); // reads OLLAMA_API_KEY from env

const detector = new DriftDetector(llm);             // scaffoldEnabled defaults to true
const result   = await detector.detect(diffFiles, docFiles);
const comment  = buildPRComment(result, isFirstRun); // returns a markdown string
```

---

## Monorepo structure

```
packages/
  core/     — pure analysis library (no HTTP, no GitHub API, no DB)
  action/   — GitHub Action wrapper
  app/      — webhook server, job queue, persistence (GitHub App)
```

---

## License

MIT
