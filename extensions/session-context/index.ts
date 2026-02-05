import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  DynamicBorder,
  appKeyHint,
  buildSessionContext,
  computeFileLists,
  convertToLlm,
  createFileOps,
  extractFileOpsFromMessage,
  getMarkdownTheme,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Context, Model, TextContent } from "@mariozechner/pi-ai";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { MarkdownTheme } from "@mariozechner/pi-tui";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

const EXTENSION_KEY = "session-context";
const STATUS_KEY = "session-context";
const SETTINGS_FILE_NAME = "settings.json";
const DEFAULT_CONFIG_DIR = ".pi";
const EXTENSIONS_CONFIG_KEY = "extensionsConfig";
const SESSION_CONTEXT_CONFIG_KEY = "sessionContext";
const LINE_MAX_CHARS = 140;
const MAX_CONTEXT_MESSAGES = 80;
const MAX_CONTEXT_CHARS = 18_000;
const CONTEXT_HEAD_CHARS = 6000;
const CONTEXT_TAIL_CHARS = 6000;
const MAX_RECENT_COMMANDS = 12;
const MAX_FILE_LIST = 20;
const SUMMARY_MAX_TOKENS = 900;
const CHEAP_MODEL_HINTS = ["mini", "haiku", "flash", "small", "lite"];
const ISSUE_KEY_REGEX = /[A-Z][A-Z0-9]+-\d+/g;

type SessionContextConfig = {
  model?: string;
};

type ModelResolution = {
  model?: Model<Api>;
  apiKey?: string;
  reason?: string;
};

type LinearIssue = {
  key: string;
  title?: string;
  state?: string;
  url?: string;
  assignee?: string;
};

type MessageStats = {
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  total: number;
};

type SessionContextSummary = {
  line: string;
  modal: string;
};

type StoredSessionContext = SessionContextSummary & {
  updatedAt: string;
  model?: {
    provider: string;
    id: string;
    name?: string;
  };
};

type SessionSnapshot = {
  sessionName?: string;
  cwd?: string;
  repoRoot?: string;
  branch?: string;
  lastActivity?: string;
  issueKey?: string;
  issue?: LinearIssue | null;
  messageStats: MessageStats;
  recentCommands: string[];
  files: {
    read: string[];
    modified: string[];
  };
};

let currentSummary: StoredSessionContext | null = null;
let inFlight = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatLocalTimestamp(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildStatusLine(line: string, updatedAt: Date): string {
  const updatedLabel = formatLocalTimestamp(updatedAt);
  const summary = truncateText(normalizeLine(line), LINE_MAX_CHARS);
  return `ctx: ${summary} · ${updatedLabel}`;
}

function expandHomeDir(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

function getAgentSettingsPath(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = envDir
    ? expandHomeDir(envDir)
    : join(homedir(), DEFAULT_CONFIG_DIR, "agent");
  return join(agentDir, SETTINGS_FILE_NAME);
}

function getProjectSettingsPath(cwd: string): string {
  const baseDir = cwd || process.cwd();
  return join(baseDir, DEFAULT_CONFIG_DIR, SETTINGS_FILE_NAME);
}

async function loadSettingsFile(
  pathValue: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(pathValue, "utf8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractSessionContextConfig(
  settings: Record<string, unknown> | null,
): SessionContextConfig {
  if (!settings) return {};
  const extensionsConfig = settings[EXTENSIONS_CONFIG_KEY];
  if (!isRecord(extensionsConfig)) return {};
  const sessionContext = extensionsConfig[SESSION_CONTEXT_CONFIG_KEY];
  if (!isRecord(sessionContext)) return {};
  const model =
    typeof sessionContext.model === "string"
      ? sessionContext.model
      : undefined;
  return model ? { model } : {};
}

async function loadSessionContextConfig(
  ctx: ExtensionContext,
): Promise<SessionContextConfig> {
  const [globalSettings, projectSettings] = await Promise.all([
    loadSettingsFile(getAgentSettingsPath()),
    loadSettingsFile(getProjectSettingsPath(ctx.cwd)),
  ]);
  return {
    ...extractSessionContextConfig(globalSettings),
    ...extractSessionContextConfig(projectSettings),
  };
}

function parseModelSpecifier(
  spec: string,
  fallbackProvider?: string,
): { provider?: string; id: string } {
  const trimmed = spec.trim();
  if (trimmed.includes("/")) {
    const [provider, id] = trimmed.split("/", 2);
    return { provider, id };
  }
  return { provider: fallbackProvider, id: trimmed };
}

function findPreferredModel(
  models: Array<Model<Api>>,
  hints: string[],
): Model<Api> | undefined {
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

async function resolveSummaryModel(
  ctx: ExtensionContext,
  overrideModel: string | undefined,
): Promise<ModelResolution> {
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) {
    return { reason: "Session context unavailable (no authenticated models)" };
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
      return {
        reason: `Session context unavailable (model override not found: ${overrideModel})`,
      };
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      return {
        reason: `Session context unavailable (no API key for ${model.provider})`,
      };
    }

    return { model, apiKey };
  }

  const currentProvider = ctx.model?.provider;
  const candidatePools: Array<Array<Model<Api>>> = [];

  if (currentProvider) {
    const providerModels = available.filter(
      (model) => model.provider === currentProvider,
    );
    if (providerModels.length > 0) {
      candidatePools.push(providerModels);
    }
  }

  candidatePools.push(available);

  const tried = new Set<string>();
  for (const pool of candidatePools) {
    const preferred = findPreferredModel(pool, CHEAP_MODEL_HINTS);
    const ordered = preferred
      ? [preferred, ...pool.filter((model) => model !== preferred)]
      : pool;

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

  return { reason: "Session context unavailable (no API key available)" };
}

function extractMessageStats(entries: SessionEntry[]): MessageStats {
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let total = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    total += 1;
    const message = entry.message;
    if (message.role === "user") user += 1;
    if (message.role === "assistant") {
      assistant += 1;
      for (const block of message.content) {
        if (block.type === "toolCall") toolCalls += 1;
      }
    }
    if (message.role === "toolResult") toolResults += 1;
  }

  return { user, assistant, toolCalls, toolResults, total };
}

function extractRecentCommands(entries: SessionEntry[]): string[] {
  const commands: string[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "bashExecution") continue;
    if (typeof entry.message.command !== "string") continue;
    commands.push(normalizeLine(entry.message.command));
    if (commands.length >= MAX_RECENT_COMMANDS) break;
  }
  return commands.reverse();
}

function extractFileOps(entries: SessionEntry[]): {
  read: string[];
  modified: string[];
} {
  const fileOps = createFileOps();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    extractFileOpsFromMessage(entry.message, fileOps);
  }
  const lists = computeFileLists(fileOps);
  return {
    read: lists.readFiles.slice(0, MAX_FILE_LIST),
    modified: lists.modifiedFiles.slice(0, MAX_FILE_LIST),
  };
}

function truncateConversation(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  const head = text.slice(0, CONTEXT_HEAD_CHARS);
  const tail = text.slice(text.length - CONTEXT_TAIL_CHARS);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n...(truncated ${omitted} chars)...\n\n${tail}`;
}

function buildConversationText(
  entries: SessionEntry[],
  leafId: string | null,
): string {
  const context = buildSessionContext(entries, leafId);
  const summaryMessages = context.messages.filter(
    (message) =>
      message.role === "compactionSummary" || message.role === "branchSummary",
  );
  const recentMessages = context.messages.filter(
    (message) =>
      message.role !== "compactionSummary" &&
      message.role !== "branchSummary",
  );
  const tail = recentMessages.slice(-MAX_CONTEXT_MESSAGES);
  const combined = [...summaryMessages, ...tail];
  const serialized = serializeConversation(convertToLlm(combined));
  return truncateConversation(serialized);
}

function findIssueKey(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(ISSUE_KEY_REGEX);
    if (match && match.length > 0) return match[0];
  }
  return undefined;
}

async function fetchLinearIssue(issueKey: string): Promise<LinearIssue | null> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return null;

  const query = `query IssueByKey($issueKey: String!) {
  issues(filter: { identifier: { eq: $issueKey } }) {
    nodes {
      identifier
      title
      url
      state { name }
      assignee { name }
    }
  }
}`;

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables: { issueKey } }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      data?: {
        issues?: {
          nodes?: Array<{
            identifier?: string;
            title?: string;
            url?: string;
            state?: { name?: string } | null;
            assignee?: { name?: string } | null;
          }>;
        };
      };
    };

    const node = data.data?.issues?.nodes?.[0];
    if (!node || !node.identifier) return null;
    return {
      key: node.identifier,
      title: node.title,
      url: node.url,
      state: node.state?.name,
      assignee: node.assignee?.name,
    };
  } catch {
    return null;
  }
}

async function execGit(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", ["--no-pager", ...args], {
      cwd,
      timeout: 2000,
    });
    if (result.code !== 0) return undefined;
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getGitInfo(
  pi: ExtensionAPI,
  cwd: string,
): Promise<{ branch?: string; root?: string }> {
  const [branch, root] = await Promise.all([
    execGit(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    execGit(pi, cwd, ["rev-parse", "--show-toplevel"]),
  ]);
  return { branch, root };
}

async function buildSessionSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<{ snapshot: SessionSnapshot; conversation: string }> {
  const entries = ctx.sessionManager.getBranch();
  const leafId = ctx.sessionManager.getLeafId();
  const lastEntry = entries[entries.length - 1];
  const lastActivity = lastEntry?.timestamp;

  const sessionName = ctx.sessionManager.getSessionName();
  const cwd = ctx.sessionManager.getCwd();

  const { branch, root } = await getGitInfo(pi, cwd);
  const issueKey = findIssueKey([sessionName, cwd, branch, root]);
  const issue = issueKey ? await fetchLinearIssue(issueKey) : null;

  const snapshot: SessionSnapshot = {
    sessionName,
    cwd,
    repoRoot: root,
    branch,
    lastActivity,
    issueKey,
    issue,
    messageStats: extractMessageStats(entries),
    recentCommands: extractRecentCommands(entries),
    files: extractFileOps(entries),
  };

  const conversation = buildConversationText(
    ctx.sessionManager.getEntries(),
    leafId,
  );

  return { snapshot, conversation };
}

function extractJsonBlock(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function parseSummaryResponse(text: string): SessionContextSummary {
  const trimmed = text.trim();
  const jsonBlock = extractJsonBlock(trimmed);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock) as unknown;
      if (isRecord(parsed)) {
        const line =
          typeof parsed.line === "string" ? parsed.line : undefined;
        const modal =
          typeof parsed.modal === "string" ? parsed.modal : undefined;
        if (line && modal) {
          return { line: line.trim(), modal: modal.trim() };
        }
      }
    } catch {
      // fallthrough
    }
  }

  const fallbackLine = trimmed.split("\n")[0] ?? "";
  return {
    line: fallbackLine,
    modal: trimmed || "Session context unavailable.",
  };
}

async function generateSummary(
  ctx: ExtensionContext,
  model: Model<Api>,
  apiKey: string,
  snapshot: SessionSnapshot,
  conversation: string,
  signal: AbortSignal,
): Promise<SessionContextSummary> {
  const systemPrompt =
    "You create session context summaries for a coding agent UI. " +
    "Respond with JSON only: {\"line\": string, \"modal\": string}. " +
    `The line must be one sentence, no newlines, max ${LINE_MAX_CHARS} chars. ` +
    "The modal must be markdown with clear sections (use ## headings), " +
    "covering goal, progress, next steps, risks/questions, and references (issues/PRs/tests/files) when available. " +
    "Avoid repeating cwd/branch/model/tokens unless they matter to the summary. " +
    "Omit sections that have no useful content. No code fences.";

  const metadata = JSON.stringify(snapshot, null, 2);
  const userPrompt = [
    "Session metadata (JSON):",
    metadata,
    "",
    "Conversation (serialized):",
    conversation || "(no conversation)",
  ].join("\n");

  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
      },
    ],
  };

  const result = await completeSimple(model, context, {
    apiKey,
    maxTokens: SUMMARY_MAX_TOKENS,
    temperature: 0.2,
    signal,
    sessionId: ctx.sessionManager.getSessionId(),
  });

  const responseText = result.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");

  const parsed = parseSummaryResponse(responseText);
  const line = normalizeLine(parsed.line) || "Session context updated";
  const modal = parsed.modal.trim() || "Session context updated.";
  return {
    line: truncateText(line, LINE_MAX_CHARS),
    modal,
  };
}

function storeSummary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  summary: SessionContextSummary,
  updatedAt: Date,
  model: Model<Api> | undefined,
): void {
  const stored: StoredSessionContext = {
    line: summary.line,
    modal: summary.modal,
    updatedAt: updatedAt.toISOString(),
    model: model
      ? {
          provider: model.provider,
          id: model.id,
          name: model.name,
        }
      : undefined,
  };

  pi.appendEntry(EXTENSION_KEY, stored);
  applySummaryStatus(ctx, stored);
}

function loadStoredSummary(ctx: ExtensionContext): StoredSessionContext | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;
    if (entry.customType !== EXTENSION_KEY) continue;
    if (!isRecord(entry.data)) continue;
    const line = entry.data.line;
    const modal = entry.data.modal;
    const updatedAt = entry.data.updatedAt;
    if (
      typeof line === "string" &&
      typeof modal === "string" &&
      typeof updatedAt === "string"
    ) {
      return {
        line,
        modal,
        updatedAt,
        model: isRecord(entry.data.model)
          ? {
              provider: String(entry.data.model.provider ?? ""),
              id: String(entry.data.model.id ?? ""),
              name:
                typeof entry.data.model.name === "string"
                  ? entry.data.model.name
                  : undefined,
            }
          : undefined,
      };
    }
  }
  return null;
}

function applySummaryStatus(
  ctx: ExtensionContext,
  stored: StoredSessionContext | null,
): void {
  currentSummary = stored;
  if (!ctx.hasUI) return;
  if (!stored) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const updatedAt = new Date(stored.updatedAt);
  ctx.ui.setStatus(STATUS_KEY, buildStatusLine(stored.line, updatedAt));
}

function applyStoredSummary(ctx: ExtensionContext): void {
  applySummaryStatus(ctx, loadStoredSummary(ctx));
}

class SessionContextModal extends Container {
  private markdown: string;
  private markdownTheme: MarkdownTheme;
  private keybindings: KeybindingsManager;
  private theme: Theme;
  private onClose: () => void;

  constructor(
    markdown: string,
    markdownTheme: MarkdownTheme,
    keybindings: KeybindingsManager,
    theme: Theme,
    onClose: () => void,
  ) {
    super();
    this.markdown = markdown;
    this.markdownTheme = markdownTheme;
    this.keybindings = keybindings;
    this.theme = theme;
    this.onClose = onClose;
    this.updateDisplay();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "interrupt")) {
      this.onClose();
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.updateDisplay();
  }

  private updateDisplay(): void {
    this.clear();
    this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        this.theme.fg("accent", this.theme.bold("Session Context")),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(
      new Markdown(this.markdown, 1, 0, this.markdownTheme, {
        color: (text: string) => this.theme.fg("text", text),
      }),
    );
    this.addChild(new Spacer(1));
    this.addChild(new Text(appKeyHint(this.keybindings, "interrupt", "close"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
  }
}

async function showSummaryModal(
  ctx: ExtensionContext,
  summary: SessionContextSummary,
  updatedAt: Date,
  model: Model<Api> | undefined,
): Promise<void> {
  if (!ctx.hasUI) return;

  const updatedLabel = formatLocalTimestamp(updatedAt);
  const modelLabel = model ? `${model.provider}/${model.id}` : "unknown";
  const modalMarkdown = `${summary.modal.trim()}\n\n---\n_Last updated: ${updatedLabel}_\n_Model: ${modelLabel}_`;

  await ctx.ui.custom<void>(
    (_tui, theme, keybindings, done) =>
      new SessionContextModal(
        modalMarkdown,
        getMarkdownTheme(),
        keybindings,
        theme,
        () => done(),
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        maxHeight: "80%",
        minWidth: 60,
      },
    },
  );
}

async function runSummaryFlow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (inFlight) {
    if (ctx.hasUI) {
      ctx.ui.notify("Session context is already updating", "warning");
    }
    return;
  }

  const previousSummary = currentSummary;
  inFlight = true;
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, "ctx: updating…");
  }

  try {
    const config = await loadSessionContextConfig(ctx);
    const resolution = await resolveSummaryModel(ctx, config.model);
    if (!resolution.model || !resolution.apiKey) {
      if (ctx.hasUI && resolution.reason) {
        ctx.ui.notify(resolution.reason, "warning");
      }
      applySummaryStatus(ctx, previousSummary);
      return;
    }

    const { snapshot, conversation } = await buildSessionSnapshot(pi, ctx);

    const abortController = new AbortController();
    let summaryResult: SessionContextSummary | null = null;
    let summaryError: Error | null = null;

    const summaryPromise = generateSummary(
      ctx,
      resolution.model,
      resolution.apiKey,
      snapshot,
      conversation,
      abortController.signal,
    )
      .then((summary) => {
        summaryResult = summary;
      })
      .catch((error) => {
        summaryError = error instanceof Error ? error : new Error(String(error));
      });

    if (ctx.hasUI) {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            done();
          };

          const loader = new BorderedLoader(
            tui,
            theme,
            "Summarizing session context…",
          );
          loader.onAbort = () => {
            abortController.abort();
            close();
          };

          summaryPromise.finally(() => {
            if (!abortController.signal.aborted) {
              close();
            }
          });

          return loader;
        },
        {
          overlay: true,
          overlayOptions: {
            width: 60,
          },
        },
      );
    }

    await summaryPromise;

    if (abortController.signal.aborted) {
      if (ctx.hasUI) {
        ctx.ui.notify("Session context update cancelled", "warning");
      }
      applySummaryStatus(ctx, previousSummary);
      return;
    }

    if (summaryError || !summaryResult) {
      if (ctx.hasUI && summaryError) {
        ctx.ui.notify(
          `Session context failed: ${summaryError.message}`,
          "error",
        );
      }
      applySummaryStatus(ctx, previousSummary);
      return;
    }

    const updatedAt = new Date();
    storeSummary(pi, ctx, summaryResult, updatedAt, resolution.model);
    await showSummaryModal(ctx, summaryResult, updatedAt, resolution.model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) {
      ctx.ui.notify(`Session context failed: ${message}`, "error");
    }
    applySummaryStatus(ctx, previousSummary);
  } finally {
    inFlight = false;
  }
}

export default function sessionContext(pi: ExtensionAPI): void {
  pi.registerCommand("session-context", {
    description: "Summarize and display session context",
    handler: async (_args, ctx) => {
      await runSummaryFlow(pi, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    applyStoredSummary(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    applyStoredSummary(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}
