# Subswitch refactor + test strategy plan (cautious rollout)

## Why this plan exists

`extensions/subscription-fallback/index.ts` now implements substantial behavior:
route policy, failover, return probing, setup UX, continuation fallback, command
surface, tool surface, and persisted runtime state.

To reduce future regression risk, we should split responsibilities and make
regression checks first-class in-repo.

This document proposes a **behavior-preserving**, phased path.

---

## Hard guardrails

- No intentional user-facing behavior change while refactoring.
- Keep command/tool contracts stable (`/subswitch`, `subswitch_manage`).
- Preserve severity policy (`info` for expected recovery, `warning` for hard failures).
- Preserve state schema compatibility (`subswitch-state.json`).
- Prefer small PRs with focused scope.

---

## Phase 0 (now): freeze expected behavior

Before structural refactors, codify expected behavior using committed tests.

### Behaviors to freeze

1. Manual context-blocked switch compacts then retries.
2. Automatic failover with context-blocked candidates attempts compaction bridge.
3. Hard failover stays include next-retry messaging.
4. Return-probe outcomes:
   - success switch
   - inconclusive probe + direct switch success
   - inconclusive probe + direct switch fail (info)
   - hard probe failure (warning)
5. `/subswitch explain` reflects active route + candidate ineligibility reasons.
6. `/subswitch events` renders bounded event history with reason/next retry.
7. Setup `Validate now` flow checks auth/model/context and offers fixes.
8. `continue` action/command selector validation and unavailable-`newSession` behavior.

---

## Phase 1: test harnesses in repo + CI gate

Move current ad-hoc `/tmp/test_subswitch_*.mjs` scripts into repo.

### Proposed layout

- `extensions/subscription-fallback/tests/`
  - `subswitch_manual_context_compact_test.mjs`
  - `subswitch_context_failover_test.mjs`
  - `subswitch_context_compaction_fail_test.mjs`
  - `subswitch_probe_outcomes_test.mjs`
  - `subswitch_explain_events_test.mjs`
  - `subswitch_setup_validate_now_test.mjs`
  - `subswitch_continue_test.mjs`

### Execution model

- Run via plain Node scripts (`node tests/<file>.mjs`) to keep dependency light.
- Add npm script alias (for local convenience) and CI step to run these tests
  when files under `extensions/subscription-fallback/**` change.

### CI policy suggestion

- Required for PRs touching subswitch extension files.
- Optional/skipped for unrelated extension changes.

---

## Phase 2: file/module extraction (behavior-preserving)

Split `index.ts` into focused modules while keeping public behavior identical.

### Suggested module boundaries

1. `config.ts`
   - config schema types
   - load/normalize/merge
   - legacy migration
2. `state.ts`
   - persisted runtime state IO
   - cooldown/holdoff/event persistence helpers
3. `routing.ts`
   - route resolution
   - eligibility checks
   - effective preference stack selection
4. `switching.ts`
   - `switchToRoute`
   - compaction bridge
   - failover trigger handling
5. `recovery.ts`
   - return-to-preferred probe logic
   - retry timer scheduling
6. `continuation.ts`
   - continuation target resolution
   - map-reduce/heuristic summary path
7. `ui.ts`
   - status/explain/events rendering
   - setup wizard + validate-now flow
8. `commands_tools.ts`
   - command parsing + tool actions

Keep `index.ts` as orchestration/wiring only.

---

## Phase 3: typed context wrappers (optional)

Introduce minimal typed wrappers for frequently used `ctx` capabilities:

- model registry access
- UI notifier/select helpers
- compaction + new session capabilities

Goal: reduce accidental misuse and improve readability, without changing runtime semantics.

---

## Phase 4: reliability polish (optional)

After module split is stable:

- add negative tests for malformed state/config inputs
- add small fuzz table tests for argument parsing and event-limit parsing
- add explicit regression tests for route-id stability assumptions

---

## What should be checked in and run on change?

**Yes** — the subswitch regression harnesses should be checked in and run in CI.

Reason:

- This feature has many interacting branches (triggers, cooldown, context fit,
  recovery probe classes, continuation), so manual checks are easy to miss.
- Lightweight script tests provide strong signal with low maintenance overhead.
- Keeping them in repo makes behavior expectations explicit for future refactors.

Recommended policy:

- Run full subswitch test set for PRs that touch:
  - `extensions/subscription-fallback/index.ts`
  - any future `extensions/subscription-fallback/*.ts`
  - `extensions/subscription-fallback/README.md`
  - `extensions/subscription-fallback/*design*.md` (optional docs-only mode)

---

## PR checklist for cautious subswitch refactors

1. Small scope, single responsibility.
2. No behavior changes unless explicitly intended and documented.
3. Update design docs if flow/contract changes.
4. Run subswitch regression scripts locally.
5. Ensure severity and messaging policy remains consistent.
6. Confirm no state schema break.
