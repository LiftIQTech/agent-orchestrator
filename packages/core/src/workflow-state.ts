/**
 * Workflow State Manager — persistence for architect-delivery workflows.
 *
 * Manages workflow state files that track:
 * - Current iteration and builder progress
 * - Task completion status (via PLAN.md)
 * - Session associations
 */

import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import type {
  OrchestratorConfig,
  ProjectConfig,
  WorkflowState,
  IterationState,
} from "./types.js";
import { getProjectBaseDir } from "./paths.js";
import { safeJsonParse } from "./utils/validation.js";

// =============================================================================
// PATH HELPERS
// =============================================================================

export function getWorkflowsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "workflows");
}

export function getIterationsBaseDir(
  configPath: string,
  projectPath: string,
  issueId: string,
  worktreePath?: string
): string {
  return join(getProjectRootDir(configPath, projectPath, issueId, worktreePath), "iterations");
}

export function getProjectRootDir(
  configPath: string,
  projectPath: string,
  issueId: string,
  worktreePath?: string
): string {
  if (worktreePath && worktreePath.length > 0) {
    return join(worktreePath, ".architect-delivery", "projects", `issue-${issueId}`);
  }
  return join(getProjectBaseDir(configPath, projectPath), "projects", `issue-${issueId}`);
}

export function getIterationDir(
  configPath: string,
  projectPath: string,
  issueId: string,
  iteration: number,
  worktreePath?: string
): string {
  return join(
    getIterationsBaseDir(configPath, projectPath, issueId, worktreePath),
    `iteration-${String(iteration).padStart(3, "0")}`,
  );
}

export function getWorkflowStatePath(
  configPath: string,
  projectPath: string,
  workflowId: string
): string {
  return join(getWorkflowsDir(configPath, projectPath), `${workflowId}.json`);
}

export function getPlanPath(
  configPath: string,
  projectPath: string,
  issueId: string,
  iteration: number,
  worktreePath?: string
): string {
  return join(getIterationDir(configPath, projectPath, issueId, iteration, worktreePath), "PLAN.md");
}

export function getProgressPath(
  configPath: string,
  projectPath: string,
  issueId: string,
  iteration: number,
  worktreePath?: string
): string {
  return join(getIterationDir(configPath, projectPath, issueId, iteration, worktreePath), "PROGRESS.md");
}

export function getOrchestratorAnalysisPath(
  configPath: string,
  projectPath: string,
  issueId: string,
  iteration: number,
  worktreePath?: string
): string {
  return join(
    getIterationDir(configPath, projectPath, issueId, iteration, worktreePath),
    "orchestrator-analysis.md",
  );
}

export function getReviewFindingsPath(
  configPath: string,
  projectPath: string,
  issueId: string,
  iteration: number,
  worktreePath?: string
): string {
  return join(
    getIterationDir(configPath, projectPath, issueId, iteration, worktreePath),
    "CODE_REVIEW_FINDINGS.md",
  );
}

export function getRequirementsPath(
  configPath: string,
  projectPath: string,
  issueId: string,
  worktreePath?: string
): string {
  return join(getProjectRootDir(configPath, projectPath, issueId, worktreePath), "requirements.md");
}

export function generateWorkflowId(issueId: string): string {
  return `wf-${issueId}`;
}

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

export function createWorkflowState(
  configPath: string,
  project: ProjectConfig,
  projectId: string,
  issueId: string,
  branch: string,
  baseBranch?: string
): WorkflowState {
  const workflowId = generateWorkflowId(issueId);
  const maxIterations = project.workflow?.iterations?.maxIterations ?? 30;
  const maxBuilderIterations = project.workflow?.builders?.maxIterations ?? 5;
  const now = new Date().toISOString();

  const state: WorkflowState = {
    id: workflowId,
    issueId,
    projectId,
    status: "pending",
    desiredStage: "architect",
    desiredIteration: 1,
    desiredBuilderIteration: 0,
    dispatchStatus: "pending",
    dispatchStartedAt: now,
    lastStageActivityAt: now,
    currentIteration: 0,
    maxIterations,
    currentBuilderIteration: 0,
    maxBuilderIterations,
    branch,
    baseBranch: baseBranch ?? project.defaultBranch,
    worktreePath: "",
    ownerSessionId: "",
    createdAt: now,
    updatedAt: now,
    iterations: [],
    artifacts: {
      prs: [],
      mergedPRs: [],
    },
  };

  // Create directories
  const workflowsDir = getWorkflowsDir(configPath, project.path);
  const projectRootDir = getProjectRootDir(configPath, project.path, issueId);
  const iterationsDir = getIterationsBaseDir(configPath, project.path, issueId);
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(projectRootDir, { recursive: true });
  mkdirSync(iterationsDir, { recursive: true });

  saveWorkflowState(configPath, project.path, state);

  return state;
}

export function loadWorkflowState(
  configPath: string,
  projectPath: string,
  workflowId: string
): WorkflowState | null {
  const path = getWorkflowStatePath(configPath, projectPath, workflowId);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const state = safeJsonParse<WorkflowState>(raw);
    if (!state) return null;
    if (!state.baseBranch || state.baseBranch.length === 0) {
      state.baseBranch = state.branch;
    }
    if (!state.ownerSessionId) {
      state.ownerSessionId = "";
    }
    if (!state.desiredStage) {
      state.desiredStage = state.status === "reviewing" ? "reviewer" : state.status === "building" ? "builder" : "architect";
    }
    if (!state.desiredIteration || state.desiredIteration < 1) {
      state.desiredIteration = state.currentIteration > 0 ? state.currentIteration : 1;
    }
    if (state.desiredBuilderIteration === undefined || state.desiredBuilderIteration < 0) {
      state.desiredBuilderIteration = state.currentBuilderIteration > 0 ? state.currentBuilderIteration : 0;
    }
    if (!state.dispatchStatus) {
      state.dispatchStatus = state.status === "completed" || state.status === "failed" ? "completed" : "pending";
    }
    if (!state.dispatchStartedAt) {
      state.dispatchStartedAt = state.updatedAt ?? new Date().toISOString();
    }
    if (!state.lastStageActivityAt) {
      state.lastStageActivityAt = state.dispatchStartedAt;
    }
    state.iterations = state.iterations.map((iteration) => {
      const iterNum = iteration.number;
      const iterationDir = iteration.iterationDir ?? getIterationDir(configPath, projectPath, state.issueId, iterNum);
      return {
        ...iteration,
        iterationDir,
        planPath: iteration.planPath ?? join(iterationDir, "PLAN.md"),
        progressPath: iteration.progressPath ?? join(iterationDir, "PROGRESS.md"),
        orchestratorAnalysisPath:
          iteration.orchestratorAnalysisPath ?? join(iterationDir, "orchestrator-analysis.md"),
        reviewFindingsPath:
          iteration.reviewFindingsPath ?? join(iterationDir, "CODE_REVIEW_FINDINGS.md"),
      };
    });
    return state;
  } catch {
    return null;
  }
}

export function saveWorkflowState(
  configPath: string,
  projectPath: string,
  state: WorkflowState
): void {
  const path = getWorkflowStatePath(configPath, projectPath, state.id);
  const dir = dirname(path);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  state.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export function findWorkflowByIssue(
  config: OrchestratorConfig,
  issueId: string
): { workflow: WorkflowState; project: ProjectConfig; projectId: string } | null {
  for (const [projectId, project] of Object.entries(config.projects)) {
    const workflowId = generateWorkflowId(issueId);
    const workflow = loadWorkflowState(config.configPath, project.path, workflowId);
    if (workflow) {
      return { workflow, project, projectId };
    }
  }
  return null;
}

// =============================================================================
// ITERATION MANAGEMENT
// =============================================================================

export function startNewIteration(
  configPath: string,
  projectPath: string,
  workflow: WorkflowState,
  worktreePath?: string
): IterationState {
  const iterationNum = workflow.currentIteration + 1;
  const now = new Date().toISOString();

  const iteration: IterationState = {
    number: iterationNum,
    status: "planning",
    startedAt: now,
    iterationDir: getIterationDir(configPath, projectPath, workflow.issueId, iterationNum, worktreePath),
    planPath: getPlanPath(configPath, projectPath, workflow.issueId, iterationNum, worktreePath),
    progressPath: getProgressPath(configPath, projectPath, workflow.issueId, iterationNum, worktreePath),
    orchestratorAnalysisPath: getOrchestratorAnalysisPath(
      configPath,
      projectPath,
      workflow.issueId,
      iterationNum,
      worktreePath,
    ),
    reviewFindingsPath: getReviewFindingsPath(
      configPath,
      projectPath,
      workflow.issueId,
      iterationNum,
      worktreePath,
    ),
    builderSessions: [],
  };

  workflow.iterations.push(iteration);
  workflow.currentIteration = iterationNum;
  workflow.currentBuilderIteration = 0;

  // Create iteration directory
  const iterDir = iteration.iterationDir;
  mkdirSync(iterDir, { recursive: true });

  const currentPointer = join(
    getIterationsBaseDir(configPath, projectPath, workflow.issueId, worktreePath),
    ".current",
  );
  writeFileSync(currentPointer, String(iterationNum), "utf-8");

  saveWorkflowState(configPath, projectPath, workflow);

  return iteration;
}
