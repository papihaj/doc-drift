import type { DiffFile } from "../diff/analyzer.js";
import type { DocFile } from "./retriever.js";

export interface SpaceStructure {
  rootPages: { id: string; title: string; childCount: number }[];
  totalPages: number;
  /** true when at least one root-level page has children — indicates hierarchical space */
  isHierarchical: boolean;
}

export interface LayoutRecommendation {
  recommendation: "single-page" | "multi-page";
  rationale: string;
  structure: SpaceStructure;
}

export interface ConfluenceConfig {
  baseUrl: string;    // e.g. https://yourorg.atlassian.net/wiki
  apiToken: string;   // Atlassian API token (Cloud) or PAT (Data Center)
  email?: string;     // required for Atlassian Cloud Basic auth; omit for Data Center PAT
  spaceKey?: string;  // scope search to a specific space (recommended)
}

const MAX_CONFLUENCE_PAGES = 5;
const MAX_SEARCH_TERMS = 4;
const MAX_PAGE_CHARS = 100_000;

const SKIP_BASENAMES = new Set(["index", "main", "test", "spec", "utils", "helpers", "types", "constants"]);

export class ConfluenceRetriever {
  private readonly authHeader: string;
  private readonly apiBase: string;

  constructor(private readonly config: ConfluenceConfig) {
    if (config.email) {
      const creds = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
      this.authHeader = `Basic ${creds}`;
    } else {
      this.authHeader = `Bearer ${config.apiToken}`;
    }
    this.apiBase = config.baseUrl.replace(/\/+$/, "");
  }

  async fetch(changedFiles: DiffFile[]): Promise<DocFile[]> {
    const terms = this.extractSearchTerms(changedFiles);
    if (terms.length === 0) return [];
    return this.searchPages(terms);
  }

  /** Fetches root-level page tree to understand current space layout. Returns null on error. */
  async fetchSpaceStructure(spaceKey: string): Promise<SpaceStructure | null> {
    const url = new URL(`${this.apiBase}/rest/api/content`);
    url.searchParams.set("spaceKey", spaceKey);
    url.searchParams.set("type", "page");
    url.searchParams.set("depth", "root");
    url.searchParams.set("expand", "children.page.size");
    url.searchParams.set("limit", "25");

    const res = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      results?: Array<{ id: string; title: string; children?: { page?: { size?: number } } }>;
      totalSize?: number;
    };

    const rootPages = (data.results ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      childCount: p.children?.page?.size ?? 0,
    }));

    return {
      rootPages,
      totalPages: data.totalSize ?? rootPages.length,
      isHierarchical: rootPages.some((p) => p.childCount > 0),
    };
  }

  /** Produces a layout recommendation based on space structure and changed file count. */
  recommendLayout(structure: SpaceStructure, changedFiles: DiffFile[]): LayoutRecommendation {
    const changedDirs = new Set(changedFiles.map((f) => f.path.split("/")[0]));
    const isLargeChange = changedFiles.length > 5 || changedDirs.size > 2;

    if (structure.isHierarchical || isLargeChange) {
      return {
        recommendation: "multi-page",
        rationale: structure.isHierarchical
          ? `Your Confluence space uses a hierarchical structure (${structure.totalPages} pages with parent/child nesting). Creating multiple focused pages will match your existing layout.`
          : `This PR touches ${changedFiles.length} files across ${changedDirs.size} directories. Breaking docs into focused pages (Architecture, API Reference, Setup) makes each one more navigable.`,
        structure,
      };
    }

    return {
      recommendation: "single-page",
      rationale: structure.totalPages <= 5
        ? `Your Confluence space is small (${structure.totalPages} pages, flat structure). A single comprehensive page keeps everything in one place and is easier to discover.`
        : `This PR has a focused scope (${changedFiles.length} file${changedFiles.length !== 1 ? "s" : ""}). A single page is sufficient and avoids fragmenting the docs.`,
      structure,
    };
  }

  private extractSearchTerms(files: DiffFile[]): string[] {
    const terms = new Set<string>();
    for (const file of files) {
      const basename = file.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      if (basename.length > 3 && !SKIP_BASENAMES.has(basename.toLowerCase())) {
        terms.add(basename);
      }
    }
    return [...terms].slice(0, MAX_SEARCH_TERMS);
  }

  private async searchPages(terms: string[]): Promise<DocFile[]> {
    const textClause = terms.map((t) => `text~"${t}"`).join(" OR ");
    const spaceClause = this.config.spaceKey ? ` AND space.key="${this.config.spaceKey}"` : "";
    const cql = `type=page${spaceClause} AND (${textClause}) ORDER BY lastmodified DESC`;

    const url = new URL(`${this.apiBase}/rest/api/content/search`);
    url.searchParams.set("cql", cql);
    url.searchParams.set("expand", "body.storage");
    url.searchParams.set("limit", String(MAX_CONFLUENCE_PAGES));

    const res = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as { results?: ConfluencePage[] };
    return (data.results ?? [])
      .filter((p) => {
        const len = p.body?.storage?.value?.length ?? 0;
        return len > 0 && len < MAX_PAGE_CHARS;
      })
      .map((p) => ({
        path: `confluence:${p.title}`,
        content: stripStorageFormat(p.body!.storage!.value),
      }));
  }
}

interface ConfluencePage {
  id: string;
  title: string;
  body?: { storage?: { value: string } };
}

function stripStorageFormat(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
