import { CUSTOM_PROVIDER_ID_PATTERN, hasProviderDescriptor } from './provider-registry.js';

function sanitizeProviderOrder(savedOrder, availableProviderIds) {
  const availableIds = Array.isArray(availableProviderIds) ? availableProviderIds : [];
  const availableIdSet = new Set(availableIds);
  const normalizedOrder = [];

  for (const providerId of Array.isArray(savedOrder) ? savedOrder : []) {
    if (availableIdSet.has(providerId) && !normalizedOrder.includes(providerId)) {
      normalizedOrder.push(providerId);
    }
  }

  return normalizedOrder;
}

export function normalizeProviderOrder(savedOrder, availableProviderIds) {
  const availableIds = Array.isArray(availableProviderIds) ? availableProviderIds : [];
  const normalizedOrder = sanitizeProviderOrder(savedOrder, availableIds);

  for (const providerId of availableIds) {
    if (!normalizedOrder.includes(providerId)) {
      normalizedOrder.push(providerId);
    }
  }

  return normalizedOrder;
}

export function appendProviderToOrder(savedOrder, fallbackOrder, providerId, availableProviderIds) {
  const availableIds = Array.isArray(availableProviderIds) ? availableProviderIds : [];
  const orderSource = Array.isArray(savedOrder) ? savedOrder : fallbackOrder;
  const providerOrder = sanitizeProviderOrder(orderSource, availableIds);

  if (availableIds.includes(providerId) && !providerOrder.includes(providerId)) {
    providerOrder.push(providerId);
  }

  return providerOrder;
}

/**
 * Re-inserts custom provider IDs from `previousIds` that are not known on the
 * local device into `nextIds` at their previous relative positions. Unknown IDs
 * that do not match the custom ID pattern continue to be dropped.
 *
 * @param {string[]} nextIds
 * @param {unknown} previousIds
 * @param {(id: string) => boolean} [isKnownId]
 * @returns {string[]}
 */
export function preserveForeignCustomIds(nextIds, previousIds, isKnownId = hasProviderDescriptor) {
  const baseNext = Array.isArray(nextIds) ? [...nextIds] : [];
  if (!Array.isArray(previousIds) || previousIds.length === 0) {
    return baseNext;
  }

  const checkKnown = typeof isKnownId === 'function' ? isKnownId : () => false;
  const nextSet = new Set(baseNext);
  const seenSurvivingInPrev = new Set();
  const seenForeign = new Set();
  const buckets = new Map();

  let survivingSlot = 0;
  for (const id of previousIds) {
    if (typeof id !== 'string') {
      continue;
    }

    if (nextSet.has(id)) {
      if (!seenSurvivingInPrev.has(id)) {
        seenSurvivingInPrev.add(id);
        survivingSlot += 1;
      }
      continue;
    }

    if (CUSTOM_PROVIDER_ID_PATTERN.test(id) && !checkKnown(id) && !seenForeign.has(id)) {
      seenForeign.add(id);
      if (!buckets.has(survivingSlot)) {
        buckets.set(survivingSlot, []);
      }
      buckets.get(survivingSlot).push(id);
    }
  }

  if (seenForeign.size === 0) {
    return baseNext;
  }

  const result = [...(buckets.get(0) || [])];
  let emittedSurviving = 0;
  const countedInNext = new Set();

  for (const id of baseNext) {
    result.push(id);
    if (seenSurvivingInPrev.has(id) && !countedInNext.has(id)) {
      countedInNext.add(id);
      emittedSurviving += 1;
      const slotItems = buckets.get(emittedSurviving);
      if (slotItems) {
        result.push(...slotItems);
      }
    }
  }

  return result;
}
