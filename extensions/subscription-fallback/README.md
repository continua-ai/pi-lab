# subscription-fallback (pi extension)

`/subswitch` is a vendor/account/model failover manager for pi.

It is designed to keep conversations moving when a route is rate-limited,
quota-limited, or otherwise unavailable, while preserving predictable routing
policy and clear user-facing status.

## What it does (full feature list)

- Multi-vendor routing (currently `openai`, `claude`/`anthropic`).
- Multiple routes per vendor (`oauth`, `api_key`).
- Global preference stack failover by stable `route_id` (+ optional model override).
- Configurable failover triggers:
  - `rate_limit`
  - `quota_exhausted`
  - `auth_error` (API-key routes only)
- Return-to-preferred logic with holdoff and background health checks.
- Pre-return probing with safe handling:
  - probe success -> switch back
  - probe inconclusive (timeout/abort) -> attempt direct switch anyway
  - probe failure -> stay on fallback and retry later
- Context-window-aware switching:
  - marks over-small routes ineligible for current context
  - attempts compaction before retrying context-blocked switches
  - does this for both manual switch and automatic failover selection
- Automatic retry of the last prompt after successful automatic failover when
  `auto_retry=true` for that vendor.
- Persisted runtime state across reloads/restarts:
  - per-route cooldowns
  - return holdoff (`next_return_eligible_at_ms`)
- Concise + detailed status surfaces with colorized state.
- Guided setup wizard (apply-on-finish; cancel leaves existing config unchanged).
- OAuth login reminder widget + `/subswitch login` flow.
- LLM-callable tool bridge: `subswitch_manage`.

---

## Install / update

### Recommended: pi package install

```bash
pi install git:github.com/continua-ai/pi-lab
```

Then restart pi or run:

```text
/reload
```

`/reload` reloads extension code/resources.

### Alternative: manual global extension copy

```bash
mkdir -p ~/.pi/agent/extensions/subscription-fallback
cp extensions/subscription-fallback/index.ts ~/.pi/agent/extensions/subscription-fallback/index.ts
```

Then run `/reload`.

---

## Core concepts

### Route

A route is an account/auth lane for a vendor.

- `auth_type: oauth` routes use pi OAuth credentials for `provider_id`.
- `auth_type: api_key` routes use API key material from env/path/inline config.

### `provider_id` vs route `id`

- `provider_id`: runtime model provider alias used by pi model registry.
- route `id`: stable policy identity used in `preference_stack` and persisted state.

Keep route `id` stable so cooldown/holdoff state remains consistent.

### Preference stack

`preference_stack` defines strict failover order.
Each entry references a route by `route_id` and can optionally pin `model`.
If `model` is omitted, subswitch follows current `/model`.

---

## Quick setup (recommended)

1. Run `/subswitch setup`.
2. Choose config destination (global or project).
3. Configure vendors and route labels.
4. Set failover policy options.
5. Review/reorder preference stack.
6. Finish setup (writes config atomically only at the end).
7. Run `/subswitch login` and complete OAuth login(s) via `/login`.
8. Ensure API-key env vars exist for `api_key` routes.
9. Verify:
   - `/subswitch login-status`
   - `/subswitch status`
   - `/subswitch longstatus`

Wizard behavior notes:

- Back navigation is supported across screens.
- `Continue` is first in toggle menus for Enter-safe progression.
- Route IDs are preserved where possible when editing existing vendor routes.

---

## How failover works

When a turn ends with an error, subswitch evaluates configured triggers.

If triggered:

1. Current route is placed on cooldown.
   - Uses provider retry hints when available.
   - Otherwise uses configured cooldown for route/vendor.
2. It selects the next eligible lower-priority stack entry.
3. If candidates are blocked by context size, it compacts current session and retries selection.
4. It switches to the selected route/model.
5. If `auto_retry=true` for current vendor, it re-sends last prompt automatically.

### Eligibility checks for candidate routes

A route is eligible only if all are true:

- not cooling down
- model is available on route provider
- credentials are usable
- context fits target model window (conservative fit estimate)

### Context-window-aware behavior

Subswitch estimates whether current context can fit target model safely.
If not, it will:

- mark route as context-blocked (`context too large for target model`)
- attempt compaction before retrying selection/switch
- emit explicit user messaging about context block and retry plan

> Current implementation uses runtime model metadata (`contextWindow`) and
> conservative heuristics. Account-tier-specific limits not exposed by runtime
> metadata may still differ.

---

## Return-to-preferred behavior

If `failover.return_to_preferred.enabled=true`, subswitch can return upward in
preference stack after `min_stable_minutes` holdoff.

Return checks run in idle/background paths (not awaited on prompt start).

Flow:

1. Wait until holdoff expires.
2. Probe preferred candidate route/model.
3. Outcomes:
   - success: switch to preferred route
   - inconclusive probe (timeout/abort): attempt direct switch anyway
   - failure: stay on fallback, set short cooldown, retry later

Notifications are phrased to distinguish normal inconclusive recovery vs hard
failure, and include next-check timing.

---

## Runtime state + file locations

### Config merge order

1. Global: `~/.pi/agent/subswitch.json`
2. Project: `./.pi/subswitch.json`

Project overrides top-level global keys. Vendor lists merge by vendor name.

If no `subswitch.json` exists, subswitch attempts runtime migration from legacy
`subscription-fallback.json` shape.

### Runtime state files

State includes route cooldowns + return holdoff:

- Global: `~/.pi/agent/subswitch-state.json`
- Project: `./.pi/subswitch-state.json`

State keying is based on route `id`.

### Reload semantics

- `/subswitch reload` -> reload config + runtime state from disk.
- `/reload` -> reload extension code/resources (full runtime reload).

State is loaded on session start/switch and on `/subswitch reload`.
State is persisted on session shutdown and when cooldown/holdoff values change.

---

## Commands

All control is via `/subswitch`.

### Primary commands

- `/subswitch`
  - Quick picker + status.
- `/subswitch status`
  - Concise, stack-first status.
- `/subswitch longstatus`
  - Detailed status (models, provider IDs, route IDs, per-vendor route view).
- `/subswitch help`
  - Print command help.
- `/subswitch setup`
  - Guided setup wizard.
- `/subswitch login`
  - OAuth login checklist + optional `/login` prefill.
- `/subswitch login-status`
  - Re-check OAuth completion and update reminder widget.
- `/subswitch reload`
  - Reload config + runtime state.
- `/subswitch on` / `/subswitch off`
  - Runtime enable/disable for current session.

### Route selection commands

- `/subswitch use <vendor> <auth_type> <label> [modelId]`
  - Force a specific route.
- `/subswitch subscription <vendor> [label] [modelId]`
  - Use OAuth route.
- `/subswitch api <vendor> [label] [modelId]`
  - Use API-key route.

### Config editing commands

- `/subswitch rename <vendor> <auth_type> <old_label> <new_label>`
- `/subswitch reorder [vendor]`
- `/subswitch edit`
- `/subswitch models <vendor>`

### Compatibility aliases

- `/subswitch primary ...` -> `subscription` (deprecated)
- `/subswitch fallback ...` -> `api` (deprecated)

---

## LLM tool bridge

Tool name: `subswitch_manage`

Supported actions:

- `status`
- `longstatus`
- `reload`
- `use`
- `prefer`
- `rename`

Parameters:

- `vendor`
- `auth_type` (`oauth` | `api_key`)
- `label`
- `model_id` (optional)
- `old_label` / `new_label` (rename)

---

## Config schema (v2)

```json
{
  "enabled": true,
  "default_vendor": "openai",
  "rate_limit_patterns": [],
  "failover": {
    "scope": "global",
    "return_to_preferred": {
      "enabled": true,
      "min_stable_minutes": 10
    },
    "triggers": {
      "rate_limit": true,
      "quota_exhausted": true,
      "auth_error": true
    }
  },
  "vendors": [
    {
      "vendor": "openai",
      "oauth_cooldown_minutes": 180,
      "api_key_cooldown_minutes": 15,
      "auto_retry": true,
      "routes": [
        {
          "id": "openai-work-sub",
          "auth_type": "oauth",
          "label": "work",
          "provider_id": "openai-codex-work"
        },
        {
          "id": "openai-work-api",
          "auth_type": "api_key",
          "label": "work",
          "provider_id": "openai",
          "api_key_env": "OPENAI_API_KEY_WORK",
          "openai_org_id_env": "OPENAI_ORG_ID_WORK",
          "openai_project_id_env": "OPENAI_PROJECT_ID_WORK"
        }
      ]
    },
    {
      "vendor": "claude",
      "oauth_cooldown_minutes": 180,
      "api_key_cooldown_minutes": 15,
      "auto_retry": true,
      "routes": [
        {
          "id": "claude-work-sub",
          "auth_type": "oauth",
          "label": "work",
          "provider_id": "anthropic-work"
        }
      ]
    }
  ],
  "preference_stack": [
    { "route_id": "openai-work-sub", "model": "gpt-5.2" },
    { "route_id": "claude-work-sub", "model": "claude-sonnet-4-5" },
    { "route_id": "openai-work-api", "model": "gpt-5.2" }
  ]
}
```

---

## Provider aliases

Built-ins include `openai`, `openai-codex`, and `anthropic`.
Subswitch auto-registers alias providers referenced by route `provider_id`
(e.g. `openai-codex-work`, `anthropic-work`, custom API aliases).

OAuth credentials are stored per provider ID in `~/.pi/agent/auth.json`.
Keep provider IDs stable to avoid unnecessary re-login.

---

## Status semantics

Interactive status/stack coloring:

- `ready` -> green
- `cooldown` / `waiting for current /model` / `context too large` -> yellow
- `model unavailable` / `credentials needed` -> red

Time windows are reported as human-readable durations plus local
`until ...` timestamps.

---

## Notes and limitations

- Context-window errors are intentionally excluded from failover trigger
  classification; context fit is handled by eligibility + compaction paths.
- `failover.scope=current_vendor` restricts failover/return to current vendor.
- `off` disables runtime behavior without rewriting config.
- Extremely large histories where no route can compact currently remain in
  stay-and-retry mode; continuation/map-reduce fallback is documented in:
  `context-window-failover-design.md`.
