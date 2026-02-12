# pi-lab

A small collection of [pi](https://github.com/badlogic/pi-mono) (pi-coding-agent) extensions from your friends at Continua.

## Install

```bash
pi install git:github.com/continua-ai/pi-lab
```

After install, restart `pi` (or run `/reload`) and the extensions in this repo will be available.

## Extensions

- `subscription-fallback` (`/subswitch`): multi-vendor (OpenAI/Claude) route failover manager with preference stack, runtime setup wizard, and return-to-preferred probing.
- `title-status`: shows a small status icon (busy/ready/pending) in the terminal title.
- `live-commentary`: summarizes long-running bash tool output with a small widget (auto-starts after ~10s).
- `session-context` (`/session-context`): generates a dedicated session summary line below the editor and a detailed modal on demand.
