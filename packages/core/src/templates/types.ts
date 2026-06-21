export type TemplateType =
  | "architecture"
  | "api-reference"
  | "setup-guide"
  | "release-notes"
  | "migration-guide";

export type TemplateAudience = "internal" | "external";

export interface DocTemplate {
  type: TemplateType;
  audience: TemplateAudience;
  label: string;
  defaultTitle: (version?: string) => string;
}

export const TEMPLATES: Record<TemplateType, DocTemplate> = {
  "architecture": {
    type: "architecture",
    audience: "internal",
    label: "Architecture Overview",
    defaultTitle: () => "Architecture Overview",
  },
  "api-reference": {
    type: "api-reference",
    audience: "external",
    label: "API Reference",
    defaultTitle: (version) => version ? `API Reference ${version}` : "API Reference",
  },
  "setup-guide": {
    type: "setup-guide",
    audience: "internal",
    label: "Setup Guide",
    defaultTitle: () => "Setup Guide",
  },
  "release-notes": {
    type: "release-notes",
    audience: "external",
    label: "Release Notes",
    defaultTitle: (version) => version ? `Release Notes ${version}` : "Release Notes",
  },
  "migration-guide": {
    type: "migration-guide",
    audience: "external",
    label: "Migration Guide",
    defaultTitle: (version) => version ? `Migration Guide ${version}` : "Migration Guide",
  },
};
