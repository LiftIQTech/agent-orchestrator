/**
 * Workflow Manager — orchestrates architect-delivery workflow
 *
 * Implements sequential builder pattern:
 * 1. Architect creates PLAN.md with tasks
 * 2. Builders execute tasks sequentially (not parallel)
 * 3. Reviewer checks the work
 * 4. If changes requested, new iteration with architect
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, readdirSync, unlinkSync, cpSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { shellEscape } from "./utils.js";
import type {
  OrchestratorConfig,
  ProjectConfig,
  WorkflowState,
  WorkflowStage,
  IterationState,
  Session,
    SessionManager,
    PluginRegistry,
    Issue,
    Tracker,
    SCM,
    Workspace,
} from "./types.js";
import {
  createWorkflowState,
  loadWorkflowState,
  saveWorkflowState,
  startNewIteration,
  getRequirementsPath,
} from "./workflow-state.js";
import { createTaskManager } from "./task-manager.js";
import { 
  loadPromptFile, 
  buildPromptContext, 
  renderPrompt, 
  writeProgressEntry,
  type PromptContext 
} from "./prompt-loader.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir, getProjectBaseDir } from "./paths.js";
import { isTerminalSession } from "./types.js";

export interface WorkflowManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

export interface WorkflowManager {
  startWorkflow(projectId: string, issueId: string, baseBranch?: string): Promise<WorkflowState>;
  spawnArchitect(workflow: WorkflowState, project: ProjectConfig): Promise<Session>;
  spawnNextBuilder(workflowId: string): Promise<Session | null>;
  spawnReviewer(workflow: WorkflowState, project: ProjectConfig): Promise<Session>;
  handleReviewComplete(workflowId: string, approved: boolean, feedback?: string): Promise<void>;
  reopenWorkflow(workflowId: string, reason: string, preferredStage?: WorkflowStage): Promise<WorkflowState>;
  resumeWorkflow(workflowId: string): Promise<WorkflowState>;
  getWorkflow(projectId: string, workflowId: string): WorkflowState | null;
  listWorkflows(projectId: string): WorkflowState[];
  killWorkflow(workflowId: string): Promise<void>;
}

export function createWorkflowManager(deps: WorkflowManagerDeps): WorkflowManager {
  const { config, registry, sessionManager } = deps;
  const WORKFLOW_SENTINEL_PREFIX = "__AO_STAGE_DONE__";
  const execFileAsync = promisify(execFile);

  const WORKFLOW_GUARDRAILS = `\n\n## Deterministic Workflow Guardrails (MANDATORY)\n\n- DO NOT create or update pull requests with gh/CLI tools.\n- DO NOT create/switch branches (no git checkout -b, no git switch).\n- DO NOT rebase or merge branches.\n- Stay on the provided branch for this workflow session.\n- Only modify files required by requirements + PLAN tasks for this issue.\n`;

  function makeWorkflowBranch(issueId: string, baseBranch?: string, defaultBranch?: string): string {
    if (!baseBranch || !defaultBranch || baseBranch === defaultBranch) {
      return `feat/${issueId}`;
    }
    const slug = baseBranch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `feat/${issueId}-from-${slug}`;
  }

  function getWorkflowSessionIds(workflow: WorkflowState): string[] {
    const ids: string[] = [];
    for (const iteration of workflow.iterations) {
      if (iteration.architectSession) ids.push(iteration.architectSession);
      ids.push(...iteration.builderSessions);
      if (iteration.reviewerSession) ids.push(iteration.reviewerSession);
    }
    return ids;
  }

  async function hasLiveWorkflowSessions(workflow: WorkflowState): Promise<boolean> {
    const sessionIds = getWorkflowSessionIds(workflow);
    for (const sessionId of sessionIds) {
      try {
        const session = await sessionManager.get(sessionId);
        if (!session) continue;
        if (session.status === "ci_failed") continue;
        if (!isTerminalSession(session)) {
          return true;
        }
      } catch {
        // Ignore missing/invalid sessions while probing staleness
      }
    }
    return false;
  }

  async function cleanupIterationSessions(
    workflow: WorkflowState,
    iteration: IterationState,
    options?: { includeOwner?: boolean },
  ): Promise<void> {
    const sessionIds = [
      iteration.architectSession,
      ...iteration.builderSessions,
      iteration.reviewerSession,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);

    for (const sessionId of sessionIds) {
      if (!options?.includeOwner && sessionId === workflow.ownerSessionId) continue;
      try {
        await sessionManager.kill(sessionId, { purgeOpenCode: false });
      } catch {
        // Best-effort cleanup only
      }
    }
  }

  function normalizeIterationArtifacts(workflow: WorkflowState, iteration: IterationState): void {
    if (!workflow.worktreePath) return;

    const rootPlanPath = join(workflow.worktreePath, "PLAN.md");
    const rootProgressPath = join(workflow.worktreePath, "PROGRESS.md");
    const rootAnalysisPath = join(workflow.worktreePath, "orchestrator-analysis.md");

    try {
      if (existsSync(rootPlanPath)) {
        const rootPlan = readFileSync(rootPlanPath, "utf-8");
        const currentPlan = existsSync(iteration.planPath)
          ? readFileSync(iteration.planPath, "utf-8")
          : "";
        const isPlaceholder = currentPlan.includes("(Architect will add tasks)");
        if (isPlaceholder || !existsSync(iteration.planPath)) {
          writeFileSync(iteration.planPath, rootPlan, "utf-8");
        }
        unlinkSync(rootPlanPath);
      }

      if (existsSync(rootProgressPath) && !existsSync(iteration.progressPath)) {
        writeFileSync(iteration.progressPath, readFileSync(rootProgressPath, "utf-8"), "utf-8");
        unlinkSync(rootProgressPath);
      }

      if (existsSync(rootAnalysisPath) && !existsSync(iteration.orchestratorAnalysisPath)) {
        writeFileSync(
          iteration.orchestratorAnalysisPath,
          readFileSync(rootAnalysisPath, "utf-8"),
          "utf-8",
        );
        unlinkSync(rootAnalysisPath);
      }
    } catch {
      // Best-effort normalization only
    }
  }

  function rebindWorkflowArtifactsToWorktree(workflow: WorkflowState): void {
    if (!workflow.worktreePath) return;

    const issueRoot = join(workflow.worktreePath, ".architect-delivery", "projects", `issue-${workflow.issueId}`);
    const requirementsPath = join(issueRoot, "requirements.md");

    for (const iteration of workflow.iterations) {
      const iterationDir = join(issueRoot, "iterations", basename(iteration.iterationDir));
      iteration.iterationDir = iterationDir;
      iteration.planPath = join(iterationDir, "PLAN.md");
      iteration.progressPath = join(iterationDir, "PROGRESS.md");
      iteration.orchestratorAnalysisPath = join(iterationDir, "orchestrator-analysis.md");
      iteration.reviewFindingsPath = join(iterationDir, "CODE_REVIEW_FINDINGS.md");
    }

    if (existsSync(requirementsPath)) {
      // No-op anchor: ensures the rebuilt issue root points at the active worktree layout.
    }
  }

  function archiveWorkflowProject(workflow: WorkflowState, project: ProjectConfig): void {
    const sourceFromRepo = join(project.path, ".architect-delivery", "projects", `issue-${workflow.issueId}`);
    const sourceFromWorktree = workflow.worktreePath
      ? join(workflow.worktreePath, ".architect-delivery", "projects", `issue-${workflow.issueId}`)
      : "";
    const sourceDir = existsSync(sourceFromRepo)
      ? sourceFromRepo
      : sourceFromWorktree && existsSync(sourceFromWorktree)
      ? sourceFromWorktree
      : "";
    if (!sourceDir) return;

    const completedRoot = join(project.path, ".architect-delivery", "completed", `issue-${workflow.issueId}`);
    mkdirSync(dirname(completedRoot), { recursive: true });
    cpSync(sourceDir, completedRoot, { recursive: true, force: true });
  }

  function syncIterationArtifactsToRepo(
    workflow: WorkflowState,
    project: ProjectConfig,
    iteration: IterationState,
  ): void {
    const repoIterationDir = join(
      project.path,
      ".architect-delivery",
      "projects",
      `issue-${workflow.issueId}`,
      "iterations",
      basename(iteration.iterationDir),
    );
    mkdirSync(repoIterationDir, { recursive: true });

    const copyIfExists = (source: string, destination: string) => {
      if (existsSync(source)) {
        cpSync(source, destination, { force: true });
      }
    };

    copyIfExists(iteration.planPath, join(repoIterationDir, "PLAN.md"));
    copyIfExists(iteration.progressPath, join(repoIterationDir, "PROGRESS.md"));
    copyIfExists(
      iteration.orchestratorAnalysisPath,
      join(repoIterationDir, "orchestrator-analysis.md"),
    );
    copyIfExists(iteration.reviewFindingsPath, join(repoIterationDir, "CODE_REVIEW_FINDINGS.md"));

    const requirementsSource = join(
      dirname(dirname(iteration.iterationDir)),
      "requirements.md",
    );
    copyIfExists(
      requirementsSource,
      join(project.path, ".architect-delivery", "projects", `issue-${workflow.issueId}`, "requirements.md"),
    );
  }

  function ensureProgressArtifact(iteration: IterationState): void {
    if (!existsSync(iteration.progressPath)) return;
    const content = readFileSync(iteration.progressPath, "utf-8");
    const nonEmptyLines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    if (nonEmptyLines.length > 4) return;

    let completedTasks = "";
    if (existsSync(iteration.planPath)) {
      completedTasks = readFileSync(iteration.planPath, "utf-8")
        .split("\n")
        .filter((line) => line.startsWith("- [x] TASK-"))
        .join("\n");
    }

    const fallback = `\n\n## Automated Iteration Summary\n\n${
      completedTasks || "No completed TASK checkboxes detected at summary time."
    }\n`;
    appendFileSync(iteration.progressPath, fallback, "utf-8");
  }

  function buildStageCommand(prompt: string): string {
    const escapedPrompt = shellEscape(prompt);
    const command = [
      'command -v opencode >/dev/null 2>&1 || export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$PATH"',
      `opencode run --model github-copilot/gpt-5.4 ${escapedPrompt}`,
    ].join(" && ");
    return `${command}; printf '\n${WORKFLOW_SENTINEL_PREFIX}:%s\\n' \"$?\"`;
  }

  function ownerSessionMatchesIntent(
    session: Session | null,
    workflow: WorkflowState,
    stage: "architect" | "builder" | "reviewer",
    iterationNumber: number,
    builderIteration?: number,
  ): session is Session {
    if (!session) return false;
    if (isTerminalSession(session)) return false;
    if (session.projectId !== workflow.projectId) return false;
    if (session.branch !== workflow.branch) return false;
    if (session.workspacePath !== workflow.worktreePath) return false;
    if (session.metadata["workflowId"] !== workflow.id) return false;
    if (session.metadata["workflowStage"] !== stage) return false;
    if (session.metadata["workflowIteration"] !== String(iterationNumber)) return false;
    if (stage === "builder") {
      return session.metadata["builderIteration"] === String(builderIteration ?? 0);
    }
    return true;
  }

  function ownerSessionMatchesDispatch(
    session: Session | null,
    workflow: WorkflowState,
    stage: "architect" | "builder" | "reviewer",
    iterationNumber: number,
    builderIteration?: number,
  ): boolean {
    if (!session) return false;
    if (isTerminalSession(session)) return false;
    if (session.projectId !== workflow.projectId) return false;
    if (session.branch !== workflow.branch) return false;
    if (session.metadata["workflowId"] !== workflow.id) return false;
    if (session.metadata["workflowStage"] !== stage) return false;
    if (session.metadata["workflowIteration"] !== String(iterationNumber)) return false;
    if (stage === "builder") {
      return session.metadata["builderIteration"] === String(builderIteration ?? 0);
    }
    return true;
  }

  function ownerSessionCanBeReused(
    session: Session | null,
    workflow: WorkflowState,
    stage: "architect" | "builder" | "reviewer",
    iterationNumber: number,
    builderIteration?: number,
  ): session is Session {
    if (!session) return false;
    if (isTerminalSession(session)) return false;
    if (session.projectId !== workflow.projectId) return false;
    if (session.branch !== workflow.branch) return false;

    const recordedWorkflowId = session.metadata["workflowId"];
    if (recordedWorkflowId && recordedWorkflowId !== workflow.id) {
      return false;
    }

    const recordedStage = session.metadata["workflowStage"];
    const recordedIteration = session.metadata["workflowIteration"];
    const recordedBuilderIteration = session.metadata["builderIteration"];
    const hasRecordedIntent = Boolean(recordedStage || recordedIteration || recordedBuilderIteration);
    if (!hasRecordedIntent) return true;

    return ownerSessionMatchesIntent(session, workflow, stage, iterationNumber, builderIteration);
  }

  function stampOwnerSessionMetadata(
    projectPath: string,
    sessionId: string,
    workflow: WorkflowState,
    stage: "architect" | "builder" | "reviewer",
    iterationNumber: number,
    builderIteration?: number,
  ): void {
    const sessionsDir = getSessionsDir(config.configPath, projectPath);
    updateMetadata(sessionsDir, sessionId, {
      workflowId: workflow.id,
      workflowStage: stage,
      workflowIteration: String(iterationNumber),
      builderIteration: builderIteration !== undefined ? String(builderIteration) : "",
      prAutoDetect: "off",
    });
  }

  async function cleanupSupersededWorkflowOwners(
    workflow: WorkflowState,
    keepSessionId: string,
  ): Promise<void> {
    const sessions = await sessionManager.list(workflow.projectId);
    const candidates = sessions.filter(
      (session) =>
        session.id !== keepSessionId &&
        session.branch === workflow.branch &&
        session.metadata["workflowId"] === workflow.id &&
        session.metadata["agent"] === "host-shell",
    );

    for (const session of candidates) {
      try {
        await sessionManager.kill(session.id, { purgeOpenCode: false });
      } catch {
        // Best effort cleanup only.
      }
    }
  }

  function markWorkflowDispatchPending(
    projectPath: string,
    workflow: WorkflowState,
    stage: "architect" | "builder" | "reviewer",
    iterationNumber: number,
    builderIteration = 0,
  ): void {
    setWorkflowIntent(workflow, stage, iterationNumber, builderIteration, "pending");
    persistWorkflow(projectPath, workflow);
  }

  function persistWorkflow(projectPath: string, workflow: WorkflowState): void {
    saveWorkflowState(config.configPath, projectPath, workflow);
  }

  function setWorkflowIntent(
    workflow: WorkflowState,
    stage: "architect" | "builder" | "reviewer",
    iteration: number,
    builderIteration = 0,
    dispatchStatus: "pending" | "running" | "completed" = "pending",
  ): void {
    workflow.desiredStage = stage;
    workflow.desiredIteration = iteration;
    workflow.desiredBuilderIteration = builderIteration;
    workflow.dispatchStatus = dispatchStatus;
    const now = new Date().toISOString();
    workflow.dispatchStartedAt = now;
    workflow.lastStageActivityAt = now;
  }

  function loadWorkflowOrThrow(workflowId: string): { workflow: WorkflowState; project: ProjectConfig } {
    for (const [_, project] of Object.entries(config.projects)) {
      const workflow = loadWorkflowState(config.configPath, project.path, workflowId);
      if (workflow) {
        return { workflow, project };
      }
    }
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  function ensureIterationArtifacts(iteration: IterationState, issueId: string): void {
    const iterDir = dirname(iteration.planPath);
    mkdirSync(iterDir, { recursive: true });

    if (!existsSync(iteration.planPath)) {
      writeFileSync(
        iteration.planPath,
        `# PLAN - Iteration ${iteration.number}

Issue: ${issueId}

(Architect will add tasks)
`,
        "utf-8",
      );
    }

    if (!existsSync(iteration.orchestratorAnalysisPath)) {
      writeFileSync(
        iteration.orchestratorAnalysisPath,
        `# Orchestrator Analysis - Iteration ${iteration.number}\n\nIssue: ${issueId}\n\n(Architect will add analysis)\n`,
        "utf-8",
      );
    }

    if (!existsSync(iteration.progressPath)) {
      writeFileSync(
        iteration.progressPath,
        `# Progress - Iteration ${iteration.number}

Issue: ${issueId}

`,
        "utf-8",
      );
    }
  }

  function architectArtifactsReady(iteration: IterationState): boolean {
    if (!existsSync(iteration.planPath) || !existsSync(iteration.orchestratorAnalysisPath)) {
      return false;
    }
    const taskManager = createTaskManager({ planPath: iteration.planPath });
    return taskManager.planExists() && taskManager.hasAnyTasks();
  }

  function progressHasBuilderEntry(iteration: IterationState, builderNum: number): boolean {
    if (builderNum < 1 || !existsSync(iteration.progressPath)) {
      return false;
    }
    const content = readFileSync(iteration.progressPath, "utf-8");
    return new RegExp(`^##\\s+Builder\\s+${builderNum}\\b`, "mi").test(content);
  }

  function progressHasPendingCommit(iteration: IterationState): boolean {
    if (!existsSync(iteration.progressPath)) {
      return false;
    }
    const content = readFileSync(iteration.progressPath, "utf-8");
    return /(^|\n)\s*-\s*Hash:\s*pending\b/i.test(content);
  }

  function stageForIterationStatus(
    status: IterationState["status"],
  ): "architect" | "builder" | "reviewer" {
    if (status === "building") return "builder";
    if (status === "reviewing") return "reviewer";
    return "architect";
  }

  function stageMatchesIteration(
    stage: "architect" | "builder" | "reviewer",
    iteration: IterationState,
  ): boolean {
    return stageForIterationStatus(iteration.status) === stage;
  }

  function builderArtifactsReadyForAdvance(
    workflow: WorkflowState,
    iteration: IterationState,
    builderNum: number,
  ): boolean {
    if (builderNum < 1) {
      return false;
    }

    const taskManager = createTaskManager({ planPath: iteration.planPath });
    if (!taskManager.planExists() || !taskManager.hasAnyTasks()) {
      return false;
    }

    if (progressHasPendingCommit(iteration)) {
      return false;
    }

    if (taskManager.allTasksComplete()) {
      return true;
    }

    if (workflow.currentBuilderIteration < workflow.maxBuilderIterations) {
      return false;
    }

    return progressHasBuilderEntry(iteration, builderNum);
  }

  function getReviewVerdict(iteration: IterationState): "approved" | "changes_requested" | null {
    if (!existsSync(iteration.reviewFindingsPath)) return null;
    const content = readFileSync(iteration.reviewFindingsPath, "utf-8");
    if (content.includes("(Pending reviewer output)")) return null;
    if (/##\s+VERDICT:\s+APPROVED/i.test(content)) return "approved";
    if (/##\s+VERDICT:\s+CHANGES REQUESTED/i.test(content)) return "changes_requested";
    return null;
  }

  async function ensureOwnerSession(
    workflow: WorkflowState,
    project: ProjectConfig,
    stage: "architect" | "builder" | "reviewer",
    iterationNumber: number,
    builderIteration?: number,
  ): Promise<Session> {
    const workspacePlugin = registry.get<Workspace>(
      "workspace",
      project.workspace ?? config.defaults.workspace,
    );
    const ownerWorkspaceUsable = async (session: Session | null): Promise<boolean> => {
      const workspacePath = session?.workspacePath;
      if (!workspacePath) return false;
      if (workspacePlugin?.exists) {
        try {
          return await workspacePlugin.exists(workspacePath);
        } catch {
          return false;
        }
      }
      return existsSync(workspacePath);
    };

    const adoptOwnerSession = async (session: Session): Promise<Session> => {
      workflow.worktreePath = session.workspacePath ?? workflow.worktreePath;
      workflow.ownerSessionId = session.id;
      rebindWorkflowArtifactsToWorktree(workflow);
      persistWorkflow(project.path, workflow);
      stampOwnerSessionMetadata(project.path, session.id, workflow, stage, iterationNumber, builderIteration);
      await cleanupSupersededWorkflowOwners(workflow, session.id);
      return session;
    };

    const restoreWorkflowOwner = async (sessionId: string): Promise<Session | null> => {
      try {
        return await sessionManager.restore(sessionId);
      } catch {
        return null;
      }
    };

    const spawnFreshOwnerSession = async (): Promise<Session | null> => {
      const reusableWorkspacePath = workflow.worktreePath
        ? await ownerWorkspaceUsable({ workspacePath: workflow.worktreePath } as Session)
          ? workflow.worktreePath
          : undefined
        : undefined;

      const candidate = await sessionManager.spawn({
        projectId: workflow.projectId,
        issueId: workflow.issueId,
        skipIssueValidation: true,
        branch: workflow.branch,
        baseBranch: workflow.baseBranch,
        ...(reusableWorkspacePath ? { workspacePath: reusableWorkspacePath } : {}),
        agent: "host-shell",
        workflowId: workflow.id,
        workflowStage: stage,
        workflowIteration: iterationNumber,
        builderIteration,
      });

      if (!candidate) {
        lastError = new Error(`Workflow owner spawn returned no session for ${workflow.id}`);
        return null;
      }

      await sleep(400);
      const confirmed = await sessionManager.get(candidate.id);
      if (ownerSessionMatchesDispatch(confirmed, workflow, stage, iterationNumber, builderIteration)) {
        return confirmed;
      }

      if (
        confirmed &&
        confirmed.id === candidate.id &&
        ownerSessionMatchesDispatch(candidate, workflow, stage, iterationNumber, builderIteration)
      ) {
        return candidate;
      }

      await sessionManager.kill(candidate.id, { purgeOpenCode: false }).catch(() => undefined);
      return null;
    };

    if (workflow.ownerSessionId) {
      const existing = await sessionManager.get(workflow.ownerSessionId);
      const existingWorkspaceUsable = await ownerWorkspaceUsable(existing);
      if (
        existingWorkspaceUsable &&
        ownerSessionMatchesIntent(existing, workflow, stage, iterationNumber, builderIteration)
      ) {
        return adoptOwnerSession(existing as Session);
      }
      if (
        existingWorkspaceUsable &&
        ownerSessionCanBeReused(existing, workflow, stage, iterationNumber, builderIteration)
      ) {
        return adoptOwnerSession(existing);
      }

      const restored = await restoreWorkflowOwner(workflow.ownerSessionId);
      const restoredWorkspaceUsable = await ownerWorkspaceUsable(restored);
      if (
        restoredWorkspaceUsable &&
        ownerSessionMatchesIntent(restored, workflow, stage, iterationNumber, builderIteration)
      ) {
        return adoptOwnerSession(restored);
      }
      if (
        restoredWorkspaceUsable &&
        ownerSessionCanBeReused(restored, workflow, stage, iterationNumber, builderIteration)
      ) {
        return adoptOwnerSession(restored);
      }

      workflow.ownerSessionId = "";
    }

    let session: Session | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (workflow.ownerSessionId) {
          const restored = await restoreWorkflowOwner(workflow.ownerSessionId);
          if (ownerSessionMatchesDispatch(restored, workflow, stage, iterationNumber, builderIteration)) {
            session = restored;
            break;
          }
        }

        session = await spawnFreshOwnerSession();
        if (session) break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!session) {
      throw lastError ?? new Error(`Failed to create durable workflow owner session for ${workflow.id}`);
    }

    return adoptOwnerSession(session);
  }

  async function dispatchArchitectForIteration(
    workflow: WorkflowState,
    project: ProjectConfig,
    iteration: IterationState,
  ): Promise<Session> {
    ensureIterationArtifacts(iteration, workflow.issueId);

    let issueContext: Partial<PromptContext["issue"]> = {
      identifier: workflow.issueId,
      title: "",
      description: "",
      url: "",
    };

    if (project.tracker) {
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (tracker) {
        try {
          const issue = await tracker.getIssue(workflow.issueId, project);
          issueContext = {
            identifier: issue.id,
            title: issue.title,
            description: issue.description ?? "",
            url: tracker.issueUrl ? tracker.issueUrl(workflow.issueId, project) : issue.url ?? "",
          };
        } catch {
          // Non-fatal: continue without issue context
        }
      }
    }

    const baseContext = buildPromptContext(config, workflow.projectId, workflow, iteration);
    const context: PromptContext = {
      ...baseContext,
      issue: { ...baseContext.issue, ...issueContext },
    };

    const template = loadPromptFile(config, project, "architect")
      .replace("{{requirementsPath}}", context.requirementsPath)
      .replace("{{iterationDir}}", context.iterationDir)
      .replace("{{planPath}}", iteration.planPath)
      .replace("{{progressPath}}", iteration.progressPath)
      .replace("{{orchestratorAnalysisPath}}", context.orchestratorAnalysisPath)
      .replace("{{reviewFindingsPath}}", context.reviewFindingsPath);

    markWorkflowDispatchPending(project.path, workflow, "architect", iteration.number, 0);

    await ensureOwnerSession(workflow, project, "architect", iteration.number);
    const prompt = `${renderPrompt(template, context)}${WORKFLOW_GUARDRAILS}`;
    const session = await dispatchStageCommand(workflow, prompt, "architect", iteration.number);

    await ensureWorkflowPR(workflow, project, session);

    iteration.architectSession = session.id;
    iteration.status = "planning";
    workflow.status = "planning";
    setWorkflowIntent(workflow, "architect", iteration.number, 0, "running");
    persistWorkflow(project.path, workflow);

    return session;
  }

  async function dispatchStageCommand(
    workflow: WorkflowState,
    prompt: string,
    stage: "architect" | "builder" | "reviewer",
    iterationNumber: number,
    builderNum?: number,
  ): Promise<Session> {
    if (!workflow.ownerSessionId) {
      throw new Error(`Workflow owner session missing: ${workflow.id}`);
    }

    const session = await sessionManager.get(workflow.ownerSessionId);
    if (!session) {
      throw new Error(`Owner session not found: ${workflow.ownerSessionId}`);
    }

    if (stage === "builder" || stage === "reviewer") {
      const project = config.projects[workflow.projectId];
      if (project) {
        const sessionsDir = getSessionsDir(config.configPath, project.path);
        updateMetadata(sessionsDir, session.id, { prAutoDetect: "off" });
      }
    }

    const command = buildStageCommand(prompt);
    await sessionManager.runCommand(workflow.ownerSessionId, command);

    const project = config.projects[workflow.projectId];
    if (project) {
      const sessionsDir = getSessionsDir(config.configPath, project.path);
      updateMetadata(sessionsDir, session.id, {
        workflowId: workflow.id,
        workflowStage: stage,
        workflowIteration: String(iterationNumber),
        builderIteration: builderNum ? String(builderNum) : "",
        status: "working",
      });
    }

    return session;
  }

  async function ensureWorkflowPR(
    workflow: WorkflowState,
    project: ProjectConfig,
    session: Session,
  ): Promise<void> {
    if (!project.scm) return;
    const scm = registry.get<SCM>("scm", project.scm.plugin);
    if (!scm) return;

    const detectPrSession =
      session.metadata["agent"] === "host-shell" || session.metadata["agent"] === ""
        ? { ...session, pr: null }
        : session;

    let pr = await scm.detectPR(detectPrSession, project);
    if (!pr && scm.createPR) {
      const createDeterministicPR = () =>
        scm.createPR!(project, {
          branch: workflow.branch,
          baseBranch: workflow.baseBranch,
          title: `architect: issue ${workflow.issueId} workflow branch`,
          body: `Deterministic workflow PR for issue #${workflow.issueId}.`,
          draft: true,
        });

      try {
        pr = await createDeterministicPR();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("No commits between")) {
          throw err;
        }

        await createWorkflowBootstrapCommit(project.path, workflow);
        pr = await createDeterministicPR();
      }
    }

    if (!pr) return;

    if (!pr.isDraft && scm.convertPRToDraft) {
      try {
        await scm.convertPRToDraft(pr);
        pr.isDraft = true;
      } catch {
        // Non-fatal: continue even if draft conversion fails
      }
    }

    if (!workflow.artifacts.prs.includes(pr.url)) {
      workflow.artifacts.prs.push(pr.url);
    }
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, {
      pr: pr.url,
      prBranch: pr.branch,
      prBaseBranch: pr.baseBranch,
    });
  }

  async function createWorkflowBootstrapCommit(projectPath: string, workflow: WorkflowState): Promise<void> {
    if (!workflow.worktreePath) return;

    const requirementsPath = getRequirementsPath(
      config.configPath,
      projectPath,
      workflow.issueId,
      workflow.worktreePath,
    );
    const commitMessage = `chore(workflow): bootstrap issue ${workflow.issueId} branch visibility`;

    await ensureWorkflowRequirementsScaffold(projectPath, workflow);

    if (!existsSync(requirementsPath)) {
      return;
    }

    try {
      await execFileAsync("git", ["add", "--", requirementsPath], { cwd: workflow.worktreePath });
      await execFileAsync("git", ["commit", "-m", commitMessage], { cwd: workflow.worktreePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/nothing to commit/i.test(message)) {
        return;
      }
      throw err;
    }

    try {
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workflow.worktreePath });
    } catch {
      return;
    }
  }

  async function transitionWorkflowCompletionArtifacts(
    workflow: WorkflowState,
    project: ProjectConfig,
    iteration: IterationState,
  ): Promise<void> {
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    const tracker = project.tracker ? registry.get<Tracker>("tracker", project.tracker.plugin) : null;
    const prReference = workflow.artifacts.prs.at(-1);

    if (prReference && scm?.resolvePR) {
      const pr = await scm.resolvePR(prReference, project);
      if (pr.isDraft && scm.markPRReadyForReview) {
        await scm.markPRReadyForReview(pr);
      }
    }

    if (tracker?.updateIssue) {
      await tracker.updateIssue(
        workflow.issueId,
        {
          labels: ["agent:pending-merge"],
          removeLabels: ["agent:in-progress", "agent:backlog"],
          comment:
            `Architect workflow completed in iteration ${iteration.number}. PR is ready for review and awaiting merge.`,
        },
        project,
      );
    }
  }

  async function ensureWorkflowRequirementsScaffold(
    projectPath: string,
    workflow: WorkflowState,
  ): Promise<void> {
    if (!workflow.worktreePath) return;

    const requirementsPath = getRequirementsPath(
      config.configPath,
      projectPath,
      workflow.issueId,
      workflow.worktreePath,
    );

    if (existsSync(requirementsPath)) return;

    let issueTitle = workflow.issueId;
    let issueDescription = "";
    let issueUrl = "";
    const project = config.projects[workflow.projectId];
    if (project?.tracker) {
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (tracker) {
        try {
          const issue = await tracker.getIssue(workflow.issueId, project);
          issueTitle = issue.title;
          issueDescription = issue.description ?? "";
          issueUrl = issue.url ?? (tracker.issueUrl ? tracker.issueUrl(workflow.issueId, project) : "");
        } catch {
          // Best-effort scaffold only
        }
      }
    }

    mkdirSync(dirname(requirementsPath), { recursive: true });
    writeFileSync(
      requirementsPath,
      `# Requirements\n\nIssue: ${workflow.issueId}\nTitle: ${issueTitle}\nURL: ${issueUrl}\n\n## Description\n\n${issueDescription}\n`,
      "utf-8",
    );
  }

  // =============================================================================
  // WORKFLOW START
  // =============================================================================

  /**
   * Start a new workflow for an issue
   */
  async function startWorkflow(
    projectId: string,
    issueId: string,
    baseBranch?: string
  ): Promise<WorkflowState> {
    const project = config.projects[projectId];
    if (!project) throw new Error(`Unknown project: ${projectId}`);

    if (!project.workflow?.enabled) {
      throw new Error(`Workflows not enabled for project: ${projectId}`);
    }

    // Check for existing workflow
    const existingId = `wf-${issueId}`;
    const existing = loadWorkflowState(config.configPath, project.path, existingId);
    if (existing && existing.status !== "completed" && existing.status !== "failed") {
      const hasLiveSessions = await hasLiveWorkflowSessions(existing);
      if (hasLiveSessions) {
        throw new Error(`Workflow already exists for ${issueId}: ${existing.id} (status: ${existing.status})`);
      }
    }

    // Determine branch
    const branch = makeWorkflowBranch(issueId, baseBranch, project.defaultBranch);

    // Create workflow state
    const workflow = createWorkflowState(
      config.configPath,
      project,
      projectId,
      issueId,
      branch,
      baseBranch,
    );

    // Create host shell session + worktree
    const session = await sessionManager.spawn({
      projectId,
      issueId,
      skipIssueValidation: true,
      branch,
      baseBranch,
      agent: "host-shell",
      workflowId: workflow.id,
      workflowStage: "architect",
      workflowIteration: 1,
    });

    workflow.worktreePath = session.workspacePath ?? "";
    workflow.ownerSessionId = session.id;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, {
      workflowId: workflow.id,
      workflowStage: "architect",
      workflowIteration: "1",
    });

    persistWorkflow(project.path, workflow);

    await ensureWorkflowRequirementsScaffold(project.path, workflow);

    await ensureWorkflowPR(workflow, project, session);

    // Start first iteration with architect
    await spawnArchitect(workflow, project);

    return workflow;
  }

  // =============================================================================
  // ARCHITECT SPAWN
  // =============================================================================

  /**
   * Spawn architect for new or continued iteration
   */
  async function spawnArchitect(
    workflow: WorkflowState,
    project: ProjectConfig
  ): Promise<Session> {
    // Create new iteration
    const iteration = startNewIteration(
      config.configPath,
      project.path,
      workflow,
      workflow.worktreePath,
    );

    return dispatchArchitectForIteration(workflow, project, iteration);
  }

  // =============================================================================
  // BUILDER SPAWN (Sequential)
  // =============================================================================

  /**
   * Spawn next builder in sequence
   * Returns null if should spawn reviewer instead
   */
  async function spawnNextBuilder(workflowId: string): Promise<Session | null> {
    // Find the workflow
    let workflow: WorkflowState | null = null;
    let project: ProjectConfig | null = null;

    for (const [pid, p] of Object.entries(config.projects)) {
      const w = loadWorkflowState(config.configPath, p.path, workflowId);
      if (w) {
        workflow = w;
        project = p;
        break;
      }
    }

    if (!workflow || !project) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const iteration = workflow.iterations[workflow.currentIteration - 1];
    if (!iteration) {
      throw new Error(`No current iteration for workflow: ${workflowId}`);
    }

    normalizeIterationArtifacts(workflow, iteration);
    syncIterationArtifactsToRepo(workflow, project, iteration);

    // Create task manager
    const taskManager = createTaskManager({ planPath: iteration.planPath });

    // Check if PLAN.md exists and has tasks
    if (!taskManager.planExists() || !taskManager.hasAnyTasks()) {
      // No plan yet, wait for architect
      return null;
    }

    // Check if all tasks done
    if (taskManager.allTasksComplete()) {
      // All done, spawn reviewer
      return spawnReviewer(workflow, project);
    }

    // Check builder limit
    if (workflow.currentBuilderIteration >= workflow.maxBuilderIterations) {
      // Hit limit, spawn reviewer anyway
      return spawnReviewer(workflow, project);
    }

    // Increment builder iteration
    const builderNum = workflow.currentBuilderIteration + 1;
    workflow.currentBuilderIteration = builderNum;
    markWorkflowDispatchPending(project.path, workflow, "builder", iteration.number, builderNum);

    return dispatchBuilderForIteration(workflow, project, iteration, builderNum);
  }

  async function dispatchBuilderForIteration(
    workflow: WorkflowState,
    project: ProjectConfig,
    iteration: IterationState,
    builderNum: number,
  ): Promise<Session> {
    if (builderNum < 1) {
      throw new Error(`Invalid builder iteration for workflow ${workflow.id}: ${builderNum}`);
    }

    // Build prompt context
    const baseContext = buildPromptContext(config, workflow.projectId, workflow, iteration);
    
    // Fetch issue context
    let issueContext: Partial<PromptContext["issue"]> = {};
    if (project.tracker) {
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (tracker) {
        try {
          const issue = await tracker.getIssue(workflow.issueId, project);
          issueContext = {
            identifier: issue.id,
            title: issue.title,
            description: issue.description ?? "",
            url: issue.url ?? "",
          };
        } catch {}
      }
    }

    const context: PromptContext = {
      ...baseContext,
      issue: { ...baseContext.issue, ...issueContext },
      builderNum,
    };

    // Load and render prompt
    let template = loadPromptFile(config, project, "builder");
    template = template
      .replace("{{requirementsPath}}", context.requirementsPath)
      .replace("{{iterationDir}}", context.iterationDir)
      .replace("{{planPath}}", iteration.planPath)
      .replace("{{progressPath}}", iteration.progressPath)
      .replace("{{orchestratorAnalysisPath}}", context.orchestratorAnalysisPath)
      .replace("{{reviewFindingsPath}}", context.reviewFindingsPath);
    
    const prompt = `${renderPrompt(template, context)}${WORKFLOW_GUARDRAILS}`;
    const session = await dispatchStageCommand(workflow, prompt, "builder", iteration.number, builderNum);

    await ensureWorkflowPR(workflow, project, session);

    // Update state
    iteration.builderSessions[builderNum - 1] = session.id;
    iteration.status = "building";
    workflow.status = "building";
    workflow.currentBuilderIteration = Math.max(workflow.currentBuilderIteration, builderNum);
    setWorkflowIntent(workflow, "builder", iteration.number, builderNum, "running");
    persistWorkflow(project.path, workflow);

    // Update session metadata
    return session;
  }

  // =============================================================================
  // REVIEWER SPAWN
  // =============================================================================

  /**
   * Spawn reviewer
   */
  async function spawnReviewer(
    workflow: WorkflowState,
    project: ProjectConfig
  ): Promise<Session> {
    const iteration = workflow.iterations[workflow.currentIteration - 1];

    // Build prompt context
    const baseContext = buildPromptContext(config, workflow.projectId, workflow, iteration);
    
    // Fetch issue context
    let issueContext: Partial<PromptContext["issue"]> = {};
    if (project.tracker) {
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (tracker) {
        try {
          const issue = await tracker.getIssue(workflow.issueId, project);
          issueContext = {
            identifier: issue.id,
            title: issue.title,
            description: issue.description ?? "",
            url: issue.url ?? "",
          };
        } catch {}
      }
    }

    const context: PromptContext = {
      ...baseContext,
      issue: { ...baseContext.issue, ...issueContext },
    };

    // Load and render prompt
    let template = loadPromptFile(config, project, "reviewer");
    template = template
      .replace("{{requirementsPath}}", context.requirementsPath)
      .replace("{{iterationDir}}", context.iterationDir)
      .replace("{{planPath}}", iteration.planPath)
      .replace("{{progressPath}}", iteration.progressPath)
      .replace("{{orchestratorAnalysisPath}}", context.orchestratorAnalysisPath)
      .replace("{{reviewFindingsPath}}", context.reviewFindingsPath);
    const prompt = `${renderPrompt(template, context)}${WORKFLOW_GUARDRAILS}`;

    if (!existsSync(iteration.reviewFindingsPath)) {
      writeFileSync(
        iteration.reviewFindingsPath,
        `# CODE REVIEW FINDINGS - Iteration ${iteration.number}\n\n(Pending reviewer output)\n`,
        "utf-8",
      );
    }

    markWorkflowDispatchPending(project.path, workflow, "reviewer", iteration.number, 0);

    const session = await dispatchStageCommand(workflow, prompt, "reviewer", iteration.number);

    await ensureWorkflowPR(workflow, project, session);

    // Update state
    iteration.reviewerSession = session.id;
    iteration.status = "reviewing";
    workflow.status = "reviewing";
    setWorkflowIntent(workflow, "reviewer", iteration.number, 0, "running");
    persistWorkflow(project.path, workflow);

    // Update session metadata
    return session;
  }

  // =============================================================================
  // REVIEW COMPLETE
  // =============================================================================

  /**
   * Handle review completion
   */
  async function handleReviewComplete(
    workflowId: string,
    approved: boolean,
    feedback?: string
  ): Promise<void> {
    // Find the workflow
    let workflow: WorkflowState | null = null;
    let project: ProjectConfig | null = null;

    for (const [_, p] of Object.entries(config.projects)) {
      const w = loadWorkflowState(config.configPath, p.path, workflowId);
      if (w) {
        workflow = w;
        project = p;
        break;
      }
    }

    if (!workflow || !project) return;

    const iteration = workflow.iterations[workflow.currentIteration - 1];

    const taskManager = createTaskManager({ planPath: iteration.planPath });
    const tasksComplete = taskManager.allTasksComplete();
    if (approved && !tasksComplete) {
      approved = false;
      feedback =
        feedback ??
        "Review marked approved but TASK checkboxes are not complete. Builders must complete and mark PLAN.md tasks.";
    }

    if (approved) {
      // Workflow complete
      ensureProgressArtifact(iteration);

      iteration.status = "approved";
      iteration.completedAt = new Date().toISOString();
      workflow.status = "completed";
      setWorkflowIntent(workflow, "reviewer", iteration.number, 0, "completed");
      persistWorkflow(project.path, workflow);
      syncIterationArtifactsToRepo(workflow, project, iteration);
      if (!project.workflow?.iterations?.autoMergeOnApproval) {
        await transitionWorkflowCompletionArtifacts(workflow, project, iteration);
      }
      archiveWorkflowProject(workflow, project);
      await cleanupIterationSessions(workflow, iteration, { includeOwner: true });
      return;
    }

    // Check iteration limit
    if (workflow.currentIteration >= workflow.maxIterations) {
      iteration.status = "changes_requested";
      iteration.completedAt = new Date().toISOString();
      workflow.status = "failed";
      setWorkflowIntent(workflow, "reviewer", iteration.number, 0, "completed");
      persistWorkflow(project.path, workflow);
      throw new Error(`Max iterations (${workflow.maxIterations}) reached`);
    }

    // Write feedback for next iteration while preserving reviewer findings file
    iteration.status = "changes_requested";
    iteration.completedAt = new Date().toISOString();
    ensureProgressArtifact(iteration);

    // Write feedback for next iteration
    const feedbackPath = join(dirname(iteration.progressPath), "review-feedback.md");
    writeFileSync(feedbackPath, feedback ?? "Changes requested", "utf-8");

    // Cleanup completed iteration sessions before starting next one
    await cleanupIterationSessions(workflow, iteration, { includeOwner: true });

    const nextIteration = startNewIteration(
      config.configPath,
      project.path,
      workflow,
      workflow.worktreePath,
    );
    normalizeIterationArtifacts(workflow, nextIteration);
    workflow.status = "planning";
    setWorkflowIntent(workflow, "architect", nextIteration.number, 0, "pending");
    persistWorkflow(project.path, workflow);

    await dispatchArchitectForIteration(workflow, project, nextIteration);
  }

  async function reopenWorkflow(
    workflowId: string,
    reason: string,
    preferredStage: WorkflowStage = "architect",
  ): Promise<WorkflowState> {
    const { workflow, project } = loadWorkflowOrThrow(workflowId);
    rebindWorkflowArtifactsToWorktree(workflow);
    const iteration = workflow.iterations[workflow.currentIteration - 1];

    if (!iteration) {
      throw new Error(`No current iteration for workflow: ${workflowId}`);
    }

    ensureIterationArtifacts(iteration, workflow.issueId);
    await ensureWorkflowRequirementsScaffold(project.path, workflow);

    const normalizedPreferredStage = preferredStage === "reviewer" ? "architect" : preferredStage;
    const feedbackPath = join(dirname(iteration.progressPath), "review-feedback.md");

    if (workflow.status === "completed") {
      iteration.status = "changes_requested";
      iteration.completedAt = undefined;
    }

    iteration.status = normalizedPreferredStage === "builder" ? "building" : "planning";
    workflow.status = normalizedPreferredStage === "builder" ? "building" : "planning";
    workflow.ownerSessionId = "";
    workflow.currentBuilderIteration = normalizedPreferredStage === "builder" ? 1 : 0;
    workflow.lastReopenReason = reason;
    workflow.lastReopenAt = new Date().toISOString();
    setWorkflowIntent(
      workflow,
      normalizedPreferredStage,
      iteration.number,
      normalizedPreferredStage === "builder" ? 1 : 0,
      "pending",
    );

    mkdirSync(dirname(feedbackPath), { recursive: true });
    writeFileSync(feedbackPath, reason, "utf-8");
    persistWorkflow(project.path, workflow);

    const tracker = project.tracker ? registry.get<Tracker>("tracker", project.tracker.plugin) : null;
    if (tracker?.updateIssue) {
      await tracker.updateIssue(
        workflow.issueId,
        {
          labels: ["agent:in-progress"],
          removeLabels: ["agent:pending-merge", "agent:backlog"],
          comment: `Workflow reopened automatically to address follow-up feedback.\n\n${reason}`,
        },
        project,
      );
    }

    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    const prReference = workflow.artifacts.prs.at(-1);
    if (prReference && scm?.resolvePR) {
      const pr = await scm.resolvePR(prReference, project);
      if (!pr.isDraft && scm.convertPRToDraft) {
        try {
          await scm.convertPRToDraft(pr);
        } catch {
          // Best effort only.
        }
      }
    }

    return resumeWorkflow(workflowId);
  }

  async function resumeWorkflow(workflowId: string): Promise<WorkflowState> {
    const { workflow, project } = loadWorkflowOrThrow(workflowId);

    rebindWorkflowArtifactsToWorktree(workflow);
    persistWorkflow(project.path, workflow);

    const iteration = workflow.iterations[workflow.currentIteration - 1];
    if (!iteration) {
      throw new Error(`No current iteration for workflow: ${workflowId}`);
    }

    let desiredStage = workflow.desiredStage ?? (iteration.status === "reviewing" ? "reviewer" : iteration.status === "building" ? "builder" : "architect");
    let desiredIteration = workflow.desiredIteration ?? workflow.currentIteration;
    let desiredBuilderIteration = workflow.desiredBuilderIteration ?? workflow.currentBuilderIteration;

    if (
      desiredIteration !== iteration.number ||
      !stageMatchesIteration(desiredStage, iteration) ||
      (desiredStage === "builder" && desiredBuilderIteration < 1)
    ) {
      const normalizedStage = stageForIterationStatus(iteration.status);
      desiredStage = normalizedStage;
      desiredIteration = iteration.number;
      desiredBuilderIteration =
        normalizedStage === "builder" ? Math.max(workflow.currentBuilderIteration, 1) : 0;
      setWorkflowIntent(workflow, normalizedStage, desiredIteration, desiredBuilderIteration, "pending");
      persistWorkflow(project.path, workflow);
    }

    const ownerSession = await ensureOwnerSession(
      workflow,
      project,
      desiredStage,
      desiredIteration,
      desiredStage === "builder" ? desiredBuilderIteration : undefined,
    );

    if (workflow.status === "completed") {
      return workflow;
    }

    if (workflow.status === "failed" && iteration.status !== "approved") {
      workflow.status =
        iteration.status === "planning" ||
        iteration.status === "building" ||
        iteration.status === "reviewing"
          ? iteration.status
          : "building";
      persistWorkflow(project.path, workflow);
    }

    if (desiredStage === "reviewer" && iteration.status === "reviewing") {
      const verdict = getReviewVerdict(iteration);
      if (verdict === "approved") {
        await handleReviewComplete(workflowId, true, readFileSync(iteration.reviewFindingsPath, "utf-8"));
        return loadWorkflowOrThrow(workflowId).workflow;
      }
      if (verdict === "changes_requested") {
        await handleReviewComplete(workflowId, false, readFileSync(iteration.reviewFindingsPath, "utf-8"));
        return loadWorkflowOrThrow(workflowId).workflow;
      }
      if (workflow.dispatchStatus === "pending" || ownerSession.activity === "ready") {
        await spawnReviewer(workflow, project);
        return loadWorkflowOrThrow(workflowId).workflow;
      }
      return workflow;
    }

    if (desiredStage === "architect" && desiredIteration === iteration.number && iteration.status === "planning") {
      if (workflow.dispatchStatus === "pending" || !architectArtifactsReady(iteration)) {
        await dispatchArchitectForIteration(workflow, project, iteration);
        return loadWorkflowOrThrow(workflowId).workflow;
      }
      const maybeNext = await spawnNextBuilder(workflowId);
      if (maybeNext) {
        return loadWorkflowOrThrow(workflowId).workflow;
      }
      return loadWorkflowOrThrow(workflowId).workflow;
    }

    if (desiredStage === "builder" && desiredIteration === iteration.number && iteration.status === "building") {
      if (builderArtifactsReadyForAdvance(workflow, iteration, desiredBuilderIteration)) {
        const maybeNext = await spawnNextBuilder(workflowId);
        if (maybeNext) {
          return loadWorkflowOrThrow(workflowId).workflow;
        }
        return loadWorkflowOrThrow(workflowId).workflow;
      }

      if (workflow.dispatchStatus === "pending" || ownerSession.activity === "ready") {
        if (desiredBuilderIteration > 0) {
          workflow.currentBuilderIteration = Math.max(workflow.currentBuilderIteration, desiredBuilderIteration);
          persistWorkflow(project.path, workflow);
          await dispatchBuilderForIteration(
            workflow,
            project,
            iteration,
            desiredBuilderIteration,
          );
        } else {
          await spawnNextBuilder(workflowId);
        }
        return loadWorkflowOrThrow(workflowId).workflow;
      }
      return loadWorkflowOrThrow(workflowId).workflow;
    }

    return workflow;
  }

  // =============================================================================
  // HELPERS
  // =============================================================================

  function getWorkflow(projectId: string, workflowId: string): WorkflowState | null {
    const project = config.projects[projectId];
    if (!project) return null;
    return loadWorkflowState(config.configPath, project.path, workflowId);
  }

  function listWorkflows(projectId: string): WorkflowState[] {
    const project = config.projects[projectId];
    if (!project) return [];

    const workflowsDir = join(
      getProjectBaseDir(config.configPath, project.path),
      "workflows"
    );

    if (!existsSync(workflowsDir)) return [];

    const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => loadWorkflowState(config.configPath, project.path, f.replace(".json", "")))
      .filter((w): w is WorkflowState => !!w)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function killWorkflow(workflowId: string): Promise<void> {
    for (const [_, p] of Object.entries(config.projects)) {
      const w = loadWorkflowState(config.configPath, p.path, workflowId);
      if (w) {
        const sessionIds = new Set<string>();
        if (w.ownerSessionId) {
          sessionIds.add(w.ownerSessionId);
        }
        for (const iteration of w.iterations) {
          if (iteration.architectSession) {
            sessionIds.add(iteration.architectSession);
          }
          for (const sessionId of iteration.builderSessions) {
            sessionIds.add(sessionId);
          }
          if (iteration.reviewerSession) {
            sessionIds.add(iteration.reviewerSession);
          }
        }

        for (const sessionId of sessionIds) {
          try {
            await sessionManager.kill(sessionId);
          } catch {
            // best effort
          }
        }

        w.status = "failed";
        persistWorkflow(p.path, w);
        return;
      }
    }
  }

  return {
    startWorkflow,
    spawnArchitect,
    spawnNextBuilder,
    spawnReviewer,
    handleReviewComplete,
    reopenWorkflow,
    resumeWorkflow,
    getWorkflow,
    listWorkflows,
    killWorkflow,
  };
}
