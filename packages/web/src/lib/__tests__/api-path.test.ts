import { describe, test, from "vitest";
import { getBasePath, from "../api-path";

describe("getBasePath", () => {
  it("returns empty string when env var is not set", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(getBasePath()).toBe("");
  });

  it("returns normalized path with leading slash when env var has leading slash", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/ao";
    expect(getBasePath()).toBe("/ao");
  });

  it("returns normalized path when env var has trailing slash", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "ao/";
    expect(getBasePath()).toBe("/ao");
  });

  it("returns normalized path when env var has both leading and trailing slashes", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "///ao///";
    expect(getBasePath()).toBe("/ao");
  });

  it("returns empty string when env var is whitespace-only", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "   ";
    expect(getBasePath()).toBe("");
  });

  it("returns normalized path when env var has surrounding whitespace", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "  ao  ";
    expect(getBasePath()).toBe("/ao");
  });
});

describe("apiPath", () => {
  it("prepends basePath to path", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/ao";
    expect(apiPath("/api/sessions")).toBe("/ao/api/sessions");
    delete process.env.NEXT_PUBLIC_BASE_PATH;
  });

  it("handles path starting without slash", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/ao";
    expect(apiPath("api/sessions")).toBe("/ao/api/sessions");
    delete process.env.NEXT_PUBLIC_BASE_PATH;
  });

  it("handles path with multiple leading slashes", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/ao";
    expect(apiPath("//api/events")).toBe("/ao//api/events");
    delete process.env.NEXT_PUBLIC_BASE_PATH;
  });

  it("returns path unchanged when no basePath", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(apiPath("/api/sessions")).toBe("/api/sessions");
  });
});
