import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8')
);

describe('manifest Qwen permission coverage', () => {
  it('declares both Qwen sites as optional host permissions', () => {
    expect(manifest.optional_host_permissions).toEqual(expect.arrayContaining([
      'https://www.qianwen.com/*',
      'https://chat.qwen.ai/*',
    ]));
  });

  it('does not add Qwen to required host permissions', () => {
    expect(manifest.host_permissions.some((origin) =>
      origin.includes('qianwen.com') || origin.includes('qwen.ai')
    )).toBe(false);
  });

  it('does not use static Qwen content scripts', () => {
    expect(manifest.content_scripts.some(({ matches }) =>
      matches.some((match) => match.includes('qianwen.com') || match.includes('qwen.ai'))
    )).toBe(false);
  });
});
