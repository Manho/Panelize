import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

const CONTAINER = { top: 40, left: 0, width: 800, height: 700, scrollHeight: 4000 };

function rect({ top, left = 0, width, height }) {
  return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

function setStaticRect(element, box) {
  element.getBoundingClientRect = () => rect(box);
}

/**
 * Builds a conversation in a scrolling container with stubbed geometry:
 * happy-dom has no layout, so each message gets a fixed offset in the
 * scrolled content.
 */
function createConversation(messages, { stickyHeader = true, composer = true } = {}) {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.style.overflowY = 'auto';
  let scrollTop = 0;
  Object.defineProperties(container, {
    scrollTop: { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = value; } },
    scrollHeight: { configurable: true, get: () => CONTAINER.scrollHeight },
    clientHeight: { configurable: true, get: () => CONTAINER.height },
    clientWidth: { configurable: true, get: () => CONTAINER.width },
    clientTop: { configurable: true, get: () => 0 },
    clientLeft: { configurable: true, get: () => 0 }
  });
  container.scrollTo = ({ top }) => { scrollTop = top; };
  setStaticRect(container, CONTAINER);

  if (stickyHeader) {
    const header = document.createElement('header');
    header.style.position = 'sticky';
    header.textContent = 'Model picker';
    // Stuck to the top; once un-stuck, at the start of the content.
    header.getBoundingClientRect = () => rect({
      top: CONTAINER.top - (header.style.position === 'sticky' ? 0 : scrollTop), width: CONTAINER.width, height: 56
    });
    container.appendChild(header);
  }

  const elements = messages.map(({ text, offset, tag = 'div', attributes = {} }) => {
    const element = document.createElement(tag);
    element.textContent = text;
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    element.getBoundingClientRect = () => rect({
      top: CONTAINER.top + offset - scrollTop, width: 600, height: 40
    });
    container.appendChild(element);
    return element;
  });

  if (composer) {
    const box = document.createElement('div');
    box.style.position = 'sticky';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Message DeepSeek';
    box.appendChild(textarea);
    // Stuck to the bottom; once un-stuck, at the end of the content.
    box.getBoundingClientRect = () => rect({
      top: CONTAINER.top + (box.style.position === 'sticky' ? CONTAINER.height : CONTAINER.scrollHeight - scrollTop) - 120,
      width: CONTAINER.width,
      height: 120
    });
    setStaticRect(textarea, { top: CONTAINER.top + CONTAINER.height - 100, left: 20, width: 760, height: 60 });
    container.appendChild(box);
  }

  document.body.appendChild(container);
  return { container, elements, getScrollTop: () => scrollTop, setScrollTop: (value) => { scrollTop = value; } };
}

let nextRequestId = 0;

function sendSnapshotMessage(data, { source = window } = {}) {
  const requestId = `request-${nextRequestId += 1}`;
  const reply = new Promise((resolvePromise) => {
    const listener = (event) => {
      if (event.data?.type === 'PANELIZE_SNAPSHOT_STATE' && event.data.requestId === requestId) {
        window.removeEventListener('message', listener);
        resolvePromise(event.data);
      }
    };
    window.addEventListener('message', listener);
  });
  window.dispatchEvent(new MessageEvent('message', {
    data: { context: 'multi-panel', requestId, ...data },
    source
  }));
  return reply;
}

const prepare = (prompt, extra = {}) => sendSnapshotMessage({
  type: 'PANELIZE_SNAPSHOT_PREPARE', sessionId: 'session-1', prompt, align: true, ...extra
});

describe('snapshot scroll protocol in provider frames', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
  });

  it('scrolls the latest matching user message under the sticky header', async () => {
    const { elements, getScrollTop } = createConversation([
      { text: 'Explain how HTTPS works in detail', offset: 300 },
      { text: 'An older answer', offset: 500 },
      { text: 'Explain how HTTPS works in detail', offset: 2200 },
      { text: 'The newest answer', offset: 2300 }
    ]);

    const state = await prepare('Explain how HTTPS works in detail');

    expect(state).toMatchObject({ matched: true, alignedBy: 'prompt', originalScrollTop: 0, sessionId: 'session-1', provider: 'deepseek' });
    // Sticky header (56px) and composer (120px) are cut from the clip.
    expect(state.clip).toEqual({ left: 0, top: CONTAINER.top + 56, right: 800, bottom: CONTAINER.top + CONTAINER.height - 120 });
    expect(getScrollTop()).toBe(2200 - 56 - 16);
    expect(elements[2].getBoundingClientRect().top).toBe(state.clip.top + 16);
    expect(state.scrollTop).toBe(getScrollTop());
    expect(state.maxScrollTop).toBe(CONTAINER.scrollHeight - CONTAINER.height);
  });

  it('keeps a side rail out of the clip when the box beside it is scrolled sideways', async () => {
    const { container } = createConversation([
      { text: 'Explain how HTTPS works in detail', offset: 300 },
      { text: 'The newest answer', offset: 400 }
    ]);
    // Like signed-in Qwen in a narrow panel: the content box beside a 60px
    // rail is scrolled 30px sideways, so the conversation starts under it.
    const rail = document.createElement('nav');
    setStaticRect(rail, { top: 0, left: 0, width: 60, height: 800 });
    const content = document.createElement('div');
    content.style.overflowX = 'auto';
    content.style.overflowY = 'auto';
    Object.defineProperties(content, {
      clientWidth: { configurable: true, get: () => 740 },
      clientHeight: { configurable: true, get: () => 800 },
      clientTop: { configurable: true, get: () => 0 },
      clientLeft: { configurable: true, get: () => 0 }
    });
    setStaticRect(content, { top: 0, left: 60, width: 740, height: 800 });
    setStaticRect(container, { ...CONTAINER, left: 30 });
    document.body.append(rail, content);
    content.appendChild(container);

    const state = await prepare('Explain how HTTPS works in detail');

    expect(state.clip.left).toBe(60);
    expect(state.clip.right).toBe(800);
  });

  it('cuts the fading backdrop of a header laid over the conversation from the clip', async () => {
    createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }], { stickyHeader: false });
    // Claude: an absolute title row next to the conversation, whose backdrop
    // has no pointer events and fades out below the row.
    const header = document.createElement('div');
    header.style.position = 'absolute';
    setStaticRect(header, { top: CONTAINER.top, width: CONTAINER.width, height: 48 });
    const button = document.createElement('button');
    setStaticRect(button, { top: CONTAINER.top + 10, left: 760, width: 28, height: 28 });
    const backdrop = document.createElement('div');
    backdrop.style.position = 'absolute';
    backdrop.style.pointerEvents = 'none';
    setStaticRect(backdrop, { top: CONTAINER.top, width: CONTAINER.width - 12, height: 72 });
    header.append(button, backdrop);
    document.body.appendChild(header);
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = (x, y) => (y >= CONTAINER.top && y < CONTAINER.top + 48 ? button : null);

    try {
      const state = await prepare('Explain how HTTPS works');
      expect(state.clip.top).toBe(CONTAINER.top + 72);
    } finally {
      document.elementFromPoint = originalElementFromPoint;
    }
  });

  it('matches through whitespace, markdown, zero-width and full-width differences', async () => {
    const { getScrollTop } = createConversation([
      { text: 'Explain how ＨＴＴＰＳ​ works,\n  step by step, for a curious beginner who knows a bit of networking', offset: 900 }
    ]);

    const state = await prepare('  **Explain**  how `HTTPS` works,   step by step, for a curious beginner who knows nothing');

    expect(state.matched).toBe(true);
    expect(getScrollTop()).toBe(900 - 56 - 16);
  });

  it('prefers a message that starts with the prompt over a later quote inside an answer', async () => {
    const { getScrollTop } = createConversation([
      { text: 'Why is the sky blue?', offset: 1000 },
      { text: 'You asked: why is the sky blue? Rayleigh scattering…', offset: 1200 }
    ]);

    await prepare('Why is the sky blue?');

    expect(getScrollTop()).toBe(1000 - 56 - 16);
  });

  it('prefers a marked user message over a later answer heading repeating the prompt', async () => {
    const { getScrollTop } = createConversation([
      { text: 'Why is the sky blue?', offset: 1000, attributes: { 'data-message-author-role': 'user' } },
      { text: 'Rayleigh scattering…', offset: 1100 },
      { text: 'Why is the sky blue?', offset: 1800, tag: 'h2' }
    ]);

    const state = await prepare('Why is the sky blue?');

    expect(state).toMatchObject({ matched: true, alignedBy: 'prompt' });
    expect(getScrollTop()).toBe(1000 - 56 - 16);
  });

  it('ignores the prompt still sitting in the composer', async () => {
    const { container, getScrollTop } = createConversation([{ text: 'Unrelated message', offset: 400 }]);
    container.querySelector('textarea').value = 'Summarize this thread';
    container.querySelector('textarea').textContent = 'Summarize this thread';

    const state = await prepare('Summarize this thread');

    expect(state.matched).toBe(false);
    expect(getScrollTop()).toBe(0);
  });

  it('leaves the panel untouched when nothing matches', async () => {
    const { setScrollTop, getScrollTop } = createConversation([{ text: 'Something else entirely', offset: 400 }]);
    setScrollTop(321);

    const state = await prepare('A prompt that was never sent here');

    expect(state).toMatchObject({ matched: false, alignedBy: null, scrollTop: 321 });
    expect(getScrollTop()).toBe(321);
    // The main conversation container is still reported for stitching.
    expect(state.clip.top).toBe(CONTAINER.top + 56);
  });

  it('does not align when alignment is off', async () => {
    const { getScrollTop } = createConversation([{ text: 'Explain how HTTPS works', offset: 2000 }]);

    const state = await prepare('Explain how HTTPS works', { align: false });

    expect(state.matched).toBe(false);
    expect(getScrollTop()).toBe(0);
  });

  it('scrolls to requested positions, clamps them, then restores the original position', async () => {
    const { setScrollTop, getScrollTop } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
    setScrollTop(77);
    await prepare('Explain how HTTPS works');

    const scrolled = await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_SCROLL', sessionId: 'session-1', scrollTop: 2000 });
    expect(scrolled.scrollTop).toBe(2000);
    const clamped = await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_SCROLL', sessionId: 'session-1', scrollTop: 99999 });
    expect(clamped.scrollTop).toBe(CONTAINER.scrollHeight - CONTAINER.height);

    const restored = await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
    expect(restored).toMatchObject({ restored: true, scrollTop: 77 });
    expect(getScrollTop()).toBe(77);

    const stale = await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_SCROLL', sessionId: 'session-1', scrollTop: 10 });
    expect(stale.error).toBe('no-session');
    expect(getScrollTop()).toBe(77);
  });


  it('skips matches in navigation and fixed layers', async () => {
    const { getScrollTop } = createConversation([
      { text: 'Explain how HTTPS works', offset: 1200 }
    ]);
    // A sidebar title and a dialog, both after the message in the page.
    const nav = document.createElement('nav');
    const title = document.createElement('a');
    title.href = '/c/1';
    title.textContent = 'Explain how HTTPS works';
    setStaticRect(title, { top: 100, width: 200, height: 20 });
    nav.appendChild(title);
    const dialog = document.createElement('div');
    dialog.style.position = 'fixed';
    dialog.textContent = 'Explain how HTTPS works';
    setStaticRect(dialog, { top: 200, width: 400, height: 40 });
    document.body.append(nav, dialog);

    const state = await prepare('Explain how HTTPS works');

    expect(state.matched).toBe(true);
    expect(getScrollTop()).toBe(1200 - 56 - 16);
  });

  it('only aligns a match that moves with the scroll', async () => {
    const { elements, getScrollTop } = createConversation([
      { text: 'Explain how HTTPS works', offset: 1200 },
      { text: 'Explain how HTTPS works', offset: 2400 }
    ]);
    // The latest copy stays put, e.g. it sits in a box that scrolls on its own.
    setStaticRect(elements[1], { top: 500, width: 600, height: 40 });

    const state = await prepare('Explain how HTTPS works');

    expect(state).toMatchObject({ matched: true, alignedBy: 'prompt' });
    expect(getScrollTop()).toBe(1200 - 56 - 16);
  });

  describe('when full answers find no prompt', () => {
    it('starts at the latest user message', async () => {
      const { setScrollTop, getScrollTop } = createConversation([
        { text: 'First question', offset: 300, attributes: { 'data-message-author-role': 'user' } },
        { text: 'First answer', offset: 400 },
        { text: 'Second question', offset: 1800, attributes: { 'data-message-author-role': 'user' } },
        { text: 'Second answer', offset: 1900 }
      ]);
      setScrollTop(3300);

      const state = await prepare('A prompt typed into the provider directly', { stitch: true });

      expect(state).toMatchObject({ matched: false, alignedBy: 'user-turn', originalScrollTop: 3300 });
      expect(getScrollTop()).toBe(1800 - 56 - 16);
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      expect(getScrollTop()).toBe(3300);
    });

    it('starts at the top when no user message is marked, never where the panel was', async () => {
      const { setScrollTop, getScrollTop } = createConversation([{ text: 'Something else entirely', offset: 400 }]);
      setScrollTop(3300);

      const state = await prepare('A prompt typed into the provider directly', { stitch: true });

      expect(state).toMatchObject({ matched: false, alignedBy: 'top', scrollTop: 0, originalScrollTop: 3300 });
      expect(getScrollTop()).toBe(0);
      const restored = await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      expect(restored.scrollTop).toBe(3300);
    });

    it('also starts at the top without a prompt at all', async () => {
      const { setScrollTop, getScrollTop } = createConversation([{ text: 'Something else entirely', offset: 400 }]);
      setScrollTop(900);

      const state = await prepare('', { stitch: true, align: false });

      expect(state.alignedBy).toBe('top');
      expect(getScrollTop()).toBe(0);
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
    });
  });

  describe('on a page that puts itself back at its bottom', () => {
    // Like a scroll listener keeping the conversation at its end.
    function keepAtBottom(container, times) {
      const descriptor = Object.getOwnPropertyDescriptor(container, 'scrollTop');
      const bottom = CONTAINER.scrollHeight - CONTAINER.height;
      let left = times;
      Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get: descriptor.get,
        set: (value) => {
          descriptor.set(value);
          if (value < bottom && left > 0) {
            left -= 1;
            setTimeout(() => descriptor.set(bottom), 0);
          }
        }
      });
      container.scrollTo = ({ top }) => { container.scrollTop = top; };
    }

    const messages = [
      { text: 'Explain how HTTPS works in detail', offset: 300 },
      { text: 'The answer', offset: 400 }
    ];

    it('says full answers could not start at the prompt when the page keeps going back', async () => {
      const { container, setScrollTop, getScrollTop } = createConversation(messages);
      setScrollTop(CONTAINER.scrollHeight - CONTAINER.height);
      keepAtBottom(container, Infinity);

      const state = await prepare('Explain how HTTPS works in detail', { stitch: true });

      expect(state.error).toBe('unaligned');
      expect(state.sessionId).toBe('session-1');
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      expect(getScrollTop()).toBe(CONTAINER.scrollHeight - CONTAINER.height);
    });

    it('does not claim a current view is aligned when the page keeps going back', async () => {
      const { container, setScrollTop } = createConversation(messages);
      setScrollTop(CONTAINER.scrollHeight - CONTAINER.height);
      keepAtBottom(container, Infinity);

      const state = await prepare('Explain how HTTPS works in detail');

      expect(state).toMatchObject({ matched: false, alignedBy: null, scrollTop: CONTAINER.scrollHeight - CONTAINER.height });
      expect(state.error).toBeUndefined();
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
    });

    it('starts at the prompt when the page goes back only once', async () => {
      const { container, setScrollTop, getScrollTop } = createConversation(messages);
      setScrollTop(CONTAINER.scrollHeight - CONTAINER.height);
      keepAtBottom(container, 1);

      const state = await prepare('Explain how HTTPS works in detail', { stitch: true });

      expect(state.error).toBeUndefined();
      expect(state).toMatchObject({ alignedBy: 'prompt', scrollTop: 300 - 56 - 16 });
      expect(getScrollTop()).toBe(300 - 56 - 16);
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
    });
  });

  it('hides the pointer in the frame while asked to, then shows it again', async () => {
    createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
    const root = document.documentElement;

    await prepare('Explain how HTTPS works', { hideCursor: true });
    expect(root.hasAttribute('data-panelize-snapshot-cursor')).toBe(true);
    const sheets = document.adoptedStyleSheets.length + document.querySelectorAll('#panelize-snapshot-style').length;
    expect(sheets).toBe(1);

    await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
    expect(root.hasAttribute('data-panelize-snapshot-cursor')).toBe(false);
    expect(document.adoptedStyleSheets.length + document.querySelectorAll('#panelize-snapshot-style').length).toBe(0);
  });

  describe('while stitching full answers', () => {
    const CLIP_BOTTOM = CONTAINER.top + CONTAINER.height - 120;

    /** Absolute element with a fixed place on screen, inside `parent`. */
    function addOverlay(parent, { tag = 'div', text = '', box, offsetParent = parent }) {
      const element = document.createElement(tag);
      element.style.position = 'absolute';
      element.textContent = text;
      setStaticRect(element, box);
      Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => offsetParent });
      parent.appendChild(element);
      return element;
    }

    function addFloatingParts(container) {
      const composerBox = container.querySelector('textarea').parentElement;
      return {
        // Icon-only "Scroll to bottom" button above the composer.
        button: addOverlay(composerBox, {
          tag: 'button', text: '', box: { top: CLIP_BOTTOM - 60, left: 380, width: 36, height: 36 }
        }),
        fade: addOverlay(composerBox, { box: { top: CLIP_BOTTOM - 40, width: CONTAINER.width, height: 40 } }),
        // A text label pinned over the conversation, away from the composer.
        label: addOverlay(document.body, {
          text: 'Thinking', box: { top: CONTAINER.top + 80, left: 20, width: 80, height: 20 }
        })
      };
    }

    /**
     * Claude: the composer dock is stuck to the bottom of the conversation
     * with a transparent background, and a plain notice card sits above the
     * input box. The dock is too tall to be cut from the clip as a whole.
     */
    function addComposerDock(container, { position = 'sticky' } = {}) {
      const dock = document.createElement('div');
      dock.style.position = position;
      setStaticRect(dock, { top: CONTAINER.top + CONTAINER.height - 320, width: CONTAINER.width, height: 320 });
      const notice = document.createElement('div');
      notice.textContent = "You've used 90% of your session limit";
      setStaticRect(notice, { top: CONTAINER.top + CONTAINER.height - 280, left: 20, width: 760, height: 80 });
      const close = document.createElement('button');
      setStaticRect(close, { top: CONTAINER.top + CONTAINER.height - 270, left: 740, width: 28, height: 28 });
      notice.appendChild(close);
      const inputBox = document.createElement('div');
      setStaticRect(inputBox, { top: CONTAINER.top + CONTAINER.height - 120, width: CONTAINER.width, height: 120 });
      const textarea = document.createElement('textarea');
      textarea.placeholder = 'Message DeepSeek';
      setStaticRect(textarea, { top: CONTAINER.top + CONTAINER.height - 100, left: 20, width: 760, height: 60 });
      const attach = document.createElement('button');
      setStaticRect(attach, { top: CONTAINER.top + CONTAINER.height - 100, left: 20, width: 28, height: 28 });
      inputBox.append(textarea, attach);
      dock.append(notice, inputBox);
      container.appendChild(dock);
      return { dock, notice, inputBox, textarea, attach };
    }

    it('hides pinned buttons and fades over the conversation, then restores them', async () => {
      const { container, elements } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      const { button, fade, label } = addFloatingParts(container);
      fade.style.setProperty('visibility', 'visible');
      // Absolute parts of a message scroll with it.
      const badge = addOverlay(elements[0], { box: { top: 300, left: 610, width: 20, height: 20 } });
      const background = addOverlay(container, {
        box: { top: CONTAINER.top, width: CONTAINER.width, height: CONTAINER.height }, offsetParent: document.body
      });

      await prepare('Explain how HTTPS works', { stitch: true });

      expect(button.style.getPropertyValue('visibility')).toBe('hidden');
      expect(fade.style.getPropertyValue('visibility')).toBe('hidden');
      // Pinned text would show on every stitched screen.
      expect(label.style.getPropertyValue('visibility')).toBe('hidden');
      // Content and large layers stay.
      expect(badge.style.getPropertyValue('visibility')).toBe('');
      expect(background.style.getPropertyValue('visibility')).toBe('');

      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });

      expect(button.style.getPropertyValue('visibility')).toBe('');
      expect(label.style.getPropertyValue('visibility')).toBe('');
      expect(fade.style.getPropertyValue('visibility')).toBe('visible');
      expect(fade.style.getPropertyPriority('visibility')).toBe('');
    });

    it('un-sticks headings in the middle of the conversation and drops their shadow, then restores them', async () => {
      const { container, getScrollTop } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      // A section heading stuck under the header, 1700px into the content.
      const heading = document.createElement('h2');
      heading.textContent = 'Handshake';
      heading.style.position = 'sticky';
      heading.style.top = '56px';
      heading.style.boxShadow = '0 4px 8px black';
      heading.getBoundingClientRect = () => rect({
        top: heading.style.position === 'sticky' ? CONTAINER.top + 56 : CONTAINER.top + 1700 - getScrollTop(),
        width: 600,
        height: 40
      });
      container.insertBefore(heading, container.querySelector('textarea').parentElement);

      const state = await prepare('Explain how HTTPS works', { stitch: true });

      expect(heading.style.getPropertyValue('position')).toBe('relative');
      expect(heading.style.getPropertyValue('top')).toBe('auto');
      expect(heading.style.getPropertyValue('box-shadow')).toBe('none');
      expect(heading.style.getPropertyValue('visibility')).toBe('');
      // Header and composer at the edges keep sticking, so the clip is the same.
      expect(container.querySelector('header').style.position).toBe('sticky');
      expect(container.querySelector('textarea').parentElement.style.position).toBe('sticky');
      expect(state.clip.top).toBe(CONTAINER.top + 56);
      expect(state.clip.bottom).toBe(CLIP_BOTTOM);

      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });

      expect(heading.style.position).toBe('sticky');
      expect(heading.style.top).toBe('56px');
      expect(heading.style.boxShadow).toBe('0 4px 8px black');
      expect(heading.style.getPropertyPriority('position')).toBe('');
    });

    it('hides fades drawn by pseudo-elements of the composer, then shows them again', async () => {
      const { container } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      const composerBox = container.querySelector('textarea').parentElement;
      const getComputedStyle = window.getComputedStyle;
      // Gemini: the composer's ::before is a gradient over the conversation.
      window.getComputedStyle = (element, pseudo) => {
        if (pseudo === '::before' && element === composerBox) {
          return { content: '""', display: 'block', position: 'absolute', backgroundImage: 'linear-gradient(transparent, white)', boxShadow: 'none' };
        }
        if (pseudo) {
          return { content: 'none', display: 'inline', position: 'static', backgroundImage: 'none', boxShadow: 'none' };
        }
        return getComputedStyle.call(window, element);
      };
      try {
        await prepare('Explain how HTTPS works', { stitch: true });
        expect(composerBox.getAttribute('data-panelize-snapshot-hide')).toBe('before');
        expect(container.hasAttribute('data-panelize-snapshot-hide')).toBe(false);

        await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
        expect(composerBox.hasAttribute('data-panelize-snapshot-hide')).toBe(false);
      } finally {
        window.getComputedStyle = getComputedStyle;
      }
    });

    it('hides notices stacked on a pinned composer, then restores them', async () => {
      const { container, elements } = createConversation(
        [{ text: 'Explain how HTTPS works', offset: 1500 }],
        { composer: false }
      );
      const { dock, notice, inputBox, textarea, attach } = addComposerDock(container);

      const state = await prepare('Explain how HTTPS works', { stitch: true });

      expect(state.clip.bottom).toBe(CONTAINER.top + CONTAINER.height - 120);
      expect(notice.style.getPropertyValue('visibility')).toBe('hidden');
      // The input box is under the clip; the dock and the message stay.
      for (const element of [dock, inputBox, textarea, attach, elements[0]]) {
        expect(element.style.getPropertyValue('visibility')).toBe('');
      }

      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });

      expect(notice.style.getPropertyValue('visibility')).toBe('');
    });

    it('leaves the composer surroundings alone when the composer scrolls with the conversation', async () => {
      const { container } = createConversation(
        [{ text: 'Explain how HTTPS works', offset: 1500 }],
        { composer: false }
      );
      const { notice } = addComposerDock(container, { position: 'static' });

      await prepare('Explain how HTTPS works', { stitch: true });

      expect(notice.style.getPropertyValue('visibility')).toBe('');
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
    });

    it('leaves floating elements alone when not asked to hide them', async () => {
      const { container } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      const { button, fade } = addFloatingParts(container);

      await prepare('Explain how HTTPS works');

      expect(button.style.getPropertyValue('visibility')).toBe('');
      expect(fade.style.getPropertyValue('visibility')).toBe('');
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
    });

    it('hides floating controls for a current view, keeping the composer, pinned text and stuck headings', async () => {
      const { container, elements, setScrollTop, getScrollTop } = createConversation(
        [{ text: 'Explain how HTTPS works', offset: 1500 }],
        { composer: false }
      );
      const { notice, inputBox, textarea } = addComposerDock(container);
      const { button, fade, label } = addFloatingParts({ querySelector: () => textarea });
      const heading = document.createElement('h2');
      heading.style.position = 'sticky';
      setStaticRect(heading, { top: CONTAINER.top + 56, width: 600, height: 40 });
      container.insertBefore(heading, elements[0]);
      setScrollTop(1234);

      const state = await prepare('A prompt that was never sent here', { hideFloating: true });

      expect(state.alignedBy).toBe(null);
      expect(getScrollTop()).toBe(1234);
      for (const element of [button, fade, notice]) {
        expect(element.style.getPropertyValue('visibility')).toBe('hidden');
      }
      for (const element of [inputBox, textarea, label]) {
        expect(element.style.getPropertyValue('visibility')).toBe('');
      }
      // A current view shows the heading where it is stuck.
      expect(heading.style.getPropertyValue('position')).toBe('sticky');
      expect(heading.style.getPropertyPriority('position')).toBe('');

      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      for (const element of [button, fade, notice]) {
        expect(element.style.getPropertyValue('visibility')).toBe('');
      }
    });

    it('hides a button that only shows up after scrolling', async () => {
      const { container } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      const { button } = addFloatingParts(container);
      button.style.display = 'none';

      await prepare('Explain how HTTPS works', { stitch: true });
      expect(button.style.getPropertyValue('visibility')).toBe('');

      button.style.display = '';
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_SCROLL', sessionId: 'session-1', scrollTop: 2000 });
      expect(button.style.getPropertyValue('visibility')).toBe('hidden');

      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      expect(button.style.getPropertyValue('visibility')).toBe('');
    });

    it('removes masks that fade the conversation edges and puts them back', async () => {
      const { container } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      const wrapper = document.createElement('div');
      wrapper.style.setProperty('mask-image', 'linear-gradient(transparent 0px, black 40px)');
      container.replaceWith(wrapper);
      wrapper.appendChild(container);

      await prepare('Explain how HTTPS works', { stitch: true });
      expect(wrapper.style.getPropertyValue('mask-image')).toBe('none');

      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      expect(wrapper.style.getPropertyValue('mask-image')).toBe('linear-gradient(transparent 0px, black 40px)');
    });

    it('hides an overlay scrollbar, but not one that takes room', async () => {
      const { container } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      let offsetWidth = CONTAINER.width;
      Object.defineProperty(container, 'offsetWidth', { configurable: true, get: () => offsetWidth });

      await prepare('Explain how HTTPS works', { stitch: true });
      expect(container.style.getPropertyValue('scrollbar-width')).toBe('none');
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      expect(container.style.getPropertyValue('scrollbar-width')).toBe('');

      offsetWidth = CONTAINER.width + 15;
      await prepare('Explain how HTTPS works', { stitch: true });
      expect(container.style.getPropertyValue('scrollbar-width')).toBe('');
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
    });

    it('puts hidden elements back when a new capture starts without a restore', async () => {
      const { container } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      const { button } = addFloatingParts(container);

      await prepare('Explain how HTTPS works', { stitch: true });
      expect(button.style.getPropertyValue('visibility')).toBe('hidden');

      await prepare('Explain how HTTPS works', { sessionId: 'session-2' });
      expect(button.style.getPropertyValue('visibility')).toBe('');
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-2' });
    });
  });

  describe('putting a virtual list back', () => {
    /**
     * DeepSeek: rows far from the position are not rendered, so the range is
     * an estimate that is short at first and grows once the rows near the
     * position render.
     */
    function createVirtualList(scrollTop) {
      const conversation = createConversation([
        { text: 'Explain how TCP works', offset: 300 },
        { text: 'A long answer', offset: 400 }
      ]);
      let scrollHeight = CONTAINER.scrollHeight;
      Object.defineProperty(conversation.container, 'scrollHeight', { configurable: true, get: () => scrollHeight });
      conversation.setScrollTop(scrollTop);
      return { ...conversation, setScrollHeight: (value) => { scrollHeight = value; } };
    }

    async function restoreWhileTheRangeIsShort(list) {
      list.setScrollHeight(CONTAINER.scrollHeight - 400);
      const restored = sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      setTimeout(() => list.setScrollHeight(CONTAINER.scrollHeight), 250);
      return restored;
    }

    it('goes back to the end when it was at the end', async () => {
      const max = CONTAINER.scrollHeight - CONTAINER.height;
      const list = createVirtualList(max);
      const state = await prepare('Explain how TCP works', { stitch: true, hideFloating: true });
      expect(state).toMatchObject({ alignedBy: 'prompt', originalScrollTop: max });

      await restoreWhileTheRangeIsShort(list);
      expect(list.getScrollTop()).toBe(max);
    });

    it('goes back to the position it was held short of', async () => {
      const list = createVirtualList(3100);
      await prepare('Explain how TCP works', { stitch: true, hideFloating: true });

      await restoreWhileTheRangeIsShort(list);
      expect(list.getScrollTop()).toBe(3100);
    });

    it('leaves a list the page scrolled itself meanwhile', async () => {
      const list = createVirtualList(3100);
      await prepare('Explain how TCP works', { stitch: true, hideFloating: true });

      list.setScrollHeight(CONTAINER.scrollHeight - 400);
      const restored = sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
      // Held at 2900 by the range, then the page scrolls up on its own.
      setTimeout(() => list.setScrollTop(1000), 50);
      setTimeout(() => list.setScrollHeight(CONTAINER.scrollHeight), 250);
      await restored;
      expect(list.getScrollTop()).toBe(1000);
    });
  });

  it('ignores snapshot messages that do not come from the embedding page', async () => {
    const { getScrollTop } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
    const replies = [];
    const listener = (event) => {
      if (event.data?.type === 'PANELIZE_SNAPSHOT_STATE') replies.push(event.data);
    };
    window.addEventListener('message', listener);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'PANELIZE_SNAPSHOT_PREPARE', context: 'multi-panel', requestId: 'x', sessionId: 's', prompt: 'Explain how HTTPS works', align: true },
      source: null
    }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
    window.removeEventListener('message', listener);

    expect(replies).toEqual([]);
    expect(getScrollTop()).toBe(0);
  });
});
