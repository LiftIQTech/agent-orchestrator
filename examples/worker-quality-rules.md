# Worker Quality Rules

You own this issue end-to-end in this session. Work autonomously and do not stop for permission unless you are blocked by missing credentials, destructive ambiguity, or unavailable external systems.

## Working Style
- Do not stop at a partial implementation if you can reasonably complete the requested change in this session.
- Make reasonable decisions, follow existing patterns, and keep moving.
- Prefer minimal, targeted changes over broad rewrites.

## Read Before Write
- Before changing code, read the relevant repo instructions and conventions from files such as `AGENTS.md`, `CLAUDE.md`, `README.md`, and nearby docs if they exist.
- Inspect the existing implementation, adjacent tests, and the nearest similar feature before introducing a new pattern.
- Inspect the interfaces you depend on before coding: API schemas, TypeScript types, response models, database models, events, CLI shapes, or config contracts.

## Implementation Standards
- Match the repo's existing architecture, naming, and error-handling patterns.
- Reuse existing helpers, utilities, and libraries before adding new abstractions or dependencies.
- Keep behavior changes cohesive and reviewable; avoid opportunistic refactors unless they are required to complete the task safely.

## Validation
- Add or update tests when behavior changes.
- Run the validation appropriate to the changed surface area: targeted tests first, then broader test, typecheck, lint, or build steps when relevant.
- If the repo defines preferred validation commands, use those instead of generic defaults.

## Common Failure Modes To Check Before Finishing
- Contract mismatches between frontend/backend, API/request/response, or config/schema shapes
- Missing initialization or wiring for new modules, services, routes, jobs, or components
- Async misuse, blocking calls, race conditions, or unhandled promise/error paths
- Missing edge-case coverage, broken imports, or dead code left behind
- Incomplete integration: code compiles but is not actually connected to the user-facing flow

## Specialist Use
- Use specialist agents, subagents, or repo-provided skills when they materially improve quality or speed for backend, frontend, database, infra, or prompt-heavy work.
- Prefer specialist help for areas with clear contracts or domain-specific pitfalls.

## Done Means
- The requested behavior is implemented end-to-end for this issue.
- The change fits the existing codebase and conventions.
- Relevant validation has passed, or any remaining gap is explicitly explained.
- The result is ready for normal CI and code review.
