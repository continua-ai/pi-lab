# subswitch context-window failover design

## Problem

Subswitch can fail over from one route/model to another when a provider hits rate limits, quota limits, or auth failures.

A hard edge case appears when the current conversation is large and the target model has a smaller context window.

Example:

- current route/model can handle ~250k+ context
- fallback route/model can handle ~200k
- switching fails before the target model can compact

## Goals

- Prevent dead-end failovers caused by context-window mismatch.
- Keep user experience smooth and explicit (what happened + what happens next).
- Use only runtime information available in pi extension context.

## Non-goals

- Perfect cross-tokenizer token accounting.
- Account-tier-specific context limits that are not exposed by runtime model metadata.

## Runtime signals available

- Current usage estimate from `ctx.getContextUsage()`.
- Target model metadata from `ctx.modelRegistry.find(...).contextWindow`.
- Current provider/model from `ctx.model`.
- Ability to trigger compaction via `ctx.compact(...)`.

## Proposed failover strategy

### 1) Context-fit route eligibility gate

When evaluating candidate routes in preference stack order, mark a candidate ineligible if it is:

1. cooling down
2. model-incompatible
3. missing credentials
4. context-window-incompatible

Context compatibility uses conservative estimation:

- apply a multiplier to current usage
  - same provider: lighter multiplier
  - cross-provider: larger multiplier
- reserve headroom for system/tools/output
- require estimated target input <= safe target budget

### 2) Bridge compaction + retry

If no fallback route is eligible and one or more routes are blocked by context size:

1. compact on the current route (while still on the current model)
2. re-evaluate candidate eligibility
3. fail over if a route becomes eligible

If a direct switch attempt is context-blocked (e.g. manual `/subswitch use`), compact first and retry the switch.

### 3) Continuation fallback (design target)

If current route cannot compact and no route can fit context:

- start a continuation session with reduced carryover
  - last user intent
  - compacted state summary
  - unresolved tasks + constraints

For very large histories, use hierarchical map-reduce compaction:

1. split history into chunks that fit a helper route
2. summarize chunks independently
3. merge summaries
4. recurse if merge output is still too large

This is intentionally staged for later work.

### 4) Return-to-preferred behavior

Return probing should respect context-fit eligibility as well.

If preferred route is context-blocked, remain on fallback and surface status as context-related (not auth/quota failure).

## User-facing behavior

- Status/longstatus can show `context too large for target model`.
- Failure notifications should include retry timing.
- Context-blocked failover paths should explicitly say when compaction is attempted.

## This PR implements

- Context-fit eligibility in route selection.
- Context-blocked detection in failover selection.
- Automatic compaction-and-retry path before failover retry.
- Pre-switch compaction-and-retry for direct route switches.
- Status state: `context too large for target model`.

## Follow-up work

- Continuation fallback session flow when compaction is impossible.
- Hierarchical map-reduce compaction pipeline for extreme histories.
- Better per-provider/account window metadata (if runtime exposes it).
