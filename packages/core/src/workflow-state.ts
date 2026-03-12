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
  issueId: string
): string {
  return join(getProjectBaseDir(configPath, projectPath), "iterations", `issue-${issueId}`);
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
  iteration: number
): string {
  return join(getIterationsBaseDir(configPath, projectPath, issueId), String(iteration), "PLAN.md");
}

export function getProgressPath(
  configPath: string,
  projectPath: string,
  issueId: string,
  iteration: number
): string {
  return join(getIterationsBaseDir(configPath, projectPath, issueId), String(iteration), "PROGRESS.md");
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
  branch: string
): WorkflowState {
  const workflowId = generateWorkflowId(issueId);
  const maxIterations = project.workflow?.iterations?.maxIterations ?? 3;
  const maxBuilderIterations = project.workflow?.builders?.maxIterations ?? 5;
  const now = new Date().toISOString();

  const state: WorkflowState = {
    id: workflowId,
    issueId,
    projectId,
    status: "pending",
    currentIteration: 0,
    maxIterations,
    currentBuilderIteration: 0,
    maxBuilderIterations,
    branch,
    worktreePath: "",
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
  const iterationsDir = getIterationsBaseDir(configPath, project.path, issueId);
  mkdirSync(workflowsDir, { recursive: true });
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
    return safeJsonParse<WorkflowState>(raw);
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
  workflow: WorkflowState
): IterationState {
  const iterationNum = workflow.currentIteration + 1;
  const now = new Date().toISOString();

  const iteration: IterationState = {
    number: iterationNum,
    status: "planning",
    startedAt: now,
    planPath: getPlanPath(configPath, projectPath, workflow.issueId, iterationNum),
    progressPath: getProgressPath(configPath, projectPath, workflow.issueId, iterationNum),
    builderSessions: [],
  };

  workflow.iterations.push(iteration);
  workflow.currentIteration = iterationNum;
  workflow.currentBuilderIteration = 0;
  saveWorkflowState(configPath, projectPath, workflow);

  // Create iteration directory
  const iterDir = dirname(iteration.planPath);
  mkdirSync(iterDir, { recursive: true });

  return iteration;
}
