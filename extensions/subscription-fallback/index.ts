// subscription-fallback (pi extension)
//
// v2 UX goals:
// - support multiple vendors (openai, claude)
// - support multiple auth routes per vendor (oauth + api_key)
// - failover order is the order routes are defined in config
// - model policy is always "follow_current" in v1 (no pinned model)
// - expose a command UX + LLM-callable tool bridge

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  getModels,
  loginAnthropic,
  loginOpenAICodex,
  refreshAnthropicToken,
  refreshOpenAICodexToken,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

type InputSource = "interactive" | "rpc" | "extension";
type AuthType = "oauth" | "api_key";

const EXT = "subscription-fallback";

interface RouteConfig {
  auth_type?: AuthType;
  label?: string;
  provider_id?: string;

  // API-key route material (prefer env/path over inline key)
  api_key_env?: string;
  api_key_path?: string;
  api_key?: string;

  // OpenAI optional per-route org/project env names
  openai_org_id_env?: string;
  openai_project_id_env?: string;

  // Optional per-route cooldown override
  cooldown_minutes?: number;
}

interface VendorConfig {
  vendor?: string;
  routes?: RouteConfig[];

  // Optional per-vendor defaults
  oauth_cooldown_minutes?: number;
  api_key_cooldown_minutes?: number;
  auto_retry?: boolean;
}

interface Config {
  enabled?: boolean;
  default_vendor?: string;
  vendors?: VendorConfig[];
  rate_limit_patterns?: string[];
}

interface NormalizedRoute {
  auth_type: AuthType;
  label: string;
  provider_id: string;
  api_key_env?: string;
  api_key_path?: string;
  api_key?: string;
  openai_org_id_env?: string;
  openai_project_id_env?: string;
  cooldown_minutes?: number;
}

interface NormalizedVendor {
  vendor: string;
  routes: NormalizedRoute[];
  oauth_cooldown_minutes: number;
  api_key_cooldown_minutes: number;
  auto_retry: boolean;
}

interface NormalizedConfig {
  enabled: boolean;
  default_vendor: string;
  vendors: NormalizedVendor[];
  rate_limit_patterns: string[];
}

// Legacy schema from v1 (OpenAI-only)
interface LegacyOpenAIAccount {
  name?: string;
  apiKeyEnv?: string;
  apiKeyPath?: string;
  apiKey?: string;
  openaiOrgIdEnv?: string;
  openaiProjectIdEnv?: string;
}

interface LegacyConfig {
  enabled?: boolean;
  primaryProvider?: string;
  primaryProviders?: string[];
  fallbackProvider?: string;
  modelId?: string;
  cooldownMinutes?: number;
  autoRetry?: boolean;
  rateLimitPatterns?: string[];
  fallbackAccounts?: LegacyOpenAIAccount[];
  fallbackAccountCooldownMinutes?: number;
}

interface LastPrompt {
  source: InputSource;
  text: string;
  images: any[];
}

interface OriginalEnv {
  openai_api_key?: string;
  openai_org_id?: string;
  openai_project_id?: string;
  anthropic_api_key?: string;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function splitArgs(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-")
    .slice(0, 64);
}

function titleCase(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function expandHome(path: string): string {
  if (!path) return path;
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function globalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "subswitch.json");
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "subswitch.json");
}

function legacyGlobalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "subscription-fallback.json");
}

function legacyProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "subscription-fallback.json");
}

function defaultProviderId(vendor: string, authType: AuthType): string {
  const v = vendor.toLowerCase();
  if (v === "openai" && authType === "oauth") return "openai-codex";
  if (v === "openai" && authType === "api_key") return "openai";
  if ((v === "claude" || v === "anthropic") && authType === "oauth") return "anthropic";
  if ((v === "claude" || v === "anthropic") && authType === "api_key") return "anthropic-api";
  return v;
}

function routeDisplay(vendor: string, route: { auth_type: AuthType; label: string }): string {
  return `${vendor} · ${route.auth_type} · ${route.label}`;
}

function mergeVendorLists(globalVendors: VendorConfig[] | undefined, projectVendors: VendorConfig[] | undefined): VendorConfig[] {
  const g = Array.isArray(globalVendors) ? globalVendors : [];
  const p = Array.isArray(projectVendors) ? projectVendors : [];
  if (p.length === 0) return g;

  const byVendor = new Map<string, VendorConfig>();
  const globalOrder: string[] = [];
  for (const v of g) {
    const key = String(v.vendor ?? "").trim().toLowerCase();
    if (!key) continue;
    byVendor.set(key, v);
    globalOrder.push(key);
  }

  const projectOrder: string[] = [];
  for (const v of p) {
    const key = String(v.vendor ?? "").trim().toLowerCase();
    if (!key) continue;
    byVendor.set(key, v);
    projectOrder.push(key);
  }

  const out: VendorConfig[] = [];
  const seen = new Set<string>();

  for (const key of projectOrder) {
    const v = byVendor.get(key);
    if (!v) continue;
    out.push(v);
    seen.add(key);
  }

  for (const key of globalOrder) {
    if (seen.has(key)) continue;
    const v = byVendor.get(key);
    if (!v) continue;
    out.push(v);
  }

  return out;
}

function normalizeRoute(vendor: string, route: RouteConfig, index: number): NormalizedRoute | undefined {
  const authType: AuthType = route.auth_type === "oauth" || route.auth_type === "api_key" ? route.auth_type : "oauth";

  const providerId = String(route.provider_id ?? defaultProviderId(vendor, authType)).trim();
  if (!providerId) return undefined;

  const fallbackLabel = `${authType}-${index + 1}`;
  const label = String(route.label ?? fallbackLabel).trim() || fallbackLabel;

  const out: NormalizedRoute = {
    auth_type: authType,
    label,
    provider_id: providerId,
  };

  if (route.api_key_env) out.api_key_env = String(route.api_key_env).trim();
  if (route.api_key_path) out.api_key_path = String(route.api_key_path).trim();
  if (route.api_key) out.api_key = String(route.api_key).trim();
  if (route.openai_org_id_env) out.openai_org_id_env = String(route.openai_org_id_env).trim();
  if (route.openai_project_id_env)
    out.openai_project_id_env = String(route.openai_project_id_env).trim();

  if (route.cooldown_minutes !== undefined && Number.isFinite(Number(route.cooldown_minutes))) {
    const n = Math.max(1, Math.floor(Number(route.cooldown_minutes)));
    out.cooldown_minutes = n;
  }

  return out;
}

function normalizeConfig(input: Config | undefined): NormalizedConfig {
  const vendorsInput = Array.isArray(input?.vendors) ? input?.vendors : [];

  const vendors: NormalizedVendor[] = [];
  for (const rawVendor of vendorsInput) {
    const vendorName = String(rawVendor.vendor ?? "").trim().toLowerCase();
    if (!vendorName) continue;

    const rawRoutes = Array.isArray(rawVendor.routes) ? rawVendor.routes : [];
    const routes: NormalizedRoute[] = [];
    for (let i = 0; i < rawRoutes.length; i++) {
      const normalized = normalizeRoute(vendorName, rawRoutes[i], i);
      if (normalized) routes.push(normalized);
    }

    if (routes.length === 0) continue;

    const oauthCooldown = Number.isFinite(Number(rawVendor.oauth_cooldown_minutes))
      ? Math.max(1, Math.floor(Number(rawVendor.oauth_cooldown_minutes)))
      : 180;

    const apiCooldown = Number.isFinite(Number(rawVendor.api_key_cooldown_minutes))
      ? Math.max(1, Math.floor(Number(rawVendor.api_key_cooldown_minutes)))
      : 15;

    vendors.push({
      vendor: vendorName,
      routes,
      oauth_cooldown_minutes: oauthCooldown,
      api_key_cooldown_minutes: apiCooldown,
      auto_retry: rawVendor.auto_retry ?? true,
    });
  }

  const defaultVendor = String(input?.default_vendor ?? vendors[0]?.vendor ?? "openai")
    .trim()
    .toLowerCase();

  const rateLimitPatterns = Array.isArray(input?.rate_limit_patterns)
    ? input?.rate_limit_patterns.map((p) => String(p).trim()).filter(Boolean)
    : [];

  return {
    enabled: input?.enabled ?? true,
    default_vendor: defaultVendor,
    vendors,
    rate_limit_patterns: rateLimitPatterns,
  };
}

function migrateLegacyConfig(legacy: LegacyConfig | undefined): Config | undefined {
  if (!legacy) return undefined;

  const primaries = Array.isArray(legacy.primaryProviders)
    ? legacy.primaryProviders.map((p) => String(p).trim()).filter(Boolean)
    : [];
  const primaryProvider = String(legacy.primaryProvider ?? "openai-codex").trim();

  const oauthProviders = primaries.length > 0 ? primaries : primaryProvider ? [primaryProvider] : ["openai-codex"];

  const oauthRoutes: RouteConfig[] = oauthProviders.map((providerId) => {
    let label = providerId;
    if (providerId === "openai-codex") {
      label = "personal";
    } else if (providerId.startsWith("openai-codex-")) {
      label = providerId.slice("openai-codex-".length);
    }

    return {
      auth_type: "oauth",
      label,
      provider_id: providerId,
      cooldown_minutes: legacy.cooldownMinutes,
    };
  });

  const fallbackProvider = String(legacy.fallbackProvider ?? "openai").trim() || "openai";

  const fallbackAccounts = Array.isArray(legacy.fallbackAccounts) ? legacy.fallbackAccounts : [];
  const apiRoutes: RouteConfig[] = [];

  if (fallbackAccounts.length > 0) {
    for (let i = 0; i < fallbackAccounts.length; i++) {
      const a = fallbackAccounts[i];
      const label = String(a.name ?? `api-${i + 1}`).trim() || `api-${i + 1}`;
      apiRoutes.push({
        auth_type: "api_key",
        label,
        provider_id: fallbackProvider,
        api_key_env: a.apiKeyEnv,
        api_key_path: a.apiKeyPath,
        api_key: a.apiKey,
        openai_org_id_env: a.openaiOrgIdEnv,
        openai_project_id_env: a.openaiProjectIdEnv,
        cooldown_minutes: legacy.fallbackAccountCooldownMinutes,
      });
    }
  } else {
    apiRoutes.push({
      auth_type: "api_key",
      label: "default",
      provider_id: fallbackProvider,
      api_key_env: "OPENAI_API_KEY",
      cooldown_minutes: legacy.fallbackAccountCooldownMinutes,
    });
  }

  return {
    enabled: legacy.enabled ?? true,
    default_vendor: "openai",
    rate_limit_patterns: legacy.rateLimitPatterns ?? [],
    vendors: [
      {
        vendor: "openai",
        routes: [...oauthRoutes, ...apiRoutes],
        oauth_cooldown_minutes: legacy.cooldownMinutes ?? 180,
        api_key_cooldown_minutes: legacy.fallbackAccountCooldownMinutes ?? 15,
        auto_retry: legacy.autoRetry ?? true,
      },
    ],
  };
}

function loadConfig(cwd: string): NormalizedConfig {
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(cwd);

  const globalCfg = readJson(globalPath) as Config | undefined;
  const projectCfg = readJson(projectPath) as Config | undefined;

  let merged: Config | undefined;

  if (globalCfg || projectCfg) {
    const base: Config = {
      enabled: true,
      default_vendor: "openai",
      vendors: [],
      rate_limit_patterns: [],
    };

    merged = {
      ...base,
      ...globalCfg,
      ...projectCfg,
      vendors: mergeVendorLists(globalCfg?.vendors, projectCfg?.vendors),
      rate_limit_patterns: projectCfg?.rate_limit_patterns ?? globalCfg?.rate_limit_patterns ?? [],
    };
  } else {
    const legacyGlobal = readJson(legacyGlobalConfigPath()) as LegacyConfig | undefined;
    const legacyProject = readJson(legacyProjectConfigPath(cwd)) as LegacyConfig | undefined;

    const migratedGlobal = migrateLegacyConfig(legacyGlobal);
    const migratedProject = migrateLegacyConfig(legacyProject);

    if (migratedGlobal || migratedProject) {
      merged = {
        enabled: true,
        default_vendor: "openai",
        vendors: mergeVendorLists(migratedGlobal?.vendors, migratedProject?.vendors),
        rate_limit_patterns:
          migratedProject?.rate_limit_patterns ?? migratedGlobal?.rate_limit_patterns ?? [],
      };
    }
  }

  const normalized = normalizeConfig(merged);

  if (normalized.vendors.length === 0) {
    // Safe bootstrap default: OpenAI subscription + OpenAI API key.
    return normalizeConfig({
      enabled: true,
      default_vendor: "openai",
      vendors: [
        {
          vendor: "openai",
          routes: [
            { auth_type: "oauth", label: "personal", provider_id: "openai-codex" },
            {
              auth_type: "api_key",
              label: "default",
              provider_id: "openai",
              api_key_env: "OPENAI_API_KEY",
            },
          ],
          oauth_cooldown_minutes: 180,
          api_key_cooldown_minutes: 15,
          auto_retry: true,
        },
      ],
      rate_limit_patterns: [],
    });
  }

  return normalized;
}

function configToJson(cfg: NormalizedConfig): Config {
  return {
    enabled: cfg.enabled,
    default_vendor: cfg.default_vendor,
    rate_limit_patterns: cfg.rate_limit_patterns,
    vendors: cfg.vendors.map((v) => ({
      vendor: v.vendor,
      oauth_cooldown_minutes: v.oauth_cooldown_minutes,
      api_key_cooldown_minutes: v.api_key_cooldown_minutes,
      auto_retry: v.auto_retry,
      routes: v.routes.map((r) => ({
        auth_type: r.auth_type,
        label: r.label,
        provider_id: r.provider_id,
        api_key_env: r.api_key_env,
        api_key_path: r.api_key_path,
        api_key: r.api_key,
        openai_org_id_env: r.openai_org_id_env,
        openai_project_id_env: r.openai_project_id_env,
        cooldown_minutes: r.cooldown_minutes,
      })),
    })),
  };
}

function preferredWritableConfigPath(cwd: string): string {
  const project = projectConfigPath(cwd);
  const global = globalConfigPath();

  if (existsSync(project)) return project;

  const legacyProject = legacyProjectConfigPath(cwd);
  if (existsSync(legacyProject)) return project;

  if (existsSync(global)) return global;

  const legacyGlobal = legacyGlobalConfigPath();
  if (existsSync(legacyGlobal)) return global;

  return global;
}

function isContextWindowExceededError(err: unknown): boolean {
  const s = String(err ?? "");
  const l = s.toLowerCase();

  const patterns = [
    "context window",
    "context length",
    "maximum context",
    "maximum context length",
    "max context",
    "context_length_exceeded",
    "context length exceeded",
    "this model's maximum context length",
    "prompt is too long",
    "input is too long",
    "too many tokens",
  ];

  return patterns.some((p) => p && l.includes(p));
}

function isRateLimitError(err: unknown, extraPatterns: string[] = []): boolean {
  if (isContextWindowExceededError(err)) return false;

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
    "insufficient_quota",
    "quota exceeded",
    "exceeded your current quota",
    "billing hard limit",
    "capacity",
    ...extraPatterns.map((p) => p.toLowerCase()),
  ];

  return patterns.some((p) => p && l.includes(p));
}

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

function cloneProviderModels(sourceProvider: string): any[] {
  const models = getModels(sourceProvider);
  if (!models) return [];
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    api: m.api,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    headers: m.headers,
    compat: (m as any).compat,
  }));
}

function providerBaseUrl(sourceProvider: string): string | undefined {
  const models = getModels(sourceProvider);
  if (!models || models.length === 0) return undefined;
  return (models[0] as any).baseUrl;
}

export default function (pi: ExtensionAPI): void {
  let cfg: NormalizedConfig | undefined;

  let lastCtx: any | undefined;
  let lastPrompt: LastPrompt | undefined;
  let pendingInputSource: InputSource | undefined;

  // follow_current model policy
  let managedModelId: string | undefined;

  // Current route state
  let activeVendor: string | undefined;
  const activeRouteIndexByVendor = new Map<string, number>();

  // Per-route cooldown state. Key: `${vendor}::${index}` => epoch ms
  const routeCooldownUntil = new Map<string, number>();

  // Retry timer for cooldown expiry checks
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  // Avoid feedback loops for extension-driven model changes.
  let pendingExtensionSwitch: { provider: string; modelId: string } | undefined;

  let originalEnv: OriginalEnv | undefined;

  // Keep track of aliases we registered to avoid duplicate work.
  const registeredAliases = new Set<string>();

  const LOGIN_WIDGET_KEY = `${EXT}-oauth-login`;
  let pendingOauthReminderProviders: string[] = [];

  function routeKey(vendor: string, index: number): string {
    return `${vendor}::${index}`;
  }

  function now(): number {
    return Date.now();
  }

  function ensureCfg(ctx: any): NormalizedConfig {
    if (!cfg) {
      cfg = loadConfig(ctx.cwd);
      registerAliasesFromConfig(cfg);
    }
    return cfg;
  }

  function reloadCfg(ctx: any): void {
    cfg = loadConfig(ctx.cwd);
    registerAliasesFromConfig(cfg);
  }

  function getVendor(vendor: string): NormalizedVendor | undefined {
    if (!cfg) return undefined;
    const key = vendor.trim().toLowerCase();
    return cfg.vendors.find((v) => v.vendor === key);
  }

  function getRoute(vendor: string, index: number): NormalizedRoute | undefined {
    const v = getVendor(vendor);
    if (!v) return undefined;
    if (index < 0 || index >= v.routes.length) return undefined;
    return v.routes[index];
  }

  function captureOriginalEnv(): void {
    if (originalEnv) return;
    originalEnv = {
      openai_api_key: process.env.OPENAI_API_KEY,
      openai_org_id: process.env.OPENAI_ORG_ID,
      openai_project_id: process.env.OPENAI_PROJECT_ID,
      anthropic_api_key: process.env.ANTHROPIC_API_KEY,
    };
  }

  function restoreOriginalEnv(): void {
    if (!originalEnv) return;

    if (originalEnv.openai_api_key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalEnv.openai_api_key;

    if (originalEnv.openai_org_id === undefined) delete process.env.OPENAI_ORG_ID;
    else process.env.OPENAI_ORG_ID = originalEnv.openai_org_id;

    if (originalEnv.openai_project_id === undefined) delete process.env.OPENAI_PROJECT_ID;
    else process.env.OPENAI_PROJECT_ID = originalEnv.openai_project_id;

    if (originalEnv.anthropic_api_key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalEnv.anthropic_api_key;

    originalEnv = undefined;
  }

  function resolveApiKey(route: NormalizedRoute): string | undefined {
    if (route.api_key_env) {
      const v = process.env[route.api_key_env];
      if (v && v.trim()) return v.trim();
    }

    if (route.api_key_path) {
      try {
        const path = expandHome(route.api_key_path);
        if (existsSync(path)) {
          const raw = readFileSync(path, "utf-8").trim();
          if (raw) return raw;
        }
      } catch {
        // ignored
      }
    }

    if (route.api_key && route.api_key.trim()) return route.api_key.trim();

    return undefined;
  }

  function applyApiRouteCredentials(vendor: string, route: NormalizedRoute): boolean {
    const key = resolveApiKey(route);
    if (!key) return false;

    captureOriginalEnv();

    if (vendor === "openai") {
      process.env.OPENAI_API_KEY = key;

      if (route.openai_org_id_env) {
        const org = process.env[route.openai_org_id_env];
        if (org && org.trim()) process.env.OPENAI_ORG_ID = org.trim();
        else delete process.env.OPENAI_ORG_ID;
      } else {
        delete process.env.OPENAI_ORG_ID;
      }

      if (route.openai_project_id_env) {
        const project = process.env[route.openai_project_id_env];
        if (project && project.trim()) process.env.OPENAI_PROJECT_ID = project.trim();
        else delete process.env.OPENAI_PROJECT_ID;
      } else {
        delete process.env.OPENAI_PROJECT_ID;
      }

      return true;
    }

    if (vendor === "claude" || vendor === "anthropic") {
      process.env.ANTHROPIC_API_KEY = key;
      return true;
    }

    return false;
  }

  function getRouteCooldownUntil(vendor: string, index: number): number {
    return routeCooldownUntil.get(routeKey(vendor, index)) ?? 0;
  }

  function setRouteCooldownUntil(vendor: string, index: number, untilMs: number): void {
    routeCooldownUntil.set(routeKey(vendor, index), Math.max(untilMs, 0));
  }

  function isRouteCoolingDown(vendor: string, index: number): boolean {
    const until = getRouteCooldownUntil(vendor, index);
    return Boolean(until && now() < until);
  }

  function routeDefaultCooldownMinutes(vendorCfg: NormalizedVendor, route: NormalizedRoute): number {
    if (route.cooldown_minutes !== undefined) return route.cooldown_minutes;
    return route.auth_type === "oauth"
      ? vendorCfg.oauth_cooldown_minutes
      : vendorCfg.api_key_cooldown_minutes;
  }

  function findRouteIndex(vendor: string, authType: AuthType, label: string): number | undefined {
    const v = getVendor(vendor);
    if (!v) return undefined;

    const want = label.trim().toLowerCase();
    const idx = v.routes.findIndex(
      (r) => r.auth_type === authType && r.label.trim().toLowerCase() === want,
    );
    return idx >= 0 ? idx : undefined;
  }

  function routeCanHandleModel(ctx: any, route: NormalizedRoute, modelId: string): boolean {
    return Boolean(ctx.modelRegistry.find(route.provider_id, modelId));
  }

  function routeHasUsableCredentials(vendor: string, route: NormalizedRoute): boolean {
    if (route.auth_type === "oauth") return true;
    return Boolean(resolveApiKey(route));
  }

  function routeEligible(ctx: any, vendor: string, index: number, modelId: string): boolean {
    const route = getRoute(vendor, index);
    if (!route) return false;
    if (isRouteCoolingDown(vendor, index)) return false;
    if (!routeCanHandleModel(ctx, route, modelId)) return false;
    if (!routeHasUsableCredentials(vendor, route)) return false;
    return true;
  }

  function selectBestRouteIndex(ctx: any, vendor: string, modelId: string): number | undefined {
    const v = getVendor(vendor);
    if (!v) return undefined;
    for (let i = 0; i < v.routes.length; i++) {
      if (routeEligible(ctx, vendor, i, modelId)) return i;
    }
    return undefined;
  }

  function selectNextRouteIndexForFailover(
    ctx: any,
    vendor: string,
    modelId: string,
    currentIndex: number,
  ): number | undefined {
    const v = getVendor(vendor);
    if (!v) return undefined;
    if (v.routes.length <= 1) return undefined;

    for (let offset = 1; offset < v.routes.length; offset++) {
      const idx = (currentIndex + offset) % v.routes.length;
      if (idx === currentIndex) continue;
      if (routeEligible(ctx, vendor, idx, modelId)) return idx;
    }

    return undefined;
  }

  function clearRetryTimer(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  }

  function computeNextCooldownExpiry(): number | undefined {
    let next: number | undefined;
    for (const until of routeCooldownUntil.values()) {
      if (!until || until <= now()) continue;
      if (!next || until < next) next = until;
    }
    return next;
  }

  async function maybePromotePreferredRoute(ctx: any, reason: string): Promise<void> {
    if (!cfg?.enabled) return;
    if (!ctx.model?.id || !ctx.model?.provider) return;

    const resolved = resolveVendorRouteForProvider(ctx.model.provider);
    if (!resolved) return;

    const { vendor, index: currentIndex } = resolved;
    const modelId = ctx.model.id;

    const bestIdx = selectBestRouteIndex(ctx, vendor, modelId);
    if (bestIdx === undefined) return;

    if (bestIdx < currentIndex) {
      if (ctx.hasUI) {
        const route = getRoute(vendor, bestIdx);
        if (route) {
          ctx.ui.notify(
            `[${EXT}] Cooldown expired; switching back to preferred route (${routeDisplay(vendor, route)})…`,
            "info",
          );
        }
      }
      await switchToRoute(ctx, vendor, bestIdx, modelId, reason, true);
    }
  }

  function scheduleRetryTimer(ctx: any): void {
    clearRetryTimer();

    const next = computeNextCooldownExpiry();
    if (!next) return;

    const delay = Math.max(1000, next - now());
    retryTimer = setTimeout(async () => {
      retryTimer = undefined;

      if (!lastCtx) {
        scheduleRetryTimer(ctx);
        return;
      }

      if (typeof lastCtx.isIdle === "function" && !lastCtx.isIdle()) {
        scheduleRetryTimer(lastCtx);
        return;
      }

      try {
        await maybePromotePreferredRoute(lastCtx, "cooldown expired");
      } finally {
        scheduleRetryTimer(lastCtx);
      }
    }, delay);
  }

  function registerOpenAICodexAliasProvider(providerId: string): void {
    if (!providerId || registeredAliases.has(providerId)) return;
    if (providerId === "openai-codex") return;

    // Avoid accidentally overriding common non-Codex providers.
    if (["openai", "anthropic", "github-copilot", "google", "google-gemini-cli"].includes(providerId)) {
      return;
    }

    const models = cloneProviderModels("openai-codex");
    const baseUrl = providerBaseUrl("openai-codex");
    if (models.length === 0 || !baseUrl) return;

    const label = providerId;

    pi.registerProvider(providerId, {
      baseUrl,
      models,
      oauth: {
        name: `ChatGPT Plus/Pro (Codex Subscription) (${label})`,
        async login(callbacks: any) {
          return loginOpenAICodex({
            onAuth: callbacks.onAuth,
            onPrompt: callbacks.onPrompt,
            onProgress: callbacks.onProgress,
            onManualCodeInput: callbacks.onManualCodeInput,
            originator: providerId,
          });
        },
        async refreshToken(credentials: any) {
          return refreshOpenAICodexToken(String(credentials.refresh));
        },
        getApiKey(credentials: any) {
          return String(credentials.access);
        },
      },
    });

    registeredAliases.add(providerId);
  }

  function registerAnthropicOAuthAliasProvider(providerId: string): void {
    if (!providerId || registeredAliases.has(providerId)) return;
    if (providerId === "anthropic") return;

    // Avoid accidentally overriding common non-Anthropic providers.
    if (["openai", "openai-codex", "github-copilot", "google", "google-gemini-cli"].includes(providerId)) {
      return;
    }

    const models = cloneProviderModels("anthropic");
    const baseUrl = providerBaseUrl("anthropic");
    if (models.length === 0 || !baseUrl) return;

    const label = providerId;

    pi.registerProvider(providerId, {
      baseUrl,
      models,
      oauth: {
        name: `Anthropic (Claude Pro/Max) (${label})`,
        async login(callbacks: any) {
          return loginAnthropic(
            (url) => callbacks.onAuth({ url }),
            () => callbacks.onPrompt({ message: "Paste the authorization code:" }),
          );
        },
        async refreshToken(credentials: any) {
          return refreshAnthropicToken(String(credentials.refresh));
        },
        getApiKey(credentials: any) {
          return String(credentials.access);
        },
      },
    });

    registeredAliases.add(providerId);
  }

  function registerOpenAIApiAliasProvider(providerId: string): void {
    if (!providerId || registeredAliases.has(providerId)) return;
    if (providerId === "openai") return;

    const models = cloneProviderModels("openai");
    const baseUrl = providerBaseUrl("openai");
    if (models.length === 0 || !baseUrl) return;

    pi.registerProvider(providerId, {
      baseUrl,
      apiKey: "OPENAI_API_KEY",
      api: models[0]?.api,
      models,
    });

    registeredAliases.add(providerId);
  }

  function registerAnthropicApiAliasProvider(providerId: string): void {
    if (!providerId || registeredAliases.has(providerId)) return;
    if (providerId === "anthropic") return;

    const models = cloneProviderModels("anthropic");
    const baseUrl = providerBaseUrl("anthropic");
    if (models.length === 0 || !baseUrl) return;

    pi.registerProvider(providerId, {
      baseUrl,
      apiKey: "ANTHROPIC_API_KEY",
      api: models[0]?.api,
      models,
    });

    registeredAliases.add(providerId);
  }

  function registerAliasesFromConfig(nextCfg: NormalizedConfig): void {
    for (const v of nextCfg.vendors) {
      for (const route of v.routes) {
        if (route.auth_type === "oauth") {
          if (v.vendor === "openai") registerOpenAICodexAliasProvider(route.provider_id);
          if (v.vendor === "claude" || v.vendor === "anthropic")
            registerAnthropicOAuthAliasProvider(route.provider_id);
        } else {
          if (v.vendor === "openai" && route.provider_id !== "openai") {
            registerOpenAIApiAliasProvider(route.provider_id);
          }
          if ((v.vendor === "claude" || v.vendor === "anthropic") && route.provider_id !== "anthropic") {
            registerAnthropicApiAliasProvider(route.provider_id);
          }
        }
      }
    }
  }

  function resolveVendorRouteForProvider(providerId: string): { vendor: string; index: number } | undefined {
    if (!cfg) return undefined;

    // Prefer known active index first.
    for (const [vendor, idx] of activeRouteIndexByVendor.entries()) {
      const route = getRoute(vendor, idx);
      if (route && route.provider_id === providerId) {
        return { vendor, index: idx };
      }
    }

    // Fallback to first route match.
    for (const v of cfg.vendors) {
      for (let i = 0; i < v.routes.length; i++) {
        if (v.routes[i].provider_id === providerId) {
          return { vendor: v.vendor, index: i };
        }
      }
    }

    return undefined;
  }

  function rememberActiveFromCtx(ctx: any): void {
    if (!cfg) return;

    const provider = ctx.model?.provider;
    if (!provider) return;

    const resolved = resolveVendorRouteForProvider(provider);
    if (!resolved) return;

    activeVendor = resolved.vendor;
    activeRouteIndexByVendor.set(resolved.vendor, resolved.index);
  }

  function nearestPreferredCooldownHint(vendor: string, currentIndex: number): string | undefined {
    const v = getVendor(vendor);
    if (!v) return undefined;

    let nearestUntil: number | undefined;
    for (let i = 0; i < currentIndex; i++) {
      const until = getRouteCooldownUntil(vendor, i);
      if (!until || until <= now()) continue;
      if (!nearestUntil || until < nearestUntil) nearestUntil = until;
    }

    if (!nearestUntil) return undefined;

    const mins = Math.max(0, Math.ceil((nearestUntil - now()) / 60000));
    return `preferred route retry ~${mins}m`;
  }

  function updateStatus(ctx: any): void {
    if (!ctx.hasUI) return;

    if (!cfg?.enabled) {
      ctx.ui.setStatus(EXT, undefined);
      return;
    }

    const provider = ctx.model?.provider;
    const modelId = ctx.model?.id;
    if (!provider || !modelId) {
      ctx.ui.setStatus(EXT, undefined);
      return;
    }

    const resolved = resolveVendorRouteForProvider(provider);
    if (!resolved) {
      ctx.ui.setStatus(EXT, ctx.ui.theme.fg("muted", `${EXT}:`) + " " + provider + "/" + modelId);
      return;
    }

    const route = getRoute(resolved.vendor, resolved.index);
    if (!route) {
      ctx.ui.setStatus(EXT, ctx.ui.theme.fg("muted", `${EXT}:`) + " " + provider + "/" + modelId);
      return;
    }

    let msg = ctx.ui.theme.fg("muted", `${EXT}:`);
    msg += " " + ctx.ui.theme.fg("accent", route.auth_type === "oauth" ? "sub" : "api");
    msg += " " + ctx.ui.theme.fg("dim", `${resolved.vendor}/${route.label}`);
    msg += " " + ctx.ui.theme.fg("dim", modelId);

    const hint = nearestPreferredCooldownHint(resolved.vendor, resolved.index);
    if (hint) msg += " " + ctx.ui.theme.fg("dim", `(${hint})`);

    ctx.ui.setStatus(EXT, msg);
  }

  function buildStatusLines(ctx: any): string[] {
    if (!cfg) return ["(no config loaded)"];

    const lines: string[] = [];
    lines.push(`[${EXT}] enabled=${cfg.enabled} default_vendor=${cfg.default_vendor}`);

    const currentProvider = ctx.model?.provider;
    const currentModel = ctx.model?.id;
    if (currentProvider && currentModel) {
      lines.push(`current_model=${currentProvider}/${currentModel}`);
    }

    for (const v of cfg.vendors) {
      lines.push(`vendor ${v.vendor}:`);
      for (let i = 0; i < v.routes.length; i++) {
        const route = v.routes[i];
        const active = activeRouteIndexByVendor.get(v.vendor) === i ? "*" : " ";
        const cooling = isRouteCoolingDown(v.vendor, i)
          ? `cooldown~${Math.max(0, Math.ceil((getRouteCooldownUntil(v.vendor, i) - now()) / 60000))}m`
          : "ready";
        lines.push(
          `  ${active} ${i + 1}. ${route.auth_type} ${decode(route.label)} (provider=${route.provider_id}, ${cooling})`,
        );
      }
    }

    return lines;
  }

  function notifyStatus(ctx: any): void {
    if (!ctx.hasUI) return;
    for (const line of buildStatusLines(ctx)) {
      ctx.ui.notify(line, "info");
    }
  }

  function configuredOauthProviders(): string[] {
    if (!cfg) return [];
    const providers: string[] = [];
    for (const v of cfg.vendors) {
      for (const route of v.routes) {
        if (route.auth_type === "oauth") providers.push(route.provider_id);
      }
    }
    return Array.from(new Set(providers));
  }

  function findAnyModelForProvider(ctx: any, providerId: string): any | undefined {
    const currentModelId = ctx.model?.id;
    if (currentModelId) {
      const m = ctx.modelRegistry.find(providerId, currentModelId);
      if (m) return m;
    }

    const available = (ctx.modelRegistry.getAvailable?.() ?? []) as any[];
    return available.find((m) => m?.provider === providerId);
  }

  async function isOauthProviderAuthenticated(ctx: any, providerId: string): Promise<boolean> {
    if (!ctx?.modelRegistry?.getApiKey) return false;

    const model = findAnyModelForProvider(ctx, providerId);
    if (!model) return false;

    try {
      const apiKey = await ctx.modelRegistry.getApiKey(model);
      return Boolean(apiKey && String(apiKey).trim());
    } catch {
      return false;
    }
  }

  async function missingOauthProviders(
    ctx: any,
    providers: string[],
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const provider of providers) {
      const ok = await isOauthProviderAuthenticated(ctx, provider);
      if (!ok) missing.push(provider);
    }
    return missing;
  }

  async function refreshOauthReminderWidget(
    ctx: any,
    providers?: string[],
  ): Promise<string[]> {
    const candidates = providers ? Array.from(new Set(providers)) : configuredOauthProviders();
    const missing = await missingOauthProviders(ctx, candidates);
    pendingOauthReminderProviders = missing;

    if (ctx.hasUI) {
      if (missing.length === 0) {
        ctx.ui.setWidget(LOGIN_WIDGET_KEY, undefined);
      } else {
        const lines = [
          "⚠ subswitch setup incomplete: OAuth login required",
          "Run /login and authenticate providers:",
          ...missing.map((p) => `  - ${p}`),
          "Use /subswitch login-status to re-check.",
        ];
        ctx.ui.setWidget(LOGIN_WIDGET_KEY, lines, { placement: "belowEditor" });
      }
    }

    return missing;
  }

  async function promptOauthLogin(
    ctx: any,
    providers?: string[],
  ): Promise<void> {
    const missing = await refreshOauthReminderWidget(ctx, providers);
    if (missing.length === 0) {
      if (ctx.hasUI) {
        ctx.ui.notify(`[${EXT}] OAuth providers already authenticated`, "info");
      }
      return;
    }

    if (!ctx.hasUI) return;

    const choice = await ctx.ui.select("OAuth login required", [
      "Start /login now",
      "Remind me later",
    ]);

    if (choice === "Start /login now") {
      ctx.ui.setEditorText("/login");
      ctx.ui.notify(
        `[${EXT}] Prefilled /login. After each login, run /subswitch login-status.`,
        "warning",
      );
    } else {
      ctx.ui.notify(
        `[${EXT}] Reminder saved. Run /subswitch login to resume OAuth login flow.`,
        "info",
      );
    }
  }

  async function switchToRoute(
    ctx: any,
    vendor: string,
    routeIndex: number,
    modelId: string,
    reason: string,
    notify = true,
  ): Promise<boolean> {
    if (!cfg?.enabled) return false;

    const vendorCfg = getVendor(vendor);
    const route = getRoute(vendor, routeIndex);
    if (!vendorCfg || !route) return false;

    if (!routeCanHandleModel(ctx, route, modelId)) {
      if (notify && ctx.hasUI) {
        ctx.ui.notify(
          `[${EXT}] Route cannot serve model ${modelId}: ${routeDisplay(vendor, route)}`,
          "warning",
        );
      }
      return false;
    }

    if (route.auth_type === "api_key") {
      const ok = applyApiRouteCredentials(vendor, route);
      if (!ok) {
        if (notify && ctx.hasUI) {
          ctx.ui.notify(
            `[${EXT}] Missing API key material for ${routeDisplay(vendor, route)} (check api_key_env/api_key_path/api_key)`,
            "warning",
          );
        }
        return false;
      }
    }

    const model = ctx.modelRegistry.find(route.provider_id, modelId);
    if (!model) {
      if (notify && ctx.hasUI) {
        ctx.ui.notify(
          `[${EXT}] No model ${route.provider_id}/${modelId} (${reason})`,
          "warning",
        );
      }
      return false;
    }

    pendingExtensionSwitch = { provider: route.provider_id, modelId };

    let ok = false;
    try {
      ok = await pi.setModel(model);
    } finally {
      if (!ok) pendingExtensionSwitch = undefined;
    }

    if (!ok) {
      if (notify && ctx.hasUI) {
        ctx.ui.notify(
          `[${EXT}] Missing credentials for ${route.provider_id}/${modelId} (${reason})`,
          "warning",
        );
      }
      return false;
    }

    activeVendor = vendor;
    activeRouteIndexByVendor.set(vendor, routeIndex);
    managedModelId = modelId;

    if (notify && ctx.hasUI) {
      ctx.ui.notify(
        `[${EXT}] Switched to ${routeDisplay(vendor, route)} (${route.provider_id}/${modelId})`,
        "info",
      );
    }

    updateStatus(ctx);
    scheduleRetryTimer(ctx);
    return true;
  }

  async function useRouteBySelector(
    ctx: any,
    vendor: string,
    authType: AuthType,
    label: string,
    modelId?: string,
    reason = "manual",
  ): Promise<boolean> {
    ensureCfg(ctx);

    const v = getVendor(vendor);
    if (!v) {
      if (ctx.hasUI) ctx.ui.notify(`[${EXT}] Unknown vendor '${vendor}'`, "warning");
      return false;
    }

    const idx = findRouteIndex(vendor, authType, label);
    if (idx === undefined) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `[${EXT}] No route '${label}' with auth_type='${authType}' for vendor '${vendor}'`,
          "warning",
        );
      }
      return false;
    }

    const targetModelId = modelId ?? ctx.model?.id;
    if (!targetModelId) {
      if (ctx.hasUI) {
        ctx.ui.notify(`[${EXT}] No current model selected; specify model id explicitly`, "warning");
      }
      return false;
    }

    return switchToRoute(ctx, vendor, idx, targetModelId, reason, true);
  }

  async function useFirstRouteForAuthType(
    ctx: any,
    vendor: string,
    authType: AuthType,
    label: string | undefined,
    modelId?: string,
    reason = "manual",
  ): Promise<boolean> {
    ensureCfg(ctx);

    const v = getVendor(vendor);
    if (!v) {
      if (ctx.hasUI) ctx.ui.notify(`[${EXT}] Unknown vendor '${vendor}'`, "warning");
      return false;
    }

    const targetModelId = modelId ?? ctx.model?.id;
    if (!targetModelId) {
      if (ctx.hasUI) {
        ctx.ui.notify(`[${EXT}] No current model selected; specify model id explicitly`, "warning");
      }
      return false;
    }

    let idx: number | undefined;

    if (label) {
      idx = findRouteIndex(vendor, authType, label);
      if (idx === undefined) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[${EXT}] No ${authType} route '${label}' for vendor '${vendor}'`,
            "warning",
          );
        }
        return false;
      }
    } else {
      for (let i = 0; i < v.routes.length; i++) {
        const route = v.routes[i];
        if (route.auth_type !== authType) continue;
        if (!routeEligible(ctx, vendor, i, targetModelId)) continue;
        idx = i;
        break;
      }

      if (idx === undefined) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[${EXT}] No eligible ${authType} route for vendor '${vendor}' and model '${targetModelId}'`,
            "warning",
          );
        }
        return false;
      }
    }

    return switchToRoute(ctx, vendor, idx, targetModelId, reason, true);
  }

  function routeOrderMoveToFront(vendor: string, authType: AuthType, label: string): boolean {
    const v = getVendor(vendor);
    if (!v) return false;

    const idx = findRouteIndex(vendor, authType, label);
    if (idx === undefined) return false;

    const [picked] = v.routes.splice(idx, 1);
    v.routes.unshift(picked);

    // Reconcile active index if we touched this vendor.
    const current = activeRouteIndexByVendor.get(vendor);
    if (current !== undefined) {
      if (current === idx) {
        activeRouteIndexByVendor.set(vendor, 0);
      } else if (current < idx) {
        activeRouteIndexByVendor.set(vendor, current + 1);
      }
    }

    return true;
  }

  function renameRoute(vendor: string, authType: AuthType, oldLabel: string, newLabel: string): boolean {
    const idx = findRouteIndex(vendor, authType, oldLabel);
    if (idx === undefined) return false;
    const route = getRoute(vendor, idx);
    if (!route) return false;
    route.label = newLabel.trim();
    return true;
  }

  function saveCurrentConfig(ctx: any): string {
    const path = preferredWritableConfigPath(ctx.cwd);
    if (!cfg) return path;
    writeJson(path, configToJson(cfg));
    return path;
  }

  function vendorForCommand(ctx: any, candidate: string | undefined): string {
    if (candidate && candidate.trim()) return candidate.trim().toLowerCase();

    const provider = ctx.model?.provider;
    if (provider) {
      const resolved = resolveVendorRouteForProvider(provider);
      if (resolved) return resolved.vendor;
    }

    return cfg?.default_vendor ?? "openai";
  }

  async function showModelCompatibility(ctx: any, vendor: string): Promise<void> {
    ensureCfg(ctx);

    const v = getVendor(vendor);
    if (!v) {
      if (ctx.hasUI) ctx.ui.notify(`[${EXT}] Unknown vendor '${vendor}'`, "warning");
      return;
    }

    const available = ctx.modelRegistry.getAvailable() as any[];
    const byProvider = new Map<string, Set<string>>();

    for (const m of available) {
      const p = String(m.provider ?? "");
      const id = String(m.id ?? "");
      if (!p || !id) continue;
      if (!byProvider.has(p)) byProvider.set(p, new Set<string>());
      byProvider.get(p)?.add(id);
    }

    let intersection: Set<string> | undefined;
    for (const route of v.routes) {
      const ids = byProvider.get(route.provider_id) ?? new Set<string>();
      if (!intersection) {
        intersection = new Set(ids);
      } else {
        for (const id of Array.from(intersection)) {
          if (!ids.has(id)) intersection.delete(id);
        }
      }
    }

    const models = Array.from(intersection ?? []).sort();

    if (ctx.hasUI) {
      ctx.ui.notify(
        `[${EXT}] Compatible models for vendor '${vendor}' across ${v.routes.length} routes: ${
          models.length > 0 ? models.join(", ") : "(none)"
        }`,
        models.length > 0 ? "info" : "warning",
      );
    }
  }

  async function reorderVendorInteractive(ctx: any, vendorArg?: string): Promise<void> {
    ensureCfg(ctx);
    if (!ctx.hasUI) {
      return;
    }

    const vendor = vendorForCommand(ctx, vendorArg);
    const v = getVendor(vendor);
    if (!v) {
      ctx.ui.notify(`[${EXT}] Unknown vendor '${vendor}'`, "warning");
      return;
    }

    if (v.routes.length < 2) {
      ctx.ui.notify(`[${EXT}] Vendor '${vendor}' has fewer than 2 routes`, "warning");
      return;
    }

    const fromChoices = v.routes.map((r, i) => `${i + 1}. ${routeDisplay(vendor, r)}`);
    const from = await ctx.ui.select(`Move which route? (${vendor})`, fromChoices);
    if (!from) return;

    const fromIndex = fromChoices.indexOf(from);
    if (fromIndex < 0) return;

    const toChoices = v.routes.map((r, i) => `Position ${i + 1}: ${routeDisplay(vendor, r)}`);
    const to = await ctx.ui.select(`Move to which position? (${vendor})`, toChoices);
    if (!to) return;

    const toIndex = toChoices.indexOf(to);
    if (toIndex < 0 || toIndex === fromIndex) return;

    const [picked] = v.routes.splice(fromIndex, 1);
    v.routes.splice(toIndex, 0, picked);

    const savePath = saveCurrentConfig(ctx);
    ctx.ui.notify(
      `[${EXT}] Reordered routes for '${vendor}'. Saved to ${savePath}`,
      "info",
    );

    reloadCfg(ctx);
    updateStatus(ctx);
  }

  async function editConfigInteractive(ctx: any): Promise<void> {
    ensureCfg(ctx);

    if (!ctx.hasUI) {
      return;
    }

    const path = preferredWritableConfigPath(ctx.cwd);

    const currentJson = existsSync(path)
      ? readFileSync(path, "utf-8")
      : JSON.stringify(configToJson(cfg!), null, 2) + "\n";

    const edited = await ctx.ui.editor(`Edit ${path}`, currentJson);
    if (edited === undefined) return;

    let parsed: Config;
    try {
      parsed = JSON.parse(edited) as Config;
    } catch (e) {
      ctx.ui.notify(`[${EXT}] Invalid JSON: ${String(e)}`, "error");
      return;
    }

    const normalized = normalizeConfig(parsed);
    if (normalized.vendors.length === 0) {
      ctx.ui.notify(`[${EXT}] Config must define at least one vendor with routes`, "error");
      return;
    }

    writeJson(path, configToJson(normalized));
    cfg = normalized;
    registerAliasesFromConfig(cfg);

    ctx.ui.notify(`[${EXT}] Saved config to ${path}`, "info");
    updateStatus(ctx);
  }

  function generateOauthProviderId(vendor: string, label: string): string {
    const slug = slugify(label);
    if (vendor === "openai") {
      if (slug === "personal") return "openai-codex";
      return `openai-codex-${slug || "account"}`;
    }
    if (vendor === "claude" || vendor === "anthropic") {
      if (slug === "personal") return "anthropic";
      return `anthropic-${slug || "account"}`;
    }
    return `${vendor}-${slug || "oauth"}`;
  }

  function defaultApiEnvVar(vendor: string, label: string): string {
    const suffix = slugify(label).toUpperCase().replace(/-/g, "_") || "DEFAULT";
    if (vendor === "openai") return `OPENAI_API_KEY_${suffix}`;
    if (vendor === "claude" || vendor === "anthropic") return `ANTHROPIC_API_KEY_${suffix}`;
    return `${vendor.toUpperCase()}_API_KEY_${suffix}`;
  }

  async function setupWizard(ctx: any): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.notify(`[${EXT}] Starting setup wizard…`, "info");

    type WizardNav = "ok" | "back" | "cancel";

    async function inputWithBack(title: string, placeholder: string): Promise<{ nav: WizardNav; value?: string }> {
      const raw = await ctx.ui.input(`${title}\nType /back to go to previous screen`, placeholder);
      if (raw === undefined) return { nav: "cancel" };
      if (raw.trim().toLowerCase() === "/back") return { nav: "back" };
      return { nav: "ok", value: raw };
    }

    async function collectVendor(
      vendor: "openai" | "claude",
      existing?: VendorConfig,
    ): Promise<{ nav: WizardNav; config?: VendorConfig }> {
      const vendorTitle = titleCase(vendor);
      const existingRoutes = Array.isArray(existing?.routes) ? existing.routes : [];

      const defaultOauthLabels =
        existingRoutes
          .filter((r) => r.auth_type === "oauth")
          .map((r) => String(r.label ?? "").trim())
          .filter(Boolean)
          .join(", ") || (vendor === "openai" ? "work, personal" : "personal");

      const defaultApiLabels =
        existingRoutes
          .filter((r) => r.auth_type === "api_key")
          .map((r) => String(r.label ?? "").trim())
          .filter(Boolean)
          .join(", ") || "work";

      const existingApiEnvByLabel = new Map<string, string>();
      for (const route of existingRoutes) {
        if (route.auth_type !== "api_key") continue;
        const label = String(route.label ?? "").trim();
        if (!label) continue;
        if (route.api_key_env && String(route.api_key_env).trim()) {
          existingApiEnvByLabel.set(label, String(route.api_key_env).trim());
        }
      }

      let oauthRaw = defaultOauthLabels;
      let apiRaw = defaultApiLabels;

      while (true) {
        const oauthRes = await inputWithBack(
          `${vendorTitle} OAuth account labels (comma-separated, e.g. work, personal)`,
          oauthRaw,
        );
        if (oauthRes.nav === "cancel") return { nav: "cancel" };
        if (oauthRes.nav === "back") return { nav: "back" };
        oauthRaw = oauthRes.value ?? "";

        while (true) {
          const apiRes = await inputWithBack(
            `${vendorTitle} API key account labels (comma-separated, e.g. work, personal)`,
            apiRaw,
          );
          if (apiRes.nav === "cancel") return { nav: "cancel" };
          if (apiRes.nav === "back") break;
          apiRaw = apiRes.value ?? "";

          const oauthLabels = oauthRaw
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
          const apiLabels = apiRaw
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);

          const apiEnvByLabel = new Map<string, string>();
          for (const label of apiLabels) {
            const existingEnv = existingApiEnvByLabel.get(label);
            apiEnvByLabel.set(label, existingEnv ?? defaultApiEnvVar(vendor, label));
          }

          let goBackToApiLabels = false;
          let idx = 0;
          while (idx < apiLabels.length) {
            const label = apiLabels[idx];
            const envDefault = apiEnvByLabel.get(label) ?? defaultApiEnvVar(vendor, label);
            const envRes = await inputWithBack(
              `${vendorTitle} env var for API key '${label}'`,
              envDefault,
            );
            if (envRes.nav === "cancel") return { nav: "cancel" };
            if (envRes.nav === "back") {
              if (idx === 0) {
                goBackToApiLabels = true;
                break;
              }
              idx -= 1;
              continue;
            }

            apiEnvByLabel.set(label, (envRes.value ?? "").trim() || envDefault);
            idx += 1;
          }

          if (goBackToApiLabels) {
            continue;
          }

          const routes: RouteConfig[] = [];

          for (const label of oauthLabels) {
            routes.push({
              auth_type: "oauth",
              label,
              provider_id: generateOauthProviderId(vendor, label),
            });
          }

          for (const label of apiLabels) {
            routes.push({
              auth_type: "api_key",
              label,
              provider_id: defaultProviderId(vendor, "api_key"),
              api_key_env: apiEnvByLabel.get(label) ?? defaultApiEnvVar(vendor, label),
            });
          }

          if (routes.length === 0) {
            const emptyChoice = await ctx.ui.select(
              `No routes configured for ${vendorTitle}.`,
              ["Retry", "Skip vendor", "← Back", "Cancel"],
            );
            if (!emptyChoice || emptyChoice === "Cancel") return { nav: "cancel" };
            if (emptyChoice === "← Back") return { nav: "back" };
            if (emptyChoice === "Skip vendor") return { nav: "ok", config: undefined };
            continue;
          }

          return {
            nav: "ok",
            config: {
              vendor,
              routes,
              oauth_cooldown_minutes: Number(existing?.oauth_cooldown_minutes ?? 180),
              api_key_cooldown_minutes: Number(existing?.api_key_cooldown_minutes ?? 15),
              auto_retry: existing?.auto_retry ?? true,
            },
          };
        }
      }
    }

    async function orderVendorRoutes(vendor: "openai" | "claude"): Promise<WizardNav> {
      const vendorCfg = vendorConfigs.get(vendor);
      if (!vendorCfg || !Array.isArray(vendorCfg.routes)) return "ok";
      const routes = vendorCfg.routes;
      if (routes.length <= 1) return "ok";

      const vendorTitle = titleCase(vendor);

      while (true) {
        const summary = routes
          .map((r, i) => `${i + 1}. ${String(r.auth_type)} · ${decode(String(r.label ?? ""))}`)
          .join("\n");

        const orderChoice = await ctx.ui.select(
          `${vendorTitle} route order (first = preferred failover):\n${summary}`,
          ["Keep order", "Move route", "← Back", "Cancel"],
        );

        if (!orderChoice || orderChoice === "Cancel") return "cancel";
        if (orderChoice === "← Back") return "back";
        if (orderChoice === "Keep order") return "ok";

        const routeOptions = routes.map(
          (r, i) => `${i + 1}. ${String(r.auth_type)} · ${decode(String(r.label ?? ""))}`,
        );

        const fromChoice = await ctx.ui.select(`Move which route? (${vendorTitle})`, [
          ...routeOptions,
          "← Back",
          "Cancel",
        ]);
        if (!fromChoice || fromChoice === "Cancel") return "cancel";
        if (fromChoice === "← Back") continue;

        const fromIndex = routeOptions.indexOf(fromChoice);
        if (fromIndex < 0) continue;

        const toChoice = await ctx.ui.select(`Move to which position? (${vendorTitle})`, [
          ...routeOptions,
          "← Back",
          "Cancel",
        ]);
        if (!toChoice || toChoice === "Cancel") return "cancel";
        if (toChoice === "← Back") continue;

        const toIndex = routeOptions.indexOf(toChoice);
        if (toIndex < 0 || toIndex === fromIndex) continue;

        const [picked] = routes.splice(fromIndex, 1);
        routes.splice(toIndex, 0, picked);
      }
    }

    let targetPath = globalConfigPath();
    let useOpenAI = true;
    let useClaude = false;

    const existingCfg = cfg ?? loadConfig(ctx.cwd);
    if (existingCfg.vendors.some((v) => v.vendor === "openai")) useOpenAI = true;
    if (existingCfg.vendors.some((v) => v.vendor === "claude" || v.vendor === "anthropic")) {
      useClaude = true;
    }

    const vendorConfigs = new Map<string, VendorConfig>();

    const existingOpenAI = existingCfg.vendors.find((v) => v.vendor === "openai");
    if (existingOpenAI) {
      vendorConfigs.set("openai", {
        vendor: "openai",
        routes: existingOpenAI.routes.map((r) => ({
          auth_type: r.auth_type,
          label: r.label,
          provider_id: r.provider_id,
          api_key_env: r.api_key_env,
          api_key_path: r.api_key_path,
          api_key: r.api_key,
          openai_org_id_env: r.openai_org_id_env,
          openai_project_id_env: r.openai_project_id_env,
          cooldown_minutes: r.cooldown_minutes,
        })),
        oauth_cooldown_minutes: existingOpenAI.oauth_cooldown_minutes,
        api_key_cooldown_minutes: existingOpenAI.api_key_cooldown_minutes,
        auto_retry: existingOpenAI.auto_retry,
      });
    }

    const existingClaude = existingCfg.vendors.find((v) => v.vendor === "claude" || v.vendor === "anthropic");
    if (existingClaude) {
      vendorConfigs.set("claude", {
        vendor: "claude",
        routes: existingClaude.routes.map((r) => ({
          auth_type: r.auth_type,
          label: r.label,
          provider_id: r.provider_id,
          api_key_env: r.api_key_env,
          api_key_path: r.api_key_path,
          api_key: r.api_key,
          cooldown_minutes: r.cooldown_minutes,
        })),
        oauth_cooldown_minutes: existingClaude.oauth_cooldown_minutes,
        api_key_cooldown_minutes: existingClaude.api_key_cooldown_minutes,
        auto_retry: existingClaude.auto_retry,
      });
    }

    let stage: "dest" | "vendors" | "routes" | "order" | "default" = "dest";

    while (true) {
      if (stage === "dest") {
        const destChoice = await ctx.ui.select("Where should subswitch config live?", [
          `Global (${globalConfigPath()})`,
          `Project (${projectConfigPath(ctx.cwd)})`,
          "Cancel",
        ]);

        if (!destChoice || destChoice === "Cancel") {
          ctx.ui.notify(`[${EXT}] Setup cancelled`, "warning");
          return;
        }

        targetPath = destChoice.startsWith("Project")
          ? projectConfigPath(ctx.cwd)
          : globalConfigPath();

        stage = "vendors";
        continue;
      }

      if (stage === "vendors") {
        const choice = await ctx.ui.select("Select vendors to configure", [
          `OpenAI: ${useOpenAI ? "Yes" : "No"}`,
          `Claude: ${useClaude ? "Yes" : "No"}`,
          "Continue",
          "← Back",
          "Cancel",
        ]);

        if (!choice || choice === "Cancel") {
          ctx.ui.notify(`[${EXT}] Setup cancelled`, "warning");
          return;
        }

        if (choice.startsWith("OpenAI:")) {
          useOpenAI = !useOpenAI;
          if (!useOpenAI) vendorConfigs.delete("openai");
          continue;
        }

        if (choice.startsWith("Claude:")) {
          useClaude = !useClaude;
          if (!useClaude) vendorConfigs.delete("claude");
          continue;
        }

        if (choice === "← Back") {
          stage = "dest";
          continue;
        }

        if (!useOpenAI && !useClaude) {
          ctx.ui.notify(`[${EXT}] Select at least one vendor`, "warning");
          continue;
        }

        stage = "routes";
        continue;
      }

      if (stage === "routes") {
        if (useOpenAI) {
          const openaiResult = await collectVendor("openai", vendorConfigs.get("openai"));
          if (openaiResult.nav === "cancel") {
            ctx.ui.notify(`[${EXT}] Setup cancelled`, "warning");
            return;
          }
          if (openaiResult.nav === "back") {
            stage = "vendors";
            continue;
          }
          if (openaiResult.config) vendorConfigs.set("openai", openaiResult.config);
          else vendorConfigs.delete("openai");
        }

        if (useClaude) {
          const claudeResult = await collectVendor("claude", vendorConfigs.get("claude"));
          if (claudeResult.nav === "cancel") {
            ctx.ui.notify(`[${EXT}] Setup cancelled`, "warning");
            return;
          }
          if (claudeResult.nav === "back") {
            stage = "vendors";
            continue;
          }
          if (claudeResult.config) vendorConfigs.set("claude", claudeResult.config);
          else vendorConfigs.delete("claude");
        }

        if (vendorConfigs.size === 0) {
          ctx.ui.notify(`[${EXT}] No routes configured; returning to vendor selection`, "warning");
          stage = "vendors";
          continue;
        }

        stage = "order";
        continue;
      }

      if (stage === "order") {
        if (useOpenAI && vendorConfigs.has("openai")) {
          const nav = await orderVendorRoutes("openai");
          if (nav === "cancel") {
            ctx.ui.notify(`[${EXT}] Setup cancelled`, "warning");
            return;
          }
          if (nav === "back") {
            stage = "routes";
            continue;
          }
        }

        if (useClaude && vendorConfigs.has("claude")) {
          const nav = await orderVendorRoutes("claude");
          if (nav === "cancel") {
            ctx.ui.notify(`[${EXT}] Setup cancelled`, "warning");
            return;
          }
          if (nav === "back") {
            stage = "routes";
            continue;
          }
        }

        stage = "default";
        continue;
      }

      const vendorNames = Array.from(vendorConfigs.keys());
      const defaultChoice = await ctx.ui.select("Default vendor", [
        ...vendorNames,
        "← Back",
        "Cancel",
      ]);

      if (!defaultChoice || defaultChoice === "Cancel") {
        ctx.ui.notify(`[${EXT}] Setup cancelled`, "warning");
        return;
      }

      if (defaultChoice === "← Back") {
        stage = "order";
        continue;
      }

      const out = normalizeConfig({
        enabled: true,
        default_vendor: defaultChoice,
        vendors: vendorNames
          .map((name) => vendorConfigs.get(name))
          .filter((v): v is VendorConfig => Boolean(v)),
        rate_limit_patterns: cfg?.rate_limit_patterns ?? [],
      });

      writeJson(targetPath, configToJson(out));

      cfg = out;
      registerAliasesFromConfig(cfg);

      ctx.ui.notify(`[${EXT}] Wrote config to ${targetPath}`, "info");

      const oauthProviders = configuredOauthProviders();
      if (oauthProviders.length > 0) {
        await promptOauthLogin(ctx, oauthProviders);
      }

      updateStatus(ctx);
      return;
    }
  }

  async function runQuickPicker(ctx: any): Promise<void> {
    if (!ctx.hasUI) {
      notifyStatus(ctx);
      return;
    }

    ensureCfg(ctx);

    const options: string[] = [
      "Status",
      "Setup wizard",
      "OAuth login checklist",
      "Edit config",
      "Reorder routes",
      "Reload config",
    ];

    for (const v of cfg!.vendors) {
      for (const route of v.routes) {
        options.push(`Use: ${routeDisplay(v.vendor, route)}`);
      }
    }

    const selected = await ctx.ui.select("subswitch", options);
    if (!selected) return;

    if (selected === "Status") {
      notifyStatus(ctx);
      return;
    }

    if (selected === "Setup wizard") {
      await setupWizard(ctx);
      return;
    }

    if (selected === "OAuth login checklist") {
      await promptOauthLogin(ctx, configuredOauthProviders());
      return;
    }

    if (selected === "Edit config") {
      await editConfigInteractive(ctx);
      return;
    }

    if (selected === "Reorder routes") {
      await reorderVendorInteractive(ctx);
      return;
    }

    if (selected === "Reload config") {
      reloadCfg(ctx);
      notifyStatus(ctx);
      updateStatus(ctx);
      return;
    }

    if (selected.startsWith("Use: ")) {
      const payload = selected.slice("Use: ".length);
      const parts = payload.split(" · ");
      if (parts.length !== 3) return;

      const vendor = parts[0].trim();
      const authType = parts[1].trim() as AuthType;
      const label = parts[2].trim();
      await useRouteBySelector(ctx, vendor, authType, label, ctx.model?.id, "quick picker");
    }
  }

  function toolStatusSummary(ctx: any): string {
    return buildStatusLines(ctx).join("\n");
  }

  async function toolPreferRoute(
    ctx: any,
    vendor: string,
    authType: AuthType,
    label: string,
    modelId?: string,
  ): Promise<string> {
    ensureCfg(ctx);

    const ok = routeOrderMoveToFront(vendor, authType, label);
    if (!ok) {
      return `No route found for vendor='${vendor}', auth_type='${authType}', label='${label}'`;
    }

    const savePath = saveCurrentConfig(ctx);

    const targetModel = modelId ?? ctx.model?.id;
    if (targetModel) {
      await useFirstRouteForAuthType(ctx, vendor, authType, label, targetModel, "tool prefer");
    }

    return `Set ${vendor}/${authType}/${label} as first failover route and saved config to ${savePath}.`;
  }

  // Register aliases as early as possible (extension load-time).
  registerAliasesFromConfig(loadConfig(process.cwd()));

  pi.registerTool({
    name: "subswitch_manage",
    label: "Subswitch Manage",
    description:
      "Manage subscription/api failover routes for vendors (openai/claude). Supports status, use, prefer, rename, reload.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("use"),
        Type.Literal("prefer"),
        Type.Literal("rename"),
        Type.Literal("reload"),
      ]),
      vendor: Type.Optional(Type.String({ description: "Vendor, e.g. openai or claude" })),
      auth_type: Type.Optional(
        Type.Union([Type.Literal("oauth"), Type.Literal("api_key")], {
          description: "Auth type",
        }),
      ),
      label: Type.Optional(Type.String({ description: "Route label, e.g. work/personal" })),
      model_id: Type.Optional(Type.String({ description: "Optional model id to switch to while applying route" })),
      old_label: Type.Optional(Type.String({ description: "Old label for rename action" })),
      new_label: Type.Optional(Type.String({ description: "New label for rename action" })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      ensureCfg(ctx);
      lastCtx = ctx;

      const action = String(params.action ?? "").trim();

      if (action === "status") {
        const text = toolStatusSummary(ctx);
        return {
          content: [{ type: "text", text }],
          details: { action, ok: true },
        };
      }

      if (action === "reload") {
        reloadCfg(ctx);
        updateStatus(ctx);
        const text = `Reloaded config.\n${toolStatusSummary(ctx)}`;
        return {
          content: [{ type: "text", text }],
          details: { action, ok: true },
        };
      }

      if (action === "use") {
        const vendor = String(params.vendor ?? "").trim().toLowerCase();
        const authType = String(params.auth_type ?? "").trim() as AuthType;
        const label = String(params.label ?? "").trim();
        const modelId = params.model_id ? String(params.model_id).trim() : undefined;

        if (!vendor || (authType !== "oauth" && authType !== "api_key") || !label) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Missing required args for action=use: vendor, auth_type (oauth|api_key), label",
              },
            ],
            details: { action, ok: false },
          };
        }

        const ok = await useRouteBySelector(ctx, vendor, authType, label, modelId, "tool use");
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Switched to ${vendor}/${authType}/${label}${modelId ? ` with model ${modelId}` : ""}.`
                : `Failed to switch to ${vendor}/${authType}/${label}.`,
            },
          ],
          details: { action, ok },
        };
      }

      if (action === "prefer") {
        const vendor = String(params.vendor ?? "").trim().toLowerCase();
        const authType = String(params.auth_type ?? "").trim() as AuthType;
        const label = String(params.label ?? "").trim();
        const modelId = params.model_id ? String(params.model_id).trim() : undefined;

        if (!vendor || (authType !== "oauth" && authType !== "api_key") || !label) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Missing required args for action=prefer: vendor, auth_type (oauth|api_key), label",
              },
            ],
            details: { action, ok: false },
          };
        }

        const text = await toolPreferRoute(ctx, vendor, authType, label, modelId);
        return {
          content: [{ type: "text", text }],
          details: { action, ok: !text.startsWith("No route found") },
        };
      }

      if (action === "rename") {
        const vendor = String(params.vendor ?? "").trim().toLowerCase();
        const authType = String(params.auth_type ?? "").trim() as AuthType;
        const oldLabel = String(params.old_label ?? "").trim();
        const newLabel = String(params.new_label ?? "").trim();

        if (
          !vendor ||
          (authType !== "oauth" && authType !== "api_key") ||
          !oldLabel ||
          !newLabel
        ) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Missing required args for action=rename: vendor, auth_type (oauth|api_key), old_label, new_label",
              },
            ],
            details: { action, ok: false },
          };
        }

        const ok = renameRoute(vendor, authType, oldLabel, newLabel);
        if (!ok) {
          return {
            content: [
              {
                type: "text",
                text: `Route not found for rename (${vendor}/${authType}/${oldLabel})`,
              },
            ],
            details: { action, ok: false },
          };
        }

        const savePath = saveCurrentConfig(ctx);
        return {
          content: [
            {
              type: "text",
              text: `Renamed route '${oldLabel}' -> '${newLabel}' and saved config to ${savePath}.`,
            },
          ],
          details: { action, ok: true },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Unknown action '${action}'. Supported: status, use, prefer, rename, reload.`,
          },
        ],
        details: { action, ok: false },
      };
    },
  });

  pi.registerCommand("subswitch", {
    description:
      "Vendor/account failover manager (openai/claude). Use /subswitch for quick picker + status.",
    handler: async (args, ctx) => {
      ensureCfg(ctx);
      lastCtx = ctx;
      rememberActiveFromCtx(ctx);
      managedModelId = ctx.model?.id;

      const parts = splitArgs(args || "");
      const cmd = parts[0] ?? "";

      if (cmd === "" || cmd === "status") {
        if (cmd === "") {
          await runQuickPicker(ctx);
        } else {
          notifyStatus(ctx);
        }
        await refreshOauthReminderWidget(ctx, configuredOauthProviders());
        updateStatus(ctx);
        return;
      }

      if (cmd === "help") {
        if (ctx.hasUI) {
          const help =
            "Usage: /subswitch [command]\n\n" +
            "Commands:\n" +
            "  (no args)                     Quick picker + status\n" +
            "  status                        Show status\n" +
            "  setup                         Guided setup wizard\n" +
            "  login                         Prompt OAuth login checklist and prefill /login\n" +
            "  login-status                  Re-check OAuth login completion and update reminder\n" +
            "  reload                        Reload config\n" +
            "  on / off                      Enable/disable extension (runtime)\n" +
            "  use <vendor> <auth_type> <label> [modelId]\n" +
            "  subscription <vendor> [label] [modelId]\n" +
            "  api <vendor> [label] [modelId]\n" +
            "  rename <vendor> <auth_type> <old_label> <new_label>\n" +
            "  reorder [vendor]              Interactive reorder for vendor routes\n" +
            "  edit                          Edit JSON config with validation\n" +
            "  models <vendor>               Show compatible models across routes\n" +
            "\nCompatibility aliases:\n" +
            "  primary [label] [modelId]     == subscription <default_vendor> ...\n" +
            "  fallback [label] [modelId]    == api <default_vendor> ...";
          ctx.ui.notify(help, "info");
        }
        updateStatus(ctx);
        return;
      }

      if (cmd === "setup") {
        await setupWizard(ctx);
        updateStatus(ctx);
        return;
      }

      if (cmd === "login") {
        await promptOauthLogin(ctx, configuredOauthProviders());
        updateStatus(ctx);
        return;
      }

      if (cmd === "login-status") {
        const providers = configuredOauthProviders();
        const missing = await refreshOauthReminderWidget(ctx, providers);
        if (ctx.hasUI) {
          if (missing.length === 0) {
            ctx.ui.notify(`[${EXT}] OAuth login checklist complete`, "info");
          } else {
            ctx.ui.notify(
              `[${EXT}] Missing OAuth login for: ${missing.join(", ")}`,
              "warning",
            );
          }
        }
        updateStatus(ctx);
        return;
      }

      if (cmd === "reload") {
        reloadCfg(ctx);
        notifyStatus(ctx);
        updateStatus(ctx);
        return;
      }

      if (cmd === "on") {
        if (cfg) cfg.enabled = true;
        if (ctx.hasUI) ctx.ui.notify(`[${EXT}] enabled=true (runtime)`, "info");
        updateStatus(ctx);
        return;
      }

      if (cmd === "off") {
        if (cfg) cfg.enabled = false;
        clearRetryTimer();
        restoreOriginalEnv();
        pendingOauthReminderProviders = [];
        if (ctx.hasUI) {
          ctx.ui.notify(`[${EXT}] enabled=false (runtime)`, "warning");
          ctx.ui.setStatus(EXT, undefined);
          ctx.ui.setWidget(LOGIN_WIDGET_KEY, undefined);
        }
        return;
      }

      if (cmd === "use") {
        const vendor = String(parts[1] ?? "").trim().toLowerCase();
        const authType = String(parts[2] ?? "").trim() as AuthType;
        const label = String(parts[3] ?? "").trim();
        const modelId = parts[4] ? String(parts[4]).trim() : undefined;

        if (!vendor || (authType !== "oauth" && authType !== "api_key") || !label) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `[${EXT}] Usage: /subswitch use <vendor> <auth_type> <label> [modelId]`,
              "warning",
            );
          }
          updateStatus(ctx);
          return;
        }

        await useRouteBySelector(ctx, vendor, authType, label, modelId, "manual use");
        updateStatus(ctx);
        return;
      }

      if (cmd === "subscription" || cmd === "api") {
        const authType: AuthType = cmd === "subscription" ? "oauth" : "api_key";
        const vendor = vendorForCommand(ctx, parts[1]);
        const label = parts[2] ? String(parts[2]).trim() : undefined;
        const modelId = parts[3] ? String(parts[3]).trim() : undefined;

        await useFirstRouteForAuthType(ctx, vendor, authType, label, modelId, "manual auth-type");
        updateStatus(ctx);
        return;
      }

      if (cmd === "primary" || cmd === "fallback") {
        const authType: AuthType = cmd === "primary" ? "oauth" : "api_key";
        const vendor = cfg?.default_vendor ?? "openai";
        const label = parts[1] ? String(parts[1]).trim() : undefined;
        const modelId = parts[2] ? String(parts[2]).trim() : undefined;

        if (ctx.hasUI) {
          const replacement = cmd === "primary" ? "subscription" : "api";
          ctx.ui.notify(
            `[${EXT}] '${cmd}' is deprecated; use '/subswitch ${replacement} ${vendor} ...'`,
            "warning",
          );
        }

        await useFirstRouteForAuthType(ctx, vendor, authType, label, modelId, "compat alias");
        updateStatus(ctx);
        return;
      }

      if (cmd === "rename") {
        const vendor = String(parts[1] ?? "").trim().toLowerCase();
        const authType = String(parts[2] ?? "").trim() as AuthType;
        const oldLabel = String(parts[3] ?? "").trim();
        const newLabel = String(parts[4] ?? "").trim();

        if (!vendor || (authType !== "oauth" && authType !== "api_key") || !oldLabel || !newLabel) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `[${EXT}] Usage: /subswitch rename <vendor> <auth_type> <old_label> <new_label>`,
              "warning",
            );
          }
          updateStatus(ctx);
          return;
        }

        const ok = renameRoute(vendor, authType, oldLabel, newLabel);
        if (!ok) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `[${EXT}] Route not found for rename (${vendor}/${authType}/${oldLabel})`,
              "warning",
            );
          }
          updateStatus(ctx);
          return;
        }

        const savePath = saveCurrentConfig(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[${EXT}] Renamed route '${oldLabel}' -> '${newLabel}'. Saved to ${savePath}`,
            "info",
          );
        }

        reloadCfg(ctx);
        updateStatus(ctx);
        return;
      }

      if (cmd === "reorder") {
        await reorderVendorInteractive(ctx, parts[1]);
        updateStatus(ctx);
        return;
      }

      if (cmd === "edit") {
        await editConfigInteractive(ctx);
        updateStatus(ctx);
        return;
      }

      if (cmd === "models") {
        const vendor = vendorForCommand(ctx, parts[1]);
        await showModelCompatibility(ctx, vendor);
        updateStatus(ctx);
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(`[${EXT}] Unknown command '${cmd}'. Try '/subswitch help'.`, "warning");
      }
      updateStatus(ctx);
    },
  });

  pi.on("input", async (event) => {
    pendingInputSource = event.source as InputSource;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    ensureCfg(ctx);
    if (!cfg?.enabled) return;

    lastCtx = ctx;
    rememberActiveFromCtx(ctx);
    managedModelId = ctx.model?.id;

    lastPrompt = {
      source: pendingInputSource ?? "interactive",
      text: event.prompt,
      images: (event.images ?? []) as any[],
    };
    pendingInputSource = undefined;

    await maybePromotePreferredRoute(ctx, "before turn");
    scheduleRetryTimer(ctx);
    updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    ensureCfg(ctx);
    if (!cfg?.enabled) return;

    lastCtx = ctx;

    const activeProvider = event.model?.provider;
    const activeModelId = event.model?.id;

    const isExtensionSwitch =
      pendingExtensionSwitch !== undefined &&
      activeProvider === pendingExtensionSwitch.provider &&
      activeModelId === pendingExtensionSwitch.modelId;

    if (isExtensionSwitch) {
      pendingExtensionSwitch = undefined;
      rememberActiveFromCtx(ctx);
      managedModelId = activeModelId;
      scheduleRetryTimer(ctx);
      await refreshOauthReminderWidget(ctx, configuredOauthProviders());
      updateStatus(ctx);
      return;
    }

    managedModelId = activeModelId;
    rememberActiveFromCtx(ctx);
    scheduleRetryTimer(ctx);
    await refreshOauthReminderWidget(ctx, configuredOauthProviders());
    updateStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    ensureCfg(ctx);
    if (!cfg?.enabled) return;

    lastCtx = ctx;
    rememberActiveFromCtx(ctx);

    const message: any = event.message;
    if (message?.stopReason !== "error") return;

    const err = message?.errorMessage ?? message?.details?.error ?? message?.error ?? "unknown error";
    if (!isRateLimitError(err, cfg.rate_limit_patterns)) return;

    const provider = ctx.model?.provider;
    const modelId = ctx.model?.id;
    if (!provider || !modelId) return;

    const resolved = resolveVendorRouteForProvider(provider);
    if (!resolved) return;

    const vendorCfg = getVendor(resolved.vendor);
    const route = getRoute(resolved.vendor, resolved.index);
    if (!vendorCfg || !route) return;

    const parsedRetryMs = parseRetryAfterMs(err);
    const defaultCooldownMs = routeDefaultCooldownMinutes(vendorCfg, route) * 60_000;
    const bufferMs = route.auth_type === "oauth" ? 15_000 : 5_000;
    const until = now() + (parsedRetryMs ?? defaultCooldownMs) + bufferMs;

    setRouteCooldownUntil(resolved.vendor, resolved.index, until);

    const nextIdx = selectNextRouteIndexForFailover(ctx, resolved.vendor, modelId, resolved.index);
    if (nextIdx === undefined) {
      if (ctx.hasUI) {
        const mins = Math.max(0, Math.ceil((until - now()) / 60000));
        ctx.ui.notify(
          `[${EXT}] ${routeDisplay(resolved.vendor, route)} appears rate-limited; no eligible next route for model '${modelId}' (retry ~${mins}m)`,
          "warning",
        );
      }
      scheduleRetryTimer(ctx);
      updateStatus(ctx);
      return;
    }

    const nextRoute = getRoute(resolved.vendor, nextIdx)!;
    if (ctx.hasUI) {
      const source = parsedRetryMs !== undefined ? "provider retry hint" : "configured cooldown";
      ctx.ui.notify(
        `[${EXT}] ${routeDisplay(resolved.vendor, route)} rate-limited; switching to ${routeDisplay(resolved.vendor, nextRoute)} (${source})`,
        "warning",
      );
    }

    const switched = await switchToRoute(
      ctx,
      resolved.vendor,
      nextIdx,
      modelId,
      "rate limited",
      true,
    );

    if (!switched) {
      scheduleRetryTimer(ctx);
      updateStatus(ctx);
      return;
    }

    // Auto-retry only when moving from OAuth to API key route and vendor policy allows it.
    if (
      route.auth_type === "oauth" &&
      nextRoute.auth_type === "api_key" &&
      vendorCfg.auto_retry &&
      lastPrompt &&
      lastPrompt.source !== "extension"
    ) {
      const content =
        !lastPrompt.images || lastPrompt.images.length === 0
          ? lastPrompt.text
          : [{ type: "text", text: lastPrompt.text }, ...lastPrompt.images];

      if (typeof ctx.isIdle === "function" && ctx.isIdle()) {
        pi.sendUserMessage(content);
      } else {
        pi.sendUserMessage(content, { deliverAs: "followUp" });
      }
    }

    scheduleRetryTimer(ctx);
    updateStatus(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    reloadCfg(ctx);
    lastCtx = ctx;
    rememberActiveFromCtx(ctx);
    managedModelId = ctx.model?.id;

    // If we start on an api_key route we might need to apply env material now.
    const provider = ctx.model?.provider;
    if (provider) {
      const resolved = resolveVendorRouteForProvider(provider);
      if (resolved) {
        const route = getRoute(resolved.vendor, resolved.index);
        if (route?.auth_type === "api_key") {
          applyApiRouteCredentials(resolved.vendor, route);
        }
      }
    }

    scheduleRetryTimer(ctx);
    await refreshOauthReminderWidget(ctx, configuredOauthProviders());
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    reloadCfg(ctx);
    lastCtx = ctx;
    rememberActiveFromCtx(ctx);
    managedModelId = ctx.model?.id;
    scheduleRetryTimer(ctx);
    await refreshOauthReminderWidget(ctx, configuredOauthProviders());
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    clearRetryTimer();
    restoreOriginalEnv();
  });
}
