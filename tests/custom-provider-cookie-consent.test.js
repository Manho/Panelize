import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'content-scripts/custom-provider-cookie-consent.js');

function createMockFramedEnvironment({
  url = 'https://www.perplexity.ai/',
  isFramed = true,
  isDirectChildOfTop = true,
  ancestorOrigins = ['chrome-extension://cbffpohpaendhgcfdcmiliogainhncmh'],
} = {}) {
  const win = new Window({ url });
  const writes = [];
  let cookieJar = '';

  let owner = Object.getPrototypeOf(win.document);
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'cookie')) {
    owner = Object.getPrototypeOf(owner);
  }
  Object.defineProperty(owner, 'cookie', {
    configurable: true,
    enumerable: true,
    get() {
      return cookieJar;
    },
    set(value) {
      writes.push(String(value));
      cookieJar = String(value).split(';')[0];
    },
  });

  if (isFramed) {
    const topWindow = {};
    const parentWindow = isDirectChildOfTop ? topWindow : {};
    Object.defineProperty(win, 'top', { value: topWindow, configurable: true });
    Object.defineProperty(win, 'parent', { value: parentWindow, configurable: true });
  } else {
    Object.defineProperty(win, 'top', { value: win, configurable: true });
    Object.defineProperty(win, 'parent', { value: win, configurable: true });
  }

  Object.defineProperty(win.location, 'ancestorOrigins', {
    value: ancestorOrigins,
    configurable: true,
  });

  const code = readFileSync(scriptPath, 'utf8');
  win.eval(code);

  return { win, writes };
}

describe('content-scripts/custom-provider-cookie-consent.js', () => {
  it('rewrites default/Lax/Strict document.cookie writes inside direct extension HTTPS iframes to SameSite=None; Secure; Partitioned', async () => {
    const { win, writes } = createMockFramedEnvironment();

    win.document.cookie = 'pplx.trackingAllowed=true; path=/; expires=Sat, 13 Nov 2027 09:03:01 GMT';
    win.document.cookie = 'OptanonConsent=isGpcEnabled=0; path=/; SameSite=Lax';
    win.document.cookie = 'theme=dark; path=/; SameSite=Strict; Secure';

    expect(writes).toEqual([
      'pplx.trackingAllowed=true; path=/; expires=Sat, 13 Nov 2027 09:03:01 GMT; SameSite=None; Secure; Partitioned',
      'OptanonConsent=isGpcEnabled=0; path=/; SameSite=None; Secure; Partitioned',
      'theme=dark; path=/; Secure; SameSite=None; Partitioned',
    ]);

    await win.happyDOM.close();
  });

  it('leaves cookies that already declare SameSite=None and Secure untouched', async () => {
    const { win, writes } = createMockFramedEnvironment();

    win.document.cookie = 'already_cross_site=1; path=/; SameSite=None; Secure';
    win.document.cookie = 'already_partitioned=1; path=/; SameSite=None; Secure; Partitioned';

    expect(writes).toEqual([
      'already_cross_site=1; path=/; SameSite=None; Secure',
      'already_partitioned=1; path=/; SameSite=None; Secure; Partitioned',
    ]);

    await win.happyDOM.close();
  });

  it('stays completely inert in top-level tabs, HTTP frames, non-extension parents, and nested third-party frames', async () => {
    const topLevel = createMockFramedEnvironment({ isFramed: false });
    topLevel.win.document.cookie = 'pplx.trackingAllowed=true; path=/';
    expect(topLevel.writes).toEqual(['pplx.trackingAllowed=true; path=/']);
    await topLevel.win.happyDOM.close();

    const httpFrame = createMockFramedEnvironment({ url: 'http://127.0.0.1:3000/' });
    httpFrame.win.document.cookie = 'pplx.trackingAllowed=true; path=/';
    expect(httpFrame.writes).toEqual(['pplx.trackingAllowed=true; path=/']);
    await httpFrame.win.happyDOM.close();

    const webParent = createMockFramedEnvironment({
      ancestorOrigins: ['https://evil.example'],
    });
    webParent.win.document.cookie = 'pplx.trackingAllowed=true; path=/';
    expect(webParent.writes).toEqual(['pplx.trackingAllowed=true; path=/']);
    await webParent.win.happyDOM.close();

    const nestedUnderEvilFramingExtension = createMockFramedEnvironment({
      isDirectChildOfTop: false,
      ancestorOrigins: ['chrome-extension://cbffpohpaendhgcfdcmiliogainhncmh', 'https://evil.example'],
    });
    nestedUnderEvilFramingExtension.win.document.cookie = 'pplx.trackingAllowed=true; path=/';
    expect(nestedUnderEvilFramingExtension.writes).toEqual(['pplx.trackingAllowed=true; path=/']);
    await nestedUnderEvilFramingExtension.win.happyDOM.close();
  });
});
