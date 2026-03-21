# Architect-Delivery Workflow Implementation Plan (Revised)

## Overview

This plan implements the iterative workflow pattern within agent-orchestrator that supports:
- **Architect** → Analyzes requirements, creates PLAN.md, reviews previous iteration
- **Builder** → Implements the current iteration's plan
- **Reviewer** → Reviews the implementation, provides feedback

- **Iterations** → Cycle continues until approved or max iterations reached

Each issue gets **ONE worktree** and its own branch. All agents for an issue work in the same workspace directory, with context from previous iterations.

---

## Key Simplifications from Original Plan

| Original | Revised |
|----------|---------|
| Parallel builders | **Single builder per iteration** |
| Multiple worktrees per task | **Single worktree per issue** |
| Decomposition tree | **Sequential iterations** |
| Complex workflow engine | **Stage state machine only** |

---

## Folder Structure

```
~/.agent-orchestrator/
├── {hash}-{project}/
│   ├── sessions/
│   │   ├── arch-1           # Architect session (iteration 1)
│   │   ├── build-1           # Builder session (iteration 1)
│   │   ├── rev-1             # Review session (iteration 1)
│   │   ├── arch-2           # Architect session (iteration 2)
│   │   ├── build-2           # Builder session (iteration 2)
│   │   ├── rev-2             # Review session (iteration 2)
│   │   └── wf-INT-123-orchestrator  # Workflow orchestrator
│   │
│   ├── worktrees/
│   │   └── wf-INT-123/           # ONE worktree per workflow
│   │
│   ├── iterations/
│   │   └── issue-INT-123/
│   │       ├── plan.md           # Current iteration plan
│   │       ├── 1/
│   │       │   ├── analysis.md
│   │       │   ├── plan.md
│   │       │   ├── build-summary.md
│   │       │   └── review-feedback.md
│   │       └── 2/
│   │           └── ... (if needed)
│   │
│   └── workflows/
│       └── wf-INT-123.json   # Workflow state
│
└── prompts/
    ├── architect.md
    ├── builder.md
    └── reviewer.md

{project-root}/
└── .ao/
    └── prompts/             # Project-specific overrides
        ├── architect.md
        ├── builder.md
        └── reviewer.md
```

---

## Configuration Schema

### agent-orchestrator.yaml

```yaml
defaults:
  runtime: tmux
  agent: opencode
  workspace: worktree
  notifiers: [desktop]

projects:
  my-project:
    repo: owner/my-repo
    path: ~/repos/my-project
    defaultBranch: main
    sessionPrefix: mp
    
    # Enable workflow
    workflow:
      enabled: true
      type: architect-delivery
      
      # Prompt file paths (relative to project or absolute)
      prompts:
        architect: .ao/prompts/architect.md
        builder: .ao/prompts/builder.md
        reviewer: .ao/prompts/reviewer.md
      
      # Iteration settings
      iterations:
        maxIterations: 3
        autoMergeOnApproval: true
        notifyOnMaxIterations: true
      
      # Stage timeouts
      timeouts:
        architect: 30m
        builder: 2h
        reviewer: 1h
```

### Workflow State File (wf-INT-123.json)

```json
{
  "id": "wf-INT-123",
  "issueId": "INT-123",
  "projectId": "my-project",
  "status": "building",
  "currentIteration": 1,
  "maxIterations": 3,
  "createdAt": "2026-03-10T10:00:00Z",
  "updatedAt": "2026-03-10T12:30:00Z",
  "currentStage": "builder",
  "branch": "feat/INT-123",
  "worktreePath": "~/.agent-orchestrator/{hash}/worktrees/wf-INT-123",
  
  "iterations": [
    {
      "number": 1,
      "status": "building",
      "startedAt": "2026-03-10T10:35:00Z",
      "stages": {
        "architect": {
          "sessionId": "arch-1",
          "status": "completed",
          "completedAt": "2026-03-10T10:30:00Z"
        },
        "builder": {
          "sessionId": "build-1",
          "status": "running",
          "startedAt": "2026-03-10T10:35:00Z"
        }
      }
    }
  ],
  
  "artifacts": {
    "planPath": "iterations/issue-INT-123/1/plan.md",
    "prs": ["https://github.com/owner/repo/pull/42"]
  }
}
```

---

## Implementation Phases

### Phase 1: Core Types (0.5 days)

**File:** `packages/core/src/types.ts`

```typescript
// Add to existing types

export type WorkflowStage = "architect" | "builder" | "reviewer";
export type WorkflowStatus = "pending" | "planning" | "building" | "reviewing" | "completed" | "failed";

export interface WorkflowConfig {
  enabled: boolean;
  type: string;
  prompts?: {
    architect?: string;
    builder?: string;
    reviewer?: string;
  };
  iterations?: {
    maxIterations: number;
    autoMergeOnApproval: boolean;
    notifyOnMaxIterations: boolean;
  };
  timeouts?: {
    architect?: string;
    builder?: string;
    reviewer?: string;
  };
}

export interface IterationState {
  number: number;
  status: "pending" | "architecting" | "building" | "reviewing" | "changes_requested" | "approved";
  startedAt: string;
  completedAt?: string;
  stages: {
    architect: IterationStageState;
    builder: IterationStageState;
    reviewer: IterationStageState;
  };
}

export interface IterationStageState {
  sessionId?: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowState {
  id: string;
  issueId: string;
  projectId: string;
  status: WorkflowStatus;
  currentIteration: number;
  maxIterations: number;
  currentStage: WorkflowStage;
  branch: string;
  worktreePath: string;
  createdAt: string;
  updatedAt: string;
  iterations: IterationState[];
  artifacts: {
    planPath?: string;
    prs: string[];
    mergedPRs: string[];
  };
}

// Extend ProjectConfig
export interface ProjectConfig {
  // ... existing fields ...
  workflow?: WorkflowConfig;
}
```

---

### Phase 2: Workflow State Manager (1.5 days)

**File:** `packages/core/src/workflow-state.ts` (new)

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { 
  OrchestratorConfig, 
  ProjectConfig, 
  WorkflowState, 
  IterationState,
  WorkflowStage 
} from "./types.js";
import { getProjectBaseDir } from "./paths.js";

export function getWorkflowsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "workflows");
}

export function getIterationsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "iterations");
}

export function getWorkflowStatePath(
  configPath: string, 
  projectPath: string, 
  workflowId: string
): string {
  return join(getWorkflowsDir(configPath, projectPath), `${workflowId}.json`);
}

export function createWorkflowState(
  config: OrchestratorConfig,
  project: ProjectConfig,
  issueId: string,
  branch: string
): WorkflowState {
  const workflowId = `wf-${issueId}`;
  const now = new Date().toISOString();
  const maxIterations = project.workflow?.iterations?.maxIterations ?? 3;
  
  const state: WorkflowState = {
    id: workflowId,
    issueId,
    projectId: Object.keys(config.projects).find(k => config.projects[k].path === project.path)?.[0] ?? "unknown",
    status: "pending",
    currentIteration: 0,
    maxIterations,
    currentStage: "architect",
    branch,
    worktreePath: "", // Will be set when worktree created
    createdAt: now,
    updatedAt: now,
    iterations: [],
    artifacts: {
      prs: [],
      mergedPRs: [],
    },
  };
  
  // Create directories
  const workflowsDir = getWorkflowsDir(config.configPath, project.path);
  const iterationsDir = getIterationsDir(config.configPath, project.path);
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(join(iterationsDir, `issue-${issueId}`), { recursive: true });
  
  saveWorkflowState(config.configPath, project.path, state);
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
    return JSON.parse(readFileSync(path, "utf-8"));
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
  state.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export function startIteration(
  configPath: string,
  projectPath: string,
  workflow: WorkflowState
): IterationState {
  const iterationNumber = workflow.iterations.length + 1;
  const now = new Date().toISOString();
  
  const iteration: IterationState = {
    number: iterationNumber,
    status: "pending",
    startedAt: now,
    stages: {
      architect: { status: "pending" },
      builder: { status: "pending" },
      reviewer: { status: "pending" },
    },
  };
  
  workflow.iterations.push(iteration);
  workflow.currentIteration = iterationNumber;
  saveWorkflowState(configPath, projectPath, workflow);
  
  return iteration;
}
```

---

### Phase 3: Prompt System (1 day)

**File:** `packages/core/src/prompt-loader.ts` (new)

```typescript
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { OrchestratorConfig, ProjectConfig, WorkflowState, IterationState } from "./types.js";
import Handlebars from "handlebars";

import { loadWorkflowState, getIterationsDir } from "./workflow-state.js";

import { readMetadataRaw } from "./metadata.js";
import { getSessionsDir } from "./paths.js";

export interface PromptContext {
  issue: { identifier: string; title: string; description: string; url: string };
  project: { id: string; name: string; repo: string; defaultBranch: string };
  workflow: { id: string; currentIteration: number; maxIterations: number };
  iteration?: number;
  previousPlan?: string;
  previousFeedback?: string;
  reviewUrl?: string;
}

const GLOBAL_PROMPTS_DIR = join(homedir(), ".agent-orchestrator", "prompts");

export function loadPromptFile(
  config: OrchestratorConfig,
  project: ProjectConfig,
  stage: "architect" | "builder" | "reviewer"
): string {
  // 1. Project-specific prompt
  const projectPromptPath = project.workflow?.prompts?.[stage];
  if (projectPromptPath) {
    const fullPath = projectPromptPath.startsWith("~/")
      ? join(homedir(), projectPromptPath.slice(2))
      : projectPromptPath.startsWith("/")
      ? projectPromptPath
      : resolve(project.path, projectPromptPath);
    
    if (existsSync(fullPath)) {
      return readFileSync(fullPath, "utf-8");
    }
  }
  
  // 2. Default .ao/prompts location
  const defaultPath = join(project.path, ".ao", "prompts", `${stage}.md`);
  if (existsSync(defaultPath)) {
    return readFileSync(defaultPath, "utf-8");
  }
  
  // 3. Global prompts
  const globalPath = join(GLOBAL_PROMPTS_DIR, `${stage}.md`);
  if (existsSync(globalPath)) {
    return readFileSync(globalPath, "utf-8");
  }
  
  // 4. Built-in fallback
  return getBuiltInPrompt(stage);
}

function getBuiltInPrompt(stage: string): string {
  const prompts: Record<string, string> = {
    architect: `# Architect

You are the **Architect** for this iteration.

## Context
- Issue: {{issue.identifier}} - {{issue.title}}
- Iteration: {{iteration}} of {{workflow.maxIterations}}

{% if previousPlan %}
## Previous Plan
{{previousPlan}}
{% /if %}

{% if previousFeedback %}
## Previous Review Feedback
{{previousFeedback}}
{% /if %}

## Your Task
1. Analyze the current state vs requirements
2. Identify what's done and what remains
3. Create PLAN.md for this iteration
4. Document any risks or blockers

`,
    builder: `# Builder

You are the **Builder** for this iteration.

## Context
- Issue: {{issue.identifier}} - {{issue.title}}
- Iteration: {{iteration}} of {{workflow.maxIterations}}

{% if previousFeedback %}
## Review Feedback to Address
{{previousFeedback}}
{% /if %}

## Your Task
Implement the plan for this iteration.
`,
    reviewer: `# Reviewer

You are the **Reviewer** for this iteration.

## Context
- Issue: {{issue.identifier}} - {{issue.title}}
- Iteration: {{iteration}} of {{workflow.maxIterations}}

{% if reviewUrl %}
## PR to Review
{{reviewUrl}}
{% /if %}

## Your Task
1. Review the implementation
2. Check against the plan
3. Provide feedback or`,
  };
  return prompts[stage] ?? "";
}

export function buildPromptContext(
  config: OrchestratorConfig,
  projectId: string,
  workflow: WorkflowState,
  iteration: IterationState,
  extras?: Partial<PromptContext>
): PromptContext {
  const project = config.projects[projectId];
  
  // Load previous iteration's feedback if this is iteration > 1
  let previousFeedback: string | undefined;
  let previousPlan: string | undefined;
  
  if (iteration.number > 1) {
    const prevIteration = workflow.iterations[iteration.number - 2];
    if (prevIteration) {
      const feedbackPath = join(
        getIterationsDir(config.configPath, project.path),
        `issue-${workflow.issueId}`,
        String(prevIteration.number),
        "review-feedback.md"
      );
      if (existsSync(feedbackPath)) {
        previousFeedback = readFileSync(feedbackPath, "utf-8");
      }
    }
  }
  
  return {
    issue: {
      identifier: workflow.issueId,
      title: "", // Would be fetched from tracker
      description: "", // Would be fetched from tracker
      url: "", // Would be constructed
    },
    project: {
      id: projectId,
      name: project.name,
      repo: project.repo,
      defaultBranch: project.defaultBranch,
    },
    workflow: {
      id: workflow.id,
      currentIteration: iteration.number,
      maxIterations: workflow.maxIterations,
    },
    iteration: iteration.number,
    previousFeedback,
    previousPlan,
    ...extras,
  };
}

export function renderPrompt(template: string, context: PromptContext): string {
  Handlebars.registerHelper("eq", (a, b) => a === b);
  Handlebars.registerHelper("gt", (a, b) => a > b);
  return Handlebars.compile(template)(context);
}
```

---

### Phase 4: Workflow Manager (2 days)

**File:** `packages/core/src/workflow-manager.ts` (new)

Key methods:
- `startWorkflow(projectId, issueId)` - Create workflow and start first iteration
- `advanceStage(workflowId, stage)` - Move to next stage
- `handleReviewComplete(workflowId, approved, feedback)` - Process review result
- `getWorkflow(workflowId)` - Get workflow state
- `listWorkflows(projectId)` - List active workflows

- `killWorkflow(workflowId)` - Cleanup workflow

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { 
  OrchestratorConfig, 
  ProjectConfig, 
  WorkflowState,
  IterationState,
  WorkflowStage,
  Session,
  SessionManager,
  PluginRegistry 
} from "./types.js";
import { 
  createWorkflowState, 
  loadWorkflowState, 
  saveWorkflowState, 
  startIteration,
  getIterationsDir 
} from "./workflow-state.js";
import { loadPromptFile, renderPrompt, buildPromptContext } from "./prompt-loader.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir, from "./paths.js";

export interface WorkflowManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

 export function createWorkflowManager(deps: WorkflowManagerDeps) {
  const { config, registry, sessionManager } = deps;
  
  async function startWorkflow(projectId: string, issueId: string): Promise<WorkflowState> {
    const project = config.projects[projectId];
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!project.workflow?.enabled) throw new Error(`Workflows not enabled for ${projectId}`);
    
    // Create workflow state
    const branch = `feat/${issueId}`;
    const workflow = createWorkflowState(config, project, issueId, branch);
    
    // Create worktree (shared across all iterations)
    const sessionId = `${project.sessionPrefix}-wf-${issueId}`;
    const workspace = await sessionManager.spawn({
      projectId,
      issueId,
      branch,
      workflowId: workflow.id,
    });
    
    workflow.worktreePath = workspace.workspacePath;
    saveWorkflowState(config.configPath, project.path, workflow);
    
    // Start first iteration
    const iteration = startIteration(config.configPath, project.path, workflow);
    
    // Spawn architect
    await spawnStageSession(workflow, iteration, "architect");
    
    return workflow;
  }
  
  async function spawnStageSession(
    workflow: WorkflowState,
    iteration: IterationState,
    stage: WorkflowStage
  ): Promise<Session> {
    const project = config.projects[workflow.projectId];
    const prompt = loadPromptFile(config, project, stage);
    const context = buildPromptContext(config, workflow.projectId, workflow, iteration);
    const renderedPrompt = renderPrompt(prompt, context);
    
    const sessionId = `${project.sessionPrefix}-${stage.substring(0, 4)}-${iteration.number}`;
    
    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt: renderedPrompt,
      workflowId: workflow.id,
      workflowStage: stage,
      workflowIteration: iteration.number,
    });
    
    // Update iteration state
    iteration.stages[stage] = {
      sessionId: session.id,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    workflow.currentStage = stage;
    saveWorkflowState(config.configPath, project.path, workflow);
    
    return session;
  }
  
  async function advanceStage(workflowId: string): Promise<void> {
    const project = Object.values(config.projects).find(p => 
      loadWorkflowState(config.configPath, p.path, workflowId)?.id === workflowId
    )?.path;
    if (!project) return;
    
    const workflow = loadWorkflowState(config.configPath, project.path, workflowId);
    if (!workflow) return;
    
    const currentIteration = workflow.iterations[workflow.currentIteration - 1];
    
    // Mark current stage complete
    const currentStage = workflow.currentStage;
    currentIteration.stages[currentStage].status = "completed";
    currentIteration.stages[currentStage].completedAt = new Date().toISOString();
    
    // Determine next stage
    const stages: WorkflowStage[] = ["architect", "builder", "reviewer"];
    const currentIndex = stages.indexOf(currentStage);
    
    if (currentIndex === stages.length - 1) {
      // Review complete - check if approved
      if (currentIteration.stages.reviewer.status === "completed") {
        workflow.status = "completed";
        // Auto-merge if configured
        if (project.workflow?.iterations?.autoMergeOnApproval) {
          // Would merge PRs here
        }
      }
    saveWorkflowState(config.configPath, project.path, workflow);
      return;
    }
    
    // Move to next stage
    const nextStage = stages[currentIndex + 1];
    await spawnStageSession(workflow, currentIteration, nextStage);
  }
  
  async function handleReviewComplete(
    workflowId: string,
    approved: boolean,
    feedback?: string
  ): Promise<void> {
    const project = Object.values(config.projects).find(p => 
      loadWorkflowState(config.configPath, p.path, workflowId)?.id === workflowId
    )?.path;
    if (!project) return;
    
    const workflow = loadWorkflowState(config.configPath, project.path, workflowId);
    if (!workflow) return;
    
    const currentIteration = workflow.iterations[workflow.currentIteration - 1];
    
    if (approved) {
      currentIteration.status = "approved";
      currentIteration.stages.reviewer.status = "completed";
      await advanceStage(workflowId);
    } else {
      currentIteration.status = "changes_requested";
      currentIteration.stages.reviewer.status = "completed";
      
      // Write feedback
      const feedbackPath = join(
        getIterationsDir(config.configPath, project.path),
        `issue-${workflow.issueId}`,
        String(currentIteration.number),
        "review-feedback.md"
      );
      mkdirSync(join(feedPath, ".."), { recursive: true });
      writeFileSync(feedbackPath, feedback ?? "Changes requested", "utf-8");
      
      // Check max iterations
      if (workflow.currentIteration >= workflow.maxIterations) {
        workflow.status = "failed";
        saveWorkflowState(config.configPath, project.path, workflow);
        throw new Error(`Max iterations (${workflow.maxIterations}) reached`);
      }
      
      // Start new iteration
      const newIteration = startIteration(config.configPath, project.path, workflow);
      await spawnStageSession(workflow, newIteration, "architect");
    }
  }
  
  function getWorkflow(projectId: string, workflowId: string): WorkflowState | null {
    const project = config.projects[projectId];
    if (!project) return null;
    return loadWorkflowState(config.configPath, project.path, workflowId);
  }
  
  function listWorkflows(projectId: string): WorkflowState[] {
    const project = config.projects[projectId];
    if (!project) return [];
    
    const workflowsDir = getWorkflowsDir(config.configPath, project.path);
    if (!existsSync(workflowsDir)) return [];
    
    const files = readdirSync(workflowsDir).filter(f => f.endsWith(".json"));
    return files
      .map(f => loadWorkflowState(config.configPath, project.path, f.replace(".json", "")))
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  
  async function killWorkflow(workflowId: string): Promise<void> {
    const project = Object.values(config.projects).find(p => 
      loadWorkflowState(config.configPath, p.path, workflowId)?.id === workflowId
    )?.path;
    if (!project) return;
    
    const workflow = loadWorkflowState(config.configPath, project.path, workflowId);
    if (!workflow) return;
    
    // Kill all sessions
    for (const iteration of workflow.iterations) {
      for (const stage of Object.values(iteration.stages)) {
        if (stage.sessionId) {
          try {
            await sessionManager.kill(stage.sessionId);
          } catch {}
        }
      }
    }
  }
  
  return {
    startWorkflow,
    advanceStage,
    handleReviewComplete,
    getWorkflow,
    listWorkflows,
    killWorkflow,
  };
}

```

---

### Phase 5: Lifecycle Integration (1.5 days)

**File:** `packages/core/src/lifecycle-manager.ts` (modify)

Add workflow stage completion detection:
```typescript
// In checkSession function, after existing status detection:

// Check for workflow stage completion
if (session.metadata["workflowId"]) && session.metadata["workflowStage"]) {
  const workflowId = session.metadata["workflowId"];
  const stage = session.metadata["workflowStage"] as WorkflowStage;
  const iteration = session.metadata["workflowIteration"];
  
  // Architect complete: plan.md created or branch created
  if (stage === "architect" && session.status === "pr_open") {
    const planPath = join(
      getIterationsDir(config.configPath, project.path),
      `issue-${workflow.issueId}`,
      "plan.md"
    );
    if (existsSync(planPath)) {
      await workflowManager.advanceStage(workflowId);
    }
  }
  
  // Builder complete: PR created and CI passing
  if (stage === "builder" && session.status === "mergeable") {
    await workflowManager.advanceStage(workflowId);
  }
  
  // Reviewer complete: check PR status
  if (stage === "reviewer") {
    if (session.status === "approved") {
      await workflowManager.handleReviewComplete(workflowId, true);
    } else if (session.status === "changes_requested") {
      // Read feedback from PR comments
      const feedback = "Extract from PR review comments...";
      await workflowManager.handleReviewComplete(workflowId, false, feedback);
    }
  }
}
```

---

### Phase 6: CLI Commands (1 day)

**File:** `packages/cli/src/commands/workflow.ts` (new)
```typescript
import { Command } from "commander";
import chalk from "chalk";

import { loadConfig } from "@composio/ao-core/config";
import { createPluginRegistry } from "@composio/ao-core/plugin-registry";
import { createSessionManager } from "@composio/ao-core/session-manager";
import { createWorkflowManager } from "@composio/ao-core/workflow-manager";

import { getWorkflow, listWorkflows } from "@composio/ao-core/workflow-manager";

import type { WorkflowState } from "@composio/ao-core";

export const workflowCommand = new Command("workflow")
  .description("Manage architect-delivery workflows");

workflowCommand
  .command("start <projectId> <issueId>")
  .description("Start a new workflow")
  .action(async (projectId: string, issueId: string) => {
    const config = await loadConfig();
    const registry = createPluginRegistry();
    await registry.loadBuiltins(config);
    const sessionManager = createSessionManager({ config, registry });
    const workflowManager = createWorkflowManager({ config, registry, sessionManager });
    
    console.log(chalk.blue(`Starting workflow for ${issueId}...`));
    const workflow = await workflowManager.startWorkflow(projectId, issueId);
    console.log(chalk.green(`✓ Workflow started: ${workflow.id}`));
    printWorkflowStatus(workflow);
  });

workflowCommand
  .command("status [workflowId]")
  .description("Show workflow status")
  .option("-p, --project <projectId>", "Project ID")
  .action(async (workflowId: string | undefined, options: { project?: string }) => {
    const config = await loadConfig();
    const registry = createPluginRegistry();
    await registry.loadBuiltins(config);
    const sessionManager = createSessionManager({ config, registry });
    const workflowManager = createWorkflowManager({ config, registry, sessionManager });
    
    if (workflowId) {
      const projectId = options.project ?? Object.keys(config.projects)[0];
      const workflow = workflowManager.getWorkflow(projectId, workflowId);
      if (!workflow) {
        console.error(chalk.red(`Workflow not found: ${workflowId}`));
        process.exit(1);
      }
      printWorkflowDetail(workflow);
    } else {
      const projectId = options.project ?? Object.keys(config.projects)[0];
      const workflows = workflowManager.listWorkflows(projectId);
      if (workflows.length === 0) {
        console.log("No workflows found.");
        return;
      }
      console.log(chalk.bold("\nWorkflows:\n"));
      for (const w of workflows) {
        printWorkflowSummary(w);
      }
    }
  });

workflowCommand
  .command("kill <workflowId>")
  .description("Kill a workflow and .option("-p, --project <projectId>", "Project ID")
  .action(async (workflowId: string, options: { project?: string }) => {
    const config = await loadConfig();
    const registry = createPluginRegistry();
    await registry.loadBuiltins(config);
    const sessionManager = createSessionManager({ config, registry });
    const workflowManager = createWorkflowManager({ config, registry, sessionManager });
    
    console.log(chalk.yellow(`Killing workflow ${workflowId}...`));
    await workflowManager.killWorkflow(workflowId);
    console.log(chalk.green("✓ Workflow killed"));
  });

function printWorkflowSummary(w: WorkflowState) {
  const statusColor = 
    w.status === "completed" ? chalk.green :
    w.status === "failed" ? chalk.red :
    chalk.yellow;
  
  console.log(`${statusColor(w.status)} ${w.id}`);
  console.log(`  Issue: ${w.issueId}`);
  console.log(`  Iteration: ${w.currentIteration}/${w.maxIterations}`);
}

 console.log(`  Stage: ${w.currentStage}`);
}

 console.log(`  Created: ${w.createdAt}`);
}

 }

function printWorkflowDetail(w: WorkflowState) {
  console.log(chalk.bold(`\nWorkflow: ${w.id}`));
  console.log(`  Status: ${w.status}`);
  console.log(`  Issue: ${w.issueId}`);
  console.log(`  Iteration: ${w.currentIteration}/${w.maxIterations}`);
  console.log(`  Current Stage: ${w.currentStage}`);
  console.log(`  Branch: ${w.branch}`);
  console.log(`  Created: ${w.createdAt}`);
  
  console.log(chalk.bold("\n  Iterations:"));
  for (const iter of w.iterations) {
    console.log(`    ${iter.number}: ${iter.status}`);
    for (const [stage, state] of Object.entries(iter.stages)) {
      console.log(`      ${stage}: ${state.status} ${state.sessionId ?? ""}`);
    }
  }
  
  if (w.artifacts.prs.length > 0) {
    console.log(chalk.bold("\n  PRs:"));
    for (const pr of w.artifacts.prs) {
      console.log(`    - ${pr}`);
    }
  }
}
```

---

## Summary

### Revised Estimates

| Phase | Duration | Key Deliverable |
|------|----------|--------------|
| 1. Core Types | 0.5 days | Workflow state types |
| 2. State Manager | 1.5 days | State persistence |
| 3. Prompt System | 1 day | Template loading |
| 4. Workflow Manager | 2 days | Orchestration logic |
| 5. Lifecycle Integration | 1.5 days | Stage completion detection |
| 6. CLI Commands | 1 day | User interface |
| **Total** | **7.5 days** | |

### Key Simplifications
1. **Single worktree per issue** - Not per task
2. **Sequential stages** - Architect → Builder → Reviewer
3. **Iteration-based** - Feedback loops drive new iterations
4. **Simpler state machine** - Just track current stage and iteration
5. **No decomposition** - Simple sequential flow
