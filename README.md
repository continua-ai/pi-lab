# pi-lab

A small collection of [pi](https://github.com/badlogic/pi-mono) (pi-coding-agent) extensions from your friends at Continua.

## Install

```bash
pi install git:github.com/continua-ai/pi-lab
```

After install, restart `pi` (or run `/reload`) and the extensions in this repo will be available.

## Extensions

- `subscription-fallback` (`/subswitch`): automatically switches between a ChatGPT subscription provider and an API-key provider when you hit usage/rate limits.
- `title-status`: shows a small status icon (busy/ready/pending) in the terminal title.
- `live-commentary`: summarizes long-running bash tool output with a small widget (auto-starts after ~10s).
- `session-context` (`/session-context`): generates a session summary line in the footer and a detailed modal on demand.
