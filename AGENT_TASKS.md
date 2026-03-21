# Agent Tasks: Architect-Delivery Workflow (SEQUENTIAL Builders)

## The Actual Pattern

```
1. ARCHITECT creates PLAN.md:
   - [ ] TASK-01: Implement auth
   - [ ] TASK-02: Add tests
   - [ ] TASK-03: Update docs
   ... (5-8 tasks)

2. BUILDER LOOP (sequential):
   
   for i = 1 to MAX_BUILDER_ITERATIONS (e.g., 5):
     if all tasks checked in PLAN.md:
       break  # Skip remaining builders
     
     spawn Builder i
     Builder reads PLAN.md
     Builder picks uncompleted tasks (e.g., TASK-01, TASK-02)
     Builder executes tasks
     Builder marks them done: - [x] TASK-01: ...
     Builder updates PROGRESS.md
     Builder commits

3. REVIEWER reviews the PR

4. If changes requested → New iteration (back to Architect)
```

---

## BATCH 1: Types (0.5 days)

**File:** `packages/core/src/types.ts`

Add after `SessionMetadata` interface:

```typescript
// =============================================================================
// WORKFLOW TYPES
// =============================================================================

export type WorkflowStage = "architect" | "builder" | "reviewer";

export type WorkflowStatus = 
  | "planning"      // Architect working
  | "building"      // Builders working (sequential)
  | "reviewing"     // Reviewer working
  | "completed" 
  | "failed";

export type TaskStatus = "pending" | "completed";

export interface WorkflowTask {
  id: string;              // TASK-01, TASK-02
  description: string;
  status: TaskStatus;
}

export interface IterationState {
  number: number;
  status: "planning" | "building" | "reviewing" | "changes_requested" | "approved";
  startedAt: string;
  completedAt?: string;
  planPath: string;
  progressPath: string;
  architectSession?: string;
  builderSessions: string[];  // Sequential: [build-1, build-2, ...]
  reviewerSession?: string;
}

export interface WorkflowState {
  id: string;                    // wf-INT-123
  issueId: string;               // INT-123
  projectId: string;
  status: WorkflowStatus;
  currentIteration: number;
  maxIterations: number;
  currentBuilderIteration: number;  // 1, 2, 3... within current iteration
  maxBuilderIterations: number;     // e.g., 5
  branch: string;
  worktreePath: string;
  iterations: IterationState[];
  artifacts: {
    prs: string[];
    mergedPRs: string[];
  };
}

export interface WorkflowConfig {
  enabled: boolean;
  prompts?: {
    architect?: string;
    builder?: string;
    reviewer?: string;
  };
  builders?: {
    maxIterations: number;       // Default: 5
    tasksPerBuilder: number;    // Default: 3
  };
  iterations?: {
    maxIterations: number;       // Default: 3
    autoMergeOnApproval: boolean;
  };
}

// Add to ProjectConfig
export interface ProjectConfig {
  // ... existing fields ...
  workflow?: WorkflowConfig;
}

// Add to SessionSpawnConfig
export interface SessionSpawnConfig {
  // ... existing fields ...
  workflowId?: string;
  workflowStage?: WorkflowStage;
  workflowIteration?: number;
  builderIteration?: number;  // Which builder number (1, 2, 3...)
}
```

**Validation:** `pnpm tsc --noEmit`

---

## BATCH 2: State Manager (0.5 days)

**File:** `packages/core/src/workflow-state.ts`

```typescript
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { OrchestratorConfig, ProjectConfig, WorkflowState, IterationState } from "./types.js";
import { getProjectBaseDir } from "./paths.js";
import { safeJsonParse } from "./utils/validation.js";

export function getWorkflowsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "workflows");
}

export function getIterationsBaseDir(configPath: string, projectPath: string, issueId: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "iterations", `issue-${issueId}`);
}

export function getPlanPath(configPath: string, projectPath: string, issueId: string, iteration: number): string {
  return join(getIterationsBaseDir(configPath, projectPath, issueId), String(iteration), "PLAN.md");
}

export function getProgressPath(configPath: string, projectPath: string, issueId: string, iteration: number): string {
  return join(getIterationsBaseDir(configPath, projectPath, issueId), String(iteration), "PROGRESS.md");
}

export function createWorkflowState(
  configPath: string,
  project: ProjectConfig,
  projectId: string,
  issueId: string,
  branch: string
): WorkflowState {
  const maxIterations = project.workflow?.iterations?.maxIterations ?? 3;
  const maxBuilderIterations = project.workflow?.builders?.maxIterations ?? 5;
  
  return {
    id: `wf-${issueId}`,
    issueId,
    projectId,
    status: "planning",
    currentIteration: 0,
    maxIterations,
    currentBuilderIteration: 0,
    maxBuilderIterations,
    branch,
    worktreePath: "",
    iterations: [],
    artifacts: { prs: [], mergedPRs: [] },
  };
}

export function saveWorkflowState(configPath: string, projectPath: string, state: WorkflowState): void {
  const dir = getWorkflowsDir(configPath, projectPath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${state.id}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export function loadWorkflowState(configPath: string, projectPath: string, workflowId: string): WorkflowState | null {
  const path = join(getWorkflowsDir(configPath, projectPath), `${workflowId}.json`);
  if (!existsSync(path)) return null;
  try {
    return safeJsonParse<WorkflowState>(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
```

---

## BATCH 3: Task Manager (0.5 days)

**File:** `packages/core/src/task-manager.ts`

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { WorkflowTask, TaskStatus } from "./types.js";

export interface TaskManagerDeps {
  planPath: string;
}

export function createTaskManager(deps: TaskManagerDeps) {
  const { planPath } = deps;

  /**
   * Parse tasks from PLAN.md
   * Format: - [ ] TASK-XX: Description (pending)
   *         - [x] TASK-XX: Description (completed)
   */
  function parseTasks(): WorkflowTask[] {
    if (!existsSync(planPath)) return [];

    const content = readFileSync(planPath, "utf-8");
    const tasks: WorkflowTask[] = [];

    for (const line of content.split("\n")) {
      // Pending: - [ ] TASK-01: Description
      const pending = line.match(/^- \[ \] (TASK-\d+):\s*(.+)$/);
      if (pending) {
        tasks.push({ id: pending[1], description: pending[2].trim(), status: "pending" });
        continue;
      }

      // Completed: - [x] TASK-01: Description
      const done = line.match(/^- \[x\] (TASK-\d+):\s*(.+)$/);
      if (done) {
        tasks.push({ id: done[1], description: done[2].trim(), status: "completed" });
      }
    }

    return tasks;
  }

  /**
   * Get pending (uncompleted) tasks
   */
  function getPendingTasks(): WorkflowTask[] {
    return parseTasks().filter(t => t.status === "pending");
  }

  /**
   * Check if all tasks are complete
   */
  function allTasksComplete(): boolean {
    const tasks = parseTasks();
    // No tasks OR all completed
    return tasks.length === 0 || tasks.every(t => t.status === "completed");
  }

  /**
   * Count remaining tasks
   */
  function getRemainingCount(): number {
    return getPendingTasks().length;
  }

  /**
   * Mark a task as complete in PLAN.md
   */
  function markComplete(taskId: string): void {
    let content = readFileSync(planPath, "utf-8");
    // Replace: - [ ] TASK-XX: with: - [x] TASK-XX:
    const regex = new RegExp(`^- \\[ \\] ${taskId}:`, "gm");
    content = content.replace(regex, `- [x] ${taskId}:`);
    writeFileSync(planPath, content, "utf-8");
  }

  return {
    parseTasks,
    getPendingTasks,
    allTasksComplete,
    getRemainingCount,
    markComplete,
  };
}

export type TaskManager = ReturnType<typeof createTaskManager>;
```

---

## BATCH 4: Workflow Manager (1 day)

**File:** `packages/core/src/workflow-manager.ts`

```typescript
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  OrchestratorConfig,
  ProjectConfig,
  WorkflowState,
  IterationState,
  Session,
  SessionManager,
  PluginRegistry,
} from "./types.js";
import {
  createWorkflowState,
  loadWorkflowState,
  saveWorkflowState,
  getPlanPath,
  getProgressPath,
} from "./workflow-state.js";
import { createTaskManager } from "./task-manager.js";
import { loadPromptFile, buildPromptContext, renderPrompt } from "./prompt-loader.js";

export interface WorkflowManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

export function createWorkflowManager(deps: WorkflowManagerDeps) {
  const { config, registry, sessionManager } = deps;

  /**
   * Start a new workflow
   */
  async function startWorkflow(projectId: string, issueId: string): Promise<WorkflowState> {
    const project = config.projects[projectId];
    if (!project) throw new Error(`Unknown project: ${projectId}`);

    const branch = `feat/${issueId}`;
    const workflow = createWorkflowState(config.configPath, project, projectId, issueId, branch);

    // Create worktree
    const session = await sessionManager.spawn({
      projectId,
      issueId,
      branch,
      workflowId: workflow.id,
    });
    workflow.worktreePath = session.workspacePath ?? "";
    saveWorkflowState(config.configPath, project.path, workflow);

    // Spawn architect for iteration 1
    await spawnArchitect(workflow);

    return workflow;
  }

  /**
   * Spawn architect for new iteration
   */
  async function spawnArchitect(workflow: WorkflowState): Promise<Session> {
    const project = config.projects[workflow.projectId];
    
    // Create new iteration
    const iterationNum = workflow.currentIteration + 1;
    const iteration: IterationState = {
      number: iterationNum,
      status: "planning",
      startedAt: new Date().toISOString(),
      planPath: getPlanPath(config.configPath, project.path, workflow.issueId, iterationNum),
      progressPath: getProgressPath(config.configPath, project.path, workflow.issueId, iterationNum),
      builderSessions: [],
    };

    workflow.iterations.push(iteration);
    workflow.currentIteration = iterationNum;
    workflow.currentBuilderIteration = 0;
    workflow.status = "planning";

    // Create iteration folder and files
    mkdirSync(dirname(iteration.planPath), { recursive: true });
    writeFileSync(iteration.planPath, "# PLAN\n\n(Architect will add tasks)\n", "utf-8");
    writeFileSync(iteration.progressPath, "# Progress\n\n", "utf-8");

    // Spawn architect
    const prompt = renderPrompt(
      loadPromptFile(config, project, "architect"),
      buildPromptContext(config, workflow.projectId, workflow, iteration)
    );

    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "architect",
      workflowIteration: iterationNum,
    });

    iteration.architectSession = session.id;
    saveWorkflowState(config.configPath, project.path, workflow);

    return session;
  }

  /**
   * Spawn next builder in sequence
   */
  async function spawnNextBuilder(workflowId: string): Promise<Session | null> {
    const project = Object.values(config.projects).find(p => 
      loadWorkflowState(config.configPath, p.path, workflowId)?.id === workflowId
    );
    if (!project) throw new Error(`Workflow not found: ${workflowId}`);

    const workflow = loadWorkflowState(config.configPath, project.path, workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

    const iteration = workflow.iterations[workflow.currentIteration - 1];

    // Check if all tasks done
    const taskManager = createTaskManager({ planPath: iteration.planPath });
    if (taskManager.allTasksComplete()) {
      // All done, spawn reviewer
      return spawnReviewer(workflow);
    }

    // Check builder limit
    if (workflow.currentBuilderIteration >= workflow.maxBuilderIterations) {
      // Hit limit, spawn reviewer anyway
      return spawnReviewer(workflow);
    }

    // Spawn next builder
    workflow.currentBuilderIteration++;
    const builderNum = workflow.currentBuilderIteration;

    const prompt = renderPrompt(
      loadPromptFile(config, project, "builder"),
      buildPromptContext(config, workflow.projectId, workflow, iteration, { builderNum })
    );

    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: iteration.number,
      builderIteration: builderNum,
    });

    iteration.builderSessions.push(session.id);
    workflow.status = "building";
    saveWorkflowState(config.configPath, project.path, workflow);

    return session;
  }

  /**
   * Spawn reviewer
   */
  async function spawnReviewer(workflow: WorkflowState): Promise<Session> {
    const project = config.projects[workflow.projectId];
    const iteration = workflow.iterations[workflow.currentIteration - 1];

    const prompt = renderPrompt(
      loadPromptFile(config, project, "reviewer"),
      buildPromptContext(config, workflow.projectId, workflow, iteration)
    );

    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "reviewer",
      workflowIteration: iteration.number,
    });

    iteration.reviewerSession = session.id;
    iteration.status = "reviewing";
    workflow.status = "reviewing";
    saveWorkflowState(config.configPath, project.path, workflow);

    return session;
  }

  /**
   * Handle review complete
   */
  async function handleReviewComplete(
    workflowId: string,
    approved: boolean,
    feedback?: string
  ): Promise<void> {
    const project = Object.values(config.projects).find(p => 
      loadWorkflowState(config.configPath, p.path, workflowId)?.id === workflowId
    );
    if (!project) return;

    const workflow = loadWorkflowState(config.configPath, project.path, workflowId);
    if (!workflow) return;

    const iteration = workflow.iterations[workflow.currentIteration - 1];

    if (approved) {
      iteration.status = "approved";
      iteration.completedAt = new Date().toISOString();
      workflow.status = "completed";
      saveWorkflowState(config.configPath, project.path, workflow);
      return;
    }

    // Check iteration limit
    if (workflow.currentIteration >= workflow.maxIterations) {
      workflow.status = "failed";
      saveWorkflowState(config.configPath, project.path, workflow);
      throw new Error(`Max iterations (${workflow.maxIterations}) reached`);
    }

    // Write feedback
    const feedbackPath = join(dirname(iteration.progressPath), "review-feedback.md");
    writeFileSync(feedbackPath, feedback ?? "Changes requested", "utf-8");

    // Start new iteration with architect
    await spawnArchitect(workflow);
  }

  /**
   * Write progress entry
   */
  function writeProgressEntry(
    workflowId: string,
    builderNum: number,
    entry: { tasksCompleted: string[]; summary: string; commitHash?: string }
  ): void {
    const project = Object.values(config.projects).find(p => 
      loadWorkflowState(config.configPath, p.path, workflowId)?.id === workflowId
    );
    if (!project) return;

    const workflow = loadWorkflowState(config.configPath, project.path, workflowId);
    if (!workflow) return;

    const iteration = workflow.iterations[workflow.currentIteration - 1];
    const timestamp = new Date().toISOString();

    const content = `

## Builder ${builderNum} (${timestamp})

### Tasks Completed
${entry.tasksCompleted.map(t => `- [x] ${t}`).join("\n") || "(none)"}

### Summary
${entry.summary}

${entry.commitHash ? `**Commit:** \`${entry.commitHash}\`` : ""}

---
`;

    appendFileSync(iteration.progressPath, content, "utf-8");
  }

  return {
    startWorkflow,
    spawnArchitect,
    spawnNextBuilder,
    spawnReviewer,
    handleReviewComplete,
    writeProgressEntry,
  };
}

export type WorkflowManager = ReturnType<typeof createWorkflowManager>;
```

---

## BATCH 5: Lifecycle Integration (0.5 days)

**File:** `packages/core/src/lifecycle-manager.ts`

Add in `checkSession` function:

```typescript
// Check for workflow stage completion
if (session.metadata["workflowId"] && session.metadata["workflowStage"]) {
  const workflowId = session.metadata["workflowId"];
  const stage = session.metadata["workflowStage"] as WorkflowStage;

  // Architect done → spawn first builder
  if (stage === "architect" && to !== "spawning" && to !== "running") {
    await workflowManager.spawnNextBuilder(workflowId);
  }

  // Builder done → spawn next builder or reviewer
  if (stage === "builder" && to !== "spawning" && to !== "running") {
    await workflowManager.spawnNextBuilder(workflowId);
  }

  // Reviewer done → handle approval/rejection
  if (stage === "reviewer" && to !== "spawning" && to !== "running") {
    const approved = (to === "approved" || to === "mergeable");
    const feedback = /* extract from PR */;
    await workflowManager.handleReviewComplete(workflowId, approved, feedback);
  }
}
```

---

## BATCH 6: CLI (0.5 days)

Same structure as before, just simpler commands.

---

## Summary

| Phase | Duration | Key Work |
|-------|----------|----------|
| 1. Types | 0.5 days | WorkflowState with builder iteration tracking |
| 2. State Manager | 0.5 days | Save/load workflow JSON |
| 3. Task Manager | 0.5 days | Parse PLAN.md, check `- [ ]` vs `- [x]` |
| 4. Workflow Manager | 1 day | Sequential builder spawning loop |
| 5. Lifecycle | 0.5 days | Detect stage completion |
| 6. CLI | 0.5 days | User commands |
| **Total** | **3.5 days** |

### Key Simplifications

1. **Sequential builders** - One at a time, no coordination needed
2. **Simple task status** - Just `- [ ]` vs `- [x]` in PLAN.md
3. **Loop until done** - Keep spawning builders until all tasks checked or max hit
4. **No claiming** - Builders just look for unchecked tasks
