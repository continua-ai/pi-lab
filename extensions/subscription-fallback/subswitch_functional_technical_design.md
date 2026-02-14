# Subswitch functional + technical design

## Scope

Feature: `subscription-fallback` extension (`/subswitch`)

Primary implementation: `extensions/subscription-fallback/index.ts`

This document describes:

1. Full user-facing functionality
2. The technical design implementing it
3. Runtime config and state model
4. Observability/loop-closing hooks
5. Known tradeoffs and failure modes
6. Maintenance checklist
7. Delta for this PR

---

## 1) User-facing functionality

### 1.1 Goal

Keep conversations moving by switching across configured vendor/account routes
when a route is unavailable (rate limit, quota exhausted, API-key auth failure),
while preserving explicit routing policy and clear status.

### 1.2 Supported routing model

- Multi-vendor (`openai`, `claude`/`anthropic`)
- Multiple routes per vendor
  - `oauth`
  - `api_key`
- Global preference stack (`preference_stack`) using stable `route_id`
- Optional per-stack model pin; otherwise follows active `/model`

### 1.3 Core `/subswitch` commands

- `/subswitch` (quick picker)
- `/subswitch status`
- `/subswitch longstatus`
- `/subswitch explain`
- `/subswitch events [limit]`
- `/subswitch setup`
- `/subswitch login`
- `/subswitch login-status`
- `/subswitch reload`
- `/subswitch on` / `/subswitch off`
- `/subswitch use <vendor> <auth_type> <label> [modelId]`
- `/subswitch subscription <vendor> [label] [modelId]`
- `/subswitch api <vendor> [label] [modelId]`
- `/subswitch continue [vendor auth_type label [modelId]]`
- `/subswitch rename <vendor> <auth_type> <old_label> <new_label>`
- `/subswitch reorder [vendor]`
- `/subswitch edit`
- `/subswitch models <vendor>`

Compatibility aliases:

- `primary` -> `subscription`
- `fallback` -> `api`

### 1.4 Setup + validation UX

`/subswitch setup` is apply-on-finish and supports back/cancel.

Final step provides:

- **Finish setup**
- **Validate now**
- **OAuth login checklist**

Validate-now checks/fixes:

- OAuth login completeness
- API key credential/env presence
- Current model compatibility
- Context-blocked candidate detection
- Actions: run login flow, show env vars, switch to compatible model,
  compact now

### 1.5 Failover UX

On trigger:

- route cooldown is set
- next eligible fallback route is selected
- context-blocked candidates can trigger compaction first
- switch happens when possible
- optional auto-retry of last prompt after successful automatic switch

User messaging severity policy:

- `info`: expected recovery/progression
- `warning`: hard failures or blocked outcomes

### 1.6 Return-to-preferred UX

When enabled:

- background idle checks probe preferred route health
- probe outcomes:
  - success -> switch back
  - inconclusive probe -> direct switch attempt
  - failure -> stay and retry later
- inconclusive is treated as expected recovery path (info tone)

### 1.7 Explain + events UX

- `/subswitch explain`
  - active route/model
  - effective candidate stack
  - explicit ineligibility reasons (cooldown/model/credentials/context)
  - next fallback candidate
- `/subswitch events [N]`
  - recent routing decisions with local timestamp, level, reason,
    and next retry time (if present)

### 1.8 Tool bridge (`subswitch_manage`)

Actions:

- `status`, `longstatus`, `explain`, `events`
- `use`, `prefer`, `rename`
- `reload`, `continue`

---

## 2) Technical design

### 2.1 Main architecture

Single extension module with:

- config normalization/merge
- route resolution + eligibility checks
- model/provider switching
- cooldown and return-holdoff logic
- command + tool handlers
- UI surfaces (status, widgets, notifications)
- persisted runtime state

Key entry points:

- `pi.registerCommand("subswitch", ...)`
- `pi.registerTool({ name: "subswitch_manage", ... })`
- `pi.on("turn_end", ...)` for failover trigger handling
- `pi.on("session_start"|"session_switch"|"session_end", ...)`

### 2.2 Route selection and eligibility

Core selection is based on effective preference stack entries
(route + resolved model).

Eligibility reason engine:

- `routeIneligibleReason(...)`
- reasons include:
  - cooldown
  - model unavailable
  - missing credentials
  - context too large

Context-fit utilities:

- `contextFitForRouteModel(...)`
- `findNextEligibleFallback(...)`
- `contextFitSummary(...)`

### 2.3 Switching pipeline

Primary switch function:

- `switchToRoute(ctx, vendor, routeIndex, modelId, reason, notify)`

Switch path includes:

1. model compatibility checks
2. credential materialization (`api_key` routes)
3. context-fit check
4. optional compaction (`runSwitchCompaction`) and re-check
5. `pi.setModel(...)`
6. state updates + status + retry timer

### 2.4 Failover trigger pipeline

`turn_end` error handling detects configured triggers:

- rate limit
- quota exhausted
- auth error (API-key route)

Then:

1. cooldown assignment (`setRouteCooldownUntil`)
2. candidate selection via effective stack
3. optional compaction bridge if only context-blocked candidates exist
4. switch attempt
5. optional last-prompt auto-retry

### 2.5 Return-to-preferred pipeline

Background recovery uses:

- `requestBackgroundPreferredRouteCheck(...)`
- `maybePromotePreferredRoute(...)`
- probing via `probeRouteModel(...)`

Probe classification distinguishes hard failures from inconclusive outcomes.

### 2.6 Continuation fallback pipeline

User/tool initiated continuation:

- target resolution: `resolveContinuationTarget(...)`
- summary generation:
  - map-reduce attempt (`generateContinuationSummary`)
  - heuristic fallback (`buildHeuristicContinuationSummary`)
- new session creation (`ctx.newSession()`)
- route switch in new session
- carryover message injection + optional resend of latest prompt

### 2.7 Decision event model

Decision events are appended via `notifyDecision(...)` and persisted.

Event record fields:

- timestamp
- kind
- level
- message
- optional reason
- optional next retry time

Rendered by:

- `buildDecisionEventLines(...)`

---

## 3) Runtime config and state

### 3.1 Config files

Merge order:

1. `~/.pi/agent/subswitch.json`
2. `<cwd>/.pi/subswitch.json`

Top-level project values override global values.
Vendor lists merge by vendor key.

### 3.2 Runtime state files

- `~/.pi/agent/subswitch-state.json`
- `<cwd>/.pi/subswitch-state.json`

State includes:

- per-route cooldown expiries
- next preferred-route return eligibility time
- bounded decision-event history

### 3.3 Key invariants

- `route_id` must stay stable for cooldown/state continuity.
- Preference stack entries resolve through normalized route IDs.
- Event history remains bounded.
- Retrying preferred route is gated by holdoff and idle conditions.

---

## 4) Observability and loop-closing hooks

User-visible surfaces:

- `/subswitch status` (concise)
- `/subswitch longstatus` (detailed)
- `/subswitch explain`
- `/subswitch events`
- status widget + OAuth reminder widget

Machine-usable surface:

- `subswitch_manage` tool actions for status/explain/events/control

These hooks support autonomous verification of routing decisions and retry plans
without relying only on UI inference.

---

## 5) Tradeoffs and gotchas

- Context-fit estimates are conservative heuristics, not perfect tokenizer parity.
- Runtime model metadata may not capture all account-tier limits.
- Continuation fallback is explicit (`/subswitch continue`), not yet always
  auto-invoked when all automatic paths are exhausted.
- OAuth/API credential health depends on external auth/env state.

---

## 6) Maintenance checklist

When changing subswitch behavior:

1. Update command help and tool action descriptions.
2. Keep `/status`, `/longstatus`, `/explain`, and `/events` mutually consistent.
3. Preserve severity policy (`info` expected recovery, `warning` hard failure).
4. Keep runtime state schema backward-compatible.
5. Verify cooldown/holdoff timer behavior after changes.
6. Validate continuation flow in contexts where `newSession` is unavailable.
7. Update docs in this directory and root `README.md` blurb when UX changes.

---

## 7) Changed in this PR (delta)

This PR is intentionally behavior-preserving and focused on clarity/maintainability:

- Refactored duplicate event-limit parsing into `parseDecisionEventLimit(...)`.
- Refactored duplicate continuation-selector checks into:
  - `hasExplicitContinuationSelector(...)`
  - `isCompleteContinuationSelector(...)`
- Refactored duplicate compatible-model intersection logic into
  `compatibleModelsAcrossVendorRoutes(...)` and reused it in:
  - `/subswitch models`
  - setup validation
- Added clarifying comments around shared model-compatibility computation.

No intended routing-policy or failover-behavior changes.
