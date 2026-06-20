import { describe, it, expect } from "vitest";
import { DriftAnalysisSchema, FindingSchema } from "../drift/schemas.js";

const validFinding = {
  docFile: "docs/api.md",
  codeFile: "src/api/users.ts",
  issue: "createUser signature changed",
  explanation: "The function now requires a role parameter but the docs don't mention it.",
  suggestedUpdate: "-createUser(name: string)\n+createUser(name: string, role: string)",
  severity: "high",
  confidence: 0.95,
};

describe("FindingSchema", () => {
  it("accepts a valid finding", () => {
    const result = FindingSchema.safeParse(validFinding);
    expect(result.success).toBe(true);
  });

  it("rejects missing docFile", () => {
    const result = FindingSchema.safeParse({ ...validFinding, docFile: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid severity", () => {
    const result = FindingSchema.safeParse({ ...validFinding, severity: "critical" });
    expect(result.success).toBe(false);
  });

  it("rejects confidence > 1", () => {
    const result = FindingSchema.safeParse({ ...validFinding, confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const result = FindingSchema.safeParse({ ...validFinding, confidence: -0.1 });
    expect(result.success).toBe(false);
  });
});

describe("DriftAnalysisSchema", () => {
  it("accepts valid analysis with findings", () => {
    const result = DriftAnalysisSchema.safeParse({
      findings: [validFinding],
      summary: "One endpoint changed.",
      checkedDocFiles: ["docs/api.md"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty findings array (no drift)", () => {
    const result = DriftAnalysisSchema.safeParse({
      findings: [],
      summary: "No drift found.",
      checkedDocFiles: ["docs/api.md"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing findings field", () => {
    const result = DriftAnalysisSchema.safeParse({
      summary: "test",
      checkedDocFiles: [],
    });
    expect(result.success).toBe(false);
  });
});
