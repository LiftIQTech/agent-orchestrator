/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Prompt layers:
 *   1. BASE_AGENT_PROMPT — constant instructions about session lifecycle, git workflow, PR handling
 *   2. Config-derived context — project name, repo, default branch, tracker info, reaction rules
 *   3. Shared project rules — inline agentRules and/or agentRulesFile content
 *   4. Worker-specific rules — inline workerRules and/or workerRulesFile content
 *
 * buildPrompt() always returns the AO base guidance and project context so
 * bare launches still know about AO-specific commands such as PR claiming.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

export const BASE_AGENT_PROMPT = `You are an AI coding agent managed by the Agent Orchestrator (ao).

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- When you finish your work, create a PR and push it. The orchestrator will handle CI monitoring and review routing.
- If you're told to take over or continue work on an existing PR, run \`ao session claim-pr <pr-number-or-url>\` from inside this session before making changes.
- If CI fails, the orchestrator will send you the failures — fix them and push again.
- If reviewers request changes, the orchestrator will forward their comments — address each one, push fixes, and reply to the comments.

## Git Workflow
- Always create a feature branch from the default branch (never commit directly to it).
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR when the implementation is ready.
- Keep PRs focused — one issue per PR.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.`;

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;

  /** Decomposition context — ancestor task chain (from decomposer) */
  lineage?: string[];

  /** Decomposition context — sibling task descriptions (from decomposer) */
  siblings?: string[];
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);
  lines.push(`- Repository: ${project.repo}`);
  lines.push(`- Default branch: ${project.defaultBranch}`);

  if (project.tracker) {
    lines.push(`- Tracker: ${project.tracker.plugin}`);
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    lines.push(
      `Create a branch named so that it auto-links to the issue tracker (e.g. feat/${issueId}).`,
    );
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: auto-handled (you'll receive instructions)`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: RULES
// =============================================================================

function readRulesFile(project: ProjectConfig, relativePath?: string): string | null {
  if (!relativePath) {
    return null;
  }

  const filePath = resolve(project.path, relativePath);
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    return content || null;
  } catch {
    // File not found or unreadable — skip silently (don't crash the spawn)
    return null;
  }
}

function readSharedRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  const fileRules = readRulesFile(project, project.agentRulesFile);
  if (fileRules) {
    parts.push(fileRules);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function readWorkerRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.workerRules) {
    parts.push(project.workerRules);
  }

  const fileRules = readRulesFile(project, project.workerRulesFile);
  if (fileRules) {
    parts.push(fileRules);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 *
 * Always returns the AO base guidance plus project context, then layers on
 * issue context, shared rules, worker rules, and explicit instructions when available.
 */
export function buildPrompt(config: PromptBuildConfig): string {
  const sharedRules = readSharedRules(config.project);
  const workerRules = readWorkerRules(config.project);
  const sections: string[] = [];

  // Layer 1: Base prompt is always included for every managed session.
  sections.push(BASE_AGENT_PROMPT);

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 3: Shared project rules
  if (sharedRules) {
    sections.push(`## Project Rules\n${sharedRules}`);
  }

  // Layer 4: Worker-specific quality guidance
  if (workerRules) {
    sections.push(`## Worker Quality Rules\n${workerRules}`);
  }

  // Layer 5: Decomposition context (lineage + siblings)
  if (config.lineage && config.lineage.length > 0) {
    const hierarchy = config.lineage.map((desc, i) => `${"  ".repeat(i)}${i}. ${desc}`);
    // Add current task marker using issueId or last lineage entry
    const currentLabel = config.issueId ?? "this task";
    hierarchy.push(`${"  ".repeat(config.lineage.length)}${config.lineage.length}. ${currentLabel}  <-- (this task)`);

    sections.push(
      `## Task Hierarchy\nThis task is part of a larger decomposed plan. Your place in the hierarchy:\n\n\`\`\`\n${hierarchy.join("\n")}\n\`\`\`\n\nStay focused on YOUR specific task. Do not implement functionality that belongs to other tasks in the hierarchy.`,
    );
  }

  if (config.siblings && config.siblings.length > 0) {
    const siblingLines = config.siblings.map((s) => `  - ${s}`);
    sections.push(
      `## Parallel Work\nSibling tasks being worked on in parallel:\n${siblingLines.join("\n")}\n\nDo not duplicate work that sibling tasks handle. If you need interfaces/types from siblings, define reasonable stubs.`,
    );
  }

  // Explicit user prompt (appended last, highest priority)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  return sections.join("\n\n");
}
