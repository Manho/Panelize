import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POINTER_IDLE_MS,
  POINTER_MAX_WAIT_MS,
  canPointerReach,
  createPointerGuard,
  createPointerTracker
} from '../modules/pointer-guard.js';

const AREA = { left: 0, top: 100, right: 1200, bottom: 800, width: 1200, height: 700 };

function pointer(type, x, y, relatedTarget = null) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { clientX: x, clientY: y });
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  return event;
}

describe('canPointerReach', () => {
  it('counts the pointer drawn just outside the area', () => {
    expect(canPointerReach({ x: 600, y: 400 }, AREA)).toBe(true);
    expect(canPointerReach({ x: 600, y: 80 }, AREA)).toBe(true);
    expect(canPointerReach({ x: 600, y: 20 }, AREA)).toBe(false);
    expect(canPointerReach({ x: -Infinity, y: -Infinity }, AREA)).toBe(false);
  });
});

describe('createPointerGuard', () => {
  let area;
  let tracker;
  let guard;

  beforeEach(() => {
    vi.useFakeTimers();
    area = document.createElement('div');
    area.getBoundingClientRect = () => AREA;
    document.body.appendChild(area);
    tracker = createPointerTracker({ target: window, now: () => Date.now() });
  });

  afterEach(() => {
    guard?.dispose();
    guard = null;
    tracker.dispose();
    area.remove();
    vi.useRealTimers();
  });

  const startGuard = (options = {}) => {
    guard = createPointerGuard({ area, tracker, now: () => Date.now(), ...options });
    return guard;
  };

  async function settle(promise) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    return () => done;
  }

  it('shields the captured area until disposed', () => {
    startGuard();
    const shield = document.querySelector('.snapshot-pointer-shield');
    expect(shield).not.toBeNull();
    expect(shield.style.top).toBe('100px');
    expect(shield.style.height).toBe('700px');
    guard.dispose();
    expect(document.querySelector('.snapshot-pointer-shield')).toBeNull();
  });

  it('does not wait for a pointer that last moved away from the panels', async () => {
    window.dispatchEvent(pointer('pointerdown', 600, 20));
    const onWaitChange = vi.fn();
    startGuard({ onWaitChange });
    const isDone = await settle(guard.waitUntilStill());
    expect(isDone()).toBe(true);
    expect(onWaitChange).not.toHaveBeenCalled();
  });

  it('does not wait for a pointer that left the page', async () => {
    window.dispatchEvent(pointer('pointermove', 600, 400));
    document.body.dispatchEvent(pointer('pointerout', 600, 400, null));
    startGuard();
    const isDone = await settle(guard.waitUntilStill());
    expect(isDone()).toBe(true);
  });

  it('waits until the pointer over the panels has been still long enough', async () => {
    const onWaitChange = vi.fn();
    startGuard({ onWaitChange });
    window.dispatchEvent(pointer('pointermove', 600, 400));
    const isDone = await settle(guard.waitUntilStill());
    expect(onWaitChange).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(POINTER_IDLE_MS - 500);
    // Moving again restarts the wait.
    window.dispatchEvent(pointer('pointermove', 610, 400));
    await vi.advanceTimersByTimeAsync(POINTER_IDLE_MS - 1);
    expect(isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isDone()).toBe(true);
    expect(onWaitChange).toHaveBeenLastCalledWith(false);

    // Still since then: the next frame does not wait.
    expect(await settle(guard.waitUntilStill()).then(isNextDone => isNextDone())).toBe(true);
  });

  it('waits one idle period for a pointer last seen inside a panel', async () => {
    const iframe = document.createElement('iframe');
    window.dispatchEvent(pointer('pointermove', 600, 400));
    document.body.dispatchEvent(pointer('pointerout', 600, 400, iframe));
    await vi.advanceTimersByTimeAsync(60_000);
    startGuard();
    const isDone = await settle(guard.waitUntilStill());
    await vi.advanceTimersByTimeAsync(POINTER_IDLE_MS - 1);
    expect(isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isDone()).toBe(true);
  });

  it('gives up on a pointer that keeps moving', async () => {
    startGuard();
    const isDone = await settle(guard.waitUntilStill());
    for (let elapsed = 0; elapsed < POINTER_MAX_WAIT_MS; elapsed += 500) {
      window.dispatchEvent(pointer('pointermove', 600, 400 + (elapsed % 2)));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(isDone()).toBe(true);
  });

  it('stops waiting when the capture is cancelled', async () => {
    const onWaitChange = vi.fn();
    startGuard({ onWaitChange });
    const controller = new AbortController();
    const waiting = guard.waitUntilStill(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(onWaitChange).toHaveBeenLastCalledWith(false);
  });
});
