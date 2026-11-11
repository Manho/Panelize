/**
 * Returns true when `pattern` is `<all_urls>` or a match pattern whose host is
 * `*` (such as `https://*` or `*://*` match patterns). Subdomain wildcards like
 * `https://*.example.com/...` are concrete domain patterns and return false.
 * @param {string} pattern
 * @returns {boolean}
 */
export function isWildcardHostPermission(pattern) {
  if (typeof pattern !== 'string') {
    return false;
  }
  const trimmed = pattern.trim();
  if (trimmed === '<all_urls>') {
    return true;
  }
  const schemeSeparatorIndex = trimmed.indexOf('://');
  if (schemeSeparatorIndex === -1) {
    return false;
  }
  const afterScheme = trimmed.slice(schemeSeparatorIndex + 3);
  const slashIndex = afterScheme.indexOf('/');
  const host = slashIndex === -1 ? afterScheme : afterScheme.slice(0, slashIndex);
  if (host.startsWith('[')) {
    return false;
  }
  const hostname = host.split(':')[0];
  return hostname === '*';
}

/**
 * Filters `optional_host_permissions` down to concrete domain patterns so test
 * builds that pre-grant optional built-in providers do not accidentally grant
 * wildcard runtime origins (`<all_urls>` or `*`-host match patterns).
 * @param {string[]} [patterns]
 * @returns {string[]}
 */
export function filterNonWildcardHostPermissions(patterns = []) {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return patterns.filter((pattern) => typeof pattern === 'string' && !isWildcardHostPermission(pattern));
}
