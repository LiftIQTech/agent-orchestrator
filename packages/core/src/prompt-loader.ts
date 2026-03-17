/**
 * Prompt Loader — loads and renders workflow prompts
 *
 * Supports:
 * - Loading from project-specific .ao/prompts/
 * - Loading from global ~/.agent-orchestrator/prompts/
 * - Built-in fallback prompts
 * - Handlebars-style template rendering
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type {
  OrchestratorConfig,
  ProjectConfig,
  WorkflowState,
  IterationState,
} from "./types.js";
import { getPlanPath, getProgressPath } from "./workflow-state.js";

const GLOBAL_PROMPTS_DIR = join(homedir(), ".agent-orchestrator", "prompts");

// =============================================================================
// CONTEXT TYPES
// =============================================================================

export interface PromptContext {
  issue: {
    identifier: string;
    title: string;
    description: string;
    url: string;
  };
  project: {
    id: string;
    name: string;
    repo: string;
    defaultBranch: string;
    baseBranch: string;
  };
  workflow: {
    id: string;
    currentIteration: number;
    maxIterations: number;
    currentBuilderIteration: number;
    maxBuilderIterations: number;
  };
  iteration: number;
  requirementsPath: string;
  iterationDir: string;
  planPath: string;
  progressPath: string;
  orchestratorAnalysisPath: string;
  reviewFindingsPath: string;
  builderNum?: number;
  previousFeedback?: string;
}

// =============================================================================
// PROMPT LOADING
// =============================================================================

export function loadPromptFile(
  config: OrchestratorConfig,
  project: ProjectConfig,
  stage: "architect" | "builder" | "reviewer"
): string {
  // 1. Project-specific prompt from config
  const configPromptPath = project.workflow?.prompts?.[stage];
  if (configPromptPath) {
    const fullPath = configPromptPath.startsWith("~/")
      ? join(homedir(), configPromptPath.slice(2))
      : configPromptPath.startsWith("/")
      ? configPromptPath
      : resolve(project.path, configPromptPath);

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

function getBuiltInPrompt(stage: "architect" | "builder" | "reviewer"): string {
  const prompts: Record<string, string> = {
    architect: `# Architect Agent

You are the strategic planner for issue \`{{issue.identifier}}\`.

Read \`{{requirementsPath}}\`, assess the current state, then write:
- \`{{planPath}}\`
- \`{{orchestratorAnalysisPath}}\`

PLAN.md MUST contain 3-7 tasks using exact checkbox syntax:

\`\`\`markdown
# PLAN

- [ ] TASK-01: Clear actionable task
- [ ] TASK-02: Clear actionable task
- [ ] TASK-03: Clear actionable task
\`\`\`

Rules:
- do not leave placeholder text
- do not modify requirements.md
- do not create/switch branches
- commit planning artifacts with message starting \`architect(i{{iteration}}):\`
`,
    builder: `# Builder Agent

You are Builder {{builderNum}} for issue \`{{issue.identifier}}\`.

Read \`{{planPath}}\` and complete the next unchecked task(s).

Before finishing you MUST:
- update PLAN.md checkboxes to \`- [x]\`
- append to \`{{progressPath}}\`
- run relevant tests
- commit your work with message starting \`architect(i{{iteration}}-b{{builderNum}}):\`

Rules:
- stay on the current workflow branch
- do not create or update PRs
- do not create/switch branches
- only change files relevant to the planned tasks
- if a command or validation is long-running, split the work into smaller verifiable chunks and keep making progress
- if local daemon-managed services need a restart to proceed, restart them yourself and document it in progress output instead of asking
`,
    reviewer: `# Reviewer Agent

You are the reviewer for issue \`{{issue.identifier}}\`.

Review the iteration work against \`{{planPath}}\`, \`{{progressPath}}\`, and the changed code.

You MUST write \`{{reviewFindingsPath}}\` with one explicit verdict:
- \`## VERDICT: APPROVED\`
- \`## VERDICT: CHANGES REQUESTED\`

If changes are requested, include specific issues, files, and fixes.
Do not leave placeholder text in the findings file.
Do not modify product code.
`,
  };
  return prompts[stage] ?? "";
}

// =============================================================================
// CONTEXT BUILDING
// =============================================================================

export function buildPromptContext(
  config: OrchestratorConfig,
  projectId: string,
  workflow: WorkflowState,
  iteration: IterationState,
  extras?: Partial<PromptContext>
): PromptContext {
  const project = config.projects[projectId];

  // Load previous feedback if iteration > 1
  let previousFeedback: string | undefined;
  if (iteration.number > 1 && workflow.iterations.length > 1) {
    const prevIter = workflow.iterations[iteration.number - 2];
    const feedbackPath = join(dirname(prevIter.progressPath), "review-feedback.md");
    if (existsSync(feedbackPath)) {
      previousFeedback = readFileSync(feedbackPath, "utf-8");
    }
  } else if (iteration.number === 1) {
    // First iteration - no previous feedback but previousFeedback = "N/A - First iteration";
  }

  return {
    issue: {
      identifier: workflow.issueId,
      title: "",  // Will be filled by tracker
      description: "",  // Will be filled by tracker
      url: "",  // Will be filled by tracker
    },
    project: {
      id: projectId,
      name: project.name,
      repo: project.repo,
      defaultBranch: project.defaultBranch,
      baseBranch: workflow.baseBranch,
    },
    workflow: {
      id: workflow.id,
      currentIteration: workflow.currentIteration,
      maxIterations: workflow.maxIterations,
      currentBuilderIteration: workflow.currentBuilderIteration,
      maxBuilderIterations: workflow.maxBuilderIterations,
    },
    iteration: iteration.number,
    requirementsPath: join(dirname(dirname(iteration.iterationDir)), "requirements.md"),
    iterationDir: iteration.iterationDir,
    planPath: iteration.planPath,
    progressPath: iteration.progressPath,
    orchestratorAnalysisPath: iteration.orchestratorAnalysisPath,
    reviewFindingsPath: iteration.reviewFindingsPath,
    previousFeedback,
    ...extras,
  };
}

// =============================================================================
// PROMPT RENDERING
// =============================================================================

export function renderPrompt(template: string, context: PromptContext): string {
  let result = template;

  // Simple template replacement
  // Handle {{variable}} and {{object.property}}
  const varPattern = /\{\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}\}/g;

  result = result.replace(varPattern, (match, path) => {
    const parts = path.split(".");
    let value: unknown = context as unknown;

    for (const part of parts) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[part];
      } else {
        return match; // Keep original if path doesn't exist
      }
    }

    return value !== undefined ? String(value) : match;
  });

  // Handle conditionals: {{#if (eq var1 var2)}}...{{else}}...{{/if}}
  // Simple implementation for eq helper
  result = result.replace(/\{\{#if \(eq (\w+) (\d+)\)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g, 
    (_, varName, compareValue, ifBlock, elseBlock) => {
      const value = (context as unknown as Record<string, unknown>)[varName];
      return value === parseInt(compareValue, 10) ? ifBlock : elseBlock;
    }
  );

  // Remove extra empty lines from conditionals
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}

// =============================================================================
// PROGRESS WRITING
// =============================================================================

export function writeProgressEntry(
  progressPath: string,
  builderNum: number,
  entry: {
    tasksCompleted: string[];
    summary: string;
    commitHash?: string;
  }
): void {
  const dir = dirname(progressPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const content = `

## Builder ${builderNum} (${timestamp})

### Tasks Completed
${entry.tasksCompleted.length > 0
  ? entry.tasksCompleted.map((t) => `- [x] ${t}`).join("\n")
  : "(none)"}

### Summary
${entry.summary}

${entry.commitHash ? `**Commit:** \`${entry.commitHash}\`` : ""}

---
`;

  appendFileSync(progressPath, content, "utf-8");
}
