/**
 * Task Manager — parses and manages tasks in PLAN.md
 *
 * Handles:
 * - Parsing tasks from PLAN.md checkbox format
 * - Checking completion status
 * - Marking tasks as complete
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { WorkflowTask, TaskStatus } from "./types.js";

export interface TaskManagerDeps {
  planPath: string;
}

export function createTaskManager(deps: TaskManagerDeps) {
  const { planPath } = deps;

  /**
   * Parse all tasks from PLAN.md
   * 
   * Format:
   * - [ ] TASK-01: Description (pending)
   * - [x] TASK-01: Description (completed)
   * - [>] TASK-01: Description (in progress - not used in sequential model)
   */
  function parseTasks(): WorkflowTask[] {
    if (!existsSync(planPath)) return [];

    const content = readFileSync(planPath, "utf-8");
    const tasks: WorkflowTask[] = [];

    for (const line of content.split("\n")) {
      // Pending: - [ ] TASK-01: Description
      const pending = line.match(/^- \[ \] (TASK-\d+):\s*(.+)$/);
      if (pending) {
        tasks.push({
          id: pending[1],
          description: pending[2].trim(),
          status: "pending",
        });
        continue;
      }

      // Completed: - [x] TASK-01: Description
      const done = line.match(/^- \[x\] (TASK-\d+):\s*(.+)$/);
      if (done) {
        tasks.push({
          id: done[1],
          description: done[2].trim(),
          status: "completed",
        });
      }
    }

    return tasks;
  }

  /**
   * Get pending (uncompleted) tasks
   */
  function getPendingTasks(): WorkflowTask[] {
    return parseTasks().filter((t) => t.status === "pending");
  }

  /**
   * Check if all tasks are complete
   */
  function allTasksComplete(): boolean {
    const tasks = parseTasks();
    // No tasks OR all completed
    return tasks.length === 0 || tasks.every((t) => t.status === "completed");
  }

  /**
   * Count remaining tasks
   */
  function getRemainingCount(): number {
    return getPendingTasks().length;
  }

  /**
   * Count total tasks
   */
  function getTotalCount(): number {
    return parseTasks().length;
  }

  /**
   * Count completed tasks
   */
  function getCompletedCount(): number {
    return parseTasks().filter((t) => t.status === "completed").length;
  }

  /**
   * Mark a task as complete in PLAN.md
   */
  function markComplete(taskId: string): void {
    if (!existsSync(planPath)) return;

    let content = readFileSync(planPath, "utf-8");
    // Replace: - [ ] TASK-XX: with: - [x] TASK-XX:
    const regex = new RegExp(`^- \\[ \\] ${taskId}:`, "gm");
    content = content.replace(regex, `- [x] ${taskId}:`);
    writeFileSync(planPath, content, "utf-8");
  }

  /**
   * Check if PLAN.md exists
   */
  function planExists(): boolean {
    return existsSync(planPath);
  }

  /**
   * Check if PLAN.md has any tasks at all
   */
  function hasAnyTasks(): boolean {
    return parseTasks().length > 0;
  }

  return {
    parseTasks,
    getPendingTasks,
    allTasksComplete,
    getRemainingCount,
    getTotalCount,
    getCompletedCount,
    markComplete,
    planExists,
    hasAnyTasks,
    planPath,
  };
}

export type TaskManager = ReturnType<typeof createTaskManager>;
