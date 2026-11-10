import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The manifest CSP is `script-src 'self'`, so inline event handler attributes,
// inline <script> bodies and javascript: URLs in extension pages never run.
// This guard scans every extension source file for them.

const ROOT = resolve(process.cwd());
// Third-party bundles, tooling and test code are not extension markup.
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'libs', 'tests', 'scripts', 'test-results', 'playwright-report', 'dist', 'artifacts'
]);
const SCANNED_EXTENSIONS = new Set(['.html', '.js']);

function listSourceFiles(directory = ROOT) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : listSourceFiles(fullPath);
    }
    if (!SCANNED_EXTENSIONS.has(extname(entry.name))) {
      return [];
    }
    // Root-level config files run in Node, not in the extension.
    if (directory === ROOT && entry.name.endsWith('.config.js')) {
      return [];
    }
    return [fullPath];
  });
}

const PATTERNS = [
  {
    name: 'inline event handler attribute in markup',
    // A tag opening such as `<button class="x" onclick=` in HTML or in a JS
    // string/template literal. `el.onclick = fn` has no tag opening.
    regex: /<[a-z][\w-]*\b[^<>]*?\son[a-z]+\s*=/gi,
  },
  {
    name: 'inline event handler set through setAttribute',
    regex: /setAttribute(?:NS)?\(\s*(?:[^,]+,\s*)?['"`]on[a-z]+['"`]/gi,
  },
  {
    name: 'javascript: URL',
    regex: /(?:href|src|action|formaction)\s*=\s*["'`]?\s*javascript:/gi,
  },
];

const HTML_ONLY_PATTERNS = [
  {
    name: 'inline <script> body',
    regex: /<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*\S/gi,
  },
];

/**
 * Blanks every `${...}` template interpolation (nested braces included) so
 * expressions such as `${a > b ? 'x' : 'y'}` cannot end a tag early. Line
 * breaks are kept, so reported line numbers stay right.
 */
function blankInterpolations(source) {
  let result = '';
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (depth === 0 && char === '$' && source[index + 1] === '{') {
      depth = 1;
      result += '  ';
      index += 1;
      continue;
    }
    if (depth > 0) {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      result += char === '\n' ? '\n' : ' ';
      continue;
    }
    result += char;
  }
  return result;
}

function findCspViolations(rawSource, { html = false } = {}) {
  const source = blankInterpolations(rawSource);
  const patterns = html ? [...PATTERNS, ...HTML_ONLY_PATTERNS] : PATTERNS;
  return patterns.flatMap(({ name, regex }) => [...source.matchAll(regex)].map((match) => ({
    name,
    line: source.slice(0, match.index).split('\n').length,
    excerpt: match[0].slice(0, 120),
  })));
}

describe('extension sources contain no CSP-blocked inline script', () => {
  const files = listSourceFiles();

  it('scans the extension pages and scripts', () => {
    const relativePaths = files.map((file) => relative(ROOT, file));
    expect(relativePaths).toEqual(expect.arrayContaining([
      'multi-panel/multi-panel.html',
      'multi-panel/multi-panel.js',
      'options/options.html',
      'options/options.js',
      'background/service-worker.js',
      'content-scripts/text-injection-all-providers.js',
      'data/prompt-libraries/guide.en.html',
    ]));
    expect(relativePaths.some((path) => path.startsWith('libs/'))).toBe(false);
  });

  it.each(files.map((file) => [relative(ROOT, file), file]))('%s', (_relativePath, file) => {
    const source = readFileSync(file, 'utf8');
    expect(findCspViolations(source, { html: file.endsWith('.html') })).toEqual([]);
  });
});

describe('findCspViolations', () => {
  it.each([
    ['an onclick attribute in a template literal', '`<button class="remove" onclick="remove(1)">x</button>`'],
    ['an onerror attribute on a later line of a tag', '`<img src="${src}" alt="x"\n     onerror="this.remove()" />`'],
    ['an unquoted handler', "'<div onmouseover=go()>'"],
    ['a handler set through setAttribute', "button.setAttribute('onclick', 'go()');"],
    ['a javascript: link', '`<a href="javascript:void(0)">x</a>`'],
    ['a handler after an interpolation with a > comparison',
      "`<div class=\"${a > b ? 'x' : 'y'}\" onclick=\"go()\">x</div>`"],
    ['a handler after a nested interpolation', '`<p title="${f({ a: `${b}` })}" onload="go()"></p>`'],
  ])('flags %s', (_label, source) => {
    expect(findCspViolations(source)).not.toEqual([]);
  });

  it('flags an inline script body in HTML', () => {
    expect(findCspViolations('<script>\n  start();\n</script>', { html: true })).not.toEqual([]);
  });

  it.each([
    ['a handler property assignment', 'button.onclick = () => go();'],
    ['addEventListener', "button.addEventListener('click', go);"],
    ['a comparison followed by a handler property', 'for (let i = 0; i<count; i++) { el.onload = done; }'],
    ['a data attribute that starts with on', '`<div data-online="true">x</div>`'],
    ['an external script tag', '<script src="options.js"></script>'],
    ['a module script tag', '<script type="module" src="./multi-panel.js"></script>'],
  ])('allows %s', (_label, source) => {
    expect(findCspViolations(source, { html: true })).toEqual([]);
  });
});
