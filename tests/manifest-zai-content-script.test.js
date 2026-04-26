import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('manifest Z.ai content script coverage', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8')
  );

  it('grants host permission for Z.ai chat', () => {
    expect(manifest.host_permissions).toContain('*://chat.z.ai/*');
  });

  it('injects the Z.ai content scripts', () => {
    const zaiContentScript = manifest.content_scripts.find((entry) =>
      Array.isArray(entry.matches) && entry.matches.includes('https://chat.z.ai/*')
    );

    expect(zaiContentScript).toBeTruthy();
    expect(zaiContentScript.js).toEqual(expect.arrayContaining([
      'content-scripts/button-finder-utils.js',
      'content-scripts/enter-behavior-zai.js',
      'content-scripts/text-injection-all-providers.js',
    ]));
  });
});
