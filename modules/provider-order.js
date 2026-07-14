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
