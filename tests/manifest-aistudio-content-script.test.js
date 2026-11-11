import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8')
);

describe('manifest Google AI Studio permission coverage', () => {
  it('declares both AI Studio and its RPC origin as optional host permissions', () => {
    expect(manifest.optional_host_permissions).toEqual(expect.arrayContaining([
      'https://aistudio.google.com/*',
      'https://alkalimakersuite-pa.clients6.google.com/*',
    ]));
  });

  it('does not add AI Studio to required host permissions', () => {
    expect(manifest.host_permissions.some((origin) =>
      origin.includes('aistudio.google.com') || origin.includes('alkalimakersuite-pa.clients6.google.com')
    )).toBe(false);
  });

  it('uses dynamic content-script registration', () => {
    expect(manifest.content_scripts.some(({ matches }) =>
      matches.some((match) =>
        match.includes('aistudio.google.com') || match.includes('alkalimakersuite-pa.clients6.google.com')
      )
    )).toBe(false);
  });
});
