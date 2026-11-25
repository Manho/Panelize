import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_ORIGIN, dispatchMultiPanelMessage } from './helpers/multi-panel-messages.js';

const chatgptComposerSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/chatgpt-composer.js'),
  'utf8'
);
const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=';

function makePng(id = 'img-mizuho', name = 'Mizuho.png') {
  return { id, kind: 'image', name, type: 'image/png', ext: '.png', size: 68, dataUrl: PNG_DATA_URL };
}

function makeDocx(id = 'doc-kyoto', name = '日本中部京都红叶之旅_图文行程(1).docx') {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]).buffer;
  return {
    id,
    kind: 'document',
    name,
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
    size: bytes.byteLength,
    isPlainText: false,
    bytes,
  };
}

function markVisible(element) {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
}

/**
 * Mounts the composer `<form>` captured on live chatgpt.com (2026-11): a mobile
 * camera-capture input comes first in DOM order, and the multi-file
 * "Attach files" input (empty accept) comes last.
 */
function mountLiveComposer({ text = '' } = {}) {
  document.body.innerHTML = `
    <form data-type="unified-composer" data-chatgpt-composer data-composer-placement="thread">
      <div id="attachment-tray"></div>
      <input id="_r_v_" class="hidden" accept="image/*" aria-label="Take a photo" capture="environment" type="file">
      <input id="_r_11_" accept="image/*,video/*" aria-label="Attach photos or videos" class="hidden" multiple type="file">
      <input id="_r_10_" accept="image/*" aria-label="Attach photos" class="hidden" multiple type="file">
      <input id="_r_u_" accept="" aria-label="Attach files" class="hidden" multiple type="file">
      <div data-composer-markdown contenteditable="true" role="textbox" class="ProseMirror">${text ? `<p>${text}</p>` : ''}</div>
      <button type="submit" aria-label="Send">Send</button>
    </form>
  `;
  markVisible(document.querySelector('[data-composer-markdown]'));
  return document.querySelector('form');
}

function renderChatgptCard(displayName, { isImage, failed = false }) {
  const card = document.createElement('div');
  if (isImage) {
    card.className = 'composer-attachment-surface';
    card.innerHTML = `<img alt="${displayName}" src="${PNG_DATA_URL}"><button type="button" aria-label="Remove ${displayName}">x</button>`;
  } else {
    card.className = 'group/composer-attachment relative block';
    card.innerHTML = `<div class="truncate">${displayName}</div><div>Document</div><button type="button" aria-label="Remove ${displayName}">x</button>`;
  }
  if (failed) {
    card.insertAdjacentHTML('beforeend', '<div class="text-token-text-error">Upload failed</div>');
  }
  document.getElementById('attachment-tray').append(card);
  return card;
}

/**
 * Simulates ChatGPT's React onChange on every composer file input. `dropFirst`
 * ignores the first N change events, as an unhydrated composer does right
 * after reload or New Chat. `rename` mimics ChatGPT's duplicate suffixes.
 */
function installChatgptUploadHandler({
  dropFirst = 0,
  rename = name => name,
  delayMs = 0,
  failed = false,
} = {}) {
  const changes = [];
  let remainingDrops = dropFirst;
  document.querySelectorAll('form input[type="file"]').forEach(input => {
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      changes.push({ inputId: input.id, names: files.map(file => file.name) });
      if (remainingDrops > 0) {
        remainingDrops -= 1;
        return;
      }
      const mount = () => files.forEach(file => renderChatgptCard(rename(file.name), {
        isImage: file.type.startsWith('image/'),
        failed,
      }));
      if (delayMs > 0) {
        setTimeout(mount, delayMs);
      } else {
        mount();
      }
    });
  });
  return changes;
}

function dispatchFill({
  attachments,
  fallbackAttachments,
  text = '',
  requestId,
  retry = false,
}) {
  dispatchMultiPanelMessage({
    type: 'INJECT_TEXT_WITH_IMAGES',
    context: 'multi-panel',
    images: attachments.filter(a => a.kind === 'image'),
    attachments,
    ...(fallbackAttachments ? { fallbackAttachments } : {}),
    text,
    autoSubmit: false,
    requestId,
    retry,
  });
}

function getActionResult(requestId) {
  const call = window.parent.postMessage.mock.calls.find(
    ([message]) => message?.type === 'PANELIZE_ACTION_RESULT' && message.requestId === requestId
  );
  return call ? call[0] : null;
}

function countCards() {
  return document.querySelectorAll('#attachment-tray > *').length;
}

describe('ChatGPT attachment upload (live composer DOM)', () => {
  beforeAll(() => {
    window.eval(chatgptComposerSource);
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://chatgpt.com/');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it.each([
    ['PNG', makePng()],
    ['DOCX', makeDocx()],
  ])('skips the camera-capture input and uploads %s through "Attach files"', async (_label, attachment) => {
    mountLiveComposer();
    const changes = installChatgptUploadHandler();

    dispatchFill({ attachments: [attachment], requestId: `chatgpt-select-${attachment.id}` });
    await vi.advanceTimersByTimeAsync(3000);

    expect(changes).toEqual([{ inputId: '_r_u_', names: [attachment.name] }]);
    expect(getActionResult(`chatgpt-select-${attachment.id}`)).toMatchObject({
      provider: 'chatgpt',
      status: 'succeeded',
      succeededAttachmentIds: [attachment.id],
    });
  });

  it('confirms duplicate-suffixed and CJK previews ("Remove Mizuho(4).png", Kyoto DOCX)', async () => {
    mountLiveComposer();
    const changes = installChatgptUploadHandler({
      rename: name => (name === 'Mizuho.png' ? 'Mizuho(4).png' : name),
    });
    const png = makePng();
    const docx = makeDocx();

    dispatchFill({ attachments: [png, docx], requestId: 'chatgpt-suffix' });
    await vi.advanceTimersByTimeAsync(3000);

    expect(changes.map(change => change.names[0])).toEqual(['Mizuho.png', docx.name]);
    expect(document.querySelector('button[aria-label="Remove Mizuho(4).png"]')).not.toBeNull();
    expect(getActionResult('chatgpt-suffix')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: [png.id, docx.id],
    });
  });

  it('reports preview-timeout after one bounded retry when ChatGPT ignores the change event', async () => {
    mountLiveComposer();
    const changes = installChatgptUploadHandler({ dropFirst: Infinity });

    dispatchFill({ attachments: [makePng()], requestId: 'chatgpt-dropped' });
    await vi.advanceTimersByTimeAsync(7000);

    expect(changes).toHaveLength(2);
    expect(changes.every(change => change.inputId === '_r_u_')).toBe(true);
    expect(getActionResult('chatgpt-dropped')).toMatchObject({
      status: 'failed',
      reason: 'preview-timeout',
      succeededAttachmentIds: [],
    });
  });

  it('does not count an errored attachment card as a staged preview', async () => {
    mountLiveComposer();
    installChatgptUploadHandler({ failed: true });

    dispatchFill({ attachments: [makeDocx()], requestId: 'chatgpt-errored-card' });
    await vi.advanceTimersByTimeAsync(7000);

    expect(getActionResult('chatgpt-errored-card')).toMatchObject({
      status: 'failed',
      reason: 'preview-timeout',
    });
  });

  it('retries once when the first change is dropped during hydration, without duplicating the attachment', async () => {
    mountLiveComposer();
    const changes = installChatgptUploadHandler({ dropFirst: 1 });

    dispatchFill({ attachments: [makePng()], requestId: 'chatgpt-hydration' });
    await vi.advanceTimersByTimeAsync(7000);

    expect(changes).toHaveLength(2);
    expect(countCards()).toBe(1);
    expect(getActionResult('chatgpt-hydration')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: ['img-mizuho'],
    });
  });

  it('does not re-dispatch when a slow preview lands before the retry', async () => {
    mountLiveComposer();
    const changes = installChatgptUploadHandler({ delayMs: 2600 });

    dispatchFill({ attachments: [makeDocx()], requestId: 'chatgpt-slow-preview' });
    await vi.advanceTimersByTimeAsync(7000);

    expect(changes).toHaveLength(1);
    expect(countCards()).toBe(1);
    expect(getActionResult('chatgpt-slow-preview')).toMatchObject({ status: 'succeeded' });
  });

  it('re-uploads every fallback attachment when the composer was cleared before a retry', async () => {
    mountLiveComposer();
    const changes = installChatgptUploadHandler();
    const png = makePng();
    const docx = makeDocx();

    dispatchFill({
      attachments: [],
      fallbackAttachments: [png, docx],
      requestId: 'chatgpt-cleared-retry',
      retry: true,
    });
    await vi.advanceTimersByTimeAsync(7000);

    expect(changes.map(change => change.names[0])).toEqual(['Mizuho.png', docx.name]);
    expect(countCards()).toBe(2);
    expect(getActionResult('chatgpt-cleared-retry')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: [png.id, docx.id],
    });
  });

  it('re-uploads only the missing fallback attachment when a suffixed image is still staged', async () => {
    mountLiveComposer();
    renderChatgptCard('Mizuho(4).png', { isImage: true });
    const changes = installChatgptUploadHandler();
    const png = makePng();
    const docx = makeDocx();

    dispatchFill({
      attachments: [],
      fallbackAttachments: [png, docx],
      requestId: 'chatgpt-partial-retry',
      retry: true,
    });
    await vi.advanceTimersByTimeAsync(7000);

    expect(changes).toEqual([{ inputId: '_r_u_', names: [docx.name] }]);
    expect(countCards()).toBe(2);
    expect(getActionResult('chatgpt-partial-retry')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: [png.id, docx.id],
    });
  });

  it('acknowledges a late preview on Retry Failed instead of uploading the file again', async () => {
    mountLiveComposer();
    const changes = installChatgptUploadHandler({ dropFirst: Infinity });
    const png = makePng();

    dispatchFill({ attachments: [png], text: 'Describe this', requestId: 'chatgpt-first-fill' });
    await vi.advanceTimersByTimeAsync(7000);
    expect(getActionResult('chatgpt-first-fill')).toMatchObject({
      status: 'failed',
      reason: 'preview-timeout',
    });
    const dispatchesBeforeRetry = changes.length;

    // ChatGPT finally renders the earlier upload before the user clicks Retry Failed.
    renderChatgptCard('Mizuho.png', { isImage: true });

    dispatchFill({
      attachments: [png],
      fallbackAttachments: [png],
      text: 'Describe this',
      requestId: 'chatgpt-retry-failed',
      retry: true,
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(changes).toHaveLength(dispatchesBeforeRetry);
    expect(countCards()).toBe(1);
    expect(getActionResult('chatgpt-retry-failed')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: [png.id],
    });
  });

  it('does not confirm a pending file with a late card that names a different file', async () => {
    mountLiveComposer();
    const png = makePng('one', 'one.png');
    const docx = makeDocx('two', 'two.docx');
    const changes = [];
    document.getElementById('_r_u_').addEventListener('change', event => {
      const name = event.target.files[0].name;
      changes.push(name);
      // The PNG preview lands after the first attempt times out, so the retry
      // dispatches it twice; the DOCX change is dropped entirely.
      if (name === 'one.png') {
        setTimeout(() => renderChatgptCard(name, { isImage: true }), 3050);
      }
    });

    dispatchFill({ attachments: [png, docx], requestId: 'chatgpt-foreign-late-card' });
    await vi.advanceTimersByTimeAsync(12000);

    expect(changes.filter(name => name === 'one.png')).toHaveLength(2);
    expect(changes).toContain('two.docx');
    expect(document.querySelector('button[aria-label="Remove two.docx"]')).toBeNull();
    expect(getActionResult('chatgpt-foreign-late-card')).toMatchObject({
      status: 'failed',
      succeededAttachmentIds: ['one'],
    });
  });

  it('treats a card with an explicit error marker and localized failure text as rejected', async () => {
    mountLiveComposer();
    const docx = makeDocx();
    document.getElementById('_r_u_').addEventListener('change', () => {
      const card = renderChatgptCard(docx.name, { isImage: false, failed: true });
      card.querySelector('.text-token-text-error').textContent = '上传失败';
    });

    dispatchFill({ attachments: [docx], requestId: 'chatgpt-localized-rejected' });
    await vi.advanceTimersByTimeAsync(7000);

    expect(getActionResult('chatgpt-localized-rejected')).toMatchObject({
      status: 'failed',
      reason: 'preview-timeout',
    });
  });

  it('confirms the retry preview inside a composer form remounted during hydration', async () => {
    mountLiveComposer();
    const firstChanges = installChatgptUploadHandler({ dropFirst: Infinity });

    dispatchFill({ attachments: [makePng()], requestId: 'chatgpt-form-remount' });
    await vi.advanceTimersByTimeAsync(500);
    expect(firstChanges).toHaveLength(1);

    // React hydration replaces the whole composer form before the retry.
    mountLiveComposer();
    const secondChanges = installChatgptUploadHandler();
    await vi.advanceTimersByTimeAsync(6500);

    expect(secondChanges).toEqual([{ inputId: '_r_u_', names: ['Mizuho.png'] }]);
    expect(countCards()).toBe(1);
    expect(getActionResult('chatgpt-form-remount')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: ['img-mizuho'],
    });
  });

  it('does not re-dispatch when the first preview lands in a remounted composer form', async () => {
    mountLiveComposer();
    installChatgptUploadHandler({ dropFirst: Infinity });

    dispatchFill({ attachments: [makePng()], requestId: 'chatgpt-remount-landed' });
    await vi.advanceTimersByTimeAsync(500);

    // React remounts the form and renders the first attempt's card into the new tray.
    mountLiveComposer();
    renderChatgptCard('Mizuho.png', { isImage: true });
    const secondChanges = installChatgptUploadHandler();
    await vi.advanceTimersByTimeAsync(6500);

    expect(secondChanges).toEqual([]);
    expect(countCards()).toBe(1);
    expect(getActionResult('chatgpt-remount-landed')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: ['img-mizuho'],
    });
  });

  it('claims each retained card for one fallback ID, preferring exact names over suffixes', async () => {
    mountLiveComposer();
    const original = makePng('original', 'Mizuho.png');
    const numbered = makePng('numbered', 'Mizuho(4).png');
    const changes = installChatgptUploadHandler();

    dispatchFill({ attachments: [original, numbered], requestId: 'chatgpt-collision-fill' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(countCards()).toBe(2);
    expect(getActionResult('chatgpt-collision-fill')).toMatchObject({ status: 'succeeded' });

    document.querySelector('button[aria-label="Remove Mizuho.png"]').parentElement.remove();
    dispatchFill({
      attachments: [],
      fallbackAttachments: [original, numbered],
      retry: true,
      requestId: 'chatgpt-collision-retry',
    });
    await vi.advanceTimersByTimeAsync(7000);

    expect(changes.map(change => change.names[0])).toEqual(['Mizuho.png', 'Mizuho(4).png', 'Mizuho.png']);
    expect(countCards()).toBe(2);
    expect(getActionResult('chatgpt-collision-retry')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: ['original', 'numbered'],
    });
  });

  it('keeps an image staged as a named composer thumbnail on an empty-editor retry', async () => {
    mountLiveComposer();
    const png = makePng();
    const changes = [];
    document.getElementById('_r_u_').addEventListener('change', event => {
      const img = document.createElement('img');
      img.alt = event.target.files[0].name;
      img.src = PNG_DATA_URL;
      document.getElementById('attachment-tray').append(img);
      changes.push(img.alt);
    });

    dispatchFill({ attachments: [png], requestId: 'chatgpt-thumbnail-fill' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(getActionResult('chatgpt-thumbnail-fill')).toMatchObject({ status: 'succeeded' });

    dispatchFill({
      attachments: [],
      fallbackAttachments: [png],
      retry: true,
      requestId: 'chatgpt-thumbnail-retry',
    });
    await vi.advanceTimersByTimeAsync(7000);

    expect(changes).toEqual([png.name]);
    expect(getActionResult('chatgpt-thumbnail-retry')).toMatchObject({
      status: 'succeeded',
      succeededAttachmentIds: [png.id],
    });
  });
});
