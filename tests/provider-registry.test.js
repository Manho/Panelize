import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  createProviderRegistry,
  defaultProviderRegistry,
  getProviderDescriptor,
  hasProviderDescriptor,
  listProviderDescriptors,
  registerExtraProviderDescriptors,
  resetExtraProviderDescriptors,
  validateProviderDescriptor,
  validateProviderDescriptors,
} from '../modules/provider-registry.js';

function makeValidDescriptor(overrides = {}) {
  return {
    id: 'test-local',
    name: 'Test Local',
    url: 'http://localhost:43110/',
    topLevelUrl: 'http://localhost:43110/',
    icon: '/icons/providers/chatgpt.png',
    iconDark: '/icons/providers/dark/chatgpt.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['http://localhost:43110'],
    allowedHosts: ['localhost'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: null,
    ...overrides,
  };
}

describe('provider-registry module', () => {
  afterEach(() => {
    resetExtraProviderDescriptors();
  });

  describe('BUILTIN_PROVIDER_DESCRIPTORS', () => {
    it('is frozen and validates every built-in descriptor with zero errors', () => {
      expect(Object.isFrozen(BUILTIN_PROVIDER_DESCRIPTORS)).toBe(true);
      expect(BUILTIN_PROVIDER_DESCRIPTORS).toHaveLength(14);

      for (const descriptor of BUILTIN_PROVIDER_DESCRIPTORS) {
        expect(Object.isFrozen(descriptor)).toBe(true);
        expect(validateProviderDescriptor(descriptor), descriptor.id).toEqual([]);
      }

      expect(validateProviderDescriptors(BUILTIN_PROVIDER_DESCRIPTORS)).toEqual([]);
    });

    it('has unique provider ids and unique frameRule ids across all built-in descriptors', () => {
      const ids = BUILTIN_PROVIDER_DESCRIPTORS.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);

      const ruleIds = BUILTIN_PROVIDER_DESCRIPTORS
        .filter((d) => d.frameRule !== null)
        .map((d) => d.frameRule.id);
      expect(ruleIds).toEqual([1001, 1002, 1003, 1004, 1005]);
      expect(new Set(ruleIds).size).toBe(ruleIds.length);
    });
  });

  describe('validateProviderDescriptor and validateProviderDescriptors', () => {
    it('rejects an empty or whitespace-only id', () => {
      expect(validateProviderDescriptor(makeValidDescriptor({ id: '' }))).not.toEqual([]);
      expect(validateProviderDescriptor(makeValidDescriptor({ id: '   ' }))).not.toEqual([]);
      expect(validateProviderDescriptor(makeValidDescriptor({ id: ' padded ' }))).not.toEqual([]);
    });

    it('rejects frame origins with a path, trailing slash, query, hash, or redundant default port', () => {
      for (const badOrigin of [
        'https://example.com/',
        'https://example.com/chat',
        'https://example.com?foo=1',
        'https://example.com#frag',
        'https://example.com:443',
      ]) {
        const errors = validateProviderDescriptor(
          makeValidDescriptor({ frameOrigins: [badOrigin] })
        );
        expect(errors, badOrigin).not.toEqual([]);
      }
    });

    it('rejects unsupported origin schemes such as ftp:', () => {
      const errors = validateProviderDescriptor(
        makeValidDescriptor({ frameOrigins: ['ftp://example.com'] })
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('ftp://example.com');
    });

    it('rejects non-bare allowedHosts entries containing a scheme, port, wildcard, or path', () => {
      for (const badHost of [
        'https://example.com',
        'localhost:43110',
        'example.com/chat',
        '*.example.com',
        '',
      ]) {
        const errors = validateProviderDescriptor(
          makeValidDescriptor({ allowedHosts: [badHost] })
        );
        expect(errors, badHost).not.toEqual([]);
      }
    });

    it('rejects duplicate provider ids and duplicate frameRule ids', () => {
      const first = makeValidDescriptor({
        id: 'dup-id',
        frameRule: { id: 1901, urlFilter: 'http://localhost:43110/*' },
      });
      const duplicateId = makeValidDescriptor({
        id: 'dup-id',
        frameRule: { id: 1902, urlFilter: 'http://localhost:43111/*' },
      });
      const duplicateRule = makeValidDescriptor({
        id: 'other-id',
        frameRule: { id: 1901, urlFilter: 'http://localhost:43112/*' },
      });

      const idErrors = validateProviderDescriptors([first, duplicateId]);
      expect(idErrors).toContain('Duplicate provider id: "dup-id"');
      expect(() => createProviderRegistry([first, duplicateId])).toThrow(/Duplicate provider id/);

      const ruleErrors = validateProviderDescriptors([first, duplicateRule]);
      expect(ruleErrors).toContain('Duplicate frameRule id: 1901');
      expect(() => createProviderRegistry([first, duplicateRule])).toThrow(/Duplicate frameRule id/);
    });
  });

  describe('createProviderRegistry', () => {
    it('is pure, freezes stored descriptors, and performs own-property-safe Map lookups', () => {
      const raw = makeValidDescriptor();
      const registry = createProviderRegistry([raw]);

      raw.name = 'Mutated Outside';
      expect(registry.get('test-local').name).toBe('Test Local');
      expect(Object.isFrozen(registry.get('test-local'))).toBe(true);

      expect(registry.has('test-local')).toBe(true);
      expect(registry.has('unknown')).toBe(false);
      for (const protoKey of ['__proto__', 'constructor', 'toString', 'valueOf']) {
        expect(registry.has(protoKey)).toBe(false);
        expect(registry.get(protoKey)).toBeUndefined();
      }

      // Default registry was not affected by createProviderRegistry
      expect(hasProviderDescriptor('test-local')).toBe(false);
    });
  });

  describe('registerExtraProviderDescriptors and resetExtraProviderDescriptors', () => {
    it('appends extra descriptors after built-ins and cleanly removes them on reset', () => {
      const extra = makeValidDescriptor({
        id: 'extra-local',
        frameRule: { id: 1999, urlFilter: 'http://localhost:43110/*' },
      });

      expect(defaultProviderRegistry.has('extra-local')).toBe(false);
      expect(listProviderDescriptors()).toHaveLength(14);

      registerExtraProviderDescriptors([extra]);

      expect(defaultProviderRegistry.has('extra-local')).toBe(true);
      expect(hasProviderDescriptor('extra-local')).toBe(true);
      expect(getProviderDescriptor('extra-local')).toMatchObject({
        id: 'extra-local',
        frameOrigins: ['http://localhost:43110'],
        allowedHosts: ['localhost'],
      });
      expect(listProviderDescriptors().map((d) => d.id)).toEqual([
        ...BUILTIN_PROVIDER_DESCRIPTORS.map((d) => d.id),
        'extra-local',
      ]);

      // Rejecting a colliding extra descriptor leaves the active registry intact.
      expect(() =>
        registerExtraProviderDescriptors([makeValidDescriptor({ id: 'chatgpt' })])
      ).toThrow(/Duplicate provider id/);
      expect(hasProviderDescriptor('extra-local')).toBe(true);

      resetExtraProviderDescriptors();

      expect(hasProviderDescriptor('extra-local')).toBe(false);
      expect(getProviderDescriptor('extra-local')).toBeUndefined();
      expect(listProviderDescriptors()).toEqual([...BUILTIN_PROVIDER_DESCRIPTORS]);
    });
  });
});
