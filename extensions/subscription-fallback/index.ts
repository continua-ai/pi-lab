// subscription-fallback (pi extension)
//
// v2 UX goals:
// - support multiple vendors (openai, claude)
// - support multiple auth routes per vendor (oauth + api_key)
// - failover order is defined by a global preference stack (route + optional model)
// - model policy defaults to "follow_current", with optional per-stack-entry model override
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
type FailoverScope = "global" | "current_vendor";

const EXT = "subscription-fallback";
const EXT_LABEL = "subswitch";
const EXT_NOTIFY = `[${EXT_LABEL}]`;

interface PreferenceStackEntryConfig {
  route_id?: string;
  model?: string;
}

interface FailoverReturnConfig {
  enabled?: boolean;
  min_stable_minutes?: number;
}

interface FailoverTriggersConfig {
  rate_limit?: boolean;
  quota_exhausted?: boolean;
  auth_error?: boolean;
}

interface FailoverConfig {
  scope?: FailoverScope;
  return_to_preferred?: FailoverReturnConfig;
  // Legacy aliases accepted for compatibility.
  auto_return?: boolean;
  min_stable_minutes?: number;
  triggers?: FailoverTriggersConfig;
}

interface RouteConfig {
  id?: string;
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
  failover?: FailoverConfig;
  preference_stack?: PreferenceStackEntryConfig[];
}

interface NormalizedRoute {
  id: string;
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

interface NormalizedPreferenceStackEntry {
  route_id: string;
  model?: string;
}

interface NormalizedFailoverReturnConfig {
  enabled: boolean;
  min_stable_minutes: number;
}

interface NormalizedFailoverTriggersConfig {
  rate_limit: boolean;
  quota_exhausted: boolean;
  auth_error: boolean;
}

interface NormalizedFailoverConfig {
  scope: FailoverScope;
  return_to_preferred: NormalizedFailoverReturnConfig;
  triggers: NormalizedFailoverTriggersConfig;
}

interface NormalizedConfig {
  enabled: boolean;
  default_vendor: string;
  vendors: NormalizedVendor[];
  rate_limit_patterns: string[];
  failover: NormalizedFailoverConfig;
  preference_stack: NormalizedPreferenceStackEntry[];
}

interface ResolvedRouteRef {
  vendor: string;
  index: number;
  route: NormalizedRoute;
}

interface EffectivePreferenceEntry {
  stack_index: number;
  route_ref: ResolvedRouteRef;
  model_id: string;
  model_source: "entry" | "current";
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

type DecisionEventLevel = "info" | "warning";

type DecisionEventKind =
  | "failover_trigger"
  | "failover_switch"
  | "failover_stay"
  | "no_fallback"
  | "return_probe"
  | "return_switch"
  | "return_stay"
  | "manual_switch"
  | "manual_switch_stay"
  | "compaction"
  | "continuation"
  | "auto_retry";

interface DecisionEvent {
  ts_ms: number;
  kind: DecisionEventKind;
  level: DecisionEventLevel;
  message: string;
  reason?: string;
  next_retry_at_ms?: number;
}

interface PersistedState {
  version?: number;
  route_cooldown_until?: Record<string, number>;
  next_return_eligible_at_ms?: number;
  decision_events?: DecisionEvent[];
}

interface RouteProbeResult {
  ok: boolean;
  message?: string;
  retry_after_ms?: number;
  inconclusive?: boolean;
}

type RouteIneligibleReason =
  | "cooldown"
  | "model_unavailable"
  | "missing_credentials"
  | "context_too_large";

interface ContextFitResult {
  fits: boolean;
  source_tokens?: number;
  estimated_target_tokens?: number;
  target_context_window?: number;
  safe_target_budget?: number;
  multiplier?: number;
}

interface FallbackSelectionResult {
  entry?: EffectivePreferenceEntry;
  context_blocked: number;
  first_context_blocked?: EffectivePreferenceEntry;
}

interface ContinuationTarget {
  vendor: string;
  routeIndex: number;
  route: NormalizedRoute;
  modelId: string;
}

interface ContinuationSummaryResult {
  ok: boolean;
  summary?: string;
  message?: string;
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
    console.error(`${EXT_NOTIFY} Failed to parse ${path}:`, e);
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

function globalStatePath(): string {
  return join(homedir(), ".pi", "agent", "subswitch-state.json");
}

function projectStatePath(cwd: string): string {
  return join(cwd, ".pi", "subswitch-state.json");
}

function statePathForConfigPath(cwd: string, configPath: string): string {
  return configPath === projectConfigPath(cwd)
    ? projectStatePath(cwd)
    : globalStatePath();
}

function preferredWritableStatePath(cwd: string): string {
  return statePathForConfigPath(cwd, preferredWritableConfigPath(cwd));
}

function statePathCandidates(cwd: string): string[] {
  const preferred = preferredWritableStatePath(cwd);
  const fallback =
    preferred === projectStatePath(cwd)
      ? globalStatePath()
      : projectStatePath(cwd);
  return preferred === fallback ? [preferred] : [preferred, fallback];
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

function uniqueRouteId(base: string, usedIds: Set<string>): string {
  const cleaned = (base || "").trim().replace(/\s+/g, "-") || "route";
  if (!usedIds.has(cleaned)) {
    usedIds.add(cleaned);
    return cleaned;
  }

  let n = 2;
  while (usedIds.has(`${cleaned}-${n}`)) n += 1;
  const id = `${cleaned}-${n}`;
  usedIds.add(id);
  return id;
}

function normalizeRoute(
  vendor: string,
  route: RouteConfig,
  index: number,
  usedIds: Set<string>,
): NormalizedRoute | undefined {
  const authType: AuthType = route.auth_type === "oauth" || route.auth_type === "api_key" ? route.auth_type : "oauth";

  const providerId = String(route.provider_id ?? defaultProviderId(vendor, authType)).trim();
  if (!providerId) return undefined;

  const fallbackLabel = `${authType}-${index + 1}`;
  const label = String(route.label ?? fallbackLabel).trim() || fallbackLabel;
  const rawRouteId = String(route.id ?? `${vendor}-${authType}-${label}`).trim();
  const routeId = uniqueRouteId(rawRouteId, usedIds);

  const out: NormalizedRoute = {
    id: routeId,
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

function normalizeFailover(raw: FailoverConfig | undefined): NormalizedFailoverConfig {
  const scope: FailoverScope = raw?.scope === "current_vendor" ? "current_vendor" : "global";

  const returnEnabled = raw?.return_to_preferred?.enabled ?? raw?.auto_return ?? true;
  const minStableMinutesRaw =
    raw?.return_to_preferred?.min_stable_minutes ?? raw?.min_stable_minutes ?? 10;
  const minStableMinutes = Number.isFinite(Number(minStableMinutesRaw))
    ? Math.max(0, Math.floor(Number(minStableMinutesRaw)))
    : 10;

  return {
    scope,
    return_to_preferred: {
      enabled: Boolean(returnEnabled),
      min_stable_minutes: minStableMinutes,
    },
    triggers: {
      rate_limit: raw?.triggers?.rate_limit ?? true,
      quota_exhausted: raw?.triggers?.quota_exhausted ?? true,
      auth_error: raw?.triggers?.auth_error ?? true,
    },
  };
}

function buildDefaultPreferenceStack(
  vendors: NormalizedVendor[],
  defaultVendor: string,
): NormalizedPreferenceStackEntry[] {
  const vendorOrder: string[] = [];
  if (vendors.some((v) => v.vendor === defaultVendor)) {
    vendorOrder.push(defaultVendor);
  }
  for (const v of vendors) {
    if (!vendorOrder.includes(v.vendor)) vendorOrder.push(v.vendor);
  }

  const byVendor = new Map<string, NormalizedVendor>();
  for (const v of vendors) byVendor.set(v.vendor, v);

  const out: NormalizedPreferenceStackEntry[] = [];
  const pushByAuth = (authType: AuthType): void => {
    for (const vendor of vendorOrder) {
      const v = byVendor.get(vendor);
      if (!v) continue;
      for (const route of v.routes) {
        if (route.auth_type !== authType) continue;
        out.push({ route_id: route.id });
      }
    }
  };

  // Recommended default: subscription first, then API key routes.
  pushByAuth("oauth");
  pushByAuth("api_key");

  if (out.length === 0) {
    for (const v of vendors) {
      for (const route of v.routes) {
        out.push({ route_id: route.id });
      }
    }
  }

  return out;
}

function normalizePreferenceStack(
  inputEntries: PreferenceStackEntryConfig[] | undefined,
  vendors: NormalizedVendor[],
  defaultVendor: string,
): NormalizedPreferenceStackEntry[] {
  const routeIds = new Set<string>();
  for (const v of vendors) {
    for (const route of v.routes) routeIds.add(route.id);
  }

  const out: NormalizedPreferenceStackEntry[] = [];
  const seen = new Set<string>();
  const raw = Array.isArray(inputEntries) ? inputEntries : [];
  for (const entry of raw) {
    const routeId = String(entry?.route_id ?? "").trim();
    if (!routeId || !routeIds.has(routeId)) continue;

    const model = String(entry?.model ?? "").trim() || undefined;
    const key = `${routeId}::${model ?? ""}`;
    if (seen.has(key)) continue;

    out.push({ route_id: routeId, ...(model ? { model } : {}) });
    seen.add(key);
  }

  const recommended = buildDefaultPreferenceStack(vendors, defaultVendor);
  if (out.length === 0) return recommended;

  // Ensure every configured route appears at least once in the stack.
  const presentRouteIds = new Set(out.map((entry) => entry.route_id));
  for (const entry of recommended) {
    if (presentRouteIds.has(entry.route_id)) continue;
    out.push(entry);
    presentRouteIds.add(entry.route_id);
  }

  return out;
}

function normalizeConfig(input: Config | undefined): NormalizedConfig {
  const vendorsInput = Array.isArray(input?.vendors) ? input?.vendors : [];

  const vendors: NormalizedVendor[] = [];
  const usedRouteIds = new Set<string>();
  for (const rawVendor of vendorsInput) {
    const vendorName = String(rawVendor.vendor ?? "").trim().toLowerCase();
    if (!vendorName) continue;

    const rawRoutes = Array.isArray(rawVendor.routes) ? rawVendor.routes : [];
    const routes: NormalizedRoute[] = [];
    for (let i = 0; i < rawRoutes.length; i++) {
      const normalized = normalizeRoute(vendorName, rawRoutes[i], i, usedRouteIds);
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

  let defaultVendor = String(input?.default_vendor ?? vendors[0]?.vendor ?? "openai")
    .trim()
    .toLowerCase();
  if (vendors.length > 0 && !vendors.some((v) => v.vendor === defaultVendor)) {
    defaultVendor = vendors[0].vendor;
  }

  const rateLimitPatterns = Array.isArray(input?.rate_limit_patterns)
    ? input?.rate_limit_patterns.map((p) => String(p).trim()).filter(Boolean)
    : [];

  const failover = normalizeFailover(input?.failover);
  const preferenceStack = normalizePreferenceStack(input?.preference_stack, vendors, defaultVendor);

  return {
    enabled: input?.enabled ?? true,
    default_vendor: defaultVendor,
    vendors,
    rate_limit_patterns: rateLimitPatterns,
    failover,
    preference_stack: preferenceStack,
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
    failover: {
      scope: cfg.failover.scope,
      return_to_preferred: {
        enabled: cfg.failover.return_to_preferred.enabled,
        min_stable_minutes: cfg.failover.return_to_preferred.min_stable_minutes,
      },
      triggers: {
        rate_limit: cfg.failover.triggers.rate_limit,
        quota_exhausted: cfg.failover.triggers.quota_exhausted,
        auth_error: cfg.failover.triggers.auth_error,
      },
    },
    preference_stack: cfg.preference_stack.map((entry) => ({
      route_id: entry.route_id,
      model: entry.model,
    })),
    vendors: cfg.vendors.map((v) => ({
      vendor: v.vendor,
      oauth_cooldown_minutes: v.oauth_cooldown_minutes,
      api_key_cooldown_minutes: v.api_key_cooldown_minutes,
      auto_retry: v.auto_retry,
      routes: v.routes.map((r) => ({
        id: r.id,
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

function isQuotaExhaustedError(err: unknown): boolean {
  if (isContextWindowExceededError(err)) return false;

  const s = String(err ?? "");
  const l = s.toLowerCase();

  const patterns = [
    "insufficient_quota",
    "quota exceeded",
    "exceeded your current quota",
    "billing hard limit",
    "credit balance",
    "out of credits",
  ];

  return patterns.some((p) => p && l.includes(p));
}

function isRateLimitSignalError(err: unknown, extraPatterns: string[] = []): boolean {
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
    "capacity",
    ...extraPatterns.map((p) => p.toLowerCase()),
  ];

  return patterns.some((p) => p && l.includes(p));
}

function isAuthError(err: unknown): boolean {
  if (isContextWindowExceededError(err)) return false;

  const s = String(err ?? "");
  const l = s.toLowerCase();

  const patterns = [
    "invalid api key",
    "incorrect api key",
    "api key is not valid",
    "authentication",
    "unauthorized",
    "forbidden",
    "permission denied",
    "401",
    "403",
    "invalid x-api-key",
    "missing api key",
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

  // Current model selected by /model (used when preference stack entries omit model).
  let managedModelId: string | undefined;

  // Current route state
  let activeVendor: string | undefined;
  const activeRouteIndexByVendor = new Map<string, number>();

  // Per-route cooldown state. Key: route_id => epoch ms.
  const routeCooldownUntil = new Map<string, number>();

  // Rolling decision/event log used for /subswitch events and diagnostics.
  const decisionEvents: DecisionEvent[] = [];

  // Persistent runtime state path (project or global, based on active config location).
  let statePath: string | undefined;

  // Retry timer for cooldown expiry checks
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  // Avoid feedback loops for extension-driven model changes.
  let pendingExtensionSwitch: { provider: string; modelId: string } | undefined;

  let originalEnv: OriginalEnv | undefined;

  // Keep track of aliases we registered to avoid duplicate work.
  const registeredAliases = new Set<string>();

  const LOGIN_WIDGET_KEY = `${EXT}-oauth-login`;
  let pendingOauthReminderProviders: string[] = [];

  // Prevent immediate bounce-backs after failover.
  let nextReturnEligibleAtMs = 0;

  // Ensure we do not run concurrent preferred-route probes.
  let promotionProbeInFlight = false;

  // Ensure we do not run concurrent switch-triggered compactions.
  let switchCompactionInFlight = false;

  const RETURN_PROBE_TIMEOUT_MS = 12_000;
  const RETURN_PROBE_MIN_COOLDOWN_MS = 2 * 60_000;
  const RETURN_PROBE_MAX_COOLDOWN_MS = 10 * 60_000;

  const SWITCH_CONTEXT_SAME_PROVIDER_MULTIPLIER = 1.08;
  const SWITCH_CONTEXT_CROSS_PROVIDER_MULTIPLIER = 1.2;
  const SWITCH_CONTEXT_RESERVE_RATIO = 0.15;
  const SWITCH_CONTEXT_RESERVE_MIN_TOKENS = 16_384;
  const SWITCH_COMPACTION_TIMEOUT_MS = 120_000;
  const DECISION_EVENT_MAX = 200;
  const DECISION_EVENT_DEFAULT_LIMIT = 20;

  const CONTINUATION_CHUNK_CHARS = 18_000;
  const CONTINUATION_MAX_CHUNKS = 8;
  const CONTINUATION_MAX_LINES_PER_CHUNK = 60;

  function now(): number {
    return Date.now();
  }

  function formatDurationCompact(ms: number): string {
    const safeMs = Math.max(0, Math.floor(ms));
    const totalMinutes = Math.max(0, Math.ceil(safeMs / 60000));

    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }

    const totalHours = Math.floor(totalMinutes / 60);
    const remMinutes = totalMinutes % 60;

    if (totalHours < 24) {
      return remMinutes > 0 ? `${totalHours}h ${remMinutes}m` : `${totalHours}h`;
    }

    const totalDays = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return remHours > 0 ? `${totalDays}d ${remHours}h` : `${totalDays}d`;
  }

  function isSameLocalDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function isTomorrowLocalDay(target: Date, relativeTo: Date): boolean {
    const tomorrow = new Date(relativeTo.getTime());
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return isSameLocalDay(target, tomorrow);
  }

  function formatUntilLocal(untilMs: number): string {
    const target = new Date(untilMs);
    const current = new Date(now());

    const localTime = target.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });

    if (isSameLocalDay(target, current)) {
      return `until ${localTime} local`;
    }

    if (isTomorrowLocalDay(target, current)) {
      return `until tomorrow ${localTime} local`;
    }

    const localDate = target.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      ...(target.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
    });

    return `until ${localDate} ${localTime} local`;
  }

  function formatRetryWindow(untilMs: number): string {
    return `~${formatDurationCompact(untilMs - now())} (${formatUntilLocal(untilMs)})`;
  }

  function formatTimestampLocal(tsMs: number): string {
    const d = new Date(tsMs);
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function isDecisionEventLevel(level: string): level is DecisionEventLevel {
    return level === "info" || level === "warning";
  }

  function isDecisionEventKind(kind: string): kind is DecisionEventKind {
    return [
      "failover_trigger",
      "failover_switch",
      "failover_stay",
      "no_fallback",
      "return_probe",
      "return_switch",
      "return_stay",
      "manual_switch",
      "manual_switch_stay",
      "compaction",
      "continuation",
      "auto_retry",
    ].includes(kind);
  }

  function recordDecisionEvent(event: DecisionEvent): void {
    decisionEvents.push({
      ...event,
      ts_ms: Number.isFinite(event.ts_ms) ? Math.floor(event.ts_ms) : now(),
    });

    if (decisionEvents.length > DECISION_EVENT_MAX) {
      decisionEvents.splice(0, decisionEvents.length - DECISION_EVENT_MAX);
    }

    persistRuntimeState();
  }

  function notifyDecision(
    ctx: any,
    level: DecisionEventLevel,
    kind: DecisionEventKind,
    message: string,
    options?: { reason?: string; nextRetryAtMs?: number; silent?: boolean },
  ): void {
    recordDecisionEvent({
      ts_ms: now(),
      kind,
      level,
      message,
      reason: options?.reason,
      next_retry_at_ms: options?.nextRetryAtMs,
    });

    if (!options?.silent && ctx.hasUI) {
      ctx.ui.notify(`${EXT_NOTIFY} ${message}`, level);
    }
  }

  function buildDecisionEventLines(limit = DECISION_EVENT_DEFAULT_LIMIT): string[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const recent = decisionEvents.slice(-safeLimit);

    if (recent.length === 0) {
      return [`${EXT_NOTIFY} No subswitch events recorded yet.`];
    }

    const lines: string[] = [`${EXT_NOTIFY} Last ${recent.length} subswitch event(s):`];
    for (const event of recent) {
      const level = event.level.toUpperCase();
      let line = `- [${formatTimestampLocal(event.ts_ms)}] [${level}] ${event.kind}: ${event.message}`;
      if (event.reason) line += ` | reason=${event.reason}`;
      if (event.next_retry_at_ms && event.next_retry_at_ms > 0) {
        line += ` | next=${formatRetryWindow(event.next_retry_at_ms)}`;
      }
      lines.push(line);
    }

    return lines;
  }

  function humanReadableRouteState(
    rawState: string,
    cooldownUntilMs?: number,
  ): string {
    if (rawState === "ready") return "ready";
    if (rawState === "waiting_for_current_model") return "waiting for current /model";
    if (rawState === "model_unavailable") return "model unavailable";
    if (rawState === "missing_credentials") return "credentials needed";
    if (rawState === "context_too_large") return "context too large for target model";

    if (rawState.startsWith("cooldown")) {
      if (cooldownUntilMs && cooldownUntilMs > now()) {
        return `cooling down: ${formatRetryWindow(cooldownUntilMs)}`;
      }
      return "cooling down";
    }

    return rawState;
  }

  function ensureCfg(ctx: any): NormalizedConfig {
    if (!cfg) {
      cfg = loadConfig(ctx.cwd);
      registerAliasesFromConfig(cfg);
      statePath = preferredWritableStatePath(ctx.cwd);
      pruneRuntimeState();
    }
    return cfg;
  }

  function reloadCfg(ctx: any): void {
    cfg = loadConfig(ctx.cwd);
    registerAliasesFromConfig(cfg);
    statePath = preferredWritableStatePath(ctx.cwd);
    pruneRuntimeState();
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

  function resolveRouteById(routeId: string): ResolvedRouteRef | undefined {
    if (!cfg) return undefined;
    const id = routeId.trim();
    if (!id) return undefined;

    for (const v of cfg.vendors) {
      for (let i = 0; i < v.routes.length; i++) {
        if (v.routes[i].id === id) {
          return { vendor: v.vendor, index: i, route: v.routes[i] };
        }
      }
    }
    return undefined;
  }

  function routeStateKey(vendor: string, index: number): string | undefined {
    const route = getRoute(vendor, index);
    return route?.id;
  }

  function pruneRuntimeState(): void {
    const currentTs = now();

    const validRouteIds = new Set<string>();
    if (cfg) {
      for (const v of cfg.vendors) {
        for (const route of v.routes) validRouteIds.add(route.id);
      }
    }

    for (const [routeId, until] of routeCooldownUntil.entries()) {
      if (!Number.isFinite(until) || until <= currentTs) {
        routeCooldownUntil.delete(routeId);
        continue;
      }

      if (validRouteIds.size > 0 && !validRouteIds.has(routeId)) {
        routeCooldownUntil.delete(routeId);
      }
    }

    if (!cfg?.failover.return_to_preferred.enabled || nextReturnEligibleAtMs <= currentTs) {
      nextReturnEligibleAtMs = 0;
    }

    // Keep decision log bounded and well-formed.
    for (let i = decisionEvents.length - 1; i >= 0; i--) {
      const event = decisionEvents[i];
      if (!event || !Number.isFinite(Number(event.ts_ms))) {
        decisionEvents.splice(i, 1);
      }
    }
    if (decisionEvents.length > DECISION_EVENT_MAX) {
      decisionEvents.splice(0, decisionEvents.length - DECISION_EVENT_MAX);
    }
  }

  function buildPersistedState(): PersistedState {
    pruneRuntimeState();

    const routeCooldowns: Record<string, number> = {};
    for (const [routeId, until] of routeCooldownUntil.entries()) {
      routeCooldowns[routeId] = Math.floor(until);
    }

    const state: PersistedState = { version: 1 };
    if (Object.keys(routeCooldowns).length > 0) {
      state.route_cooldown_until = routeCooldowns;
    }

    if (nextReturnEligibleAtMs > now()) {
      state.next_return_eligible_at_ms = Math.floor(nextReturnEligibleAtMs);
    }

    if (decisionEvents.length > 0) {
      state.decision_events = decisionEvents.slice(-DECISION_EVENT_MAX);
    }

    return state;
  }

  function persistRuntimeState(): void {
    if (!statePath) return;
    writeJson(statePath, buildPersistedState());
  }

  function loadRuntimeState(ctx: any): void {
    ensureCfg(ctx);
    statePath = preferredWritableStatePath(ctx.cwd);

    routeCooldownUntil.clear();
    decisionEvents.splice(0, decisionEvents.length);
    nextReturnEligibleAtMs = 0;

    const candidates = statePathCandidates(ctx.cwd);
    for (const candidate of candidates) {
      const raw = readJson(candidate) as PersistedState | undefined;
      if (!raw) continue;

      const routeCooldowns = raw.route_cooldown_until;
      if (routeCooldowns && typeof routeCooldowns === "object") {
        for (const [routeId, untilRaw] of Object.entries(routeCooldowns)) {
          if (!routeId) continue;
          const until = Number(untilRaw);
          if (!Number.isFinite(until) || until <= now()) continue;
          routeCooldownUntil.set(routeId, Math.floor(until));
        }
      }

      const holdoff = Number(raw.next_return_eligible_at_ms);
      if (Number.isFinite(holdoff) && holdoff > now()) {
        nextReturnEligibleAtMs = Math.floor(holdoff);
      }

      const events = Array.isArray(raw.decision_events) ? raw.decision_events : [];
      for (const event of events.slice(-DECISION_EVENT_MAX)) {
        if (!event || typeof event !== "object") continue;
        const ts = Number((event as any).ts_ms);
        const message = String((event as any).message ?? "").trim();
        const kindRaw = String((event as any).kind ?? "").trim();
        const levelRaw = String((event as any).level ?? "").trim();
        if (!Number.isFinite(ts) || !message || !isDecisionEventKind(kindRaw) || !isDecisionEventLevel(levelRaw)) {
          continue;
        }
        const nextRetry = Number((event as any).next_retry_at_ms);
        const reasonRaw = String((event as any).reason ?? "").trim();
        decisionEvents.push({
          ts_ms: Math.floor(ts),
          kind: kindRaw,
          level: levelRaw,
          message,
          reason: reasonRaw || undefined,
          next_retry_at_ms: Number.isFinite(nextRetry) ? Math.floor(nextRetry) : undefined,
        });
      }

      break;
    }

    pruneRuntimeState();
    persistRuntimeState();
  }

  function setNextReturnEligibleAtMs(untilMs: number): void {
    const normalized = Number.isFinite(untilMs)
      ? Math.max(0, Math.floor(untilMs))
      : 0;

    if (normalized === nextReturnEligibleAtMs) return;
    nextReturnEligibleAtMs = normalized;
    persistRuntimeState();
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
    const key = routeStateKey(vendor, index);
    if (!key) return 0;
    return routeCooldownUntil.get(key) ?? 0;
  }

  function setRouteCooldownUntil(vendor: string, index: number, untilMs: number): void {
    const key = routeStateKey(vendor, index);
    if (!key) return;

    const normalized = Number.isFinite(untilMs)
      ? Math.max(0, Math.floor(untilMs))
      : 0;
    const previous = routeCooldownUntil.get(key) ?? 0;

    if (normalized <= now()) {
      if (previous !== 0) {
        routeCooldownUntil.delete(key);
        persistRuntimeState();
      }
      return;
    }

    if (previous === normalized) return;

    routeCooldownUntil.set(key, normalized);
    persistRuntimeState();
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

  function contextFitForRouteModel(
    ctx: any,
    route: NormalizedRoute,
    modelId: string,
  ): ContextFitResult {
    const targetModel = ctx.modelRegistry.find(route.provider_id, modelId);
    if (!targetModel) return { fits: true };

    const targetWindow = Number((targetModel as any).contextWindow ?? 0);
    if (!Number.isFinite(targetWindow) || targetWindow <= 0) {
      return { fits: true };
    }

    const usage = typeof ctx.getContextUsage === "function"
      ? ctx.getContextUsage()
      : undefined;
    const sourceTokens = Number(usage?.tokens ?? 0);
    if (!Number.isFinite(sourceTokens) || sourceTokens <= 0) {
      return { fits: true, target_context_window: targetWindow };
    }

    const currentProvider = String(ctx.model?.provider ?? "").trim();
    const multiplier =
      currentProvider && currentProvider === route.provider_id
        ? SWITCH_CONTEXT_SAME_PROVIDER_MULTIPLIER
        : SWITCH_CONTEXT_CROSS_PROVIDER_MULTIPLIER;

    const estimatedTokens = Math.ceil(sourceTokens * multiplier);
    const reserveTokens = Math.max(
      SWITCH_CONTEXT_RESERVE_MIN_TOKENS,
      Math.floor(targetWindow * SWITCH_CONTEXT_RESERVE_RATIO),
    );
    const safeBudget = Math.max(1024, targetWindow - reserveTokens);

    return {
      fits: estimatedTokens <= safeBudget,
      source_tokens: sourceTokens,
      estimated_target_tokens: estimatedTokens,
      target_context_window: targetWindow,
      safe_target_budget: safeBudget,
      multiplier,
    };
  }

  function routeIneligibleReason(
    ctx: any,
    vendor: string,
    index: number,
    modelId: string,
  ): RouteIneligibleReason | undefined {
    const route = getRoute(vendor, index);
    if (!route) return "model_unavailable";
    if (isRouteCoolingDown(vendor, index)) return "cooldown";
    if (!routeCanHandleModel(ctx, route, modelId)) return "model_unavailable";
    if (!routeHasUsableCredentials(vendor, route)) return "missing_credentials";

    const fit = contextFitForRouteModel(ctx, route, modelId);
    if (!fit.fits) return "context_too_large";

    return undefined;
  }

  function routeEligible(ctx: any, vendor: string, index: number, modelId: string): boolean {
    return routeIneligibleReason(ctx, vendor, index, modelId) === undefined;
  }

  function routeEligibleRef(ctx: any, ref: ResolvedRouteRef, modelId: string): boolean {
    return routeEligible(ctx, ref.vendor, ref.index, modelId);
  }

  function findNextEligibleFallback(
    ctx: any,
    effective: EffectivePreferenceEntry[],
    start: number,
  ): FallbackSelectionResult {
    let contextBlocked = 0;
    let firstContextBlocked: EffectivePreferenceEntry | undefined;

    for (let i = start; i < effective.length; i++) {
      const candidate = effective[i];
      const reason = routeIneligibleReason(
        ctx,
        candidate.route_ref.vendor,
        candidate.route_ref.index,
        candidate.model_id,
      );

      if (!reason) {
        return {
          entry: candidate,
          context_blocked: contextBlocked,
          first_context_blocked: firstContextBlocked,
        };
      }

      if (reason === "context_too_large") {
        contextBlocked += 1;
        if (!firstContextBlocked) firstContextBlocked = candidate;
      }
    }

    return {
      context_blocked: contextBlocked,
      first_context_blocked: firstContextBlocked,
    };
  }

  function contextFitSummary(fit: ContextFitResult): string {
    const source = Number(fit.source_tokens ?? 0).toLocaleString();
    const estimate = Number(fit.estimated_target_tokens ?? 0).toLocaleString();
    const budget = Number(fit.safe_target_budget ?? 0).toLocaleString();
    const window = Number(fit.target_context_window ?? 0).toLocaleString();

    return `current ~${source} tokens (estimated ~${estimate} on target) exceeds safe budget ~${budget}/${window}`;
  }

  function reasonLabel(reason: RouteIneligibleReason): string {
    if (reason === "cooldown") return "cooldown";
    if (reason === "model_unavailable") return "model unavailable";
    if (reason === "missing_credentials") return "credentials needed";
    if (reason === "context_too_large") return "context blocked";
    return reason;
  }

  function reasonDetails(
    ctx: any,
    ref: ResolvedRouteRef,
    modelId: string,
    reason: RouteIneligibleReason,
  ): string {
    if (reason === "cooldown") {
      const until = getRouteCooldownUntil(ref.vendor, ref.index);
      return until > now() ? formatRetryWindow(until) : "cooldown active";
    }

    if (reason === "model_unavailable") {
      return `${ref.route.provider_id}/${modelId} not found`;
    }

    if (reason === "missing_credentials") {
      if (ref.route.auth_type === "oauth") {
        return `oauth login needed for provider '${ref.route.provider_id}'`;
      }
      const envHint = ref.route.api_key_env ? `env ${ref.route.api_key_env}` : "api key missing";
      return envHint;
    }

    if (reason === "context_too_large") {
      return contextFitSummary(contextFitForRouteModel(ctx, ref.route, modelId));
    }

    return reason;
  }

  function buildExplainLines(ctx: any): string[] {
    if (!cfg) return [`${EXT_NOTIFY} No config loaded.`];

    const currentProvider = ctx.model?.provider;
    const currentModel = ctx.model?.id;
    if (!currentProvider || !currentModel) {
      return [`${EXT_NOTIFY} No active model selected.`];
    }

    const resolved = resolveVendorRouteForProvider(currentProvider);
    if (!resolved) {
      return [
        `${EXT_NOTIFY} Active provider '${currentProvider}' is not mapped to a subswitch route.`,
      ];
    }

    const currentRoute = getRoute(resolved.vendor, resolved.index);
    if (!currentRoute) {
      return [`${EXT_NOTIFY} Active route mapping is unavailable.`];
    }

    const usage = typeof ctx.getContextUsage === "function"
      ? ctx.getContextUsage()
      : undefined;

    const lines: string[] = [];
    lines.push(`${EXT_NOTIFY} decision explain`);
    lines.push(`current route: ${routeDisplay(resolved.vendor, currentRoute)}`);
    lines.push(`current model: ${currentProvider}/${currentModel}`);
    if (usage && Number.isFinite(Number(usage.tokens))) {
      const tokens = Number(usage.tokens).toLocaleString();
      const window = Number(usage.contextWindow ?? 0).toLocaleString();
      lines.push(`current context: ~${tokens} tokens (window ${window})`);
    }

    const effective = buildEffectivePreferenceStack(resolved.vendor, currentModel);
    if (effective.length === 0) {
      lines.push("effective stack: (empty)");
      return lines;
    }

    const currentIdx = findCurrentEffectiveStackIndex(effective, currentRoute.id, currentModel);
    lines.push("effective candidates:");

    for (let i = 0; i < effective.length; i++) {
      const entry = effective[i];
      const mark = currentIdx === i ? "*" : " ";
      const reason = routeIneligibleReason(
        ctx,
        entry.route_ref.vendor,
        entry.route_ref.index,
        entry.model_id,
      );

      if (!reason) {
        const status = currentIdx === i ? "active" : "eligible";
        lines.push(
          `  ${mark} ${i + 1}. ${routeDisplay(entry.route_ref.vendor, entry.route_ref.route)} (${entry.model_id}) -> ${status}`,
        );
      } else {
        const detail = reasonDetails(ctx, entry.route_ref, entry.model_id, reason);
        lines.push(
          `  ${mark} ${i + 1}. ${routeDisplay(entry.route_ref.vendor, entry.route_ref.route)} (${entry.model_id}) -> ineligible: ${reasonLabel(reason)} (${detail})`,
        );
      }
    }

    let nextEligible: EffectivePreferenceEntry | undefined;
    const start = currentIdx === undefined ? 0 : currentIdx + 1;
    for (let i = start; i < effective.length; i++) {
      const entry = effective[i];
      if (!routeIneligibleReason(ctx, entry.route_ref.vendor, entry.route_ref.index, entry.model_id)) {
        nextEligible = entry;
        break;
      }
    }

    if (nextEligible) {
      lines.push(
        `next fallback candidate: ${routeDisplay(nextEligible.route_ref.vendor, nextEligible.route_ref.route)} (${nextEligible.model_id})`,
      );
    } else {
      lines.push("next fallback candidate: none");
    }

    return lines;
  }

  function switchDecisionKind(reason: string, success: boolean): DecisionEventKind {
    const r = String(reason ?? "").toLowerCase();

    if (r.includes("rate") || r.includes("quota") || r.includes("auth error")) {
      return success ? "failover_switch" : "failover_stay";
    }

    if (r.includes("before turn") || r.includes("cooldown expired") || r.includes("probe")) {
      return success ? "return_switch" : "return_stay";
    }

    return success ? "manual_switch" : "manual_switch_stay";
  }

  async function runSwitchCompaction(
    ctx: any,
    targetRoute: NormalizedRoute,
    targetModelId: string,
  ): Promise<{ ok: boolean; message?: string }> {
    if (switchCompactionInFlight) {
      return { ok: false, message: "compaction already in progress" };
    }

    if (typeof ctx.compact !== "function") {
      return { ok: false, message: "compaction is unavailable in this runtime" };
    }

    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      return { ok: false, message: "agent is busy; try again when idle" };
    }

    switchCompactionInFlight = true;

    try {
      return await new Promise((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: { ok: boolean; message?: string }) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve(result);
        };

        timeout = setTimeout(() => {
          finish({
            ok: false,
            message: `compaction timed out after ${Math.floor(SWITCH_COMPACTION_TIMEOUT_MS / 1000)}s`,
          });
        }, SWITCH_COMPACTION_TIMEOUT_MS);

        try {
          ctx.compact({
            customInstructions:
              `Create a compact continuation summary so the conversation can continue after switching to ${targetRoute.provider_id}/${targetModelId}. Preserve unresolved tasks, constraints, key decisions, active file paths, and the latest user intent.`,
            onComplete: () => finish({ ok: true }),
            onError: (error: Error) => {
              const msg = trimProbeMessage(
                error instanceof Error ? error.message : String(error),
              );
              finish({ ok: false, message: msg });
            },
          });
        } catch (error) {
          const msg = trimProbeMessage(
            error instanceof Error ? error.message : String(error),
          );
          finish({ ok: false, message: msg });
        }
      });
    } finally {
      switchCompactionInFlight = false;
    }
  }

  function buildEffectivePreferenceStack(
    currentVendor: string | undefined,
    currentModelId: string | undefined,
  ): EffectivePreferenceEntry[] {
    if (!cfg) return [];

    const effective: EffectivePreferenceEntry[] = [];
    for (let i = 0; i < cfg.preference_stack.length; i++) {
      const entry = cfg.preference_stack[i];
      const routeRef = resolveRouteById(entry.route_id);
      if (!routeRef) continue;

      if (
        cfg.failover.scope === "current_vendor" &&
        currentVendor &&
        routeRef.vendor !== currentVendor
      ) {
        continue;
      }

      const modelId = entry.model ?? currentModelId;
      if (!modelId) continue;

      effective.push({
        stack_index: i,
        route_ref: routeRef,
        model_id: modelId,
        model_source: entry.model ? "entry" : "current",
      });
    }

    return effective;
  }

  function findCurrentEffectiveStackIndex(
    effective: EffectivePreferenceEntry[],
    currentRouteId: string,
    currentModelId: string,
  ): number | undefined {
    const exact = effective.findIndex(
      (entry) => entry.route_ref.route.id === currentRouteId && entry.model_id === currentModelId,
    );
    if (exact >= 0) return exact;

    const routeOnly = effective.findIndex((entry) => entry.route_ref.route.id === currentRouteId);
    return routeOnly >= 0 ? routeOnly : undefined;
  }

  function clearRetryTimer(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  }

  function computeNextRecoveryEvent(): number | undefined {
    let next: number | undefined;

    for (const until of routeCooldownUntil.values()) {
      if (!until || until <= now()) continue;
      if (!next || until < next) next = until;
    }

    if (cfg?.failover.return_to_preferred.enabled && nextReturnEligibleAtMs > now()) {
      if (!next || nextReturnEligibleAtMs < next) next = nextReturnEligibleAtMs;
    }

    return next;
  }

  function nextBackgroundCheckHint(): string {
    const next = computeNextRecoveryEvent();
    if (next && next > now()) return ` Next check in ${formatRetryWindow(next)}.`;
    return " We'll try again on the next idle check.";
  }

  function extractCodexAccountId(token: string): string | undefined {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;

      const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

      const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
      const claim = payload?.["https://api.openai.com/auth"];
      const accountId = claim?.chatgpt_account_id;
      return accountId ? String(accountId) : undefined;
    } catch {
      return undefined;
    }
  }

  function resolveCodexProbeUrl(baseUrl: string): string {
    const raw = String(baseUrl ?? "").trim() || "https://chatgpt.com/backend-api";
    const normalized = raw.replace(/\/+$/, "");
    if (normalized.endsWith("/codex/responses")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
  }

  function trimProbeMessage(message: string): string {
    const oneLine = String(message ?? "").replace(/\s+/g, " ").trim();
    if (!oneLine) return "unknown probe error";
    if (oneLine.length <= 180) return oneLine;
    return `${oneLine.slice(0, 177)}...`;
  }

  function classifyProbeException(error: unknown): { message: string; inconclusive: boolean } {
    const rawMessage = error instanceof Error ? error.message : String(error);
    let message = trimProbeMessage(rawMessage);

    const lower = message.toLowerCase();
    const errorName = error instanceof Error ? error.name.toLowerCase() : "";

    const inconclusive =
      errorName === "aborterror" ||
      lower.includes("operation was aborted") ||
      lower.includes("request was aborted") ||
      lower.includes("timeout") ||
      lower.includes("timed out");

    if (inconclusive && (
      lower.includes("operation was aborted") ||
      lower.includes("request was aborted") ||
      lower.includes("abort")
    )) {
      message = `probe timed out after ${Math.floor(RETURN_PROBE_TIMEOUT_MS / 1000)}s`;
    }

    return { message, inconclusive };
  }

  function applyOpenAIRouteHeaders(route: NormalizedRoute, headers: Headers): void {
    if (route.openai_org_id_env) {
      const org = process.env[route.openai_org_id_env];
      if (org && org.trim()) headers.set("OpenAI-Organization", org.trim());
    }

    if (route.openai_project_id_env) {
      const project = process.env[route.openai_project_id_env];
      if (project && project.trim()) headers.set("OpenAI-Project", project.trim());
    }
  }

  async function parseProbeFailureResponse(response: Response): Promise<string> {
    const rawText = (await response.text()).trim();
    if (!rawText) return `HTTP ${response.status}`;

    try {
      const parsed = JSON.parse(rawText);
      const msg =
        parsed?.error?.message ??
        parsed?.error?.details ??
        parsed?.message ??
        parsed?.detail ??
        rawText;
      return trimProbeMessage(`HTTP ${response.status}: ${String(msg)}`);
    } catch {
      return trimProbeMessage(`HTTP ${response.status}: ${rawText}`);
    }
  }

  async function runRouteProbeRequest(
    model: any,
    route: NormalizedRoute,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const api = String(model?.api ?? "").trim();
    const baseUrl = String(model?.baseUrl ?? "").trim().replace(/\/+$/, "");

    if (api === "openai-codex-responses") {
      const headers = new Headers(model?.headers ?? {});
      headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("OpenAI-Beta", "responses=experimental");
      headers.set("originator", "pi");
      headers.set("User-Agent", "pi-subswitch-probe");
      headers.set("accept", "application/json");
      headers.set("content-type", "application/json");

      const accountId = extractCodexAccountId(apiKey);
      if (accountId) headers.set("chatgpt-account-id", accountId);

      const body = {
        model: model.id,
        store: false,
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "health check" }] }],
        text: { verbosity: "low" },
      };

      return fetch(resolveCodexProbeUrl(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    }

    if (api === "openai-responses" || api === "openai-completions") {
      const headers = new Headers(model?.headers ?? {});
      headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("accept", "application/json");
      headers.set("content-type", "application/json");
      applyOpenAIRouteHeaders(route, headers);

      if (api === "openai-responses") {
        const body = {
          model: model.id,
          input: "health check",
          max_output_tokens: 1,
          store: false,
        };
        return fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
      }

      const body = {
        model: model.id,
        messages: [{ role: "user", content: "health check" }],
        max_tokens: 1,
        temperature: 0,
      };
      return fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    }

    if (api === "anthropic-messages") {
      const headers = new Headers(model?.headers ?? {});
      const isOauth = apiKey.includes("sk-ant-oat");

      headers.set("accept", "application/json");
      headers.set("content-type", "application/json");
      headers.set("anthropic-version", "2023-06-01");
      headers.set("anthropic-dangerous-direct-browser-access", "true");

      if (isOauth) {
        headers.set("Authorization", `Bearer ${apiKey}`);
        headers.set(
          "anthropic-beta",
          "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
        );
        headers.set("user-agent", "claude-cli/2.1.2 (external, cli)");
        headers.set("x-app", "cli");
      } else {
        headers.set("x-api-key", apiKey);
        headers.set(
          "anthropic-beta",
          "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
        );
      }

      const body: any = {
        model: model.id,
        max_tokens: 1,
        stream: false,
        messages: [{ role: "user", content: "health check" }],
      };

      if (isOauth) {
        body.system = [
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
        ];
      }

      const url = baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
      return fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    }

    throw new Error(`unsupported probe api '${api || "unknown"}'`);
  }

  async function probeRouteModel(
    ctx: any,
    ref: ResolvedRouteRef,
    modelId: string,
  ): Promise<RouteProbeResult> {
    const route = ref.route;
    const model = ctx.modelRegistry.find(route.provider_id, modelId);
    if (!model) {
      return {
        ok: false,
        message: `model unavailable for probe (${route.provider_id}/${modelId})`,
      };
    }

    let apiKey: string | undefined;
    if (route.auth_type === "api_key") {
      apiKey = resolveApiKey(route);
    } else {
      try {
        const key = await ctx.modelRegistry.getApiKey(model);
        apiKey = key ? String(key).trim() : undefined;
      } catch {
        apiKey = undefined;
      }
    }

    if (!apiKey) {
      return { ok: false, message: "missing credentials for probe" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RETURN_PROBE_TIMEOUT_MS);

    try {
      const response = await runRouteProbeRequest(model, route, apiKey, controller.signal);
      if (response.ok) return { ok: true };

      const message = await parseProbeFailureResponse(response);
      return {
        ok: false,
        message,
        retry_after_ms: parseRetryAfterMs(message),
      };
    } catch (error) {
      const classified = classifyProbeException(error);
      return {
        ok: false,
        message: classified.message,
        retry_after_ms: parseRetryAfterMs(classified.message),
        inconclusive: classified.inconclusive,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function probeFailureCooldownMs(
    vendorCfg: NormalizedVendor,
    route: NormalizedRoute,
    probe: RouteProbeResult,
  ): number {
    if (probe.retry_after_ms !== undefined && probe.retry_after_ms > 0) {
      return Math.max(
        RETURN_PROBE_MIN_COOLDOWN_MS,
        Math.min(probe.retry_after_ms + 5_000, RETURN_PROBE_MAX_COOLDOWN_MS),
      );
    }

    const configuredMs = routeDefaultCooldownMinutes(vendorCfg, route) * 60_000;
    return Math.max(
      RETURN_PROBE_MIN_COOLDOWN_MS,
      Math.min(configuredMs, RETURN_PROBE_MAX_COOLDOWN_MS),
    );
  }

  async function maybePromotePreferredRoute(ctx: any, reason: string): Promise<void> {
    if (!cfg?.enabled) return;
    if (!cfg.failover.return_to_preferred.enabled) return;
    if (!ctx.model?.id || !ctx.model?.provider) return;
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
    if (nextReturnEligibleAtMs > now()) return;

    const resolved = resolveVendorRouteForProvider(ctx.model.provider);
    if (!resolved) return;

    const currentRoute = getRoute(resolved.vendor, resolved.index);
    if (!currentRoute) return;

    const currentModelId = ctx.model.id;
    const effective = buildEffectivePreferenceStack(resolved.vendor, currentModelId);
    if (effective.length === 0) return;

    const currentIdx = findCurrentEffectiveStackIndex(effective, currentRoute.id, currentModelId);
    const bestIdx = effective.findIndex((entry) => routeEligibleRef(ctx, entry.route_ref, entry.model_id));
    if (bestIdx < 0) return;

    if (currentIdx !== undefined && bestIdx >= currentIdx) return;

    const target = effective[bestIdx];
    const targetVendorCfg = getVendor(target.route_ref.vendor);
    if (!targetVendorCfg) return;

    notifyDecision(
      ctx,
      "info",
      "return_probe",
      `Checking whether preferred route is healthy: ${routeDisplay(target.route_ref.vendor, target.route_ref.route)} (${target.model_id})…`,
      { reason },
    );

    const probe = await probeRouteModel(ctx, target.route_ref, target.model_id);
    if (!probe.ok) {
      if (probe.inconclusive) {
        const detail = probe.message ? ` (${probe.message})` : "";
        notifyDecision(
          ctx,
          "info",
          "return_probe",
          `Preferred route check was inconclusive${detail}. Trying a direct switch to ${routeDisplay(target.route_ref.vendor, target.route_ref.route)} (${target.model_id})…`,
          { reason: probe.message },
        );

        const switchedAfterInconclusiveProbe = await switchToRoute(
          ctx,
          target.route_ref.vendor,
          target.route_ref.index,
          target.model_id,
          `${reason} (probe inconclusive)`,
          false,
        );
        if (switchedAfterInconclusiveProbe) {
          notifyDecision(
            ctx,
            "info",
            "return_switch",
            `Successfully switched back to preferred route: ${routeDisplay(target.route_ref.vendor, target.route_ref.route)} (${target.model_id}).`,
            { reason },
          );
          return;
        }
      }

      const cooldownMs = probeFailureCooldownMs(
        targetVendorCfg,
        target.route_ref.route,
        probe,
      );
      const cooldownUntil = now() + cooldownMs;
      setRouteCooldownUntil(target.route_ref.vendor, target.route_ref.index, cooldownUntil);

      if (probe.inconclusive) {
        const reasonText = probe.message ? ` Last check: ${probe.message}.` : "";
        notifyDecision(
          ctx,
          "info",
          "return_stay",
          `Stayed on ${routeDisplay(resolved.vendor, currentRoute)} for now. Preferred route check was inconclusive and direct switch did not succeed. Next check in ${formatRetryWindow(cooldownUntil)}.${reasonText}`,
          {
            reason: probe.message,
            nextRetryAtMs: cooldownUntil,
          },
        );
      } else {
        const reasonText = probe.message ? ` Reason: ${probe.message}` : "";
        notifyDecision(
          ctx,
          "warning",
          "return_stay",
          `Preferred route still unavailable. Staying on ${routeDisplay(resolved.vendor, currentRoute)}. Next check in ${formatRetryWindow(cooldownUntil)}.${reasonText}`,
          {
            reason: probe.message,
            nextRetryAtMs: cooldownUntil,
          },
        );
      }

      scheduleRetryTimer(ctx);
      updateStatus(ctx);
      return;
    }

    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      return;
    }

    notifyDecision(
      ctx,
      "info",
      "return_probe",
      `Preferred route is healthy again. Switching to ${routeDisplay(target.route_ref.vendor, target.route_ref.route)} (${target.model_id}).`,
      { reason },
    );

    const switched = await switchToRoute(
      ctx,
      target.route_ref.vendor,
      target.route_ref.index,
      target.model_id,
      reason,
      true,
    );

    if (!switched) {
      notifyDecision(
        ctx,
        "warning",
        "return_stay",
        `Preferred route looks healthy, but switching failed. Staying on ${routeDisplay(resolved.vendor, currentRoute)}.${nextBackgroundCheckHint()}`,
        { reason },
      );
    }
  }

  function requestBackgroundPreferredRouteCheck(ctx: any, reason: string): void {
    if (!cfg?.enabled) return;
    if (!cfg.failover.return_to_preferred.enabled) return;
    if (promotionProbeInFlight) return;

    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;

    promotionProbeInFlight = true;
    void Promise.resolve(maybePromotePreferredRoute(ctx, reason))
      .catch(() => {
        // No-op: maybePromotePreferredRoute already emits user-facing diagnostics.
      })
      .finally(() => {
        promotionProbeInFlight = false;
        updateStatus(ctx);
      });
  }

  function scheduleRetryTimer(ctx: any): void {
    clearRetryTimer();

    const next = computeNextRecoveryEvent();
    if (!next) return;

    const delay = Math.max(1000, next - now());
    retryTimer = setTimeout(() => {
      retryTimer = undefined;

      const activeCtx = lastCtx ?? ctx;
      requestBackgroundPreferredRouteCheck(activeCtx, "cooldown expired");
      scheduleRetryTimer(activeCtx);
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

  function nearestPreferredCooldownHint(
    currentVendor: string,
    currentRouteId: string,
    currentModelId: string,
  ): string | undefined {
    const effective = buildEffectivePreferenceStack(currentVendor, currentModelId);
    if (effective.length === 0) return undefined;

    const currentIdx = findCurrentEffectiveStackIndex(effective, currentRouteId, currentModelId);
    if (currentIdx === undefined || currentIdx <= 0) return undefined;

    let nearestUntil: number | undefined;
    for (let i = 0; i < currentIdx; i++) {
      const candidate = effective[i];
      const until = getRouteCooldownUntil(candidate.route_ref.vendor, candidate.route_ref.index);
      if (!until || until <= now()) continue;
      if (!nearestUntil || until < nearestUntil) nearestUntil = until;
    }

    if (!nearestUntil) return undefined;

    return `preferred retry ${formatRetryWindow(nearestUntil)}`;
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
      ctx.ui.setStatus(EXT, ctx.ui.theme.fg("muted", `${EXT_LABEL}:`) + " " + provider + "/" + modelId);
      return;
    }

    const route = getRoute(resolved.vendor, resolved.index);
    if (!route) {
      ctx.ui.setStatus(EXT, ctx.ui.theme.fg("muted", `${EXT_LABEL}:`) + " " + provider + "/" + modelId);
      return;
    }

    let state = "ready";
    let cooldownUntil: number | undefined;

    if (isRouteCoolingDown(resolved.vendor, resolved.index)) {
      cooldownUntil = getRouteCooldownUntil(resolved.vendor, resolved.index);
      state = "cooldown";
    } else if (!routeCanHandleModel(ctx, route, modelId)) {
      state = "model_unavailable";
    } else if (!routeHasUsableCredentials(resolved.vendor, route)) {
      state = "missing_credentials";
    }

    const stateText = humanReadableRouteState(state, cooldownUntil);
    let stateDisplay = stateText;
    if (stateText === "ready") {
      stateDisplay = ctx.ui.theme.fg("success", stateText);
    } else if (
      stateText.startsWith("cooling down") ||
      stateText === "waiting for current /model" ||
      stateText === "context too large for target model"
    ) {
      stateDisplay = ctx.ui.theme.fg("warning", stateText);
    } else if (stateText === "model unavailable" || stateText === "credentials needed") {
      stateDisplay = ctx.ui.theme.fg("error", stateText);
    }

    let msg = ctx.ui.theme.fg("muted", `${EXT_LABEL}:`);
    msg += " " + ctx.ui.theme.fg(route.auth_type === "oauth" ? "accent" : "warning", route.auth_type === "oauth" ? "sub" : "api");
    msg += " " + ctx.ui.theme.fg("dim", `${resolved.vendor}/${route.label}`);
    msg += " " + ctx.ui.theme.fg("dim", modelId);
    msg += " " + stateDisplay;

    const hint = nearestPreferredCooldownHint(resolved.vendor, route.id, modelId);
    if (hint) msg += " " + ctx.ui.theme.fg("dim", `(${hint})`);

    ctx.ui.setStatus(EXT, msg);
  }

  function buildStatusLines(ctx: any, detailed = false, colorize = false): string[] {
    if (!cfg) return ["(no config loaded)"];

    const lines: string[] = [];

    const paint = (color: string, text: string): string => {
      if (!colorize || !ctx.hasUI) return text;
      return ctx.ui.theme.fg(color as any, text);
    };

    const paintAuthType = (authType: AuthType): string => {
      if (authType === "oauth") return paint("accent", "oauth");
      return paint("warning", "api_key");
    };

    const paintState = (state: string, cooldownUntilMs?: number): string => {
      const text = humanReadableRouteState(state, cooldownUntilMs);
      if (text === "ready") return paint("success", text);
      if (
        text.startsWith("cooling down") ||
        text === "waiting for current /model" ||
        text === "context too large for target model"
      ) {
        return paint("warning", text);
      }
      if (text === "model unavailable" || text === "credentials needed") {
        return paint("error", text);
      }
      return text;
    };

    const renderRoute = (
      vendor: string,
      route: { auth_type: AuthType; label: string },
    ): string => {
      if (!colorize || !ctx.hasUI) return routeDisplay(vendor, route);
      return `${paint("dim", vendor)} · ${paintAuthType(route.auth_type)} · ${paint("dim", decode(route.label))}`;
    };

    const currentProvider = ctx.model?.provider;
    const currentModel = ctx.model?.id;
    const currentResolved = currentProvider
      ? resolveVendorRouteForProvider(currentProvider)
      : undefined;
    const currentRoute = currentResolved
      ? getRoute(currentResolved.vendor, currentResolved.index)
      : undefined;

    if (detailed) {
      lines.push(`${EXT_NOTIFY} enabled=${cfg.enabled} default_vendor=${cfg.default_vendor}`);
      lines.push(
        `failover scope=${cfg.failover.scope} return_to_preferred=${cfg.failover.return_to_preferred.enabled} stable=${cfg.failover.return_to_preferred.min_stable_minutes}m triggers(rate_limit=${cfg.failover.triggers.rate_limit},quota=${cfg.failover.triggers.quota_exhausted},auth=${cfg.failover.triggers.auth_error})`,
      );

      if (nextReturnEligibleAtMs > now()) {
        lines.push(paint("warning", `return holdoff: ${formatRetryWindow(nextReturnEligibleAtMs)}`));
      }

      if (currentProvider && currentModel) {
        lines.push(`current_model=${currentProvider}/${currentModel}`);
      }
    }

    lines.push(paint("accent", "preference_stack:"));
    for (let i = 0; i < cfg.preference_stack.length; i++) {
      const entry = cfg.preference_stack[i];
      const ref = resolveRouteById(entry.route_id);
      if (!ref) {
        lines.push(`  ${i + 1}. ${paint("error", `[missing route_id=${entry.route_id}]`)}`);
        continue;
      }

      const modelId = entry.model ?? currentModel;

      const isActive =
        currentRoute !== undefined &&
        currentRoute.id === ref.route.id &&
        (entry.model === undefined || entry.model === currentModel);

      let state = "ready";
      let cooldownUntil: number | undefined;
      if (!modelId) {
        state = "waiting_for_current_model";
      } else if (isRouteCoolingDown(ref.vendor, ref.index)) {
        state = "cooldown";
        cooldownUntil = getRouteCooldownUntil(ref.vendor, ref.index);
      } else if (!routeCanHandleModel(ctx, ref.route, modelId)) {
        state = "model_unavailable";
      } else if (!routeHasUsableCredentials(ref.vendor, ref.route)) {
        state = "missing_credentials";
      } else if (!isActive && !contextFitForRouteModel(ctx, ref.route, modelId).fits) {
        state = "context_too_large";
      }

      const activeMark = isActive ? paint("success", "*") : " ";
      const stateDisplay = paintState(state, cooldownUntil);
      if (detailed) {
        const modelOverridePart = entry.model ? `, model_override=${entry.model}` : "";
        lines.push(
          `  ${activeMark} ${i + 1}. ${renderRoute(ref.vendor, ref.route)} (id=${ref.route.id}, provider=${ref.route.provider_id}${modelOverridePart}, ${stateDisplay})`,
        );
      } else {
        lines.push(
          `  ${activeMark} ${i + 1}. ${renderRoute(ref.vendor, ref.route)} (${stateDisplay})`,
        );
      }
    }

    if (detailed) {
      for (const v of cfg.vendors) {
        lines.push(paint("accent", `vendor ${v.vendor}:`));
        for (let i = 0; i < v.routes.length; i++) {
          const route = v.routes[i];
          const active =
            activeRouteIndexByVendor.get(v.vendor) === i
              ? paint("success", "*")
              : " ";
          const routeState = isRouteCoolingDown(v.vendor, i) ? "cooldown" : "ready";
          const cooldownUntil =
            routeState === "cooldown" ? getRouteCooldownUntil(v.vendor, i) : undefined;
          lines.push(
            `  ${active} ${i + 1}. ${paintAuthType(route.auth_type)} ${paint("dim", decode(route.label))} (id=${route.id}, provider=${route.provider_id}, ${paintState(routeState, cooldownUntil)})`,
          );
        }
      }
    }

    return lines;
  }

  function notifyStatus(ctx: any, detailed = false): void {
    if (!ctx.hasUI) return;
    ctx.ui.notify(buildStatusLines(ctx, detailed, true).join("\n"), "info");
  }

  function notifyExplain(ctx: any): void {
    if (!ctx.hasUI) return;
    ctx.ui.notify(buildExplainLines(ctx).join("\n"), "info");
  }

  function notifyEvents(ctx: any, limit = DECISION_EVENT_DEFAULT_LIMIT): void {
    if (!ctx.hasUI) return;
    ctx.ui.notify(buildDecisionEventLines(limit).join("\n"), "info");
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
        ctx.ui.notify(`${EXT_NOTIFY} OAuth providers already authenticated`, "info");
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
        `${EXT_NOTIFY} Prefilled /login. After each login, run /subswitch login-status.`,
        "warning",
      );
    } else {
      ctx.ui.notify(
        `${EXT_NOTIFY} Reminder saved. Run /subswitch login to resume OAuth login flow.`,
        "info",
      );
    }
  }

  function extractTextFromContent(content: any): string {
    if (content === undefined || content === null) return "";
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") return item;
          if (!item || typeof item !== "object") return "";
          if (item.type === "text" && typeof item.text === "string") return item.text;
          if (typeof item.text === "string") return item.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    if (typeof content === "object") {
      if (typeof content.text === "string") return content.text;
      if (typeof content.content === "string") return content.content;
    }

    return String(content);
  }

  function extractMessageText(message: any): string {
    if (!message || typeof message !== "object") return "";

    const textFromContent = extractTextFromContent(message.content);
    if (textFromContent.trim()) return textFromContent.trim();

    const textFallback = [
      message.text,
      message.summary,
      message.errorMessage,
      message.error,
      message.details?.error,
    ]
      .map((v) => (v ? String(v) : ""))
      .filter(Boolean)
      .join("\n")
      .trim();

    return textFallback;
  }

  function buildContinuationTranscript(branchEntries: any[]): string {
    const lines: string[] = [];

    for (const entry of branchEntries) {
      if (!entry || entry.type !== "message") continue;
      const msg = entry.message;
      const role = String(msg?.role ?? "").trim();
      if (!role || (role !== "user" && role !== "assistant" && role !== "system")) continue;

      const text = extractMessageText(msg);
      if (!text) continue;

      lines.push(`[${role}] ${text}`);
    }

    if (lines.length === 0) return "";

    const cappedLines = lines.slice(-800);
    return cappedLines.join("\n\n");
  }

  function splitTranscriptIntoChunks(text: string): string[] {
    const normalized = String(text ?? "").trim();
    if (!normalized) return [];

    const lines = normalized.split("\n");
    const chunks: string[] = [];

    let currentLines: string[] = [];
    let currentChars = 0;

    const flush = () => {
      if (currentLines.length === 0) return;
      chunks.push(currentLines.join("\n"));
      currentLines = [];
      currentChars = 0;
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const lineChars = line.length + 1;
      const wouldOverflowChars = currentChars + lineChars > CONTINUATION_CHUNK_CHARS;
      const wouldOverflowLines = currentLines.length >= CONTINUATION_MAX_LINES_PER_CHUNK;

      if (currentLines.length > 0 && (wouldOverflowChars || wouldOverflowLines)) {
        flush();
        if (chunks.length >= CONTINUATION_MAX_CHUNKS) break;
      }

      currentLines.push(line);
      currentChars += lineChars;

      if (chunks.length >= CONTINUATION_MAX_CHUNKS) break;
    }

    flush();

    if (chunks.length > CONTINUATION_MAX_CHUNKS) {
      return chunks.slice(0, CONTINUATION_MAX_CHUNKS);
    }

    return chunks;
  }

  function latestCompactionSummary(branchEntries: any[]): string | undefined {
    for (let i = branchEntries.length - 1; i >= 0; i--) {
      const entry = branchEntries[i];
      if (entry?.type !== "compaction") continue;
      const summary = String(entry.summary ?? "").trim();
      if (summary) return summary;
    }
    return undefined;
  }

  function latestAssistantMessageText(branchEntries: any[]): string | undefined {
    for (let i = branchEntries.length - 1; i >= 0; i--) {
      const entry = branchEntries[i];
      if (entry?.type !== "message") continue;
      const msg = entry.message;
      if (String(msg?.role ?? "") !== "assistant") continue;
      const text = extractMessageText(msg).trim();
      if (text) return text;
    }
    return undefined;
  }

  function buildHeuristicContinuationSummary(ctx: any): string {
    const branch = ctx.sessionManager.getBranch();
    const compaction = latestCompactionSummary(branch);
    const transcript = buildContinuationTranscript(branch);
    const recentLines = transcript
      ? transcript.split("\n").slice(-80).join("\n")
      : "(no recent transcript available)";

    const promptText = lastPrompt?.text?.trim() || "(no captured pending user prompt)";

    const parts = [
      "Carryover context (heuristic fallback):",
      "",
      `- Current model: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`,
      `- Last user prompt: ${promptText}`,
      "",
      "Most recent compaction summary:",
      compaction ? compaction : "(none)",
      "",
      "Recent transcript excerpt:",
      recentLines,
    ];

    return parts.join("\n");
  }

  function requireContinuationCapabilities(ctx: any): { ok: boolean; message?: string } {
    if (typeof ctx.newSession !== "function") {
      return { ok: false, message: "newSession() is unavailable in this context" };
    }
    if (typeof ctx.switchSession !== "function") {
      return { ok: false, message: "switchSession() is unavailable in this context" };
    }
    if (typeof ctx.waitForIdle !== "function") {
      return { ok: false, message: "waitForIdle() is unavailable in this context" };
    }
    return { ok: true };
  }

  async function summarizeWithTargetRouteInTempSession(
    ctx: any,
    target: ContinuationTarget,
    prompt: string,
    label: string,
  ): Promise<ContinuationSummaryResult> {
    const capabilities = requireContinuationCapabilities(ctx);
    if (!capabilities.ok) {
      return { ok: false, message: capabilities.message };
    }

    const originalSessionPath = ctx.sessionManager.getSessionFile();
    if (!originalSessionPath) {
      return { ok: false, message: "unable to determine original session path" };
    }

    const created = await ctx.newSession();
    if (created?.cancelled) {
      return { ok: false, message: "temporary summarization session cancelled" };
    }

    try {
      const switched = await switchToRoute(
        ctx,
        target.vendor,
        target.routeIndex,
        target.modelId,
        `${label} (temp summary session)`,
        false,
      );
      if (!switched) {
        return {
          ok: false,
          message: `could not switch temporary session to ${target.route.provider_id}/${target.modelId}`,
        };
      }

      pi.sendUserMessage(prompt);
      await ctx.waitForIdle();

      const summary = latestAssistantMessageText(ctx.sessionManager.getBranch());
      if (!summary) {
        return { ok: false, message: "no assistant summary generated in temporary session" };
      }

      return { ok: true, summary };
    } finally {
      await ctx.switchSession(originalSessionPath);
    }
  }

  async function generateContinuationSummary(
    ctx: any,
    target: ContinuationTarget,
  ): Promise<ContinuationSummaryResult> {
    const branch = ctx.sessionManager.getBranch();
    const transcript = buildContinuationTranscript(branch);

    if (!transcript) {
      return {
        ok: true,
        summary: buildHeuristicContinuationSummary(ctx),
      };
    }

    const chunks = splitTranscriptIntoChunks(transcript);
    if (chunks.length === 0) {
      return {
        ok: true,
        summary: buildHeuristicContinuationSummary(ctx),
      };
    }

    const partials: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const prompt = [
        "You are preparing carryover context for a failover continuation session.",
        "Summarize this transcript chunk with short sections:",
        "- Open tasks",
        "- Key decisions",
        "- Constraints and preferences",
        "- Important files and commands",
        "- Current user intent",
        "Keep it concise and factual. Do not invent details.",
        "",
        `<chunk index='${i + 1}' total='${chunks.length}'>`,
        chunk,
        "</chunk>",
      ].join("\n");

      const result = await summarizeWithTargetRouteInTempSession(
        ctx,
        target,
        prompt,
        `chunk-${i + 1}`,
      );
      if (!result.ok || !result.summary) {
        return {
          ok: false,
          message: result.message ?? "chunk summarization failed",
        };
      }

      partials.push(result.summary);
    }

    const mergePrompt = [
      "Merge these partial carryover summaries into one compact continuation summary.",
      "Preserve factual details and unresolved tasks. Remove duplicates.",
      "Required sections:",
      "- Open tasks",
      "- Key decisions",
      "- Constraints and preferences",
      "- Important files and commands",
      "- Current user intent",
      "",
      partials.map((s, i) => `<partial index='${i + 1}'>\n${s}\n</partial>`).join("\n\n"),
    ].join("\n");

    const merged = await summarizeWithTargetRouteInTempSession(
      ctx,
      target,
      mergePrompt,
      "merge",
    );

    if (!merged.ok || !merged.summary) {
      return {
        ok: false,
        message: merged.message ?? "merge summarization failed",
      };
    }

    return { ok: true, summary: merged.summary };
  }

  function resolveContinuationTarget(
    ctx: any,
    vendor?: string,
    authType?: AuthType,
    label?: string,
    modelId?: string,
  ): ContinuationTarget | undefined {
    ensureCfg(ctx);

    if (vendor && authType && label) {
      const idx = findRouteIndex(vendor, authType, label);
      if (idx === undefined) return undefined;
      const route = getRoute(vendor, idx);
      const targetModel = modelId ?? ctx.model?.id;
      if (!route || !targetModel) return undefined;
      return {
        vendor,
        routeIndex: idx,
        route,
        modelId: targetModel,
      };
    }

    const currentProvider = ctx.model?.provider;
    const currentModel = ctx.model?.id;
    const currentResolved = currentProvider
      ? resolveVendorRouteForProvider(currentProvider)
      : undefined;

    const effective = buildEffectivePreferenceStack(currentResolved?.vendor, currentModel);
    for (const entry of effective) {
      if (!entry.route_ref.route || !entry.model_id) continue;
      if (currentResolved && entry.route_ref.route.id === getRoute(currentResolved.vendor, currentResolved.index)?.id) {
        continue;
      }

      return {
        vendor: entry.route_ref.vendor,
        routeIndex: entry.route_ref.index,
        route: entry.route_ref.route,
        modelId: entry.model_id,
      };
    }

    if (currentResolved && currentModel) {
      const route = getRoute(currentResolved.vendor, currentResolved.index);
      if (route) {
        return {
          vendor: currentResolved.vendor,
          routeIndex: currentResolved.index,
          route,
          modelId: currentModel,
        };
      }
    }

    return undefined;
  }

  async function runContinuationFallback(
    ctx: any,
    target: ContinuationTarget,
  ): Promise<{ ok: boolean; message: string }> {
    const capabilities = requireContinuationCapabilities(ctx);
    if (!capabilities.ok) {
      return { ok: false, message: capabilities.message ?? "continuation helpers unavailable" };
    }

    notifyDecision(
      ctx,
      "info",
      "continuation",
      `Starting continuation fallback on ${routeDisplay(target.vendor, target.route)} (${target.modelId})…`,
    );

    const summaryResult = await generateContinuationSummary(ctx, target);
    const continuationSummary = summaryResult.ok && summaryResult.summary
      ? summaryResult.summary
      : buildHeuristicContinuationSummary(ctx);

    if (!summaryResult.ok) {
      notifyDecision(
        ctx,
        "warning",
        "continuation",
        "Map-reduce continuation summary failed; falling back to heuristic carryover summary.",
        { reason: summaryResult.message },
      );
    }

    const created = await ctx.newSession();
    if (created?.cancelled) {
      return { ok: false, message: "continuation session creation cancelled" };
    }

    const switched = await switchToRoute(
      ctx,
      target.vendor,
      target.routeIndex,
      target.modelId,
      "continuation fallback",
      false,
    );

    if (!switched) {
      return {
        ok: false,
        message: `continuation session created but switch failed for ${target.route.provider_id}/${target.modelId}`,
      };
    }

    const summaryIntro = [
      "Continuation context imported from previous session after failover.",
      "Use this as carryover state and continue naturally.",
      "",
      `<carryover_summary>\n${continuationSummary}\n</carryover_summary>`,
    ].join("\n");

    pi.sendMessage(
      {
        customType: `${EXT}-continuation-carryover`,
        content: summaryIntro,
        display: true,
        details: {
          source: "subswitch_continuation",
          target_provider: target.route.provider_id,
          target_model: target.modelId,
        },
      },
      { triggerTurn: false },
    );

    const latestPrompt = lastPrompt?.text?.trim();
    if (latestPrompt) {
      const content =
        !lastPrompt.images || lastPrompt.images.length === 0
          ? latestPrompt
          : [{ type: "text", text: latestPrompt }, ...lastPrompt.images];
      pi.sendUserMessage(content);
    }

    notifyDecision(
      ctx,
      "info",
      "continuation",
      `Continuation session ready on ${routeDisplay(target.vendor, target.route)} (${target.modelId}).${latestPrompt ? " Resent your latest prompt." : ""}`,
    );

    return {
      ok: true,
      message: `Continuation session started on ${target.route.provider_id}/${target.modelId}`,
    };
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
      if (notify) {
        notifyDecision(
          ctx,
          "warning",
          switchDecisionKind(reason, false),
          `Route cannot serve model ${modelId}: ${routeDisplay(vendor, route)}`,
          { reason },
        );
      }
      return false;
    }

    if (route.auth_type === "api_key") {
      const ok = applyApiRouteCredentials(vendor, route);
      if (!ok) {
        if (notify) {
          notifyDecision(
            ctx,
            "warning",
            switchDecisionKind(reason, false),
            `Missing API key material for ${routeDisplay(vendor, route)} (check api_key_env/api_key_path/api_key)`,
            { reason },
          );
        }
        return false;
      }
    }

    const model = ctx.modelRegistry.find(route.provider_id, modelId);
    if (!model) {
      if (notify) {
        notifyDecision(
          ctx,
          "warning",
          switchDecisionKind(reason, false),
          `No model ${route.provider_id}/${modelId} (${reason})`,
          { reason },
        );
      }
      return false;
    }

    let fit = contextFitForRouteModel(ctx, route, modelId);
    if (!fit.fits) {
      const compactingMessage =
        `Cannot switch yet to ${routeDisplay(vendor, route)} (${modelId}): ${contextFitSummary(fit)}. Compacting current session first…`;
      if (notify) {
        notifyDecision(ctx, "info", "compaction", compactingMessage, { reason });
      }

      const compactResult = await runSwitchCompaction(ctx, route, modelId);
      if (!compactResult.ok) {
        if (notify) {
          const reasonText = compactResult.message ? ` Reason: ${compactResult.message}` : "";
          notifyDecision(
            ctx,
            "warning",
            "compaction",
            `Could not compact session before switching to ${routeDisplay(vendor, route)}.${reasonText}`,
            { reason },
          );
        }
        return false;
      }

      fit = contextFitForRouteModel(ctx, route, modelId);
      if (!fit.fits) {
        if (notify) {
          notifyDecision(
            ctx,
            "warning",
            "compaction",
            `Still cannot switch to ${routeDisplay(vendor, route)} (${modelId}) after compaction: ${contextFitSummary(fit)}.`,
            { reason },
          );
        }
        return false;
      }

      if (notify) {
        notifyDecision(
          ctx,
          "info",
          "compaction",
          `Compaction complete. Retrying switch to ${routeDisplay(vendor, route)} (${modelId}).`,
          { reason },
        );
      }
    }

    pendingExtensionSwitch = { provider: route.provider_id, modelId };

    let ok = false;
    try {
      ok = await pi.setModel(model);
    } finally {
      if (!ok) pendingExtensionSwitch = undefined;
    }

    if (!ok) {
      if (notify) {
        notifyDecision(
          ctx,
          "warning",
          switchDecisionKind(reason, false),
          `Missing credentials for ${route.provider_id}/${modelId} (${reason})`,
          { reason },
        );
      }
      return false;
    }

    activeVendor = vendor;
    activeRouteIndexByVendor.set(vendor, routeIndex);
    managedModelId = modelId;

    if (notify) {
      notifyDecision(
        ctx,
        "info",
        switchDecisionKind(reason, true),
        `Switched to ${routeDisplay(vendor, route)} (${route.provider_id}/${modelId})`,
        { reason },
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
      if (ctx.hasUI) ctx.ui.notify(`${EXT_NOTIFY} Unknown vendor '${vendor}'`, "warning");
      return false;
    }

    const idx = findRouteIndex(vendor, authType, label);
    if (idx === undefined) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${EXT_NOTIFY} No route '${label}' with auth_type='${authType}' for vendor '${vendor}'`,
          "warning",
        );
      }
      return false;
    }

    const targetModelId = modelId ?? ctx.model?.id;
    if (!targetModelId) {
      if (ctx.hasUI) {
        ctx.ui.notify(`${EXT_NOTIFY} No current model selected; specify model id explicitly`, "warning");
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
      if (ctx.hasUI) ctx.ui.notify(`${EXT_NOTIFY} Unknown vendor '${vendor}'`, "warning");
      return false;
    }

    const targetModelId = modelId ?? ctx.model?.id;
    if (!targetModelId) {
      if (ctx.hasUI) {
        ctx.ui.notify(`${EXT_NOTIFY} No current model selected; specify model id explicitly`, "warning");
      }
      return false;
    }

    let idx: number | undefined;

    if (label) {
      idx = findRouteIndex(vendor, authType, label);
      if (idx === undefined) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `${EXT_NOTIFY} No ${authType} route '${label}' for vendor '${vendor}'`,
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
            `${EXT_NOTIFY} No eligible ${authType} route for vendor '${vendor}' and model '${targetModelId}'`,
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
    if (!v || !cfg) return false;

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

    // Keep preference stack aligned with explicit route preference operations.
    const matching = cfg.preference_stack.filter((entry) => entry.route_id === picked.id);
    const rest = cfg.preference_stack.filter((entry) => entry.route_id !== picked.id);
    cfg.preference_stack = matching.length > 0 ? [...matching, ...rest] : [{ route_id: picked.id }, ...rest];

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
    statePath = statePathForConfigPath(ctx.cwd, path);
    pruneRuntimeState();
    persistRuntimeState();
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
      if (ctx.hasUI) ctx.ui.notify(`${EXT_NOTIFY} Unknown vendor '${vendor}'`, "warning");
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
        `${EXT_NOTIFY} Compatible models for vendor '${vendor}' across ${v.routes.length} routes: ${
          models.length > 0 ? models.join(", ") : "(none)"
        }`,
        models.length > 0 ? "info" : "warning",
      );
    }
  }

  async function reorderVendorInteractive(ctx: any, vendorArg?: string): Promise<void> {
    ensureCfg(ctx);
    if (!ctx.hasUI || !cfg) {
      return;
    }

    const filterVendor = vendorArg ? vendorForCommand(ctx, vendorArg) : undefined;

    const indexed = cfg.preference_stack
      .map((entry, index) => ({ index, entry, ref: resolveRouteById(entry.route_id) }))
      .filter((x) => Boolean(x.ref))
      .filter((x) => !filterVendor || x.ref!.vendor === filterVendor);

    if (indexed.length < 2) {
      const scope = filterVendor ? `for vendor '${filterVendor}'` : "";
      ctx.ui.notify(`${EXT_NOTIFY} Need at least 2 stack entries ${scope} to reorder`, "warning");
      return;
    }

    const labels = indexed.map((x, i) => {
      const ref = x.ref!;
      const model = x.entry.model ?? "current";
      return `${i + 1}. ${routeDisplay(ref.vendor, ref.route)} model=${model}`;
    });

    const fromChoice = await ctx.ui.select("Move which preference stack entry?", labels);
    if (!fromChoice) return;

    const fromLocal = labels.indexOf(fromChoice);
    if (fromLocal < 0) return;

    const toChoice = await ctx.ui.select("Move to which position?", labels);
    if (!toChoice) return;

    const toLocal = labels.indexOf(toChoice);
    if (toLocal < 0 || toLocal === fromLocal) return;

    const fromGlobal = indexed[fromLocal].index;
    const toGlobal = indexed[toLocal].index;

    const [picked] = cfg.preference_stack.splice(fromGlobal, 1);
    cfg.preference_stack.splice(toGlobal, 0, picked);

    const savePath = saveCurrentConfig(ctx);
    ctx.ui.notify(
      `${EXT_NOTIFY} Reordered preference stack${filterVendor ? ` for '${filterVendor}'` : ""}. Saved to ${savePath}`,
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
      ctx.ui.notify(`${EXT_NOTIFY} Invalid JSON: ${String(e)}`, "error");
      return;
    }

    const normalized = normalizeConfig(parsed);
    if (normalized.vendors.length === 0) {
      ctx.ui.notify(`${EXT_NOTIFY} Config must define at least one vendor with routes`, "error");
      return;
    }

    writeJson(path, configToJson(normalized));
    cfg = normalized;
    registerAliasesFromConfig(cfg);

    ctx.ui.notify(`${EXT_NOTIFY} Saved config to ${path}`, "info");
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

    ctx.ui.notify(`${EXT_NOTIFY} Starting setup wizard…`, "info");
    ctx.ui.notify(
      `${EXT_NOTIFY} Changes are applied only when you finish setup. Cancel keeps current config.`,
      "info",
    );

    type WizardNav = "ok" | "back" | "cancel";

    async function inputWithBack(
      title: string,
      currentValue: string,
      options?: { allowEmpty?: boolean },
    ): Promise<{ nav: WizardNav; value?: string }> {
      const shownValue = String(currentValue ?? "");
      const currentDisplay = shownValue.trim() ? shownValue : "(empty)";
      const raw = await ctx.ui.input(
        `${title}\nCurrent: ${currentDisplay}\nPress Enter to keep current value.\nType /back to go to previous screen`,
        shownValue,
      );
      if (raw === undefined) return { nav: "cancel" };

      const trimmed = raw.trim();
      if (trimmed.toLowerCase() === "/back") return { nav: "back" };

      if (!options?.allowEmpty && trimmed === "") {
        return { nav: "ok", value: shownValue };
      }

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
      const existingRouteIdByKey = new Map<string, string>();
      for (const route of existingRoutes) {
        const authType = route.auth_type === "api_key" ? "api_key" : "oauth";
        const label = String(route.label ?? "").trim();
        if (!label) continue;

        if (route.id && String(route.id).trim()) {
          existingRouteIdByKey.set(`${authType}::${label.toLowerCase()}`, String(route.id).trim());
        }

        if (route.auth_type !== "api_key") continue;
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
            const key = `oauth::${label.toLowerCase()}`;
            routes.push({
              id: existingRouteIdByKey.get(key),
              auth_type: "oauth",
              label,
              provider_id: generateOauthProviderId(vendor, label),
            });
          }

          for (const label of apiLabels) {
            const key = `api_key::${label.toLowerCase()}`;
            routes.push({
              id: existingRouteIdByKey.get(key),
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
          `${vendorTitle} route order (first = preferred within vendor):\n${summary}`,
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

    let targetPath = preferredWritableConfigPath(ctx.cwd);
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
          id: r.id,
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
          id: r.id,
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

    let defaultVendorChoice = existingCfg.default_vendor;
    let failoverScope: FailoverScope = existingCfg.failover.scope;
    let returnEnabled = existingCfg.failover.return_to_preferred.enabled;
    let returnStableMinutes = existingCfg.failover.return_to_preferred.min_stable_minutes;
    let triggerRateLimit = existingCfg.failover.triggers.rate_limit;
    let triggerQuota = existingCfg.failover.triggers.quota_exhausted;
    let triggerAuth = existingCfg.failover.triggers.auth_error;
    let preferenceStackDraft: PreferenceStackEntryConfig[] = existingCfg.preference_stack.map((entry) => ({
      route_id: entry.route_id,
      model: entry.model,
    }));

    function draftVendorList(): VendorConfig[] {
      return Array.from(vendorConfigs.values());
    }

    function buildDraftNormalized(defaultVendor: string): NormalizedConfig {
      return normalizeConfig({
        enabled: true,
        default_vendor: defaultVendor,
        vendors: draftVendorList(),
        rate_limit_patterns: cfg?.rate_limit_patterns ?? [],
        failover: {
          scope: failoverScope,
          return_to_preferred: {
            enabled: returnEnabled,
            min_stable_minutes: returnStableMinutes,
          },
          triggers: {
            rate_limit: triggerRateLimit,
            quota_exhausted: triggerQuota,
            auth_error: triggerAuth,
          },
        },
        preference_stack: preferenceStackDraft,
      });
    }

    function previewRouteLabel(preview: NormalizedConfig, routeId: string): string {
      for (const v of preview.vendors) {
        for (const route of v.routes) {
          if (route.id === routeId) {
            return `${routeDisplay(v.vendor, route)} [${route.id}]`;
          }
        }
      }
      return `[missing route_id=${routeId}]`;
    }

    async function configurePreferenceStack(defaultVendor: string): Promise<WizardNav> {
      while (true) {
        const preview = buildDraftNormalized(defaultVendor);
        preferenceStackDraft = preview.preference_stack.map((entry) => ({
          route_id: entry.route_id,
          model: entry.model,
        }));

        const summary = preview.preference_stack
          .map(
            (entry, i) =>
              `${i + 1}. ${previewRouteLabel(preview, entry.route_id)} model=${entry.model ?? "current"}`,
          )
          .join("\n");

        const choice = await ctx.ui.select(
          `Preference stack (top is most preferred):\n${summary}`,
          [
            "Keep stack",
            "Move entry",
            "Set model override",
            "Reset recommended",
            "← Back",
            "Cancel",
          ],
        );

        if (!choice || choice === "Cancel") return "cancel";
        if (choice === "← Back") return "back";
        if (choice === "Keep stack") return "ok";

        if (choice === "Reset recommended") {
          preferenceStackDraft = [];
          continue;
        }

        const entryOptions = preview.preference_stack.map(
          (entry, i) =>
            `${i + 1}. ${previewRouteLabel(preview, entry.route_id)} model=${entry.model ?? "current"}`,
        );

        if (choice === "Move entry") {
          if (entryOptions.length < 2) {
            ctx.ui.notify(`${EXT_NOTIFY} Need at least 2 entries to reorder`, "warning");
            continue;
          }

          const fromChoice = await ctx.ui.select("Move which stack entry?", [
            ...entryOptions,
            "← Back",
            "Cancel",
          ]);
          if (!fromChoice || fromChoice === "Cancel") return "cancel";
          if (fromChoice === "← Back") continue;

          const fromIndex = entryOptions.indexOf(fromChoice);
          if (fromIndex < 0) continue;

          const toChoice = await ctx.ui.select("Move to which position?", [
            ...entryOptions,
            "← Back",
            "Cancel",
          ]);
          if (!toChoice || toChoice === "Cancel") return "cancel";
          if (toChoice === "← Back") continue;

          const toIndex = entryOptions.indexOf(toChoice);
          if (toIndex < 0 || toIndex === fromIndex) continue;

          const [picked] = preferenceStackDraft.splice(fromIndex, 1);
          preferenceStackDraft.splice(toIndex, 0, picked);
          continue;
        }

        if (choice === "Set model override") {
          const targetChoice = await ctx.ui.select("Set model for which stack entry?", [
            ...entryOptions,
            "← Back",
            "Cancel",
          ]);
          if (!targetChoice || targetChoice === "Cancel") return "cancel";
          if (targetChoice === "← Back") continue;

          const targetIndex = entryOptions.indexOf(targetChoice);
          if (targetIndex < 0) continue;

          const currentModel = preferenceStackDraft[targetIndex]?.model ?? "";
          const modelRes = await inputWithBack(
            "Model override (type 'current' to clear override and follow /model)",
            currentModel,
          );
          if (modelRes.nav === "cancel") return "cancel";
          if (modelRes.nav === "back") continue;

          const trimmed = String(modelRes.value ?? "").trim();
          if (
            trimmed.toLowerCase() === "current" ||
            trimmed.toLowerCase() === "follow_current" ||
            trimmed.toLowerCase() === "none"
          ) {
            preferenceStackDraft[targetIndex] = {
              route_id: preferenceStackDraft[targetIndex].route_id,
            };
          } else if (trimmed) {
            preferenceStackDraft[targetIndex] = {
              ...preferenceStackDraft[targetIndex],
              model: trimmed,
            };
          }
        }
      }
    }

    function compatibleModelsForVendor(vendor: string): string[] {
      const v = getVendor(vendor);
      if (!v) return [];

      const available = (ctx.modelRegistry.getAvailable?.() ?? []) as any[];
      const byProvider = new Map<string, Set<string>>();

      for (const m of available) {
        const p = String(m?.provider ?? "");
        const id = String(m?.id ?? "");
        if (!p || !id) continue;
        if (!byProvider.has(p)) byProvider.set(p, new Set<string>());
        byProvider.get(p)?.add(id);
      }

      let intersection: Set<string> | undefined;
      for (const route of v.routes) {
        const ids = byProvider.get(route.provider_id) ?? new Set<string>();
        if (!intersection) {
          intersection = new Set(ids);
          continue;
        }

        for (const id of Array.from(intersection)) {
          if (!ids.has(id)) intersection.delete(id);
        }
      }

      return Array.from(intersection ?? []).sort();
    }

    type SetupValidationResult = {
      lines: string[];
      missingOauth: string[];
      missingApiRoutes: string[];
      missingApiEnvNames: string[];
      modelCompatible: boolean;
      compatibleModels: string[];
      contextBlocked: ResolvedPreferenceEntry | undefined;
      contextBlockedCount: number;
    };

    async function collectSetupValidation(
      defaultVendor: string,
    ): Promise<SetupValidationResult> {
      const lines: string[] = [`${EXT_NOTIFY} setup validation`];

      const currentModelId = String(ctx.model?.id ?? "").trim();
      const missingOauth = await missingOauthProviders(ctx, configuredOauthProviders());

      const missingApiRoutes: string[] = [];
      const missingApiEnvNames: string[] = [];
      for (const v of cfg?.vendors ?? []) {
        for (const route of v.routes) {
          if (route.auth_type !== "api_key") continue;
          const key = resolveApiKey(route);
          if (key) continue;

          const envName = String(route.api_key_env ?? "").trim();
          missingApiRoutes.push(
            `${routeDisplay(v.vendor, route)}${envName ? ` (env ${envName})` : ""}`,
          );
          if (envName) missingApiEnvNames.push(envName);
        }
      }

      let modelCompatible = false;
      if (currentModelId) {
        for (const v of cfg?.vendors ?? []) {
          for (const route of v.routes) {
            if (routeCanHandleModel(ctx, route, currentModelId)) {
              modelCompatible = true;
              break;
            }
          }
          if (modelCompatible) break;
        }
      }

      const compatibleModels = compatibleModelsForVendor(defaultVendor);

      let contextBlocked: ResolvedPreferenceEntry | undefined;
      let contextBlockedCount = 0;
      if (currentModelId) {
        const effective = buildEffectivePreferenceStack(defaultVendor, currentModelId);
        const selection = findNextEligibleFallback(ctx, effective, 0);
        contextBlocked = selection.first_context_blocked;
        contextBlockedCount = selection.context_blocked;
      }

      if (missingOauth.length > 0) {
        lines.push(`⚠ OAuth login missing for: ${missingOauth.join(", ")}`);
      } else {
        lines.push("✓ OAuth authentication looks good");
      }

      if (missingApiRoutes.length > 0) {
        lines.push(`⚠ API key material missing for: ${missingApiRoutes.join("; ")}`);
      } else {
        lines.push("✓ API key routes have credentials");
      }

      if (!currentModelId) {
        lines.push("⚠ No active model selected; run /model to choose one.");
      } else if (!modelCompatible) {
        const hint =
          compatibleModels.length > 0
            ? ` Try one of: ${compatibleModels.slice(0, 8).join(", ")}`
            : " No shared model found across configured routes.";
        lines.push(`⚠ Current model '${currentModelId}' is not compatible with configured routes.${hint}`);
      } else {
        lines.push(`✓ Current model '${currentModelId}' is compatible`);
      }

      if (contextBlockedCount > 0 && contextBlocked) {
        lines.push(
          `ℹ ${contextBlockedCount} preferred fallback route(s) are currently context-blocked (example: ${routeDisplay(contextBlocked.route_ref.vendor, contextBlocked.route_ref.route)} model=${contextBlocked.model_id}).`,
        );
      } else {
        lines.push("✓ No context-window block detected for current preference stack");
      }

      return {
        lines,
        missingOauth,
        missingApiRoutes,
        missingApiEnvNames,
        modelCompatible: Boolean(currentModelId) && modelCompatible,
        compatibleModels,
        contextBlocked,
        contextBlockedCount,
      };
    }

    async function trySwitchToCompatibleModel(
      vendor: string,
      modelId: string,
    ): Promise<boolean> {
      const v = getVendor(vendor);
      if (!v) return false;

      for (let i = 0; i < v.routes.length; i++) {
        const route = v.routes[i];
        if (!routeCanHandleModel(ctx, route, modelId)) continue;

        const ok = await switchToRoute(
          ctx,
          vendor,
          i,
          modelId,
          "setup validation model fix",
          true,
        );
        if (ok) return true;
      }

      return false;
    }

    async function runSetupValidation(defaultVendor: string): Promise<void> {
      while (true) {
        const check = await collectSetupValidation(defaultVendor);
        const hasHardFailures =
          check.missingOauth.length > 0 ||
          check.missingApiRoutes.length > 0 ||
          !check.modelCompatible;

        ctx.ui.notify(
          check.lines.join("\n"),
          hasHardFailures ? "warning" : "info",
        );

        const options: string[] = ["Done", "Re-run checks"];

        if (check.missingOauth.length > 0) {
          options.unshift("Run /login now");
        }

        if (check.missingApiRoutes.length > 0) {
          options.unshift("Show missing API key env vars");
        }

        if (!check.modelCompatible && check.compatibleModels.length > 0) {
          options.unshift(
            `Try switching to compatible model (${check.compatibleModels[0]})`,
          );
        }

        if (check.contextBlocked) {
          options.unshift("Compact session now");
        }

        const choice = await ctx.ui.select("Validate setup now", options);
        if (!choice || choice === "Done") return;

        if (choice === "Run /login now") {
          await promptOauthLogin(ctx, check.missingOauth);
          continue;
        }

        if (choice === "Show missing API key env vars") {
          const vars = Array.from(new Set(check.missingApiEnvNames)).filter(Boolean);
          if (vars.length === 0) {
            ctx.ui.notify(
              `${EXT_NOTIFY} Missing API key credentials. Check api_key_env/api_key_path/api_key in your config.`,
              "warning",
            );
          } else {
            ctx.ui.notify(
              `${EXT_NOTIFY} Set these env vars, then Re-run checks:\n${vars
                .map((name) => `  - ${name}`)
                .join("\n")}`,
              "warning",
            );
          }
          continue;
        }

        if (choice.startsWith("Try switching to compatible model")) {
          const modelOptions = check.compatibleModels.slice(0, 20);
          const pickedModel = await ctx.ui.select("Choose compatible model", [
            ...modelOptions,
            "← Back",
          ]);
          if (!pickedModel || pickedModel === "← Back") continue;

          const switched = await trySwitchToCompatibleModel(defaultVendor, pickedModel);
          if (!switched) {
            ctx.ui.notify(
              `${EXT_NOTIFY} Could not switch to compatible model '${pickedModel}'.`,
              "warning",
            );
          }
          continue;
        }

        if (choice === "Compact session now") {
          const target = check.contextBlocked;
          if (!target) continue;

          const compact = await runSwitchCompaction(
            ctx,
            target.route_ref.route,
            target.model_id,
          );
          if (!compact.ok) {
            const reasonText = compact.message ? ` Reason: ${compact.message}` : "";
            ctx.ui.notify(
              `${EXT_NOTIFY} Compaction failed.${reasonText}`,
              "warning",
            );
          } else {
            ctx.ui.notify(`${EXT_NOTIFY} Compaction complete.`, "info");
          }
          continue;
        }
      }
    }

    let stage: "dest" | "vendors" | "routes" | "order" | "default" | "policy" | "stack" = "dest";

    while (true) {
      if (stage === "dest") {
        const globalDest = `Global (${globalConfigPath()})`;
        const projectDest = `Project (${projectConfigPath(ctx.cwd)})`;
        const preferProject = targetPath === projectConfigPath(ctx.cwd);

        const destChoice = await ctx.ui.select(
          "Where should subswitch config live?",
          preferProject ? [projectDest, globalDest, "Cancel"] : [globalDest, projectDest, "Cancel"],
        );

        if (!destChoice || destChoice === "Cancel") {
          ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
          return;
        }

        targetPath = destChoice === projectDest
          ? projectConfigPath(ctx.cwd)
          : globalConfigPath();

        stage = "vendors";
        continue;
      }

      if (stage === "vendors") {
        const choice = await ctx.ui.select("Select vendors to configure", [
          "Continue",
          `OpenAI: ${useOpenAI ? "Yes" : "No"}`,
          `Claude: ${useClaude ? "Yes" : "No"}`,
          "← Back",
          "Cancel",
        ]);

        if (!choice || choice === "Cancel") {
          ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
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
          ctx.ui.notify(`${EXT_NOTIFY} Select at least one vendor`, "warning");
          continue;
        }

        stage = "routes";
        continue;
      }

      if (stage === "routes") {
        if (useOpenAI) {
          const openaiResult = await collectVendor("openai", vendorConfigs.get("openai"));
          if (openaiResult.nav === "cancel") {
            ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
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
            ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
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
          ctx.ui.notify(`${EXT_NOTIFY} No routes configured; returning to vendor selection`, "warning");
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
            ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
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
            ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
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

      if (stage === "default") {
        const vendorNames = Array.from(vendorConfigs.keys());
        if (vendorNames.length === 0) {
          stage = "vendors";
          continue;
        }

        if (!vendorNames.includes(defaultVendorChoice)) {
          defaultVendorChoice = vendorNames[0];
        }

        const orderedVendorNames = [
          defaultVendorChoice,
          ...vendorNames.filter((v) => v !== defaultVendorChoice),
        ];

        const defaultChoice = await ctx.ui.select("Default vendor", [
          ...orderedVendorNames,
          "← Back",
          "Cancel",
        ]);

        if (!defaultChoice || defaultChoice === "Cancel") {
          ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
          return;
        }

        if (defaultChoice === "← Back") {
          stage = "order";
          continue;
        }

        defaultVendorChoice = defaultChoice;
        stage = "policy";
        continue;
      }

      if (stage === "policy") {
        const policyChoice = await ctx.ui.select("Failover policy", [
          "Continue",
          `Scope: ${failoverScope === "global" ? "Cross-vendor" : "Current vendor only"}`,
          `Return to preferred: ${returnEnabled ? "On" : "Off"}`,
          `Minimum time on fallback (minutes): ${returnStableMinutes}`,
          `Failover on rate limit: ${triggerRateLimit ? "On" : "Off"}`,
          `Failover on exhausted quota: ${triggerQuota ? "On" : "Off"}`,
          `Failover on auth error (API key routes): ${triggerAuth ? "On" : "Off"}`,
          "← Back",
          "Cancel",
        ]);

        if (!policyChoice || policyChoice === "Cancel") {
          ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
          return;
        }

        if (policyChoice === "← Back") {
          stage = "default";
          continue;
        }

        if (policyChoice.startsWith("Scope:")) {
          failoverScope = failoverScope === "global" ? "current_vendor" : "global";
          continue;
        }

        if (policyChoice.startsWith("Return to preferred:")) {
          returnEnabled = !returnEnabled;
          continue;
        }

        if (policyChoice.startsWith("Minimum time on fallback (minutes):")) {
          const minutesRes = await inputWithBack(
            "Minimum time on fallback in minutes (0 = no holdoff)",
            String(returnStableMinutes),
          );
          if (minutesRes.nav === "cancel") {
            ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
            return;
          }
          if (minutesRes.nav === "back") continue;

          const parsed = Number(String(minutesRes.value ?? "").trim());
          if (!Number.isFinite(parsed) || parsed < 0) {
            ctx.ui.notify(`${EXT_NOTIFY} Enter a non-negative integer`, "warning");
            continue;
          }
          returnStableMinutes = Math.floor(parsed);
          continue;
        }

        if (policyChoice.startsWith("Failover on rate limit:")) {
          triggerRateLimit = !triggerRateLimit;
          continue;
        }

        if (policyChoice.startsWith("Failover on exhausted quota:")) {
          triggerQuota = !triggerQuota;
          continue;
        }

        if (policyChoice.startsWith("Failover on auth error (API key routes):")) {
          triggerAuth = !triggerAuth;
          continue;
        }

        stage = "stack";
        continue;
      }

      const nav = await configurePreferenceStack(defaultVendorChoice);
      if (nav === "cancel") {
        ctx.ui.notify(`${EXT_NOTIFY} Setup cancelled`, "warning");
        return;
      }
      if (nav === "back") {
        stage = "policy";
        continue;
      }

      const out = buildDraftNormalized(defaultVendorChoice);

      writeJson(targetPath, configToJson(out));

      cfg = out;
      registerAliasesFromConfig(cfg);
      statePath = statePathForConfigPath(ctx.cwd, targetPath);
      pruneRuntimeState();
      persistRuntimeState();

      ctx.ui.notify(`${EXT_NOTIFY} Wrote config to ${targetPath}`, "info");

      const oauthProviders = configuredOauthProviders();

      while (true) {
        const nextStep = await ctx.ui.select("Setup complete", [
          "Finish setup",
          "Validate now",
          "OAuth login checklist",
        ]);

        if (!nextStep || nextStep === "Finish setup") {
          break;
        }

        if (nextStep === "Validate now") {
          await runSetupValidation(defaultVendorChoice);
          continue;
        }

        if (oauthProviders.length > 0) {
          await promptOauthLogin(ctx, oauthProviders);
        } else {
          ctx.ui.notify(`${EXT_NOTIFY} No OAuth providers configured.`, "info");
        }
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
      "Long status",
      "Explain routing",
      "Recent events",
      "Start continuation fallback",
      "Setup wizard",
      "OAuth login checklist",
      "Edit config",
      "Reorder failover stack",
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
      notifyStatus(ctx, false);
      return;
    }

    if (selected === "Long status") {
      notifyStatus(ctx, true);
      return;
    }

    if (selected === "Explain routing") {
      notifyExplain(ctx);
      return;
    }

    if (selected === "Recent events") {
      notifyEvents(ctx, DECISION_EVENT_DEFAULT_LIMIT);
      return;
    }

    if (selected === "Start continuation fallback") {
      const target = resolveContinuationTarget(ctx);
      if (!target) {
        if (ctx.hasUI) {
          ctx.ui.notify(`${EXT_NOTIFY} Could not resolve continuation target route/model.`, "warning");
        }
        return;
      }
      const result = await runContinuationFallback(ctx, target);
      if (!result.ok && ctx.hasUI) {
        ctx.ui.notify(`${EXT_NOTIFY} ${result.message}`, "warning");
      }
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

    if (selected === "Reorder failover stack") {
      await reorderVendorInteractive(ctx);
      return;
    }

    if (selected === "Reload config") {
      reloadCfg(ctx);
      loadRuntimeState(ctx);
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

  function toolStatusSummary(ctx: any, detailed = false): string {
    return buildStatusLines(ctx, detailed).join("\n");
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

    return `Moved ${vendor}/${authType}/${label} to the top of the preference stack and saved config to ${savePath}.`;
  }

  // Register aliases as early as possible (extension load-time).
  registerAliasesFromConfig(loadConfig(process.cwd()));

  pi.registerTool({
    name: "subswitch_manage",
    label: "Subswitch Manage",
    description:
      "Manage subscription/api failover routes for vendors (openai/claude). Supports status/longstatus/explain/events, use, prefer, rename, reload, continue.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("longstatus"),
        Type.Literal("explain"),
        Type.Literal("events"),
        Type.Literal("use"),
        Type.Literal("prefer"),
        Type.Literal("rename"),
        Type.Literal("reload"),
        Type.Literal("continue"),
      ]),
      vendor: Type.Optional(Type.String({ description: "Vendor, e.g. openai or claude" })),
      auth_type: Type.Optional(
        Type.Union([Type.Literal("oauth"), Type.Literal("api_key")], {
          description: "Auth type",
        }),
      ),
      label: Type.Optional(Type.String({ description: "Route label, e.g. work/personal" })),
      model_id: Type.Optional(Type.String({ description: "Optional model id to switch to while applying route" })),
      limit: Type.Optional(Type.Number({ description: "Optional limit for action=events" })),
      old_label: Type.Optional(Type.String({ description: "Old label for rename action" })),
      new_label: Type.Optional(Type.String({ description: "New label for rename action" })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      ensureCfg(ctx);
      lastCtx = ctx;

      const action = String(params.action ?? "").trim();

      if (action === "status") {
        const text = toolStatusSummary(ctx, false);
        return {
          content: [{ type: "text", text }],
          details: { action, ok: true },
        };
      }

      if (action === "longstatus") {
        const text = toolStatusSummary(ctx, true);
        return {
          content: [{ type: "text", text }],
          details: { action, ok: true },
        };
      }

      if (action === "explain") {
        const text = buildExplainLines(ctx).join("\n");
        return {
          content: [{ type: "text", text }],
          details: { action, ok: true },
        };
      }

      if (action === "events") {
        const nRaw = Number(params.limit ?? DECISION_EVENT_DEFAULT_LIMIT);
        const limit = Number.isFinite(nRaw)
          ? Math.max(1, Math.min(200, Math.floor(nRaw)))
          : DECISION_EVENT_DEFAULT_LIMIT;
        const text = buildDecisionEventLines(limit).join("\n");
        return {
          content: [{ type: "text", text }],
          details: { action, ok: true, limit },
        };
      }

      if (action === "reload") {
        reloadCfg(ctx);
        loadRuntimeState(ctx);
        updateStatus(ctx);
        const text = `Reloaded config and runtime state.\n${toolStatusSummary(ctx, false)}`;
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

      if (action === "continue") {
        const vendor = params.vendor ? String(params.vendor).trim().toLowerCase() : undefined;
        const authType = params.auth_type
          ? (String(params.auth_type).trim() as AuthType)
          : undefined;
        const label = params.label ? String(params.label).trim() : undefined;
        const modelId = params.model_id ? String(params.model_id).trim() : undefined;

        const hasExplicitSelector = Boolean(vendor || authType || label || modelId);
        if (hasExplicitSelector && !(vendor && authType && label)) {
          return {
            content: [
              {
                type: "text",
                text: "Usage for action=continue: provide vendor+auth_type+label together (model_id optional), or provide none to auto-select target.",
              },
            ],
            details: { action, ok: false },
          };
        }

        const target = resolveContinuationTarget(ctx, vendor, authType, label, modelId);
        if (!target) {
          return {
            content: [
              {
                type: "text",
                text: "Could not resolve continuation target route/model.",
              },
            ],
            details: { action, ok: false },
          };
        }

        const result = await runContinuationFallback(ctx, target);
        return {
          content: [{ type: "text", text: result.message }],
          details: { action, ok: result.ok },
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
            text: `Unknown action '${action}'. Supported: status, longstatus, explain, events, use, prefer, rename, reload, continue.`,
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

      if (
        cmd === "" ||
        cmd === "status" ||
        cmd === "longstatus" ||
        cmd === "explain" ||
        cmd === "events"
      ) {
        if (cmd === "") {
          await runQuickPicker(ctx);
        } else if (cmd === "status" || cmd === "longstatus") {
          notifyStatus(ctx, cmd === "longstatus");
        } else if (cmd === "explain") {
          notifyExplain(ctx);
        } else {
          const nRaw = Number(parts[1] ?? DECISION_EVENT_DEFAULT_LIMIT);
          const limit = Number.isFinite(nRaw)
            ? Math.max(1, Math.min(200, Math.floor(nRaw)))
            : DECISION_EVENT_DEFAULT_LIMIT;
          notifyEvents(ctx, limit);
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
            "  status                        Show concise status\n" +
            "  longstatus                    Show detailed status (stack/models/ids)\n" +
            "  explain                       Explain current route selection and ineligible candidates\n" +
            "  events [limit]                Show recent route decision events\n" +
            "  setup                         Guided setup wizard (applies only on finish)\n" +
            "  login                         Prompt OAuth login checklist and prefill /login\n" +
            "  login-status                  Re-check OAuth login completion and update reminder\n" +
            "  reload                        Reload config + runtime state\n" +
            "  on / off                      Enable/disable extension (runtime)\n" +
            "  reorder [vendor]              Interactive reorder for failover preference stack\n" +
            "  edit                          Edit JSON config with validation\n" +
            "  models <vendor>               Show compatible models across routes\n" +
            "  continue [vendor auth_type label [modelId]]\n" +
            "                                Create reduced-carryover continuation session\n" +
            "  use <vendor> <auth_type> <label> [modelId]\n" +
            "  subscription <vendor> [label] [modelId]\n" +
            "  api <vendor> [label] [modelId]\n" +
            "  rename <vendor> <auth_type> <old_label> <new_label>\n" +
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
            ctx.ui.notify(`${EXT_NOTIFY} OAuth login checklist complete`, "info");
          } else {
            ctx.ui.notify(
              `${EXT_NOTIFY} Missing OAuth login for: ${missing.join(", ")}`,
              "warning",
            );
          }
        }
        updateStatus(ctx);
        return;
      }

      if (cmd === "reload") {
        reloadCfg(ctx);
        loadRuntimeState(ctx);
        notifyStatus(ctx);
        updateStatus(ctx);
        return;
      }

      if (cmd === "on") {
        if (cfg) cfg.enabled = true;
        if (ctx.hasUI) ctx.ui.notify(`${EXT_NOTIFY} enabled=true (runtime)`, "info");
        updateStatus(ctx);
        return;
      }

      if (cmd === "off") {
        if (cfg) cfg.enabled = false;
        clearRetryTimer();
        restoreOriginalEnv();
        pendingOauthReminderProviders = [];
        if (ctx.hasUI) {
          ctx.ui.notify(`${EXT_NOTIFY} enabled=false (runtime)`, "warning");
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
              `${EXT_NOTIFY} Usage: /subswitch use <vendor> <auth_type> <label> [modelId]`,
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
            `${EXT_NOTIFY} '${cmd}' is deprecated; use '/subswitch ${replacement} ${vendor} ...'`,
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
              `${EXT_NOTIFY} Usage: /subswitch rename <vendor> <auth_type> <old_label> <new_label>`,
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
              `${EXT_NOTIFY} Route not found for rename (${vendor}/${authType}/${oldLabel})`,
              "warning",
            );
          }
          updateStatus(ctx);
          return;
        }

        const savePath = saveCurrentConfig(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `${EXT_NOTIFY} Renamed route '${oldLabel}' -> '${newLabel}'. Saved to ${savePath}`,
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

      if (cmd === "continue") {
        const vendor = parts[1] ? String(parts[1]).trim().toLowerCase() : undefined;
        const authType = parts[2] ? (String(parts[2]).trim() as AuthType) : undefined;
        const label = parts[3] ? String(parts[3]).trim() : undefined;
        const modelId = parts[4] ? String(parts[4]).trim() : undefined;

        if (authType && authType !== "oauth" && authType !== "api_key") {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `${EXT_NOTIFY} Usage: /subswitch continue [vendor auth_type(oauth|api_key) label [modelId]]`,
              "warning",
            );
          }
          updateStatus(ctx);
          return;
        }

        const hasExplicitSelector = Boolean(vendor || authType || label || modelId);
        if (hasExplicitSelector && !(vendor && authType && label)) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `${EXT_NOTIFY} Usage: /subswitch continue [vendor auth_type(oauth|api_key) label [modelId]]`,
              "warning",
            );
          }
          updateStatus(ctx);
          return;
        }

        const target = resolveContinuationTarget(ctx, vendor, authType, label, modelId);
        if (!target) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `${EXT_NOTIFY} Could not resolve continuation target route/model.`,
              "warning",
            );
          }
          updateStatus(ctx);
          return;
        }

        const result = await runContinuationFallback(ctx, target);
        if (!result.ok && ctx.hasUI) {
          ctx.ui.notify(`${EXT_NOTIFY} ${result.message}`, "warning");
        }

        updateStatus(ctx);
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(`${EXT_NOTIFY} Unknown command '${cmd}'. Try '/subswitch help'.`, "warning");
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

    // Keep prompt start fast: do not run preferred-route probes on the user start path.
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
    if (message?.stopReason !== "error") {
      requestBackgroundPreferredRouteCheck(ctx, "after turn");
      scheduleRetryTimer(ctx);
      updateStatus(ctx);
      return;
    }

    const err = message?.errorMessage ?? message?.details?.error ?? message?.error ?? "unknown error";

    const provider = ctx.model?.provider;
    const modelId = ctx.model?.id;
    if (!provider || !modelId) return;

    const resolved = resolveVendorRouteForProvider(provider);
    if (!resolved) return;

    const vendorCfg = getVendor(resolved.vendor);
    const route = getRoute(resolved.vendor, resolved.index);
    if (!vendorCfg || !route) return;

    const triggeredByRateLimit =
      cfg.failover.triggers.rate_limit && isRateLimitSignalError(err, cfg.rate_limit_patterns);
    const triggeredByQuota = cfg.failover.triggers.quota_exhausted && isQuotaExhaustedError(err);
    const triggeredByAuth =
      cfg.failover.triggers.auth_error &&
      route.auth_type === "api_key" &&
      isAuthError(err);

    if (!triggeredByRateLimit && !triggeredByQuota && !triggeredByAuth) return;

    const parsedRetryMs = triggeredByAuth ? undefined : parseRetryAfterMs(err);
    const defaultCooldownMs = routeDefaultCooldownMinutes(vendorCfg, route) * 60_000;
    const bufferMs = route.auth_type === "oauth" ? 15_000 : 5_000;
    const until = now() + (parsedRetryMs ?? defaultCooldownMs) + bufferMs;
    setRouteCooldownUntil(resolved.vendor, resolved.index, until);

    const effective = buildEffectivePreferenceStack(resolved.vendor, modelId);
    const currentIdx = findCurrentEffectiveStackIndex(effective, route.id, modelId);
    const start = currentIdx === undefined ? 0 : currentIdx + 1;

    const triggerLabel = triggeredByAuth
      ? "auth error"
      : triggeredByQuota
        ? "quota exhausted"
        : "rate limited";

    notifyDecision(
      ctx,
      triggeredByAuth ? "warning" : "info",
      "failover_trigger",
      `${routeDisplay(resolved.vendor, route)} hit ${triggerLabel}. Evaluating fallback routes.`,
      {
        reason: String(err),
        nextRetryAtMs: until,
        silent: true,
      },
    );

    let selection = findNextEligibleFallback(ctx, effective, start);
    let nextEntry = selection.entry;

    if (!nextEntry && selection.context_blocked > 0) {
      notifyDecision(
        ctx,
        "info",
        "compaction",
        `${selection.context_blocked} fallback route(s) are currently blocked by context size. Trying compaction before failover…`,
        { reason: triggerLabel },
      );

      const compactTargetRoute = selection.first_context_blocked?.route_ref.route ?? route;
      const compactTargetModel = selection.first_context_blocked?.model_id ?? modelId;
      const compactResult = await runSwitchCompaction(ctx, compactTargetRoute, compactTargetModel);
      if (!compactResult.ok) {
        const reasonText = compactResult.message ? ` Reason: ${compactResult.message}` : "";
        notifyDecision(
          ctx,
          "warning",
          "compaction",
          `Could not compact session before fallback retry.${reasonText}`,
          { reason: triggerLabel },
        );
      }

      selection = findNextEligibleFallback(ctx, effective, start);
      nextEntry = selection.entry;
    }

    if (!nextEntry) {
      const contextHint = selection.context_blocked > 0
        ? ` ${selection.context_blocked} route(s) are blocked by context size.`
        : "";
      notifyDecision(
        ctx,
        "warning",
        "no_fallback",
        `${routeDisplay(resolved.vendor, route)} hit ${triggerLabel}. No eligible fallback route.${contextHint} Next retry in ${formatRetryWindow(until)}.`,
        {
          reason: triggerLabel,
          nextRetryAtMs: until,
        },
      );
      scheduleRetryTimer(ctx);
      updateStatus(ctx);
      return;
    }

    notifyDecision(
      ctx,
      "info",
      "failover_switch",
      `${routeDisplay(resolved.vendor, route)} hit ${triggerLabel}. Switching to ${routeDisplay(nextEntry.route_ref.vendor, nextEntry.route_ref.route)} (${nextEntry.model_id}).`,
      { reason: triggerLabel },
    );

    const switched = await switchToRoute(
      ctx,
      nextEntry.route_ref.vendor,
      nextEntry.route_ref.index,
      nextEntry.model_id,
      triggerLabel,
      true,
    );

    if (!switched) {
      notifyDecision(
        ctx,
        "warning",
        "failover_stay",
        `Could not switch to fallback route. Staying on ${routeDisplay(resolved.vendor, route)}. Next retry in ${formatRetryWindow(until)}.`,
        {
          reason: triggerLabel,
          nextRetryAtMs: until,
        },
      );
      scheduleRetryTimer(ctx);
      updateStatus(ctx);
      return;
    }

    if (cfg.failover.return_to_preferred.enabled) {
      const holdoffMs = cfg.failover.return_to_preferred.min_stable_minutes * 60_000;
      setNextReturnEligibleAtMs(Math.max(nextReturnEligibleAtMs, now() + holdoffMs));
    }

    // Auto-retry after any successful automatic failover switch when enabled.
    if (vendorCfg.auto_retry && lastPrompt && lastPrompt.source !== "extension") {
      const content =
        !lastPrompt.images || lastPrompt.images.length === 0
          ? lastPrompt.text
          : [{ type: "text", text: lastPrompt.text }, ...lastPrompt.images];

      notifyDecision(
        ctx,
        "info",
        "auto_retry",
        "Retrying your last prompt on the new route…",
        { reason: triggerLabel },
      );

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
    loadRuntimeState(ctx);
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
    loadRuntimeState(ctx);
    lastCtx = ctx;
    rememberActiveFromCtx(ctx);
    managedModelId = ctx.model?.id;
    scheduleRetryTimer(ctx);
    await refreshOauthReminderWidget(ctx, configuredOauthProviders());
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    persistRuntimeState();
    clearRetryTimer();
    restoreOriginalEnv();
  });
}
