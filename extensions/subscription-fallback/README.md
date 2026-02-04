# subscription-fallback (pi extension)

Automatically switches between:

- **ChatGPT subscription** via `openai-codex` (authenticated with `pi /login`), and
- **OpenAI API credits** via `openai` (authenticated with `OPENAI_API_KEY`)

…when the subscription provider hits rate limits / usage limits.

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
- API credits provider: set `OPENAI_API_KEY` in your environment.

## Commands

All control is via the `/subswitch` command.

- `/subswitch` or `/subswitch reload`
  - Reload config from disk and print current status.

- `/subswitch on` / `/subswitch off`
  - Enable/disable the extension.

- `/subswitch primary`
  - Force switch to subscription provider (default: `openai-codex`).

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
  "rateLimitPatterns": [
    "You have hit your ChatGPT usage limit"
  ]
}
```

## Notes / limitations

- The footer status line shows:
  - whether you’re on subscription (`sub`) or API credits (`api`),
  - remaining time until the subscription rate-limit cooldown ends (when applicable), and
  - best-effort total tokens used while on API credits.
- Switching back to subscription happens when pi is idle; the extension avoids changing models mid-stream.
- If switching back fails (credentials/provider issues), the extension backs off for ~5 minutes and retries.
- The extension only manages switching when the chosen model id exists in both providers.
