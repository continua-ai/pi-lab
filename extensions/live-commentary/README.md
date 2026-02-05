# live-commentary (pi extension)

Adds a small status widget that analyzes long-running bash tool output.
It auto-starts after ~10 seconds and refreshes about every 10 seconds until the command completes.

## Behavior

- Watches `bash` tool executions.
- After 10s of runtime, calls a cheaper model to summarize progress and suggest next steps.
- Includes the triggering user prompt and recent session context in the analysis.
- Reads full output from the tool's `fullOutputPath` when output truncates; otherwise accumulates streamed output.
- Renders an inline widget above the editor with elapsed time, last output line, and suggestions (including cancel when output stalls).
- Stops automatically when the tool completes or is aborted.

## Configuration

Override the commentary model in `settings.json` (global or project):

```json
{
  "extensionsConfig": {
    "liveCommentary": {
      "model": "openai/gpt-4o-mini"
    }
  }
}
```

- Global: `~/.pi/agent/settings.json`
- Project: `./.pi/settings.json`

If unset, the extension picks a "mini/haiku/flash" model from providers with auth/login available.

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
