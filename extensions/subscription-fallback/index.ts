// subscription-fallback (pi extension)
//
// Automatically switch between a ChatGPT subscription provider (default: openai-codex via /login)
// and OpenAI API credits (default: openai via OPENAI_API_KEY) when the subscription hits
// usage limits / rate limits.
//
// This extension registers:
//   - /subswitch (status/help/reload/force/simulate/selftest)

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type InputSource = "interactive" | "rpc" | "extension";

interface Config {
  /** Master switch */
  enabled?: boolean;

  /** Subscription provider (via /login). Default: openai-codex */
  primaryProvider?: string;

  /** API-key provider (via OPENAI_API_KEY). Default: openai */
  fallbackProvider?: string;

  /** If set, lock switching to this model id. If omitted, follows the currently selected model id (if present in both providers). */
  modelId?: string;

  /** After we detect subscription rate-limit, wait this long before trying the subscription again. Default: 180 */
  cooldownMinutes?: number;

  /** If true, re-send the prompt automatically after switching to fallback. Default: true */
  autoRetry?: boolean;

  /** Extra substrings (case-insensitive) that should count as "rate limited". */
  rateLimitPatterns?: string[];
}

const EXT = "subscription-fallback";

function splitArgs(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function readJson(path: string): any | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`[${EXT}] Failed to parse ${path}:`, e);
    return undefined;
  }
}

function loadConfig(cwd: string): Config {
  const globalPath = join(homedir(), ".pi", "agent", "subscription-fallback.json");
  const projectPath = join(cwd, ".pi", "subscription-fallback.json");

  const globalCfg = (readJson(globalPath) ?? {}) as Config;
  const projectCfg = (readJson(projectPath) ?? {}) as Config;

  const merged: Config = {
    enabled: true,
    primaryProvider: "openai-codex",
    fallbackProvider: "openai",
    cooldownMinutes: 180,
    autoRetry: true,
    rateLimitPatterns: [],
    ...globalCfg,
    ...projectCfg,
  };

  // Normalize
  merged.enabled = merged.enabled ?? true;
  merged.primaryProvider = merged.primaryProvider || "openai-codex";
  merged.fallbackProvider = merged.fallbackProvider || "openai";
  merged.cooldownMinutes = merged.cooldownMinutes ?? 180;
  merged.autoRetry = merged.autoRetry ?? true;
  merged.rateLimitPatterns = merged.rateLimitPatterns ?? [];

  return merged;
}

function isRateLimitError(err: unknown, extraPatterns: string[] = []): boolean {
  const s = String(err ?? "");
  const l = s.toLowerCase();

  const patterns = [
    "rate limit",
    "ratelimit",
    "too many requests",
    "429",
    "try again later",
    "please try again",
    "usage limit",
    "usage_limit",
    "exceeded",
    "capacity",
    ...extraPatterns.map((p) => p.toLowerCase()),
  ];

  return patterns.some((p) => p && l.includes(p));
}

/**
 * Try to extract when the subscription becomes available again.
 *
 * Supports common patterns like:
 * - JSON-ish: {"resets_at": 1738600000}
 * - ISO timestamp
 * - "Try again in ~53 min"
 * - "Retry after 30s" / "retry after 2m"
 * - "in 1h 23m 10s"
 * - "again at 2pm" (local time)
 */
function parseRetryAfterMs(err: unknown): number | undefined {
  const s = String(err ?? "");
  if (!s) return undefined;

  const resetsAt = s.match(/\bresets_at\b[^0-9]*(\d{9,13})/i);
  if (resetsAt) {
    const raw = Number(resetsAt[1]);
    if (!Number.isNaN(raw)) {
      const tsMs = resetsAt[1].length >= 13 ? raw : raw * 1000;
      const delta = tsMs - Date.now();
      if (delta > 0) return delta;
    }
  }

  const iso = s.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  if (iso) {
    const ts = Date.parse(iso[1]);
    if (!Number.isNaN(ts)) {
      const delta = ts - Date.now();
      if (delta > 0) return delta;
    }
  }

  const tryAgainMin = s.match(/try again in\s*~?\s*(\d+)\s*(?:min|mins|minutes)\b/i);
  if (tryAgainMin) return Number(tryAgainMin[1]) * 60_000;

  const retryAfter = s.match(
    /retry[\s-]*after\s*(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/i,
  );
  if (retryAfter) {
    const n = Number(retryAfter[1]);
    const unit = retryAfter[2].toLowerCase();
    if (unit.startsWith("s")) return n * 1000;
    if (unit.startsWith("m")) return n * 60_000;
    if (unit.startsWith("h")) return n * 3_600_000;
  }

  const dur = s.match(/\bin\s*~?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?\b/i);
  if (dur) {
    const h = dur[1] ? Number(dur[1]) : 0;
    const m = dur[2] ? Number(dur[2]) : 0;
    const sec = dur[3] ? Number(dur[3]) : 0;
    const total = h * 3_600_000 + m * 60_000 + sec * 1000;
    if (total > 0) return total;
  }

  const at = s.match(/again at\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (at) {
    let hour = Number(at[1]);
    const minute = at[2] ? Number(at[2]) : 0;
    const ampm = at[3].toLowerCase();

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    const target = new Date(Date.now());
    target.setSeconds(0, 0);
    target.setHours(hour, minute, 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    return target.getTime() - Date.now();
  }

  return undefined;
}

export default function subscriptionFallback(pi: ExtensionAPI) {
  let cfg: Config | undefined;
  let managedModelId: string | undefined;
  let retryPrimaryAfter = 0;

  let pendingInputSource: InputSource | undefined;
  let lastPrompt:
    | {
        source: InputSource;
        text: string;
        images: any[];
      }
    | undefined;

  // `ctx.model` can be stale briefly after `pi.setModel()`.
  let activeProvider: string | undefined;
  let activeModelId: string | undefined;

  // Approximate "API credits" usage: sum of assistant-message tokens while on the fallback provider.
  // This is best-effort (depends on provider reporting usage) but is useful to eyeball spend.
  let fallbackTokensUsed = 0;

  let lastCtx: any | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  // Track extension-driven switches so we don't treat them as user actions.
  let pendingExtensionSwitch:
    | {
        provider: string;
        modelId: string;
      }
    | undefined;

  function now(): number {
    return Date.now();
  }

  function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n < 1000) return String(Math.floor(n));
    if (n < 1_000_000) {
      const v = (n / 1000).toFixed(1);
      return v.endsWith(".0") ? `${v.slice(0, -2)}k` : `${v}k`;
    }
    const v = (n / 1_000_000).toFixed(1);
    return v.endsWith(".0") ? `${v.slice(0, -2)}M` : `${v}M`;
  }

  function estimateTokensFromUsage(usage: any): number {
    if (!usage) return 0;

    // Prefer explicit total tokens if present.
    const total = Number(usage.totalTokens);
    if (Number.isFinite(total) && total > 0) return total;

    const input = Number(usage.input);
    const output = Number(usage.output);
    const cacheRead = Number(usage.cacheRead);
    const cacheWrite = Number(usage.cacheWrite);

    return (Number.isFinite(input) ? input : 0) +
      (Number.isFinite(output) ? output : 0) +
      (Number.isFinite(cacheRead) ? cacheRead : 0) +
      (Number.isFinite(cacheWrite) ? cacheWrite : 0);
  }

  function rebuildFallbackUsageFromSession(ctx: any): void {
    fallbackTokensUsed = 0;
    if (!cfg?.enabled) return;
    const fallback = cfg.fallbackProvider;
    if (!fallback) return;

    const entries = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    for (const entry of entries) {
      if (entry?.type !== "message") continue;
      const msg = entry.message;
      if (!msg || msg.role !== "assistant") continue;
      if (msg.provider !== fallback) continue;
      fallbackTokensUsed += estimateTokensFromUsage(msg.usage);
    }
  }

  function rememberActiveFromCtx(ctx: any): void {
    lastCtx = ctx;
    if (!activeProvider && ctx.model?.provider) activeProvider = ctx.model.provider;
    if (!activeModelId && ctx.model?.id) activeModelId = ctx.model.id;
  }

  function clearRetryTimer(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function schedulePrimaryRetry(ctx: any): void {
    clearRetryTimer();
    if (!cfg?.enabled) return;
    if (!retryPrimaryAfter) return;

    lastCtx = ctx;

    const delayMs = Math.max(0, retryPrimaryAfter - now());
    retryTimer = setTimeout(() => {
      void maybeSwitchBackToPrimary("cooldown timer");
    }, delayMs);
  }

  async function maybeSwitchBackToPrimary(reason: string): Promise<void> {
    if (!cfg?.enabled) return;

    // We're about to act; any outstanding pending marker is stale.
    pendingExtensionSwitch = undefined;

    if (!managedModelId) return;

    const ctx = lastCtx;
    if (!ctx) return;

    // Don't switch models while the agent is streaming.
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      clearRetryTimer();
      retryTimer = setTimeout(() => {
        void maybeSwitchBackToPrimary(reason);
      }, 30_000);
      return;
    }

    const provider = activeProvider ?? ctx.model?.provider;
    const id = activeModelId ?? ctx.model?.id;
    if (provider !== cfg.fallbackProvider || id !== managedModelId) {
      // User likely switched away.
      clearRetryTimer();
      retryPrimaryAfter = 0;
      return;
    }

    if (retryPrimaryAfter && now() < retryPrimaryAfter) {
      schedulePrimaryRetry(ctx);
      return;
    }

    if (ctx.hasUI) {
      ctx.ui.notify(`[${EXT}] Cooldown expired; switching back to subscription…`, "info");
    }

    const switched = await switchToProvider(ctx, cfg.primaryProvider!, reason);
    if (switched) {
      retryPrimaryAfter = 0;
      clearRetryTimer();
    } else {
      if (ctx.hasUI) {
        ctx.ui.notify(`[${EXT}] Failed to switch back to subscription; will retry in ~5m`, "warning");
      }
      retryPrimaryAfter = now() + 5 * 60_000;
      schedulePrimaryRetry(ctx);
    }
  }

  function updateStatus(ctx: any) {
    if (!ctx.hasUI) return;

    if (!cfg?.enabled) {
      ctx.ui.setStatus(EXT, undefined);
      return;
    }

    const provider = activeProvider ?? ctx.model?.provider;
    const modelId = activeModelId ?? ctx.model?.id;
    if (!provider || !modelId) {
      ctx.ui.setStatus(EXT, undefined);
      return;
    }

    const primary = cfg.primaryProvider;
    const fallback = cfg.fallbackProvider;

    const mode = provider === primary ? "sub" : provider === fallback ? "api" : provider;

    let msg = ctx.ui.theme.fg("muted", `${EXT}:`);
    msg += " " + ctx.ui.theme.fg("accent", mode);

    if (managedModelId) {
      msg += " " + ctx.ui.theme.fg("dim", managedModelId);
    }

    // If a rate-limit/cooldown is in effect, show remaining minutes.
    if (retryPrimaryAfter) {
      const mins = Math.max(0, Math.ceil((retryPrimaryAfter - now()) / 60000));
      msg += " " + ctx.ui.theme.fg("dim", `(rate limit ~${mins}m)`);
    }

    // If we're using API credits (fallback provider), show token usage so far.
    if (fallback && (provider === fallback || fallbackTokensUsed > 0)) {
      msg += " " + ctx.ui.theme.fg("dim", `(credits ${formatTokens(fallbackTokensUsed)} tok)`);
    }

    ctx.ui.setStatus(EXT, msg);
  }

  function canManageModelId(ctx: any, modelId: string): boolean {
    const primary = cfg?.primaryProvider;
    const fallback = cfg?.fallbackProvider;
    if (!primary || !fallback) return false;

    return Boolean(ctx.modelRegistry.find(primary, modelId) && ctx.modelRegistry.find(fallback, modelId));
  }

  function resolveManagedModelId(ctx: any): string | undefined {
    if (!cfg) return undefined;

    if (cfg.modelId) {
      return canManageModelId(ctx, cfg.modelId) ? cfg.modelId : undefined;
    }

    const current = ctx.model;
    if (current?.id && canManageModelId(ctx, current.id)) return current.id;

    return undefined;
  }

  async function switchToProvider(ctx: any, provider: string, reason: string): Promise<boolean> {
    if (!cfg?.enabled) return false;
    if (!managedModelId) return false;

    lastCtx = ctx;

    const model = ctx.modelRegistry.find(provider, managedModelId);
    if (!model) {
      if (ctx.hasUI) ctx.ui.notify(`[${EXT}] No model ${provider}/${managedModelId} (${reason})`, "warning");
      return false;
    }

    pendingExtensionSwitch = { provider, modelId: managedModelId };

    let ok = false;
    try {
      ok = await pi.setModel(model);
    } finally {
      if (!ok) pendingExtensionSwitch = undefined;
    }

    if (!ok) {
      if (ctx.hasUI) ctx.ui.notify(`[${EXT}] Missing credentials for ${provider}/${managedModelId} (${reason})`, "warning");
      return false;
    }

    activeProvider = provider;
    activeModelId = managedModelId;

    if (provider === cfg.primaryProvider) {
      retryPrimaryAfter = 0;
      clearRetryTimer();
    } else if (provider === cfg.fallbackProvider && retryPrimaryAfter) {
      schedulePrimaryRetry(ctx);
    }


    if (ctx.hasUI) {
      const label =
        provider === cfg.primaryProvider ? "subscription" : provider === cfg.fallbackProvider ? "API credits" : provider;
      ctx.ui.notify(`[${EXT}] Switched to ${label} (${provider}/${managedModelId})`, "info");
    }

    updateStatus(ctx);
    return true;
  }

  function buildUserMessageContent(text: string, images: any[]): any {
    if (!images || images.length === 0) return text;
    return [{ type: "text", text }, ...images];
  }

  pi.registerCommand("subswitch", {
    description: "Subscription↔API model auto-fallback (status/help/reload/force)",
    handler: async (args, ctx) => {
      cfg = loadConfig(ctx.cwd);
      managedModelId = resolveManagedModelId(ctx);
      rememberActiveFromCtx(ctx);

      const parts = splitArgs(args || "");
      const cmd = parts[0] ?? "";

      if (cmd === "reload" || cmd === "" || cmd === "help") {
        if (cmd === "help" && ctx.hasUI) {
          const help =
            "Usage: /subswitch [command]\n\n" +
            "Commands:\n" +
            "  reload | (no args)   Reload config + show status\n" +
            "  on / off             Enable/disable extension\n" +
            "  primary              Force subscription provider (default: openai-codex)\n" +
            "  fallback             Force API-key provider (default: openai)\n" +
            "  simulate [mins] [err] Simulate a subscription limit for testing\n" +
            "  selftest [ms]        Quick self-test (parse + timer + switch-back)";
          ctx.ui.notify(help, "info");
        }
      } else if (cmd === "on") {
        cfg.enabled = true;
      } else if (cmd === "off") {
        cfg.enabled = false;
        retryPrimaryAfter = 0;
        clearRetryTimer();
        if (ctx.hasUI) ctx.ui.setStatus(EXT, undefined);
      } else if (cmd === "primary") {
        const switched = await switchToProvider(ctx, cfg.primaryProvider!, "forced");
        if (switched) {
          retryPrimaryAfter = 0;
          clearRetryTimer();
        }
      } else if (cmd === "fallback") {
        await switchToProvider(ctx, cfg.fallbackProvider!, "forced");
      } else if (cmd === "simulate") {
        const mins = parts[1] ? Number(parts[1]) : 1;
        const safeMins = !Number.isFinite(mins) || mins <= 0 ? 1 : Math.floor(mins);
        const custom = parts.slice(2).join(" ");
        const fakeErr =
          custom || `You have hit your ChatGPT usage limit (pro plan). Try again in ~${safeMins} min.`;

        const parsedRetryMs = parseRetryAfterMs(fakeErr) ?? safeMins * 60_000;
        const bufferMs = 1_000;
        retryPrimaryAfter = now() + parsedRetryMs + bufferMs;
        schedulePrimaryRetry(ctx);

        if (ctx.hasUI) {
          ctx.ui.notify(
            `[${EXT}] Simulating subscription limit; switching to API credits. Will try subscription again in ~${safeMins}m`,
            "warning",
          );
        }

        managedModelId = managedModelId ?? resolveManagedModelId(ctx);
        if (managedModelId && ctx.model?.provider === cfg.primaryProvider) {
          await switchToProvider(ctx, cfg.fallbackProvider!, "simulated rate limit");
        }
      } else if (cmd === "selftest") {
        if (typeof (ctx as any).waitForIdle === "function") {
          await (ctx as any).waitForIdle();
        }

        if (!cfg.enabled) {
          if (ctx.hasUI) ctx.ui.notify(`[${EXT}] Selftest skipped: extension disabled`, "warning");
        } else if (!managedModelId) {
          if (ctx.hasUI)
            ctx.ui.notify(
              `[${EXT}] Selftest skipped: not managing current model id (pick a model present in both providers)`,
              "warning",
            );
        } else {
          const msRaw = parts[1] ? Number(parts[1]) : 250;
          const ms = Number.isFinite(msRaw) && msRaw >= 50 && msRaw <= 5000 ? Math.floor(msRaw) : 250;

          await switchToProvider(ctx, cfg.primaryProvider!, "selftest setup");

          const resetAtMs = now() + ms;
          const fakeErr = `{"resets_at": ${resetAtMs}}`;
          const parsedRetryMs = parseRetryAfterMs(fakeErr);
          if (!parsedRetryMs) {
            if (ctx.hasUI)
              ctx.ui.notify(`[${EXT}] Selftest failed: couldn't parse retry hint from '${fakeErr}'`, "error");
          } else {
            retryPrimaryAfter = now() + parsedRetryMs;

            if (ctx.hasUI) {
              ctx.ui.notify(
                `[${EXT}] Selftest: switching to fallback; will try subscription again in ~${Math.max(0, Math.ceil(parsedRetryMs))}ms`,
                "info",
              );
            }

            await switchToProvider(ctx, cfg.fallbackProvider!, "selftest simulated rate limit");

            setTimeout(() => {
              const provider = activeProvider ?? lastCtx?.model?.provider;
              const ok = provider === cfg?.primaryProvider;
              if (lastCtx?.hasUI) {
                lastCtx.ui.notify(
                  `[${EXT}] Selftest ${ok ? "PASS" : "FAIL"}: active=${provider ?? "unknown"} managedId=${managedModelId}`,
                  ok ? "info" : "warning",
                );
              }
            }, ms + 500);
          }
        }
      } else {
        if (ctx.hasUI) {
          const help =
            "Usage: /subswitch [command]\n\n" +
            "Commands:\n" +
            "  reload | (no args)   Reload config + show status\n" +
            "  on / off             Enable/disable extension\n" +
            "  primary              Force subscription provider (default: openai-codex)\n" +
            "  fallback             Force API-key provider (default: openai)\n" +
            "  simulate [mins] [err] Simulate a subscription limit for testing\n" +
            "  selftest [ms]        Quick self-test (parse + timer + switch-back)";
          ctx.ui.notify(help, "info");
        }
      }

      if (ctx.hasUI) {
        const provider = activeProvider ?? ctx.model?.provider;
        const modelId = activeModelId ?? ctx.model?.id;
        const model = provider && modelId ? `${provider}/${modelId}` : "(none)";
        const managed = managedModelId
          ? managedModelId
          : "(not managing - pick a model that exists in both providers)";
        const active =
          !provider
            ? "none"
            : provider === cfg.primaryProvider
              ? "primary"
              : provider === cfg.fallbackProvider
                ? "fallback"
                : `other:${provider}`;

        ctx.ui.notify(
          `[${EXT}] enabled=${cfg.enabled} active=${active} primary=${cfg.primaryProvider} fallback=${cfg.fallbackProvider} model=${model} managedId=${managed}`,
          "info",
        );
      }

      updateStatus(ctx);
    },
  });

  pi.on("input", async (event) => {
    pendingInputSource = event.source as InputSource;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    cfg = cfg ?? loadConfig(ctx.cwd);
    if (!cfg.enabled) return;

    rememberActiveFromCtx(ctx);

    managedModelId = managedModelId ?? resolveManagedModelId(ctx);
    if (!managedModelId) {
      updateStatus(ctx);
      return;
    }

    lastPrompt = {
      source: pendingInputSource ?? "interactive",
      text: event.prompt,
      images: (event.images ?? []) as any[],
    };
    pendingInputSource = undefined;

    rememberActiveFromCtx(ctx);

    if (retryPrimaryAfter && now() >= retryPrimaryAfter) {
      const provider = activeProvider ?? ctx.model?.provider;
      const id = activeModelId ?? ctx.model?.id;

      if (provider === cfg.fallbackProvider && id === managedModelId) {
        const switched = await switchToProvider(ctx, cfg.primaryProvider!, "cooldown expired");
        if (switched) {
          retryPrimaryAfter = 0;
          clearRetryTimer();
        } else {
          retryPrimaryAfter = now() + 5 * 60_000;
          schedulePrimaryRetry(ctx);
        }
      } else {
        clearRetryTimer();
      }
    } else if (retryPrimaryAfter) {
      schedulePrimaryRetry(ctx);
    }

    updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    cfg = cfg ?? loadConfig(ctx.cwd);
    if (!cfg.enabled) return;

    lastCtx = ctx;
    activeProvider = event.model?.provider;
    activeModelId = event.model?.id;

    const isExtensionSwitch =
      pendingExtensionSwitch !== undefined &&
      activeProvider === pendingExtensionSwitch.provider &&
      activeModelId === pendingExtensionSwitch.modelId;

    if (isExtensionSwitch) {
      pendingExtensionSwitch = undefined;

      if (activeProvider === cfg.primaryProvider) {
        retryPrimaryAfter = 0;
        clearRetryTimer();
      } else if (activeProvider === cfg.fallbackProvider && retryPrimaryAfter) {
        schedulePrimaryRetry(ctx);
      }

      updateStatus(ctx);
      return;
    }

    if (cfg.modelId) {
      updateStatus(ctx);
      return;
    }

    if (activeProvider && activeProvider !== cfg.fallbackProvider) {
      retryPrimaryAfter = 0;
      clearRetryTimer();
    } else if (retryPrimaryAfter) {
      schedulePrimaryRetry(ctx);
    }

    const id = event.model?.id;
    if (id && canManageModelId(ctx, id)) {
      managedModelId = id;
      retryPrimaryAfter = 0;
      clearRetryTimer();
    }

    updateStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    cfg = cfg ?? loadConfig(ctx.cwd);
    if (!cfg.enabled) return;

    rememberActiveFromCtx(ctx);

    if (!managedModelId) return;

    const msg: any = event.message;

    // Track API-credit usage (best-effort): sum usage tokens for responses produced by the fallback provider.
    if (msg?.provider === cfg.fallbackProvider && msg?.stopReason !== "error") {
      fallbackTokensUsed += estimateTokensFromUsage(msg.usage);
      updateStatus(ctx);
    }

    const stopReason = msg?.stopReason;
    if (stopReason !== "error") return;

    const err = msg?.errorMessage ?? msg?.details?.error ?? msg?.error ?? "unknown error";

    // Only auto-switch if the failing response came from the subscription provider.
    if (msg?.provider !== cfg.primaryProvider) return;
    if (msg?.model !== managedModelId) return;

    if (!isRateLimitError(err, cfg.rateLimitPatterns)) return;

    const parsedRetryMs = parseRetryAfterMs(err);
    const fallbackRetryMs = (cfg.cooldownMinutes ?? 180) * 60_000;
    const bufferMs = 15_000;
    retryPrimaryAfter = now() + (parsedRetryMs ?? fallbackRetryMs) + bufferMs;
    schedulePrimaryRetry(ctx);

    if (ctx.hasUI) {
      const mins = Math.max(0, Math.ceil((retryPrimaryAfter - now()) / 60000));
      const source = parsedRetryMs !== undefined ? "(from provider reset hint)" : "(from configured cooldown)";
      ctx.ui.notify(
        `[${EXT}] Subscription appears rate-limited; switching to API credits… Will try subscription again in ~${mins}m ${source}`,
        "warning",
      );
    }

    const switched = await switchToProvider(ctx, cfg.fallbackProvider!, "rate limited");
    if (!switched) return;

    if (cfg.autoRetry && lastPrompt && lastPrompt.source !== "extension") {
      const content = buildUserMessageContent(lastPrompt.text, lastPrompt.images);
      if (typeof ctx.isIdle === "function" && ctx.isIdle()) {
        pi.sendUserMessage(content);
      } else {
        pi.sendUserMessage(content, { deliverAs: "followUp" });
      }
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    // When resuming or switching sessions, rebuild token usage from the new session's history.
    cfg = loadConfig(ctx.cwd);
    managedModelId = resolveManagedModelId(ctx);

    // Reset active provider/model view; will be rehydrated from ctx/model_select.
    activeProvider = undefined;
    activeModelId = undefined;
    rememberActiveFromCtx(ctx);

    rebuildFallbackUsageFromSession(ctx);

    clearRetryTimer();
    retryPrimaryAfter = 0;
    updateStatus(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadConfig(ctx.cwd);
    managedModelId = resolveManagedModelId(ctx);
    rememberActiveFromCtx(ctx);

    rebuildFallbackUsageFromSession(ctx);

    clearRetryTimer();
    if (retryPrimaryAfter) {
      schedulePrimaryRetry(ctx);
    }

    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    clearRetryTimer();
  });
}
