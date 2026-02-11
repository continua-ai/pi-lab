# subscription-fallback (pi extension)

`/subswitch` is a vendor/account failover manager for pi.

It supports:

- multiple vendors (v1: `openai`, `claude`)
- multiple auth routes per vendor (`oauth`, `api_key`)
- ordered failover (route order in config)
- model policy `follow_current` (v1 only)
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

Project entries override global entries by vendor.

Backward compatibility:

- If no `subswitch.json` exists, the extension will attempt to migrate legacy
  `subscription-fallback.json` shape (OpenAI-only) at runtime.

## Config schema (v1)

- `vendors[].routes[]` order is the failover order.
- `auth_type` is `oauth` or `api_key`.
- `provider_id` is the underlying pi provider id.

```json
{
  "enabled": true,
  "default_vendor": "openai",
  "rate_limit_patterns": [],
  "vendors": [
    {
      "vendor": "openai",
      "oauth_cooldown_minutes": 180,
      "api_key_cooldown_minutes": 15,
      "auto_retry": true,
      "routes": [
        { "auth_type": "oauth", "label": "work", "provider_id": "openai-codex-work" },
        { "auth_type": "oauth", "label": "personal", "provider_id": "openai-codex" },
        {
          "auth_type": "api_key",
          "label": "work",
          "provider_id": "openai",
          "api_key_env": "OPENAI_API_KEY_WORK",
          "openai_org_id_env": "OPENAI_ORG_ID_WORK",
          "openai_project_id_env": "OPENAI_PROJECT_ID_WORK"
        },
        {
          "auth_type": "api_key",
          "label": "personal",
          "provider_id": "openai",
          "api_key_env": "OPENAI_API_KEY_PERSONAL"
        }
      ]
    },
    {
      "vendor": "claude",
      "oauth_cooldown_minutes": 180,
      "api_key_cooldown_minutes": 15,
      "auto_retry": true,
      "routes": [
        { "auth_type": "oauth", "label": "personal", "provider_id": "anthropic" },
        { "auth_type": "oauth", "label": "work", "provider_id": "anthropic-work" },
        {
          "auth_type": "api_key",
          "label": "work",
          "provider_id": "anthropic-api",
          "api_key_env": "ANTHROPIC_API_KEY_WORK"
        }
      ]
    }
  ]
}
```

## Commands

All control is via `/subswitch`.

- `/subswitch`
  - Quick picker + status.

- `/subswitch status`
  - Show detailed status.

- `/subswitch setup`
  - Guided setup wizard (supports Back via `← Back` and `/back` on inputs, includes route-order step, and drives OAuth login checklist).

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
  - Interactive route reorder; persists config.

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
- `reload`
- `use`
- `prefer` (move route to front of failover order, then optionally switch)
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

- v1 model policy is `follow_current`: `/subswitch` follows whichever model you selected with `/model`.
- Failover only happens when the current model exists on the candidate route.
- Quota/rate-limit detection intentionally ignores context-window errors.
