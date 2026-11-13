import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_ORIGIN } from './helpers/multi-panel-messages.js';

const DRIVER_PATH = resolve(process.cwd(), 'content-scripts/custom-provider-driver.js');
const DRIVER_SOURCE = readFileSync(DRIVER_PATH, 'utf8');
const CUSTOM_PROVIDER_ID = 'custom-0123456789';

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function setLayoutRect(element, { left = 20, top = 500, width = 600, height = 48 } = {}) {
  const rect = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return this;
    },
  };
  element.getBoundingClientRect = () => rect;
  return element;
}

function createDriverEnvironment({
  url = 'http://127.0.0.1:3000/chat',
  framed = true,
  nested = false,
  ancestorOrigins = undefined,
  runtime = globalThis.chrome.runtime,
} = {}) {
  const win = new Window({ url, width: 1024, height: 768 });
  const parent = { postMessage: vi.fn() };
  const top = nested ? { postMessage: vi.fn() } : parent;

  if (framed) {
    Object.defineProperty(win, 'parent', { configurable: true, value: parent });
    Object.defineProperty(win, 'top', { configurable: true, value: top });
  }

  if (ancestorOrigins !== undefined) {
    Object.defineProperty(win.location, 'ancestorOrigins', {
      configurable: true,
      value: ancestorOrigins,
    });
  }

  win.chrome = { ...globalThis.chrome, runtime };

  const evaluateDriver = () => {
    win.eval(DRIVER_SOURCE);
  };

  const postFromHost = (data, { origin = EXTENSION_ORIGIN, source = parent } = {}) => {
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data,
        origin,
        source,
      })
    );
  };

  return {
    win,
    document: win.document,
    parent,
    top,
    evaluateDriver,
    postFromHost,
    async close() {
      await win.happyDOM.close();
    },
  };
}

describe('content-scripts/custom-provider-driver.js', () => {
  it('stays a classic script with no ES module syntax, no wildcard postMessage, and no spike hooks', () => {
    const stripped = DRIVER_SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(stripped).not.toMatch(/^\s*import\b/m);
    expect(stripped).not.toMatch(/^\s*export\b/m);
    expect(stripped).not.toMatch(/__spike/);
    expect(stripped).not.toMatch(/\.postMessage\s*\([^,]+,\s*['"]\*['"]\s*\)/);
  });

  it('stays completely inert when unframed or nested deeper than one frame', async () => {
    for (const [label, opts] of [
      ['top-level unframed tab', { framed: false }],
      ['nested subframe inside framed UI', { framed: true, nested: true }],
    ]) {
      const env = createDriverEnvironment(opts);
      try {
        env.document.body.innerHTML = `
          <form id="chat-form">
            <textarea id="composer"></textarea>
            <button id="send-btn" type="submit">Send</button>
          </form>
        `;
        setLayoutRect(env.document.getElementById('chat-form'), { top: 480, width: 700, height: 80 });
        setLayoutRect(env.document.getElementById('composer'));
        setLayoutRect(env.document.getElementById('send-btn'), { left: 640, width: 60, height: 36 });

        env.evaluateDriver();
        env.postFromHost(
          {
            type: 'INJECT_TEXT_WITH_IMAGES',
            context: 'multi-panel',
            providerId: CUSTOM_PROVIDER_ID,
            requestId: 'req-unframed',
            action: 'fill',
            text: 'Should not inject',
            images: [],
            autoSubmit: true,
          },
          { source: env.win.parent }
        );
        await wait(120);

        expect(env.document.getElementById('composer').value, label).toBe('');
        expect(env.parent.postMessage, label).not.toHaveBeenCalled();
      } finally {
        await env.close();
      }
    }
  });

  it('enforces exact origin, window.parent source, ancestorOrigins, and chrome.runtime.getURL guards', async () => {
    // 1. Wrong origin and wrong source on an active framed instance
    const env = createDriverEnvironment({
      ancestorOrigins: [EXTENSION_ORIGIN],
    });
    try {
      env.document.body.innerHTML = `
        <form id="chat-form">
          <textarea id="composer"></textarea>
          <button id="send-btn" type="submit">Send</button>
        </form>
      `;
      setLayoutRect(env.document.getElementById('chat-form'), { top: 480, width: 700, height: 80 });
      setLayoutRect(env.document.getElementById('composer'));
      setLayoutRect(env.document.getElementById('send-btn'), { left: 640, width: 60, height: 36 });

      env.evaluateDriver();

      // Wrong event.origin
      env.postFromHost(
        {
          type: 'INJECT_TEXT',
          context: 'multi-panel',
          providerId: CUSTOM_PROVIDER_ID,
          text: 'Spoofed origin',
          autoSubmit: true,
        },
        { origin: 'https://evil.example' }
      );

      // Wrong event.source
      env.postFromHost(
        {
          type: 'INJECT_TEXT',
          context: 'multi-panel',
          providerId: CUSTOM_PROVIDER_ID,
          text: 'Spoofed source',
          autoSubmit: true,
        },
        { source: {} }
      );

      await wait(120);
      expect(env.document.getElementById('composer').value).toBe('');
      expect(env.parent.postMessage).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }

    // 2. Non-extension ancestorOrigins makes driver inert even if postMessage spoofs origin
    const evilAncestorEnv = createDriverEnvironment({
      ancestorOrigins: ['https://attacker.example'],
    });
    try {
      evilAncestorEnv.document.body.innerHTML = `<textarea id="composer"></textarea>`;
      setLayoutRect(evilAncestorEnv.document.getElementById('composer'));
      evilAncestorEnv.evaluateDriver();
      evilAncestorEnv.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        text: 'Blocked by ancestorOrigins',
      });
      await wait(80);
      expect(evilAncestorEnv.document.getElementById('composer').value).toBe('');
      expect(evilAncestorEnv.parent.postMessage).not.toHaveBeenCalled();
    } finally {
      await evilAncestorEnv.close();
    }

    // 3. Unavailable chrome.runtime.getURL disables messaging cleanly
    const brokenRuntimeEnv = createDriverEnvironment({
      runtime: { ...globalThis.chrome.runtime, getURL: undefined },
    });
    try {
      brokenRuntimeEnv.document.body.innerHTML = `<textarea id="composer"></textarea>`;
      setLayoutRect(brokenRuntimeEnv.document.getElementById('composer'));
      brokenRuntimeEnv.evaluateDriver();
      brokenRuntimeEnv.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        text: 'No runtime origin',
      });
      await wait(80);
      expect(brokenRuntimeEnv.document.getElementById('composer').value).toBe('');
      expect(brokenRuntimeEnv.parent.postMessage).not.toHaveBeenCalled();
    } finally {
      await brokenRuntimeEnv.close();
    }
  });

  it('guards against duplicate execution in the same frame (idempotency)', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `
        <form id="chat-form">
          <textarea id="composer"></textarea>
          <button id="send-btn" type="submit">Send</button>
        </form>
      `;
      setLayoutRect(env.document.getElementById('chat-form'), { top: 480, width: 700, height: 80 });
      setLayoutRect(env.document.getElementById('composer'));
      const sendBtn = setLayoutRect(env.document.getElementById('send-btn'), {
        left: 640,
        width: 60,
        height: 36,
      });

      let sendClicks = 0;
      sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        sendClicks += 1;
      });

      // Evaluate the script three times in the same window
      env.evaluateDriver();
      env.evaluateDriver();
      env.evaluateDriver();

      env.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-idem-1',
        action: 'fill',
        text: 'Once only',
        autoSubmit: true,
      });

      await wait(160);

      expect(env.document.getElementById('composer').value).toBe('Once only');
      expect(sendClicks).toBe(1);
      const actionResults = env.parent.postMessage.mock.calls.filter(
        ([msg]) => msg.type === 'PANELIZE_ACTION_RESULT'
      );
      expect(actionResults).toHaveLength(1);
    } finally {
      await env.close();
    }
  });

  it('inserts into <textarea>, resets React _valueTracker, fires framework events, echoes providerId, and targets EXTENSION_ORIGIN', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `
        <div id="composer-bar">
          <textarea id="composer"></textarea>
          <button id="send-btn" type="button" aria-label="Send message">Send</button>
        </div>
      `;
      setLayoutRect(env.document.getElementById('composer-bar'), { top: 480, width: 700, height: 80 });
      const composer = setLayoutRect(env.document.getElementById('composer'));
      const sendBtn = setLayoutRect(env.document.getElementById('send-btn'), {
        left: 640,
        width: 60,
        height: 36,
      });

      const trackerSpy = vi.fn();
      composer._valueTracker = { setValue: trackerSpy };

      const observedEvents = [];
      composer.addEventListener('beforeinput', () => observedEvents.push('beforeinput'));
      composer.addEventListener('input', () => observedEvents.push(`input:${composer.value}`));
      composer.addEventListener('change', () => observedEvents.push('change'));

      let sendClicks = 0;
      sendBtn.addEventListener('click', () => {
        sendClicks += 1;
      });

      env.evaluateDriver();

      env.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-fill-1',
        action: 'fill',
        text: 'Hello frameworks',
        autoSubmit: false,
      });

      await wait(50);

      expect(composer.value).toBe('Hello frameworks');
      expect(trackerSpy).toHaveBeenCalledWith('');
      expect(observedEvents).toContain('beforeinput');
      expect(observedEvents).toContain('input:Hello frameworks');
      expect(observedEvents).toContain('change');
      expect(sendClicks).toBe(0);

      // Verify initial location report + action result both echo providerId and target EXTENSION_ORIGIN
      expect(env.parent.postMessage).toHaveBeenCalledTimes(2);
      for (const [payload, targetOrigin] of env.parent.postMessage.mock.calls) {
        expect(targetOrigin).toBe(EXTENSION_ORIGIN);
        expect(targetOrigin).not.toBe('*');
        expect(payload.provider).toBe(CUSTOM_PROVIDER_ID);
      }

      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_PROVIDER_LOCATION',
          provider: CUSTOM_PROVIDER_ID,
          url: 'http://127.0.0.1:3000/chat',
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          requestId: 'req-fill-1',
          provider: CUSTOM_PROVIDER_ID,
          action: 'fill',
          status: 'succeeded',
          succeededImageIds: [],
        },
        EXTENSION_ORIGIN
      );

      // SPA history pushState reports updated location with exact EXTENSION_ORIGIN
      env.win.history.pushState({}, '', '/chat/c-99');
      await wait(30);
      expect(env.parent.postMessage).toHaveBeenLastCalledWith(
        {
          type: 'PANELIZE_PROVIDER_LOCATION',
          provider: CUSTOM_PROVIDER_ID,
          url: 'http://127.0.0.1:3000/chat/c-99',
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('rejects negative buttons (voice, mic, model, attach, upload, more, stop, cancel) and picks the real send button', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `
        <div id="composer-bar">
          <textarea id="composer"></textarea>
          <button id="attach-btn" type="button" aria-label="Attach file">+</button>
          <button id="upload-btn" type="button" title="Upload">Up</button>
          <button id="model-btn" type="button" aria-label="Select model">Llama</button>
          <button id="more-btn" type="button" aria-label="More options">...</button>
          <button id="mic-btn" type="button" aria-label="Mic input">Mic</button>
          <button id="voice-btn" type="button" aria-label="Voice mode">Voice</button>
          <button id="cancel-btn" type="button" aria-label="Cancel">Cancel</button>
          <button id="stop-btn" type="submit" class="send-button" aria-label="Stop generating">Stop</button>
          <button id="real-send-btn" type="button" aria-label="Send prompt">Go</button>
        </div>
      `;
      setLayoutRect(env.document.getElementById('composer-bar'), { top: 480, width: 760, height: 90 });
      setLayoutRect(env.document.getElementById('composer'), { width: 400 });

      const clickedIds = [];
      for (const btn of env.document.querySelectorAll('button')) {
        setLayoutRect(btn, { left: 450, width: 44, height: 32 });
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          clickedIds.push(btn.id);
        });
      }

      env.evaluateDriver();
      env.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        text: 'Test negative button filter',
        autoSubmit: true,
      });

      await wait(160);
      expect(clickedIds).toEqual(['real-send-btn']);
    } finally {
      await env.close();
    }
  });

  it('falls back to dispatching Enter key sequence when only negative buttons (e.g. Voice) or no buttons exist', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `
        <div id="composer-bar">
          <textarea id="composer">Ready prompt</textarea>
          <button id="voice-only-btn" type="button" aria-label="Start voice mode">Voice</button>
          <button id="more-only-btn" type="button" aria-label="More">More</button>
        </div>
      `;
      setLayoutRect(env.document.getElementById('composer-bar'), { top: 480, width: 700, height: 80 });
      const composer = setLayoutRect(env.document.getElementById('composer'));
      const voiceBtn = setLayoutRect(env.document.getElementById('voice-only-btn'), {
        left: 600,
        width: 48,
        height: 32,
      });
      const moreBtn = setLayoutRect(env.document.getElementById('more-only-btn'), {
        left: 652,
        width: 48,
        height: 32,
      });

      let negativeClicks = 0;
      voiceBtn.addEventListener('click', () => {
        negativeClicks += 1;
      });
      moreBtn.addEventListener('click', () => {
        negativeClicks += 1;
      });

      const keyEvents = [];
      for (const evtType of ['keydown', 'keypress', 'keyup']) {
        composer.addEventListener(evtType, (ev) => {
          keyEvents.push({ type: evtType, key: ev.key, code: ev.code, keyCode: ev.keyCode });
        });
      }

      env.evaluateDriver();
      env.postFromHost({
        type: 'TRIGGER_SEND',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-trigger-enter',
      });

      await wait(420);

      expect(negativeClicks).toBe(0);
      expect(keyEvents).toEqual([
        { type: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13 },
        { type: 'keypress', key: 'Enter', code: 'Enter', keyCode: 13 },
        { type: 'keyup', key: 'Enter', code: 'Enter', keyCode: 13 },
      ]);
    } finally {
      await env.close();
    }
  });

  it('clears both <textarea> and [contenteditable] composers on CLEAR_INPUT', async () => {
    // 1. Textarea clear
    const textareaEnv = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      textareaEnv.document.body.innerHTML = `<textarea id="composer">Draft to wipe</textarea>`;
      const composer = setLayoutRect(textareaEnv.document.getElementById('composer'));
      let inputFired = false;
      composer.addEventListener('input', () => {
        inputFired = true;
      });

      textareaEnv.evaluateDriver();
      textareaEnv.postFromHost({
        type: 'CLEAR_INPUT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });

      expect(composer.value).toBe('');
      expect(inputFired).toBe(true);
    } finally {
      await textareaEnv.close();
    }

    // 2. Contenteditable clear
    const ceEnv = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      ceEnv.document.body.innerHTML = `<div id="ce" contenteditable="true"><p>Rich draft</p></div>`;
      const ce = setLayoutRect(ceEnv.document.getElementById('ce'));
      ceEnv.evaluateDriver();

      ceEnv.postFromHost({
        type: 'CLEAR_INPUT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });

      expect(ce.textContent).toBe('');
    } finally {
      await ceEnv.close();
    }
  });

  it('inserts once (no paste duplicate) and clears cleanly on Lexical-style microtask-reconciled contenteditable editors', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `<div id="lexical" contenteditable="true" role="textbox"></div>`;
      const lexical = setLayoutRect(env.document.getElementById('lexical'));

      // Simulate Lexical: internal state + selection synced on 'selectionchange',
      // 'beforeinput' and 'paste' cancel default and reconcile DOM in a microtask,
      // and unauthorized direct DOM wipes get reverted to editorState.
      let editorText = '';
      let selectionAll = false;

      env.document.addEventListener('selectionchange', () => {
        const sel = env.win.getSelection();
        selectionAll = Boolean(sel && sel.rangeCount > 0 && !sel.isCollapsed);
      });

      const reconcile = () => {
        queueMicrotask(() => {
          lexical.textContent = editorText;
        });
      };

      env.document.execCommand = (cmd, _ui, val) => {
        if (cmd === 'insertText') {
          const ev = new env.win.InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            composed: true,
            inputType: 'insertText',
            data: val,
          });
          lexical.dispatchEvent(ev);
          return !ev.defaultPrevented;
        }
        if (cmd === 'delete') {
          const ev = new env.win.InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            composed: true,
            inputType: 'deleteContentBackward',
          });
          lexical.dispatchEvent(ev);
          return !ev.defaultPrevented;
        }
        return false;
      };

      lexical.addEventListener('beforeinput', (ev) => {
        if (ev.inputType === 'insertText' && typeof ev.data === 'string') {
          ev.preventDefault();
          editorText = selectionAll ? ev.data : editorText + ev.data;
          selectionAll = false;
          reconcile();
        } else if (ev.inputType === 'deleteContentBackward' || ev.inputType === 'deleteByCut') {
          ev.preventDefault();
          editorText = selectionAll ? '' : editorText.slice(0, -1);
          selectionAll = false;
          reconcile();
        }
      });

      lexical.addEventListener('paste', (ev) => {
        ev.preventDefault();
        const clip = ev.clipboardData?.getData('text/plain') || '';
        editorText += clip;
        reconcile();
      });

      env.evaluateDriver();

      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-lexical-fill',
        action: 'fill',
        text: 'Hello Perplexity Lexical!',
        images: [],
        autoSubmit: false,
      });

      await wait(80);
      expect(lexical.textContent).toBe('Hello Perplexity Lexical!');

      env.postFromHost({
        type: 'CLEAR_INPUT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });

      await wait(160);
      expect(lexical.textContent).toBe('');
    } finally {
      await env.close();
    }
  });

  it('fast-fails INJECT_TEXT_WITH_IMAGES with reason "unsupported" when images are non-empty, while succeeding when images is empty', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `<textarea id="composer"></textarea>`;
      const composer = setLayoutRect(env.document.getElementById('composer'));
      env.evaluateDriver();

      const startedAt = Date.now();
      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-img-unsupported',
        action: 'fill',
        text: 'Caption still injected',
        images: [
          {
            id: 'img-1',
            name: 'chart.png',
            type: 'image/png',
            dataUrl: 'data:image/png;base64,AAAA',
          },
        ],
        autoSubmit: false,
      });

      await wait(40);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(500);
      expect(composer.value).toBe('Caption still injected');
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          requestId: 'req-img-unsupported',
          provider: CUSTOM_PROVIDER_ID,
          action: 'fill',
          status: 'failed',
          reason: 'unsupported',
          succeededImageIds: [],
        },
        EXTENSION_ORIGIN
      );

      // Clear and verify INJECT_TEXT_WITH_IMAGES with images: [] succeeds cleanly
      env.postFromHost({
        type: 'CLEAR_INPUT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });
      env.parent.postMessage.mockClear();

      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-img-empty',
        action: 'fill',
        text: 'Text-only fill via image envelope',
        images: [],
        autoSubmit: false,
      });

      await wait(40);
      expect(composer.value).toBe('Text-only fill via image envelope');
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          requestId: 'req-img-empty',
          provider: CUSTOM_PROVIDER_ID,
          action: 'fill',
          status: 'succeeded',
          succeededImageIds: [],
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('reports injection-error without mutating DOM or auto-submitting an existing draft when paste is canceled without inserting', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `
        <form id="composer-form">
          <div id="editor" contenteditable="true" role="textbox"><p>Existing draft</p></div>
          <button id="send-btn" type="submit" aria-label="Send">Send</button>
        </form>
      `;
      const editor = setLayoutRect(env.document.getElementById('editor'));
      const sendBtn = setLayoutRect(env.document.getElementById('send-btn'), {
        left: 360,
        top: 500,
        width: 40,
        height: 40,
      });
      const sendClickSpy = vi.fn((e) => e.preventDefault());
      sendBtn.addEventListener('click', sendClickSpy);

      env.document.execCommand = vi.fn(() => false);
      // Controlled editor rejects synthetic paste (e.g. max-length or security policy)
      editor.addEventListener('paste', (ev) => {
        ev.preventDefault();
      });

      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-paste-rejected',
        action: 'fill',
        text: 'Blocked new prompt',
        images: [],
        autoSubmit: true,
      });

      await wait(120);
      expect(editor.textContent).toBe('Existing draft');
      expect(sendClickSpy).not.toHaveBeenCalled();
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          requestId: 'req-paste-rejected',
          provider: CUSTOM_PROVIDER_ID,
          action: 'fill',
          status: 'failed',
          reason: 'injection-error',
          succeededImageIds: [],
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('reports injection-error without forcing raw DOM text nodes when beforeinput is canceled without inserting', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `
        <div id="editor" contenteditable="true" role="textbox"></div>
      `;
      const editor = setLayoutRect(env.document.getElementById('editor'));
      env.document.execCommand = vi.fn(() => false);
      editor.addEventListener('beforeinput', (ev) => {
        ev.preventDefault();
      });

      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-beforeinput-rejected',
        action: 'fill',
        text: 'Rejected prompt',
        images: [],
        autoSubmit: false,
      });

      await wait(120);
      expect(editor.textContent).toBe('');
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          requestId: 'req-beforeinput-rejected',
          provider: CUSTOM_PROVIDER_ID,
          action: 'fill',
          status: 'failed',
          reason: 'injection-error',
          succeededImageIds: [],
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('does not dispatch fallback paste or duplicate text when execCommand auto-formats input (e.g. "# Title" -> "Title")', async () => {
    const env = createDriverEnvironment({ ancestorOrigins: [EXTENSION_ORIGIN] });
    try {
      env.document.body.innerHTML = `
        <div id="editor" contenteditable="true" role="textbox"></div>
      `;
      const editor = setLayoutRect(env.document.getElementById('editor'));
      const pasteSpy = vi.fn((ev) => {
        ev.preventDefault();
        const clip = ev.clipboardData?.getData('text/plain') || '';
        editor.textContent += clip;
      });
      editor.addEventListener('paste', pasteSpy);

      env.document.execCommand = vi.fn((cmd, _ui, val) => {
        if (cmd === 'insertText' && typeof val === 'string') {
          editor.innerHTML = `<h1>${val.replace(/^#\s+/, '')}</h1>`;
          return true;
        }
        return false;
      });

      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-markdown-autoformat',
        action: 'fill',
        text: '# Title',
        images: [],
        autoSubmit: false,
      });

      await wait(120);
      expect(editor.textContent).toBe('Title');
      expect(pasteSpy).not.toHaveBeenCalled();
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          requestId: 'req-markdown-autoformat',
          provider: CUSTOM_PROVIDER_ID,
          action: 'fill',
          status: 'succeeded',
          succeededImageIds: [],
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('replies to PANELIZE_CUSTOM_FRAME_PING and purges only framing-blocked CacheStorage entries inside extension frames', async () => {
    const unregisterMock = vi.fn().mockResolvedValue(true);
    const deleteEntryMock = vi.fn().mockResolvedValue(true);
    const env = createDriverEnvironment({
      url: 'https://www.perplexity.ai/',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    try {
      const poisonedReq = { url: 'https://www.perplexity.ai/spa/index.html' };
      const safeReq = { url: 'https://www.perplexity.ai/static/app.js' };
      Object.defineProperty(env.win.navigator, 'serviceWorker', {
        configurable: true,
        value: {
          getRegistrations: vi.fn().mockResolvedValue([{ unregister: unregisterMock }]),
          addEventListener: vi.fn(),
        },
      });
      Object.defineProperty(env.win, 'caches', {
        configurable: true,
        value: {
          keys: vi.fn().mockResolvedValue(['pplx-html-v2']),
          open: vi.fn().mockResolvedValue({
            keys: vi.fn().mockResolvedValue([poisonedReq, safeReq]),
            match: vi.fn(async (req) => {
              if (req === poisonedReq) {
                return {
                  headers: new Headers({
                    'content-type': 'text/html',
                    'x-frame-options': 'DENY',
                    'content-security-policy': "frame-ancestors 'self'",
                  }),
                };
              }
              return {
                headers: new Headers({ 'content-type': 'application/javascript' }),
              };
            }),
            delete: deleteEntryMock,
          }),
        },
      });

      env.evaluateDriver();
      await wait(30);

      // No unsolicited postMessage before host ping
      expect(env.parent.postMessage).not.toHaveBeenCalled();
      expect(unregisterMock).toHaveBeenCalled();
      expect(deleteEntryMock).toHaveBeenCalledWith(poisonedReq);
      expect(deleteEntryMock).not.toHaveBeenCalledWith(safeReq);

      env.postFromHost({
        type: 'PANELIZE_CUSTOM_FRAME_PING',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'ping-1',
      });

      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_CUSTOM_FRAME_PONG',
          provider: CUSTOM_PROVIDER_ID,
          requestId: 'ping-1',
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_PROVIDER_LOCATION',
          provider: CUSTOM_PROVIDER_ID,
          url: 'https://www.perplexity.ai/',
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('cleans Service Workers and poisoned CacheStorage on __panelize_sw_recover probe URL and reports completion', async () => {
    const unregisterMock = vi.fn().mockResolvedValue(true);
    const deleteEntryMock = vi.fn().mockResolvedValue(true);
    const env = createDriverEnvironment({
      url: 'https://www.perplexity.ai/robots.txt?q=1&__panelize_sw_recover=nonce-42',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    try {
      const poisonedReq = { url: 'https://www.perplexity.ai/spa/index.html' };
      Object.defineProperty(env.win.navigator, 'serviceWorker', {
        configurable: true,
        value: {
          getRegistrations: vi.fn().mockResolvedValue([{ unregister: unregisterMock }]),
        },
      });
      Object.defineProperty(env.win, 'caches', {
        configurable: true,
        value: {
          keys: vi.fn().mockResolvedValue(['pplx-html-v2']),
          open: vi.fn().mockResolvedValue({
            keys: vi.fn().mockResolvedValue([poisonedReq]),
            match: vi.fn().mockResolvedValue({
              headers: new Headers({
                'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
              }),
            }),
            delete: deleteEntryMock,
          }),
        },
      });

      env.evaluateDriver();
      await wait(40);

      expect(unregisterMock).toHaveBeenCalledTimes(1);
      expect(deleteEntryMock).toHaveBeenCalledWith(poisonedReq);
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PANELIZE_CUSTOM_SW_RECOVERED',
          nonce: 'nonce-42',
          origin: 'https://www.perplexity.ai',
          context: 'multi-panel-provider-status',
        }),
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('never touches Service Workers or CacheStorage when unframed or framed by a third-party page', async () => {
    for (const opts of [
      { framed: false, url: 'https://www.perplexity.ai/robots.txt?q=1&__panelize_sw_recover=1' },
      {
        framed: true,
        url: 'https://www.perplexity.ai/robots.txt?q=1&__panelize_sw_recover=1',
        ancestorOrigins: ['https://evil.example'],
      },
    ]) {
      const getRegistrationsMock = vi.fn();
      const cacheKeysMock = vi.fn();
      const env = createDriverEnvironment(opts);
      try {
        Object.defineProperty(env.win.navigator, 'serviceWorker', {
          configurable: true,
          value: { getRegistrations: getRegistrationsMock },
        });
        Object.defineProperty(env.win, 'caches', {
          configurable: true,
          value: { keys: cacheKeysMock },
        });

        env.evaluateDriver();
        await wait(30);

        expect(getRegistrationsMock).not.toHaveBeenCalled();
        expect(cacheKeysMock).not.toHaveBeenCalled();
        expect(env.parent.postMessage).not.toHaveBeenCalled();
      } finally {
        await env.close();
      }
    }
  });

  it('toggles Perplexity-style sticky incognito button on ENABLE_TEMP_CHAT and exits on DISABLE_TEMP_CHAT without double-toggling when already active', async () => {
    const env = createDriverEnvironment({
      url: 'https://www.perplexity.ai/',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    try {
      let isIncognito = false;
      let hydrated = false;
      let clickCount = 0;

      env.document.body.innerHTML = `
        <header id="top-bar">
          <a id="privacy-link" href="https://www.perplexity.ai/hub/privacy" target="_blank">Incognito privacy policy</a>
          <button
            id="incognito-btn"
            type="button"
            aria-label="Use incognito: create anonymous sessions that aren't saved to your history and expire after 24 hours"
          >
            <svg><use xlink:href="#pplx-icon-spy"></use></svg>
          </button>
        </header>
        <div data-composer="true">
          <div id="ask-input" contenteditable="true" role="textbox"></div>
        </div>
      `;

      const incognitoBtn = setLayoutRect(env.document.getElementById('incognito-btn'), {
        left: 440,
        top: 12,
        width: 32,
        height: 32,
      });
      setLayoutRect(env.document.getElementById('privacy-link'), {
        left: 300,
        top: 12,
        width: 120,
        height: 24,
      });
      setLayoutRect(env.document.getElementById('ask-input'));

      const privacyClickSpy = vi.fn((e) => e.preventDefault());
      env.document.getElementById('privacy-link').addEventListener('click', privacyClickSpy);

      const syncUi = () => {
        env.document.cookie = `pplx.is-incognito=${isIncognito ? 'true' : 'false'}; path=/`;
        incognitoBtn.setAttribute(
          'aria-label',
          isIncognito
            ? 'Exit incognito'
            : "Use incognito: create anonymous sessions that aren't saved to your history and expire after 24 hours"
        );
      };
      syncUi();

      incognitoBtn.addEventListener('click', () => {
        clickCount += 1;
        if (!hydrated) {
          return;
        }
        isIncognito = !isIncognito;
        syncUi();
      });

      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      // 1. Pre-hydration click does not flip state -> driver must NOT falsely report enabled yet
      env.postFromHost({
        type: 'ENABLE_TEMP_CHAT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });
      await wait(260);
      expect(clickCount).toBe(1);
      expect(isIncognito).toBe(false);
      expect(
        env.parent.postMessage.mock.calls.some(([msg]) => msg.type === 'PANELIZE_TEMP_CHAT_ENABLED')
      ).toBe(false);

      // 2. Hydrated retry activates incognito and reports PANELIZE_TEMP_CHAT_ENABLED
      hydrated = true;
      env.postFromHost({
        type: 'ENABLE_TEMP_CHAT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });
      await wait(120);
      expect(clickCount).toBe(2);
      expect(isIncognito).toBe(true);
      expect(privacyClickSpy).not.toHaveBeenCalled();
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_TEMP_CHAT_ENABLED',
          provider: CUSTOM_PROVIDER_ID,
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );

      // 3. Subsequent ENABLE_TEMP_CHAT while already active is idempotent (must NOT click Exit incognito)
      env.parent.postMessage.mockClear();
      env.postFromHost({
        type: 'ENABLE_TEMP_CHAT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });
      await wait(80);
      expect(clickCount).toBe(2);
      expect(isIncognito).toBe(true);
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_TEMP_CHAT_ENABLED',
          provider: CUSTOM_PROVIDER_ID,
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );

      // 4. DISABLE_TEMP_CHAT clicks Exit incognito, clears sticky state, and reports PANELIZE_TEMP_CHAT_DISABLED
      env.parent.postMessage.mockClear();
      env.postFromHost({
        type: 'DISABLE_TEMP_CHAT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });
      await wait(120);
      expect(clickCount).toBe(3);
      expect(isIncognito).toBe(false);
      expect(incognitoBtn.getAttribute('aria-label')).toContain('Use incognito');
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_TEMP_CHAT_DISABLED',
          provider: CUSTOM_PROVIDER_ID,
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );

      // 5. Duplicate DISABLE_TEMP_CHAT when already off does NOT re-enable incognito
      env.parent.postMessage.mockClear();
      env.postFromHost({
        type: 'DISABLE_TEMP_CHAT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });
      await wait(80);
      expect(clickCount).toBe(3);
      expect(isIncognito).toBe(false);
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_TEMP_CHAT_DISABLED',
          provider: CUSTOM_PROVIDER_ID,
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('toggles generic aria-pressed / role="switch" temporary chat controls on ENABLE_TEMP_CHAT and DISABLE_TEMP_CHAT', async () => {
    const env = createDriverEnvironment({
      url: 'http://127.0.0.1:3000/',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    try {
      env.document.body.innerHTML = `
        <nav>
          <button id="temp-switch" role="switch" aria-checked="false" aria-label="Temporary Chat">
            Temporary
          </button>
        </nav>
        <textarea id="composer"></textarea>
      `;
      const tempSwitch = setLayoutRect(env.document.getElementById('temp-switch'), {
        left: 600,
        top: 16,
        width: 88,
        height: 30,
      });
      setLayoutRect(env.document.getElementById('composer'));

      tempSwitch.addEventListener('click', () => {
        const next = tempSwitch.getAttribute('aria-checked') !== 'true';
        tempSwitch.setAttribute('aria-checked', next ? 'true' : 'false');
      });

      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      env.postFromHost({
        type: 'ENABLE_TEMP_CHAT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });
      await wait(100);
      expect(tempSwitch.getAttribute('aria-checked')).toBe('true');
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_TEMP_CHAT_ENABLED',
          provider: CUSTOM_PROVIDER_ID,
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );

      env.parent.postMessage.mockClear();
      env.postFromHost({
        type: 'DISABLE_TEMP_CHAT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
      });
      await wait(100);
      expect(tempSwitch.getAttribute('aria-checked')).toBe('false');
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_TEMP_CHAT_DISABLED',
          provider: CUSTOM_PROVIDER_ID,
          context: 'multi-panel-provider-status',
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('uploads multiple images via Perplexity-style <input type="file" multiple>, waits for .png -> .jpg transcoding and disabled preview completion, injects text, and clears attachments on CLEAR_INPUT', async () => {
    const env = createDriverEnvironment({
      url: 'https://www.perplexity.ai/',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    try {
      env.document.body.innerHTML = `
        <div id="composer-shell" style="height:140px">
          <div id="attachment-strip"></div>
          <div data-composer="true">
            <textarea id="composer" placeholder="Ask anything..."></textarea>
          </div>
          <input id="file-input" type="file" multiple accept="image/*,.png,.jpg,.jpeg,.webp" style="display:none" />
          <button id="submit-btn" type="button" aria-label="Submit">Submit</button>
        </div>
      `;

      setLayoutRect(env.document.getElementById('composer-shell'), {
        left: 20,
        top: 420,
        width: 720,
        height: 140,
      });
      const strip = setLayoutRect(env.document.getElementById('attachment-strip'), {
        left: 24,
        top: 424,
        width: 680,
        height: 56,
      });
      const composer = setLayoutRect(env.document.getElementById('composer'));
      const fileInput = env.document.getElementById('file-input');
      setLayoutRect(env.document.getElementById('submit-btn'), {
        left: 680,
        top: 500,
        width: 40,
        height: 36,
      });

      let receivedFiles = [];
      fileInput.addEventListener('change', () => {
        receivedFiles = Array.from(fileInput.files || []);
        for (const file of receivedFiles) {
          const stem = file.name.replace(/\.[^.]+$/, '');
          const chip = env.document.createElement('div');
          chip.className = 'upload-chip';

          const previewBtn = env.document.createElement('button');
          previewBtn.type = 'button';
          previewBtn.disabled = true;
          previewBtn.setAttribute('aria-label', `Preview ${file.name}`);

          const removeBtn = env.document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.setAttribute('aria-label', `Remove ${file.name}`);
          setLayoutRect(removeBtn, { left: 60, top: 428, width: 20, height: 20 });
          removeBtn.addEventListener('click', () => {
            chip.remove();
          });

          chip.append(previewBtn, removeBtn);
          strip.appendChild(chip);

          // Simulate Perplexity's async .png -> .jpg transcode while still disabled, then blob finish
          setTimeout(() => {
            previewBtn.setAttribute('aria-label', `Preview ${stem}.jpg`);
            removeBtn.setAttribute('aria-label', `Remove ${stem}.jpg`);
          }, 60);

          setTimeout(() => {
            const thumb = env.document.createElement('img');
            thumb.setAttribute('src', `blob:https://www.perplexity.ai/${stem}`);
            thumb.setAttribute('alt', `${stem}.jpg`);
            previewBtn.appendChild(thumb);
            previewBtn.disabled = false;
          }, 180);
        }
      });

      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      const pngDataUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-pplx-multi-img',
        action: 'fill',
        text: 'Compare these two charts',
        images: [
          { id: 'img-a', name: 'chart-alpha.png', type: 'image/png', dataUrl: pngDataUrl },
          { id: 'img-b', name: 'chart-beta.png', type: 'image/png', dataUrl: pngDataUrl },
        ],
        autoSubmit: false,
      });

      // Must NOT resolve early at 90ms while previewBtn.disabled is still true
      await wait(90);
      expect(
        env.parent.postMessage.mock.calls.some(([msg]) => msg.type === 'PANELIZE_ACTION_RESULT')
      ).toBe(false);

      await wait(260);
      expect(receivedFiles.map((f) => f.name)).toEqual(['chart-alpha.png', 'chart-beta.png']);
      expect(composer.value).toBe('Compare these two charts');
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          requestId: 'req-pplx-multi-img',
          provider: CUSTOM_PROVIDER_ID,
          action: 'fill',
          status: 'succeeded',
          succeededImageIds: ['img-a', 'img-b'],
        },
        EXTENSION_ORIGIN
      );

      // CLEAR_INPUT with clearImages: true removes both uploaded chips and clears composer text
      env.postFromHost({
        type: 'CLEAR_INPUT',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        clearImages: true,
      });

      await wait(40);
      expect(composer.value).toBe('');
      expect(strip.querySelectorAll('.upload-chip')).toHaveLength(0);
    } finally {
      await env.close();
    }
  });

  it('falls back to ClipboardEvent("paste") for image-only fill when no <input type="file"> exists in DOM', async () => {
    const env = createDriverEnvironment({
      url: 'http://127.0.0.1:3000/chat',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    try {
      env.document.body.innerHTML = `
        <form id="chat-form" style="height:120px">
          <div id="previews"></div>
          <div id="editor" contenteditable="true" role="textbox"></div>
          <button id="send" type="submit">Send</button>
        </form>
      `;
      setLayoutRect(env.document.getElementById('chat-form'), {
        left: 20,
        top: 440,
        width: 680,
        height: 120,
      });
      const previews = env.document.getElementById('previews');
      const editor = setLayoutRect(env.document.getElementById('editor'));
      setLayoutRect(env.document.getElementById('send'), {
        left: 620,
        top: 500,
        width: 60,
        height: 36,
      });

      let pastedFileNames = [];
      editor.addEventListener('paste', (ev) => {
        const files = Array.from(ev.clipboardData?.files || []);
        if (files.length > 0) {
          ev.preventDefault();
          pastedFileNames = files.map((f) => f.name);
          setTimeout(() => {
            for (const file of files) {
              const img = env.document.createElement('img');
              img.setAttribute('src', `blob:http://127.0.0.1:3000/${file.name}`);
              img.setAttribute('alt', file.name);
              previews.appendChild(img);
            }
          }, 50);
        }
      });

      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      const pngDataUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'req-paste-image-only',
        action: 'fill',
        text: '',
        images: [{ id: 'img-paste-1', name: 'pasted.png', type: 'image/png', dataUrl: pngDataUrl }],
        autoSubmit: false,
      });

      await wait(180);
      expect(pastedFileNames).toEqual(['pasted.png']);
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          requestId: 'req-paste-image-only',
          provider: CUSTOM_PROVIDER_ID,
          action: 'fill',
          status: 'succeeded',
          succeededImageIds: ['img-paste-1'],
        },
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });

  it('rejects PANELIZE_SNAPSHOT_PREPARE, SCROLL, and RESTORE from untrusted origins, sources, or contexts', async () => {
    const env = createDriverEnvironment({
      url: 'https://www.perplexity.ai/search/test',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    try {
      env.document.body.innerHTML = `
        <div id="thread" style="overflow-y:auto">
          <div class="group/user-bubble">Prompt</div>
          <textarea id="ask-input"></textarea>
        </div>
      `;
      const thread = env.document.getElementById('thread');
      Object.defineProperties(thread, {
        scrollHeight: { configurable: true, get: () => 2000 },
        clientHeight: { configurable: true, get: () => 700 },
        scrollTop: { configurable: true, value: 900, writable: true },
      });
      setLayoutRect(thread, { left: 0, top: 56, width: 1024, height: 700 });
      setLayoutRect(env.document.getElementById('ask-input'), {
        left: 40,
        top: 660,
        width: 900,
        height: 56,
      });

      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      for (const messageType of [
        'PANELIZE_SNAPSHOT_PREPARE',
        'PANELIZE_SNAPSHOT_SCROLL',
        'PANELIZE_SNAPSHOT_RESTORE',
      ]) {
        env.postFromHost(
          {
            type: messageType,
            context: 'multi-panel',
            providerId: CUSTOM_PROVIDER_ID,
            requestId: `evil-origin-${messageType}`,
            sessionId: 'sess-evil',
            scrollTop: 0,
            stitch: true,
          },
          { origin: 'https://www.perplexity.ai' }
        );
        env.postFromHost(
          {
            type: messageType,
            context: 'multi-panel',
            providerId: CUSTOM_PROVIDER_ID,
            requestId: `evil-source-${messageType}`,
            sessionId: 'sess-evil',
            scrollTop: 0,
            stitch: true,
          },
          { source: env.win }
        );
        env.postFromHost({
          type: messageType,
          context: 'wrong-context',
          providerId: CUSTOM_PROVIDER_ID,
          requestId: `wrong-ctx-${messageType}`,
          sessionId: 'sess-evil',
          scrollTop: 0,
          stitch: true,
        });
      }

      await wait(120);
      expect(thread.scrollTop).toBe(900);
      expect(env.parent.postMessage).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }
  });

  it('prepares, scrolls, quiets Perplexity display:contents composer halo + h-0 scroll-to-end button, un-sticks answer headers, and restores cleanly', async () => {
    const env = createDriverEnvironment({
      url: 'https://www.perplexity.ai/search/deepseek-vs-chatgpt',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    try {
      env.document.body.innerHTML = `
        <header id="top-bar" style="position:fixed;top:0;left:0;right:0;height:56px">Header</header>
        <div id="sources-rail" style="position:absolute;top:56px;right:0;width:336px;height:572px">
          <button type="button">Sources 13</button>
        </div>
        <div id="thread" class="@container/thread" style="overflow-y:auto">
          <div id="earlier-turn" style="height:500px">Earlier answer</div>
          <div id="user-bubble" class="group/user-bubble">DeepSeek 和 ChatGPT，选哪个好</div>
          <div id="answer-body">
            <h2 id="mid-sticky-heading" style="position:sticky;top:0;box-shadow:0 8px 12px rgba(0,0,0,0.25)">按用途怎么选</h2>
            <table>
              <thead>
                <tr><th id="sticky-th" style="position:sticky;top:0">你的主要需求</th></tr>
              </thead>
              <tbody>
                <tr><td>日常办公</td></tr>
              </tbody>
            </table>
          </div>
          <div class="contents" style="display:contents">
            <div id="composer-dock" style="position:sticky;bottom:0">
              <div id="scroll-end-holder" class="pointer-events-none" style="height:0">
                <div id="scroll-end-shift">
                  <button id="scroll-end-btn" type="button" aria-label="Scroll to end">↓</button>
                </div>
              </div>
              <div id="incognito-bar">You're incognito. Exit Incognito</div>
              <div id="composer-halo" style="position:static;box-shadow:0 36px 24px 64px rgb(255, 255, 255)">
                <div id="ask-input" contenteditable="true" role="textbox" aria-label="Ask a follow-up"></div>
              </div>
            </div>
          </div>
        </div>
      `;

      const topBar = env.document.getElementById('top-bar');
      const sourcesRail = env.document.getElementById('sources-rail');
      const thread = env.document.getElementById('thread');
      const userBubble = env.document.getElementById('user-bubble');
      const midHeading = env.document.getElementById('mid-sticky-heading');
      const stickyTh = env.document.getElementById('sticky-th');
      const contentsWrap = env.document.querySelector('.contents');
      const composerDock = env.document.getElementById('composer-dock');
      const scrollEndHolder = env.document.getElementById('scroll-end-holder');
      const scrollEndBtn = env.document.getElementById('scroll-end-btn');
      const incognitoBar = env.document.getElementById('incognito-bar');
      const composerHalo = env.document.getElementById('composer-halo');
      const askInput = env.document.getElementById('ask-input');

      let currentScrollTop = 1688;
      const scrollHeight = 2400;
      const clientHeight = 712; // 768 - 56

      Object.defineProperties(thread, {
        scrollHeight: { configurable: true, get: () => scrollHeight },
        clientHeight: { configurable: true, get: () => clientHeight },
        offsetWidth: { configurable: true, get: () => 1024 },
        clientWidth: { configurable: true, get: () => 1024 },
        scrollTop: {
          configurable: true,
          get: () => currentScrollTop,
          set: (val) => {
            currentScrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, Number(val) || 0));
          },
        },
      });
      thread.scrollTo = ({ top }) => {
        thread.scrollTop = top;
      };

      const makeScrolledRect = (docTop, height, left = 24, width = 960) => () => {
        const top = 56 + docTop - currentScrollTop;
        return {
          x: left,
          y: top,
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
          toJSON() {
            return this;
          },
        };
      };

      setLayoutRect(topBar, { left: 0, top: 0, width: 1024, height: 56 });
      setLayoutRect(sourcesRail, { left: 688, top: 56, width: 336, height: 572 });
      setLayoutRect(thread, { left: 0, top: 56, width: 1024, height: 712 });
      userBubble.getBoundingClientRect = makeScrolledRect(540, 44, 520, 420);
      midHeading.getBoundingClientRect = makeScrolledRect(680, 36);
      stickyTh.getBoundingClientRect = makeScrolledRect(760, 32);

      // `display: contents` returns 0x0 in real Chromium!
      setLayoutRect(contentsWrap, { left: 0, top: 0, width: 0, height: 0 });
      setLayoutRect(composerDock, { left: 24, top: 628, width: 976, height: 140 });
      // `h-0` wrapper has height 0 at top of composerDock, while inner button is `-translate-y-full` inside clip!
      setLayoutRect(scrollEndHolder, { left: 24, top: 628, width: 976, height: 0 });
      setLayoutRect(scrollEndBtn, { left: 496, top: 584, width: 32, height: 32 });
      setLayoutRect(incognitoBar, { left: 24, top: 628, width: 976, height: 32 });
      setLayoutRect(composerHalo, { left: 24, top: 660, width: 976, height: 108 });
      setLayoutRect(askInput, { left: 40, top: 672, width: 900, height: 56 });

      env.win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
      env.evaluateDriver();
      env.parent.postMessage.mockClear();

      // 1. PREPARE (stitch: true, align: true)
      env.postFromHost({
        type: 'PANELIZE_SNAPSHOT_PREPARE',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'snap-prep-1',
        sessionId: 'sess-pplx-1',
        align: true,
        prompt: 'DeepSeek 和 ChatGPT，选哪个好',
        stitch: true,
        hideFloating: true,
        hideCursor: true,
      });

      await wait(280);

      const prepCall = env.parent.postMessage.mock.calls.find(
        ([msg]) => msg.type === 'PANELIZE_SNAPSHOT_STATE' && msg.requestId === 'snap-prep-1'
      );
      expect(prepCall).toBeTruthy();
      expect(prepCall[1]).toBe(EXTENSION_ORIGIN);
      expect(prepCall[0]).toMatchObject({
        type: 'PANELIZE_SNAPSHOT_STATE',
        context: 'multi-panel-snapshot',
        requestId: 'snap-prep-1',
        sessionId: 'sess-pplx-1',
        provider: CUSTOM_PROVIDER_ID,
        matched: true,
        alignedBy: 'prompt',
        scrollTop: 524, // 540 - SNAPSHOT_ALIGN_MARGIN_PX (16)
        maxScrollTop: 1688,
        originalScrollTop: 1688,
        clip: {
          left: 0,
          top: 56,
          right: 1024,
          bottom: 628,
        },
      });

      // Verify Perplexity DOM quirks were handled during snapshot:
      expect(scrollEndHolder.style.getPropertyValue('visibility')).toBe('hidden');
      // Full-height narrow right-hand Sources rail stays visible on Screen 0 (PREPARE)
      expect(sourcesRail.style.getPropertyValue('visibility')).toBe('');
      expect(composerHalo.style.getPropertyValue('box-shadow')).toBe('none');
      expect(midHeading.style.getPropertyValue('position')).toBe('relative');
      expect(midHeading.style.getPropertyValue('box-shadow')).toBe('none');
      expect(stickyTh.style.getPropertyValue('position')).toBe('relative');
      expect(composerDock.style.getPropertyValue('position')).toBe('sticky');
      expect(env.document.documentElement.hasAttribute('data-panelize-snapshot-cursor')).toBe(
        true
      );

      // 2. SCROLL step to next screen and then clamp to maxScrollTop
      env.parent.postMessage.mockClear();
      env.postFromHost({
        type: 'PANELIZE_SNAPSHOT_SCROLL',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'snap-scroll-1',
        sessionId: 'sess-pplx-1',
        scrollTop: 1060,
      });
      await wait(280);

      expect(env.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PANELIZE_SNAPSHOT_STATE',
          requestId: 'snap-scroll-1',
          sessionId: 'sess-pplx-1',
          scrollTop: 1060,
          maxScrollTop: 1688,
        }),
        EXTENSION_ORIGIN
      );
      // On scrolled frames (Screen 1..N), the pinned right-hand Sources rail is hidden so it never repeats!
      expect(sourcesRail.style.getPropertyValue('visibility')).toBe('hidden');

      // Mismatched sessionId returns error: 'no-session' without scrolling
      env.parent.postMessage.mockClear();
      env.postFromHost({
        type: 'PANELIZE_SNAPSHOT_SCROLL',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'snap-scroll-bad-session',
        sessionId: 'wrong-session',
        scrollTop: 0,
      });
      await wait(40);
      expect(currentScrollTop).toBe(1060);
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PANELIZE_SNAPSHOT_STATE',
          requestId: 'snap-scroll-bad-session',
          error: 'no-session',
        }),
        EXTENSION_ORIGIN
      );

      // 3. RESTORE puts back original scrollTop (at end -> 1688) and all styles
      env.parent.postMessage.mockClear();
      env.postFromHost({
        type: 'PANELIZE_SNAPSHOT_RESTORE',
        context: 'multi-panel',
        providerId: CUSTOM_PROVIDER_ID,
        requestId: 'snap-restore-1',
        sessionId: 'sess-pplx-1',
      });
      await wait(180);

      expect(currentScrollTop).toBe(1688);
      expect(scrollEndHolder.style.getPropertyValue('visibility')).toBe('');
      expect(sourcesRail.style.getPropertyValue('visibility')).toBe('');
      expect(composerHalo.style.getPropertyValue('box-shadow')).toBe(
        '0 36px 24px 64px rgb(255, 255, 255)'
      );
      expect(midHeading.style.getPropertyValue('position')).toBe('sticky');
      expect(stickyTh.style.getPropertyValue('position')).toBe('sticky');
      expect(env.document.documentElement.hasAttribute('data-panelize-snapshot-cursor')).toBe(
        false
      );
      expect(env.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PANELIZE_SNAPSHOT_STATE',
          requestId: 'snap-restore-1',
          sessionId: 'sess-pplx-1',
          provider: CUSTOM_PROVIDER_ID,
          restored: true,
        }),
        EXTENSION_ORIGIN
      );
    } finally {
      await env.close();
    }
  });
});
