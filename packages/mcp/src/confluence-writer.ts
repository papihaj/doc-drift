import { markdownToStorage } from "./markdown-to-storage.js";
import type { ConfluenceConfig } from "@docdrift/core";

export interface CreatedPage {
  id: string;
  title: string;
  url: string;
}

export class ConfluenceWriter {
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

  async createPage(title: string, markdownContent: string, spaceKey: string, parentId?: string): Promise<CreatedPage> {
    const storageBody = markdownToStorage(markdownContent);

    const body: Record<string, unknown> = {
      type: "page",
      title,
      space: { key: spaceKey },
      body: {
        storage: {
          value: storageBody,
          representation: "storage",
        },
      },
    };

    if (parentId) {
      body["ancestors"] = [{ id: parentId }];
    }

    const res = await fetch(`${this.apiBase}/rest/api/content`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Confluence create failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as { id: string; title: string; _links: { webui: string } };
    return {
      id: data.id,
      title: data.title,
      url: `${this.apiBase}${data._links.webui}`,
    };
  }

  async updatePage(pageId: string, title: string, markdownContent: string): Promise<CreatedPage> {
    // Fetch current version number first — required by Confluence REST API
    const current = await this.getPageVersion(pageId);
    const storageBody = markdownToStorage(markdownContent);

    const res = await fetch(`${this.apiBase}/rest/api/content/${pageId}`, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        version: { number: current.version + 1 },
        title,
        type: "page",
        body: {
          storage: {
            value: storageBody,
            representation: "storage",
          },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Confluence update failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as { id: string; title: string; _links: { webui: string } };
    return {
      id: data.id,
      title: data.title,
      url: `${this.apiBase}${data._links.webui}`,
    };
  }

  async getPageVersion(pageId: string): Promise<{ version: number; title: string }> {
    const res = await fetch(`${this.apiBase}/rest/api/content/${pageId}?expand=version`, {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(`Could not fetch page ${pageId}: ${res.status}`);
    }

    const data = (await res.json()) as { title: string; version: { number: number } };
    return { version: data.version.number, title: data.title };
  }
}
