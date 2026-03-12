import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  createWorkflowManager,
  createPluginRegistry,
  createSessionManager,
  type OrchestratorConfig,
  type WorkflowState,
  type WorkflowConfig,
} from "@composio/ao-core";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";
import { banner } from "../lib/format.js";

async function cleanupWorkflowStageSessions(
  sessionManager: Awaited<ReturnType<typeof getWorkflowDeps>>["sessionManager"],
  workflowId: string,
): Promise<number> {
  const sessions = await sessionManager.list();
  const stageSessions = sessions.filter((session) => session.metadata["workflowId"] === workflowId);
  let killed = 0;
  for (const session of stageSessions) {
    try {
      await sessionManager.kill(session.id, { purgeOpenCode: false });
      killed++;
    } catch {
      // Best-effort cleanup
    }
  }
  return killed;
}

async function getWorkflowDeps(config: OrchestratorConfig) {
  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, (pkg: string) => import(pkg));
  const sessionManager = createSessionManager({ config, registry });
  return { config, registry, sessionManager };
}

async function runWorkflowPreflight(config: OrchestratorConfig, projectId: string): Promise<void> {
  const project = config.projects[projectId];
  const runtime = project?.runtime ?? config.defaults.runtime;
  if (runtime === "tmux") {
    await preflight.checkTmux();
  }
  if (project?.tracker?.plugin === "github") {
    await preflight.checkGhAuth();
  }
}

function formatWorkflowStatus(status: string): string {
  const statusColors: Record<string, (s: string) => string> = {
    pending: chalk.gray,
    planning: chalk.blue,
    building: chalk.yellow,
    reviewing: chalk.magenta,
    completed: chalk.green,
    failed: chalk.red,
  };
  const color = statusColors[status] ?? chalk.white;
  return color(status);
}

function printWorkflowDetails(workflow: WorkflowState): void {
  console.log();
  console.log(chalk.bold(`Workflow: ${workflow.id}`));
  console.log(`  Issue:      ${workflow.issueId}`);
  console.log(`  Project:    ${workflow.projectId}`);
  console.log(`  Branch:     ${workflow.branch}`);
  console.log(`  Status:     ${formatWorkflowStatus(workflow.status)}`);
  console.log(`  Iteration:  ${workflow.currentIteration}/${workflow.maxIterations}`);
  console.log(`  Builders:   ${workflow.currentBuilderIteration}/${workflow.maxBuilderIterations}`);
  console.log(`  Created:    ${workflow.createdAt}`);
  console.log(`  Updated:    ${workflow.updatedAt}`);

  if (workflow.iterations.length > 0) {
    console.log();
    console.log(chalk.bold("  Iterations:"));
    for (const iter of workflow.iterations) {
      console.log(`    #${iter.number}: ${iter.status} (${iter.builderSessions.length} builders)`);
    }
  }
}

export function registerWorkflow(program: Command): void {
  const workflow = program
    .command("workflow")
    .description("Manage architect-delivery workflows");

  workflow
    .command("start")
    .description("Start a new workflow for an issue")
    .argument("<project>", "Project ID from config")
    .argument("<issue>", "Issue identifier (e.g. INT-1234, #42)")
    .option("--base-branch <branch>", "Base branch to create feature branch from")
    .action(async (projectId: string, issueId: string, opts: { baseBranch?: string }) => {
      console.log(banner("WORKFLOW START"));
      console.log();

      const config = loadConfig();
      const project = config.projects[projectId];

      if (!project) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      if (!project.workflow?.enabled) {
        console.error(
          chalk.red(`Workflows not enabled for project: ${projectId}`),
        );
        console.log();
        console.log("To enable, add to your config:");
        console.log(chalk.gray(`  projects.${projectId}.workflow.enabled: true`));
        process.exit(1);
      }

      try {
        await runWorkflowPreflight(config, projectId);
        await ensureLifecycleWorker(config, projectId);

        const { registry, sessionManager } = await getWorkflowDeps(config);
        const wm = createWorkflowManager({ config, registry, sessionManager });

        const spinner = ora("Starting workflow").start();
        
        const workflow = await wm.startWorkflow(projectId, issueId, opts.baseBranch);
        
        spinner.succeed(`Workflow started: ${workflow.id}`);
        
        printWorkflowDetails(workflow);

        console.log();
        console.log(chalk.green("Architect session spawned. Check PLAN.md for task creation."));
      } catch (err) {
        console.error(chalk.red(`Failed to start workflow: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  workflow
    .command("status")
    .description("Show workflow status")
    .argument("<project>", "Project ID from config")
    .argument("[issue]", "Issue identifier (optional - shows all if omitted)")
    .action(async (projectId: string, issueId?: string) => {
      const config = loadConfig();
      const project = config.projects[projectId];

      if (!project) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const { registry, sessionManager } = await getWorkflowDeps(config);
      const wm = createWorkflowManager({ config, registry, sessionManager });

      if (issueId) {
        const workflowId = `wf-${issueId}`;
        const workflow = wm.getWorkflow(projectId, workflowId);
        
        if (!workflow) {
          console.error(chalk.red(`No workflow found for issue: ${issueId}`));
          process.exit(1);
        }

        printWorkflowDetails(workflow);
      } else {
        const workflows = wm.listWorkflows(projectId);
        
        if (workflows.length === 0) {
          console.log(chalk.gray("No workflows found for this project."));
          return;
        }

        console.log(banner("WORKFLOWS"));
        console.log();

        for (const wf of workflows) {
          console.log(
            `${formatWorkflowStatus(wf.status).padEnd(12)} ${wf.id} (iteration ${wf.currentIteration}/${wf.maxIterations})`,
          );
        }
      }
    });

  workflow
    .command("kill")
    .description("Kill a running workflow and all its sessions")
    .argument("<project>", "Project ID from config")
    .argument("<issue>", "Issue identifier")
    .option("--force", "Force kill without confirmation")
    .action(async (projectId: string, issueId: string, opts: { force?: boolean }) => {
      const config = loadConfig();
      const project = config.projects[projectId];

      if (!project) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const { registry, sessionManager } = await getWorkflowDeps(config);
      const wm = createWorkflowManager({ config, registry, sessionManager });

      const workflowId = `wf-${issueId}`;
      const workflow = wm.getWorkflow(projectId, workflowId);

      if (!workflow) {
        console.error(chalk.red(`No workflow found for issue: ${issueId}`));
        process.exit(1);
      }

      if (!opts.force) {
        console.log(chalk.yellow(`About to kill workflow ${workflowId}`));
        console.log(`  Status: ${workflow.status}`);
        console.log(`  Iterations: ${workflow.iterations.length}`);
        console.log();
        console.log("Use --force to confirm.");
        process.exit(1);
      }

      const spinner = ora("Killing workflow sessions").start();
      
      try {
        await wm.killWorkflow(workflowId);
        spinner.succeed(`Workflow ${workflowId} killed`);
      } catch (err) {
        spinner.fail(`Failed to kill workflow: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  workflow
    .command("cleanup")
    .description("Cleanup workflow stage sessions while preserving workflow state")
    .argument("<project>", "Project ID from config")
    .argument("<issue>", "Issue identifier")
    .option("--force", "Force cleanup without confirmation")
    .action(async (projectId: string, issueId: string, opts: { force?: boolean }) => {
      const config = loadConfig();
      const project = config.projects[projectId];

      if (!project) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const { registry, sessionManager } = await getWorkflowDeps(config);
      const wm = createWorkflowManager({ config, registry, sessionManager });
      const workflowId = `wf-${issueId}`;
      const workflow = wm.getWorkflow(projectId, workflowId);

      if (!workflow) {
        console.error(chalk.red(`No workflow found for issue: ${issueId}`));
        process.exit(1);
      }

      if (!opts.force) {
        console.log(chalk.yellow(`About to cleanup workflow sessions for ${workflowId}`));
        console.log(`  Status: ${workflow.status}`);
        console.log("Use --force to confirm.");
        process.exit(1);
      }

      const spinner = ora("Cleaning workflow stage sessions").start();
      try {
        const killed = await cleanupWorkflowStageSessions(sessionManager, workflowId);
        spinner.succeed(`Cleaned ${killed} workflow stage session(s) for ${workflowId}`);
      } catch (err) {
        spinner.fail(
          `Failed to cleanup workflow sessions: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}
