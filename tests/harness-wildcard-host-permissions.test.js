import { describe, expect, it } from 'vitest';
import {
  filterNonWildcardHostPermissions,
  isWildcardHostPermission,
} from './helpers/host-permission-patterns.js';

describe('wildcard optional host permission filter', () => {
  it('identifies <all_urls> and *-host match patterns as wildcards', () => {
    expect(isWildcardHostPermission('<all_urls>')).toBe(true);
    expect(isWildcardHostPermission('https://*/*')).toBe(true);
    expect(isWildcardHostPermission('http://*/*')).toBe(true);
    expect(isWildcardHostPermission('*://*/*')).toBe(true);
    expect(isWildcardHostPermission('wss://*/*')).toBe(true);
  });

  it('keeps concrete hosts and subdomain wildcards', () => {
    expect(isWildcardHostPermission('https://aistudio.google.com/*')).toBe(false);
    expect(isWildcardHostPermission('https://*.example.com/*')).toBe(false);
    expect(isWildcardHostPermission('https://*.qianwen.com/*')).toBe(false);
    expect(isWildcardHostPermission('http://127.0.0.1:3000/*')).toBe(false);
    expect(isWildcardHostPermission('http://[::1]:8080/*')).toBe(false);
  });

  it('filters wildcard patterns out of optional_host_permissions lists', () => {
    const input = [
      'https://www.qianwen.com/*',
      'https://*.example.com/*',
      'https://*/*',
      'http://*/*',
      '<all_urls>',
      '*://*/*',
      'https://aistudio.google.com/*',
    ];
    expect(filterNonWildcardHostPermissions(input)).toEqual([
      'https://www.qianwen.com/*',
      'https://*.example.com/*',
      'https://aistudio.google.com/*',
    ]);
    expect(filterNonWildcardHostPermissions(undefined)).toEqual([]);
  });
});
