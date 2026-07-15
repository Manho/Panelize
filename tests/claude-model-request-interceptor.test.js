import '../content-scripts/claude-model-request-utils.js';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  CLAUDE_MODEL_MODE_DEFAULT,
  CLAUDE_MODEL_MODE_HAIKU_4_5,
  CLAUDE_MODEL_MODE_OPUS_4_8,
  CLAUDE_MODEL_MODE_SONNET_5,
  CLAUDE_MODEL_OPTIONS,
  createClaudeModelOverrideMessage,
  getClaudeModelOption,
  normalizeClaudeModelMode
} from '../modules/claude-model-mode.js';

const utils = globalThis.PanelizeClaudeModelRequestUtils;

function createInterceptorHarness({ fetchError = null, fetchStatus = 200, xhrStatus = 200 } = {}) {
  const messages = [];
  const targetOrigins = [];
  const fetchCalls = [];
  const messageListeners = [];
  const xhrInstances = [];

  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.sentBodies = [];
      this.status = xhrStatus;
      xhrInstances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    open() {}

    send(body) {
      this.sentBodies.push(body);
      this.listeners.get('loadend')?.();
    }
  }

  const parent = {
    postMessage(message, targetOrigin) {
      messages.push(message);
      targetOrigins.push(targetOrigin);
    }
  };
  const context = {
    Request,
    URL,
    XMLHttpRequest: FakeXMLHttpRequest,
    fetch: async (...args) => {
      fetchCalls.push(args);
      if (fetchError) {
        throw fetchError;
      }
      return { status: fetchStatus };
    },
    location: { href: 'https://claude.ai/new' },
    parent,
    top: {},
    addEventListener(type, listener) {
      if (type === 'message') {
        messageListeners.push(listener);
      }
    }
  };
  context.window = context;
  context.self = context;

  vm.runInNewContext(
    fs.readFileSync(path.resolve('content-scripts/claude-model-request-utils.js'), 'utf8'),
    context
  );
  vm.runInNewContext(
    fs.readFileSync(path.resolve('content-scripts/claude-model-request-interceptor.js'), 'utf8'),
    context
  );

  return {
    configure(mode) {
      messageListeners[0]({
        source: parent,
        origin: 'chrome-extension://panelize-test',
        data: createClaudeModelOverrideMessage(mode)
      });
    },
    context,
    fetchCalls,
    messages,
    targetOrigins,
    xhrInstances
  };
}

describe('Claude model request override', () => {
  it('defines the supported UI modes and exact request model IDs', () => {
    expect(CLAUDE_MODEL_OPTIONS).toEqual([
      { mode: 'default', label: 'Claude default', modelId: '' },
      { mode: 'opus-4-8', label: 'Opus 4.8', modelId: 'claude-opus-4-8' },
      { mode: 'sonnet-5', label: 'Sonnet 5', modelId: 'claude-sonnet-5' },
      { mode: 'haiku-4-5', label: 'Haiku 4.5', modelId: 'claude-haiku-4-5-20251001' }
    ]);
  });

  it('normalizes unknown stored values to Claude default', () => {
    expect(normalizeClaudeModelMode(CLAUDE_MODEL_MODE_SONNET_5)).toBe('sonnet-5');
    expect(normalizeClaudeModelMode('future-model')).toBe(CLAUDE_MODEL_MODE_DEFAULT);
    expect(normalizeClaudeModelMode(null)).toBe(CLAUDE_MODEL_MODE_DEFAULT);
    expect(getClaudeModelOption('future-model')).toEqual(CLAUDE_MODEL_OPTIONS[0]);
  });

  it.each([
    [CLAUDE_MODEL_MODE_DEFAULT, ''],
    [CLAUDE_MODEL_MODE_SONNET_5, 'claude-sonnet-5'],
    [CLAUDE_MODEL_MODE_OPUS_4_8, 'claude-opus-4-8'],
    [CLAUDE_MODEL_MODE_HAIKU_4_5, 'claude-haiku-4-5-20251001']
  ])('builds a constrained parent message for %s', (mode, model) => {
    expect(createClaudeModelOverrideMessage(mode)).toEqual({
      type: 'PANELIZE_CLAUDE_MODEL_OVERRIDE',
      mode,
      model
    });
  });

  it('uses exact origins after the initial iframe handshake', () => {
    const harness = createInterceptorHarness();

    expect(harness.targetOrigins).toEqual(['*']);
    harness.configure(CLAUDE_MODEL_MODE_OPUS_4_8);
    expect(harness.targetOrigins.at(-1)).toBe('chrome-extension://panelize-test');

    const multiPanelSource = fs.readFileSync(
      path.resolve('multi-panel/multi-panel.js'),
      'utf8'
    );
    expect(multiPanelSource).toContain(
      "createClaudeModelOverrideMessage(mode),\n    'https://claude.ai'"
    );
  });

  it('accepts only the three catalog model IDs', () => {
    expect(utils.isAllowedModelId('claude-sonnet-5')).toBe(true);
    expect(utils.isAllowedModelId('claude-opus-4-8')).toBe(true);
    expect(utils.isAllowedModelId('claude-haiku-4-5-20251001')).toBe(true);
    expect(utils.isAllowedModelId('claude-future-model')).toBe(false);
  });

  it('matches only Claude completion endpoint URLs', () => {
    expect(utils.isClaudeCompletionUrl(
      'https://claude.ai/api/organizations/org/chat_conversations/chat/completion'
    )).toBe(true);
    expect(utils.isClaudeCompletionUrl('/api/chat/completion', 'https://claude.ai/new')).toBe(true);
    expect(utils.isClaudeCompletionUrl('https://claude.ai/api/chat/completion/extra')).toBe(false);
    expect(utils.isClaudeCompletionUrl('https://evil.example/api/chat/completion')).toBe(false);
    expect(utils.isClaudeCompletionUrl('not a url', 'not a base')).toBe(false);
  });

  it('replaces only the root model field and leaves nested fields untouched', () => {
    const result = utils.rewriteCompletionBody(JSON.stringify({
      model: 'claude-sonnet-5',
      metadata: { model: 'leave-this-value' },
      messages: [{ content: 'private prompt', modelId: 'leave-this-too' }]
    }), 'claude-opus-4-8');

    expect(result).toMatchObject({
      overridden: true,
      changed: true,
      inserted: false,
      reason: 'model-replaced'
    });
    expect(JSON.parse(result.body)).toEqual({
      model: 'claude-opus-4-8',
      metadata: { model: 'leave-this-value' },
      messages: [{ content: 'private prompt', modelId: 'leave-this-too' }]
    });
  });

  it('injects a root model field when the embedded request omits it', () => {
    const result = utils.rewriteCompletionBody(
      '{"prompt":"hello","timezone":"Asia/Shanghai"}',
      'claude-haiku-4-5-20251001'
    );

    expect(result).toMatchObject({
      overridden: true,
      changed: true,
      inserted: true,
      reason: 'model-injected'
    });
    expect(JSON.parse(result.body)).toEqual({
      prompt: 'hello',
      timezone: 'Asia/Shanghai',
      model: 'claude-haiku-4-5-20251001'
    });
  });

  it('passes unsupported bodies through without rewriting them', () => {
    expect(utils.rewriteCompletionBody('not-json', 'claude-sonnet-5')).toEqual({
      body: 'not-json',
      overridden: false,
      reason: 'invalid-json'
    });
    expect(utils.rewriteCompletionBody('["prompt"]', 'claude-sonnet-5')).toEqual({
      body: '["prompt"]',
      overridden: false,
      reason: 'unsupported-shape'
    });
    expect(utils.rewriteCompletionBody('{"model":null}', 'claude-sonnet-5')).toEqual({
      body: '{"model":null}',
      overridden: false,
      reason: 'unsupported-model-field'
    });
    expect(utils.rewriteCompletionBody('{"prompt":"hello"}', 'claude-unknown')).toEqual({
      body: '{"prompt":"hello"}',
      overridden: false,
      reason: 'unsupported-model'
    });
  });

  it('classifies only 4xx responses as model request rejections', () => {
    expect(utils.classifyResponseStatus(200)).toBe('accepted');
    expect(utils.classifyResponseStatus(204)).toBe('accepted');
    expect(utils.classifyResponseStatus(400)).toBe('rejected');
    expect(utils.classifyResponseStatus(403)).toBe('rejected');
    expect(utils.classifyResponseStatus(500)).toBe('server-error');
    expect(utils.classifyResponseStatus(0)).toBe('unknown');
  });

  it('rewrites a Fetch completion request once without resending it', async () => {
    const harness = createInterceptorHarness();
    harness.configure(CLAUDE_MODEL_MODE_OPUS_4_8);

    await harness.context.fetch(
      'https://claude.ai/api/organizations/org/chat_conversations/chat/completion',
      { method: 'POST', body: '{"prompt":"hello"}' }
    );

    expect(harness.fetchCalls).toHaveLength(1);
    expect(JSON.parse(harness.fetchCalls[0][1].body)).toEqual({
      prompt: 'hello',
      model: 'claude-opus-4-8'
    });
    expect(harness.messages.map(message => message.event)).toContain('override-request-accepted');
  });

  it('leaves completion requests unchanged in Claude default mode', async () => {
    const harness = createInterceptorHarness();
    const body = '{"prompt":"default"}';

    await harness.context.fetch('https://claude.ai/api/chat/completion', {
      method: 'POST',
      body
    });

    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.fetchCalls[0][1].body).toBe(body);
    expect(harness.messages.map(message => message.event)).not.toContain('request-overridden');
  });

  it('passes an unsupported Fetch body through once and disables later overrides', async () => {
    const harness = createInterceptorHarness();
    harness.configure(CLAUDE_MODEL_MODE_SONNET_5);
    const endpoint = 'https://claude.ai/api/chat/completion';

    await harness.context.fetch(endpoint, { method: 'POST', body: 'not-json' });
    await harness.context.fetch(endpoint, { method: 'POST', body: '{"prompt":"second"}' });

    expect(harness.fetchCalls).toHaveLength(2);
    expect(harness.fetchCalls[0][1].body).toBe('not-json');
    expect(harness.fetchCalls[1][1].body).toBe('{"prompt":"second"}');
    expect(harness.messages.map(message => message.event)).toContain('override-schema-unsupported');
  });

  it('disables the override after a 4xx without automatically retrying', async () => {
    const harness = createInterceptorHarness({ fetchStatus: 403 });
    const endpoint = 'https://claude.ai/api/chat/completion';
    harness.configure(CLAUDE_MODEL_MODE_HAIKU_4_5);

    await harness.context.fetch(endpoint, { method: 'POST', body: '{"prompt":"first"}' });
    await harness.context.fetch(endpoint, { method: 'POST', body: '{"prompt":"second"}' });

    expect(harness.fetchCalls).toHaveLength(2);
    expect(JSON.parse(harness.fetchCalls[0][1].body).model).toBe('claude-haiku-4-5-20251001');
    expect(harness.fetchCalls[1][1].body).toBe('{"prompt":"second"}');
    expect(harness.messages.map(message => message.event)).toContain('override-request-rejected');
  });

  it('leaves the override enabled after a 5xx and sends each XHR only once', async () => {
    const fetchHarness = createInterceptorHarness({ fetchStatus: 500 });
    const endpoint = 'https://claude.ai/api/chat/completion';
    fetchHarness.configure(CLAUDE_MODEL_MODE_SONNET_5);

    await fetchHarness.context.fetch(endpoint, { method: 'POST', body: '{"prompt":"first"}' });
    await fetchHarness.context.fetch(endpoint, { method: 'POST', body: '{"prompt":"second"}' });

    expect(fetchHarness.fetchCalls).toHaveLength(2);
    expect(JSON.parse(fetchHarness.fetchCalls[1][1].body).model).toBe('claude-sonnet-5');

    const xhrHarness = createInterceptorHarness({ xhrStatus: 200 });
    xhrHarness.configure(CLAUDE_MODEL_MODE_OPUS_4_8);
    const xhr = new xhrHarness.context.XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.send('{"prompt":"xhr"}');

    expect(xhrHarness.xhrInstances).toHaveLength(1);
    expect(xhr.sentBodies).toHaveLength(1);
    expect(JSON.parse(xhr.sentBodies[0]).model).toBe('claude-opus-4-8');
  });

  it('does not treat a Fetch network error as a model rejection', async () => {
    const networkError = new TypeError('network unavailable');
    const harness = createInterceptorHarness({ fetchError: networkError });
    harness.configure(CLAUDE_MODEL_MODE_SONNET_5);

    await expect(harness.context.fetch(
      'https://claude.ai/api/chat/completion',
      { method: 'POST', body: '{"prompt":"network"}' }
    )).rejects.toThrow('network unavailable');

    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.messages.map(message => message.event)).not.toContain('override-request-rejected');
  });

  it('disables an XHR override after one 4xx without resending', () => {
    const harness = createInterceptorHarness({ xhrStatus: 403 });
    const endpoint = 'https://claude.ai/api/chat/completion';
    harness.configure(CLAUDE_MODEL_MODE_OPUS_4_8);

    const firstXhr = new harness.context.XMLHttpRequest();
    firstXhr.open('POST', endpoint);
    firstXhr.send('{"prompt":"first"}');

    const secondXhr = new harness.context.XMLHttpRequest();
    secondXhr.open('POST', endpoint);
    secondXhr.send('{"prompt":"second"}');

    expect(firstXhr.sentBodies).toHaveLength(1);
    expect(JSON.parse(firstXhr.sentBodies[0]).model).toBe('claude-opus-4-8');
    expect(secondXhr.sentBodies).toEqual(['{"prompt":"second"}']);
    expect(harness.messages.map(message => message.event)).toContain('override-request-rejected');
  });

  it('loads the passive interceptor in the main world for Claude frames', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('manifest.json'), 'utf8'));
    const registration = manifest.content_scripts.find(entry =>
      entry.js.includes('content-scripts/claude-model-request-interceptor.js')
    );

    expect(registration).toMatchObject({
      matches: ['https://claude.ai/*'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN'
    });
    expect(registration.js).toEqual([
      'content-scripts/claude-model-request-utils.js',
      'content-scripts/claude-model-request-interceptor.js'
    ]);

    const source = fs.readFileSync(
      path.resolve('content-scripts/claude-model-request-interceptor.js'),
      'utf8'
    );
    expect(source).toContain('if (window.self === window.top)');
    expect(source).not.toContain('console.info');
    expect(source).not.toContain('endpointPattern');
  });

  it('provides the Claude model UI copy in every supported locale', () => {
    const requiredKeys = [
      'openProviderTopLevel',
      'embeddedModelLimitNotice',
      'embeddedModelOverrideNotice',
      'claudeModelDefault',
      'claudeModelExperimentalBadge',
      'claudeModelExperimentalTitle',
      'claudeModelSelectTitle',
      'claudeModelRequestedStatus',
      'claudeModelOverrideUnavailable',
      'claudeModelRequestRejected'
    ];
    const locales = fs.readdirSync(path.resolve('_locales'));

    locales.forEach(locale => {
      const messages = JSON.parse(fs.readFileSync(
        path.resolve('_locales', locale, 'messages.json'),
        'utf8'
      ));
      requiredKeys.forEach(key => {
        expect(messages[key]?.message, `${locale} is missing ${key}`).toBeTruthy();
      });
    });
  });
});
