import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('bypass header rules', () => {
  const rules = JSON.parse(
    readFileSync(resolve(process.cwd(), 'rules/bypass-headers.json'), 'utf8')
  );

  it('removes frame-blocking headers for all production iframe panels', () => {
    const rulesByUrlFilter = new Map(
      rules.map((rule) => [rule.condition.urlFilter, rule])
    );

    const productionUrlFilters = [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      'https://grok.com/*',
      'https://chat.deepseek.com/*',
      'https://www.google.com/*',
      'https://chat.z.ai/*',
      'https://chat.qwen.ai/*',
    ];

    for (const urlFilter of productionUrlFilters) {
      const rule = rulesByUrlFilter.get(urlFilter);

      expect(rule).toBeTruthy();
      expect(rule.condition.resourceTypes).toContain('sub_frame');
      expect(rule.action.type).toBe('modifyHeaders');
      expect(rule.action.responseHeaders).toEqual(expect.arrayContaining([
        { header: 'X-Frame-Options', operation: 'remove' },
        { header: 'Content-Security-Policy', operation: 'remove' },
      ]));
    }
  });

  it('keeps the localhost iframe bypass rule scoped to X-Frame-Options', () => {
    const localhostRule = rules.find((rule) =>
      rule.condition.urlFilter === 'http://localhost:3000/*'
    );

    expect(localhostRule).toBeTruthy();
    expect(localhostRule.condition.resourceTypes).toContain('sub_frame');
    expect(localhostRule.action.type).toBe('modifyHeaders');
    expect(localhostRule.action.responseHeaders).toEqual([
      { header: 'X-Frame-Options', operation: 'remove' },
    ]);
  });
});
