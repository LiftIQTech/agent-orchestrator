# Architect-Delivery Workflow Implementation Plan (FINAL)

## The Actual Pattern (Sequential Builders)

```
1. ARCHITECT creates PLAN.md with tasks:
   - [ ] TASK-01: Description
   - [ ] TASK-02: Description
   ...

2. BUILDER LOOP (sequential, up to MAX_BUILDER_ITERATIONS):
   
   Builder 1:
   - Reads PLAN.md
   - Picks 1-3 uncompleted tasks
   - Executes them
   - Marks them: - [x] TASK-01: ...
   - Updates PROGRESS.md
   - Commits
   
   Builder 2:
   - Reads PLAN.md (sees TASK-01 done)
   - Picks remaining tasks (TASK-02, TASK-03)
   - Executes them
   - Marks them done
   - Updates PROGRESS.md
   - Commits
   
   ... continue until:
   - All tasks done → SKIP remaining builders, go to reviewer
   - OR hit MAX_BUILDER_ITERATIONS → go to reviewer anyway

3. REVIEWER reviews the PR

4. If changes requested → New iteration (back to Architect)
```

## Key Simplifications

| What I Thought | What It Actually Is |
|----------------|---------------------|
| Parallel builders | **Sequential builders** |
| Task claiming with locks | **Just pick uncompleted tasks** |
| Multiple active builders | **One builder at a time** |
| Complex coordination | **Simple loop** |

---

## Folder Structure

```
~/.agent-orchestrator/{hash}-{project}/
├── sessions/
│   ├── arch-1           # Architect session
│   ├── build-1          # Builder session 1
│   ├── build-2          # Builder session 2
│   ├── build-3          # Builder session 3
│   └── review-1         # Reviewer session
│
├── worktrees/
│   └── wf-INT-123/      # Single shared worktree
│
├── workflows/
│   └── wf-INT-123.json   # Workflow state
│
└── iterations/
    └── issue-INT-123/
        ├── 1/
        │   ├── PLAN.md
        │   └── PROGRESS.md
        └── 2/
            └── ... (if needed)
```

---

## Configuration

```yaml
projects:
  my-project:
    workflow:
      enabled: true
      prompts:
        architect: .ao/prompts/architect.md
        builder: .ao/prompts/builder.md
        reviewer: .ao/prompts/reviewer.md
      builders:
        maxIterations: 5         # Max sequential builder runs
        tasksPerBuilder: 3       # Max tasks per builder run
      iterations:
        maxIterations: 3         # Max overall iterations
```

---

## Workflow State

```json
{
  "id": "wf-INT-123",
  "issueId": "INT-123",
  "projectId": "my-project",
  "status": "building",
  "currentIteration": 1,
  "currentBuilderIteration": 2,
  "maxBuilderIterations": 5,
  "branch": "feat/INT-123",
  "worktreePath": "~/.ao/worktrees/wf-INT-123",
  
  "iterations": [{
    "number": 1,
    "status": "building",
    "planPath": "iterations/issue-INT-123/1/PLAN.md",
    "progressPath": "iterations/issue-INT-123/1/PROGRESS.md",
    "builderSessions": ["build-1", "build-2"],
    "reviewerSession": null
  }]
}
```

---

## Implementation Phases

### Phase 1: Types (0.5 days)

**File:** `packages/core/src/types.ts`

```typescript
export type WorkflowStage = "architect" | "builder" | "reviewer";
export type WorkflowStatus = "planning" | "building" | "reviewing" | "completed" | "failed";

export interface IterationState {
  number: number;
  status: "planning" | "building" | "reviewing" | "changes_requested" | "approved";
  planPath: string;
  progressPath: string;
  builderSessions: string[];
  reviewerSession?: string;
  startedAt: string;
  completedAt?: string;
}

export interface WorkflowState {
  id: string;
  issueId: string;
  projectId: string;
  status: WorkflowStatus;
  currentIteration: number;
  currentBuilderIteration: number;
  maxBuilderIterations: number;
  branch: string;
  worktreePath: string;
  iterations: IterationState[];
  artifacts: { prs: string[]; mergedPRs: string[] };
}

export interface WorkflowConfig {
  enabled: boolean;
  prompts?: { architect?: string; builder?: string; reviewer?: string };
  builders?: { maxIterations: number; tasksPerBuilder: number };
  iterations?: { maxIterations: number; autoMergeOnApproval: boolean };
}
```

---

### Phase 2: State Manager (0.5 days)

**File:** `packages/core/src/workflow-state.ts`

```typescript
// Same as before, but simpler - no parallel builder tracking

export function createWorkflowState(...): WorkflowState {
  return {
    id: workflowId,
    status: "planning",
    currentIteration: 0,
    currentBuilderIteration: 0,
    maxBuilderIterations: project.workflow?.builders?.maxIterations ?? 5,
    iterations: [],
    // ...
  };
}
```

---

### Phase 3: Task Manager (0.5 days)

**File:** `packages/core/src/task-manager.ts`

```typescript
export function createTaskManager(deps: TaskManagerDeps) {
  const planPath = getPlanPath(...);

  // Parse tasks from PLAN.md
  function parseTasks(): WorkflowTask[] {
    const content = readFileSync(planPath, "utf-8");
    const tasks: WorkflowTask[] = [];
    
    // Match: - [ ] TASK-XX: Description (pending)
    // Match: - [x] TASK-XX: Description (completed)
    for (const line of content.split("\n")) {
      if (line.match(/^- \[ \] (TASK-\d+):/)) {
        tasks.push({ id: match[1], status: "pending", ... });
      }
      if (line.match(/^- \[x\] (TASK-\d+):/)) {
        tasks.push({ id: match[1], status: "completed", ... });
      }
    }
    return tasks;
  }

  // Get uncompleted tasks
  function getPendingTasks(): WorkflowTask[] {
    return parseTasks().filter(t => t.status === "pending");
  }

  // Check if all done
  function allTasksComplete(): boolean {
    const tasks = parseTasks();
    return tasks.length > 0 && tasks.every(t => t.status === "completed");
  }

  // Mark task complete
  function markTaskComplete(taskId: string): void {
    let content = readFileSync(planPath, "utf-8");
    content = content.replace(
      new RegExp(`^- \\[ \\] ${taskId}:`, "gm"),
      `- [x] ${taskId}:`
    );
    writeFileSync(planPath, content, "utf-8");
  }

  return { parseTasks, getPendingTasks, allTasksComplete, markTaskComplete };
}
```

---

### Phase 4: Workflow Manager (1 day)

**File:** `packages/core/src/workflow-manager.ts`

```typescript
export function createWorkflowManager(deps: WorkflowManagerDeps) {
  const { config, registry, sessionManager } = deps;

  /**
   * Start workflow - spawn architect
   */
  async function startWorkflow(projectId: string, issueId: string): Promise<WorkflowState> {
    const project = config.projects[projectId];
    const branch = `feat/${issueId}`;
    
    // Create workflow state
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
    
    // Start first iteration with architect
    await spawnArchitect(workflow);
    
    return workflow;
  }

  /**
   * Spawn architect to create PLAN.md
   */
  async function spawnArchitect(workflow: WorkflowState): Promise<void> {
    const project = config.projects[workflow.projectId];
    
    // Create new iteration
    const iteration = startNewIteration(config.configPath, project.path, workflow);
    
    // Spawn architect
    const prompt = renderPrompt(loadPromptFile(config, project, "architect"), context);
    await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "architect",
    });
    
    workflow.status = "planning";
    workflow.currentBuilderIteration = 0;
    saveWorkflowState(config.configPath, project.path, workflow);
  }

  /**
   * Spawn next builder (sequential)
   */
  async function spawnNextBuilder(workflowId: string): Promise<void> {
    const { workflow, project } = loadWorkflow(config, workflowId);
    const iteration = workflow.iterations[workflow.currentIteration - 1];
    
    // Check if we've hit max builder iterations
    if (workflow.currentBuilderIteration >= workflow.maxBuilderIterations) {
      // Done with builders, spawn reviewer
      await spawnReviewer(workflow);
      return;
    }
    
    // Check if all tasks done
    const taskManager = createTaskManager({
      configPath: config.configPath,
      projectPath: project.path,
      issueId: workflow.issueId,
      iteration: iteration.number,
    });
    
    if (taskManager.allTasksComplete()) {
      // All done, skip remaining builders
      await spawnReviewer(workflow);
      return;
    }
    
    // Spawn next builder
    workflow.currentBuilderIteration++;
    const builderNum = workflow.currentBuilderIteration;
    
    const prompt = renderPrompt(loadPromptFile(config, project, "builder"), {
      ...context,
      builderIteration: builderNum,
    });
    
    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "builder",
    });
    
    iteration.builderSessions.push(session.id);
    workflow.status = "building";
    saveWorkflowState(config.configPath, project.path, workflow);
  }

  /**
   * Spawn reviewer
   */
  async function spawnReviewer(workflow: WorkflowState): Promise<void> {
    const project = config.projects[workflow.projectId];
    const iteration = workflow.iterations[workflow.currentIteration - 1];
    
    const prompt = renderPrompt(loadPromptFile(config, project, "reviewer"), context);
    
    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "reviewer",
    });
    
    iteration.reviewerSession = session.id;
    workflow.status = "reviewing";
    saveWorkflowState(config.configPath, project.path, workflow);
  }

  /**
   * Handle review complete
   */
  async function handleReviewComplete(
    workflowId: string, 
    approved: boolean, 
    feedback?: string
  ): Promise<void> {
    const { workflow, project } = loadWorkflow(config, workflowId);
    const iteration = workflow.iterations[workflow.currentIteration - 1];
    
    if (approved) {
      workflow.status = "completed";
      saveWorkflowState(config.configPath, project.path, workflow);
      return;
    }
    
    // Check max iterations
    if (workflow.currentIteration >= (project.workflow?.iterations?.maxIterations ?? 3)) {
      workflow.status = "failed";
      saveWorkflowState(config.configPath, project.path, workflow);
      throw new Error("Max iterations reached");
    }
    
    // Start new iteration with architect
    await spawnArchitect(workflow);
  }

  return {
    startWorkflow,
    spawnArchitect,
    spawnNextBuilder,
    spawnReviewer,
    handleReviewComplete,
  };
}
```

---

### Phase 5: Lifecycle Integration (0.5 days)

**File:** `packages/core/src/lifecycle-manager.ts`

```typescript
// In checkSession:

if (session.metadata["workflowId"] && session.metadata["workflowStage"]) {
  const stage = session.metadata["workflowStage"];
  
  if (stage === "architect" && sessionDone) {
    // Architect done, start first builder
    await workflowManager.spawnNextBuilder(workflowId);
  }
  
  if (stage === "builder" && sessionDone) {
    // Builder done, spawn next builder (or reviewer if all done)
    await workflowManager.spawnNextBuilder(workflowId);
  }
  
  if (stage === "reviewer" && sessionDone) {
    if (approved) {
      await workflowManager.handleReviewComplete(workflowId, true);
    } else {
      await workflowManager.handleReviewComplete(workflowId, false, feedback);
    }
  }
}
```

---

### Phase 6: CLI (0.5 days)

Same as before.

---

## Summary

| Phase | Duration |
|-------|----------|
| 1. Types | 0.5 days |
| 2. State Manager | 0.5 days |
| 3. Task Manager | 0.5 days |
| 4. Workflow Manager | 1 day |
| 5. Lifecycle | 0.5 days |
| 6. CLI | 0.5 days |
| **Total** | **3.5 days** |

### Key Simplifications

1. **Sequential builders** - No parallel coordination needed
2. **Simple task check** - Just look for `- [ ]` vs `- [x]`
3. **Loop until done** - Keep spawning builders until tasks done or max hit
4. **No task claiming** - Builders just pick uncompleted tasks

Much simpler than my parallel version!
