import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_SRC = resolve(TEST_DIR, '../index.ts');
const PI_AI_STUB = resolve(TEST_DIR, 'stubs/pi-ai-stub.mjs');
const TYPEBOX_STUB = resolve(TEST_DIR, 'stubs/typebox-stub.mjs');

export function createModel(
  provider,
  id,
  {
    api,
    baseUrl,
    contextWindow = 272_000,
  } = {},
) {
  const resolvedApi = api
    ?? (provider.includes('anthropic') ? 'anthropic-messages' : 'openai-codex-responses');
  const resolvedBaseUrl = baseUrl
    ?? (resolvedApi === 'anthropic-messages'
      ? 'https://api.anthropic.com'
      : 'https://chatgpt.com/backend-api');

  return {
    provider,
    id,
    api: resolvedApi,
    baseUrl: resolvedBaseUrl,
    contextWindow,
    headers: {},
  };
}

function patchedExtensionSource() {
  const source = readFileSync(EXT_SRC, 'utf8');
  return source
    .replace(
      'from "@mariozechner/pi-ai"',
      `from "${pathToFileURL(PI_AI_STUB).href}"`,
    )
    .replace(
      'from "@sinclair/typebox"',
      `from "${pathToFileURL(TYPEBOX_STUB).href}"`,
    );
}

export async function createSubswitchRuntime(options) {
  const {
    config,
    initialModel,
    models,
    usageTokens = 120_000,
    usageContextWindow = 272_000,
    compactBehavior,
    compactedUsageTokens = 100_000,
    setModelSucceeds = true,
    getApiKey = async () => 'oauth-token',
    select,
    input,
    prompt,
    hasUI = true,
    fetchImpl,
    startSession = true,
  } = options;

  if (!config) {
    throw new Error('createSubswitchRuntime requires config');
  }
  if (!initialModel?.provider || !initialModel?.id) {
    throw new Error('createSubswitchRuntime requires initialModel { provider, id }');
  }

  const root = mkdtempSync(join(tmpdir(), 'subswitch-test-'));
  mkdirSync(join(root, '.pi'), { recursive: true });
  writeFileSync(join(root, '.pi', 'subswitch.json'), `${JSON.stringify(config, null, 2)}\n`);

  const extPath = join(root, 'index.test.ts');
  writeFileSync(extPath, patchedExtensionSource());

  const mod = await import(pathToFileURL(extPath).href);
  const extension = mod.default;

  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();

  const notifications = [];
  const setModelCalls = [];
  const userMessages = [];
  const extensionMessages = [];

  let currentUsageTokens = usageTokens;
  let currentUsageContextWindow = usageContextWindow;

  const modelMap = new Map();
  for (const model of models ?? []) {
    modelMap.set(`${model.provider}/${model.id}`, model);
  }

  const originalFetch = globalThis.fetch;
  if (fetchImpl) {
    globalThis.fetch = fetchImpl;
  }

  let ctx;

  const pi = {
    registerProvider() {},

    registerTool(definition) {
      tools.set(definition.name, definition);
    },

    registerCommand(name, definition) {
      commands.set(name, definition);
    },

    on(name, handler) {
      handlers.set(name, handler);
    },

    async setModel(model) {
      const shouldSucceed = typeof setModelSucceeds === 'function'
        ? await setModelSucceeds(model, ctx)
        : setModelSucceeds;

      setModelCalls.push(`${model.provider}/${model.id}`);
      if (!shouldSucceed) {
        return false;
      }

      ctx.model = { provider: model.provider, id: model.id };
      const onModelSelect = handlers.get('model_select');
      if (onModelSelect) {
        await onModelSelect({ model: ctx.model }, ctx);
      }

      return true;
    },

    sendUserMessage(content, opts) {
      userMessages.push({ content, opts });
    },

    sendMessage(message, opts) {
      extensionMessages.push({ message, opts });
    },
  };

  extension(pi);

  ctx = {
    cwd: root,
    hasUI,
    model: {
      provider: initialModel.provider,
      id: initialModel.id,
    },
    modelRegistry: {
      find(provider, modelId) {
        return modelMap.get(`${provider}/${modelId}`);
      },
      async getApiKey(model) {
        return getApiKey(model);
      },
      getAvailable() {
        return Array.from(modelMap.values());
      },
    },
    isIdle() {
      return true;
    },
    getContextUsage() {
      const percent = currentUsageContextWindow > 0
        ? Math.round((currentUsageTokens / currentUsageContextWindow) * 100)
        : 0;
      return {
        tokens: currentUsageTokens,
        contextWindow: currentUsageContextWindow,
        percent,
        usageTokens: currentUsageTokens,
        trailingTokens: 0,
        lastUsageIndex: null,
      };
    },
    compact(compactOptions) {
      if (compactBehavior) {
        compactBehavior(compactOptions, {
          getUsageTokens: () => currentUsageTokens,
          setUsageTokens: (value) => {
            currentUsageTokens = Number(value);
          },
        });
        return;
      }

      currentUsageTokens = compactedUsageTokens;
      compactOptions?.onComplete?.({ summary: 'ok' });
    },
    ui: {
      theme: {
        fg(_color, text) {
          return text;
        },
      },
      notify(text, level) {
        notifications.push({ level, text: String(text) });
      },
      setStatus() {},
      setWidget() {},
      setEditorText() {},
      spinner() {
        return { stop() {} };
      },
      async select(title, choices) {
        if (!select) return undefined;
        return select(String(title), choices);
      },
      async input(title, defaultValue) {
        if (!input) return undefined;
        return input(String(title), String(defaultValue ?? ''));
      },
      async prompt(title, options) {
        if (!prompt) return undefined;
        return prompt(String(title), options);
      },
    },
  };

  if (startSession) {
    const onSessionStart = handlers.get('session_start');
    if (onSessionStart) {
      await onSessionStart({}, ctx);
    }
  }

  async function runCommand(args) {
    const command = commands.get('subswitch');
    if (!command) {
      throw new Error('subswitch command is not registered');
    }
    await command.handler(args, ctx);
  }

  async function runTool(params) {
    const tool = tools.get('subswitch_manage');
    if (!tool) {
      throw new Error('subswitch_manage tool is not registered');
    }
    return tool.execute('tool-call', params, undefined, undefined, ctx);
  }

  async function emitTurnEnd(message) {
    const handler = handlers.get('turn_end');
    if (!handler) {
      throw new Error('turn_end handler is not registered');
    }
    await handler({ message }, ctx);
  }

  async function waitFor(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function shutdown() {
    const onShutdown = handlers.get('session_shutdown');
    if (onShutdown) {
      await onShutdown({}, ctx);
    }

    globalThis.fetch = originalFetch;
  }

  return {
    root,
    ctx,
    notifications,
    setModelCalls,
    userMessages,
    extensionMessages,
    runCommand,
    runTool,
    emitTurnEnd,
    waitFor,
    setUsageTokens(value) {
      currentUsageTokens = Number(value);
    },
    setUsageContextWindow(value) {
      currentUsageContextWindow = Number(value);
    },
    shutdown,
  };
}
