import fs from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_INCLUDE_PATHS } from './release-utils.js';

/** Directory of the bundled icon font, relative to the repo root. */
export const MATERIAL_SYMBOLS_DIR = 'libs/material-symbols';
export const MATERIAL_SYMBOLS_FONT_PATH = `${MATERIAL_SYMBOLS_DIR}/material-symbols-outlined.woff2`;
export const MATERIAL_SYMBOLS_CSS_PATH = `${MATERIAL_SYMBOLS_DIR}/material-symbols-outlined.css`;
/** Records where the subset came from and which icon names it contains. */
export const MATERIAL_SYMBOLS_SOURCE_PATH = `${MATERIAL_SYMBOLS_DIR}/font-source.json`;

const ICON_CLASS = 'material-symbols-outlined';
const ICON_NAME_PATTERN = /^[a-z0-9_]+$/;
const SCANNED_EXTENSIONS = new Set(['.html', '.js']);

// Markup that carries the icon class, in HTML files and JS template strings.
const ICON_ELEMENT_PATTERN = new RegExp(
  `<([a-z]+)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${ICON_CLASS}\\b[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`,
  'g'
);
// `const icon = btn.querySelector('.material-symbols-outlined')`.
const ICON_VARIABLE_PATTERN = new RegExp(
  `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]*?querySelector\\(\\s*(['"\`])[^'"\`]*\\.${ICON_CLASS}\\b[^'"\`]*\\2\\s*\\)`,
  'g'
);
// Ways of creating an icon element that the scanner cannot follow.
const UNSUPPORTED_ICON_PATTERNS = [
  new RegExp(`classList\\.(?:add|toggle|replace)\\([^)]*['"\`]${ICON_CLASS}['"\`]`),
  new RegExp(`\\.className\\s*=\\s*[^;]*\\b${ICON_CLASS}\\b`),
  new RegExp(`setAttribute\\(\\s*['"\`]class['"\`]\\s*,[^)]*\\b${ICON_CLASS}\\b`),
];

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Icon names used by one source file.
 *
 * Icons are ligatures: the element's text is the icon name. Names are read from
 * icon markup and from literal text assigned to an icon element looked up with
 * `querySelector('.material-symbols-outlined')`. Anything else that would set
 * an icon's text throws, so a new icon cannot bypass the subset check.
 * @param {string} text - File contents.
 * @param {string} file - Path used in error messages.
 * @returns {string[]}
 */
export function extractIconNames(text, file) {
  const names = [];
  const fail = (index, message) => {
    throw new Error(`${file}:${lineOf(text, index)}: ${message}`);
  };

  for (const match of text.matchAll(ICON_ELEMENT_PATTERN)) {
    const name = match[2].trim();
    if (!ICON_NAME_PATTERN.test(name)) {
      fail(match.index, `icon element text must be a literal icon name, found "${name}"`);
    }
    names.push(name);
  }

  if (file.endsWith('.js')) {
    for (const pattern of UNSUPPORTED_ICON_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        fail(match.index, `icon elements must be created as markup so their names can be checked: ${match[0]}`);
      }
    }

    for (const variable of text.matchAll(ICON_VARIABLE_PATTERN)) {
      const assignment = new RegExp(
        `\\b${escapeRegExp(variable[1])}\\.(?:textContent|innerText|innerHTML)\\s*=\\s*([^;\\n]+)`,
        'g'
      );
      for (const match of text.matchAll(assignment)) {
        const literal = /^(['"`])([a-z0-9_]+)\1$/.exec(match[1].trim());
        if (!literal) {
          fail(match.index, `icon text must be assigned a literal icon name, found ${match[1].trim()}`);
        }
        names.push(literal[2]);
      }
    }
  }

  return names;
}

async function listSourceFiles(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) {
    return SCANNED_EXTENSIONS.has(path.extname(relativePath)) ? [relativePath] : [];
  }
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => listSourceFiles(repoRoot, path.join(relativePath, entry.name))));
  return nested.flat();
}

/**
 * Packaged HTML and JS files, relative to the repo root.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
export async function listPackagedSourceFiles(repoRoot) {
  const files = await Promise.all(PACKAGE_INCLUDE_PATHS.map(entry => listSourceFiles(repoRoot, entry)));
  return files.flat().sort();
}

/**
 * Every icon name the packaged extension uses, sorted and deduplicated.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
export async function collectIconNames(repoRoot) {
  const names = new Set();
  for (const file of await listPackagedSourceFiles(repoRoot)) {
    const text = await fs.readFile(path.join(repoRoot, file), 'utf8');
    for (const name of extractIconNames(text, file)) {
      names.add(name);
    }
  }
  return Array.from(names).sort();
}
