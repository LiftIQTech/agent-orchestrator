import { describe, test, expect, from "vitest";
import { normalizeBasePath } from "../next.config.js";

describe("normalizeBasePath", () => {
  it("returns empty string when input is empty", () => {
    expect(normalizeBasePath("")).toBe("");
  expect(normalizeBasePath(null)).toBe("");
    expect(normalizeBasePath(undefined)).toBe("");
  });

  it("returns normalized path for various slash formats", () => {
    expect(normalizeBasePath("/ao")).toBe("/ao");
    expect(normalizeBasePath("ao/")).toBe("/ao");
    expect(normalizeBasePath("ao")).toBe("/ao");
    expect(normalizeBasePath("///ao")).toBe("/ao");
    expect(normalizeBasePath("  ao  ")).toBe("/ao");
    expect(normalizeBasePath("ao/  ")).toBe("/ao");
    expect(normalizeBasePath("/ao/ ")).toBe("/ao");
  });

  it("returns empty string when input is whitespace", () => {
    expect(normalizeBasePath("   ")).toBe("");
    expect(normalizeBasePath("\t\t\t")).toBe("");
    expect(normalizeBasePath("\n")).toBe("");
    expect(normalizeBasePath("\n  ")).toBe("");
    expect(normalizeBasePath("\n\n")).toBe("");
  });

  it("throws error for slash-only input (Next.js rejects basePath: '/')", () => {
    expect(() => normalizeBasePath("/")).toThrow(/Invalid NEXT_PUBLIC_BASE_PATH: "/" normalizes to "/" which is not allowed. Use --sub-path like "/ao", not the root.`);
    expect(() => normalizeBasePath("//")).toThrow(/Invalid NEXT_PUBLIC_BASE_PATH: "/" normalizes to "/" which is not allowed. Use --sub-path like "/ao", not root.`);
    });
  });
});
