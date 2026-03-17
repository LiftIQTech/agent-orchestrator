/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  SESSION_STATUS,
  PR_STATE,
  CI_STATUS,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type EventPriority,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { saveWorkflowState } from "./workflow-state.js";
import {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
  GLOBAL_PAUSE_SOURCE_KEY,
  parsePauseUntil,
} from "./global-pause.js";

const WORKFLOW_SENTINEL_PREFIX = "__AO_STAGE_DONE__";
const WORKFLOW_STAGE_IDLE_TIMEOUT_MS = 10 * 60_000;
const WORKFLOW_STAGE_TIMEOUT_MS = 60 * 60_000;

function parseWorkflowStageExitCode(output: string): number | null {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith(`${WORKFLOW_SENTINEL_PREFIX}:`)) continue;
    const code = Number.parseInt(line.slice(`${WORKFLOW_SENTINEL_PREFIX}:`.length), 10);
    return Number.isFinite(code) ? code : null;
  }
  return null;
}

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 0;
  }
}

function parseRateLimitReset(output: string): Date | null {
  if (!/usage\s+limit\s+reached/i.test(output)) return null;

  const resetMatch = output.match(
    /limit\s+will\s+reset\s+at\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{1,2})/i,
  );
  if (resetMatch) {
    const [year, month, day] = resetMatch[1].split("-").map((part) => Number.parseInt(part, 10));
    const hour = Number.parseInt(resetMatch[2], 10);
    const minute = Number.parseInt(resetMatch[3], 10);
    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day) &&
      Number.isFinite(hour) &&
      Number.isFinite(minute)
    ) {
      const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }

  const durationMatch = output.match(
    /usage\s+limit\s+reached\s+for\s+(\d+)\s*(hour|hours|hr|h|minute|minutes|min|m)/i,
  );
  if (!durationMatch) return null;
  const value = Number.parseInt(durationMatch[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = durationMatch[2].toLowerCase();
  const millis = unit.startsWith("h") ? value * 3_600_000 : value * 60_000;
  return new Date(Date.now() + millis);
}

function hasWorkflowStageTimedOut(startedAt?: string): boolean {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return false;
  return Date.now() - started >= WORKFLOW_STAGE_TIMEOUT_MS;
}

function hasWorkflowStageGoneIdle(lastActivityAt?: string): boolean {
  if (!lastActivityAt) return false;
  const last = Date.parse(lastActivityAt);
  if (Number.isNaN(last)) return false;
  return Date.now() - last >= WORKFLOW_STAGE_IDLE_TIMEOUT_MS;
}

function isWorkflowStageReadyForAdvance(session?: Session): boolean {
  if (!session) return false;
  return session.activity === "ready";
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "idle":
      return "session.idle";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.idle":
      return "agent-idle";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    default:
      return null;
  }
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  /** When set, only poll sessions belonging to this project. */
  projectId?: string;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, projectId: scopedProjectId } = deps;

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  function isOrchestratorSession(session: Session): boolean {
    return session.metadata["role"] === "orchestrator" || session.id.endsWith("-orchestrator");
  }

  function setProjectPause(project: _ProjectConfig, sourceSessionId: string, until: Date): void {
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const orchestratorId = `${project.sessionPrefix}-orchestrator`;
    const message = `Model rate limit detected from ${sourceSessionId}`;
    updateMetadata(sessionsDir, orchestratorId, {
      [GLOBAL_PAUSE_UNTIL_KEY]: until.toISOString(),
      [GLOBAL_PAUSE_REASON_KEY]: message,
      [GLOBAL_PAUSE_SOURCE_KEY]: sourceSessionId,
    });
  }

  function clearProjectPause(project: _ProjectConfig): void {
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const orchestratorId = `${project.sessionPrefix}-orchestrator`;
    updateMetadata(sessionsDir, orchestratorId, {
      [GLOBAL_PAUSE_UNTIL_KEY]: "",
      [GLOBAL_PAUSE_REASON_KEY]: "",
      [GLOBAL_PAUSE_SOURCE_KEY]: "",
    });
  }

  async function detectAndApplyRateLimitPause(
    session: Session,
    project: _ProjectConfig,
    runtime: Runtime,
  ): Promise<void> {
    if (!session.runtimeHandle) return;
    try {
      const output = await runtime.getOutput(session.runtimeHandle, 60);
      if (!output) return;
      const resetAt = parseRateLimitReset(output);
      if (!resetAt) return;
      if (resetAt.getTime() <= Date.now()) return;

      // Check if there's already an active pause from this session
      // to prevent infinite re-pause loops with duration-based rate limits
      const orchestratorId = `${project.sessionPrefix}-orchestrator`;
      const orchestratorSession = await sessionManager.get(orchestratorId);
      if (orchestratorSession) {
        const existingUntil = parsePauseUntil(orchestratorSession.metadata[GLOBAL_PAUSE_UNTIL_KEY]);
        const existingSource = orchestratorSession.metadata[GLOBAL_PAUSE_SOURCE_KEY];

        // If there's an active pause from the same session, don't override
        // This prevents extending duration-based pauses on every poll cycle
        if (
          existingUntil &&
          existingUntil.getTime() > Date.now() &&
          existingSource === session.id
        ) {
          return;
        }

        // If there's a longer pause already active from another session, keep it
        if (
          existingUntil &&
          existingUntil.getTime() > Date.now() &&
          existingUntil.getTime() >= resetAt.getTime()
        ) {
          return;
        }
      }

      setProjectPause(project, session.id, resetAt);
    } catch {
      return;
    }
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return session.status;

    const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    const runtime = session.runtimeHandle
      ? registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime)
      : null;

    // 1. Check if runtime is alive
    if (session.runtimeHandle && runtime) {
      const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
      if (!alive) return "killed";

      await detectAndApplyRateLimitPause(session, project, runtime);
    }

    // 2. Check agent activity — prefer JSONL-based detection (runtime-agnostic)
    if (agent && session.runtimeHandle) {
      try {
        // Try JSONL-based activity detection first (reads agent's session files directly)
        const activityState = await agent.getActivityState(session, config.readyThresholdMs);
        if (activityState) {
          if (activityState.state === "waiting_input") return "needs_input";
          if (activityState.state === "exited") return "killed";
          if (activityState.state === "idle") return "idle";
          // active/ready/blocked — proceed to PR checks below
        } else {
          // getActivityState returned null — fall back to terminal output parsing
          const runtime = registry.get<Runtime>(
            "runtime",
            project.runtime ?? config.defaults.runtime,
          );
          const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
          if (terminalOutput) {
            const activity = agent.detectActivity(terminalOutput);
            if (activity === "waiting_input") return "needs_input";

            const processAlive = await agent.isProcessRunning(session.runtimeHandle);
            if (!processAlive) return "killed";
          }
        }
      } catch {
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          session.status === SESSION_STATUS.STUCK ||
          session.status === SESSION_STATUS.NEEDS_INPUT
        ) {
          return session.status;
        }
      }
    }

    // 3. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    if (!session.pr && scm && session.branch && session.metadata["prAutoDetect"] !== "off") {
      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          session.pr = detectedPR;
          // Persist PR URL so subsequent polls don't need to re-query.
          // Don't write status here — step 4 below will determine the
          // correct status (merged, ci_failed, etc.) on this same cycle.
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, {
            pr: detectedPR.url,
            prBranch: detectedPR.branch,
            prBaseBranch: detectedPR.baseBranch,
          });
        }
      } catch {
        // SCM detection failed — will retry next poll
      }
    }

    // 4. Check PR state if PR exists
    const isWorkflowHostShell =
      session.metadata["agent"] === "host-shell" &&
      typeof session.metadata["workflowId"] === "string" &&
      session.metadata["workflowId"].length > 0;

    if (session.pr && scm && !isWorkflowHostShell) {
      try {
        const prState = await scm.getPRState(session.pr);
        if (prState === PR_STATE.MERGED) return "merged";
        if (prState === PR_STATE.CLOSED) return "killed";

        // Check CI
        const ciStatus = await scm.getCISummary(session.pr);
        if (ciStatus === CI_STATUS.FAILING) return "ci_failed";

        // Check reviews
        const reviewDecision = await scm.getReviewDecision(session.pr);
        if (reviewDecision === "changes_requested") return "changes_requested";
        if (reviewDecision === "approved") {
          // Check merge readiness
          const mergeReady = await scm.getMergeability(session.pr);
          if (mergeReady.mergeable) return "mergeable";
          return "approved";
        }
        if (reviewDecision === "pending") return "review_pending";

        return "pr_open";
      } catch {
        // SCM check failed — keep current status
      }
    }

    if (isWorkflowHostShell) {
      return session.status === "spawning" ? "spawning" : "working";
    }

    // 5. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === "idle" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return "working";
    }
    return session.status;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult> {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      reactionTrackers.set(trackerKey, tracker);
    }

    // Increment attempts before checking escalation
    tracker.attempts++;

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent");
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        // Auto-merge is handled by the SCM plugin
        // For now, just notify
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered auto-merge`,
          data: { reactionKey },
        });
        await notifyHuman(event, "action");
        return {
          reactionType: reactionKey,
          success: true,
          action: "auto-merge",
          escalated: false,
        };
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  function clearReactionTracker(sessionId: SessionId, reactionKey: string): void {
    reactionTrackers.delete(`${sessionId}:${reactionKey}`);
  }

  function getReactionConfigForSession(
    session: Session,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[session.projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const reactionConfig = projectReaction
      ? { ...globalReaction, ...projectReaction }
      : globalReaction;
    return reactionConfig ? (reactionConfig as ReactionConfig) : null;
  }

  function updateSessionMetadata(session: Session, updates: Partial<Record<string, string>>): void {
    const project = config.projects[session.projectId];
    if (!project) return;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, updates);

    const cleaned = Object.fromEntries(
      Object.entries(session.metadata).filter(([key]) => {
        const update = updates[key];
        return update === undefined || update !== "";
      }),
    );
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === "") continue;
      cleaned[key] = value;
    }
    session.metadata = cleaned;
  }

  function makeFingerprint(ids: string[]): string {
    return [...ids].sort().join(",");
  }

  async function maybeDispatchReviewBacklog(
    session: Session,
    oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: { key: string; result: ReactionResult | null },
  ): Promise<void> {
    // Workflow-managed sessions have their own architect/builder/reviewer loop and
    // should not receive generic review-backlog reaction injections.
    if (session.metadata["workflowId"]) return;

    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const humanReactionKey = "changes-requested";
    const automatedReactionKey = "bugbot-comments";

    if (newStatus === "merged" || newStatus === "killed") {
      clearReactionTracker(session.id, humanReactionKey);
      clearReactionTracker(session.id, automatedReactionKey);
      updateSessionMetadata(session, {
        lastPendingReviewFingerprint: "",
        lastPendingReviewDispatchHash: "",
        lastPendingReviewDispatchAt: "",
        lastAutomatedReviewFingerprint: "",
        lastAutomatedReviewDispatchHash: "",
        lastAutomatedReviewDispatchAt: "",
      });
      return;
    }

    const [pendingResult, automatedResult] = await Promise.allSettled([
      scm.getPendingComments(session.pr),
      scm.getAutomatedComments(session.pr),
    ]);

    // null means "failed to fetch" — preserve existing metadata.
    // [] means "confirmed no comments" — safe to clear.
    const pendingComments =
      pendingResult.status === "fulfilled" && Array.isArray(pendingResult.value)
        ? pendingResult.value
        : null;
    const automatedComments =
      automatedResult.status === "fulfilled" && Array.isArray(automatedResult.value)
        ? automatedResult.value
        : null;

    // --- Pending (human) review comments ---
    // null = SCM fetch failed; skip processing to preserve existing metadata.
    if (pendingComments === null) {
      console.debug(
        `[ao lifecycle] Pending comments fetch failed for ${session.id}, preserving existing metadata`,
      );
    }
    if (pendingComments !== null) {
      const pendingFingerprint = makeFingerprint(pendingComments.map((comment) => comment.id));
      const lastPendingFingerprint = session.metadata["lastPendingReviewFingerprint"] ?? "";
      const lastPendingDispatchHash = session.metadata["lastPendingReviewDispatchHash"] ?? "";

      if (
        pendingFingerprint !== lastPendingFingerprint &&
        transitionReaction?.key !== humanReactionKey
      ) {
        clearReactionTracker(session.id, humanReactionKey);
      }
      if (pendingFingerprint !== lastPendingFingerprint) {
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: pendingFingerprint,
        });
      }

      if (!pendingFingerprint) {
        clearReactionTracker(session.id, humanReactionKey);
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: "",
          lastPendingReviewDispatchHash: "",
          lastPendingReviewDispatchAt: "",
        });
      } else if (
        transitionReaction?.key === humanReactionKey &&
        transitionReaction.result?.success
      ) {
        if (lastPendingDispatchHash !== pendingFingerprint) {
          updateSessionMetadata(session, {
            lastPendingReviewDispatchHash: pendingFingerprint,
            lastPendingReviewDispatchAt: new Date().toISOString(),
          });
        }
      } else if (
        !(oldStatus !== newStatus && newStatus === "changes_requested") &&
        pendingFingerprint !== lastPendingDispatchHash
      ) {
        const reactionConfig = getReactionConfigForSession(session, humanReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await executeReaction(
            session.id,
            session.projectId,
            humanReactionKey,
            reactionConfig,
          );
          if (result.success) {
            updateSessionMetadata(session, {
              lastPendingReviewDispatchHash: pendingFingerprint,
              lastPendingReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    // --- Automated (bot) review comments ---
    // Note: automatedComments === null is expected when API fetch fails (auth, rate limit, etc.)
    // We preserve existing metadata in that case - no need to log
    if (automatedComments !== null) {
      const automatedFingerprint = makeFingerprint(automatedComments.map((comment) => comment.id));
      const lastAutomatedFingerprint = session.metadata["lastAutomatedReviewFingerprint"] ?? "";
      const lastAutomatedDispatchHash = session.metadata["lastAutomatedReviewDispatchHash"] ?? "";

      if (automatedFingerprint !== lastAutomatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: automatedFingerprint,
        });
      }

      if (!automatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: "",
          lastAutomatedReviewDispatchHash: "",
          lastAutomatedReviewDispatchAt: "",
        });
      } else if (automatedFingerprint !== lastAutomatedDispatchHash) {
        const reactionConfig = getReactionConfigForSession(session, automatedReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await executeReaction(
            session.id,
            session.projectId,
            automatedReactionKey,
            reactionConfig,
          );
          if (result.success) {
            updateSessionMetadata(session, {
              lastAutomatedReviewDispatchHash: automatedFingerprint,
              lastAutomatedReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch {
          // Notifier failed — not much we can do
        }
      }
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    const newStatus = await determineStatus(session);
    let transitionReaction: { key: string; result: ReactionResult | null } | undefined;

    if (newStatus !== oldStatus) {
      // State transition detected
      states.set(session.id, newStatus);
      updateSessionMetadata(session, { status: newStatus });

      // Reset allCompleteEmitted when any session becomes active again
      if (newStatus !== "merged" && newStatus !== "killed") {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          clearReactionTracker(session.id, oldReactionKey);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = getReactionConfigForSession(session, reactionKey);

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const reactionResult = await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
              );
              transitionReaction = { key: reactionKey, result: reactionResult };
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
        }

        // For significant transitions not already notified by a reaction, notify humans
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          if (priority !== "info") {
            const event = createEvent(eventType, {
              sessionId: session.id,
              projectId: session.projectId,
              message: `${session.id}: ${oldStatus} → ${newStatus}`,
              data: { oldStatus, newStatus },
            });
            await notifyHuman(event, priority);
          }
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
    }

    await maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction);

    // Workflow advancement is handled centrally in advanceWorkflows() per poll cycle.
  }

  /** 
   * Advance workflows that are ready for the next stage.
   * Called on each poll cycle to check if architect/builder sessions are done.
   */
  async function advanceWorkflows(sessions: Session[]): Promise<void> {
    // Check each project for workflows that need advancing
    for (const [projectId, project] of Object.entries(config.projects)) {
      const workflowEnabled = !!(project.workflow as Record<string, unknown> | undefined)?.enabled;
      if (!workflowEnabled) continue;
      
      // Import workflow manager functions
      const wm = await import("./workflow-manager.js").then(m => 
        m.createWorkflowManager({ config, registry, sessionManager })
      );
      
      const workflows = wm.listWorkflows(projectId);
      
      for (const listedWorkflow of workflows) {
        let workflow = listedWorkflow;
        // Skip completed/failed workflows
        if (workflow.status === "completed" || workflow.status === "failed") continue;

        // Deterministic guard: workflow sessions must stay on workflow.branch
        const workflowSessions = sessions.filter((s) => s.metadata["workflowId"] === workflow.id);
        const branchMismatch = workflowSessions.find(
          (s) => !!s.branch && s.branch !== workflow.branch,
        );
        if (branchMismatch) {
          await wm.killWorkflow(workflow.id);
          continue;
        }
        const prMismatch = workflowSessions.find(
          (s) =>
            !!s.pr &&
            (s.pr.branch !== workflow.branch || s.pr.baseBranch !== workflow.baseBranch),
        );
        if (prMismatch) {
          await wm.killWorkflow(workflow.id);
          continue;
        }
        
        let iteration = workflow.iterations[workflow.currentIteration - 1];
        if (!iteration) continue;

        const ownerSession = workflow.ownerSessionId
          ? sessions.find((s) => s.id === workflow.ownerSessionId)
          : undefined;

        const desiredStage = workflow.desiredStage ?? "architect";
        const desiredIteration = workflow.desiredIteration ?? workflow.currentIteration;
        const desiredBuilderIteration = workflow.desiredBuilderIteration ?? workflow.currentBuilderIteration;

        const stageSessionId =
          desiredStage === "reviewer"
            ? iteration.reviewerSession
            : desiredStage === "builder"
            ? iteration.builderSessions[Math.max(desiredBuilderIteration - 1, 0)] ?? iteration.builderSessions[iteration.builderSessions.length - 1]
            : iteration.architectSession;
        const stageSession = stageSessionId ? sessions.find((s) => s.id === stageSessionId) : ownerSession;

        const staleStageMetadata =
          ownerSession &&
          (ownerSession.metadata["workflowStage"] !== desiredStage ||
            ownerSession.metadata["workflowIteration"] !== String(desiredIteration) ||
            (desiredStage === "builder" &&
              ownerSession.metadata["builderIteration"] !== String(desiredBuilderIteration)));

        if (stageSession?.lastActivityAt) {
          const activityAt = stageSession.lastActivityAt.toISOString();
          if (!workflow.lastStageActivityAt || Date.parse(activityAt) > Date.parse(workflow.lastStageActivityAt)) {
            workflow.lastStageActivityAt = activityAt;
            saveWorkflowState(config.configPath, project.path, workflow);
          }
        }

        const stageTimedOut = hasWorkflowStageTimedOut(workflow.dispatchStartedAt);
        const stageGoneIdle = hasWorkflowStageGoneIdle(workflow.lastStageActivityAt);

        const stagePending = workflow.dispatchStatus === "pending";
        const shouldResumePendingStage =
          stagePending && (!ownerSession || ownerSession.activity === "ready" || staleStageMetadata);

        if ((stageTimedOut || stageGoneIdle) && ownerSession) {
          try {
            await sessionManager.kill(ownerSession.id, { purgeOpenCode: false });
          } catch {
            // Best effort kill before resume.
          }
          workflow.ownerSessionId = "";
          workflow.dispatchStatus = "pending";
          saveWorkflowState(config.configPath, project.path, workflow);
        }

        if (!ownerSession || ownerSession.activity === "ready" || staleStageMetadata || stageTimedOut || stageGoneIdle || shouldResumePendingStage) {
          try {
            workflow = await wm.resumeWorkflow(workflow.id);
            iteration = workflow.iterations[workflow.currentIteration - 1];
            if (!iteration) continue;
          } catch (err) {
            console.error(`[ao lifecycle] Failed to resume workflow ${workflow.id}:`, err);
          }
        }
         
        // Check if architect is done and we're still in planning
        if (workflow.status === "planning" && iteration.architectSession) {
          const architectSession = sessions.find(s => s.id === iteration.architectSession);
          if (architectSession?.runtimeHandle && isWorkflowStageReadyForAdvance(architectSession)) {
            try {
              const runtime = registry.get<Runtime>(
                "runtime",
                architectSession.runtimeHandle.runtimeName ??
                  config.projects[architectSession.projectId]?.runtime ??
                  config.defaults.runtime,
              );
              const output = runtime
                ? await runtime.getOutput(architectSession.runtimeHandle, 120)
                : "";
              const exitCode = parseWorkflowStageExitCode(output);
              if (exitCode === 0) {
                await wm.spawnNextBuilder(workflow.id);
              }
            } catch (err) {
              console.error(`[ao lifecycle] Failed to advance workflow ${workflow.id}:`, err);
            }
          }
        }
        
        // Check if builder is done and we're still in building
        if (workflow.status === "building" && iteration.builderSessions.length > 0) {
          const lastBuilderId = iteration.builderSessions[iteration.builderSessions.length - 1];
          const builderSession = sessions.find(s => s.id === lastBuilderId);
          if (builderSession?.runtimeHandle && isWorkflowStageReadyForAdvance(builderSession)) {
            try {
              const runtime = registry.get<Runtime>(
                "runtime",
                builderSession.runtimeHandle.runtimeName ??
                  config.projects[builderSession.projectId]?.runtime ??
                  config.defaults.runtime,
              );
              const output = runtime
                ? await runtime.getOutput(builderSession.runtimeHandle, 120)
                : "";
              const exitCode = parseWorkflowStageExitCode(output);
              if (exitCode === 0) {
                await wm.spawnNextBuilder(workflow.id);
              }
            } catch (err) {
              console.error(`[ao lifecycle] Failed to advance workflow ${workflow.id}:`, err);
            }
          }
        }
        
        // Check if reviewer is done
        if (workflow.status === "reviewing" && iteration.reviewerSession) {
          const reviewerSession = sessions.find(s => s.id === iteration.reviewerSession);
          if (reviewerSession?.runtimeHandle && isWorkflowStageReadyForAdvance(reviewerSession)) {
            try {
              const runtime = registry.get<Runtime>(
                "runtime",
                reviewerSession.runtimeHandle.runtimeName ??
                  config.projects[reviewerSession.projectId]?.runtime ??
                  config.defaults.runtime,
              );
              const output = runtime
                ? await runtime.getOutput(reviewerSession.runtimeHandle, 120)
                : "";
              const exitCode = parseWorkflowStageExitCode(output);
              if (exitCode !== 0) {
                continue;
              }

              // Check CODE_REVIEW_FINDINGS.md for verdict
              const reviewPath = iteration.reviewFindingsPath;
              if (reviewPath) {
                if (!existsSync(reviewPath)) {
                  continue;
                }

                const reviewContent = readFileSync(reviewPath, "utf-8");
                const hasPlaceholder = reviewContent.includes("(Pending reviewer output)");
                const isApproved = reviewContent.includes("APPROVED") || 
                                   reviewContent.includes("VERDICT: APPROVED");
                const isChangesRequested = reviewContent.includes("CHANGES REQUESTED") ||
                                           reviewContent.includes("VERDICT: CHANGES REQUESTED");
                
                if (hasPlaceholder) {
                  continue;
                } else if (isApproved) {
                  await wm.handleReviewComplete(workflow.id, true);
                } else if (isChangesRequested) {
                  await wm.handleReviewComplete(workflow.id, false, reviewContent);
                } else {
                  continue;
                }
              }
            } catch (err) {
              console.error(`[ao lifecycle] Failed to handle review complete for ${workflow.id}:`, err);
            }
          }
        }
      }
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list(scopedProjectId);

      const pausedProjects = new Map<string, Date>();
      for (const session of sessions) {
        if (!isOrchestratorSession(session)) continue;
        const until = parsePauseUntil(session.metadata[GLOBAL_PAUSE_UNTIL_KEY]);
        if (!until) continue;
        if (until.getTime() <= Date.now()) {
          const project = config.projects[session.projectId];
          if (project) {
            clearProjectPause(project);
          }
          continue;
        }
        pausedProjects.set(session.projectId, until);
      }

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (pausedProjects.has(s.projectId) && !isOrchestratorSession(s)) {
          return false;
        }
        if (s.status !== "merged" && s.status !== "killed") return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }

      // ==========================================================================
      // WORKFLOW ADVANCEMENT
      // Check for workflows that need advancing (architect done → builder, etc.)
      // ==========================================================================
      await advanceWorkflows(sessions);

      // Check if all sessions are complete (trigger reaction only once)
      const activeSessions = sessions.filter((s) => s.status !== "merged" && s.status !== "killed");
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction("system", "all", reactionKey, reactionConfig as ReactionConfig);
            }
          }
        }
      }
    } catch (err) {
      console.error("[ao lifecycle] Poll cycle failed:", err);
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },
  };
}
