import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CREEM_URL = 'https://www.creem.io/product/prod_251L781OFoY218MIE84jx1';
const LOCALES_DIR = resolve(ROOT, '_locales');
const LOCALES = readdirSync(LOCALES_DIR).sort();

describe('Creem support link integration', () => {
  it('configures .github/FUNDING.yml with the Creem checkout URL', () => {
    const fundingYml = readFileSync(resolve(ROOT, '.github/FUNDING.yml'), 'utf8');
    expect(fundingYml.trim()).toBe(`custom: ['${CREEM_URL}']`);
  });

  it('defines non-empty linkSupportPanelize translations across all 10 locales', () => {
    expect(LOCALES).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'ru', 'zh_CN', 'zh_TW']);
    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
      const message = messages.linkSupportPanelize?.message?.trim();
      expect(message, `${locale}.linkSupportPanelize`).toBeTruthy();
      expect(message, `${locale}.linkSupportPanelize`).toContain('↗');
    }
  });

  it('places the support link in options.html inside .about-links outside .version-download', () => {
    const html = readFileSync(resolve(ROOT, 'options/options.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const aboutInfo = doc.querySelector('.about-info');
    expect(aboutInfo).not.toBeNull();

    const link = aboutInfo.querySelector('.about-links a#support-panelize-link');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe(CREEM_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('data-i18n')).toBe('linkSupportPanelize');
    expect(link.closest('.version-download')).toBeNull();
    expect(link.querySelector('.material-symbols-outlined')).toBeNull();
  });

  it('includes dark-theme styling for .about-links a in options.css', () => {
    const css = readFileSync(resolve(ROOT, 'options/options.css'), 'utf8');
    expect(css).toMatch(/\[data-theme="dark"\]\s+\.about-links\s+a\s*\{[^}]*color:\s*#90caf9/i);
  });

  it('adds the support link to README.md and README.ja.md while keeping README.zh-CN.md clean', () => {
    const readmeEn = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
    const readmeJa = readFileSync(resolve(ROOT, 'README.ja.md'), 'utf8');
    const readmeZh = readFileSync(resolve(ROOT, 'README.zh-CN.md'), 'utf8');

    expect(readmeEn).toContain(CREEM_URL);
    expect(readmeJa).toContain(CREEM_URL);
    expect(readmeZh).not.toContain(CREEM_URL);
    expect(readmeZh).not.toContain('creem.io');
  });
});
