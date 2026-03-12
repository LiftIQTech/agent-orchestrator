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
  };
  workflow: {
    id: string;
    currentIteration: number;
    maxIterations: number;
    currentBuilderIteration: number;
    maxBuilderIterations: number;
  };
  iteration: number;
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

You are the **Architect** for issue \`{{issue.identifier}}\`.

## Context
- Issue: {{issue.identifier}} - {{issue.title}}
- Iteration: {{iteration}} of {{workflow.maxIterations}}
{{#if (eq iteration 1)}}
## Requirements
Read the issue description and create a detailed implementation plan.

{{else}}
## Previous Feedback
Address the following from the review:
{{previousFeedback}}

{{/if}}

## Your Task
1. Analyze what's been done vs what remains
2. Create PLAN.md with tasks:
   \`\`\`markdown
   # PLAN
   
   - [ ] TASK-01: First task description
   - [ ] TASK-02: Second task description
   - [ ] TASK-03: Third task description
   \`\`\`

3. Document your analysis in orchestrator-analysis.md

## Important
- Write PLAN.md to: {{planPath}}
- Use checkbox format: \`- [ ] TASK-XX:\` for tasks
- If goal achieved, write \`# GOAL ACHIEVED\` at top of PLAN.md
`,
    builder: `# Builder Agent

You are **Builder {{builderNum}}** for issue \`{{issue.identifier}}\`.

## Context
- Issue: {{issue.identifier}} - {{issue.title}}
- Iteration: {{iteration}} of {{workflow.maxIterations}}
- Builder: {{builderNum}} of {{workflow.maxBuilderIterations}}

## Your Task
1. Read PLAN.md at: {{planPath}}
2. Pick 1-3 uncompleted tasks (marked with \`- [ ]\`)
3. Implement the tasks
4. Mark them complete: change \`- [ ]\` to \`- [x]\`
5. Update PROGRESS.md at: {{progressPath}}
6. Commit with message: \`architect(i{{iteration}}-b{{builderNum}}): <task summary>\`

## Important
- Work in the existing workspace - do NOT create new branches
- Commit after EACH task is complete
- Update PLAN.md checkboxes as you complete tasks
- If all tasks done early, you can stop

## PROGRESS.md Format
Append your work:
\`\`\`markdown
## Builder {{builderNum}} ({{timestamp}})

### Tasks Completed
- [x] TASK-XX: Description

### Summary
Brief description of what was done.

**Commit:** \`abc123\`
\`\`\`
`,
    reviewer: `# Reviewer Agent

You are the **Reviewer** for issue \`{{issue.identifier}}\`.

## Context
- Issue: {{issue.identifier}} - {{issue.title}}
- Iteration: {{iteration}} of {{workflow.maxIterations}}

## Your Task
1. Review the implementation in the current branch
2. Check against PLAN.md
3. Verify:
   - All tasks are implemented
   - Tests pass
   - Code quality is acceptable

4. Decision:
   - If APPROVED: Comment "APPROVED - Ready to merge"
   - If CHANGES REQUESTED: List specific issues that need addressing

## Important
- Be thorough but fair
- Focus on correctness and completeness
- Consider edge cases and error handling
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
    },
    workflow: {
      id: workflow.id,
      currentIteration: workflow.currentIteration,
      maxIterations: workflow.maxIterations,
      currentBuilderIteration: workflow.currentBuilderIteration,
      maxBuilderIterations: workflow.maxBuilderIterations,
    },
    iteration: iteration.number,
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
