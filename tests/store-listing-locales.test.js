import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const LOCALES_DIR = resolve(ROOT, '_locales');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const locales = readdirSync(LOCALES_DIR);

// Chrome Web Store limits for the manifest name and summary.
const MAX_NAME_LENGTH = 75;
const MAX_DESCRIPTION_LENGTH = 132;

// The store listing must not name AI providers or competing extensions; the
// Chrome Web Store rejects listings that do.
const THIRD_PARTY_NAMES =
  /chatgpt|openai|claude|anthropic|gemini|grok|deepseek|kimi|qwen|doubao|zhipu|z\.ai|yuanbao|通义|千问|豆包|智谱|元宝|chathub|chatall|merlin|sider|monica/i;

function readMessages(locale) {
  return JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
}

describe('store listing locales', () => {
  it('localizes the manifest name and description', () => {
    expect(manifest.name).toBe('__MSG_extensionName__');
    expect(manifest.description).toBe('__MSG_extensionDescription__');
    expect(manifest.short_name).toBe('Panelize');
  });

  it.each(locales)('%s keeps the store name and summary within limits', (locale) => {
    const messages = readMessages(locale);
    const name = messages.extensionName?.message;
    const description = messages.extensionDescription?.message;

    expect(name, locale).toMatch(/^Panelize\b/);
    expect([...name].length, locale).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect([...description].length, locale).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(`${name} ${description}`, locale).not.toMatch(THIRD_PARTY_NAMES);
  });
});
