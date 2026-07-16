import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8')
);

describe('manifest ChatGLM permission coverage', () => {
  it('declares ChatGLM as an optional host permission', () => {
    expect(manifest.optional_host_permissions).toContain('https://chatglm.cn/*');
  });

  it('does not add ChatGLM to required host permissions', () => {
    expect(manifest.host_permissions.some((origin) => origin.includes('chatglm.cn'))).toBe(false);
  });

  it('does not use a static ChatGLM content script', () => {
    expect(manifest.content_scripts.some(({ matches }) =>
      matches.some((match) => match.includes('chatglm.cn'))
    )).toBe(false);
  });
});

describe('manifest Z.ai Global permission coverage', () => {
  it('declares Z.ai as an optional host permission', () => {
    expect(manifest.optional_host_permissions).toContain('https://chat.z.ai/*');
  });

  it('does not add Z.ai to required host permissions', () => {
    expect(manifest.host_permissions.some((origin) => origin.includes('z.ai'))).toBe(false);
  });

  it('does not use a static Z.ai content script', () => {
    expect(manifest.content_scripts.some(({ matches }) =>
      matches.some((match) => match.includes('z.ai'))
    )).toBe(false);
  });
});
