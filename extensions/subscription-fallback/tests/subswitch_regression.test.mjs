import assert from 'node:assert/strict';
import test from 'node:test';

import { createModel, createSubswitchRuntime } from './harness.mjs';

function notificationTexts(runtime) {
  return runtime.notifications.map((n) => `[${n.level}] ${n.text}`);
}

function hasText(runtime, snippet) {
  return notificationTexts(runtime).some((line) => line.includes(snippet));
}

function openaiClaudeConfig() {
  return {
    enabled: true,
    default_vendor: 'openai',
    rate_limit_patterns: [],
    failover: {
      scope: 'global',
      return_to_preferred: { enabled: true, min_stable_minutes: 10 },
      triggers: { rate_limit: true, quota_exhausted: true, auth_error: true },
    },
    preference_stack: [
      { route_id: 'openai-oauth-work' },
      { route_id: 'claude-oauth-work' },
    ],
    vendors: [
      {
        vendor: 'openai',
        oauth_cooldown_minutes: 180,
        api_key_cooldown_minutes: 15,
        auto_retry: true,
        routes: [
          {
            id: 'openai-oauth-work',
            auth_type: 'oauth',
            label: 'work',
            provider_id: 'openai-codex-work',
          },
        ],
      },
      {
        vendor: 'claude',
        oauth_cooldown_minutes: 180,
        api_key_cooldown_minutes: 15,
        auto_retry: true,
        routes: [
          {
            id: 'claude-oauth-work',
            auth_type: 'oauth',
            label: 'work',
            provider_id: 'anthropic-work',
          },
        ],
      },
    ],
  };
}

function openaiPreferredRecoveryConfig() {
  return {
    enabled: true,
    default_vendor: 'openai',
    rate_limit_patterns: [],
    failover: {
      scope: 'global',
      return_to_preferred: { enabled: true, min_stable_minutes: 0 },
      triggers: { rate_limit: true, quota_exhausted: true, auth_error: true },
    },
    preference_stack: [
      { route_id: 'openai-oauth-work' },
      { route_id: 'openai-oauth-personal' },
    ],
    vendors: [
      {
        vendor: 'openai',
        oauth_cooldown_minutes: 180,
        api_key_cooldown_minutes: 15,
        auto_retry: true,
        routes: [
          {
            id: 'openai-oauth-work',
            auth_type: 'oauth',
            label: 'work',
            provider_id: 'openai-codex-work',
          },
          {
            id: 'openai-oauth-personal',
            auth_type: 'oauth',
            label: 'personal',
            provider_id: 'openai-codex',
          },
        ],
      },
    ],
  };
}

test('manual switch compacts and then switches when context is too large', async () => {
  const runtime = await createSubswitchRuntime({
    config: openaiClaudeConfig(),
    initialModel: { provider: 'openai-codex-work', id: 'gpt-5.3-codex' },
    usageTokens: 260_000,
    models: [
      createModel('openai-codex-work', 'gpt-5.3-codex', { contextWindow: 272_000 }),
      createModel('anthropic-work', 'gpt-5.3-codex', {
        api: 'anthropic-messages',
        contextWindow: 200_000,
      }),
    ],
    compactBehavior(compactOptions, helpers) {
      helpers.setUsageTokens(100_000);
      compactOptions?.onComplete?.({ summary: 'ok' });
    },
  });

  try {
    await runtime.runCommand('use claude oauth work gpt-5.3-codex');

    assert.equal(runtime.ctx.model.provider, 'anthropic-work');
    assert.equal(runtime.ctx.model.id, 'gpt-5.3-codex');
    assert.ok(hasText(runtime, 'Compaction complete. Retrying switch'));
    assert.ok(hasText(runtime, 'Switched to claude · oauth · work'));
  } finally {
    await runtime.shutdown();
  }
});

test('automatic failover compacts when fallback candidates are context-blocked', async () => {
  const runtime = await createSubswitchRuntime({
    config: openaiClaudeConfig(),
    initialModel: { provider: 'openai-codex-work', id: 'gpt-5.3-codex' },
    usageTokens: 220_000,
    models: [
      createModel('openai-codex-work', 'gpt-5.3-codex', { contextWindow: 272_000 }),
      createModel('anthropic-work', 'gpt-5.3-codex', {
        api: 'anthropic-messages',
        contextWindow: 200_000,
      }),
    ],
    compactBehavior(compactOptions, helpers) {
      helpers.setUsageTokens(120_000);
      compactOptions?.onComplete?.({ summary: 'ok' });
    },
  });

  try {
    await runtime.emitTurnEnd({
      stopReason: 'error',
      errorMessage: 'usage limit reached',
    });

    assert.equal(runtime.ctx.model.provider, 'anthropic-work');
    assert.ok(runtime.setModelCalls.includes('anthropic-work/gpt-5.3-codex'));
    assert.ok(hasText(runtime, 'blocked by context size'));
    assert.ok(hasText(runtime, 'Switching to claude · oauth · work'));
  } finally {
    await runtime.shutdown();
  }
});

test('automatic failover stays on route when compaction fails and no candidate becomes eligible', async () => {
  const runtime = await createSubswitchRuntime({
    config: openaiClaudeConfig(),
    initialModel: { provider: 'openai-codex-work', id: 'gpt-5.3-codex' },
    usageTokens: 220_000,
    models: [
      createModel('openai-codex-work', 'gpt-5.3-codex', { contextWindow: 272_000 }),
      createModel('anthropic-work', 'gpt-5.3-codex', {
        api: 'anthropic-messages',
        contextWindow: 200_000,
      }),
    ],
    compactBehavior(compactOptions) {
      compactOptions?.onError?.(new Error('mock compaction failed'));
    },
  });

  try {
    await runtime.emitTurnEnd({
      stopReason: 'error',
      errorMessage: 'usage limit reached',
    });

    assert.equal(runtime.ctx.model.provider, 'openai-codex-work');
    assert.equal(runtime.setModelCalls.length, 0);
    assert.ok(hasText(runtime, 'Could not compact session before fallback retry'));
    assert.ok(hasText(runtime, 'No eligible fallback route'));
  } finally {
    await runtime.shutdown();
  }
});

test('return-to-preferred handles inconclusive probes as info and can directly switch back', async () => {
  const runtime = await createSubswitchRuntime({
    config: openaiPreferredRecoveryConfig(),
    initialModel: { provider: 'openai-codex', id: 'gpt-5.3-codex' },
    models: [
      createModel('openai-codex-work', 'gpt-5.3-codex', { contextWindow: 272_000 }),
      createModel('openai-codex', 'gpt-5.3-codex', { contextWindow: 272_000 }),
    ],
    fetchImpl: async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    },
  });

  try {
    await runtime.emitTurnEnd({ stopReason: 'stop' });
    await runtime.waitFor(150);

    assert.equal(runtime.ctx.model.provider, 'openai-codex-work');
    assert.ok(hasText(runtime, 'Preferred route check was inconclusive'));
    assert.ok(hasText(runtime, 'Successfully switched back to preferred route'));

    const hardWarnings = runtime.notifications.filter(
      (n) => n.level === 'warning' && n.text.includes('Preferred route still unavailable'),
    );
    assert.equal(hardWarnings.length, 0);
  } finally {
    await runtime.shutdown();
  }
});

test('return-to-preferred probe hard failure stays on fallback with warning severity', async () => {
  const runtime = await createSubswitchRuntime({
    config: openaiPreferredRecoveryConfig(),
    initialModel: { provider: 'openai-codex', id: 'gpt-5.3-codex' },
    models: [
      createModel('openai-codex-work', 'gpt-5.3-codex', { contextWindow: 272_000 }),
      createModel('openai-codex', 'gpt-5.3-codex', { contextWindow: 272_000 }),
    ],
    fetchImpl: async () => new Response('{"error":{"message":"usage limit"}}', { status: 429 }),
  });

  try {
    await runtime.emitTurnEnd({ stopReason: 'stop' });
    await runtime.waitFor(150);

    assert.equal(runtime.ctx.model.provider, 'openai-codex');

    const warning = runtime.notifications.find(
      (n) => n.level === 'warning' && n.text.includes('Preferred route still unavailable'),
    );
    assert.ok(warning, 'expected warning for hard preferred-route probe failure');
  } finally {
    await runtime.shutdown();
  }
});

test('/subswitch explain and /subswitch events surface decision state and history', async () => {
  const runtime = await createSubswitchRuntime({
    config: openaiClaudeConfig(),
    initialModel: { provider: 'openai-codex-work', id: 'gpt-5.3-codex' },
    usageTokens: 220_000,
    models: [
      createModel('openai-codex-work', 'gpt-5.3-codex', { contextWindow: 272_000 }),
      createModel('anthropic-work', 'gpt-5.3-codex', {
        api: 'anthropic-messages',
        contextWindow: 200_000,
      }),
    ],
    compactBehavior(compactOptions, helpers) {
      helpers.setUsageTokens(120_000);
      compactOptions?.onComplete?.({ summary: 'ok' });
    },
  });

  try {
    await runtime.emitTurnEnd({
      stopReason: 'error',
      errorMessage: 'usage limit reached',
    });

    await runtime.runCommand('explain');
    await runtime.runCommand('events 5');

    assert.ok(hasText(runtime, 'decision explain'));
    assert.ok(hasText(runtime, 'Last'));
    assert.ok(hasText(runtime, 'failover_trigger'));
  } finally {
    await runtime.shutdown();
  }
});

test('setup wizard validate-now path reports auth/model/context checks', async () => {
  const setupConfig = {
    enabled: true,
    default_vendor: 'openai',
    vendors: [
      {
        vendor: 'openai',
        routes: [
          {
            id: 'openai-oauth-work',
            auth_type: 'oauth',
            label: 'work',
            provider_id: 'openai-codex-work',
          },
        ],
      },
    ],
  };

  let setupCompleteCount = 0;

  const runtime = await createSubswitchRuntime({
    config: setupConfig,
    initialModel: { provider: 'openai-codex-work', id: 'gpt-5.3-codex' },
    models: [
      createModel('openai-codex-work', 'gpt-5.3-codex', { contextWindow: 272_000 }),
      createModel('openai-codex', 'gpt-5.3-codex', { contextWindow: 272_000 }),
    ],
    getApiKey: async () => '',
    input: async () => '',
    select(title, choices) {
      if (title.includes('Where should subswitch config live?')) {
        return choices.find((c) => String(c).startsWith('Project')) ?? choices[0];
      }
      if (title === 'Select vendors to configure') return 'Continue';
      if (title.startsWith('OpenAI route order')) return 'Keep order';
      if (title === 'Default vendor') return 'openai';
      if (title === 'Failover policy') return 'Continue';
      if (title.startsWith('Preference stack')) return 'Keep stack';
      if (title === 'Setup complete') {
        setupCompleteCount += 1;
        return setupCompleteCount === 1 ? 'Validate now' : 'Finish setup';
      }
      if (title === 'Validate setup now') return 'Done';
      return choices[0];
    },
  });

  try {
    await runtime.runCommand('setup');

    assert.ok(hasText(runtime, 'setup validation'));
    assert.ok(hasText(runtime, 'OAuth login missing'));
    assert.ok(hasText(runtime, 'API key material missing'));
  } finally {
    await runtime.shutdown();
  }
});

test('subswitch_manage supports explain/events/continue actions with expected contracts', async () => {
  const runtime = await createSubswitchRuntime({
    config: {
      enabled: true,
      default_vendor: 'openai',
      preference_stack: [{ route_id: 'openai-oauth-work' }],
      vendors: [
        {
          vendor: 'openai',
          routes: [
            {
              id: 'openai-oauth-work',
              auth_type: 'oauth',
              label: 'work',
              provider_id: 'openai-codex-work',
            },
          ],
        },
      ],
    },
    hasUI: false,
    initialModel: { provider: 'openai-codex-work', id: 'gpt-5.3-codex' },
    models: [
      createModel('openai-codex-work', 'gpt-5.3-codex', { contextWindow: 272_000 }),
    ],
  });

  try {
    const explain = await runtime.runTool({ action: 'explain' });
    const events = await runtime.runTool({ action: 'events', limit: 5 });
    const continuation = await runtime.runTool({ action: 'continue' });

    assert.ok(explain.content?.[0]?.text?.includes('[subswitch] decision explain'));
    assert.ok(events.content?.[0]?.text?.includes('[subswitch]'));
    assert.equal(continuation.details?.ok, false);
    assert.ok(String(continuation.content?.[0]?.text ?? '').includes('newSession() is unavailable'));
  } finally {
    await runtime.shutdown();
  }
});
