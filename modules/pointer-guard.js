/**
 * Keeps the mouse pointer out of tab-sharing snapshots.
 *
 * Chrome draws the pointer into a shared tab's frames whenever it moved or
 * clicked inside the tab in the last 2 seconds, whatever the page's CSS
 * cursor (on macOS it falls back to the arrow). A stitched snapshot would
 * then show one pointer per screen. The page follows the pointer; while
 * capturing, the guard covers the captured area with a transparent shield,
 * so the provider frames get no hover and the page sees every move, and
 * waits before each frame until the pointer has been still long enough for
 * Chrome to stop drawing it.
 */

/**
 * Chrome stops drawing the pointer after 2s without movement
 * (MouseCursorOverlayController kIdleTimeout); the rest is a margin.
 */
export const POINTER_IDLE_MS = 2200;
/** A pointer kept moving longer than this is captured anyway. */
export const POINTER_MAX_WAIT_MS = 10000;
/**
 * The drawn pointer reaches up to its image size (32px) past its hot spot,
 * so a pointer just outside the captured area can still show up in it.
 */
export const POINTER_REACH_PX = 32;

function abortError(signal) {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Whether a pointer at `point` can be drawn inside `area`.
 * @param {{x: number, y: number}} point
 * @param {{left: number, top: number, right: number, bottom: number}} area
 * @param {number} [reach]
 * @returns {boolean}
 */
export function canPointerReach(point, area, reach = POINTER_REACH_PX) {
  return point.x >= area.left - reach && point.x <= area.right + reach
    && point.y >= area.top - reach && point.y <= area.bottom + reach;
}

const OUTSIDE = Object.freeze({ x: -Infinity, y: -Infinity });

/**
 * Follows the pointer over the page. Moves over a provider frame are not
 * seen here, so a pointer inside one is only known to be somewhere in it.
 * @param {object} [options]
 * @param {Window} [options.target]
 * @param {() => number} [options.now]
 * @returns {{read: () => {point: {x: number, y: number} | null, time: number} | null,
 *   dispose: () => void}} read() is null until the pointer is first seen; a null
 *   point means it is inside a frame, at a time the page cannot know.
 */
export function createPointerTracker({ target = window, now = () => performance.now() } = {}) {
  let last = null;
  const record = (event) => {
    last = { point: { x: event.clientX, y: event.clientY }, time: now() };
  };
  const leave = (event) => {
    const into = event.relatedTarget;
    if (!into) {
      last = { point: OUTSIDE, time: now() };
    } else if (into.tagName === 'IFRAME') {
      last = { point: null, time: now() };
    }
  };
  target.addEventListener('pointermove', record, true);
  target.addEventListener('pointerdown', record, true);
  target.addEventListener('pointerout', leave, true);
  return {
    read: () => last,
    dispose() {
      target.removeEventListener('pointermove', record, true);
      target.removeEventListener('pointerdown', record, true);
      target.removeEventListener('pointerout', leave, true);
    }
  };
}

/**
 * Shields `area` from the pointer until disposed.
 * @param {object} options
 * @param {HTMLElement} options.area - Element whose box is captured (#panel-grid).
 * @param {ReturnType<typeof createPointerTracker>} options.tracker
 * @param {(waiting: boolean) => void} [options.onWaitChange] - The guard
 *   started or stopped waiting for the pointer to keep still.
 * @param {() => number} [options.now] - Same clock as the tracker.
 * @param {number} [options.idleMs]
 * @param {number} [options.maxWaitMs]
 * @returns {{waitUntilStill: (signal?: AbortSignal) => Promise<void>, dispose: () => void}}
 */
export function createPointerGuard({
  area,
  tracker,
  onWaitChange = () => {},
  now = () => performance.now(),
  idleMs = POINTER_IDLE_MS,
  maxWaitMs = POINTER_MAX_WAIT_MS
}) {
  const doc = area.ownerDocument;
  const rect = area.getBoundingClientRect();
  const shield = doc.createElement('div');
  shield.className = 'snapshot-pointer-shield';
  shield.setAttribute('aria-hidden', 'true');
  Object.assign(shield.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  });
  // The shield takes the wheel too, so panels do not scroll under the capture.
  const block = (event) => event.preventDefault();
  shield.addEventListener('wheel', block, { passive: false });
  doc.body.appendChild(shield);

  // A pointer last seen in a frame may have moved there just now; from here
  // on the shield sees its moves.
  const startedAt = now();
  const lastActivity = (last) => (last?.point ? last.time : Math.max(last?.time ?? startedAt, startedAt));
  const isDrawable = () => {
    const last = tracker.read();
    return now() - lastActivity(last) < idleMs
      && (!last?.point || canPointerReach(last.point, area.getBoundingClientRect()));
  };

  return {
    async waitUntilStill(signal) {
      if (!isDrawable()) return;
      const deadline = now() + maxWaitMs;
      onWaitChange(true);
      try {
        while (isDrawable() && now() < deadline) {
          const stillAt = lastActivity(tracker.read()) + idleMs;
          await sleep(Math.max(1, Math.min(stillAt, deadline) - now()), signal);
        }
      } finally {
        onWaitChange(false);
      }
    },
    dispose() {
      shield.remove();
    }
  };
}
