// Ensure OneTrust cookie consent choices (OptanonAlertBoxClosed, OptanonConsent)
// written via document.cookie inside an embedded Grok iframe use SameSite=None; Secure
// so Chromium's cross-site script cookie check accepts and persists them.
(() => {
  if (window.top === window.self) {
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

  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
    Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
  if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') {
    return;
  }

  Object.defineProperty(Document.prototype, 'cookie', {
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
