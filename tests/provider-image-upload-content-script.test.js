import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

const SAMPLE_IMAGES = [
  {
    name: 'sample-one.png',
    type: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
  },
  {
    name: 'sample-two.png',
    type: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
  },
];

function markVisible(element) {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: 10,
      left: 10,
      right: 100,
      bottom: 40,
      width: 90,
      height: 30,
    }),
  });
}

function dispatchImageInjection({
  images = SAMPLE_IMAGES.slice(0, 1),
  text = '',
  autoSubmit = false,
  requestId,
  retry = false,
} = {}) {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'INJECT_TEXT_WITH_IMAGES',
      context: 'multi-panel',
      images,
      text,
      autoSubmit,
      requestId,
      retry,
    },
  }));
}

async function finishSuccessfulInjection() {
  await vi.advanceTimersByTimeAsync(2500);
}

async function finishTimedOutInjection() {
  await vi.advanceTimersByTimeAsync(7500);
}

function createGrokDom({
  menuAvailable = true,
  includeFileInput = true,
  previewOnChange = true,
  previewOutsideComposer = false,
} = {}) {
  document.body.innerHTML = `
    <form id="grok-composer">
      ${includeFileInput ? '<input id="grok-file" type="file" name="files" multiple />' : ''}
      <div role="list" aria-label="Conversation attachments"></div>
      <div data-testid="chat-input">
        <div class="tiptap ProseMirror" contenteditable="true" aria-label="Ask Grok anything"></div>
      </div>
      <button type="button" data-testid="attach-button" aria-label="Attach">Attach</button>
      <button type="button" aria-label="Send">Send</button>
    </form>
  `;

  const composer = document.getElementById('grok-composer');
  const fileInput = document.getElementById('grok-file');
  const attachButton = composer.querySelector('[aria-label="Attach"]');
  const sendButton = composer.querySelector('[aria-label="Send"]');
  const attachmentList = composer.querySelector('[aria-label="Conversation attachments"]');
  [attachButton, sendButton].forEach(markVisible);

  attachButton.addEventListener('click', () => {
    if (!menuAvailable || document.getElementById('grok-upload-menu-item')) return;
    const item = document.createElement('div');
    item.id = 'grok-upload-menu-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = 'Upload a file';
    markVisible(item);
    document.body.append(item);
  });

  const uploadedNames = [];
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files[0];
    uploadedNames.push(file.name);
    if (!previewOnChange) return;
    if (previewOutsideComposer) {
      const previewButton = document.createElement('button');
      previewButton.type = 'button';
      const image = document.createElement('img');
      image.alt = file.name;
      previewButton.append(image);
      document.body.append(previewButton);
      return;
    }
    const preview = document.createElement('div');
    preview.dataset.fileName = file.name;
    attachmentList.append(preview);
  });

  return { attachmentList, fileInput, sendButton, uploadedNames };
}

function createDeepSeekDom({
  includeFileInput = true,
  previewOnChange = true,
  previewOutsideComposer = false,
} = {}) {
  document.body.innerHTML = `
    <main id="deepseek-composer">
      <textarea placeholder="Message DeepSeek"></textarea>
      ${includeFileInput ? '<input id="deepseek-file" type="file" multiple accept=".png,.jpg,.jpeg,.webp" />' : ''}
      <button type="button" aria-label="Send">Send</button>
      <div id="deepseek-previews"></div>
    </main>
  `;

  const composer = document.getElementById('deepseek-composer');
  const fileInput = document.getElementById('deepseek-file');
  const sendButton = composer.querySelector('[aria-label="Send"]');
  markVisible(sendButton);
  const uploadedNames = [];

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files[0];
    uploadedNames.push(file.name);
    if (!previewOnChange) return;
    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.setAttribute('aria-label', `${file.name} No text extracted`);
    const image = document.createElement('img');
    image.alt = file.name;
    image.src = `blob:https://chat.deepseek.com/${file.name}`;
    previewButton.append(image);
    const previewRoot = previewOutsideComposer
      ? document.body
      : document.getElementById('deepseek-previews');
    previewRoot.append(previewButton);
  });

  return { composer, fileInput, sendButton, uploadedNames };
}

function createKimiDom({
  uploadAvailable = true,
  previewOnChange = true,
  previewDelayMs = 0,
  replacePreviewOnDelay = false,
  language = 'zh',
  remoteErrorPreview = false,
  existingLoadingPreview = false,
  existingPreviewOutcome = null,
  existingPreviewDelayMs = 500,
} = {}) {
  document.body.innerHTML = `
    <div id="chat-box">
      <div class="chat-editor">
        <div class="chat-input-editor" contenteditable="true"></div>
        <div class="toolkit-trigger-btn">+</div>
        <div class="send-button-container">Send</div>
        <div id="kimi-previews"></div>
      </div>
    </div>
  `;

  const composer = document.querySelector('.chat-editor');
  const toolkitTrigger = composer.querySelector('.toolkit-trigger-btn');
  const sendButton = composer.querySelector('.send-button-container');
  [toolkitTrigger, sendButton].forEach(markVisible);
  const uploadedNames = [];

  function appendThumbnail(status, fileName = '') {
    const thumbnail = document.createElement('div');
    thumbnail.className = `image-thumbnail middle ${status}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'image-wrapper image-detail';
    const image = document.createElement('img');
    image.className = 'image-main is-cover';
    if (status === 'success') {
      image.src = `https://www.kimi.com/apiv2-files/sign-obj/${fileName}`;
    } else if (status === 'error') {
      image.src = `https://statics.moonshot.cn/kimi-upload-error/${fileName}`;
    }
    wrapper.append(image);
    thumbnail.append(wrapper);
    document.getElementById('kimi-previews').append(thumbnail);
    return { thumbnail, image };
  }

  if (existingLoadingPreview) {
    const { thumbnail, image } = appendThumbnail('loading', 'existing.png');
    if (existingPreviewOutcome) {
      setTimeout(() => {
        thumbnail.classList.replace('loading', existingPreviewOutcome);
        image.src = existingPreviewOutcome === 'success'
          ? 'https://www.kimi.com/apiv2-files/sign-obj/existing.png'
          : 'https://statics.moonshot.cn/kimi-upload-error/existing.png';
      }, existingPreviewDelayMs);
    }
  }

  toolkitTrigger.addEventListener('click', () => {
    if (!uploadAvailable || document.getElementById('kimi-upload-entry')) return;
    const entry = document.createElement('label');
    entry.id = 'kimi-upload-entry';
    entry.textContent = language === 'en' ? 'Files and images' : '文件和图片';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = '.jpg,.jpeg,.png,.gif,.webp,.svg';
    entry.append(fileInput);
    markVisible(entry);
    document.body.append(entry);

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      uploadedNames.push(file.name);
      if (!previewOnChange) return;
      const outcome = remoteErrorPreview ? 'error' : 'success';
      if (previewDelayMs <= 0) {
        appendThumbnail(outcome, file.name);
        return;
      }

      const { thumbnail, image } = appendThumbnail('loading', file.name);
      setTimeout(() => {
        if (replacePreviewOnDelay) {
          thumbnail.remove();
          appendThumbnail(outcome, file.name);
          return;
        }
        thumbnail.classList.replace('loading', outcome);
        image.src = outcome === 'success'
          ? `https://www.kimi.com/apiv2-files/sign-obj/${file.name}`
          : `https://statics.moonshot.cn/kimi-upload-error/${file.name}`;
      }, previewDelayMs);
    });
  });

  return { composer, sendButton, uploadedNames };
}

describe('provider image upload adapters', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
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

  it('uploads one Grok image through the native composer input and waits for its attachment preview', async () => {
    window.happyDOM.setURL('https://grok.com/');
    const { attachmentList, uploadedNames } = createGrokDom();

    dispatchImageInjection();
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual(['sample-one.png']);
    expect(attachmentList.children).toHaveLength(1);
  });

  it('verifies every Grok image in a multi-image fill', async () => {
    window.happyDOM.setURL('https://grok.com/');
    const { attachmentList, uploadedNames } = createGrokDom();

    dispatchImageInjection({ images: SAMPLE_IMAGES });
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual(['sample-one.png', 'sample-two.png']);
    expect(attachmentList.children).toHaveLength(2);
  });

  it('uses Grok composer input when its synthetic attach click does not open the menu', async () => {
    window.happyDOM.setURL('https://grok.com/');
    const { uploadedNames } = createGrokDom({ menuAvailable: false });

    dispatchImageInjection();
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual(['sample-one.png']);
  });

  it('accepts a Grok filename preview rendered outside the composer form', async () => {
    window.happyDOM.setURL('https://grok.com/');
    createGrokDom({ previewOutsideComposer: true });

    dispatchImageInjection({ requestId: 'fill-request-grok-portal-preview' });
    await finishSuccessfulInjection();

    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-grok-portal-preview',
      provider: 'grok',
      action: 'fill',
      status: 'succeeded',
    }, '*');
  });

  it('keeps Grok text and does not submit when the attachment preview times out', async () => {
    window.happyDOM.setURL('https://grok.com/');
    const { sendButton } = createGrokDom({ previewOnChange: false });
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);

    dispatchImageInjection({ text: 'keep this text', autoSubmit: true });
    await finishTimedOutInjection();

    expect(document.querySelector('.tiptap').textContent).toContain('keep this text');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does not fall back to an unrelated Grok file input outside the composer', async () => {
    window.happyDOM.setURL('https://grok.com/');
    const { uploadedNames } = createGrokDom({ includeFileInput: false });
    const unrelatedInput = document.createElement('input');
    unrelatedInput.type = 'file';
    unrelatedInput.multiple = true;
    document.body.append(unrelatedInput);

    dispatchImageInjection();
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual([]);
    expect(unrelatedInput.files).toHaveLength(0);
  });

  it('uploads one DeepSeek image through the composer-scoped multiple input', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    const { composer, uploadedNames } = createDeepSeekDom();

    dispatchImageInjection();
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual(['sample-one.png']);
    expect(composer.querySelector('img[alt="sample-one.png"]')).not.toBeNull();
  });

  it('verifies every DeepSeek image in a multi-image fill', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    const { composer, uploadedNames } = createDeepSeekDom();

    dispatchImageInjection({ images: SAMPLE_IMAGES });
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual(['sample-one.png', 'sample-two.png']);
    expect(composer.querySelectorAll('#deepseek-previews img')).toHaveLength(2);
  });

  it('accepts a DeepSeek filename preview rendered outside the composer ancestor', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    createDeepSeekDom({ previewOutsideComposer: true });

    dispatchImageInjection({ requestId: 'fill-request-deepseek-portal-preview' });
    await finishSuccessfulInjection();

    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-deepseek-portal-preview',
      provider: 'deepseek',
      action: 'fill',
      status: 'succeeded',
    }, '*');
  });

  it('keeps DeepSeek text and does not submit when the attachment preview times out', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    const { sendButton } = createDeepSeekDom({ previewOnChange: false });
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);

    dispatchImageInjection({ text: 'keep this text', autoSubmit: true });
    await finishTimedOutInjection();

    expect(document.querySelector('textarea').value).toContain('keep this text');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does not fall back to a generic DeepSeek page input when the composer input is missing', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    const { uploadedNames } = createDeepSeekDom({ includeFileInput: false });
    const unrelatedInput = document.createElement('input');
    unrelatedInput.type = 'file';
    unrelatedInput.multiple = true;
    document.body.append(unrelatedInput);

    dispatchImageInjection();
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual([]);
    expect(unrelatedInput.files).toHaveLength(0);
  });

  it.each([
    ['Chinese', 'zh'],
    ['English', 'en'],
  ])('uploads one Kimi image through the native %s toolkit entry', async (_name, language) => {
    window.happyDOM.setURL('https://www.kimi.com/');
    const { composer, uploadedNames } = createKimiDom({ language });

    dispatchImageInjection();
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual(['sample-one.png']);
    expect(composer.querySelector('.image-thumbnail.success img.image-main')).not.toBeNull();
  });

  it('verifies every Kimi image in a multi-image fill', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    const { composer, uploadedNames } = createKimiDom();

    dispatchImageInjection({ images: SAMPLE_IMAGES });
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual(['sample-one.png', 'sample-two.png']);
    expect(composer.querySelectorAll('.image-thumbnail.success img.image-main')).toHaveLength(2);
  });

  it('does not accept an unnamed Kimi remote error thumbnail as a successful preview', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    const { sendButton } = createKimiDom({ remoteErrorPreview: true });
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);

    dispatchImageInjection({
      requestId: 'fill-request-kimi-error-thumbnail',
      autoSubmit: true,
    });
    await finishTimedOutInjection();

    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-kimi-error-thumbnail',
      provider: 'kimi',
      action: 'fill',
      status: 'failed',
      reason: 'preview-timeout',
    }, '*');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('reconciles an in-flight Kimi upload without injecting the image twice', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    const { uploadedNames } = createKimiDom({
      existingLoadingPreview: true,
      existingPreviewOutcome: 'success',
    });

    dispatchImageInjection({ requestId: 'fill-request-kimi-pending-success' });
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual([]);
    expect(document.querySelectorAll('.image-thumbnail.success')).toHaveLength(1);
    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-kimi-pending-success',
      provider: 'kimi',
      action: 'fill',
      status: 'succeeded',
    }, '*');
  });

  it('does not duplicate a Kimi upload that remains in progress', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    const { uploadedNames } = createKimiDom({ existingLoadingPreview: true });

    dispatchImageInjection({ requestId: 'fill-request-kimi-pending-timeout' });
    await finishTimedOutInjection();

    expect(uploadedNames).toEqual([]);
    expect(document.querySelectorAll('.image-thumbnail.loading')).toHaveLength(1);
    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-kimi-pending-timeout',
      provider: 'kimi',
      action: 'fill',
      status: 'failed',
      reason: 'preview-timeout',
    }, '*');
  });

  it('reconciles a Kimi upload that succeeds after the first fill times out', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    const { uploadedNames } = createKimiDom({
      previewDelayMs: 6500,
      replacePreviewOnDelay: true,
    });

    dispatchImageInjection({ requestId: 'fill-request-kimi-late-success' });
    await finishTimedOutInjection();

    expect(uploadedNames).toEqual(['sample-one.png']);
    expect(document.querySelectorAll('.image-thumbnail.success')).toHaveLength(1);
    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-kimi-late-success',
      provider: 'kimi',
      action: 'fill',
      status: 'failed',
      reason: 'preview-timeout',
    }, '*');

    window.parent.postMessage.mockClear();
    dispatchImageInjection({
      requestId: 'fill-request-kimi-late-success-retry',
      retry: true,
    });
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual(['sample-one.png']);
    expect(document.querySelectorAll('.image-thumbnail.success')).toHaveLength(1);
    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-kimi-late-success-retry',
      provider: 'kimi',
      action: 'fill',
      status: 'succeeded',
    }, '*');
  });

  it('keeps Kimi text and does not submit when the attachment preview times out', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    const { sendButton } = createKimiDom({ previewOnChange: false });
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);

    dispatchImageInjection({ text: 'keep this text', autoSubmit: true });
    await finishTimedOutInjection();

    expect(document.querySelector('.chat-input-editor').textContent).toContain('keep this text');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('reports Kimi as unsupported when the native files and images entry is unavailable', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    const { uploadedNames } = createKimiDom({ uploadAvailable: false });

    dispatchImageInjection();
    await finishSuccessfulInjection();

    expect(uploadedNames).toEqual([]);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('acknowledges a verified image fill with its request ID and provider', async () => {
    window.happyDOM.setURL('https://grok.com/');
    createGrokDom();

    dispatchImageInjection({ requestId: 'fill-request-success' });
    await finishSuccessfulInjection();

    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-success',
      provider: 'grok',
      action: 'fill',
      status: 'succeeded',
    }, '*');
  });

  it('acknowledges an unsupported Kimi image fill without claiming success', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    createKimiDom({ uploadAvailable: false });

    dispatchImageInjection({ requestId: 'fill-request-unsupported' });
    await finishSuccessfulInjection();

    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-unsupported',
      provider: 'kimi',
      action: 'fill',
      status: 'failed',
      reason: 'unsupported',
    }, '*');
  });

  it('acknowledges a preview timeout and keeps the failed fill unsent', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    const { sendButton } = createDeepSeekDom({ previewOnChange: false });
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);

    dispatchImageInjection({
      requestId: 'fill-request-timeout',
      text: 'keep this text',
      autoSubmit: true,
    });
    await finishTimedOutInjection();

    expect(window.parent.postMessage).toHaveBeenCalledWith({
      type: 'PANELIZE_ACTION_RESULT',
      context: 'multi-panel-action-result',
      requestId: 'fill-request-timeout',
      provider: 'deepseek',
      action: 'fill',
      status: 'failed',
      reason: 'preview-timeout',
    }, '*');
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
