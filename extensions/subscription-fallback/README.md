# subscription-fallback (pi extension)

Automatically switches between:

- **ChatGPT subscription** via `openai-codex` (authenticated with `pi /login`), and
- **OpenAI API credits** via `openai` (authenticated with `OPENAI_API_KEY`)

…when the subscription provider hits rate limits / usage limits.

If you have **multiple ChatGPT OAuth accounts**, you can configure multiple primary providers (aliases) and the extension will try all of them before falling back to API credits.

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

## Prerequisites

- Subscription provider: run `pi`, then `/login` (default provider name used by this extension: `openai-codex`).
- API credits provider: set `OPENAI_API_KEY` in your environment (or configure `fallbackAccounts` to rotate between multiple keys).

## Commands

All control is via the `/subswitch` command.

- `/subswitch` or `/subswitch reload`
  - Reload config from disk and print current status.

- `/subswitch on` / `/subswitch off`
  - Enable/disable the extension.

- `/subswitch primary [providerId]`
  - Force switch to a subscription provider (defaults to the first of `primaryProviders`, or `openai-codex`).

- `/subswitch fallback`
  - Force switch to API-key provider (default: `openai`).

- `/subswitch simulate [minutes] [errorText...]`
  - Simulate a subscription usage-limit error and trigger the fallback path.

- `/subswitch selftest [ms]`
  - Lightweight manual self-test that exercises parsing a retry hint, scheduling the cooldown timer,
    switching to fallback, and switching back.

## Configuration

Config is loaded from JSON, merged in this order:

1. **Global**: `~/.pi/agent/subscription-fallback.json`
2. **Project-local**: `./.pi/subscription-fallback.json`

Project-local values override global.

### Example

```json
{
  "enabled": true,
  "primaryProvider": "openai-codex",
  "fallbackProvider": "openai",
  "modelId": "gpt-5.2",
  "cooldownMinutes": 180,
  "autoRetry": true,
  "preferPrimaryOnStartup": true,
  "rateLimitPatterns": [
    "You have hit your ChatGPT usage limit"
  ]
}
```

Notes:

- `preferPrimaryOnStartup` (default: `true`): if pi restores your last model on the fallback provider (API-key mode), the extension will immediately try to switch back to a subscription provider on startup.
- `autoRetry` (default: `true`): if the active subscription provider is rate-limited and the extension switches to another provider, it will automatically re-send your last prompt.
- OpenAI Responses API mitigation: when the fallback provider uses `openai-responses`, the extension strips prior thinking blocks from the request context to avoid repeated 404s for non-persisted `rs_...` items.

### Multiple ChatGPT OAuth accounts (subscription aliases)

pi stores OAuth credentials **per provider id**.

To avoid a confusing extra "Codex" profile, this extension treats the built-in `openai-codex` provider as your **personal** account, and registers a single additional alias provider for your **work** account:

- `openai-codex` (personal)
- `openai-codex-work` (work)

Log into both:

- `/login` → select **ChatGPT Plus/Pro (Codex Subscription) (personal)**
- `/login` → select **ChatGPT Plus/Pro (Codex Subscription) (work)**

Then configure `primaryProviders` so `/subswitch` can rotate between them:

```json
{
  "primaryProviders": ["openai-codex-work", "openai-codex"],
  "fallbackProvider": "openai",
  "cooldownMinutes": 180
}
```

Behavior:

- If the active subscription account gets rate-limited, `/subswitch` will try the other subscription account first.
- Only if **all** subscription accounts are cooling down will it switch to API credits.
- When cooling down, it periodically tries to switch back to **any** available subscription account.

Note: adding new alias provider ids requires restarting pi (provider registration happens at extension load time).

### Multiple OpenAI accounts (API key rotation)

If your **fallback provider is `openai`** and you have multiple OpenAI API keys, you can configure the extension to rotate between them when one key gets throttled (429 / rate limit).

1) Put each key in its own env var (example):

```bash
export OPENAI_API_KEY_PERSONAL='...'
export OPENAI_API_KEY_WORK='...'
```

2) Configure `fallbackAccounts` to reference those env vars:

```json
{
  "fallbackProvider": "openai",
  "fallbackAccounts": [
    { "name": "personal", "apiKeyEnv": "OPENAI_API_KEY_PERSONAL" },
    { "name": "work", "apiKeyEnv": "OPENAI_API_KEY_WORK" }
  ],
  "fallbackAccountCooldownMinutes": 15
}
```

Notes:

- The extension switches the **process** `OPENAI_API_KEY` at runtime (it does not print keys).
- Rotation is only attempted when `fallbackAccounts.length > 1`.
- The extension does **not** auto-resend on fallback-key rotation (pi core may already be auto-retrying failed calls).
- When `fallbackAccounts` are configured, the extension also clears `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` unless you provide `openaiOrgIdEnv` / `openaiProjectIdEnv` per account.

## Notes / limitations

- Switching back to subscription happens when pi is idle; the extension avoids changing models mid-stream.
- If switching back fails (credentials/provider issues), the extension backs off for ~5 minutes and retries.
- The extension only manages switching when the chosen model id exists in both providers.
- "Context window exceeded" errors do **not** trigger fallback switching (they are not quota/rate-limit).
