# title-status (pi extension)

Shows a small status icon in your terminal title:

- `🟣` busy (agent running or follow-ups queued)
- `🗜️` compacting (session is being compacted)
- `✅` ready (idle)
- `⬜` pending (session start or interrupted run)

## Install

Option A (recommended): install as a pi package:

```bash
pi install git:github.com/continua-ai/pi-lab
```

Option B: copy the extension into your global pi extensions dir:

```bash
mkdir -p ~/.pi/agent/extensions/title-status
cp -r extensions/title-status/index.ts ~/.pi/agent/extensions/title-status/index.ts
```

## tmux notes

For tmux, enable title passthrough so pane titles update your terminal tab:

```tmux
set -g set-titles on
set -g set-titles-string '#{pane_title}'
```
