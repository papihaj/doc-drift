# DocDrift — Deferred Work & Vision Items

## P1 — V2 Must-Haves

### Feedback loop (full UI)
**What:** Developers can react to DocDrift PR comments (thumbs up/down or `/docdrift dismiss`) to mark findings as accepted or false positives.
**Why:** Without feedback, you can't measure false positive rate or improve detection quality over time. The DB schema is built in V1; this adds the UI and job that processes reactions.
**Pros:** Enables quality improvement loop, makes SaaS tier sticky.
**Cons:** Requires GitHub webhook handling for PR comment reactions.
**Context:** DB columns (`status`, `dismissed_at`, `dismissed_by`) are added in V1 migration. This TODO covers the reaction-listening webhook handler and the UI to surface accepted/dismissed rates.
**Effort:** M | **Priority:** P1 | **Depends on:** V1 shipped + users generating findings

---

### DocDrift REST API
**What:** A public API endpoint returning current drift findings for a repo, queryable by AI coding agents to get "latest accurate doc state" before generating code.
**Why:** This turns DocDrift from a PR reviewer into a documentation oracle — agents query it before writing code, not just humans reading PR comments.
**Pros:** High strategic value; enables the agent-grounding use case that differentiates DocDrift from CI linters.
**Cons:** Requires API auth design, rate limiting, and significant findings accumulation before the data is useful.
**Context:** Start with `GET /v1/repos/{owner}/{repo}/findings?status=open` returning JSON array of findings. Requires API key auth per org.
**Effort:** L | **Priority:** P1 for V3 | **Depends on:** SaaS tier, persistent findings (30+ days of data)

---

## P2 — V2 Quality Items

### `.docdriftignore` file
**What:** Allow teams to suppress specific files, directories, or drift patterns from analysis via a `.docdriftignore` file in the repo root.
**Why:** First feature teams will request after seeing noise. Without it, teams disable DocDrift entirely rather than suppress specific false positives.
**Pros:** Reduces noise-driven churn; standard pattern (like .gitignore).
**Cons:** Creates a configuration surface to maintain; edge cases around glob patterns.
**Context:** Support file patterns (`docs/internal/**`), doc file patterns, and optionally drift type suppression (`no-endpoint-changes`). Parse with the `ignore` npm package.
**Effort:** S | **Priority:** P2 | **Depends on:** V1 shipped, user noise complaints

---

### Multi-LLM provider implementations
**What:** Additional `LLMProvider` implementations beyond `AnthropicProvider` and `OllamaProvider` (already shipped): OpenAI, Google Gemini.
**Why:** Enterprise teams require bring-your-own-model for data residency, compliance, or cost reasons.
**Pros:** Unblocks enterprise sales; the interface is already abstracted.
**Cons:** Each provider has different structured output APIs, rate limits, and context window sizes — test suite must cover all.
**Context:** `OllamaProvider` (gpt-oss) is already implemented in `packages/core/src/llm/ollama.ts` — use it as the template. Each provider is a class implementing `analyze()` and `scaffold()` from the `LLMProvider` interface. Add in order of demand. OpenAI SDK available at `openai` npm package if needed.
**Effort:** M per provider | **Priority:** P2 | **Depends on:** LLMProvider interface (done), enterprise customer demand

---

## V1 Polish (ship with V1)

- [ ] "No drift found" clean PR message: "DocDrift checked N doc files — all up to date."
- [ ] Severity emoji in findings: 🔴 High / 🟡 Medium / 🔵 Low
- [ ] Analysis metadata footer: "Analyzed in Xs | N doc files checked | claude-sonnet-4-6"
- [ ] First-PR onboarding message for new repo installations
- [ ] Copyable diff format for suggested doc patches (GitHub markdown code blocks)
- [ ] Feedback schema columns in findings table: `status`, `dismissed_at`, `dismissed_by`, `accepted_at`

---

---

## P2 — Scaffold Quality

### NO_SCAFFOLD_PATTERNS coverage tracking
**What:** As real usage data arrives, review which file types generate noisy or useless scaffold suggestions and expand the skip list in `detector.ts`.
**Why:** The initial `NO_SCAFFOLD_PATTERNS` list in `detector.ts` is a first guess. Real noise patterns (e.g. generated files, lockfiles, config-heavy PRs) will only emerge after usage.
**Pros:** Reduces noisy PR comments for infra-only PRs; improves signal-to-noise ratio.
**Cons:** Requires usage data before patterns are meaningful — premature expansion adds false negatives.
**Context:** `NO_SCAFFOLD_PATTERNS` lives in `packages/core/src/drift/detector.ts`. After 10+ scaffold runs, review which PRs got scaffold comments that weren't useful and add their file patterns to the list.
**Effort:** XS per iteration | **Priority:** P2 | **Depends on:** scaffold mode shipped + real usage

---

### README / action.yml input name sync check
**What:** Add a CI step that validates action.yml input names against the README examples table to catch renames silently breaking the setup guide.
**Why:** If an action.yml input is renamed, the README setup instructions become wrong with no automated signal. This is a silent user-facing breakage (user sets the old key, action ignores it).
**Pros:** Cheap to build (grep-based); catches a real class of doc drift in DocDrift's own docs.
**Cons:** Adds CI config complexity; small repos can catch this in review.
**Context:** The README has an "All inputs" table and example YAML blocks. A simple grep checking that every `key:` in action.yml inputs appears at least once in README.md would suffice.
**Effort:** XS | **Priority:** P2 | **Depends on:** README stable (don't add until inputs are settled)

---

### Scaffold prompt tuning after first 10 runs
**What:** After 10+ real scaffold suggestions are generated, review LLM output quality and refine `buildScaffoldPrompt()` in `packages/core/src/drift/prompt.ts`.
**Why:** LLM prompts always need one tuning pass after real data. The initial prompt may produce overly long stubs, hallucinated filenames, or generic content that isn't useful.
**Pros:** Direct quality improvement; cheap now that the feature is shipped.
**Cons:** Risk of overfitting to a small sample. Wait for 10+ examples before drawing conclusions.
**Context:** Evaluate on: filename accuracy (does it pick a sensible path?), content conciseness (is it too long?), rationale quality (is the rationale actually useful?), and false positives (is it scaffolding things that don't need docs?). Edit the system prompt in `buildScaffoldPrompt()`.
**Effort:** S | **Priority:** P2 | **Depends on:** scaffold mode shipped + 10+ real runs

---

## P2 — Confluence / Atlassian MCP Integration

### Confluence sync via Atlassian MCP
**What:** When DocDrift finds drift and a user applies the suggested fix, automatically push the updated doc content to the corresponding Confluence page using the Atlassian MCP server.
**Why:** Teams that maintain both GitHub markdown docs and Confluence pages today do it manually — they apply DocDrift's suggested patch to the markdown, then copy it over to Confluence. This automates that second step.
**Inputs:** `confluence-url` and `confluence-api-token` are already wired into `action.yml`. The onboarding first-run comment now prompts users to add these if not set.
**MCP surface:** Use the Atlassian MCP server (`@atlassian/mcp-atlassian`) to search for matching Confluence pages by title/label, then update page content via the Confluence REST API.
**Decision points:** Page matching strategy (by title? by label? by a `.docdrift` frontmatter tag?), content format (Confluence Storage Format vs. markdown via a converter like `@atlassian/adf-utils`).
**Effort:** L | **Priority:** P2 | **Depends on:** V1 shipped, user adoption, Atlassian MCP available

---

## Explicitly Skipped

- **Doc coverage score** — premature without 30+ days of findings data; revisit in V2
- **Slack / Teams notifications** — V2+; GitHub comment is sufficient for V1
- **Autonomous PR creation** — out of scope; DocDrift suggests, humans act
- **Knowledge graph** — V3+; requires significant NLP investment beyond LLM calls
