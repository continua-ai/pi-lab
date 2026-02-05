# live-commentary (pi extension)

Adds a small status widget that analyzes long-running bash tool output.
It auto-starts after ~10 seconds and refreshes about every 10 seconds until the command completes.

## Behavior

- Watches `bash` tool executions.
- After 10s of runtime, calls a cheaper model to summarize progress and suggest next steps.
- Renders an inline widget above the editor with elapsed time, last output line, and suggestions.
- Stops automatically when the tool completes or is aborted.

## Configuration

Use a cheaper model via `PI_LIVE_COMMENTARY_MODEL`:

```bash
# Same provider as current model
export PI_LIVE_COMMENTARY_MODEL=gpt-4o-mini

# Explicit provider
export PI_LIVE_COMMENTARY_MODEL=anthropic/claude-3-5-haiku-20241022
```

If unset, the extension picks a "mini/haiku/flash" model from available providers.

## Install

Option A (recommended): install as a pi package:

```bash
pi install git:github.com/continua-ai/pi-lab
```

Option B: copy the extension into your global pi extensions dir:

```bash
mkdir -p ~/.pi/agent/extensions/live-commentary
cp -r extensions/live-commentary/index.ts ~/.pi/agent/extensions/live-commentary/index.ts
```
