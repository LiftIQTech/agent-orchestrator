import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Agent,
  AgentLaunchConfig,
  AgentSessionInfo,
  ActivityDetection,
  ActivityState,
  PluginModule,
  RuntimeHandle,
  Session,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);
const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish"]);

async function tmuxCurrentCommand(handle: RuntimeHandle): Promise<string | null> {
  if (handle.runtimeName !== "tmux" || !handle.id) return null;
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-p", "-t", handle.id, "#{pane_current_command}"],
      { timeout: 5_000 },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export const manifest = {
  name: "host-shell",
  slot: "agent" as const,
  description: "Agent plugin: persistent shell host for discrete workflow commands",
  version: "0.1.0",
};

function createHostShellAgent(): Agent {
  return {
    name: "host-shell",
    processName: "bash",

    getLaunchCommand(_config: AgentLaunchConfig): string {
      return "bash --noprofile --norc -i";
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {
        AO_SESSION_ID: config.sessionId,
      };
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(_terminalOutput: string): ActivityState {
      return "active";
    },

    async getActivityState(session: Session): Promise<ActivityDetection | null> {
      if (!session.runtimeHandle) {
        return { state: "exited", timestamp: new Date() };
      }
      const currentCommand = await tmuxCurrentCommand(session.runtimeHandle);
      if (!currentCommand) {
        return { state: "exited", timestamp: new Date() };
      }
      if (SHELL_COMMANDS.has(currentCommand)) {
        return { state: "ready", timestamp: new Date() };
      }
      return { state: "active", timestamp: new Date() };
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const currentCommand = await tmuxCurrentCommand(handle);
      return currentCommand !== null;
    },

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      return null;
    },
  };
}

export function create(): Agent {
  return createHostShellAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
