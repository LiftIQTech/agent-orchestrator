import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import { createWorkflowManager } from "../workflow-manager.js";
import { createWorkflowState, loadWorkflowState, saveWorkflowState } from "../workflow-state.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  SCM,
  Notifier,
  ActivityState,
  PRInfo,
} from "../types.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
  };
});

import { execFile } from "node:child_process";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockSessionManager: SessionManager;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
const mockExecFile = vi.mocked(execFile);

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "spawning",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    title: "Fix things",
    owner: "org",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockExecFile.mockReset();
  tmpDir = join(tmpdir(), `ao-test-lifecycle-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Create a temporary config file
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some terminal output\n"),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn(),
    getEnvironment: vi.fn(),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  mockSessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn(),
  } as SessionManager;

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        workflow: { enabled: true },
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
  };

  // Calculate sessions directory
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  // Clean up hash-based directories in ~/.agent-orchestrator
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }

  // Clean up tmpDir
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("start / stop", () => {
  it("starts and stops the polling loop", () => {
    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    // Should not throw on double start
    lm.start(60_000);
    lm.stop();
    // Should not throw on double stop
    lm.stop();
  });
});

describe("workflow iteration rollover", () => {
  it("dispatches architect for next iteration after changes requested review", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "641",
      "feat/641-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "reviewing";
    workflow.iterations = [
      {
        number: 1,
        status: "reviewing",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-1"],
        architectSession: "app-1",
        reviewerSession: "app-1",
      },
    ];

    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001"), { recursive: true });
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [x] TASK-01: Done\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n\nIssue: 641\n\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.orchestratorAnalysisPath, "# Analysis\n", "utf-8");
    writeFileSync(
      workflow.iterations[0]!.reviewFindingsPath,
      "## VERDICT: CHANGES REQUESTED\n\nNeed another architect pass.\n",
      "utf-8",
    );
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-1", {
      worktree: worktreePath,
      branch: "feat/641-from-main",
      status: "working",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "reviewer",
      workflowIteration: "1",
    });

    const session = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/641-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "reviewer",
        workflowIteration: "1",
        agent: "host-shell",
      },
    });
    const restoredSession = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/641-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "architect",
        workflowIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.restore).mockResolvedValue(restoredSession);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await wm.handleReviewComplete("wf-641", false, "Need another architect pass.");

    expect(mockSessionManager.runCommand).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(readFileSync(join(getProjectBaseDir(config.configPath, projectPath), "workflows", "wf-641.json"), "utf-8"));
    expect(saved.status).toBe("planning");
    expect(saved.currentIteration).toBe(2);
    expect(saved.iterations[1].status).toBe("planning");
    expect(saved.desiredStage).toBe("architect");
    expect(saved.desiredIteration).toBe(2);

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["workflowStage"]).toBe("architect");
    expect(metadata?.["workflowIteration"]).toBe("2");
  });

  it("resumeWorkflow restarts the pending architect pass for a stuck next iteration", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "resume-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "641",
      "feat/641-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 2;
    workflow.currentBuilderIteration = 0;
    workflow.status = "reviewing";
    workflow.desiredStage = "architect";
    workflow.desiredIteration = 2;
    workflow.desiredBuilderIteration = 0;
    workflow.dispatchStatus = "pending";
    workflow.iterations = [
      {
        number: 1,
        status: "changes_requested",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-1"],
        architectSession: "app-1",
        reviewerSession: "app-1",
      },
      {
        number: 2,
        status: "planning",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-002"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-002", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-002", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-002", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-002", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: [],
      },
    ];

    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-001"), { recursive: true });
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-641", "iterations", "iteration-002"), { recursive: true });
    writeFileSync(workflow.iterations[0]!.reviewFindingsPath, "## VERDICT: CHANGES REQUESTED\n", "utf-8");
    writeFileSync(workflow.iterations[1]!.planPath, "# PLAN - Iteration 2\n\nIssue: 641\n\n(Architect will add tasks)\n", "utf-8");
    writeFileSync(workflow.iterations[1]!.progressPath, "# Progress - Iteration 2\n\nIssue: 641\n\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-1", {
      worktree: worktreePath,
      branch: "feat/641-from-main",
      status: "working",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "reviewer",
      workflowIteration: "1",
    });

    const session = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/641-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "reviewer",
        workflowIteration: "1",
        agent: "host-shell",
      },
    });
    const restoredSession = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/641-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "architect",
        workflowIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.restore).mockResolvedValue(restoredSession);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-641");

    expect(mockSessionManager.runCommand).toHaveBeenCalledTimes(1);
    expect(resumed.currentIteration).toBe(2);
    expect(resumed.status).toBe("planning");

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["workflowStage"]).toBe("architect");
    expect(metadata?.["workflowIteration"]).toBe("2");
  });

  it("resumeWorkflow dispatches a pending architect stage even before artifacts exist", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "pending-architect-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "907",
      "feat/907-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.status = "planning";
    workflow.desiredStage = "architect";
    workflow.desiredIteration = 1;
    workflow.dispatchStatus = "pending";
    workflow.iterations = [
      {
        number: 1,
        status: "planning",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-907", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-907", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-907", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-907", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-907", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: [],
      },
    ];
    saveWorkflowState(config.configPath, projectPath, workflow);

    const session = makeSession({
      id: "app-1",
      status: "spawning",
      branch: "feat/907-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "architect",
        workflowIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(session);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await wm.resumeWorkflow("wf-907");

    expect(mockSessionManager.runCommand).toHaveBeenCalled();
  });

  it("retries owner spawn when a new workflow owner session disappears before confirmation", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "durable-owner-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "909",
      "feat/909-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.currentIteration = 1;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "pending";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-909", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-909", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-909", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-909", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-909", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: [],
      },
    ];
    mkdirSync(dirname(workflow.iterations[0]!.planPath), { recursive: true });
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const flakySession = makeSession({
      id: "app-1",
      status: "spawning",
      branch: "feat/909-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });
    const durableSession = makeSession({
      id: "app-2",
      status: "working",
      branch: "feat/909-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(durableSession)
      .mockResolvedValue(durableSession);
    vi.mocked(mockSessionManager.spawn)
      .mockResolvedValueOnce(flakySession)
      .mockResolvedValueOnce(durableSession);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await wm.resumeWorkflow("wf-909");

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: false });
    expect(mockSessionManager.spawn).toHaveBeenCalled();
  });

  it("startWorkflow bootstraps a draft PR when the branch has no commits yet", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });

    const worktreePath = join(tmpDir, "workflow-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const hostShellSession = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/645",
      workspacePath: worktreePath,
      metadata: {
        workflowId: "wf-645",
        workflowStage: "architect",
        workflowIteration: "1",
        agent: "host-shell",
      },
    });

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makePR({
            branch: "feat/645",
            baseBranch: "main",
            isDraft: true,
            url: "https://github.com/org/my-app/pull/645",
          }),
        ),
      createPR: vi
        .fn()
        .mockRejectedValueOnce(new Error("No commits between main and feat/645"))
        .mockResolvedValueOnce(
          makePR({
            branch: "feat/645",
            baseBranch: "main",
            isDraft: true,
            url: "https://github.com/org/my-app/pull/645",
          }),
        ),
      convertPRToDraft: vi.fn(),
      getPRState: vi.fn(),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.spawn).mockResolvedValue(hostShellSession);
    vi.mocked(mockSessionManager.get).mockResolvedValue(hostShellSession);
    vi.mocked(mockSessionManager.runCommand).mockResolvedValue(undefined);
    mockExecFile
      .mockImplementationOnce((file, args, options, callback) => {
        const cb = typeof options === "function" ? options : callback;
        cb?.(null, "", "");
        return {} as ReturnType<typeof execFile>;
      })
      .mockImplementationOnce((file, args, options, callback) => {
        const cb = typeof options === "function" ? options : callback;
        cb?.(null, "", "");
        return {} as ReturnType<typeof execFile>;
      })
      .mockImplementationOnce((file, args, options, callback) => {
        const cb = typeof options === "function" ? options : callback;
        cb?.(null, "", "");
        return {} as ReturnType<typeof execFile>;
      });

    const wm = createWorkflowManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    const workflow = await wm.startWorkflow("my-app", "645");
    const requirementsPath = join(
      worktreePath,
      ".architect-delivery",
      "projects",
      "issue-645",
      "requirements.md",
    );

    expect(mockSCM.createPR).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["add", "--", requirementsPath],
      expect.objectContaining({ cwd: worktreePath }),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["commit", "-m", "chore(workflow): bootstrap issue 645 branch visibility"],
      expect.objectContaining({ cwd: worktreePath }),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({ cwd: worktreePath }),
      expect.any(Function),
    );
    expect(workflow.artifacts.prs).toEqual(["https://github.com/org/my-app/pull/645"]);
  });

  it("marks completed non-automerge workflows pending-merge and readies the PR", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    config.projects["my-app"]!.tracker = { plugin: "mock-tracker" };
    config.projects["my-app"]!.scm = { plugin: "mock-scm" };
    config.projects["my-app"]!.workflow = {
      enabled: true,
      builders: { maxIterations: 5, tasksPerBuilder: 3 },
      iterations: { maxIterations: 3, autoMergeOnApproval: false },
    };

    const worktreePath = join(tmpDir, "pending-merge-worktree");
    const iterationDir = join(
      worktreePath,
      ".architect-delivery",
      "projects",
      "issue-645",
      "iterations",
      "iteration-001",
    );
    mkdirSync(iterationDir, { recursive: true });
    writeFileSync(
      join(iterationDir, "PLAN.md"),
      "- [x] TASK-01: done\n",
      "utf-8",
    );
    writeFileSync(join(iterationDir, "PROGRESS.md"), "done\n", "utf-8");
    writeFileSync(join(iterationDir, "CODE_REVIEW_FINDINGS.md"), "## VERDICT: APPROVED\n", "utf-8");

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "645",
      "feat/645",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.status = "reviewing";
    workflow.currentIteration = 1;
    workflow.ownerSessionId = "app-1";
    workflow.artifacts.prs = ["https://github.com/org/repo/pull/42"];
    workflow.iterations[0] = {
      number: 1,
      status: "reviewing",
      startedAt: new Date().toISOString(),
      iterationDir,
      planPath: join(iterationDir, "PLAN.md"),
      progressPath: join(iterationDir, "PROGRESS.md"),
      orchestratorAnalysisPath: join(iterationDir, "orchestrator-analysis.md"),
      reviewFindingsPath: join(iterationDir, "CODE_REVIEW_FINDINGS.md"),
      builderSessions: ["app-1"],
      architectSession: "app-1",
      reviewerSession: "app-1",
    };
    saveWorkflowState(config.configPath, projectPath, workflow);

    const mockTracker = {
      name: "mock-tracker",
      updateIssue: vi.fn().mockResolvedValue(undefined),
    };
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR({ isDraft: true, branch: "feat/645" })),
      resolvePR: vi.fn().mockResolvedValue(makePR({ isDraft: true, branch: "feat/645" })),
      markPRReadyForReview: vi.fn().mockResolvedValue(undefined),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getPRState: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithTrackerAndScm: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "tracker") return mockTracker;
        if (slot === "scm") return mockSCM;
        if (slot === "workspace") return { name: "worktree" };
        return null;
      }),
    };

    const wm = createWorkflowManager({
      config,
      registry: registryWithTrackerAndScm,
      sessionManager: mockSessionManager,
    });

    await wm.handleReviewComplete(workflow.id, true, "approved");

    expect(mockSCM.markPRReadyForReview).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42, isDraft: true }),
    );
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: false });
    expect(mockTracker.updateIssue).toHaveBeenCalledWith(
      "645",
      expect.objectContaining({
        labels: ["agent:pending-merge"],
        removeLabels: ["agent:in-progress", "agent:backlog"],
      }),
      expect.any(Object),
    );
  });

  it("reopens a completed workflow when its PR has failing CI", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    config.projects["my-app"]!.tracker = { plugin: "mock-tracker" };
    config.projects["my-app"]!.scm = { plugin: "mock-scm" };
    config.projects["my-app"]!.workflow = {
      enabled: true,
      builders: { maxIterations: 5, tasksPerBuilder: 3 },
      iterations: { maxIterations: 3, autoMergeOnApproval: false },
    };

    const worktreePath = join(tmpDir, "reopen-completed-workflow");
    const iterationDir = join(
      worktreePath,
      ".architect-delivery",
      "projects",
      "issue-950",
      "iterations",
      "iteration-003",
    );
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "950",
      "feat/950",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.status = "completed";
    workflow.currentIteration = 3;
    workflow.ownerSessionId = "";
    workflow.artifacts.prs = ["https://github.com/org/repo/pull/950"];
    workflow.iterations = [
      {
        number: 1,
        status: "changes_requested",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: [],
      },
      {
        number: 2,
        status: "changes_requested",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-002"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-002", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-002", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-002", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-950", "iterations", "iteration-002", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: [],
      },
      {
        number: 3,
        status: "approved",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir,
        planPath: join(iterationDir, "PLAN.md"),
        progressPath: join(iterationDir, "PROGRESS.md"),
        orchestratorAnalysisPath: join(iterationDir, "orchestrator-analysis.md"),
        reviewFindingsPath: join(iterationDir, "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-1"],
        reviewerSession: "app-1",
      },
    ];
    saveWorkflowState(config.configPath, projectPath, workflow);

    const mockTracker = {
      name: "mock-tracker",
      updateIssue: vi.fn().mockResolvedValue(undefined),
    };
    const resolvedPr = makePR({ number: 950, url: "https://github.com/org/repo/pull/950", branch: "feat/950", isDraft: false });
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      resolvePR: vi.fn().mockResolvedValue(resolvedPr),
      convertPRToDraft: vi.fn().mockResolvedValue(undefined),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      getCIChecks: vi.fn().mockResolvedValue([
        { name: "Unit Tests", status: "failed", url: "https://example.com/checks/1" },
      ]),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn().mockResolvedValue([]),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({ mergeable: false, ciPassing: false, approved: false, noConflicts: true, blockers: ["CI is failing"] }),
    };

    const registryWithTrackerAndScm: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "tracker") return mockTracker;
        if (slot === "scm") return mockSCM;
        if (slot === "workspace") return { name: "worktree", exists: vi.fn().mockResolvedValue(true) };
        return null;
      }),
    };

    const replacement = makeSession({
      id: "app-9",
      status: "spawning",
      branch: "feat/950",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "3",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.list).mockResolvedValue([
      makeSession({
        id: "pr-monitor",
        status: "pr_open",
        projectId: "my-app",
        branch: "feat/950",
        issueId: "950",
        pr: resolvedPr,
        workspacePath: worktreePath,
      }),
    ]);
    vi.mocked(mockSessionManager.get).mockResolvedValueOnce(replacement).mockResolvedValue(replacement);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(replacement);

    const lm = createLifecycleManager({
      config,
      registry: registryWithTrackerAndScm,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    lm.stop();

    const reopened = loadWorkflowState(config.configPath, projectPath, workflow.id);
    expect(reopened?.status).toBe("building");
    expect(reopened?.desiredStage).toBe("builder");
    expect(existsSync(join(iterationDir, "review-feedback.md"))).toBe(true);
    expect(mockTracker.updateIssue).toHaveBeenCalledWith(
      "950",
      expect.objectContaining({
        labels: ["agent:in-progress"],
        removeLabels: ["agent:pending-merge", "agent:backlog"],
      }),
      expect.any(Object),
    );
    expect(mockSCM.convertPRToDraft).toHaveBeenCalledWith(expect.objectContaining({ number: 950 }));
    expect(mockSessionManager.spawn).toHaveBeenCalled();
    expect(mockSessionManager.runCommand).not.toHaveBeenCalled();
  });

  it("does not repeatedly reopen an already-active workflow for the same failing CI checks", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    config.projects["my-app"]!.tracker = { plugin: "mock-tracker" };
    config.projects["my-app"]!.scm = { plugin: "mock-scm" };
    config.projects["my-app"]!.workflow = {
      enabled: true,
      builders: { maxIterations: 5, tasksPerBuilder: 3 },
      iterations: { maxIterations: 3, autoMergeOnApproval: false },
    };

    const worktreePath = join(tmpDir, "same-ci-active-workflow");
    const iterationDir = join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-003");
    mkdirSync(iterationDir, { recursive: true });
    writeFileSync(join(iterationDir, "PLAN.md"), "- [x] TASK-01: done\n", "utf-8");
    writeFileSync(join(iterationDir, "PROGRESS.md"), "done\n", "utf-8");

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "951",
      "feat/951",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.status = "building";
    workflow.currentIteration = 3;
    workflow.ownerSessionId = "app-10";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 3;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.artifacts.prs = ["https://github.com/org/repo/pull/951"];
    workflow.lastSeenFailingChecks = ["Unit Tests"];
    workflow.iterations = [
      {
        number: 1,
        status: "changes_requested",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: [],
      },
      {
        number: 2,
        status: "changes_requested",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-002"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-002", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-002", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-002", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-951", "iterations", "iteration-002", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: [],
      },
      {
        number: 3,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir,
        planPath: join(iterationDir, "PLAN.md"),
        progressPath: join(iterationDir, "PROGRESS.md"),
        orchestratorAnalysisPath: join(iterationDir, "orchestrator-analysis.md"),
        reviewFindingsPath: join(iterationDir, "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-10"],
      },
    ];
    saveWorkflowState(config.configPath, projectPath, workflow);

    const resolvedPr = makePR({ number: 951, url: "https://github.com/org/repo/pull/951", branch: "feat/951", isDraft: true });
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      resolvePR: vi.fn().mockResolvedValue(resolvedPr),
      convertPRToDraft: vi.fn().mockResolvedValue(undefined),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      getCIChecks: vi.fn().mockResolvedValue([
        { name: "Unit Tests", status: "failed", url: "https://example.com/checks/1" },
      ]),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn().mockResolvedValue([]),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({ mergeable: false, ciPassing: false, approved: false, noConflicts: true, blockers: ["CI is failing"] }),
    };

    const registryWithScm: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "tracker") return { name: "mock-tracker", updateIssue: vi.fn().mockResolvedValue(undefined) };
        if (slot === "workspace") return { name: "worktree", exists: vi.fn().mockResolvedValue(true) };
        return null;
      }),
    };

    vi.mocked(mockSessionManager.list).mockResolvedValue([
      makeSession({
        id: "pr-monitor",
        status: "pr_open",
        projectId: "my-app",
        branch: "feat/951",
        issueId: "951",
        pr: resolvedPr,
        workspacePath: worktreePath,
      }),
      makeSession({
        id: "app-10",
        status: "working",
        projectId: "my-app",
        branch: "feat/951",
        issueId: "951",
        workspacePath: worktreePath,
        metadata: {
          workflowId: workflow.id,
          workflowStage: "builder",
          workflowIteration: "3",
          builderIteration: "1",
          agent: "host-shell",
        },
      }),
    ]);

    const lm = createLifecycleManager({
      config,
      registry: registryWithScm,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    lm.stop();

    const current = loadWorkflowState(config.configPath, projectPath, workflow.id);
    expect(current?.status).toBe("building");
    expect(current?.ownerSessionId).toBe("app-10");
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("resumeWorkflow can recover a failed non-terminal workflow that still has pending builder work", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "failed-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "902",
      "feat/902-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 2;
    workflow.status = "failed";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 2;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-902", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-902", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-902", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-902", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-902", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-1", "app-1"],
      },
    ];

    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-902", "iterations", "iteration-001"), { recursive: true });
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const session = makeSession({
      id: "app-1",
      status: "spawning",
      branch: "feat/902-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(session);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-902");

    expect(resumed.status).toBe("building");
    expect(resumed.currentBuilderIteration).toBe(2);
    expect(resumed.desiredBuilderIteration).toBe(2);
    expect(mockSessionManager.runCommand).not.toHaveBeenCalled();
  });

  it("resumeWorkflow is idempotent for an already-running builder stage", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "idempotent-builder-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-910", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "910",
      "feat/910-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-2";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 2;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 2;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-910", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-910", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-910", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-910", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-910", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-1", "app-2"],
      },
    ];

    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const session = makeSession({
      id: "app-2",
      status: "working",
      branch: "feat/910-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-910");

    expect(resumed.currentBuilderIteration).toBe(2);
    expect(resumed.desiredBuilderIteration).toBe(2);
    expect(resumed.iterations[0]?.builderSessions).toEqual(["app-1", "app-2"]);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    expect(mockSessionManager.runCommand).not.toHaveBeenCalled();
  });

  it("resumeWorkflow advances completed builder work to reviewer after restoring the owner shell", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "completed-builder-resume-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-912", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "912",
      "feat/912-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-912", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-912", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-912", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-912", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-912", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-0",
        builderSessions: ["app-1"],
      },
    ];

    writeFileSync(
      workflow.iterations[0]!.planPath,
      "# PLAN\n\n- [x] TASK-01: Done\n- [x] TASK-02: Done\n",
      "utf-8",
    );
    writeFileSync(
      workflow.iterations[0]!.progressPath,
      "# Progress - Iteration 1\n\n## Builder 1 (2026-03-16T15:55:05Z)\n\nCompleted work.\n",
      "utf-8",
    );
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-1", {
      worktree: worktreePath,
      branch: "feat/912-from-main",
      status: "killed",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: "1",
      builderIteration: "1",
    });

    const restoredSession = makeSession({
      id: "app-1",
      status: "spawning",
      branch: "feat/912-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(restoredSession);
    vi.mocked(mockSessionManager.restore).mockResolvedValue(restoredSession);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-912");

    expect(resumed.status).toBe("reviewing");
    expect(resumed.iterations[0]?.status).toBe("reviewing");
    expect(resumed.iterations[0]?.reviewerSession).toBe("app-1");
    expect(mockSessionManager.restore).toHaveBeenCalledWith("app-1");
    expect(mockSessionManager.runCommand).toHaveBeenCalledTimes(1);

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["workflowStage"]).toBe("reviewer");
    expect(metadata?.["builderIteration"] ?? "").toBe("");
  });

  it("resumeWorkflow advances to reviewer when the final builder died after recording progress", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "maxed-builder-resume-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-913", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "913",
      "feat/913-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-5";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = workflow.maxBuilderIterations;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = workflow.maxBuilderIterations;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-913", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-913", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-913", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-913", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-913", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-0",
        builderSessions: ["app-1", "app-2", "app-3", "app-4", "app-5"],
      },
    ];

    writeFileSync(
      workflow.iterations[0]!.planPath,
      "# PLAN\n\n- [x] TASK-01: Done\n- [ ] TASK-02: Left for review after max builders\n",
      "utf-8",
    );
    writeFileSync(
      workflow.iterations[0]!.progressPath,
      "# Progress - Iteration 1\n\n## Builder 5 (2026-03-16T15:55:05Z)\n\nReached final builder pass.\n",
      "utf-8",
    );
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-5", {
      worktree: worktreePath,
      branch: "feat/913-from-main",
      status: "killed",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: "1",
      builderIteration: String(workflow.maxBuilderIterations),
    });

    const restoredSession = makeSession({
      id: "app-5",
      status: "spawning",
      branch: "feat/913-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: String(workflow.maxBuilderIterations),
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(restoredSession);
    vi.mocked(mockSessionManager.restore).mockResolvedValue(restoredSession);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-913");

    expect(resumed.status).toBe("reviewing");
    expect(resumed.iterations[0]?.status).toBe("reviewing");
    expect(resumed.iterations[0]?.reviewerSession).toBe("app-5");
    expect(mockSessionManager.runCommand).toHaveBeenCalledTimes(1);
  });

  it("resumeWorkflow does not advance a restored builder with pending commit output", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "pending-commit-builder-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-914", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "914",
      "feat/914-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-914", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-914", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-914", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-914", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-914", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-0",
        builderSessions: ["app-1"],
      },
    ];

    writeFileSync(
      workflow.iterations[0]!.planPath,
      "# PLAN\n\n- [x] TASK-01: Done\n",
      "utf-8",
    );
    writeFileSync(
      workflow.iterations[0]!.progressPath,
      "# Progress - Iteration 1\n\n## Builder 1 (2026-03-16T15:55:05Z)\n\n### Git Commit\n- Hash: pending\n",
      "utf-8",
    );
    saveWorkflowState(config.configPath, projectPath, workflow);

    const restoredSession = makeSession({
      id: "app-1",
      status: "spawning",
      activity: "ready",
      branch: "feat/914-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(restoredSession);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-914");

    expect(resumed.status).toBe("building");
    expect(resumed.iterations[0]?.status).toBe("building");
    expect(mockSessionManager.runCommand).toHaveBeenCalledTimes(1);
  });

  it("resumeWorkflow normalizes stale desired reviewer intent to the current planning iteration", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "stale-reviewer-intent-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-001"), { recursive: true });
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-002"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "915",
      "feat/915-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-9";
    workflow.currentIteration = 2;
    workflow.currentBuilderIteration = 0;
    workflow.status = "failed";
    workflow.desiredStage = "reviewer";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 0;
    workflow.dispatchStatus = "pending";
    workflow.iterations = [
      {
        number: 1,
        status: "changes_requested",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-2"],
        reviewerSession: "app-3",
      },
      {
        number: 2,
        status: "planning",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-002"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-002", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-002", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-002", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-915", "iterations", "iteration-002", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: [],
      },
    ];

    writeFileSync(workflow.iterations[0]!.reviewFindingsPath, "## VERDICT: CHANGES REQUESTED\n", "utf-8");
    writeFileSync(
      workflow.iterations[1]!.planPath,
      "# PLAN - Iteration 2\n\nIssue: 915\n\n(Architect will add tasks)\n",
      "utf-8",
    );
    writeFileSync(workflow.iterations[1]!.progressPath, "# Progress - Iteration 2\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const recoveredArchitect = makeSession({
      id: "app-10",
      status: "spawning",
      branch: "feat/915-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "architect",
        workflowIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(recoveredArchitect)
      .mockResolvedValue(recoveredArchitect);
    vi.mocked(mockSessionManager.restore).mockResolvedValue(recoveredArchitect);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-915");

    expect(resumed.status).toBe("planning");
    expect(resumed.currentIteration).toBe(2);
    expect(resumed.desiredStage).toBe("architect");
    expect(resumed.desiredIteration).toBe(2);
    expect(mockSessionManager.runCommand).toHaveBeenCalledTimes(1);
  });

  it("rebinding a recovered owner session updates iteration artifact paths to the active worktree", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const oldWorktreePath = join(tmpDir, "old-worktree");
    const newWorktreePath = join(tmpDir, "new-worktree");
    mkdirSync(join(newWorktreePath, ".architect-delivery", "projects", "issue-903", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "903",
      "feat/903-from-main",
      "main",
    );
    workflow.worktreePath = oldWorktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "failed";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(oldWorktreePath, ".architect-delivery", "projects", "issue-903", "iterations", "iteration-001"),
        planPath: join(oldWorktreePath, ".architect-delivery", "projects", "issue-903", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(oldWorktreePath, ".architect-delivery", "projects", "issue-903", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(oldWorktreePath, ".architect-delivery", "projects", "issue-903", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(oldWorktreePath, ".architect-delivery", "projects", "issue-903", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-1"],
      },
    ];
    saveWorkflowState(config.configPath, projectPath, workflow);

    const replacement = makeSession({
      id: "app-2",
      status: "spawning",
      branch: "feat/903-from-main",
      workspacePath: newWorktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replacement)
      .mockResolvedValue(replacement);
    vi.mocked(mockSessionManager.restore).mockRejectedValue(new Error("missing"));
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(replacement);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-903");
    expect(resumed.worktreePath).toBe(newWorktreePath);
    expect(resumed.iterations[0]?.planPath).toContain(newWorktreePath);
  });

  it("resumeWorkflow rewrites stale artifact paths before resuming a failed workflow", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "rebind-before-resume");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-904", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "904",
      "feat/904-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "failed";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: "/tmp/old/iteration-001",
        planPath: "/tmp/old/iteration-001/PLAN.md",
        progressPath: "/tmp/old/iteration-001/PROGRESS.md",
        orchestratorAnalysisPath: "/tmp/old/iteration-001/orchestrator-analysis.md",
        reviewFindingsPath: "/tmp/old/iteration-001/CODE_REVIEW_FINDINGS.md",
        architectSession: "app-1",
        builderSessions: ["app-1"],
      },
    ];
    writeFileSync(join(worktreePath, ".architect-delivery", "projects", "issue-904", "iterations", "iteration-001", "PLAN.md"), "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(join(worktreePath, ".architect-delivery", "projects", "issue-904", "iterations", "iteration-001", "PROGRESS.md"), "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const session = makeSession({
      id: "app-1",
      status: "spawning",
      branch: "feat/904-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(session);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-904");
    expect(resumed.status).toBe("building");
    expect(resumed.iterations[0]?.planPath).toContain(worktreePath);
  });

  it("does not treat pending reviewer placeholder output as a completed review verdict", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "pending-review-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-906", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "906",
      "feat/906-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "reviewing";
    workflow.desiredStage = "reviewer";
    workflow.desiredIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "reviewing",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-906", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-906", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-906", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-906", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-906", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        reviewerSession: "app-1",
        builderSessions: ["app-1"],
      },
    ];
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [x] TASK-01: Done\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.reviewFindingsPath, "# CODE REVIEW FINDINGS - Iteration 1\n\n(Pending reviewer output)\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const session = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/906-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "reviewer",
        workflowIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(session);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-906");
    expect(resumed.status).toBe("reviewing");
    expect(mockSessionManager.runCommand).not.toHaveBeenCalled();
  });

  it("workflow state persists desired stage intent defaults", () => {
    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "555",
      "feat/555-from-main",
      "main",
    );

    expect(workflow.desiredStage).toBe("architect");
    expect(workflow.desiredIteration).toBe(1);
    expect(workflow.desiredBuilderIteration).toBe(0);
    expect(workflow.dispatchStatus).toBe("pending");
  });

  it("restored workflow owner with stale metadata respawns a matching host-shell session", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "respawn-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "901",
      "feat/901-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 2;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 2;
    workflow.dispatchStatus = "pending";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-901", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-901", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-901", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-901", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-901", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-1", "app-1"],
      },
    ];

    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-901", "iterations", "iteration-001"), { recursive: true });
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const staleSession = makeSession({
      id: "app-1",
      status: "spawning",
      branch: "feat/901-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    const spawnedSession = makeSession({
      id: "app-2",
      status: "spawning",
      branch: "feat/901-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get)
      .mockResolvedValueOnce(staleSession)
      .mockResolvedValueOnce(spawnedSession)
      .mockResolvedValue(spawnedSession);
    vi.mocked(mockSessionManager.restore).mockResolvedValue(staleSession);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(spawnedSession);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await wm.resumeWorkflow("wf-901");

    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-901",
        workflowStage: "builder",
        workflowIteration: 1,
        builderIteration: 2,
        workspacePath: worktreePath,
      }),
    );
  }, 15000);

  it("reuses the persisted workflow worktree when respawning a missing owner session", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "resume-existing-worktree");
    mkdirSync(
      join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-002"),
      { recursive: true },
    );

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "916",
      "feat/916-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.currentIteration = 2;
    workflow.status = "reviewing";
    workflow.desiredStage = "reviewer";
    workflow.desiredIteration = 2;
    workflow.dispatchStatus = "pending";
    workflow.iterations = [
      {
        number: 1,
        status: "approved",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-1"],
        architectSession: "app-1",
        reviewerSession: "app-1",
      },
      {
        number: 2,
        status: "reviewing",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-002"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-002", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-002", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-002", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-916", "iterations", "iteration-002", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-2"],
        reviewerSession: "app-2",
      },
    ];
    writeFileSync(workflow.iterations[1]!.planPath, "# PLAN\n\n- [x] TASK-01: Implemented\n", "utf-8");
    writeFileSync(workflow.iterations[1]!.progressPath, "# Progress - Iteration 2\n\n- done\n", "utf-8");
    writeFileSync(workflow.iterations[1]!.reviewFindingsPath, "(Pending reviewer output)\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const replacement = makeSession({
      id: "app-3",
      status: "spawning",
      branch: "feat/916-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "reviewer",
        workflowIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValueOnce(null).mockResolvedValue(replacement);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(replacement);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await wm.resumeWorkflow("wf-916");

    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-916",
        workflowStage: "reviewer",
        workflowIteration: 2,
        workspacePath: worktreePath,
      }),
    );
  });

  it("resumeWorkflow dispatches reviewer work when review findings are still missing", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "resume-reviewer-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-002"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "917",
      "feat/917-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-7";
    workflow.currentIteration = 2;
    workflow.status = "reviewing";
    workflow.desiredStage = "reviewer";
    workflow.desiredIteration = 2;
    workflow.dispatchStatus = "pending";
    workflow.iterations = [
      {
        number: 1,
        status: "changes_requested",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-6"],
        architectSession: "app-5",
        reviewerSession: "app-6",
      },
      {
        number: 2,
        status: "reviewing",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-002"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-002", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-002", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-002", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-917", "iterations", "iteration-002", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-7"],
        reviewerSession: "app-7",
      },
    ];

    writeFileSync(workflow.iterations[1]!.planPath, "# PLAN\n\n- [x] TASK-01: Done\n", "utf-8");
    writeFileSync(workflow.iterations[1]!.progressPath, "# Progress - Iteration 2\n\n- done\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const restoredReviewer = makeSession({
      id: "app-7",
      status: "spawning",
      activity: "ready",
      branch: "feat/917-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "reviewer",
        workflowIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(restoredReviewer);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    const resumed = await wm.resumeWorkflow("wf-917");

    expect(resumed.status).toBe("reviewing");
    expect(mockSessionManager.runCommand).toHaveBeenCalledTimes(1);
    expect(existsSync(workflow.iterations[1]!.reviewFindingsPath)).toBe(true);
    expect(readFileSync(workflow.iterations[1]!.reviewFindingsPath, "utf-8")).toContain("Pending reviewer output");
  });

  it("stamps workflow metadata onto recovered owner sessions", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "stamp-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-905", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "905",
      "feat/905-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "failed";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-905", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-905", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-905", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-905", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-905", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-1"],
      },
    ];
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    const session = makeSession({
      id: "app-1",
      status: "spawning",
      branch: "feat/905-from-main",
      workspacePath: worktreePath,
      metadata: {
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(session);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await wm.resumeWorkflow("wf-905");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["workflowId"]).toBe("wf-905");
    expect(meta?.["workflowStage"]).toBe("builder");
    expect(meta?.["workflowIteration"]).toBe("1");
    expect(meta?.["builderIteration"]).toBe("1");
  });

  it("ignores temp metadata files when listing sessions and cleans up superseded workflow owners", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "cleanup-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-908", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "908",
      "feat/908-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-2";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 2;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 2;
    workflow.dispatchStatus = "pending";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-908", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-908", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-908", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-908", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-908", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-1"],
      },
    ];
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-1", {
      worktree: worktreePath,
      branch: "feat/908-from-main",
      status: "working",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: "1",
      builderIteration: "1",
    });
    writeMetadata(sessionsDir, "app-2", {
      worktree: worktreePath,
      branch: "feat/908-from-main",
      status: "working",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: "1",
      builderIteration: "2",
    });
    writeFileSync(join(sessionsDir, "app-2.tmp.123"), "junk", "utf-8");

    const oldSession = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/908-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });
    const newSession = makeSession({
      id: "app-2",
      status: "working",
      branch: "feat/908-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(newSession);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(newSession);
    vi.mocked(mockSessionManager.list).mockResolvedValue([oldSession, newSession]);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await wm.resumeWorkflow("wf-908");

    const listed = await createSessionManager({ config, registry: mockRegistry }).list("my-app");
    expect(listed.map((s) => s.id)).toEqual(expect.arrayContaining(["app-1", "app-2"]));
  });

  it("spawnNextBuilder advances directly to reviewer when all plan tasks are complete", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "complete-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "777",
      "feat/777-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 2;
    workflow.status = "building";
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-777", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-777", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-777", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-777", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-777", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        builderSessions: ["app-1"],
        architectSession: "app-1",
      },
    ];

    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-777", "iterations", "iteration-001"), { recursive: true });
    writeFileSync(
      workflow.iterations[0]!.planPath,
      "# PLAN\n\n- [x] TASK-01: Done\n- [x] TASK-02: Done\n",
      "utf-8",
    );
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-1", {
      worktree: worktreePath,
      branch: "feat/777-from-main",
      status: "working",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: "1",
      builderIteration: "2",
    });

    const session = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/777-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "2",
        agent: "host-shell",
      },
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const wm = createWorkflowManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await wm.spawnNextBuilder("wf-777");

    const saved = JSON.parse(readFileSync(join(getProjectBaseDir(config.configPath, projectPath), "workflows", "wf-777.json"), "utf-8"));
    expect(saved.status).toBe("reviewing");
    expect(saved.iterations[0].status).toBe("reviewing");

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["workflowStage"]).toBe("reviewer");
    expect(metadata?.["builderIteration"] ?? "").toBe("");
    expect(mockSessionManager.runCommand).toHaveBeenCalledTimes(1);
  });

  it("auto-resumes a timed-out workflow stage by killing and restarting the owner session", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "timeout-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "888",
      "feat/888-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.dispatchStartedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    workflow.lastStageActivityAt = new Date(Date.now() - 11 * 60_000).toISOString();
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-888", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-888", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-888", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-888", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-888", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-1"],
      },
    ];

    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-888", "iterations", "iteration-001"), { recursive: true });
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-1", {
      worktree: worktreePath,
      branch: "feat/888-from-main",
      status: "working",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: "1",
      builderIteration: "1",
    });

    const session = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/888-from-main",
      workspacePath: worktreePath,
      lastActivityAt: new Date(Date.now() - 11 * 60_000),
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(session);
    vi.mocked(mockRuntime.getOutput).mockResolvedValue("still running\n");

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 75));
    lm.stop();

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: false });
    expect(mockSessionManager.spawn).toHaveBeenCalled();
  });

  it("does not re-dispatch a pending builder stage while the owner session is still active", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "pending-active-builder-worktree");
    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-911", "iterations", "iteration-001"), { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "911",
      "feat/911-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-2";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 2;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 2;
    workflow.dispatchStatus = "pending";
    workflow.dispatchStartedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    workflow.lastStageActivityAt = new Date().toISOString();
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-911", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-911", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-911", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-911", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-911", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-1", "app-2"],
      },
    ];

    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-2", {
      worktree: worktreePath,
      branch: "feat/911-from-main",
      status: "working",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: "1",
      builderIteration: "2",
    });

    const session = makeSession({
      id: "app-2",
      status: "working",
      activity: "active",
      branch: "feat/911-from-main",
      workspacePath: worktreePath,
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "2",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockRuntime.getOutput).mockResolvedValue("still running\n");

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    lm.stop();

    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    expect(mockSessionManager.runCommand).not.toHaveBeenCalled();
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
  });

  it("does not kill an actively-updating stage before the hard timeout", async () => {
    const projectPath = config.projects["my-app"]!.path;
    mkdirSync(projectPath, { recursive: true });
    const worktreePath = join(tmpDir, "active-worktree");
    mkdirSync(worktreePath, { recursive: true });

    const workflow = createWorkflowState(
      config.configPath,
      config.projects["my-app"]!,
      "my-app",
      "889",
      "feat/889-from-main",
      "main",
    );
    workflow.worktreePath = worktreePath;
    workflow.ownerSessionId = "app-1";
    workflow.currentIteration = 1;
    workflow.currentBuilderIteration = 1;
    workflow.status = "building";
    workflow.desiredStage = "builder";
    workflow.desiredIteration = 1;
    workflow.desiredBuilderIteration = 1;
    workflow.dispatchStatus = "running";
    workflow.dispatchStartedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    workflow.lastStageActivityAt = new Date(Date.now() - 30_000).toISOString();
    workflow.iterations = [
      {
        number: 1,
        status: "building",
        startedAt: new Date().toISOString(),
        iterationDir: join(worktreePath, ".architect-delivery", "projects", "issue-889", "iterations", "iteration-001"),
        planPath: join(worktreePath, ".architect-delivery", "projects", "issue-889", "iterations", "iteration-001", "PLAN.md"),
        progressPath: join(worktreePath, ".architect-delivery", "projects", "issue-889", "iterations", "iteration-001", "PROGRESS.md"),
        orchestratorAnalysisPath: join(worktreePath, ".architect-delivery", "projects", "issue-889", "iterations", "iteration-001", "orchestrator-analysis.md"),
        reviewFindingsPath: join(worktreePath, ".architect-delivery", "projects", "issue-889", "iterations", "iteration-001", "CODE_REVIEW_FINDINGS.md"),
        architectSession: "app-1",
        builderSessions: ["app-1"],
      },
    ];

    mkdirSync(join(worktreePath, ".architect-delivery", "projects", "issue-889", "iterations", "iteration-001"), { recursive: true });
    writeFileSync(workflow.iterations[0]!.planPath, "# PLAN\n\n- [ ] TASK-01: Continue work\n", "utf-8");
    writeFileSync(workflow.iterations[0]!.progressPath, "# Progress - Iteration 1\n", "utf-8");
    saveWorkflowState(config.configPath, projectPath, workflow);

    writeMetadata(sessionsDir, "app-1", {
      worktree: worktreePath,
      branch: "feat/889-from-main",
      status: "working",
      project: "my-app",
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: "1",
      builderIteration: "1",
    });

    const session = makeSession({
      id: "app-1",
      status: "working",
      branch: "feat/889-from-main",
      workspacePath: worktreePath,
      lastActivityAt: new Date(),
      metadata: {
        workflowId: workflow.id,
        workflowStage: "builder",
        workflowIteration: "1",
        builderIteration: "1",
        agent: "host-shell",
      },
    });

    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockRuntime.getOutput).mockResolvedValue("still working\n");

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    lm.stop();

    expect(mockSessionManager.kill).not.toHaveBeenCalled();
  });
});

describe("check (single session)", () => {
  it("detects transition from spawning to working", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    // Write metadata so updateMetadata works
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");

    // Metadata should be updated
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("working");
  });

  it("detects killed state when runtime is dead", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects killed state when getActivityState returns exited", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "exited" });

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects killed via terminal fallback when getActivityState returns null", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(false);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("stays working when agent is idle but process is still running (fallback path)", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(true);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("detects needs_input from agent", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "waiting_input" });

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("preserves stuck state when getActivityState throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const session = makeSession({ status: "stuck" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "stuck",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should preserve "stuck" — NOT coerce to "working"
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves needs_input state when getActivityState throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const session = makeSession({ status: "needs_input" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "needs_input",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should preserve "needs_input" — NOT coerce to "working"
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("preserves stuck state when getActivityState returns null and getOutput throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockRuntime.getOutput).mockRejectedValue(new Error("tmux error"));

    const session = makeSession({ status: "stuck" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "stuck",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // getOutput failure should hit the catch block and preserve "stuck"
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("detects PR states from SCM", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
  });

  it("skips PR auto-detection when metadata disables it", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      prAutoDetect: "off",
    });

    const realSessionManager = createSessionManager({
      config,
      registry: registryWithSCM,
    });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("detects merged PR", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "approved", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
  });

  it("detects mergeable when approved + CI green", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
  });

  it("throws for nonexistent session", async () => {
    vi.mocked(mockSessionManager.get).mockResolvedValue(null);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await expect(lm.check("nonexistent")).rejects.toThrow("not found");
  });

  it("does not change state when status is unchanged", async () => {
    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");

    // Second check — status remains working, no transition
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});

describe("reactions", () => {
  it("triggers send-to-agent reaction on CI failure", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 2,
        escalateAfter: 2,
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "CI is failing. Fix it.");
  });

  it("does not trigger reaction when auto=false", async () => {
    config.reactions = {
      "ci-failed": {
        auto: false,
        action: "send-to-agent",
        message: "CI is failing.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });
  it("suppresses immediate notification when send-to-agent reaction handles the event", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // Session transitions from pr_open → ci_failed, which maps to ci-failed reaction
    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    // Configure send-to-agent reaction for ci-failed with retries
    const configWithReaction = {
      ...config,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          message: "Fix CI",
          retries: 3,
          escalateAfter: 3,
        },
      },
    };

    const lm = createLifecycleManager({
      config: configWithReaction,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    // send-to-agent reaction should have been executed
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    // Notifier should NOT have been called — the reaction is handling it
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });

  it("dispatches unresolved review comments even when reviewDecision stays unchanged", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle review comments.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c1",
          author: "reviewer",
          body: "Please rename this helper",
          path: "src/app.ts",
          line: 12,
          isResolved: false,
          createdAt: new Date(),
          url: "https://example.com/comment/1",
        },
      ]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Handle review comments.");

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["lastPendingReviewDispatchHash"]).toBe("c1");
  });

  it("does not double-send when changes_requested transition already triggered the reaction", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle requested changes.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c1",
          author: "reviewer",
          body: "Please add validation",
          path: "src/route.ts",
          line: 44,
          isResolved: false,
          createdAt: new Date(),
          url: "https://example.com/comment/2",
        },
      ]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Handle requested changes.");
  });

  it("dispatches automated review comments only once for an unchanged backlog", async () => {
    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Handle automated review findings.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([
        {
          id: "bot-1",
          botName: "cursor[bot]",
          body: "Potential issue detected",
          path: "src/worker.ts",
          line: 9,
          severity: "warning",
          createdAt: new Date(),
          url: "https://example.com/comment/3",
        },
      ]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      "Handle automated review findings.",
    );

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["lastAutomatedReviewDispatchHash"]).toBe("bot-1");
  });

  it("notifies humans on significant transitions without reaction config", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // merge.completed has "action" priority but NO reaction key mapping,
    // so it must reach notifyHuman directly
    const session = makeSession({ status: "approved", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockNotifier.notify).toHaveBeenCalled();
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "merge.completed" }),
    );
  });
});

describe("getStates", () => {
  it("returns copy of states map", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    const states = lm.getStates();
    expect(states.get("app-1")).toBe("working");

    // Modifying returned map shouldn't affect internal state
    states.set("app-1", "killed");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});
