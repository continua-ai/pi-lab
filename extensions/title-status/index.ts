import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type TitleStatus = "busy" | "ready" | "pending";

const STATUS_LABELS: Record<TitleStatus, string> = {
  busy: "🟣",
  ready: "✅",
  pending: "⬜",
};

function buildBaseTitle(pi: ExtensionAPI): string {
  const session = pi.getSessionName();
  const cwd = path.basename(process.cwd());

  const parts: string[] = [];
  if (session) parts.push(session);
  if (cwd && cwd !== session) parts.push(cwd);
  if (parts.length === 0 && cwd) parts.push(cwd);

  if (parts.length === 0) return "π";
  return `π - ${parts.join(" - ")}`;
}

function buildTitle(pi: ExtensionAPI, status: TitleStatus): string {
  return `${STATUS_LABELS[status]} ${buildBaseTitle(pi)}`;
}

function resolveStatus(ctx: ExtensionContext, status?: TitleStatus): TitleStatus {
  if (status) return status;
  const busy = !ctx.isIdle() || ctx.hasPendingMessages();
  return busy ? "busy" : "ready";
}

function wasInterrupted(messages: ReadonlyArray<{
  role?: string;
  stopReason?: string;
}>): boolean {
  return messages.some(
    (message) => message.role === "assistant" && message.stopReason === "aborted",
  );
}

function inTmux(): boolean {
  return Boolean(process.env.TMUX);
}

async function applyTitle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
): Promise<void> {
  if (!ctx.hasUI) return;
  if (inTmux()) {
    await pi.exec("tmux", ["select-pane", "-T", title]);
    return;
  }
  ctx.ui.setTitle(title);
}

async function updateTitle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  status?: TitleStatus,
): Promise<void> {
  const title = buildTitle(pi, resolveStatus(ctx, status));
  await applyTitle(pi, ctx, title);
}

export default function titleStatus(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await updateTitle(pi, ctx, "pending");
  });

  pi.on("session_switch", async (_event, ctx) => {
    await updateTitle(pi, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    await updateTitle(pi, ctx, "busy");
  });

  pi.on("agent_end", async (event, ctx) => {
    if (wasInterrupted(event.messages)) {
      await updateTitle(pi, ctx, "pending");
      return;
    }
    await updateTitle(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await updateTitle(pi, ctx, "ready");
  });
}
