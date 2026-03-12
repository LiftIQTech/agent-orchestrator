/**
 * Workflow Manager — orchestrates architect-delivery workflow
 *
 * Implements sequential builder pattern:
 * 1. Architect creates PLAN.md with tasks
 * 2. Builders execute tasks sequentially (not parallel)
 * 3. Reviewer checks the work
 * 4. If changes requested, new iteration with architect
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type {
  OrchestratorConfig,
  ProjectConfig,
  WorkflowState,
  IterationState,
  Session,
  SessionManager,
  PluginRegistry,
  Issue,
  Tracker,
} from "./types.js";
import {
  createWorkflowState,
  loadWorkflowState,
  saveWorkflowState,
  startNewIteration,
  getPlanPath,
  getProgressPath,
  getWorkflowStatePath,
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

export interface WorkflowManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

export function createWorkflowManager(deps: WorkflowManagerDeps) {
  const { config, registry, sessionManager } = deps;

  async function cleanupIterationSessions(iteration: IterationState): Promise<void> {
    const sessionIds = [
      iteration.architectSession,
      ...iteration.builderSessions,
      iteration.reviewerSession,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);

    for (const sessionId of sessionIds) {
      try {
        await sessionManager.kill(sessionId, { purgeOpenCode: false });
      } catch {
        // Best-effort cleanup only
      }
    }
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
      throw new Error(`Workflow already exists for ${issueId}: ${existing.id} (status: ${existing.status})`);
    }

    // Determine branch
    const branch = baseBranch ? baseBranch : `feat/${issueId}`;

    // Create workflow state
    const workflow = createWorkflowState(
      config.configPath,
      project,
      projectId,
      issueId,
      branch
    );

    // Create worktree
    const session = await sessionManager.spawn({
      projectId,
      issueId,
      branch,
      baseBranch,
      workflowId: workflow.id,
    });

    workflow.worktreePath = session.workspacePath ?? "";
    saveWorkflowState(config.configPath, project.path, workflow);

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
    const iteration = startNewIteration(config.configPath, project.path, workflow);

    // Create iteration files
    const iterDir = dirname(iteration.planPath);
    mkdirSync(iterDir, { recursive: true });

    // Create initial PLAN.md
    writeFileSync(
      iteration.planPath,
      `# PLAN - Iteration ${iteration.number}

Issue: ${workflow.issueId}

(Architect will add tasks)
`,
      "utf-8"
    );

    // Create initial PROGRESS.md
    writeFileSync(
      iteration.progressPath,
      `# Progress - Iteration ${iteration.number}

Issue: ${workflow.issueId}

`,
      "utf-8"
    );

    // Fetch issue context from tracker
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
        } catch (err) {
          // Non-fatal: continue without issue context
        }
      }
    }

    // Build prompt context
    const baseContext = buildPromptContext(config, workflow.projectId, workflow, iteration);
    const context: PromptContext = {
      ...baseContext,
      issue: { ...baseContext.issue, ...issueContext },
    };

    // Add plan/progress paths to context
    const template = loadPromptFile(config, project, "architect")
      .replace("{{planPath}}", iteration.planPath)
      .replace("{{progressPath}}", iteration.progressPath);

    const prompt = renderPrompt(template, context);

    // Spawn architect session
    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "architect",
      workflowIteration: iteration.number,
      workspacePath: workflow.worktreePath,
    });

    // Update state
    iteration.architectSession = session.id;
    workflow.status = "planning";
    saveWorkflowState(config.configPath, project.path, workflow);

    // Update session metadata
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, {
      workflowId: workflow.id,
      workflowStage: "architect",
      workflowIteration: String(iteration.number),
    });

    return session;
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
    workflow.currentBuilderIteration++;
    const builderNum = workflow.currentBuilderIteration;

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
      .replace("{{planPath}}", iteration.planPath)
      .replace("{{progressPath}}", iteration.progressPath);
    
    const prompt = renderPrompt(template, context);

    // Spawn builder session
    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: iteration.number,
      builderIteration: builderNum,
      workspacePath: workflow.worktreePath,
    });

    // Update state
    iteration.builderSessions.push(session.id);
    workflow.status = "building";
    saveWorkflowState(config.configPath, project.path, workflow);

    // Update session metadata
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, {
      workflowId: workflow.id,
      workflowStage: "builder",
      workflowIteration: String(iteration.number),
      builderIteration: String(builderNum),
    });

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
    const template = loadPromptFile(config, project, "reviewer");
    const prompt = renderPrompt(template, context);

    // Spawn reviewer session
    const session = await sessionManager.spawn({
      projectId: workflow.projectId,
      issueId: workflow.issueId,
      branch: workflow.branch,
      prompt,
      workflowId: workflow.id,
      workflowStage: "reviewer",
      workflowIteration: iteration.number,
      workspacePath: workflow.worktreePath,
    });

    // Update state
    iteration.reviewerSession = session.id;
    iteration.status = "reviewing";
    workflow.status = "reviewing";
    saveWorkflowState(config.configPath, project.path, workflow);

    // Update session metadata
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, {
      workflowId: workflow.id,
      workflowStage: "reviewer",
      workflowIteration: String(iteration.number),
    });

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

    if (approved) {
      // Workflow complete
      iteration.status = "approved";
      iteration.completedAt = new Date().toISOString();
      workflow.status = "completed";
      saveWorkflowState(config.configPath, project.path, workflow);
      await cleanupIterationSessions(iteration);
      return;
    }

    // Check iteration limit
    if (workflow.currentIteration >= workflow.maxIterations) {
      workflow.status = "failed";
      saveWorkflowState(config.configPath, project.path, workflow);
      throw new Error(`Max iterations (${workflow.maxIterations}) reached`);
    }

    // Write feedback for next iteration
    const feedbackPath = join(dirname(iteration.progressPath), "review-feedback.md");
    writeFileSync(feedbackPath, feedback ?? "Changes requested", "utf-8");

    // Cleanup completed iteration sessions before starting next one
    await cleanupIterationSessions(iteration);

    // Start new iteration with architect
    await spawnArchitect(workflow, project);
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
        // Kill all sessions
        for (const iteration of w.iterations) {
          if (iteration.architectSession) {
            try {
              await sessionManager.kill(iteration.architectSession);
            } catch {}
          }
          for (const sessionId of iteration.builderSessions) {
            try {
              await sessionManager.kill(sessionId);
            } catch {}
          }
          if (iteration.reviewerSession) {
            try {
              await sessionManager.kill(iteration.reviewerSession);
            } catch {}
          }
        }
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
    getWorkflow,
    listWorkflows,
    killWorkflow,
  };
}

export type WorkflowManager = ReturnType<typeof createWorkflowManager>;
