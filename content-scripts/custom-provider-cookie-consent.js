// Persist client-side cookie consent & UI preference writes inside HTTPS custom
// web provider panels embedded directly by Panelize.
//
// In cross-site iframes (chrome-extension://<id> -> https://<provider>), Chromium
// silently rejects any `document.cookie = ...` write that omits `SameSite=None; Secure`
// (such as Perplexity's `pplx.trackingAllowed=true; path=/; expires=...` or OneTrust),
// causing cookie banners to reappear on every panel refresh.
//
// Rewriting rejected writes to `SameSite=None; Secure; Partitioned` (CHIPS) binds the
// cookie strictly to this extension's partition key (`chrome-extension://<id>`), so:
// 1. Consent choices persist across panel refreshes and browser restarts.
// 2. Top-level browser tabs and third-party websites never see or send the cookie.
(() => {
  'use strict';

  if (window.top === window.self || window.parent !== window.top) {
    return;
  }

  if (typeof location === 'undefined' || location.protocol !== 'https:') {
    return;
  }

  const ancestorOrigins = location.ancestorOrigins;
  if (
    !ancestorOrigins ||
    ancestorOrigins.length !== 1 ||
    typeof ancestorOrigins[0] !== 'string' ||
    !/^chrome-extension:\/\/[a-z0-9_-]+$/i.test(ancestorOrigins[0])
  ) {
    return;
  }

  const GUARD_SYMBOL = Symbol.for('panelize.customProviderCookieConsentPatched');
  if (window[GUARD_SYMBOL]) {
    return;
  }
  try {
    Object.defineProperty(window, GUARD_SYMBOL, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    window[GUARD_SYMBOL] = true;
  }

  function rewriteFramedCookieString(cookieString) {
    if (typeof cookieString !== 'string' || cookieString.trim().length === 0) {
      return cookieString;
    }

    if (/;\s*SameSite=None\b/i.test(cookieString) && /;\s*Secure\b/i.test(cookieString)) {
      return cookieString;
    }

    if (/^\s*__Host-/i.test(cookieString) && /;\s*Domain=/i.test(cookieString)) {
      return cookieString;
    }

    let rewritten = cookieString.replace(/;\s*SameSite=(?:Lax|Strict|None)\b/gi, '');
    if (/^\s*__Host-/i.test(rewritten) && !/;\s*Path=\/(?:\s*;|\s*$)/i.test(rewritten)) {
      rewritten += '; Path=/';
    }
    rewritten += '; SameSite=None';
    if (!/;\s*Secure\b/i.test(rewritten)) {
      rewritten += '; Secure';
    }
    if (!/;\s*Partitioned\b/i.test(rewritten)) {
      rewritten += '; Partitioned';
    }
    return rewritten;
  }

  let owner = Object.getPrototypeOf(document);
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'cookie')) {
    owner = Object.getPrototypeOf(owner);
  }
  const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'cookie');
  if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') {
    return;
  }

  Object.defineProperty(owner, 'cookie', {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get() {
      return descriptor.get.call(this);
    },
    set(value) {
      return descriptor.set.call(this, rewriteFramedCookieString(value));
    },
  });
})();
