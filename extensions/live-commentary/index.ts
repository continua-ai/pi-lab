import type {
  ExtensionAPI,
  ExtensionContext,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Context, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";

const WIDGET_KEY = "live-commentary";
const START_DELAY_MS = 10_000;
const INTERVAL_MS = 10_000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_OUTPUT_LINES = 80;
const MAX_ACTIONS = 3;
const DISPLAY_TRUNCATE = 120;
const MODEL_ENV = "PI_LIVE_COMMENTARY_MODEL";
const CHEAP_MODEL_HINTS = ["mini", "haiku", "flash", "small", "lite"];

type CommentaryAction = {
  label: string;
  detail?: string;
  command?: string;
  kind?: string;
};

type CommentaryResult = {
  summary: string;
  actions?: CommentaryAction[];
};

type ToolRun = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  startedAt: number;
  output: string;
  lastOutputAt?: number;
  summary?: CommentaryResult;
  startTimer?: NodeJS.Timeout;
  nextTimer?: NodeJS.Timeout;
  analysisAbort?: AbortController;
  inFlight: boolean;
  active: boolean;
  model?: Model<Api>;
  apiKey?: string;
  disabledReason?: string;
};

let activeRun: ToolRun | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function truncateText(text: string, max = DISPLAY_TRUNCATE): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimOutput(text: string): string {
  const normalized = stripAnsi(text).replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const lines = normalized.split("\n");
  const trimmedLines = lines.slice(-MAX_OUTPUT_LINES);
  const joined = trimmedLines.join("\n");
  if (joined.length <= MAX_OUTPUT_CHARS) return joined;
  return joined.slice(Math.max(0, joined.length - MAX_OUTPUT_CHARS));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function extractTextContent(content: Array<TextContent | ImageContent> | undefined): string {
  if (!content) return "";
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function getLastLine(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const lines = normalized.split("\n");
  return lines[lines.length - 1] ?? "";
}

function getCommandFromArgs(args: Record<string, unknown>): string | undefined {
  const command = args.command;
  return typeof command === "string" ? command : undefined;
}

function parseModelSpecifier(spec: string, fallbackProvider?: string): { provider?: string; id: string } {
  const trimmed = spec.trim();
  if (trimmed.includes("/")) {
    const [provider, id] = trimmed.split("/", 2);
    return { provider, id };
  }
  return { provider: fallbackProvider, id: trimmed };
}

function findPreferredModel(models: Array<Model<Api>>, hints: string[]): Model<Api> | undefined {
  for (const hint of hints) {
    const lowered = hint.toLowerCase();
    const match = models.find((model) => {
      const id = model.id.toLowerCase();
      const name = model.name?.toLowerCase() ?? "";
      return id.includes(lowered) || name.includes(lowered);
    });
    if (match) return match;
  }
  return undefined;
}

function resolveCommentaryModel(ctx: ExtensionContext): Model<Api> | undefined {
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) return undefined;

  const override = process.env[MODEL_ENV];
  if (override) {
    const parsed = parseModelSpecifier(override, ctx.model?.provider);
    if (parsed.provider) {
      const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
      if (model) return model;
    }
    const byId = available.find((model) => model.id === parsed.id);
    if (byId) return byId;
  }

  const provider = ctx.model?.provider;
  const providerModels = provider ? available.filter((model) => model.provider === provider) : [];
  const preferred = findPreferredModel(providerModels, CHEAP_MODEL_HINTS);
  if (preferred) return preferred;

  const globalPreferred = findPreferredModel(available, CHEAP_MODEL_HINTS);
  if (globalPreferred) return globalPreferred;

  const current = ctx.model;
  if (current) {
    const availableCurrent = available.find((model) => model.provider === current.provider && model.id === current.id);
    if (availableCurrent) return availableCurrent;
  }

  return available[0];
}

function extractJsonBlock(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function normalizeActions(actions: unknown): CommentaryAction[] | undefined {
  if (!Array.isArray(actions)) return undefined;
  const result: CommentaryAction[] = [];
  for (const item of actions) {
    if (!isRecord(item)) continue;
    const label = item.label;
    if (typeof label !== "string" || !label.trim()) continue;
    const detail = typeof item.detail === "string" ? item.detail : undefined;
    const command = typeof item.command === "string" ? item.command : undefined;
    const kind = typeof item.kind === "string" ? item.kind : undefined;
    result.push({ label: label.trim(), detail, command, kind });
  }
  return result.length > 0 ? result.slice(0, MAX_ACTIONS) : undefined;
}

function parseCommentaryResponse(text: string): CommentaryResult {
  const trimmed = text.trim();
  const jsonBlock = extractJsonBlock(trimmed);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock) as unknown;
      if (isRecord(parsed) && typeof parsed.summary === "string") {
        return {
          summary: parsed.summary.trim(),
          actions: normalizeActions(parsed.actions),
        };
      }
    } catch {
      // Fall back to raw text
    }
  }

  return { summary: trimmed };
}

async function ensureModel(ctx: ExtensionContext, run: ToolRun): Promise<boolean> {
  if (run.model && run.apiKey) return true;
  const model = resolveCommentaryModel(ctx);
  if (!model) {
    run.disabledReason = "Live commentary unavailable (no available model)";
    return false;
  }
  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    run.disabledReason = `Live commentary unavailable (no API key for ${model.provider})`;
    return false;
  }
  run.model = model;
  run.apiKey = apiKey;
  return true;
}

function buildWidgetLines(ctx: ExtensionContext, run: ToolRun, status?: string): string[] {
  const theme = ctx.ui.theme;
  const elapsed = formatDuration(Date.now() - run.startedAt);
  const lines: string[] = [];

  lines.push(theme.fg("accent", "Live commentary"));
  lines.push(theme.fg("muted", `${run.toolName} • ${elapsed}`));

  const command = getCommandFromArgs(run.args);
  if (command) {
    lines.push(theme.fg("dim", `Command: ${truncateText(command)}`));
  }

  if (run.disabledReason) {
    lines.push(theme.fg("error", run.disabledReason));
    lines.push(theme.fg("muted", "Press Ctrl+C to cancel the command."));
    return lines;
  }

  const lastLine = getLastLine(run.output);
  if (lastLine) {
    lines.push(theme.fg("dim", `Last output: ${truncateText(lastLine)}`));
  } else {
    lines.push(theme.fg("dim", "Last output: (no output yet)"));
  }

  if (status) {
    lines.push(theme.fg("muted", status));
  } else if (run.summary?.summary) {
    lines.push(truncateText(normalizeLine(run.summary.summary)));
  } else {
    lines.push(theme.fg("muted", "Analyzing output..."));
  }

  const actions = run.summary?.actions;
  if (actions && actions.length > 0) {
    lines.push(theme.fg("muted", "Suggestions:"));
    for (const action of actions) {
      const parts = [action.label];
      if (action.command) parts.push(`cmd: ${action.command}`);
      if (action.detail) parts.push(action.detail);
      lines.push(`- ${truncateText(normalizeLine(parts.join(" — ")))}`);
    }
  }

  return lines;
}

async function generateCommentary(ctx: ExtensionContext, run: ToolRun): Promise<CommentaryResult> {
  if (!run.model || !run.apiKey) {
    throw new Error("No commentary model available");
  }

  const elapsed = formatDuration(Date.now() - run.startedAt);
  const output = trimOutput(run.output);
  const command = getCommandFromArgs(run.args) ?? "(unknown command)";

  const systemPrompt =
    "You monitor a running terminal command. Summarize what is happening and why it might be slow. " +
    "Provide up to 3 actionable next steps. Respond with JSON only: {\"summary\": string, \"actions\": [{\"label\": string, \"detail\": string?, \"command\": string?, \"kind\": string?}]}. " +
    "Keep the summary under 200 characters. Keep actions short.";

  const userText = [
    `Command: ${command}`,
    `Elapsed: ${elapsed}`,
    "Output (tail):",
    output || "(no output yet)",
  ].join("\n");

  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userText }],
      },
    ],
  };

  const result = await completeSimple(run.model, context, {
    apiKey: run.apiKey,
    maxTokens: 300,
    temperature: 0.2,
    signal: run.analysisAbort?.signal,
  });

  const responseText = result.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");

  return parseCommentaryResponse(responseText);
}

function clearRun(ctx: ExtensionContext | undefined): void {
  if (!activeRun) return;
  if (activeRun.startTimer) clearTimeout(activeRun.startTimer);
  if (activeRun.nextTimer) clearTimeout(activeRun.nextTimer);
  activeRun.analysisAbort?.abort();
  activeRun.active = false;
  if (ctx?.hasUI) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
  activeRun = null;
}

async function runCommentaryLoop(ctx: ExtensionContext, run: ToolRun): Promise<void> {
  if (!run.active || run.inFlight || run.disabledReason) return;

  run.inFlight = true;
  run.analysisAbort?.abort();
  run.analysisAbort = new AbortController();

  if (ctx.hasUI) {
    ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(ctx, run, "Analyzing output..."));
  }

  try {
    const modelReady = await ensureModel(ctx, run);
    if (!modelReady) {
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(ctx, run));
      }
      run.inFlight = false;
      return;
    }

    const commentary = await generateCommentary(ctx, run);
    if (!run.active) return;
    run.summary = commentary;
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(ctx, run));
    }
  } catch (error) {
    if (!run.active) return;
    const message = error instanceof Error ? error.message : String(error);
    run.summary = { summary: `Commentary error: ${message}` };
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(ctx, run));
    }
  } finally {
    run.inFlight = false;
  }

  if (!run.active) return;
  run.nextTimer = setTimeout(() => runCommentaryLoop(ctx, run), INTERVAL_MS);
}

function scheduleCommentary(ctx: ExtensionContext, run: ToolRun): void {
  run.startTimer = setTimeout(() => {
    if (!run.active) return;
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(ctx, run));
    }
    void runCommentaryLoop(ctx, run);
  }, START_DELAY_MS);
}

function handleToolStart(event: ToolExecutionStartEvent, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (event.toolName !== "bash") return;

  clearRun(ctx);

  activeRun = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: event.args,
    startedAt: Date.now(),
    output: "",
    inFlight: false,
    active: true,
  };

  scheduleCommentary(ctx, activeRun);
}

function handleToolUpdate(event: ToolExecutionUpdateEvent): void {
  if (!activeRun || !activeRun.active) return;
  if (event.toolCallId !== activeRun.toolCallId) return;

  const text = extractTextContent(event.partialResult.content);
  if (!text) return;

  activeRun.output = text;
  activeRun.lastOutputAt = Date.now();
}

function handleToolEnd(event: ToolExecutionEndEvent, ctx: ExtensionContext): void {
  if (!activeRun) return;
  if (event.toolCallId !== activeRun.toolCallId) return;
  clearRun(ctx);
}

export default function liveCommentary(pi: ExtensionAPI): void {
  pi.on("tool_execution_start", (event, ctx) => {
    handleToolStart(event, ctx);
  });

  pi.on("tool_execution_update", (event) => {
    handleToolUpdate(event);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    handleToolEnd(event, ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    clearRun(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearRun(ctx);
  });
}
