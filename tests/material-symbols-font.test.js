import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectIconNames,
  extractIconNames,
  MATERIAL_SYMBOLS_CSS_PATH,
  MATERIAL_SYMBOLS_DIR,
  MATERIAL_SYMBOLS_FONT_PATH,
  MATERIAL_SYMBOLS_SOURCE_PATH
} from '../scripts/material-symbols.js';
import { PACKAGE_EXCLUDED_PREFIXES, PACKAGE_INCLUDE_PATHS } from '../scripts/release-utils.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

function isPackaged(relativePath) {
  return PACKAGE_INCLUDE_PATHS.some(entry => relativePath === entry || relativePath.startsWith(`${entry}/`))
    && !PACKAGE_EXCLUDED_PREFIXES.some(prefix => relativePath === prefix || relativePath.startsWith(prefix));
}

function listPackagedFiles(relativePath = '') {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  if (!fs.statSync(absolutePath).isDirectory()) {
    return isPackaged(relativePath) ? [relativePath] : [];
  }
  const entries = relativePath
    ? fs.readdirSync(absolutePath)
    : PACKAGE_INCLUDE_PATHS;
  return entries.flatMap(entry => listPackagedFiles(relativePath ? `${relativePath}/${entry}` : entry));
}

describe('icon name scanner', () => {
  it('reads names from markup, templates and literal assignments to icon elements', () => {
    const source = [
      '<button><span class="material-symbols-outlined">refresh</span></button>',
      "panel.innerHTML = `<span class=\"material-symbols-outlined filled\">star</span>`;",
      "const icon = btn.querySelector('.material-symbols-outlined');",
      "if (popup) { icon.textContent = 'tab'; } else { icon.textContent = 'open_in_new'; }",
      "status.textContent = 'not_an_icon';"
    ].join('\n');

    expect(extractIconNames(source, 'page.js')).toEqual(['refresh', 'star', 'tab', 'open_in_new']);
  });

  it('rejects icon text it cannot resolve to a name', () => {
    expect(() => extractIconNames('<span class="material-symbols-outlined">${name}</span>', 'page.js'))
      .toThrow(/page\.js:1: icon element text must be a literal icon name/);
    expect(() => extractIconNames([
      "const icon = el.querySelector('.material-symbols-outlined');",
      'icon.textContent = isOpen ? openIcon : closedIcon;'
    ].join('\n'), 'page.js')).toThrow(/page\.js:2: icon text must be assigned a literal icon name/);
    expect(() => extractIconNames("span.classList.add('material-symbols-outlined');", 'page.js'))
      .toThrow(/icon elements must be created as markup/);
  });
});

describe('bundled Material Symbols font', () => {
  const source = JSON.parse(read(MATERIAL_SYMBOLS_SOURCE_PATH));

  it('contains every icon name the extension uses', async () => {
    const used = await collectIconNames(REPO_ROOT);

    expect(used.length).toBeGreaterThan(0);
    // A missing name renders as its plain text instead of the icon.
    expect(used.filter(name => !source.iconNames.includes(name))).toEqual([]);
  });

  it('is a small woff2 subset that ships with its license', () => {
    const font = fs.readFileSync(path.join(REPO_ROOT, MATERIAL_SYMBOLS_FONT_PATH));

    expect(font.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(font.length).toBeLessThan(64 * 1024);
    expect(read(`${MATERIAL_SYMBOLS_DIR}/LICENSE`)).toMatch(/Apache License\s+Version 2\.0/);
    for (const file of [MATERIAL_SYMBOLS_FONT_PATH, MATERIAL_SYMBOLS_CSS_PATH, `${MATERIAL_SYMBOLS_DIR}/LICENSE`]) {
      expect(isPackaged(file), file).toBe(true);
    }
  });

  it('is declared by a stylesheet that every icon page links', () => {
    const css = read(MATERIAL_SYMBOLS_CSS_PATH);
    expect(css).toContain("font-family: 'Material Symbols Outlined';");
    const [, fontUrl] = /src:\s*url\('([^']+)'\)\s*format\('woff2'\)/.exec(css);
    expect(path.posix.join(MATERIAL_SYMBOLS_DIR, fontUrl)).toBe(MATERIAL_SYMBOLS_FONT_PATH);

    // A page uses icons when its markup or one of its scripts renders one.
    const usesIcons = (page) => {
      const html = read(page);
      const scripts = Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g), match => match[1])
        .filter(src => !/^[a-z]+:/.test(src))
        .map(src => path.posix.join(path.posix.dirname(page), src));
      return [html, ...scripts.map(read)].some(text => text.includes('material-symbols-outlined'));
    };
    const iconPages = listPackagedFiles().filter(file => file.endsWith('.html')).filter(usesIcons);
    expect(iconPages).toEqual(expect.arrayContaining(['multi-panel/multi-panel.html', 'options/options.html']));
    for (const page of iconPages) {
      const href = path.posix.relative(path.posix.dirname(page), MATERIAL_SYMBOLS_CSS_PATH);
      expect(read(page), page).toContain(`<link rel="stylesheet" href="${href}">`);
    }
  });

  it('leaves no packaged file loading anything from Google Fonts', () => {
    const textFiles = listPackagedFiles().filter(file => /\.(html|css|js|json)$/.test(file));

    expect(textFiles.length).toBeGreaterThan(0);
    expect(textFiles.filter(file => /fonts\.(googleapis|gstatic)\.com/.test(read(file)))).toEqual([]);
  });
});
