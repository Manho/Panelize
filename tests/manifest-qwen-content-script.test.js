import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('manifest Qwen content script coverage', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8')
  );

  it('grants host permission for Qwen chat', () => {
    expect(manifest.host_permissions).toContain('*://chat.qwen.ai/*');
  });

  it('injects the Qwen content scripts', () => {
    const qwenContentScript = manifest.content_scripts.find((entry) =>
      Array.isArray(entry.matches) && entry.matches.includes('https://chat.qwen.ai/*')
    );

    expect(qwenContentScript).toBeTruthy();
    expect(qwenContentScript.js).toEqual(expect.arrayContaining([
      'content-scripts/button-finder-utils.js',
      'content-scripts/enter-behavior-qwen.js',
      'content-scripts/text-injection-all-providers.js',
    ]));
  });
});
