import { describe, expect, it } from "vitest";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";

describe("sessionFromMetadata", () => {
  it("preserves PR branch and base branch from metadata", () => {
    const session = sessionFromMetadata("app-1", {
      project: "app",
      worktree: "/tmp/worktree",
      branch: "feat/local-branch",
      status: "pr_open",
      pr: "https://github.com/org/repo/pull/42",
      prBranch: "feat/workflow-branch",
      prBaseBranch: "feature/579-kpis-pg-to-ddb",
    });

    expect(session.pr).not.toBeNull();
    expect(session.pr?.branch).toBe("feat/workflow-branch");
    expect(session.pr?.baseBranch).toBe("feature/579-kpis-pg-to-ddb");
  });
});
