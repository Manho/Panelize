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
    setStaticRect(header, { top: CONTAINER.top, width: CONTAINER.width, height: 56 });
    container.appendChild(header);
  }

  const elements = messages.map(({ text, offset, tag = 'div' }) => {
    const element = document.createElement(tag);
    element.textContent = text;
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
    setStaticRect(box, { top: CONTAINER.top + CONTAINER.height - 120, width: CONTAINER.width, height: 120 });
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

    expect(state).toMatchObject({ matched: true, sessionId: 'session-1', provider: 'deepseek' });
    // Sticky header (56px) and composer (120px) are cut from the clip.
    expect(state.clip).toEqual({ left: 0, top: CONTAINER.top + 56, right: 800, bottom: CONTAINER.top + CONTAINER.height - 120 });
    expect(getScrollTop()).toBe(2200 - 56 - 16);
    expect(elements[2].getBoundingClientRect().top).toBe(state.clip.top + 16);
    expect(state.scrollTop).toBe(getScrollTop());
    expect(state.maxScrollTop).toBe(CONTAINER.scrollHeight - CONTAINER.height);
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

    expect(state).toMatchObject({ matched: false, scrollTop: 321 });
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
      // Readable text, content and large layers stay.
      expect(label.style.getPropertyValue('visibility')).toBe('');
      expect(badge.style.getPropertyValue('visibility')).toBe('');
      expect(background.style.getPropertyValue('visibility')).toBe('');

      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });

      expect(button.style.getPropertyValue('visibility')).toBe('');
      expect(fade.style.getPropertyValue('visibility')).toBe('visible');
      expect(fade.style.getPropertyPriority('visibility')).toBe('');
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

    it('leaves floating elements alone for a current view', async () => {
      const { container } = createConversation([{ text: 'Explain how HTTPS works', offset: 1500 }]);
      const { button, fade } = addFloatingParts(container);

      await prepare('Explain how HTTPS works');

      expect(button.style.getPropertyValue('visibility')).toBe('');
      expect(fade.style.getPropertyValue('visibility')).toBe('');
      await sendSnapshotMessage({ type: 'PANELIZE_SNAPSHOT_RESTORE', sessionId: 'session-1' });
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
