import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_ORIGIN } from './helpers/multi-panel-messages.js';

const TEXT_INJECTION_SOURCE = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);
const CUSTOM_DRIVER_SOURCE = readFileSync(
  resolve(process.cwd(), 'content-scripts/custom-provider-driver.js'),
  'utf8'
);
const FOCUS_TOGGLE_SOURCE = readFileSync(
  resolve(process.cwd(), 'content-scripts/focus-toggle.js'),
  'utf8'
);

const SAMPLE_IMAGE = {
  name: 'sample.png',
  type: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
};

function markVisible(element, doc) {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => doc.body,
  });
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

function configurePolicyEnvironment(
  win,
  { featurePolicy, permissionsPolicy, userActivation, hasFocus = false } = {}
) {
  win.document.hasFocus = () => hasFocus;

  if (featurePolicy !== undefined) {
    Object.defineProperty(win.document, 'featurePolicy', {
      configurable: true,
      value: featurePolicy,
    });
  }
  if (permissionsPolicy !== undefined) {
    Object.defineProperty(win.document, 'permissionsPolicy', {
      configurable: true,
      value: permissionsPolicy,
    });
  }
  if (userActivation !== undefined) {
    Object.defineProperty(win.navigator, 'userActivation', {
      configurable: true,
      value: userActivation,
    });
  }
}

function createProviderWindow(url, { framed = true, ...policyConfig } = {}) {
  const win = new Window({ url, width: 1024, height: 768 });
  const parent = framed ? { postMessage: vi.fn() } : win.eval('window.parent');
  if (framed) {
    Object.defineProperty(win, 'parent', { configurable: true, value: parent });
    Object.defineProperty(win, 'top', { configurable: true, value: parent });
  }
  win.chrome = {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      onMessage: { addListener: vi.fn() },
    },
  };
  configurePolicyEnvironment(win, policyConfig);

  const postFromHost = (data) => {
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data,
        origin: EXTENSION_ORIGIN,
        source: parent,
      })
    );
  };

  return {
    win,
    document: win.document,
    parent,
    postFromHost,
    async close() {
      await win.happyDOM.close();
    },
  };
}

describe('focus-without-user-activation guard in text-injection-all-providers.js', () => {
  it('calls element.focus() normally when no Permissions Policy API is present (default / top-level)', async () => {
    const env = createProviderWindow('https://gemini.google.com/app');
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello top level',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(editor.textContent).toContain('hello top level');
    } finally {
      await env.close();
    }
  });

  it('calls element.focus() when policy allows focus-without-user-activation', async () => {
    const allowsFeature = vi.fn(() => true);
    const env = createProviderWindow('https://gemini.google.com/app', {
      featurePolicy: {
        features: () => ['clipboard-read', 'focus-without-user-activation'],
        allowsFeature,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello allowed policy',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(allowsFeature).toHaveBeenCalledWith('focus-without-user-activation');
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(editor.textContent).toContain('hello allowed policy');
    } finally {
      await env.close();
    }
  });

  it('does not query allowsFeature() when focus-without-user-activation is unsupported in policy.features()', async () => {
    // In Chromium builds where BlockingFocusWithoutUserActivation is disabled,
    // allowsFeature('focus-without-user-activation') both returns false and logs
    // "Unrecognized feature: 'focus-without-user-activation'."
    const allowsFeature = vi.fn(() => false);
    const env = createProviderWindow('https://gemini.google.com/app', {
      featurePolicy: {
        features: () => ['clipboard-read', 'clipboard-write'],
        allowsFeature,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello unsupported feature',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(allowsFeature).not.toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(editor.textContent).toContain('hello unsupported feature');
    } finally {
      await env.close();
    }
  });

  it('calls element.focus() when policy disallows focus-without-user-activation but userActivation.isActive is true', async () => {
    const env = createProviderWindow('https://gemini.google.com/app', {
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: true, hasBeenActive: true },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello activated iframe',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(editor.textContent).toContain('hello activated iframe');
    } finally {
      await env.close();
    }
  });

  it('allows focus() in a denied iframe when isActive is false but document.hasFocus() is true', async () => {
    const env = createProviderWindow('https://gemini.google.com/app', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: true },
      hasFocus: true,
    });
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello focused iframe',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(editor.textContent).toContain('hello focused iframe');
    } finally {
      await env.close();
    }
  });

  it('allows focus() in a top-level document (window.top === window) even when allowsFeature is false, hasFocus is false, and isActive is false', async () => {
    const env = createProviderWindow('https://gemini.google.com/app', {
      framed: false,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello top frame allowed',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(env.win.top === env.win).toBe(true);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(editor.textContent).toContain('hello top frame allowed');
    } finally {
      await env.close();
    }
  });

  it('skips element.focus() on Gemini contenteditable in a cross-origin iframe when allowsFeature=false, hasFocus=false, and isActive=false, and still injects text cleanly', async () => {
    const env = createProviderWindow('https://gemini.google.com/app', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello guarded gemini',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(env.win.top === env.win).toBe(false);
      expect(focusSpy).not.toHaveBeenCalled();
      expect(editor.textContent).toContain('hello guarded gemini');
    } finally {
      await env.close();
    }
  });

  it('supports document.permissionsPolicy without a features() method and skips focus when disallowed', async () => {
    const allowsFeature = vi.fn(() => false);
    const env = createProviderWindow('https://gemini.google.com/app', {
      framed: true,
      permissionsPolicy: { allowsFeature },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello permissionsPolicy',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(allowsFeature).toHaveBeenCalledWith('focus-without-user-activation');
      expect(focusSpy).not.toHaveBeenCalled();
      expect(editor.textContent).toContain('hello permissionsPolicy');
    } finally {
      await env.close();
    }
  });

  it('skips element.focus() on textarea providers (setFormControlValue) and still sets value cleanly', async () => {
    const env = createProviderWindow('https://chat.deepseek.com/', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <textarea placeholder="Message DeepSeek"></textarea>
      `;
      const textarea = env.document.querySelector('textarea');
      markVisible(textarea, env.document);
      const focusSpy = vi.spyOn(textarea, 'focus');

      env.win.eval(TEXT_INJECTION_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        text: 'hello guarded deepseek',
        autoSubmit: false,
        context: 'multi-panel',
      });

      expect(focusSpy).not.toHaveBeenCalled();
      expect(textarea.value).toBe('hello guarded deepseek');
    } finally {
      await env.close();
    }
  });

  it('skips editor.focus() during Gemini image paste and clear input when disallowed without user activation', async () => {
    const env = createProviderWindow('https://gemini.google.com/app', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="input-area-container">
          <div class="ql-editor" contenteditable="true" role="textbox">existing draft</div>
        </div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');
      const pasteSpy = vi.fn((event) => event.preventDefault());
      editor.addEventListener('paste', pasteSpy);

      env.win.eval(TEXT_INJECTION_SOURCE);

      env.postFromHost({
        type: 'CLEAR_INPUT',
        context: 'multi-panel',
      });
      expect(editor.textContent).toBe('');
      expect(focusSpy).not.toHaveBeenCalled();

      env.postFromHost({
        type: 'INJECT_TEXT_WITH_IMAGES',
        requestId: 'req-gemini-img',
        text: 'describe image',
        images: [SAMPLE_IMAGE],
        autoSubmit: false,
        context: 'multi-panel',
      });

      await vi.waitFor(() => {
        expect(editor.textContent).toContain('describe image');
      }, { timeout: 2000 });

      expect(pasteSpy).toHaveBeenCalledTimes(1);
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }
  });
});

describe('focus-without-user-activation guard in custom-provider-driver.js', () => {
  it('skips focus() when disallowed without user activation or frame focus and still injects into textarea', async () => {
    const env = createProviderWindow('https://custom.example.test/chat', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <form id="chat-form">
          <textarea id="composer" placeholder="Ask anything"></textarea>
          <button id="send-btn" type="submit">Send</button>
        </form>
      `;
      const form = env.document.getElementById('chat-form');
      const composer = env.document.getElementById('composer');
      const sendBtn = env.document.getElementById('send-btn');
      setLayoutRect(form, { top: 480, width: 700, height: 80 });
      setLayoutRect(composer);
      setLayoutRect(sendBtn, { left: 640, width: 60, height: 36 });
      const focusSpy = vi.spyOn(composer, 'focus');

      env.win.eval(CUSTOM_DRIVER_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: 'custom-123',
        requestId: 'req-1',
        text: 'hello custom guarded',
        autoSubmit: false,
      });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

      expect(focusSpy).not.toHaveBeenCalled();
      expect(composer.value).toBe('hello custom guarded');
    } finally {
      await env.close();
    }
  });

  it('skips focus() when disallowed without user activation or frame focus and still injects into contenteditable', async () => {
    const env = createProviderWindow('https://custom.example.test/chat', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div id="composer-wrap">
          <div id="composer" contenteditable="true" role="textbox"></div>
          <button id="send-btn" type="button" aria-label="Send">Send</button>
        </div>
      `;
      const wrap = env.document.getElementById('composer-wrap');
      const composer = env.document.getElementById('composer');
      const sendBtn = env.document.getElementById('send-btn');
      setLayoutRect(wrap, { top: 480, width: 700, height: 80 });
      setLayoutRect(composer);
      setLayoutRect(sendBtn, { left: 640, width: 60, height: 36 });
      const focusSpy = vi.spyOn(composer, 'focus');

      env.win.eval(CUSTOM_DRIVER_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: 'custom-123',
        requestId: 'req-ce',
        text: 'hello custom contenteditable',
        autoSubmit: false,
      });

      await vi.waitFor(() => {
        expect(composer.textContent).toContain('hello custom contenteditable');
      }, { timeout: 2000 });

      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }
  });

  it('calls focus() in custom-provider-driver when document.hasFocus() is true even if userActivation.isActive is false', async () => {
    const env = createProviderWindow('https://custom.example.test/chat', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: true },
      hasFocus: true,
    });
    try {
      env.document.body.innerHTML = `
        <form id="chat-form">
          <textarea id="composer" placeholder="Ask anything"></textarea>
          <button id="send-btn" type="submit">Send</button>
        </form>
      `;
      const form = env.document.getElementById('chat-form');
      const composer = env.document.getElementById('composer');
      const sendBtn = env.document.getElementById('send-btn');
      setLayoutRect(form, { top: 480, width: 700, height: 80 });
      setLayoutRect(composer);
      setLayoutRect(sendBtn, { left: 640, width: 60, height: 36 });
      const focusSpy = vi.spyOn(composer, 'focus');

      env.win.eval(CUSTOM_DRIVER_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: 'custom-123',
        requestId: 'req-has-focus',
        text: 'hello custom focused',
        autoSubmit: false,
      });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(composer.value).toBe('hello custom focused');
    } finally {
      await env.close();
    }
  });

  it('calls focus() in custom-provider-driver when userActivation.isActive is true', async () => {
    const env = createProviderWindow('https://custom.example.test/chat', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: true, hasBeenActive: true },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <form id="chat-form">
          <textarea id="composer" placeholder="Ask anything"></textarea>
          <button id="send-btn" type="submit">Send</button>
        </form>
      `;
      const form = env.document.getElementById('chat-form');
      const composer = env.document.getElementById('composer');
      const sendBtn = env.document.getElementById('send-btn');
      setLayoutRect(form, { top: 480, width: 700, height: 80 });
      setLayoutRect(composer);
      setLayoutRect(sendBtn, { left: 640, width: 60, height: 36 });
      const focusSpy = vi.spyOn(composer, 'focus');

      env.win.eval(CUSTOM_DRIVER_SOURCE);
      env.postFromHost({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        providerId: 'custom-123',
        requestId: 'req-2',
        text: 'hello custom activated',
        autoSubmit: false,
      });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(composer.value).toBe('hello custom activated');
    } finally {
      await env.close();
    }
  });
});

describe('focus-without-user-activation guard in focus-toggle.js', () => {
  it('skips focus and returns success=false when disallowed without user activation or frame focus in a cross-origin iframe', async () => {
    const env = createProviderWindow('https://gemini.google.com/app', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      let listener = null;
      env.win.chrome.runtime.onMessage.addListener = vi.fn((fn) => {
        listener = fn;
      });

      env.win.eval(FOCUS_TOGGLE_SOURCE);
      const sendResponse = vi.fn();
      listener({ action: 'takeFocus' }, {}, sendResponse);

      expect(focusSpy).not.toHaveBeenCalled();
      expect(sendResponse).toHaveBeenCalledWith({ success: false });
    } finally {
      await env.close();
    }
  });

  it('allows focus in a top-level document even when allowsFeature=false, hasFocus=false, and isActive=false', async () => {
    const env = createProviderWindow('https://gemini.google.com/app', {
      framed: false,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => false,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      let listener = null;
      env.win.chrome.runtime.onMessage.addListener = vi.fn((fn) => {
        listener = fn;
      });

      env.win.eval(FOCUS_TOGGLE_SOURCE);
      const sendResponse = vi.fn();
      listener({ action: 'takeFocus' }, {}, sendResponse);

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    } finally {
      await env.close();
    }
  });

  it('focuses and returns success=true when allowed', async () => {
    const env = createProviderWindow('https://gemini.google.com/app', {
      framed: true,
      featurePolicy: {
        features: () => ['focus-without-user-activation'],
        allowsFeature: () => true,
      },
      userActivation: { isActive: false, hasBeenActive: false },
      hasFocus: false,
    });
    try {
      env.document.body.innerHTML = `
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
      `;
      const editor = env.document.querySelector('.ql-editor');
      markVisible(editor, env.document);
      const focusSpy = vi.spyOn(editor, 'focus');

      let listener = null;
      env.win.chrome.runtime.onMessage.addListener = vi.fn((fn) => {
        listener = fn;
      });

      env.win.eval(FOCUS_TOGGLE_SOURCE);
      const sendResponse = vi.fn();
      listener({ action: 'takeFocus' }, {}, sendResponse);

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    } finally {
      await env.close();
    }
  });
});
