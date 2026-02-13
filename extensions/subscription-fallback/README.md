# subscription-fallback (pi extension)

`/subswitch` is a vendor/account failover manager for pi.

It supports:

- multiple vendors (currently `openai`, `claude`)
- multiple auth routes per vendor (`oauth`, `api_key`)
- global preference-stack failover (`route_id` + optional model override)
- configurable failover triggers (`rate_limit`, `quota_exhausted`, `auth_error`)
- automatic return to preferred routes after cooldown/holdoff
- pre-return route probing (stay on fallback if probe fails)
- context-window-aware switching (skip over-small routes; compact before retry when useful)
- persisted runtime state (cooldowns + return holdoff)
- LLM-callable bridge tool: `subswitch_manage`

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

## Quick setup (recommended)

1. Run `/subswitch setup`.
2. Choose config destination (global/project).
3. Configure vendors/routes/order/policy/preference stack.
4. Finish setup (writes config atomically at end).
5. Run `/subswitch login` and complete OAuth login(s) via `/login`.
6. Ensure API-key env vars are set for `api_key` routes.
7. Verify:
   - `/subswitch login-status`
   - `/subswitch status`
   - `/subswitch longstatus`

## How failover works

When a turn ends with an error, subswitch evaluates configured triggers:

- `rate_limit`
- `quota_exhausted`
- `auth_error` (API-key routes only)

If triggered:

1. It places the current route on cooldown.
   - Uses provider retry hints when available.
   - Otherwise uses configured cooldown minutes for route/vendor.
2. It selects the next eligible lower-priority entry in `preference_stack`.
   - Eligibility includes cooldown, model compatibility, credentials, and context-window fit.
3. If routes are blocked by context size, it attempts compaction on the current route and retries selection.
4. It switches to the selected route/model.
   - If a direct switch is still context-blocked, it attempts compaction before retrying the switch.
5. After any automatic failover switch, if vendor `auto_retry=true`, it resends the previous user prompt (immediate if idle, otherwise queued as follow-up).

### Return-to-preferred behavior

If `failover.return_to_preferred.enabled=true`, subswitch can move back up the stack after `min_stable_minutes` holdoff.

Before switching upward, it performs a lightweight probe on the candidate route/model.
The probe runs as an idle/background check and is not awaited on user prompt start.

- Probe success: switch back to preferred route.
- Probe inconclusive (for example, timeout/abort): attempt a direct switch anyway; if that fails, stay on current route, set a short cooldown, retry later.
- Probe failure: stay on current route, set a short cooldown on the preferred candidate, retry later.

User-facing notifications explicitly call this out (health check, stay-on-fallback, retry window).

## Config + state paths

### Config merge order

1. Global: `~/.pi/agent/subswitch.json`
2. Project: `./.pi/subswitch.json`

Project values override top-level global keys. Vendor lists are merged by vendor name.

If no `subswitch.json` exists, subswitch attempts runtime migration from legacy `subscription-fallback.json` shape.

### Runtime state files

State includes route cooldowns + return holdoff:

- Global: `~/.pi/agent/subswitch-state.json`
- Project: `./.pi/subswitch-state.json`

State is keyed by route `id` and survives `/reload` and session restarts.

### Reload commands

- `/subswitch reload` -> reloads config + runtime state from disk.
- `/reload` -> reloads extension code/resources (full extension runtime reload).

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

## Commands

All control is via `/subswitch`.

- `/subswitch`
  - Quick picker + status.
- `/subswitch status`
  - Concise status (stack-first).
- `/subswitch longstatus`
  - Detailed status (stack/models/ids/providers).
- `/subswitch setup`
  - Guided setup wizard (Back supported, apply-on-finish).
- `/subswitch login`
  - OAuth login checklist + optional `/login` prefill.
- `/subswitch login-status`
  - Re-check OAuth completion + update reminder widget.
- `/subswitch reload`
  - Reload config + runtime state.
- `/subswitch on` / `/subswitch off`
  - Runtime enable/disable (current session only).
- `/subswitch use <vendor> <auth_type> <label> [modelId]`
  - Force a specific route.
- `/subswitch subscription <vendor> [label] [modelId]`
  - Use OAuth route (first eligible if no label).
- `/subswitch api <vendor> [label] [modelId]`
  - Use API-key route (first eligible if no label).
- `/subswitch rename <vendor> <auth_type> <old_label> <new_label>`
  - Rename route label and persist config.
- `/subswitch reorder [vendor]`
  - Interactive preference-stack reorder, persists config.
- `/subswitch edit`
  - Edit JSON config with validation.
- `/subswitch models <vendor>`
  - Show compatible models across routes for vendor.

Compatibility aliases:

- `/subswitch primary ...` -> `subscription` (deprecated)
- `/subswitch fallback ...` -> `api` (deprecated)

## LLM tool bridge

Registered tool: `subswitch_manage`

Supported actions:

- `status`
- `longstatus`
- `reload`
- `use`
- `prefer`
- `rename`

This allows natural language control via tool calls.

## Provider aliases

Built-ins include `openai`, `openai-codex`, and `anthropic`.
Subswitch can register aliases such as:

- `openai-codex-work`
- `my-codex-work`
- `anthropic-work`
- `anthropic-api`

OAuth credentials are stored per provider id in `~/.pi/agent/auth.json`.
Keep provider ids stable to avoid unnecessary re-login.

## Notes

- If a stack entry omits `model`, it follows current `/model`.
- `failover.scope=current_vendor` restricts failover/return to current vendor.
- Context-window errors are ignored for failover triggering.
- In interactive UI, status is color-coded (auth type + route state), including `ready` (green), cooldown/waiting/context-too-large (yellow), and unavailable/credentials-needed (red).
- Retry/holdoff windows in status + notifications are formatted as human-readable durations with local-time "until" timestamps.
