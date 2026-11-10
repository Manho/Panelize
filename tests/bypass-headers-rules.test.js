import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../modules/providers.js';
import { getProviderFrameOrigins } from '../modules/provider-open-url.js';

const rules = JSON.parse(readFileSync(resolve(process.cwd(), 'rules/bypass-headers.json'), 'utf8'));
const providerFrameOrigins = new Set(PROVIDERS.flatMap((provider) => getProviderFrameOrigins(provider.id)));

describe('static frame header rules', () => {
  it('uses unique rule ids', () => {
    const ids = rules.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(rules.map((rule) => [rule.id, rule]))('rule %s only targets a built-in provider frame', (_id, rule) => {
    const match = /^(https:\/\/[a-z0-9.-]+)\/\*$/.exec(rule.condition.urlFilter);
    expect(match, rule.condition.urlFilter).not.toBeNull();
    expect(providerFrameOrigins).toContain(match[1]);
    expect(rule.condition.resourceTypes).toEqual(['sub_frame']);
  });
});
