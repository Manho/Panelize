// Ensure OneTrust cookie consent choices (OptanonAlertBoxClosed, OptanonConsent)
// written via document.cookie inside an embedded Grok iframe use SameSite=None; Secure
// so Chromium's cross-site script cookie check accepts and persists them.
(() => {
  if (window.top === window.self) {
    return;
  }

  // Only rewrite inside extension pages such as the Multi-Panel page. Grok
  // frames embedded by ordinary websites (or by a website framing the
  // web-accessible Multi-Panel page) keep the browser's default behavior.
  const ancestorOrigins = location.ancestorOrigins;
  const topOrigin = ancestorOrigins?.length ? ancestorOrigins[ancestorOrigins.length - 1] : '';
  if (!topOrigin.startsWith('chrome-extension://')) {
    return;
  }

  const OPTANON_COOKIE_PATTERN = /^\s*Optanon(?:AlertBoxClosed|Consent)=/;

  function rewriteGrokConsentCookieString(cookieString) {
    if (typeof cookieString !== 'string' || !OPTANON_COOKIE_PATTERN.test(cookieString)) {
      return cookieString;
    }

    if (typeof location !== 'undefined' && location.protocol !== 'https:') {
      return cookieString;
    }

    let rewritten = cookieString.replace(/;\s*SameSite=(?:Lax|Strict)/gi, '; SameSite=None');
    if (!/;\s*SameSite=None\b/i.test(rewritten)) {
      rewritten += '; SameSite=None';
    }
    if (!/;\s*Secure\b/i.test(rewritten)) {
      rewritten += '; Secure';
    }
    return rewritten;
  }

  // Patch the prototype that actually owns the accessor (Document.prototype in
  // Chromium) so no own property further down the chain shadows the override.
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
      return descriptor.set.call(this, rewriteGrokConsentCookieString(value));
    }
  });
})();
