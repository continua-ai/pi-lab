# subscription-fallback (pi extension)

`/subswitch` is a vendor/account failover manager for pi.

It supports:

- multiple vendors (v1: `openai`, `claude`)
- multiple auth routes per vendor (`oauth`, `api_key`)
- global failover preference stack (route + optional model override)
- configurable failover triggers (`rate_limit`, `quota_exhausted`, `auth_error`)
- automatic return to higher-preference routes after cooldown
- an LLM-callable bridge tool: `subswitch_manage`

## Install

Option A (recommended): install as a pi package:

```bash
pi install git:github.com/continua-ai/pi-lab
```

Option B: copy the extension into your global pi extensions dir:

```bash
mkdir -p ~/.pi/agent/extensions/subscription-fallback
cp -r extensions/subscription-fallback/index.ts ~/.pi/agent/extensions/subscription-fallback/index.ts
```

## Config paths

Config is loaded and merged in this order:

1. Global: `~/.pi/agent/subswitch.json`
2. Project: `./.pi/subswitch.json`

Project entries override global top-level keys; vendor entries are merged by vendor name.

Backward compatibility:

- If no `subswitch.json` exists, the extension will attempt to migrate legacy
  `subscription-fallback.json` shape (OpenAI-only) at runtime.

## Config schema (v2)

Key ideas:

- `vendors[].routes[]` defines available routes/accounts.
- `preference_stack[]` defines failover priority globally.
- each stack entry can optionally pin a `model`; otherwise it follows the current model.
- `failover.scope` controls whether failover can cross vendors.
- triggers default to `true` when omitted.

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
  - Show concise status.

- `/subswitch longstatus`
  - Show detailed status (preference stack, model overrides, route ids).

- `/subswitch setup`
  - Guided setup wizard (supports Back via `← Back` and `/back` on inputs, includes route order, failover policy/triggers, preference stack, and OAuth login checklist). Changes apply only when setup is finished.

- `/subswitch login`
  - Show OAuth login checklist and optionally prefill `/login`.

- `/subswitch login-status`
  - Re-check which OAuth providers still need login and update reminder widget.

- `/subswitch reload`
  - Reload config from disk.

- `/subswitch on` / `/subswitch off`
  - Enable/disable extension in the current session.

- `/subswitch use <vendor> <auth_type> <label> [modelId]`
  - Force a specific route.

- `/subswitch subscription <vendor> [label] [modelId]`
  - Use oauth route (first eligible route if no label).

- `/subswitch api <vendor> [label] [modelId]`
  - Use api-key route (first eligible route if no label).

- `/subswitch rename <vendor> <auth_type> <old_label> <new_label>`
  - Rename a route label and persist config.

- `/subswitch reorder [vendor]`
  - Interactive failover preference-stack reorder (optionally filtered by vendor); persists config.

- `/subswitch edit`
  - Edit JSON config with validation.

- `/subswitch models <vendor>`
  - Show model ids available across all routes for the vendor.

Compatibility aliases:

- `/subswitch primary ...` -> `subscription` (deprecated)
- `/subswitch fallback ...` -> `api` (deprecated)

## LLM-callable tool bridge

The extension registers a tool:

- `subswitch_manage`

Supported actions:

- `status`
- `longstatus`
- `reload`
- `use`
- `prefer` (move matching route entry to the top of failover preference stack, then optionally switch)
- `rename`

This allows natural-language requests like:

- “Make work the primary for gpt-5.2”

…to be executed by the agent via tool calls.

## Provider aliases

Some ids are built-in (`openai`, `openai-codex`, `anthropic`), but the extension can register aliases such as:

- `openai-codex-work` (OpenAI OAuth alias)
- `my-codex-work` (OpenAI OAuth alias with a custom id)
- `anthropic-work` (Claude OAuth alias)
- `anthropic-api` (Claude API-key alias)

Alias ids are meaningful: OAuth credentials are stored per provider id in `~/.pi/agent/auth.json`.
Use stable ids; changing ids usually requires re-login for that route.

## Notes

- If a `preference_stack` entry has no `model`, subswitch follows the current `/model` selection for that entry.
- If a `preference_stack` entry has a `model`, that model is used when that entry is selected.
- `failover.scope=current_vendor` restricts failover/return to entries in the current vendor.
- `auth_error` trigger is applied only to `api_key` routes.
- Failover detection ignores context-window errors.
