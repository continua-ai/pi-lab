import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Context, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";

const WIDGET_KEY = "live-commentary";
const START_DELAY_MS = 10_000;
const INTERVAL_MS = 10_000;
const MAX_ACTIONS = 3;
const DISPLAY_TRUNCATE = 120;
const MAX_CONTEXT_LINES = 6;
const MAX_CONTEXT_CHARS = 2000;
const MAX_PROMPT_CHARS = 1000;
const CONTEXT_LINE_TRUNCATE = 280;
const MAX_ACCUMULATED_CHARS = 200_000;
const OVERLAP_WINDOW_CHARS = 2000;
const OUTPUT_SNIPPET_CHARS = 12_000;
const OUTPUT_HEAD_CHARS = 4_000;
const OUTPUT_TAIL_CHARS = 4_000;
const OUTPUT_FILE_SNIPPET_BYTES = 12_000;
const OUTPUT_FILE_HEAD_BYTES = 6_000;
const OUTPUT_FILE_TAIL_BYTES = 6_000;
const SUMMARY_MAX_CHARS = 200;
const SILENCE_CANCEL_MS = 30_000;
const SETTINGS_FILE_NAME = "settings.json";
const DEFAULT_CONFIG_DIR = ".pi";
const EXTENSIONS_CONFIG_KEY = "extensionsConfig";
const LIVE_COMMENTARY_CONFIG_KEY = "liveCommentary";
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

type OutputSnapshot = {
  text: string;
  source: "file" | "memory";
  truncated: boolean;
  note?: string;
  totalBytes?: number;
};

type ContextSnapshot = {
  prompt?: string;
  lines: string[];
};

type LiveCommentaryConfig = {
  model?: string;
};

type ModelResolution = {
  model?: Model<Api>;
  apiKey?: string;
  reason?: string;
};

type ToolRun = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  startedAt: number;
  outputTail: string;
  outputHistory: string;
  fullOutputPath?: string;
  lastOutputAt?: number;
  contextPrompt?: string;
  contextLines: string[];
  settings: LiveCommentaryConfig;
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

function expandHomeDir(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

function getAgentSettingsPath(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = envDir ? expandHomeDir(envDir) : join(homedir(), DEFAULT_CONFIG_DIR, "agent");
  return join(agentDir, SETTINGS_FILE_NAME);
}

function getProjectSettingsPath(cwd: string): string {
  const baseDir = cwd || process.cwd();
  return join(baseDir, DEFAULT_CONFIG_DIR, SETTINGS_FILE_NAME);
}

async function loadSettingsFile(pathValue: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(pathValue, "utf8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractLiveCommentaryConfig(settings: Record<string, unknown> | null): LiveCommentaryConfig {
  if (!settings) return {};
  const extensionsConfig = settings[EXTENSIONS_CONFIG_KEY];
  if (!isRecord(extensionsConfig)) return {};
  const liveCommentary = extensionsConfig[LIVE_COMMENTARY_CONFIG_KEY];
  if (!isRecord(liveCommentary)) return {};
  const model = typeof liveCommentary.model === "string" ? liveCommentary.model : undefined;
  return model ? { model } : {};
}

async function loadLiveCommentaryConfig(ctx: ExtensionContext): Promise<LiveCommentaryConfig> {
  const [globalSettings, projectSettings] = await Promise.all([
    loadSettingsFile(getAgentSettingsPath()),
    loadSettingsFile(getProjectSettingsPath(ctx.cwd)),
  ]);
  const globalConfig = extractLiveCommentaryConfig(globalSettings);
  const projectConfig = extractLiveCommentaryConfig(projectSettings);
  return { ...globalConfig, ...projectConfig };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function normalizeOutputText(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function clampOutputHistory(text: string): string {
  if (text.length <= MAX_ACCUMULATED_CHARS) return text;
  return text.slice(text.length - MAX_ACCUMULATED_CHARS);
}

function mergeOutput(existing: string, next: string): string {
  if (!next) return existing;
  if (!existing) return next;
  if (next.includes(existing)) return clampOutputHistory(next);

  const maxOverlap = Math.min(existing.length, next.length, OVERLAP_WINDOW_CHARS);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (existing.endsWith(next.slice(0, size))) {
      return clampOutputHistory(existing + next.slice(size));
    }
  }

  const separator = existing.endsWith("\n") || next.startsWith("\n") ? "" : "\n";
  return clampOutputHistory(`${existing}${separator}${next}`);
}

async function readFileRange(filePath: string, start: number, length: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.slice(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function buildMemorySnapshot(output: string): OutputSnapshot {
  const normalized = normalizeOutputText(output).trim();
  if (!normalized) {
    return { text: "", source: "memory", truncated: false };
  }
  if (normalized.length <= OUTPUT_SNIPPET_CHARS) {
    return { text: normalized, source: "memory", truncated: false };
  }
  const head = normalized.slice(0, OUTPUT_HEAD_CHARS);
  const tail = normalized.slice(-OUTPUT_TAIL_CHARS);
  return {
    text: `${head}\n...\n${tail}`,
    source: "memory",
    truncated: true,
    note: `Output truncated (${normalized.length} chars)`,
  };
}

async function buildFileSnapshot(filePath: string): Promise<OutputSnapshot | null> {
  try {
    const info = await stat(filePath);
    if (info.size <= OUTPUT_FILE_SNIPPET_BYTES) {
      const content = await readFile(filePath, "utf8");
      return {
        text: normalizeOutputText(content).trim(),
        source: "file",
        truncated: false,
        totalBytes: info.size,
      };
    }

    const head = await readFileRange(filePath, 0, OUTPUT_FILE_HEAD_BYTES);
    const tailStart = Math.max(0, info.size - OUTPUT_FILE_TAIL_BYTES);
    const tail = await readFileRange(filePath, tailStart, OUTPUT_FILE_TAIL_BYTES);
    return {
      text: `${normalizeOutputText(head)}\n...\n${normalizeOutputText(tail)}`.trim(),
      source: "file",
      truncated: true,
      note: `Output truncated (${formatBytes(info.size)} total)`,
      totalBytes: info.size,
    };
  } catch {
    return null;
  }
}

async function buildOutputSnapshot(run: ToolRun): Promise<OutputSnapshot> {
  if (run.fullOutputPath) {
    const fileSnapshot = await buildFileSnapshot(run.fullOutputPath);
    if (fileSnapshot) return fileSnapshot;
  }
  return buildMemorySnapshot(run.outputHistory || run.outputTail);
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

function extractTextFromContentValue(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextContent => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function extractTextFromMessage(message: AgentMessage): string {
  if (!isRecord(message) || typeof message.role !== "string") return "";
  if (message.role === "bashExecution") {
    const output = message.output;
    return typeof output === "string" ? output : "";
  }
  if ("content" in message) {
    return extractTextFromContentValue(message.content);
  }
  return "";
}

function summarizeMessage(message: AgentMessage): string | null {
  if (!isRecord(message) || typeof message.role !== "string") return null;
  const role = message.role;

  if (role === "user" || role === "assistant") {
    const text = extractTextFromMessage(message);
    if (!text) return null;
    const label = role === "user" ? "User" : "Assistant";
    return `${label}: ${truncateText(normalizeLine(text), CONTEXT_LINE_TRUNCATE)}`;
  }

  if (role === "toolResult") {
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const text = extractTextFromMessage(message);
    const detail = text ? truncateText(normalizeLine(text), CONTEXT_LINE_TRUNCATE) : "(no output)";
    return `Tool result (${toolName}): ${detail}`;
  }

  if (role === "bashExecution") {
    const command = typeof message.command === "string" ? message.command : "(unknown command)";
    const output = extractTextFromMessage(message);
    const lastLine = output ? getLastLine(normalizeOutputText(output)) : "";
    const detail = lastLine ? ` — ${truncateText(normalizeLine(lastLine), CONTEXT_LINE_TRUNCATE)}` : "";
    return `Bash: ${truncateText(normalizeLine(command), CONTEXT_LINE_TRUNCATE)}${detail}`;
  }

  if (role === "custom") {
    const customType = typeof message.customType === "string" ? message.customType : "custom";
    const text = extractTextFromMessage(message);
    if (!text) return null;
    return `Custom (${customType}): ${truncateText(normalizeLine(text), CONTEXT_LINE_TRUNCATE)}`;
  }

  return null;
}

function summarizeSessionEntry(entry: SessionEntry): string | null {
  if (entry.type === "message") {
    return summarizeMessage(entry.message);
  }
  if (entry.type === "custom_message") {
    const text = extractTextFromContentValue(entry.content);
    if (!text) return null;
    return `Custom (${entry.customType}): ${truncateText(normalizeLine(text), CONTEXT_LINE_TRUNCATE)}`;
  }
  return null;
}

function limitContextLines(lines: string[]): string[] {
  const normalized = lines.map((line) => truncateText(normalizeLine(line), CONTEXT_LINE_TRUNCATE));
  let total = 0;
  const result: string[] = [];

  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    const line = normalized[i];
    if (result.length >= MAX_CONTEXT_LINES) break;
    if (total + line.length > MAX_CONTEXT_CHARS && result.length > 0) break;
    total += line.length;
    result.push(line);
  }

  return result.reverse();
}

function buildContextSnapshot(ctx: ExtensionContext): ContextSnapshot {
  const entries = ctx.sessionManager.getBranch();
  const lines: string[] = [];
  let prompt: string | undefined;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const summary = summarizeSessionEntry(entry);
    if (summary) lines.push(summary);

    if (!prompt && entry.type === "message" && entry.message.role === "user") {
      const text = extractTextFromMessage(entry.message);
      if (text) {
        prompt = text;
      }
    }

    if (lines.length >= MAX_CONTEXT_LINES && prompt) break;
  }

  const orderedLines = lines.reverse();
  return {
    prompt: prompt ? truncateText(normalizeLine(prompt), MAX_PROMPT_CHARS) : undefined,
    lines: limitContextLines(orderedLines),
  };
}

function getSilenceMs(run: ToolRun): number {
  const lastOutputAt = run.lastOutputAt ?? run.startedAt;
  return Math.max(0, Date.now() - lastOutputAt);
}

function getOutputStats(text: string): { lines: number; chars: number } {
  if (!text) return { lines: 0, chars: 0 };
  return { lines: text.split("\n").length, chars: text.length };
}

function outputLooksErrored(text: string): boolean {
  const lowered = text.toLowerCase();
  const tokens = ["error", "failed", "exception", "traceback", "panic", "fatal", "permission denied", "not found"];
  return tokens.some((token) => lowered.includes(token));
}

function hasActionKeyword(actions: CommentaryAction[], keyword: string): boolean {
  const lowered = keyword.toLowerCase();
  return actions.some((action) => {
    const label = action.label.toLowerCase();
    const kind = action.kind?.toLowerCase();
    return kind === lowered || label.includes(lowered);
  });
}

function addAction(actions: CommentaryAction[], action: CommentaryAction): void {
  const label = action.label.toLowerCase();
  const kind = action.kind?.toLowerCase();
  const exists = actions.some((existing) => {
    const existingLabel = existing.label.toLowerCase();
    const existingKind = existing.kind?.toLowerCase();
    return existingLabel === label || (kind && existingKind === kind);
  });
  if (!exists) {
    actions.push(action);
  }
}

function applyActionHeuristics(
  run: ToolRun,
  snapshot: OutputSnapshot,
  actions: CommentaryAction[] | undefined,
): CommentaryAction[] | undefined {
  const next = actions ? [...actions] : [];
  const silenceMs = getSilenceMs(run);

  if (silenceMs >= SILENCE_CANCEL_MS && !hasActionKeyword(next, "cancel")) {
    addAction(next, {
      label: "Cancel command",
      detail: `No output for ${formatDuration(silenceMs)}. Press Esc or Ctrl+C to interrupt.`,
      kind: "cancel",
    });
  }

  if (run.fullOutputPath && snapshot.truncated && !hasActionKeyword(next, "output")) {
    addAction(next, {
      label: "Inspect full output",
      detail: run.fullOutputPath,
      kind: "open-output",
    });
  }

  if (snapshot.text && outputLooksErrored(snapshot.text) && !hasActionKeyword(next, "retry")) {
    addAction(next, {
      label: "Retry with verbose logging",
      detail: "Look for --verbose or --debug flags if supported.",
      kind: "retry",
    });
  }

  if (next.length === 0) return undefined;
  return next.slice(0, MAX_ACTIONS);
}

function finalizeCommentary(run: ToolRun, snapshot: OutputSnapshot, result: CommentaryResult): CommentaryResult {
  const silenceMs = getSilenceMs(run);
  let summary = normalizeLine(result.summary ?? "");
  if (!summary) {
    summary = run.lastOutputAt ? `No new output for ${formatDuration(silenceMs)}.` : "Waiting for output...";
  }
  return {
    summary: truncateText(summary, SUMMARY_MAX_CHARS),
    actions: applyActionHeuristics(run, snapshot, result.actions),
  };
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

async function resolveCommentaryModel(
  ctx: ExtensionContext,
  overrideModel: string | undefined,
): Promise<ModelResolution> {
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) {
    return { reason: "Live commentary unavailable (no authenticated providers)" };
  }

  if (overrideModel) {
    const parsed = parseModelSpecifier(overrideModel, ctx.model?.provider);
    let model: Model<Api> | undefined;

    if (parsed.provider) {
      model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    }

    if (!model) {
      const candidates = available.filter((item) => item.id === parsed.id);
      if (candidates.length > 0 && ctx.model?.provider) {
        model = candidates.find((item) => item.provider === ctx.model?.provider);
      }
      model ??= candidates[0];
    }

    if (!model) {
      return { reason: `Live commentary unavailable (model override not found: ${overrideModel})` };
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      return { reason: `Live commentary unavailable (no API key for ${model.provider})` };
    }

    return { model, apiKey };
  }

  const currentProvider = ctx.model?.provider;
  const candidatePools: Array<Array<Model<Api>>> = [];

  if (currentProvider) {
    const providerModels = available.filter((model) => model.provider === currentProvider);
    if (providerModels.length > 0) {
      candidatePools.push(providerModels);
    }
  }

  candidatePools.push(available);

  const tried = new Set<string>();
  for (const pool of candidatePools) {
    const preferred = findPreferredModel(pool, CHEAP_MODEL_HINTS);
    const ordered = preferred ? [preferred, ...pool.filter((model) => model !== preferred)] : pool;

    for (const model of ordered) {
      const key = `${model.provider}/${model.id}`;
      if (tried.has(key)) continue;
      tried.add(key);

      const apiKey = await ctx.modelRegistry.getApiKey(model);
      if (apiKey) {
        return { model, apiKey };
      }
    }
  }

  return { reason: "Live commentary unavailable (no API key available)" };
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
  return result.length > 0 ? result : undefined;
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
  const resolution = await resolveCommentaryModel(ctx, run.settings.model);
  if (!resolution.model || !resolution.apiKey) {
    run.disabledReason = resolution.reason ?? "Live commentary unavailable";
    return false;
  }
  run.model = resolution.model;
  run.apiKey = resolution.apiKey;
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

  const outputText = run.outputTail || run.outputHistory;
  const silenceMs = getSilenceMs(run);
  const silenceLabel = run.lastOutputAt
    ? ` (${formatDuration(silenceMs)} ago)`
    : ` (${formatDuration(silenceMs)} elapsed)`;
  const lastLine = getLastLine(outputText);
  if (lastLine) {
    lines.push(theme.fg("dim", `Last output: ${truncateText(lastLine)}${silenceLabel}`));
  } else {
    lines.push(theme.fg("dim", `Last output: (no output yet)${silenceLabel}`));
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
  const outputSnapshot = await buildOutputSnapshot(run);
  const outputText = outputSnapshot.text || "(no output yet)";
  const command = getCommandFromArgs(run.args) ?? "(unknown command)";
  const silenceMs = getSilenceMs(run);
  const silenceLabel = run.lastOutputAt
    ? `${formatDuration(silenceMs)} since last output`
    : `${formatDuration(silenceMs)} since start`;
  const outputStats = getOutputStats(outputSnapshot.text);
  const contextLines = run.contextLines.length > 0 ? run.contextLines : ["(none)"];
  const promptText = run.contextPrompt ?? "(unknown prompt)";
  const cwd = ctx.sessionManager.getCwd() || "(unknown)";

  const outputMeta: string[] = [`Output source: ${outputSnapshot.source}${outputSnapshot.truncated ? " (truncated)" : ""}`];
  if (outputSnapshot.note) outputMeta.push(`Output note: ${outputSnapshot.note}`);
  if (outputStats.chars > 0) {
    outputMeta.push(`Output stats: ${outputStats.lines} lines, ${outputStats.chars} chars`);
  }

  const systemPrompt =
    "You monitor a running terminal command and provide live commentary. " +
    "Use the user prompt, recent context, and full output snippet to infer progress. " +
    "If output is stale or the command appears hung, suggest cancel/interrupt. " +
    "If errors appear, suggest retries or diagnostics. " +
    "Respond with JSON only: {\"summary\": string, \"actions\": [{\"label\": string, \"detail\": string?, \"command\": string?, \"kind\": string?}]}. " +
    `Keep the summary under ${SUMMARY_MAX_CHARS} characters and actions under ${MAX_ACTIONS}.`;

  const userText = [
    `Command: ${command}`,
    `Elapsed: ${elapsed}`,
    `Silence: ${silenceLabel}`,
    `Cwd: ${cwd}`,
    `User prompt: ${promptText}`,
    "Recent context:",
    contextLines.map((line) => `- ${line}`).join("\n"),
    ...outputMeta,
    "Output:",
    outputText,
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
    sessionId: ctx.sessionManager.getSessionId(),
  });

  const responseText = result.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");

  return finalizeCommentary(run, outputSnapshot, parseCommentaryResponse(responseText));
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

async function handleToolStart(event: ToolExecutionStartEvent, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  if (event.toolName !== "bash") return;

  clearRun(ctx);

  const [contextSnapshot, settings] = await Promise.all([
    Promise.resolve(buildContextSnapshot(ctx)),
    loadLiveCommentaryConfig(ctx),
  ]);

  activeRun = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: event.args,
    startedAt: Date.now(),
    outputTail: "",
    outputHistory: "",
    contextPrompt: contextSnapshot.prompt,
    contextLines: contextSnapshot.lines,
    settings,
    inFlight: false,
    active: true,
  };

  scheduleCommentary(ctx, activeRun);
}

function handleToolUpdate(event: ToolExecutionUpdateEvent): void {
  if (!activeRun || !activeRun.active) return;
  if (event.toolCallId !== activeRun.toolCallId) return;

  const details = event.partialResult.details;
  if (isRecord(details)) {
    const fullOutputPath = details.fullOutputPath;
    if (typeof fullOutputPath === "string") {
      activeRun.fullOutputPath = fullOutputPath;
    }
  }

  const text = extractTextContent(event.partialResult.content);
  if (!text) return;

  const normalized = normalizeOutputText(text);
  activeRun.outputTail = normalized;
  activeRun.outputHistory = mergeOutput(activeRun.outputHistory, normalized);
  activeRun.lastOutputAt = Date.now();
}

function handleToolEnd(event: ToolExecutionEndEvent, ctx: ExtensionContext): void {
  if (!activeRun) return;
  if (event.toolCallId !== activeRun.toolCallId) return;
  clearRun(ctx);
}

export default function liveCommentary(pi: ExtensionAPI): void {
  pi.on("tool_execution_start", (event, ctx) => {
    void handleToolStart(event, ctx);
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
