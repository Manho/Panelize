import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdownToFragment, sanitizeMarkdownLinkHref } from '../modules/markdown-dom.js';

describe('markdown-dom safe DOM renderer', () => {
  it('never uses innerHTML or outerHTML in modules/markdown-dom.js', () => {
    const source = readFileSync(resolve(process.cwd(), 'modules/markdown-dom.js'), 'utf8');
    expect(source).not.toMatch(/\binnerHTML\b/);
    expect(source).not.toMatch(/\bouterHTML\b/);
    expect(source).not.toMatch(/\binsertAdjacentHTML\b/);
  });

  it('sanitizes link href schemes strictly to http, https, and mailto', () => {
    expect(sanitizeMarkdownLinkHref('https://example.com/docs')).toBe('https://example.com/docs');
    expect(sanitizeMarkdownLinkHref('http://localhost:11434')).toBe('http://localhost:11434/');
    expect(sanitizeMarkdownLinkHref('mailto:dev@example.com')).toBe('mailto:dev@example.com');
    expect(sanitizeMarkdownLinkHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeMarkdownLinkHref('JAVASCRIPT:alert(1)')).toBeNull();
    expect(sanitizeMarkdownLinkHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeMarkdownLinkHref('vbscript:msgbox(1)')).toBeNull();
  });

  it('renders rich Markdown structures into safe DOM nodes and neutralizes XSS payloads', () => {
    const onCopyCode = vi.fn();
    const markdown = [
      '# Comparison Summary',
      '',
      'Here is **bold**, *italic*, ~~strike~~, `inline()`, and [Docs](https://example.com) vs [Bad](javascript:alert(1)).',
      '',
      '<img src=x onerror="window.__xss = true"><script>window.__xss = true;</script>',
      '',
      '- First item',
      '- Second item',
      '',
      '| Model | Speed |',
      '| :--- | ---: |',
      '| Qwen | Fast |',
      '',
      '```js',
      'console.log("safe");',
      '```'
    ].join('\n');

    const container = document.createElement('div');
    container.appendChild(renderMarkdownToFragment(markdown, { document, onCopyCode }));

    expect(container.querySelector('h1')?.textContent).toBe('Comparison Summary');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('del')?.textContent).toBe('strike');
    expect(container.querySelector('.md-inline-code')?.textContent).toBe('inline()');

    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');

    // XSS tags remain inert text nodes, never real elements
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="window.__xss = true">');

    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelector('table th')?.textContent).toBe('Model');
    expect(container.querySelector('table td:last-child')?.style.textAlign).toBe('right');

    const copyBtn = container.querySelector('.md-code-copy-btn');
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    expect(onCopyCode).toHaveBeenCalledWith('console.log("safe");', copyBtn);
  });
});
