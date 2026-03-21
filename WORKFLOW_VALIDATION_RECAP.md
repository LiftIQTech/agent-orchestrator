# Workflow Validation Recap

Date: 2026-03-17

## Goal

Validate the architect-delivery workflow end to end in a real test environment, harden recovery/resume behavior, make backlog-triggered issues flow automatically, and clean up the GitHub/dashboard lifecycle so future projects are observable and trustworthy.

## What We Focused On

1. Fix workflow recovery after session loss, tmux loss, process restarts, and stale owner metadata.
2. Prove the fixes live against real LiftIQ issues.
3. Make newly labeled backlog issues start automatically through the web backlog path.
4. Ensure workflow branches and draft PRs become visible early.
5. Clean up final lifecycle handling for completed non-auto-merge workflows.
6. Reduce dashboard confusion from duplicate PR rows and stale completed sessions.

## Core Problems We Found

### 1. Recovery logic was incomplete

- A builder could finish real work, update artifacts, and still fail to advance if the owner shell died before the orchestrator noticed.
- `resumeWorkflow()` did not have a path for "builder already complete from artifacts; owner shell gone".
- Stale persisted intent (`desiredStage`, `desiredIteration`) could also send resume logic down the wrong path.

### 2. Worktree recovery was brittle

- Some workflows ended up pointing at broken directories that still contained `.architect-delivery` artifacts but were no longer valid git worktrees.
- Owner sessions could remain bound to stale or deleted worktree paths.

### 3. New issues were not truly flowing from backlog

- The web backlog service initially failed with `Agent plugin 'host-shell' not found`.
- Even after that fix, the AO web runtime had stale/broken Next processes and runtime bundle issues that prevented `/api/backlog` from working reliably.

### 4. Early PR visibility was weak

- Fresh workflow branches with no commits caused draft PR creation to fail with `No commits between ...`.
- That meant users could not see whether a workflow had truly started.

### 5. Completed workflows did not transition cleanly in GitHub

- Workflows could complete internally while issues still showed `agent:in-progress`.
- Draft PRs remained draft even when work was complete and ready for human review.

### 6. Dashboard state was confusing

- Open PRs could be shown multiple times because multiple sessions referenced the same PR.
- Completed workflow owner sessions could still show up as active/pending.
- Review/pending semantics were not clean enough for completed workflows.

## Major Fixes Implemented

### Workflow recovery and resume

Implemented in core workflow/session logic:

- builder artifact-based advancement after owner-session loss
- stale desired-stage normalization during resume
- owner session respawn/rebind improvements
- recovered owner metadata restamping
- active worktree artifact rebinding when sessions resume on a new valid worktree

Key files:

- `packages/core/src/workflow-manager.ts`
- `packages/core/src/session-manager.ts`
- `packages/core/src/workflow-state.ts`
- `packages/core/src/types.ts`

### Worktree resilience

Implemented safer worktree restore/reuse behavior:

- preserve `.architect-delivery` while recreating broken non-git worktree directories
- reuse an already-attached worktree when checkout/add reveals the branch is already attached elsewhere

Key files:

- `packages/plugins/workspace-worktree/src/index.ts`
- `packages/plugins/workspace-worktree/src/__tests__/index.test.ts`

### Backlog pickup and web services

Fixed the web backlog service so it can actually start workflow owner sessions:

- registered `host-shell` in web services
- rebuilt/stabilized the web runtime enough to prove `/api/backlog` live

Key files:

- `packages/web/src/lib/services.ts`
- `packages/web/src/__tests__/services.test.ts`
- `packages/plugins/agent-host-shell/`

### Early branch and draft PR visibility

Added bootstrap commit behavior so workflows can create a deterministic draft PR immediately even before real implementation commits exist.

Key files:

- `packages/core/src/workflow-manager.ts`
- `packages/core/src/__tests__/lifecycle-manager.test.ts`

### Completion lifecycle for non-auto-merge workflows

Added a better handoff state:

- issue moves to `agent:pending-merge`
- PR is marked ready for review (non-draft)
- merged-flow logic removes `agent:pending-merge`

Key files:

- `packages/core/src/workflow-manager.ts`
- `packages/plugins/scm-github/src/index.ts`
- `packages/plugins/scm-github/test/index.test.ts`
- `packages/web/src/app/api/setup-labels/route.ts`
- `packages/web/src/lib/services.ts`

### Dashboard cleanup

Improved dashboard behavior by:

- deduping open PR rows by PR number
- deduping open-PR stats / needs-review stats
- ensuring completed workflow owner sessions are cleaned up instead of lingering as active/pending

Key files:

- `packages/web/src/components/Dashboard.tsx`
- `packages/web/src/lib/serialize.ts`
- `packages/web/src/lib/__tests__/serialize.test.ts`
- `packages/core/src/workflow-manager.ts`

## Live Validation Results

### Issue 641

- Used as the main proof target for recovery/resume hardening.
- Exposed real recovery bugs that were then fixed.
- Ended in a valid workflow PR state on `#684`.

### Issue 645

- Workflow completed internally.
- Initially left in stale GitHub state.
- Corrected final state:
  - issue label: `agent:pending-merge`
  - PR `#686`: open, non-draft, ready for review

### Issue 646

- Initially failed to flow from backlog because web backlog runtime was broken.
- After fixes:
  - issue moved from `agent:backlog` to `agent:in-progress`
  - workflow `wf-646` started
  - branch `feat/646` was created
  - deterministic workflow PR `#687` was created
  - architect -> builder -> reviewer flow completed
  - final corrected state:
    - issue label: `agent:pending-merge`
    - PR `#687`: open, non-draft, ready for review

## Final Verified State

At wrap-up:

- `645` is in `agent:pending-merge`
- `646` is in `agent:pending-merge`
- `#686` is open and non-draft
- `#687` is open and non-draft
- `ao status` shows no active sessions for the completed workflows
- dashboard duplicate PR rendering was addressed in code and validated by tests

## Validation Performed

Repeatedly validated with:

- core lifecycle tests
- web tests
- SCM GitHub plugin tests
- core typecheck
- core build
- web build
- CLI build
- live AO workflow status checks
- live tmux inspection
- live GitHub issue/PR inspection
- live backlog route validation on port `3001`

## Commit Reference

Pushed commit:

- `f65aa92` — `fix: stabilize workflow lifecycle visibility`

## Operational Notes For Future Sessions

### Recommended issue lifecycle

For non-auto-merge projects:

1. `agent:backlog`
2. `agent:in-progress`
3. `agent:pending-merge`
4. `merged-unverified`
5. `agent:done`

### What to verify on a fresh issue

When testing a new issue, confirm in this order:

1. Issue label flips from `agent:backlog` to `agent:in-progress`.
2. `ao workflow status <project> <issue>` shows `planning` or `building`.
3. A host-shell owner session exists in tmux.
4. Local and remote workflow branch exist.
5. Deterministic draft PR exists.
6. Workflow progresses through architect/builder/reviewer.
7. On completion, issue moves to `agent:pending-merge` and PR becomes non-draft.
8. Completed workflow sessions do not linger as active in the dashboard.

### Remaining caveat

- `ao start` still launches the dashboard in dev mode, not a hardened production mode. The live flow is working, but that startup path is still worth revisiting later for maximum runtime stability.

## Short Summary

This session turned the workflow system from partially working and hard to trust into a much more durable, observable pipeline:

- recovery works better
- backlog pickup works
- deterministic PR visibility works
- completed workflows hand off to a clean review state
- dashboard duplication and stale-session confusion are substantially reduced

Use this document as the baseline reference before running the next new project through the system.
