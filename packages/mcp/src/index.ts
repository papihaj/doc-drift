#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import {
  AnthropicProvider,
  DiffAnalyzer,
  DocRetriever,
  ConfluenceRetriever,
  DriftDetector,
} from "@docdrift/core";
import { ConfluenceWriter } from "./confluence-writer.js";
import { z } from "zod";

const AnalyzePrSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  pr_number: z.number(),
  model: z.string().optional(),
});

const CreateConfluencePagesSchema = z.object({
  suggestions: z.array(
    z.object({
      filename: z.string(),
      content: z.string(),
      rationale: z.string(),
    }),
  ),
  space_key: z.string(),
  parent_page_id: z.string().optional(),
});

const UpdateConfluencePageSchema = z.object({
  page_id: z.string(),
  title: z.string(),
  content: z.string(),
});

const server = new Server(
  { name: "docdrift", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "analyze_pr",
      description:
        "Analyze a GitHub pull request for documentation drift. Returns drift findings and, when no docs exist, scaffold suggestions for new Confluence pages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "GitHub repository owner" },
          repo: { type: "string", description: "GitHub repository name" },
          pr_number: { type: "number", description: "Pull request number" },
          model: {
            type: "string",
            description: "Anthropic model to use. Defaults to claude-haiku-4-5-20251001.",
          },
        },
        required: ["owner", "repo", "pr_number"],
      },
    },
    {
      name: "create_confluence_pages",
      description:
        "Create Confluence pages from DocDrift scaffold suggestions. Call this after analyze_pr returns scaffoldSuggestions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          suggestions: {
            type: "array",
            description: "Array of page suggestions from analyze_pr",
            items: {
              type: "object",
              properties: {
                filename: { type: "string", description: "Page title" },
                content: { type: "string", description: "Page content (markdown)" },
                rationale: { type: "string", description: "One-line reason for this page" },
              },
              required: ["filename", "content", "rationale"],
            },
          },
          space_key: { type: "string", description: "Confluence space key (e.g. ENG)" },
          parent_page_id: {
            type: "string",
            description: "Optional Confluence page ID to nest pages under",
          },
        },
        required: ["suggestions", "space_key"],
      },
    },
    {
      name: "update_confluence_page",
      description:
        "Update an existing Confluence page with new content. Use this to apply drift fixes from analyze_pr findings.",
      inputSchema: {
        type: "object" as const,
        properties: {
          page_id: { type: "string", description: "Confluence page ID to update" },
          title: { type: "string", description: "Page title (unchanged or updated)" },
          content: { type: "string", description: "New page content in markdown" },
        },
        required: ["page_id", "title", "content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "analyze_pr") {
    const { owner, repo, pr_number, model } = AnalyzePrSchema.parse(args);

    const githubToken = process.env["GITHUB_TOKEN"];
    const anthropicKey = process.env["ANTHROPIC_API_KEY"];
    if (!githubToken) throw new Error("GITHUB_TOKEN env var is required");
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY env var is required");

    const modelId = model ?? "claude-haiku-4-5-20251001";
    const octokit = new Octokit({ auth: githubToken });
    const llm = new AnthropicProvider(anthropicKey, modelId);
    const analyzer = new DiffAnalyzer(octokit);
    const retriever = new DocRetriever(octokit);
    const detector = new DriftDetector(llm, true);

    const confluenceUrl = process.env["CONFLUENCE_URL"];
    const confluenceToken = process.env["CONFLUENCE_API_TOKEN"];
    const confluenceEmail = process.env["CONFLUENCE_EMAIL"];
    const confluenceSpaceKey = process.env["CONFLUENCE_SPACE_KEY"];

    const confluenceRetriever =
      confluenceUrl && confluenceToken
        ? new ConfluenceRetriever({
            baseUrl: confluenceUrl,
            apiToken: confluenceToken,
            ...(confluenceEmail ? { email: confluenceEmail } : {}),
            ...(confluenceSpaceKey ? { spaceKey: confluenceSpaceKey } : {}),
          })
        : null;

    const diff = await analyzer.fetch(owner, repo, pr_number);
    if (diff.files.length === 0) {
      return { content: [{ type: "text" as const, text: "No changed files found in PR." }] };
    }

    const [repoDocs, confluenceDocs] = await Promise.all([
      retriever.fetch(owner, repo, diff.files[0]!.patch.slice(0, 7), diff.files),
      confluenceRetriever ? confluenceRetriever.fetch(diff.files) : Promise.resolve([]),
    ]);

    const docs = [...repoDocs, ...confluenceDocs];
    const result = await detector.detect(diff.files, docs);

    let confluenceSuggestions = undefined;
    if (confluenceUrl && confluenceToken && confluenceDocs.length === 0 && !result.scaffoldSuggestions) {
      confluenceSuggestions = await detector.scaffoldConfluence(diff.files, result.findings);
    }

    const output = {
      findings: result.findings,
      checkedDocFiles: result.checkedDocFiles,
      scaffoldSuggestions: result.scaffoldSuggestions ?? [],
      confluenceSuggestions: confluenceSuggestions ?? [],
      modelId: result.modelId,
      durationMs: result.durationMs,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
  }

  if (name === "create_confluence_pages") {
    const { suggestions, space_key, parent_page_id } = CreateConfluencePagesSchema.parse(args);
    assertConfluenceConfig();

    const writer = makeConfluenceWriter();
    const created = [];

    for (const s of suggestions) {
      const page = await writer.createPage(s.filename, s.content, space_key, parent_page_id);
      created.push({ title: page.title, url: page.url });
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Created ${created.length} Confluence page${created.length !== 1 ? "s" : ""}:\n${created.map((p) => `- ${p.title}: ${p.url}`).join("\n")}`,
        },
      ],
    };
  }

  if (name === "update_confluence_page") {
    const { page_id, title, content } = UpdateConfluencePageSchema.parse(args);
    assertConfluenceConfig();

    const writer = makeConfluenceWriter();
    const page = await writer.updatePage(page_id, title, content);

    return {
      content: [
        {
          type: "text" as const,
          text: `Updated Confluence page "${page.title}": ${page.url}`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

function assertConfluenceConfig(): void {
  if (!process.env["CONFLUENCE_URL"]) throw new Error("CONFLUENCE_URL env var is required");
  if (!process.env["CONFLUENCE_API_TOKEN"]) throw new Error("CONFLUENCE_API_TOKEN env var is required");
}

function makeConfluenceWriter(): ConfluenceWriter {
  const email = process.env["CONFLUENCE_EMAIL"];
  const spaceKey = process.env["CONFLUENCE_SPACE_KEY"];
  return new ConfluenceWriter({
    baseUrl: process.env["CONFLUENCE_URL"]!,
    apiToken: process.env["CONFLUENCE_API_TOKEN"]!,
    ...(email ? { email } : {}),
    ...(spaceKey ? { spaceKey } : {}),
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
