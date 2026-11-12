// T050-T064: Settings Page Implementation
import { listProviders, getProviderIcon } from '../modules/providers.js';
import {
  getProviderDescriptor,
  hasProviderDescriptor,
  listProviderDescriptors
} from '../modules/provider-registry.js';
import {
  addCustomProvider,
  allocateCustomFrameRuleId,
  generateCustomProviderId,
  getCustomProviderOrigin,
  loadCustomProviders,
  MAX_CUSTOM_API_MODEL_LENGTH,
  MAX_CUSTOM_PROVIDER_NAME_LENGTH,
  removeCustomProvider,
  subscribeCustomProvidersChanged,
  updateCustomProvider,
  validateCustomApiEndpointUrl,
  validateCustomProviderUrl
} from '../modules/custom-providers.js';
import {
  deleteCustomApiKey,
  getCustomApiKey,
  MAX_CUSTOM_API_KEY_LENGTH,
  saveCustomApiKey
} from '../modules/custom-api-secrets.js';
import {
  fetchOpenAiModels,
  resolveModelsUrl
} from '../modules/openai-chat-client.js';
import { DEFAULT_PROVIDER_IDS } from '../modules/provider-defaults.js';
import {
  appendProviderToOrder,
  normalizeProviderOrder,
  preserveForeignCustomIds
} from '../modules/provider-order.js';
import {
  hasOptionalProviderPermission,
  requestOptionalProviderPermission,
  supportsScopedFrameRules
} from '../modules/optional-provider-access.js';
import { getSettings, getSetting, saveSettings, saveSetting, resetSettings, exportSettings, importSettings } from '../modules/settings.js';
import {
  DEFAULT_GOOGLE_PROVIDER_MODE,
  GOOGLE_PROVIDER_MODE_AI,
  GOOGLE_PROVIDER_MODE_SEARCH,
  normalizeGoogleProviderMode
} from '../modules/google-mode.js';
import { applyTheme } from '../modules/theme-manager.js';
import {
  getAllPrompts,
  exportPrompts,
  importPrompts,
  clearAllPrompts,
  importDefaultLibrary
} from '../modules/prompt-manager.js';
import {
  loadVersionInfo,
  checkForUpdates
} from '../modules/version-checker.js';
import { t, translatePage, getCurrentLanguage, initializeLanguage } from '../modules/i18n.js';
const DEFAULT_ENABLED_PROVIDERS = DEFAULT_PROVIDER_IDS;

export const CUSTOM_URL_REASON_MESSAGE_KEYS = Object.freeze({
  invalid_url: 'errCustomUrlInvalid',
  unsupported_scheme: 'errCustomUrlUnsupportedScheme',
  empty_host: 'errCustomUrlEmptyHost',
  credentials_not_allowed: 'errCustomUrlCredentials',
  insecure_http: 'errCustomUrlInsecureHttp',
  builtin_origin: 'errCustomUrlBuiltinOrigin',
  duplicate_custom_origin: 'errCustomUrlDuplicateOrigin'
});

let isSubmittingCustomProvider = false;
let isSubmittingInlineEdit = false;
let editingCustomProviderId = null;
let activeInlineEditState = null;
let addFormModelCombobox = null;
let sessionModelsRuleSeq = 0;

const modelCatalogCache = new Map();
const transientProbedOrigins = new Set();

function getEditingCustomProviderDescriptor() {
  if (!editingCustomProviderId) {
    return null;
  }
  const descriptor = getProviderDescriptor(editingCustomProviderId);
  return descriptor?.access === 'custom' ? descriptor : null;
}

function focusCustomProviderEditButton(providerId) {
  if (!providerId) {
    return;
  }
  const buttons = document.querySelectorAll(
    '#provider-list [data-action="edit-custom-provider"]'
  );
  for (const button of buttons) {
    if (button.dataset.providerId === providerId) {
      button.focus?.();
      return;
    }
  }
}

export function getCustomProviderUrlErrorMessage(reason) {
  const key = CUSTOM_URL_REASON_MESSAGE_KEYS[reason] || 'errCustomUrlInvalid';
  return t(key);
}

export function isOriginUsedByAnyProvider(origin, { excludeProviderId = null } = {}) {
  if (typeof origin !== 'string' || origin.length === 0) {
    return false;
  }
  const matchPattern = `${origin}/*`;
  return listProviderDescriptors().some((descriptor) => {
    if (excludeProviderId && descriptor.id === excludeProviderId) {
      return false;
    }
    if (descriptor.frameOrigins?.includes(origin)) {
      return true;
    }
    if (descriptor.permissionOrigins?.includes(matchPattern)) {
      return true;
    }
    return false;
  });
}

async function withTemporaryOriginStripSessionRule(origin, fn) {
  const dnr = chrome?.declarativeNetRequest;
  const extensionId = chrome?.runtime?.id;
  if (typeof dnr?.updateSessionRules !== 'function' || !extensionId || !origin) {
    return fn();
  }
  const ruleId = 19950 + (sessionModelsRuleSeq++ % 40);
  let installed = false;
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 2,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Origin', operation: 'remove' }]
          },
          condition: {
            urlFilter: `|${origin}/`,
            initiatorDomains: [extensionId],
            resourceTypes: ['xmlhttprequest', 'other']
          }
        }
      ]
    });
    installed = true;
  } catch {
    installed = false;
  }

  try {
    return await fn();
  } finally {
    if (installed) {
      await dnr.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
    }
  }
}

async function cleanupUnusedProbedOrigins({ keepOrigin = null } = {}) {
  const probed = [...transientProbedOrigins];
  for (const origin of probed) {
    transientProbedOrigins.delete(origin);
    if (origin === keepOrigin) {
      continue;
    }
    if (!isOriginUsedByAnyProvider(origin) && chrome?.permissions?.remove) {
      await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => {});
    }
  }
}

function createModelComboboxController({
  idPrefix,
  fieldContainer,
  modelInput,
  loadButton,
  listbox,
  countBadge,
  hintEl,
  getEndpointRawUrl,
  resolveEffectiveApiKey,
  onInvalidUrl,
  onSelectModel,
  isEnabledKind
}) {
  let loadedModels = [];
  let loadedSourceKey = '';
  let inFlightSourceKey = '';
  let requestGeneration = 0;
  let isLoading = false;
  let disabledByForm = false;
  let isOpen = false;
  let filterByInput = false;
  let activeIndex = -1;
  let filteredModels = [];
  let activeAbortController = null;
  let documentListenersBound = false;
  let destroyed = false;

  const showHint = (message) => {
    if (!hintEl) {
      return;
    }
    hintEl.textContent = message;
    hintEl.hidden = !message;
  };

  const hideHint = () => {
    if (!hintEl) {
      return;
    }
    hintEl.textContent = '';
    hintEl.hidden = true;
  };

  const syncUiLabels = () => {
    if (loadButton) {
      if (isLoading) {
        loadButton.textContent = t('msgModelsLoading');
        loadButton.disabled = true;
      } else {
        const btnKey = loadedModels.length > 0 ? 'btnRefreshModels' : 'btnLoadModels';
        loadButton.dataset.i18n = btnKey;
        loadButton.textContent = t(btnKey);
        loadButton.disabled = disabledByForm;
      }
    }
    if (countBadge) {
      if (loadedModels.length > 0) {
        countBadge.textContent = t('msgModelsLoadedCount', String(loadedModels.length));
        countBadge.hidden = false;
      } else {
        countBadge.textContent = '';
        countBadge.hidden = true;
      }
    }
  };

  const computeFilteredModels = () => {
    if (!filterByInput) {
      return loadedModels;
    }
    const rawQuery = (modelInput?.value || '').trim().toLowerCase();
    if (!rawQuery) {
      return loadedModels;
    }
    const tokens = rawQuery.split(/\s+/).filter(Boolean);
    return loadedModels.filter((entry) => {
      const haystack = `${entry.id} ${entry.name || ''}`.toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    });
  };

  const onDocumentPointerDown = (event) => {
    if (!fieldContainer?.contains(event.target)) {
      closeListbox();
    }
  };

  const onDocumentFocusIn = (event) => {
    if (!fieldContainer?.contains(event.target)) {
      closeListbox();
    }
  };

  const bindDocumentListeners = () => {
    if (documentListenersBound) {
      return;
    }
    documentListenersBound = true;
    document.addEventListener('mousedown', onDocumentPointerDown);
    document.addEventListener('focusin', onDocumentFocusIn);
  };

  const unbindDocumentListeners = () => {
    if (!documentListenersBound) {
      return;
    }
    documentListenersBound = false;
    document.removeEventListener('mousedown', onDocumentPointerDown);
    document.removeEventListener('focusin', onDocumentFocusIn);
  };

  const renderListbox = () => {
    if (!listbox) {
      return;
    }
    if (!isOpen || loadedModels.length === 0 || !isEnabledKind()) {
      listbox.hidden = true;
      listbox.replaceChildren();
      modelInput?.setAttribute('aria-expanded', 'false');
      modelInput?.removeAttribute('aria-activedescendant');
      return;
    }

    filteredModels = computeFilteredModels();
    listbox.replaceChildren();
    listbox.hidden = false;
    modelInput?.setAttribute('aria-expanded', 'true');

    if (filteredModels.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'custom-provider-model-empty';
      emptyEl.textContent = t('msgModelsNoMatch');
      listbox.appendChild(emptyEl);
      activeIndex = -1;
      modelInput?.removeAttribute('aria-activedescendant');
      return;
    }

    if (activeIndex >= filteredModels.length) {
      activeIndex = filteredModels.length - 1;
    }

    const currentVal = (modelInput?.value || '').trim();
    const fragment = document.createDocumentFragment();
    let scrollTargetEl = null;

    filteredModels.forEach((entry, index) => {
      const optionEl = document.createElement('div');
      optionEl.className = 'custom-provider-model-option';
      optionEl.id = `${idPrefix}-opt-${index}`;
      optionEl.setAttribute('role', 'option');
      optionEl.dataset.modelId = entry.id;
      const isSelected = entry.id === currentVal;
      optionEl.setAttribute('aria-selected', isSelected ? 'true' : 'false');

      if (index === activeIndex) {
        optionEl.classList.add('is-active');
        modelInput?.setAttribute('aria-activedescendant', optionEl.id);
        scrollTargetEl = optionEl;
      } else if (isSelected && !scrollTargetEl) {
        scrollTargetEl = optionEl;
      }

      const idSpan = document.createElement('span');
      idSpan.className = 'custom-provider-model-option-id';
      idSpan.textContent = entry.id;
      optionEl.appendChild(idSpan);

      if (entry.name) {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'custom-provider-model-option-name';
        nameSpan.textContent = entry.name;
        optionEl.appendChild(nameSpan);
      }

      optionEl.addEventListener('mousedown', (event) => {
        event.preventDefault();
        selectModel(entry);
      });
      optionEl.addEventListener('click', (event) => {
        event.preventDefault();
        selectModel(entry);
      });

      fragment.appendChild(optionEl);
    });

    listbox.appendChild(fragment);
    if (activeIndex < 0) {
      modelInput?.removeAttribute('aria-activedescendant');
    }
    scrollTargetEl?.scrollIntoView?.({ block: 'nearest' });
  };

  function openListbox({ filter = false } = {}) {
    if (destroyed || loadedModels.length === 0 || !isEnabledKind() || disabledByForm) {
      return;
    }
    filterByInput = filter;
    isOpen = true;
    bindDocumentListeners();
    const candidates = computeFilteredModels();
    const currentVal = (modelInput?.value || '').trim();
    const selectedIdx = candidates.findIndex((entry) => entry.id === currentVal);
    activeIndex = selectedIdx >= 0 ? selectedIdx : (filter && candidates.length > 0 ? 0 : -1);
    renderListbox();
  }

  function closeListbox() {
    isOpen = false;
    activeIndex = -1;
    unbindDocumentListeners();
    renderListbox();
  }

  function selectModel(entry) {
    if (!entry || !modelInput) {
      return;
    }
    modelInput.value = entry.id;
    closeListbox();
    onSelectModel?.(entry);
    modelInput.focus?.();
  }

  function invalidateCatalog() {
    requestGeneration += 1;
    const prevController = activeAbortController;
    activeAbortController = null;
    inFlightSourceKey = '';
    isLoading = false;
    prevController?.abort();
    loadedModels = [];
    loadedSourceKey = '';
    closeListbox();
    hideHint();
    syncUiLabels();
  }

  async function loadModels({ interactive = false, openWhenLoaded = false } = {}) {
    if (destroyed || disabledByForm || !isEnabledKind() || !supportsScopedFrameRules()) {
      return false;
    }

    const rawUrl = getEndpointRawUrl();
    const urlCheck = validateCustomApiEndpointUrl(rawUrl);
    if (!urlCheck.ok) {
      if (interactive) {
        onInvalidUrl?.(urlCheck.reason);
      }
      return false;
    }

    const expectedModelsUrl = resolveModelsUrl(urlCheck.endpointUrl);
    const permissionOrigin = `${urlCheck.origin}/*`;
    let permissionPromise;
    if (interactive) {
      // Must invoke chrome.permissions.request synchronously before any await
      // to preserve Chrome's transient user activation from clicking Load models.
      try {
        permissionPromise = chrome?.permissions?.request
          ? chrome.permissions.request({ origins: [permissionOrigin] })
          : Promise.resolve(false);
      } catch {
        showHint(t('msgProviderPermissionRequestFailed', urlCheck.origin));
        return false;
      }
    } else {
      permissionPromise = chrome?.permissions?.contains
        ? chrome.permissions.contains({ origins: [permissionOrigin] })
        : Promise.resolve(false);
    }

    requestGeneration += 1;
    const myGeneration = requestGeneration;
    activeAbortController?.abort();
    const abortController = new AbortController();
    activeAbortController = abortController;
    inFlightSourceKey = expectedModelsUrl;
    isLoading = true;
    hideHint();
    syncUiLabels();

    const isRequestCurrent = () => {
      if (
        destroyed ||
        abortController.signal.aborted ||
        activeAbortController !== abortController ||
        requestGeneration !== myGeneration ||
        !isEnabledKind()
      ) {
        return false;
      }
      const currentCheck = validateCustomApiEndpointUrl(getEndpointRawUrl());
      if (!currentCheck.ok) {
        return false;
      }
      return resolveModelsUrl(currentCheck.endpointUrl) === expectedModelsUrl;
    };

    try {
      let granted = false;
      try {
        granted = Boolean(await permissionPromise);
      } catch {
        if (isRequestCurrent() && interactive) {
          showHint(t('msgProviderPermissionRequestFailed', urlCheck.origin));
        }
        return false;
      }

      if (!isRequestCurrent()) {
        return false;
      }

      if (!granted) {
        if (interactive) {
          showHint(t('msgCustomProviderPermissionDenied', urlCheck.origin));
        }
        return false;
      }

      if (interactive && !isOriginUsedByAnyProvider(urlCheck.origin)) {
        transientProbedOrigins.add(urlCheck.origin);
      }

      const apiKey = await resolveEffectiveApiKey(urlCheck.origin);
      if (!isRequestCurrent()) {
        return false;
      }

      const cacheKey = `${expectedModelsUrl}\n${apiKey || ''}`;

      let models = null;
      if (!interactive && modelCatalogCache.has(cacheKey)) {
        models = modelCatalogCache.get(cacheKey);
      } else {
        const result = await withTemporaryOriginStripSessionRule(urlCheck.origin, () =>
          fetchOpenAiModels({
            endpointUrl: urlCheck.endpointUrl,
            apiKey,
            signal: abortController.signal
          })
        );
        models = result.models;
        modelCatalogCache.set(cacheKey, models);
      }

      if (!isRequestCurrent()) {
        return false;
      }

      loadedModels = models;
      loadedSourceKey = expectedModelsUrl;
      hideHint();
      syncUiLabels();

      if (openWhenLoaded && loadedModels.length > 0) {
        const currentVal = (modelInput?.value || '').trim();
        const shouldFilter =
          currentVal.length > 0 && !loadedModels.some((entry) => entry.id === currentVal);
        if (interactive) {
          modelInput?.focus?.();
        }
        openListbox({ filter: shouldFilter });
      } else if (isOpen) {
        renderListbox();
      }
      return true;
    } catch (error) {
      if (!isRequestCurrent() || error?.name === 'AbortError') {
        return false;
      }
      if (interactive) {
        const reason = error?.message || 'HTTP error';
        showHint(t('errModelsLoadFailed', reason));
      }
      return false;
    } finally {
      if (activeAbortController === abortController) {
        activeAbortController = null;
        inFlightSourceKey = '';
        isLoading = false;
        syncUiLabels();
      }
    }
  }

  const syncEndpointContext = () => {
    const rawUrl = getEndpointRawUrl();
    const urlCheck = validateCustomApiEndpointUrl(rawUrl);
    const nextModelsUrl = urlCheck.ok ? resolveModelsUrl(urlCheck.endpointUrl) : '';
    if (
      (inFlightSourceKey && inFlightSourceKey !== nextModelsUrl) ||
      (loadedSourceKey && loadedSourceKey !== nextModelsUrl)
    ) {
      invalidateCatalog();
    }
  };

  loadButton?.addEventListener('click', (event) => {
    event.preventDefault();
    loadModels({ interactive: true, openWhenLoaded: true });
  });

  modelInput?.addEventListener('focus', () => {
    if (isOpen) {
      return;
    }
    if (loadedModels.length > 0) {
      openListbox({ filter: false });
    } else {
      loadModels({ interactive: false, openWhenLoaded: true });
    }
  });

  fieldContainer?.addEventListener('focusout', (event) => {
    const nextTarget = event.relatedTarget;
    if (isOpen && nextTarget && !fieldContainer.contains(nextTarget)) {
      closeListbox();
    }
  });

  modelInput?.addEventListener('click', () => {
    if (!isOpen && loadedModels.length > 0) {
      openListbox({ filter: false });
    }
  });

  modelInput?.addEventListener('input', () => {
    if (loadedModels.length > 0) {
      openListbox({ filter: true });
    }
  });

  modelInput?.addEventListener('keydown', (event) => {
    if (event.isComposing) {
      return;
    }
    if (event.key === 'ArrowDown') {
      if (!isOpen && loadedModels.length > 0) {
        event.preventDefault();
        openListbox({ filter: false });
        return;
      }
      if (isOpen && filteredModels.length > 0) {
        event.preventDefault();
        activeIndex = Math.min(filteredModels.length - 1, activeIndex + 1);
        renderListbox();
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      if (isOpen && filteredModels.length > 0) {
        event.preventDefault();
        activeIndex = activeIndex <= 0 ? 0 : activeIndex - 1;
        renderListbox();
      }
      return;
    }

    if (event.key === 'Enter') {
      if (isOpen && activeIndex >= 0 && filteredModels[activeIndex]) {
        event.preventDefault();
        event.stopPropagation();
        selectModel(filteredModels[activeIndex]);
      }
      return;
    }

    if (event.key === 'Escape') {
      if (isOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeListbox();
      }
      return;
    }

    if (event.key === 'Tab') {
      closeListbox();
    }
  });

  syncUiLabels();

  return {
    loadModels,
    openListbox,
    closeListbox,
    syncEndpointContext,
    invalidateCatalog,
    setDisabled(nextDisabled) {
      disabledByForm = Boolean(nextDisabled);
      if (disabledByForm) {
        closeListbox();
      }
      syncUiLabels();
    },
    reset() {
      invalidateCatalog();
    },
    refreshTranslations() {
      syncUiLabels();
      if (isOpen) {
        renderListbox();
      }
    },
    destroy() {
      destroyed = true;
      requestGeneration += 1;
      const prevController = activeAbortController;
      activeAbortController = null;
      inFlightSourceKey = '';
      isLoading = false;
      prevController?.abort();
      closeListbox();
    }
  };
}

function getCustomProviderFormElements() {
  return {
    form: document.getElementById('custom-provider-form'),
    formTitle: document.getElementById('custom-provider-form-title'),
    kindWebRadio: document.getElementById('custom-provider-kind-web'),
    kindApiRadio: document.getElementById('custom-provider-kind-api'),
    nameInput: document.getElementById('custom-provider-name'),
    urlLabel: document.getElementById('custom-provider-url-label'),
    urlInput: document.getElementById('custom-provider-url'),
    apiFieldsWrapper: document.getElementById('custom-provider-api-fields'),
    modelFieldContainer: document
      .getElementById('custom-provider-model')
      ?.closest('.custom-provider-field-model'),
    modelInput: document.getElementById('custom-provider-model'),
    modelCountBadge: document.getElementById('custom-provider-model-count'),
    loadModelsButton: document.getElementById('custom-provider-load-models-btn'),
    modelListbox: document.getElementById('custom-provider-model-listbox'),
    modelHint: document.getElementById('custom-provider-model-hint'),
    apiKeyInput: document.getElementById('custom-provider-api-key'),
    apiKeyToggleButton: document.getElementById('custom-provider-api-key-toggle'),
    apiNote: document.getElementById('custom-provider-api-note'),
    addButton: document.getElementById('custom-provider-add-btn'),
    originPreview: document.getElementById('custom-provider-origin-preview'),
    errorMessage: document.getElementById('custom-provider-error'),
    unsupportedNote: document.getElementById('custom-provider-unsupported')
  };
}

function getSelectedCustomProviderKind() {
  const checked = document.querySelector('input[name="customProviderKind"]:checked');
  return checked?.value === 'api' ? 'api' : 'web';
}

function setPasswordFieldRevealedState(inputEl, toggleButtonEl, revealed) {
  if (!inputEl || !toggleButtonEl) {
    return;
  }
  inputEl.type = revealed ? 'text' : 'password';
  toggleButtonEl.setAttribute('aria-pressed', revealed ? 'true' : 'false');
  const i18nKey = revealed ? 'btnHideApiKey' : 'btnShowApiKey';
  toggleButtonEl.dataset.i18n = i18nKey;
  toggleButtonEl.textContent = t(i18nKey);
}

function setApiKeyRevealedState(revealed) {
  const { apiKeyInput, apiKeyToggleButton } = getCustomProviderFormElements();
  setPasswordFieldRevealedState(apiKeyInput, apiKeyToggleButton, revealed);
}

export function syncCustomProviderKindFields() {
  const {
    formTitle,
    urlLabel,
    urlInput,
    apiFieldsWrapper,
    modelInput,
    apiKeyInput,
    apiNote,
    addButton
  } = getCustomProviderFormElements();
  const isApi = getSelectedCustomProviderKind() === 'api';

  if (formTitle) {
    formTitle.dataset.i18n = 'headingAddCustomProvider';
    formTitle.textContent = t('headingAddCustomProvider');
  }
  if (addButton) {
    addButton.dataset.i18n = 'btnAddCustomProvider';
    addButton.textContent = t('btnAddCustomProvider');
  }

  if (apiFieldsWrapper) {
    apiFieldsWrapper.hidden = !isApi;
  }
  if (apiNote) {
    apiNote.hidden = !isApi;
  }
  if (modelInput) {
    modelInput.required = isApi;
  }
  if (!isApi) {
    addFormModelCombobox?.closeListbox();
  }
  if (urlLabel) {
    const labelKey = isApi ? 'labelCustomApiEndpointUrl' : 'labelCustomProviderUrl';
    urlLabel.dataset.i18n = labelKey;
    urlLabel.textContent = t(labelKey);
  }
  if (urlInput) {
    const placeholderKey = isApi
      ? 'placeholderCustomApiEndpointUrl'
      : 'placeholderCustomProviderUrl';
    urlInput.dataset.i18nPlaceholder = placeholderKey;
    urlInput.placeholder = t(placeholderKey);
  }
  if (apiKeyInput) {
    apiKeyInput.dataset.i18nPlaceholder = 'placeholderCustomProviderApiKey';
    apiKeyInput.placeholder = t('placeholderCustomProviderApiKey');
  }
}

export function syncCustomProviderFormAvailability() {
  const {
    kindWebRadio,
    kindApiRadio,
    nameInput,
    urlInput,
    modelInput,
    apiKeyInput,
    apiKeyToggleButton,
    addButton,
    unsupportedNote
  } = getCustomProviderFormElements();
  const supported = supportsScopedFrameRules();
  const disabled = !supported || isSubmittingCustomProvider;

  syncCustomProviderKindFields();

  if (unsupportedNote) {
    unsupportedNote.textContent = t('msgCustomProviderUnsupportedChrome');
    unsupportedNote.hidden = supported;
  }
  if (kindWebRadio) {
    kindWebRadio.disabled = disabled;
  }
  if (kindApiRadio) {
    kindApiRadio.disabled = disabled;
  }
  if (nameInput) {
    nameInput.disabled = disabled;
  }
  if (urlInput) {
    urlInput.disabled = disabled;
  }
  if (modelInput) {
    modelInput.disabled = disabled;
  }
  if (apiKeyInput) {
    apiKeyInput.disabled = disabled;
  }
  if (apiKeyToggleButton) {
    apiKeyToggleButton.disabled = disabled;
  }
  if (addButton) {
    addButton.disabled = disabled;
  }
  addFormModelCombobox?.setDisabled(disabled);

  if (activeInlineEditState) {
    activeInlineEditState.syncAvailability();
  }
}

function applyInlineEditToRenderedRows() {
  document
    .querySelectorAll('#provider-list .provider-item[data-custom-provider="true"]')
    .forEach((row) => {
      const rowId = row.dataset.providerId;
      const isRowEditing = Boolean(
        editingCustomProviderId &&
        rowId === editingCustomProviderId &&
        activeInlineEditState?.providerId === rowId
      );
      const editBtn = row.querySelector('[data-action="edit-custom-provider"]');
      if (editBtn) {
        editBtn.setAttribute('aria-expanded', isRowEditing ? 'true' : 'false');
      }
      if (isRowEditing) {
        row.dataset.editing = 'true';
        row.classList.remove('draggable');
        row.setAttribute('draggable', 'false');
        if (activeInlineEditState.formEl.parentElement !== row) {
          row.appendChild(activeInlineEditState.formEl);
        }
      } else {
        delete row.dataset.editing;
        const isEnabled =
          row.dataset.enabledPreference === 'true' && row.dataset.hasAccess === 'true';
        row.classList.toggle('draggable', isEnabled);
        row.setAttribute('draggable', String(isEnabled));
        row.querySelector('.custom-provider-inline-edit')?.remove();
      }
    });
}

function createInlineEditFormState(descriptor) {
  const providerId = descriptor.id;
  const isApi = descriptor.customKind === 'api';
  const idPrefix = `inline-edit-${providerId}`;
  const hasSavedApiKey = Boolean(isApi && descriptor.apiConfig?.hasApiKey);

  const formEl = document.createElement('form');
  formEl.className = 'custom-provider-form custom-provider-inline-edit';
  formEl.dataset.inlineEditProviderId = providerId;
  formEl.noValidate = true;

  // Prevent row drag-and-drop or toggle clicks when interacting with inline form controls
  formEl.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });
  formEl.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  formEl.addEventListener('dragstart', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const headerEl = document.createElement('div');
  headerEl.className = 'custom-provider-inline-header';

  const titleEl = document.createElement('h4');
  titleEl.className = 'custom-provider-inline-title';
  titleEl.id = `${idPrefix}-title`;
  titleEl.textContent = t('headingEditCustomProvider');
  formEl.setAttribute('aria-labelledby', titleEl.id);

  const kindBadgeEl = document.createElement('span');
  kindBadgeEl.className = 'custom-provider-inline-kind-badge';
  kindBadgeEl.textContent = t(isApi ? 'optionCustomProviderKindApi' : 'optionCustomProviderKindWeb');

  headerEl.append(titleEl, kindBadgeEl);
  formEl.appendChild(headerEl);

  const fieldsEl = document.createElement('div');
  fieldsEl.className = 'custom-provider-fields';

  // Name field
  const nameFieldEl = document.createElement('div');
  nameFieldEl.className = 'custom-provider-field custom-provider-field-name';
  const nameLabelEl = document.createElement('label');
  nameLabelEl.htmlFor = `${idPrefix}-name`;
  nameLabelEl.textContent = t('labelCustomProviderName');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = `${idPrefix}-name`;
  nameInput.name = 'customProviderName';
  nameInput.maxLength = MAX_CUSTOM_PROVIDER_NAME_LENGTH;
  nameInput.required = true;
  nameInput.autocomplete = 'off';
  nameInput.placeholder = t('placeholderCustomProviderName');
  nameInput.value = descriptor.name || '';
  nameInput.setAttribute('aria-describedby', `${idPrefix}-error`);
  nameFieldEl.append(nameLabelEl, nameInput);

  // URL field
  const urlFieldEl = document.createElement('div');
  urlFieldEl.className = 'custom-provider-field custom-provider-field-url';
  const urlLabelEl = document.createElement('label');
  urlLabelEl.htmlFor = `${idPrefix}-url`;
  urlLabelEl.textContent = t(isApi ? 'labelCustomApiEndpointUrl' : 'labelCustomProviderUrl');
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.inputMode = 'url';
  urlInput.id = `${idPrefix}-url`;
  urlInput.name = 'customProviderUrl';
  urlInput.required = true;
  urlInput.autocomplete = 'off';
  urlInput.setAttribute('autocorrect', 'off');
  urlInput.setAttribute('autocapitalize', 'none');
  urlInput.spellcheck = false;
  urlInput.placeholder = t(
    isApi ? 'placeholderCustomApiEndpointUrl' : 'placeholderCustomProviderUrl'
  );
  urlInput.value = isApi ? (descriptor.apiConfig?.endpointUrl || '') : (descriptor.url || '');
  urlInput.setAttribute('aria-describedby', `${idPrefix}-origin-preview ${idPrefix}-error`);
  urlFieldEl.append(urlLabelEl, urlInput);

  fieldsEl.append(nameFieldEl, urlFieldEl);

  let modelFieldEl = null;
  let modelLabelEl = null;
  let modelCountBadge = null;
  let modelInput = null;
  let loadModelsButton = null;
  let modelListbox = null;
  let modelHintEl = null;
  let apiKeyLabelEl = null;
  let apiKeyInput = null;
  let apiKeyToggleButton = null;
  let clearKeyRow = null;
  let clearApiKeyCheckbox = null;
  let clearApiKeyLabel = null;
  let apiNoteEl = null;

  if (isApi) {
    const apiFieldsEl = document.createElement('div');
    apiFieldsEl.className = 'custom-provider-api-fields';

    modelFieldEl = document.createElement('div');
    modelFieldEl.className = 'custom-provider-field custom-provider-field-model';

    const modelLabelRow = document.createElement('div');
    modelLabelRow.className = 'custom-provider-label-row';
    modelLabelEl = document.createElement('label');
    modelLabelEl.htmlFor = `${idPrefix}-model`;
    modelLabelEl.textContent = t('labelCustomProviderModel');
    modelCountBadge = document.createElement('span');
    modelCountBadge.className = 'custom-provider-model-count';
    modelCountBadge.hidden = true;
    modelLabelRow.append(modelLabelEl, modelCountBadge);

    const modelWrapEl = document.createElement('div');
    modelWrapEl.className = 'custom-provider-model-wrap';
    modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.id = `${idPrefix}-model`;
    modelInput.name = 'customProviderModel';
    modelInput.setAttribute('role', 'combobox');
    modelInput.setAttribute('aria-autocomplete', 'list');
    modelInput.setAttribute('aria-expanded', 'false');
    modelInput.setAttribute('aria-controls', `${idPrefix}-model-listbox`);
    modelInput.maxLength = MAX_CUSTOM_API_MODEL_LENGTH;
    modelInput.required = true;
    modelInput.autocomplete = 'off';
    modelInput.setAttribute('autocorrect', 'off');
    modelInput.setAttribute('autocapitalize', 'none');
    modelInput.spellcheck = false;
    modelInput.placeholder = t('placeholderCustomProviderModel');
    modelInput.value = descriptor.apiConfig?.model || '';
    modelInput.setAttribute('aria-describedby', `${idPrefix}-error`);

    loadModelsButton = document.createElement('button');
    loadModelsButton.type = 'button';
    loadModelsButton.className = 'btn-load-models';
    loadModelsButton.dataset.action = 'load-inline-models';
    loadModelsButton.textContent = t('btnLoadModels');

    modelListbox = document.createElement('div');
    modelListbox.className = 'custom-provider-model-listbox';
    modelListbox.id = `${idPrefix}-model-listbox`;
    modelListbox.setAttribute('role', 'listbox');
    modelListbox.hidden = true;

    modelWrapEl.append(modelInput, loadModelsButton, modelListbox);

    modelHintEl = document.createElement('p');
    modelHintEl.className = 'custom-provider-model-hint';
    modelHintEl.hidden = true;

    modelFieldEl.append(modelLabelRow, modelWrapEl, modelHintEl);

    const apiKeyFieldEl = document.createElement('div');
    apiKeyFieldEl.className = 'custom-provider-field custom-provider-field-api-key';
    apiKeyLabelEl = document.createElement('label');
    apiKeyLabelEl.htmlFor = `${idPrefix}-api-key`;
    apiKeyLabelEl.textContent = t('labelCustomProviderApiKey');

    const pwdWrapEl = document.createElement('div');
    pwdWrapEl.className = 'custom-provider-password-wrap';
    apiKeyInput = document.createElement('input');
    apiKeyInput.type = 'password';
    apiKeyInput.id = `${idPrefix}-api-key`;
    apiKeyInput.name = 'customProviderApiKey';
    apiKeyInput.autocomplete = 'off';
    apiKeyInput.setAttribute('autocorrect', 'off');
    apiKeyInput.setAttribute('autocapitalize', 'none');
    apiKeyInput.spellcheck = false;
    // Never populate stored IndexedDB API keys into the DOM.
    apiKeyInput.value = '';
    apiKeyInput.placeholder = t(
      hasSavedApiKey
        ? 'placeholderCustomProviderApiKeyKeepExisting'
        : 'placeholderCustomProviderApiKey'
    );
    apiKeyInput.setAttribute('aria-describedby', `${idPrefix}-api-note ${idPrefix}-error`);

    apiKeyToggleButton = document.createElement('button');
    apiKeyToggleButton.type = 'button';
    apiKeyToggleButton.className = 'btn-api-key-toggle';
    apiKeyToggleButton.setAttribute('aria-pressed', 'false');
    apiKeyToggleButton.textContent = t('btnShowApiKey');

    pwdWrapEl.append(apiKeyInput, apiKeyToggleButton);

    clearKeyRow = document.createElement('div');
    clearKeyRow.className = 'custom-provider-clear-key-row';
    clearKeyRow.hidden = !hasSavedApiKey;

    clearApiKeyCheckbox = document.createElement('input');
    clearApiKeyCheckbox.type = 'checkbox';
    clearApiKeyCheckbox.id = `${idPrefix}-clear-api-key`;
    clearApiKeyCheckbox.name = 'clearCustomProviderApiKey';

    clearApiKeyLabel = document.createElement('label');
    clearApiKeyLabel.htmlFor = `${idPrefix}-clear-api-key`;
    clearApiKeyLabel.textContent = t('labelClearSavedApiKey');

    clearKeyRow.append(clearApiKeyCheckbox, clearApiKeyLabel);
    apiKeyFieldEl.append(apiKeyLabelEl, pwdWrapEl, clearKeyRow);

    apiFieldsEl.append(modelFieldEl, apiKeyFieldEl);
    fieldsEl.appendChild(apiFieldsEl);

    apiNoteEl = document.createElement('p');
    apiNoteEl.className = 'custom-provider-api-note';
    apiNoteEl.id = `${idPrefix}-api-note`;
    apiNoteEl.textContent = t('noteCustomApiLocalOnly');
  }

  const submitGroupEl = document.createElement('div');
  submitGroupEl.className = 'custom-provider-submit';

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'btn btn-primary';
  saveButton.dataset.action = 'save-inline-custom-provider';
  saveButton.textContent = t('btnSaveCustomProvider');

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn btn-secondary';
  cancelButton.dataset.action = 'cancel-inline-custom-provider';
  cancelButton.textContent = t('btnCancel');

  submitGroupEl.append(saveButton, cancelButton);
  fieldsEl.appendChild(submitGroupEl);
  formEl.appendChild(fieldsEl);

  if (apiNoteEl) {
    formEl.appendChild(apiNoteEl);
  }

  const originPreviewEl = document.createElement('p');
  originPreviewEl.className = 'custom-provider-origin-preview';
  originPreviewEl.id = `${idPrefix}-origin-preview`;
  originPreviewEl.hidden = true;

  const errorMessageEl = document.createElement('p');
  errorMessageEl.className = 'custom-provider-error';
  errorMessageEl.id = `${idPrefix}-error`;
  errorMessageEl.setAttribute('role', 'alert');
  errorMessageEl.hidden = true;

  formEl.append(originPreviewEl, errorMessageEl);

  const clearError = () => {
    nameInput.removeAttribute('aria-invalid');
    urlInput.removeAttribute('aria-invalid');
    modelInput?.removeAttribute('aria-invalid');
    apiKeyInput?.removeAttribute('aria-invalid');
    errorMessageEl.textContent = '';
    errorMessageEl.hidden = true;
  };

  const setError = (message, invalidField = null) => {
    clearError();
    if (invalidField) {
      invalidField.setAttribute('aria-invalid', 'true');
    }
    errorMessageEl.textContent = message;
    errorMessageEl.hidden = false;
  };

  const updatePreview = () => {
    const raw = urlInput.value;
    if (!raw || raw.trim().length === 0) {
      originPreviewEl.textContent = '';
      originPreviewEl.hidden = true;
      return;
    }
    if (isApi) {
      const endpointCheck = validateCustomApiEndpointUrl(raw);
      if (endpointCheck.ok && endpointCheck.origin && endpointCheck.endpointUrl) {
        originPreviewEl.textContent = t('msgCustomApiEndpointPreview', [
          endpointCheck.origin,
          endpointCheck.endpointUrl
        ]);
        originPreviewEl.hidden = false;
        return;
      }
      originPreviewEl.textContent = '';
      originPreviewEl.hidden = true;
      return;
    }
    const check = validateCustomProviderUrl(raw, { ignoreProviderId: providerId });
    if (check.ok && check.origin) {
      originPreviewEl.textContent = t('msgCustomProviderOriginPreview', check.origin);
      originPreviewEl.hidden = false;
      return;
    }
    originPreviewEl.textContent = '';
    originPreviewEl.hidden = true;
  };

  let modelCombobox = null;
  if (isApi) {
    modelCombobox = createModelComboboxController({
      idPrefix: `${idPrefix}-models`,
      fieldContainer: modelFieldEl,
      modelInput,
      loadButton: loadModelsButton,
      listbox: modelListbox,
      countBadge: modelCountBadge,
      hintEl: modelHintEl,
      getEndpointRawUrl: () => urlInput.value || '',
      resolveEffectiveApiKey: async (targetOrigin) => {
        const typedKey = (apiKeyInput?.value || '').trim();
        if (typedKey.length > 0) {
          return typedKey;
        }
        if (clearApiKeyCheckbox?.checked) {
          return '';
        }
        const liveDescriptor = getProviderDescriptor(providerId);
        const savedOrigin = liveDescriptor ? getCustomProviderOrigin(liveDescriptor) : null;
        if (savedOrigin && savedOrigin === targetOrigin) {
          return (await getCustomApiKey(providerId)) || '';
        }
        return '';
      },
      onInvalidUrl: (reason) => {
        setError(getCustomProviderUrlErrorMessage(reason), urlInput);
        urlInput.focus?.();
      },
      onSelectModel: () => {
        clearError();
      },
      isEnabledKind: () => true
    });
  }

  nameInput.addEventListener('input', clearError);
  urlInput.addEventListener('input', () => {
    clearError();
    updatePreview();
    modelCombobox?.syncEndpointContext();
  });
  urlInput.addEventListener('blur', () => {
    if (!supportsScopedFrameRules()) {
      return;
    }
    const raw = urlInput.value;
    if (!raw || raw.trim().length === 0) {
      return;
    }
    const check = isApi
      ? validateCustomApiEndpointUrl(raw)
      : validateCustomProviderUrl(raw, { ignoreProviderId: providerId });
    if (!check.ok) {
      setError(getCustomProviderUrlErrorMessage(check.reason), urlInput);
    }
  });

  modelInput?.addEventListener('input', clearError);

  apiKeyInput?.addEventListener('input', () => {
    clearError();
    if (apiKeyInput.value.trim().length > 0 && clearApiKeyCheckbox?.checked) {
      clearApiKeyCheckbox.checked = false;
    }
    modelCombobox?.invalidateCatalog();
  });

  clearApiKeyCheckbox?.addEventListener('change', () => {
    clearError();
    if (clearApiKeyCheckbox.checked && apiKeyInput) {
      apiKeyInput.value = '';
      setPasswordFieldRevealedState(apiKeyInput, apiKeyToggleButton, false);
    }
    modelCombobox?.invalidateCatalog();
  });

  apiKeyToggleButton?.addEventListener('click', () => {
    const isRevealed = apiKeyToggleButton.getAttribute('aria-pressed') === 'true';
    setPasswordFieldRevealedState(apiKeyInput, apiKeyToggleButton, !isRevealed);
  });

  cancelButton.addEventListener('click', () => {
    cancelEditingCustomProvider({ restoreFocus: true });
  });

  formEl.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      !event.isComposing &&
      !event.defaultPrevented &&
      !isSubmittingInlineEdit
    ) {
      event.preventDefault();
      event.stopPropagation();
      cancelEditingCustomProvider({ restoreFocus: true });
    }
  });

  const syncAvailability = () => {
    const supported = supportsScopedFrameRules();
    const disabled = !supported || isSubmittingInlineEdit;
    nameInput.disabled = disabled;
    urlInput.disabled = disabled;
    if (modelInput) modelInput.disabled = disabled;
    if (apiKeyInput) apiKeyInput.disabled = disabled;
    if (apiKeyToggleButton) apiKeyToggleButton.disabled = disabled;
    if (clearApiKeyCheckbox) clearApiKeyCheckbox.disabled = disabled;
    saveButton.disabled = disabled;
    cancelButton.disabled = isSubmittingInlineEdit;
    modelCombobox?.setDisabled(disabled);
  };

  const refreshTranslations = () => {
    const latestDescriptor = getProviderDescriptor(providerId) || descriptor;
    const latestHasSavedKey = Boolean(isApi && latestDescriptor.apiConfig?.hasApiKey);
    titleEl.textContent = t('headingEditCustomProvider');
    kindBadgeEl.textContent = t(
      isApi ? 'optionCustomProviderKindApi' : 'optionCustomProviderKindWeb'
    );
    nameLabelEl.textContent = t('labelCustomProviderName');
    nameInput.placeholder = t('placeholderCustomProviderName');
    urlLabelEl.textContent = t(isApi ? 'labelCustomApiEndpointUrl' : 'labelCustomProviderUrl');
    urlInput.placeholder = t(
      isApi ? 'placeholderCustomApiEndpointUrl' : 'placeholderCustomProviderUrl'
    );
    if (isApi) {
      if (modelLabelEl) modelLabelEl.textContent = t('labelCustomProviderModel');
      if (modelInput) modelInput.placeholder = t('placeholderCustomProviderModel');
      if (apiKeyLabelEl) apiKeyLabelEl.textContent = t('labelCustomProviderApiKey');
      if (apiKeyInput) {
        apiKeyInput.placeholder = t(
          latestHasSavedKey
            ? 'placeholderCustomProviderApiKeyKeepExisting'
            : 'placeholderCustomProviderApiKey'
        );
      }
      if (apiKeyToggleButton) {
        const revealed = apiKeyToggleButton.getAttribute('aria-pressed') === 'true';
        apiKeyToggleButton.textContent = t(revealed ? 'btnHideApiKey' : 'btnShowApiKey');
      }
      if (clearApiKeyLabel) clearApiKeyLabel.textContent = t('labelClearSavedApiKey');
      if (apiNoteEl) apiNoteEl.textContent = t('noteCustomApiLocalOnly');
      modelCombobox?.refreshTranslations();
    }
    saveButton.textContent = t('btnSaveCustomProvider');
    cancelButton.textContent = t('btnCancel');
    updatePreview();
  };

  const state = {
    providerId,
    isApi,
    formEl,
    nameInput,
    urlInput,
    modelInput,
    apiKeyInput,
    apiKeyToggleButton,
    clearKeyRow,
    clearApiKeyCheckbox,
    saveButton,
    cancelButton,
    modelCombobox,
    clearError,
    setError,
    updatePreview,
    syncAvailability,
    refreshTranslations,
    destroy() {
      modelCombobox?.destroy();
      formEl.remove();
    }
  };

  formEl.addEventListener('submit', (event) => {
    handleInlineEditSubmit(event, state);
  });

  updatePreview();
  syncAvailability();

  return state;
}

export function startEditingCustomProvider(providerId) {
  const descriptor = getProviderDescriptor(providerId);
  if (!descriptor || descriptor.access !== 'custom') {
    return false;
  }

  if (activeInlineEditState) {
    activeInlineEditState.destroy();
    activeInlineEditState = null;
  }

  editingCustomProviderId = descriptor.id;
  activeInlineEditState = createInlineEditFormState(descriptor);
  applyInlineEditToRenderedRows();

  activeInlineEditState.nameInput?.focus?.({ preventScroll: true });
  if (document.activeElement !== activeInlineEditState.nameInput) {
    activeInlineEditState.nameInput?.focus?.();
  }

  if (descriptor.customKind === 'api') {
    activeInlineEditState.modelCombobox?.loadModels({
      interactive: false,
      openWhenLoaded: false
    });
  }

  return true;
}

export function cancelEditingCustomProvider({ restoreFocus = true } = {}) {
  const previousProviderId = editingCustomProviderId;
  editingCustomProviderId = null;

  if (activeInlineEditState) {
    activeInlineEditState.destroy();
    activeInlineEditState = null;
  }

  applyInlineEditToRenderedRows();
  cleanupUnusedProbedOrigins().catch(() => {});

  if (restoreFocus && previousProviderId) {
    focusCustomProviderEditButton(previousProviderId);
  }
}

async function handleInlineEditSubmit(event, inlineState) {
  event?.preventDefault?.();

  if (isSubmittingInlineEdit || !inlineState) {
    return;
  }

  if (!supportsScopedFrameRules()) {
    const message = t('msgCustomProviderUnsupportedChrome');
    inlineState.setError(message);
    showStatus('error', message);
    return;
  }

  const editingDescriptor = getProviderDescriptor(inlineState.providerId);
  if (!editingDescriptor || editingDescriptor.access !== 'custom') {
    cancelEditingCustomProvider({ restoreFocus: false });
    const message = t('errCustomProviderSaveFailed');
    showStatus('error', message);
    return;
  }

  const isApiKind = editingDescriptor.customKind === 'api';
  const rawName = typeof inlineState.nameInput?.value === 'string' ? inlineState.nameInput.value : '';
  const trimmedName = rawName.trim();
  if (trimmedName.length === 0) {
    inlineState.setError(t('errCustomNameRequired'), inlineState.nameInput);
    inlineState.nameInput?.focus?.();
    return;
  }
  if (trimmedName.length > MAX_CUSTOM_PROVIDER_NAME_LENGTH) {
    inlineState.setError(t('errCustomNameTooLong'), inlineState.nameInput);
    inlineState.nameInput?.focus?.();
    return;
  }

  const rawUrl = typeof inlineState.urlInput?.value === 'string' ? inlineState.urlInput.value : '';
  const urlCheck = isApiKind
    ? validateCustomApiEndpointUrl(rawUrl)
    : validateCustomProviderUrl(rawUrl, { ignoreProviderId: editingDescriptor.id });
  if (!urlCheck.ok) {
    const message = getCustomProviderUrlErrorMessage(urlCheck.reason);
    inlineState.setError(message, inlineState.urlInput);
    inlineState.urlInput?.focus?.();
    return;
  }

  let trimmedModel = '';
  let trimmedApiKey = '';
  if (isApiKind) {
    const rawModel =
      typeof inlineState.modelInput?.value === 'string' ? inlineState.modelInput.value : '';
    trimmedModel = rawModel.trim();
    if (trimmedModel.length === 0) {
      inlineState.setError(t('errCustomModelRequired'), inlineState.modelInput);
      inlineState.modelInput?.focus?.();
      return;
    }
    if (trimmedModel.length > MAX_CUSTOM_API_MODEL_LENGTH) {
      inlineState.setError(t('errCustomModelTooLong'), inlineState.modelInput);
      inlineState.modelInput?.focus?.();
      return;
    }

    const rawApiKey =
      typeof inlineState.apiKeyInput?.value === 'string' ? inlineState.apiKeyInput.value : '';
    trimmedApiKey = rawApiKey.trim();
    if (trimmedApiKey.length > MAX_CUSTOM_API_KEY_LENGTH) {
      inlineState.setError(t('errCustomApiKeyTooLong'), inlineState.apiKeyInput);
      inlineState.apiKeyInput?.focus?.();
      return;
    }
  }

  const permissionOrigin = `${urlCheck.origin}/*`;
  inlineState.clearError();
  inlineState.modelCombobox?.closeListbox();
  isSubmittingInlineEdit = true;
  inlineState.syncAvailability();

  // Synchronously invoke chrome.permissions.request before any await so Chrome
  // preserves transient user activation from clicking Save changes / pressing Enter.
  let permissionPromise;
  try {
    permissionPromise = chrome?.permissions?.request
      ? chrome.permissions.request({ origins: [permissionOrigin] })
      : Promise.resolve(false);
  } catch {
    isSubmittingInlineEdit = false;
    inlineState.syncAvailability();
    const message = t('msgProviderPermissionRequestFailed', trimmedName);
    inlineState.setError(message);
    showStatus('error', message);
    return;
  }

  try {
    let granted = false;
    try {
      granted = Boolean(await permissionPromise);
    } catch {
      const message = t('msgProviderPermissionRequestFailed', trimmedName);
      inlineState.setError(message);
      showStatus('error', message);
      return;
    }

    if (!granted) {
      const message = t('msgCustomProviderPermissionDenied', urlCheck.origin);
      inlineState.setError(message);
      showStatus('error', message);
      return;
    }

    const targetId = editingDescriptor.id;
    const previousOrigin = getCustomProviderOrigin(editingDescriptor);
    const previousEndpointUrl = editingDescriptor.apiConfig?.endpointUrl || null;
    let previousSecret = null;
    let secretMutated = false;

    try {
      let nextHasApiKey = false;
      if (isApiKind) {
        previousSecret = await getCustomApiKey(targetId);
        if (trimmedApiKey.length > 0) {
          await saveCustomApiKey(targetId, trimmedApiKey, {
            endpointUrl: urlCheck.endpointUrl
          });
          secretMutated = true;
          nextHasApiKey = true;
        } else if (inlineState.clearApiKeyCheckbox?.checked) {
          await deleteCustomApiKey(targetId);
          secretMutated = true;
          nextHasApiKey = false;
        } else {
          if (previousSecret && previousEndpointUrl !== urlCheck.endpointUrl) {
            await saveCustomApiKey(targetId, previousSecret, {
              endpointUrl: urlCheck.endpointUrl
            });
            secretMutated = true;
          }
          nextHasApiKey =
            Boolean(previousSecret) || Boolean(editingDescriptor.apiConfig?.hasApiKey);
        }
      }

      const savedRecord = await updateCustomProvider(
        targetId,
        isApiKind
          ? {
              name: trimmedName,
              endpointUrl: urlCheck.endpointUrl,
              model: trimmedModel,
              hasApiKey: nextHasApiKey
            }
          : {
              name: trimmedName,
              url: urlCheck.url
            }
      );

      if (
        previousOrigin &&
        previousOrigin !== urlCheck.origin &&
        !isOriginUsedByAnyProvider(previousOrigin) &&
        chrome?.permissions?.remove
      ) {
        await chrome.permissions.remove({ origins: [`${previousOrigin}/*`] }).catch((error) => {
          console.warn(`Failed to revoke permission for ${previousOrigin}:`, error);
        });
      }

      await cleanupUnusedProbedOrigins({ keepOrigin: urlCheck.origin });

      editingCustomProviderId = null;
      if (activeInlineEditState === inlineState) {
        activeInlineEditState.destroy();
        activeInlineEditState = null;
      } else {
        inlineState.destroy();
      }

      await renderProviderList();
      focusCustomProviderEditButton(targetId);
      showStatus('success', t('msgCustomProviderUpdated', savedRecord.name));
    } catch (persistError) {
      if (secretMutated) {
        if (previousSecret) {
          await saveCustomApiKey(targetId, previousSecret, {
            endpointUrl: previousEndpointUrl
          }).catch(() => {});
        } else {
          await deleteCustomApiKey(targetId).catch(() => {});
        }
      }
      await loadCustomProviders().catch(() => {});
      if (
        previousOrigin !== urlCheck.origin &&
        !isOriginUsedByAnyProvider(urlCheck.origin) &&
        chrome?.permissions?.remove
      ) {
        await chrome.permissions.remove({ origins: [permissionOrigin] }).catch(() => {});
      }
      const message =
        persistError?.reason && CUSTOM_URL_REASON_MESSAGE_KEYS[persistError.reason]
          ? getCustomProviderUrlErrorMessage(persistError.reason)
          : t('errCustomProviderSaveFailed');
      inlineState.setError(message);
      showStatus('error', message);
    }
  } finally {
    isSubmittingInlineEdit = false;
    if (activeInlineEditState === inlineState) {
      inlineState.syncAvailability();
    }
  }
}

function clearCustomProviderFormError() {
  const { nameInput, urlInput, modelInput, apiKeyInput, errorMessage } =
    getCustomProviderFormElements();
  nameInput?.removeAttribute('aria-invalid');
  urlInput?.removeAttribute('aria-invalid');
  modelInput?.removeAttribute('aria-invalid');
  apiKeyInput?.removeAttribute('aria-invalid');
  if (errorMessage) {
    errorMessage.textContent = '';
    errorMessage.hidden = true;
  }
}

function setCustomProviderFormError(message, invalidField = null) {
  const { nameInput, urlInput, modelInput, apiKeyInput, errorMessage } =
    getCustomProviderFormElements();
  nameInput?.removeAttribute('aria-invalid');
  urlInput?.removeAttribute('aria-invalid');
  modelInput?.removeAttribute('aria-invalid');
  apiKeyInput?.removeAttribute('aria-invalid');
  if (invalidField) {
    invalidField.setAttribute('aria-invalid', 'true');
  }
  if (errorMessage) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
  }
}

export function updateCustomProviderOriginPreview() {
  const { urlInput, originPreview } = getCustomProviderFormElements();
  if (!originPreview || !urlInput) {
    return;
  }
  const raw = urlInput.value;
  if (!raw || raw.trim().length === 0) {
    originPreview.textContent = '';
    originPreview.hidden = true;
    return;
  }

  const isApi = getSelectedCustomProviderKind() === 'api';

  if (isApi) {
    const endpointCheck = validateCustomApiEndpointUrl(raw);
    if (endpointCheck.ok && endpointCheck.origin && endpointCheck.endpointUrl) {
      originPreview.textContent = t('msgCustomApiEndpointPreview', [
        endpointCheck.origin,
        endpointCheck.endpointUrl
      ]);
      originPreview.hidden = false;
      return;
    }
    originPreview.textContent = '';
    originPreview.hidden = true;
    return;
  }

  const check = validateCustomProviderUrl(raw);
  if (check.ok && check.origin) {
    originPreview.textContent = t('msgCustomProviderOriginPreview', check.origin);
    originPreview.hidden = false;
    return;
  }

  originPreview.textContent = '';
  originPreview.hidden = true;
}

export async function handleCustomProviderFormSubmit(event) {
  event?.preventDefault?.();

  if (isSubmittingCustomProvider) {
    return;
  }

  const {
    nameInput,
    urlInput,
    modelInput,
    apiKeyInput
  } = getCustomProviderFormElements();
  if (!supportsScopedFrameRules()) {
    const message = t('msgCustomProviderUnsupportedChrome');
    setCustomProviderFormError(message);
    showStatus('error', message);
    return;
  }

  const isApiKind = getSelectedCustomProviderKind() === 'api';

  const rawName = typeof nameInput?.value === 'string' ? nameInput.value : '';
  const trimmedName = rawName.trim();
  if (trimmedName.length === 0) {
    setCustomProviderFormError(t('errCustomNameRequired'), nameInput);
    nameInput?.focus?.();
    return;
  }
  if (trimmedName.length > MAX_CUSTOM_PROVIDER_NAME_LENGTH) {
    setCustomProviderFormError(t('errCustomNameTooLong'), nameInput);
    nameInput?.focus?.();
    return;
  }

  const rawUrl = typeof urlInput?.value === 'string' ? urlInput.value : '';
  const urlCheck = isApiKind
    ? validateCustomApiEndpointUrl(rawUrl)
    : validateCustomProviderUrl(rawUrl);
  if (!urlCheck.ok) {
    const message = getCustomProviderUrlErrorMessage(urlCheck.reason);
    setCustomProviderFormError(message, urlInput);
    urlInput?.focus?.();
    return;
  }

  let trimmedModel = '';
  let trimmedApiKey = '';
  if (isApiKind) {
    const rawModel = typeof modelInput?.value === 'string' ? modelInput.value : '';
    trimmedModel = rawModel.trim();
    if (trimmedModel.length === 0) {
      setCustomProviderFormError(t('errCustomModelRequired'), modelInput);
      modelInput?.focus?.();
      return;
    }
    if (trimmedModel.length > MAX_CUSTOM_API_MODEL_LENGTH) {
      setCustomProviderFormError(t('errCustomModelTooLong'), modelInput);
      modelInput?.focus?.();
      return;
    }

    const rawApiKey = typeof apiKeyInput?.value === 'string' ? apiKeyInput.value : '';
    trimmedApiKey = rawApiKey.trim();
    if (trimmedApiKey.length > MAX_CUSTOM_API_KEY_LENGTH) {
      setCustomProviderFormError(t('errCustomApiKeyTooLong'), apiKeyInput);
      apiKeyInput?.focus?.();
      return;
    }
  }

  let id;
  let frameRuleId;
  try {
    id = generateCustomProviderId();
    frameRuleId = allocateCustomFrameRuleId();
  } catch {
    const message = t('errCustomProviderSaveFailed');
    setCustomProviderFormError(message);
    showStatus('error', message);
    return;
  }

  const createdAt = Date.now();
  const permissionOrigin = `${urlCheck.origin}/*`;

  clearCustomProviderFormError();
  addFormModelCombobox?.closeListbox();
  isSubmittingCustomProvider = true;
  syncCustomProviderFormAvailability();

  // Synchronously invoke chrome.permissions.request before any await so Chrome
  // preserves the transient user activation from clicking Add / pressing Enter.
  let permissionPromise;
  try {
    permissionPromise = chrome?.permissions?.request
      ? chrome.permissions.request({ origins: [permissionOrigin] })
      : Promise.resolve(false);
  } catch {
    isSubmittingCustomProvider = false;
    syncCustomProviderFormAvailability();
    const message = t('msgProviderPermissionRequestFailed', trimmedName);
    setCustomProviderFormError(message);
    showStatus('error', message);
    return;
  }

  try {
    let granted = false;
    try {
      granted = Boolean(await permissionPromise);
    } catch {
      const message = t('msgProviderPermissionRequestFailed', trimmedName);
      setCustomProviderFormError(message);
      showStatus('error', message);
      return;
    }

    if (!granted) {
      const message = t('msgCustomProviderPermissionDenied', urlCheck.origin);
      setCustomProviderFormError(message);
      showStatus('error', message);
      return;
    }

    let savedSecret = false;
    let addedToLocal = false;
    try {
      if (isApiKind && trimmedApiKey.length > 0) {
        await saveCustomApiKey(id, trimmedApiKey, {
          endpointUrl: urlCheck.endpointUrl
        });
        savedSecret = true;
      }

      const savedRecord = await addCustomProvider(
        isApiKind
          ? {
              id,
              kind: 'api',
              name: trimmedName,
              endpointUrl: urlCheck.endpointUrl,
              model: trimmedModel,
              hasApiKey: trimmedApiKey.length > 0,
              frameRuleId,
              createdAt
            }
          : {
              id,
              name: trimmedName,
              url: urlCheck.url,
              frameRuleId,
              createdAt
            }
      );
      addedToLocal = true;

      const settings = await getSettings();
      const previousEnabledProviders = getEnabledProvidersOrDefault(settings);
      const nextEnabledRaw = previousEnabledProviders.includes(savedRecord.id)
        ? [...previousEnabledProviders]
        : [...previousEnabledProviders, savedRecord.id];
      const enabledProviders = preserveForeignCustomIds(
        nextEnabledRaw,
        previousEnabledProviders,
        hasProviderDescriptor
      );

      const previousOrder = Array.isArray(settings.providerOrder)
        ? settings.providerOrder
        : previousEnabledProviders;
      const providerOrder = preserveForeignCustomIds(
        appendProviderToOrder(
          settings.providerOrder,
          previousEnabledProviders,
          savedRecord.id,
          listProviders().map(({ id: providerId }) => providerId)
        ),
        previousOrder,
        hasProviderDescriptor
      );

      await chrome.storage.sync.set({ enabledProviders, providerOrder });
      await cleanupUnusedProbedOrigins({ keepOrigin: urlCheck.origin });

      if (nameInput) nameInput.value = '';
      if (urlInput) urlInput.value = '';
      if (modelInput) modelInput.value = '';
      if (apiKeyInput) apiKeyInput.value = '';
      setApiKeyRevealedState(false);
      addFormModelCombobox?.reset();
      updateCustomProviderOriginPreview();
      clearCustomProviderFormError();
      await renderProviderList();
      showStatus('success', t('msgCustomProviderAdded', savedRecord.name));
    } catch (persistError) {
      if (savedSecret) {
        await deleteCustomApiKey(id).catch(() => {});
      }
      if (addedToLocal) {
        await removeCustomProvider(id).catch(() => {});
      }
      await loadCustomProviders().catch(() => {});
      if (
        !isOriginUsedByAnyProvider(urlCheck.origin, { excludeProviderId: id }) &&
        chrome?.permissions?.remove
      ) {
        await chrome.permissions.remove({ origins: [permissionOrigin] }).catch(() => {});
      }
      const message = persistError?.reason && CUSTOM_URL_REASON_MESSAGE_KEYS[persistError.reason]
        ? getCustomProviderUrlErrorMessage(persistError.reason)
        : t('errCustomProviderSaveFailed');
      setCustomProviderFormError(message);
      showStatus('error', message);
    }
  } finally {
    isSubmittingCustomProvider = false;
    syncCustomProviderFormAvailability();
  }
}

export async function deleteCustomProviderEntry(providerId) {
  const descriptor = getProviderDescriptor(providerId);
  if (!descriptor || descriptor.access !== 'custom') {
    return false;
  }

  const origin = getCustomProviderOrigin(descriptor);
  const providerName = descriptor.name;

  if (editingCustomProviderId === providerId) {
    cancelEditingCustomProvider({ restoreFocus: false });
  }

  await removeCustomProvider(providerId);
  await deleteCustomApiKey(providerId).catch(() => {});

  const syncState = await chrome.storage.sync.get({
    enabledProviders: DEFAULT_ENABLED_PROVIDERS,
    providerOrder: null,
    multiPanelProviders: null
  });
  const currentEnabled = Array.isArray(syncState?.enabledProviders)
    ? syncState.enabledProviders
    : DEFAULT_ENABLED_PROVIDERS;
  const syncUpdates = {
    enabledProviders: currentEnabled.filter((id) => id !== providerId)
  };
  if (Array.isArray(syncState?.providerOrder)) {
    syncUpdates.providerOrder = syncState.providerOrder.filter((id) => id !== providerId);
  }
  if (Array.isArray(syncState?.multiPanelProviders)) {
    syncUpdates.multiPanelProviders = syncState.multiPanelProviders.filter((id) => id !== providerId);
  }
  await chrome.storage.sync.set(syncUpdates);

  if (origin && !isOriginUsedByAnyProvider(origin) && chrome?.permissions?.remove) {
    await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch((error) => {
      console.warn(`Failed to revoke permission for ${origin}:`, error);
    });
  }

  await renderProviderList();
  showStatus('success', t('msgCustomProviderDeleted', providerName));
  return true;
}

function setupCustomProviderForm() {
  const {
    form,
    kindWebRadio,
    kindApiRadio,
    nameInput,
    urlInput,
    modelFieldContainer,
    modelInput,
    modelCountBadge,
    loadModelsButton,
    modelListbox,
    modelHint,
    apiKeyInput,
    apiKeyToggleButton
  } = getCustomProviderFormElements();

  const jumpButton = document.getElementById('jump-add-custom-provider-btn');
  if (jumpButton && jumpButton.dataset.jumpBound !== 'true') {
    jumpButton.dataset.jumpBound = 'true';
    jumpButton.addEventListener('click', () => {
      document
        .getElementById('custom-provider-card')
        ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      nameInput?.focus?.();
    });
  }

  if (form && form.dataset.customFormBound !== 'true') {
    form.dataset.customFormBound = 'true';

    addFormModelCombobox = createModelComboboxController({
      idPrefix: 'add-custom-models',
      fieldContainer: modelFieldContainer,
      modelInput,
      loadButton: loadModelsButton,
      listbox: modelListbox,
      countBadge: modelCountBadge,
      hintEl: modelHint,
      getEndpointRawUrl: () => urlInput?.value || '',
      resolveEffectiveApiKey: async () => (apiKeyInput?.value || '').trim(),
      onInvalidUrl: (reason) => {
        setCustomProviderFormError(getCustomProviderUrlErrorMessage(reason), urlInput);
        urlInput?.focus?.();
      },
      onSelectModel: (selectedModel) => {
        clearCustomProviderFormError();
        if (nameInput && nameInput.value.trim().length === 0) {
          const suggested = (selectedModel.name || selectedModel.id || '').trim();
          if (suggested) {
            nameInput.value = suggested.slice(0, MAX_CUSTOM_PROVIDER_NAME_LENGTH);
          }
        }
      },
      isEnabledKind: () => getSelectedCustomProviderKind() === 'api'
    });

    const onKindChange = () => {
      clearCustomProviderFormError();
      syncCustomProviderKindFields();
      updateCustomProviderOriginPreview();
      if (getSelectedCustomProviderKind() !== 'api') {
        addFormModelCombobox?.invalidateCatalog();
      }
    };
    kindWebRadio?.addEventListener('change', onKindChange);
    kindApiRadio?.addEventListener('change', onKindChange);

    nameInput?.addEventListener('input', () => {
      clearCustomProviderFormError();
    });

    urlInput?.addEventListener('input', () => {
      clearCustomProviderFormError();
      updateCustomProviderOriginPreview();
      addFormModelCombobox?.syncEndpointContext();
    });

    modelInput?.addEventListener('input', () => {
      clearCustomProviderFormError();
    });

    apiKeyInput?.addEventListener('input', () => {
      clearCustomProviderFormError();
      addFormModelCombobox?.invalidateCatalog();
    });

    apiKeyToggleButton?.addEventListener('click', () => {
      const isRevealed = apiKeyToggleButton.getAttribute('aria-pressed') === 'true';
      setApiKeyRevealedState(!isRevealed);
    });

    urlInput?.addEventListener('blur', () => {
      if (!supportsScopedFrameRules()) {
        return;
      }
      const raw = urlInput.value;
      if (!raw || raw.trim().length === 0) {
        return;
      }
      const isApi = getSelectedCustomProviderKind() === 'api';
      const check = isApi
        ? validateCustomApiEndpointUrl(raw)
        : validateCustomProviderUrl(raw);
      if (!check.ok) {
        setCustomProviderFormError(getCustomProviderUrlErrorMessage(check.reason), urlInput);
      }
    });

    form.addEventListener('submit', (event) => {
      handleCustomProviderFormSubmit(event);
    });
  }

  syncCustomProviderFormAvailability();
  updateCustomProviderOriginPreview();
}

function fitSelectWidth(select) {
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }

  const selectedOption = select.options[select.selectedIndex];
  const text = selectedOption?.textContent || select.value || '';
  const sizingProbe = document.createElement('span');
  const computedStyle = window.getComputedStyle(select);

  sizingProbe.textContent = text;
  sizingProbe.style.position = 'absolute';
  sizingProbe.style.visibility = 'hidden';
  sizingProbe.style.whiteSpace = 'pre';
  sizingProbe.style.font = computedStyle.font;
  sizingProbe.style.fontSize = computedStyle.fontSize;
  sizingProbe.style.fontWeight = computedStyle.fontWeight;
  sizingProbe.style.letterSpacing = computedStyle.letterSpacing;

  document.body.appendChild(sizingProbe);
  const measuredWidth = Math.ceil(sizingProbe.getBoundingClientRect().width);
  sizingProbe.remove();

  const horizontalPadding = (parseFloat(computedStyle.paddingLeft) || 0) +
    (parseFloat(computedStyle.paddingRight) || 0);
  const horizontalBorder = (parseFloat(computedStyle.borderLeftWidth) || 0) +
    (parseFloat(computedStyle.borderRightWidth) || 0);
  const safetyAllowance = 8;

  select.style.width = `${Math.max(
    56,
    Math.ceil(measuredWidth + horizontalPadding + horizontalBorder + safetyAllowance)
  )}px`;
}

function setupAutoSizedSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.dataset.autoSizeBound === 'true') {
    fitSelectWidth(select);
    return;
  }

  select.dataset.autoSizeBound = 'true';
  select.addEventListener('change', () => {
    fitSelectWidth(select);
  });

  fitSelectWidth(select);
}

function refreshAutoSizedSelects(root = document) {
  root.querySelectorAll('select').forEach((select) => {
    setupAutoSizedSelect(select);
  });
}

function getGoogleProviderModeOrDefault(settings) {
  return normalizeGoogleProviderMode(settings.googleProviderMode || DEFAULT_GOOGLE_PROVIDER_MODE);
}

function createGoogleModeSelectElement(currentMode, isEnabled) {
  const normalizedMode = normalizeGoogleProviderMode(currentMode);
  const select = document.createElement('select');
  select.className = 'google-mode-select';
  select.dataset.googleModeSelect = 'true';
  select.disabled = !isEnabled;
  select.title = 'Google provider mode';

  const aiOption = document.createElement('option');
  aiOption.value = GOOGLE_PROVIDER_MODE_AI;
  aiOption.textContent = 'AI Mode';
  if (normalizedMode === GOOGLE_PROVIDER_MODE_AI) {
    aiOption.selected = true;
  }

  const searchOption = document.createElement('option');
  searchOption.value = GOOGLE_PROVIDER_MODE_SEARCH;
  searchOption.textContent = 'Search';
  if (normalizedMode === GOOGLE_PROVIDER_MODE_SEARCH) {
    searchOption.selected = true;
  }

  select.append(aiOption, searchOption);
  select.value = normalizedMode;
  return select;
}

// Helper function to get browser's current language in our supported format
function getCurrentBrowserLanguage() {
  const browserLang = getCurrentLanguage();
  // Map browser language codes to our supported locales
  if (browserLang.startsWith('zh')) {
    if (browserLang.includes('TW') || browserLang.includes('HK') || browserLang.includes('Hant')) {
      return 'zh_TW';
    }
    return 'zh_CN';
  }
  return 'en';
}

function getEnabledProvidersOrDefault(settings) {
  if (settings.enabledProviders && Array.isArray(settings.enabledProviders)) {
    return [...settings.enabledProviders];
  }
  return [...DEFAULT_ENABLED_PROVIDERS];
}

function getProviderDisplayOrder(settings) {
  const allIds = listProviders().map(provider => provider.id);
  return normalizeProviderOrder(settings.providerOrder, allIds);
}

function isEdgeBrowser() {
  const uaData = navigator.userAgentData;
  if (uaData && Array.isArray(uaData.brands)) {
    return uaData.brands.some(brand => /Edge/i.test(brand.brand));
  }
  return navigator.userAgent.includes('Edg/');
}

function openShortcutSettings(browserOverride) {
  const isEdge = browserOverride === 'edge' || (browserOverride !== 'chrome' && isEdgeBrowser());
  const url = isEdge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';

  try {
    chrome.tabs.create({ url });
  } catch (error) {
    // Fallback to window.open if chrome.tabs unavailable
    window.open(url, '_blank');
  }
}

function getExtensionResourceUrl(path) {
  if (chrome?.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return new URL(path, `${window.location.origin}/`).href;
}

function getPromptGuidePath(locale) {
  const guidePaths = {
    en: 'data/prompt-libraries/guide.en.html',
    zh_CN: 'data/prompt-libraries/guide.zh_CN.html',
    zh_TW: 'data/prompt-libraries/guide.zh_TW.html',
    ko: 'data/prompt-libraries/guide.ko.html',
    ja: 'data/prompt-libraries/guide.ja.html',
    es: 'data/prompt-libraries/guide.es.html',
    fr: 'data/prompt-libraries/guide.fr.html',
    de: 'data/prompt-libraries/guide.de.html',
    it: 'data/prompt-libraries/guide.it.html',
    ru: 'data/prompt-libraries/guide.ru.html'
  };

  return guidePaths[locale] || guidePaths.en;
}

function setupShortcutHelpers() {
  const openShortcutsBtn = document.getElementById('open-shortcuts-btn');
  if (openShortcutsBtn) {
    openShortcutsBtn.addEventListener('click', () => openShortcutSettings());
  }

  const edgeHelper = document.getElementById('edge-shortcut-helper');
  const edgeButton = document.getElementById('open-edge-shortcuts-btn');

  if (edgeHelper && edgeButton) {
    edgeButton.addEventListener('click', () => openShortcutSettings('edge'));
  }
}

// Helper to detect if extension is installed from Chrome Web Store
async function isWebStoreInstall() {
  try {
    const info = await chrome.management.getSelf();
    // installType: 'normal' = Chrome Web Store, 'development' = loaded unpacked
    return info.installType === 'normal';
  } catch (error) {
    console.error('Error detecting install type:', error);
    // Default to false (show update checking) if detection fails
    return false;
  }
}

// Hide update checking UI for web store installations
async function hideUpdateCheckingIfNeeded() {
  const isFromStore = await isWebStoreInstall();

  if (isFromStore) {
    // Hide "Check for Updates" button
    const checkUpdatesBtn = document.getElementById('check-updates-btn');
    if (checkUpdatesBtn) {
      checkUpdatesBtn.style.display = 'none';
    }

    // Hide update status message area
    const updateStatus = document.getElementById('update-status');
    if (updateStatus) {
      updateStatus.style.display = 'none';
    }

    // Hide "Download Latest Version" link
    const downloadLink = document.getElementById('download-latest-link');
    if (downloadLink) {
      const downloadContainer = downloadLink.closest('.version-download');
      if (downloadContainer) {
        downloadContainer.style.display = 'none';
      }
    }
  }

  return isFromStore;
}

function updateShortcutHelperVisibility(isEnabled) {
  const edgeHelper = document.getElementById('edge-shortcut-helper');
  if (!edgeHelper) return;

  if (isEdgeBrowser() && isEnabled) {
    edgeHelper.style.display = 'flex';
  } else {
    edgeHelper.style.display = 'none';
  }
}


// T050: Initialize settings page
async function init() {
  editingCustomProviderId = null;
  if (activeInlineEditState) {
    activeInlineEditState.destroy();
    activeInlineEditState = null;
  }
  if (addFormModelCombobox) {
    addFormModelCombobox.destroy();
    addFormModelCombobox = null;
  }
  modelCatalogCache.clear();
  transientProbedOrigins.clear();
  await loadCustomProviders();
  await applyTheme();  // Apply theme first
  await initializeLanguage();  // Initialize language from user settings
  translatePage();  // Translate all static text
  setupCustomProviderForm();
  await loadSettings();
  await loadDataStats();
  await loadLibraryCount();  // Load default library count
  const isFromWebStore = await hideUpdateCheckingIfNeeded();
  await loadVersionDisplay(!isFromWebStore);  // T073: Load and display version info
  await renderProviderList();
  setupEventListeners();
  setupStorageChangeListener();
  setupPermissionChangeListeners();
  setupShortcutHelpers();
  refreshAutoSizedSelects();
}

// T051: Load and display current settings
async function loadSettings() {
  const settings = await getSettings();

  // Theme
  document.getElementById('theme-select').value = settings.theme || 'auto';

  // Language
  const currentLanguage = settings.language || getCurrentBrowserLanguage();
  document.getElementById('language-select').value = currentLanguage;

  const keyboardShortcutEnabled = settings.keyboardShortcutEnabled !== false;
  const shortcutToggle = document.getElementById('keyboard-shortcut-toggle');
  if (shortcutToggle) {
    shortcutToggle.checked = keyboardShortcutEnabled;
  }
  updateShortcutHelperVisibility(keyboardShortcutEnabled);

  // Source URL placement setting
  const sourceUrlPlacementSelect = document.getElementById('source-url-placement-select');
  if (sourceUrlPlacementSelect) {
    sourceUrlPlacementSelect.value = settings.sourceUrlPlacement || 'none';
  }

  // Open mode setting
  const openModeSelect = document.getElementById('open-mode-select');
  if (openModeSelect) {
    openModeSelect.value = settings.openMode || 'tab';
  }

  // Share snapshot watermark setting
  const shareWatermarkToggle = document.getElementById('share-watermark-toggle');
  if (shareWatermarkToggle) {
    shareWatermarkToggle.checked = settings.shareWatermarkEnabled !== false;
  }

  // Enter key behavior settings
  const enterBehavior = settings.enterKeyBehavior || {
    enabled: true,
    preset: 'default',
    newlineModifiers: { shift: true, ctrl: false, alt: false, meta: false },
    sendModifiers: { shift: false, ctrl: false, alt: false, meta: false }
  };

  const enterBehaviorToggle = document.getElementById('enter-behavior-toggle');
  if (enterBehaviorToggle) {
    enterBehaviorToggle.checked = enterBehavior.enabled;
    updateEnterBehaviorVisibility(enterBehavior.enabled);
  }

  const enterPresetSelect = document.getElementById('enter-preset-select');
  if (enterPresetSelect) {
    enterPresetSelect.value = enterBehavior.preset || 'default';
    updateCustomEnterSettingsVisibility(enterBehavior.preset);
  }

  // Load custom settings
  loadCustomEnterSettings(enterBehavior);
  refreshAutoSizedSelects();
}

// T052-T053: Render provider enable/disable toggles with drag-and-drop reordering
/**
 * Hides a provider icon whose image fails to load. `error` does not bubble,
 * so each image gets its own listener. Call it in the same task that inserts
 * the image: load errors are dispatched asynchronously, so none is missed.
 * @param {HTMLImageElement} image
 */
function hideIconOnLoadError(image) {
  image.addEventListener('error', () => { image.style.display = 'none'; }, { once: true });
}

function createCustomProviderDeleteControlElement(provider) {
  const group = document.createElement('div');
  group.className = 'custom-provider-delete-group';
  group.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });

  const isRowEditing = editingCustomProviderId === provider.id;

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'btn-provider-icon btn-provider-edit';
  editButton.dataset.action = 'edit-custom-provider';
  editButton.dataset.providerId = provider.id;
  const editLabel = t('ariaEditCustomProvider', provider.name);
  editButton.setAttribute('aria-label', editLabel);
  editButton.setAttribute('aria-expanded', isRowEditing ? 'true' : 'false');
  editButton.title = editLabel;

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn-provider-icon btn-provider-delete';
  deleteButton.dataset.action = 'delete-custom-provider';
  deleteButton.dataset.providerId = provider.id;
  const deleteLabel = t('ariaDeleteCustomProvider', provider.name);
  deleteButton.setAttribute('aria-label', deleteLabel);
  deleteButton.title = deleteLabel;

  const confirmBox = document.createElement('div');
  confirmBox.className = 'custom-provider-delete-confirm';
  confirmBox.hidden = true;

  const promptSpan = document.createElement('span');
  promptSpan.className = 'custom-provider-delete-prompt';
  promptSpan.textContent = t('msgConfirmDeleteCustomInline');

  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'btn-provider-delete-confirm';
  confirmButton.dataset.action = 'confirm-delete-custom-provider';
  confirmButton.dataset.providerId = provider.id;
  confirmButton.textContent = t('btnConfirmDeleteCustom');

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn-provider-delete-cancel';
  cancelButton.dataset.action = 'cancel-delete-custom-provider';
  cancelButton.dataset.providerId = provider.id;
  cancelButton.textContent = t('btnCancel');

  editButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (editingCustomProviderId === provider.id) {
      cancelEditingCustomProvider({ restoreFocus: true });
    } else {
      startEditingCustomProvider(provider.id);
    }
  });

  deleteButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    editButton.hidden = true;
    deleteButton.hidden = true;
    confirmBox.hidden = false;
    confirmButton.focus?.();
  });

  cancelButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    confirmBox.hidden = true;
    editButton.hidden = false;
    deleteButton.hidden = false;
    deleteButton.focus?.();
  });

  confirmButton.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    try {
      await deleteCustomProviderEntry(provider.id);
    } catch (error) {
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      console.error(`Failed to delete custom provider ${provider.id}:`, error);
    }
  });

  confirmBox.append(promptSpan, confirmButton, cancelButton);
  group.append(editButton, deleteButton, confirmBox);
  return group;
}

function createProviderListItemElement(
  provider,
  { isEnabledPreference, hasAccess, googleProviderMode, descriptor }
) {
  const isCustom = descriptor?.access === 'custom';
  const isEnabled = isEnabledPreference && hasAccess;
  const isRowEditing = Boolean(
    isCustom &&
    editingCustomProviderId === provider.id &&
    activeInlineEditState?.providerId === provider.id
  );
  const canDragRow = isEnabled && !isRowEditing;

  const item = document.createElement('div');
  item.className = canDragRow ? 'provider-item draggable' : 'provider-item';
  item.dataset.providerId = provider.id;
  item.dataset.enabledPreference = String(isEnabledPreference);
  item.dataset.hasAccess = String(hasAccess);
  if (isCustom) {
    item.dataset.customProvider = 'true';
    if (isRowEditing) {
      item.dataset.editing = 'true';
    }
  }
  item.setAttribute('draggable', String(canDragRow));

  const info = document.createElement('div');
  info.className = 'provider-info';

  if (isEnabled) {
    const dragHandleTemplate = document.createElement('template');
    dragHandleTemplate.innerHTML = '<span class="drag-handle material-symbols-outlined">drag_indicator</span>';
    info.appendChild(dragHandleTemplate.content.firstElementChild);
  }

  const iconWrapper = document.createElement('div');
  iconWrapper.className = 'provider-icon';
  const iconImg = document.createElement('img');
  // Inline onerror handlers are blocked by the extension CSP.
  hideIconOnLoadError(iconImg);
  iconImg.setAttribute('src', getProviderIcon(provider));
  iconImg.setAttribute('alt', provider.name);
  iconImg.setAttribute('width', '24');
  iconImg.setAttribute('height', '24');
  iconWrapper.appendChild(iconImg);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'provider-name';
  nameSpan.textContent = provider.name;

  info.append(iconWrapper, nameSpan);

  const customOrigin = isCustom ? getCustomProviderOrigin(descriptor) : null;
  if (customOrigin) {
    const originBadge = document.createElement('span');
    originBadge.className = 'provider-origin-badge';
    const shadow = originBadge.attachShadow({ mode: 'open' });
    const bdiEl = document.createElement('bdi');
    bdiEl.dir = 'ltr';
    bdiEl.style.direction = 'ltr';
    bdiEl.style.unicodeBidi = 'isolate';
    bdiEl.appendChild(document.createElement('slot'));
    shadow.appendChild(bdiEl);
    originBadge.textContent = customOrigin;
    originBadge.title = customOrigin;
    info.appendChild(originBadge);
  }

  if (isCustom && descriptor.customKind === 'api' && descriptor.apiConfig?.model) {
    const modelBadge = document.createElement('span');
    modelBadge.className = 'provider-model-badge';
    modelBadge.dir = 'ltr';
    modelBadge.textContent = descriptor.apiConfig.model;
    modelBadge.title = descriptor.apiConfig.model;
    info.appendChild(modelBadge);
  }

  const controls = document.createElement('div');
  controls.className = 'provider-controls';
  if (provider.id === 'google') {
    controls.appendChild(createGoogleModeSelectElement(googleProviderMode, isEnabled));
  }
  if (isCustom) {
    controls.appendChild(createCustomProviderDeleteControlElement(provider));
  }

  const toggle = document.createElement('div');
  toggle.className = isEnabled ? 'toggle-switch active' : 'toggle-switch';
  toggle.dataset.providerId = provider.id;
  controls.appendChild(toggle);

  item.append(info, controls);
  if (isRowEditing && activeInlineEditState?.formEl) {
    item.appendChild(activeInlineEditState.formEl);
  }
  return item;
}

export async function renderProviderList() {
  syncCustomProviderFormAvailability();
  const settings = await getSettings();
  const enabledProviders = getEnabledProvidersOrDefault(settings);
  const googleProviderMode = getGoogleProviderModeOrDefault(settings);
  const displayOrder = getProviderDisplayOrder(settings);
  const listContainer = document.getElementById('provider-list');
  const providers = listProviders();
  const scopedRulesSupported = supportsScopedFrameRules();
  const providerAccessEntries = await Promise.all(providers.map(async (provider) => [
    provider.id,
    await hasOptionalProviderPermission(provider.id)
  ]));
  const providerAccess = new Map(providerAccessEntries);

  const orderIndex = new Map(displayOrder.map((id, index) => [id, index]));
  const sortedProviders = [...providers].sort((a, b) => {
    return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
  });

  // Capture focus state BEFORE creating items (which re-parents activeInlineEditState.formEl).
  const activeElement = document.activeElement;
  const preservedInlineFocus =
    activeInlineEditState?.formEl && activeInlineEditState.formEl.contains(activeElement)
      ? activeElement
      : null;
  const inlineSelectionStart =
    preservedInlineFocus && typeof preservedInlineFocus.selectionStart === 'number'
      ? preservedInlineFocus.selectionStart
      : null;
  const inlineSelectionEnd =
    preservedInlineFocus && typeof preservedInlineFocus.selectionEnd === 'number'
      ? preservedInlineFocus.selectionEnd
      : null;
  const activeControlAction =
    !preservedInlineFocus && listContainer?.contains(activeElement)
      ? activeElement?.dataset?.action || null
      : null;
  const activeControlProviderId =
    !preservedInlineFocus && listContainer?.contains(activeElement)
      ? activeElement?.dataset?.providerId || null
      : null;

  const providerItems = sortedProviders.map((provider) => {
    const descriptor = getProviderDescriptor(provider.id);
    const isCustom = descriptor?.access === 'custom';
    const rawAccess = providerAccess.get(provider.id) !== false;
    return createProviderListItemElement(provider, {
      isEnabledPreference: enabledProviders.includes(provider.id),
      hasAccess: isCustom ? (scopedRulesSupported && rawAccess) : rawAccess,
      googleProviderMode,
      descriptor
    });
  });

  listContainer.replaceChildren(...providerItems);

  if (preservedInlineFocus && listContainer.contains(preservedInlineFocus)) {
    preservedInlineFocus.focus?.({ preventScroll: true });
    if (document.activeElement !== preservedInlineFocus) {
      preservedInlineFocus.focus?.();
    }
    if (
      inlineSelectionStart !== null &&
      inlineSelectionEnd !== null &&
      typeof preservedInlineFocus.setSelectionRange === 'function'
    ) {
      try {
        preservedInlineFocus.setSelectionRange(inlineSelectionStart, inlineSelectionEnd);
      } catch {
        // Non-selectable input types throw on setSelectionRange; ignore safely.
      }
    }
  } else if (activeControlAction && activeControlProviderId) {
    const replacement = Array.from(
      listContainer.querySelectorAll(`[data-action="${activeControlAction}"]`)
    ).find(
      (el) =>
        el.dataset.providerId === activeControlProviderId &&
        !el.hidden &&
        !el.closest('[hidden]')
    );
    replacement?.focus?.();
  }

  // Add click listeners to toggles
  listContainer.querySelectorAll('.toggle-switch').forEach(toggle => {
    toggle.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const providerItem = toggle.closest('.provider-item');
      const providerId = providerItem?.dataset.providerId || toggle.dataset.providerId;
      if (!providerId) return;

      const provider = listProviders().find(({ id }) => id === providerId);
      const descriptor = getProviderDescriptor(providerId);
      const isCustom = descriptor?.access === 'custom';
      const hasAccess = providerItem?.dataset.hasAccess !== 'false';
      const isEnabledPreference = providerItem?.dataset.enabledPreference === 'true';

      if (isCustom && !supportsScopedFrameRules() && (!isEnabledPreference || !hasAccess)) {
        showStatus('error', t('msgCustomProviderUnsupportedChrome'));
        return;
      }

      if (!hasAccess && (provider?.optionalOrigins || isCustom)) {
        try {
          const permissionGranted = await requestOptionalProviderPermission(providerId);
          if (!permissionGranted) {
            showStatus('error', t('msgProviderPermissionRequired', provider.name));
            return;
          }
        } catch (error) {
          console.error(`Failed to request site access for ${providerId}:`, error);
          showStatus('error', t('msgProviderPermissionRequestFailed', provider.name));
          return;
        }

        // A synced preference can already be enabled while this device still
        // needs permission. Granting access should activate it, not toggle it off.
        if (isEnabledPreference) {
          await renderProviderList();
          showStatus('success', t('msgProviderSettingsUpdated'));
          return;
        }
      }

      await toggleProvider(providerId);
    });
  });

  listContainer.querySelectorAll('[data-google-mode-select="true"]').forEach(select => {
    select.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });

    select.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    select.addEventListener('change', async (event) => {
      await saveSetting('googleProviderMode', normalizeGoogleProviderMode(event.target.value));
      fitSelectWidth(event.target);
      showStatus('success', 'Google mode updated');
    });
  });

  // Setup drag-and-drop for enabled providers
  setupProviderDragAndDrop(listContainer);
  refreshAutoSizedSelects(listContainer);
}

function setupStorageChangeListener() {
  if (!chrome?.storage?.onChanged?.addListener) {
    return;
  }

  subscribeCustomProvidersChanged(() => {
    if (editingCustomProviderId && !getProviderDescriptor(editingCustomProviderId)) {
      cancelEditingCustomProvider({ restoreFocus: false });
    } else {
      syncCustomProviderFormAvailability();
    }
    updateCustomProviderOriginPreview();
    renderProviderList().catch((error) => {
      console.error('Error syncing custom providers:', error);
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' && areaName !== 'local') {
      return;
    }

    if (changes.googleProviderMode) {
      renderProviderList().catch((error) => {
        console.error('Error syncing Google mode control:', error);
      });
    }
  });
}

function setupPermissionChangeListeners() {
  const refreshProviders = () => {
    renderProviderList().catch((error) => {
      console.error('Error syncing optional provider access:', error);
    });
  };

  chrome.permissions?.onAdded?.addListener(refreshProviders);
  chrome.permissions?.onRemoved?.addListener(refreshProviders);
}

// Setup drag-and-drop reordering
function setupProviderDragAndDrop(container) {
  let draggedItem = null;

  container.querySelectorAll('.provider-item.draggable').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      if (
        editingCustomProviderId === item.dataset.providerId ||
        e.target?.closest?.('.custom-provider-inline-edit, button, input, label, select')
      ) {
        e.preventDefault();
        return;
      }
      draggedItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedItem = null;
      // Save new order
      saveProviderOrder(container);
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedItem || draggedItem === item) return;

      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      if (e.clientY < midY) {
        item.parentNode.insertBefore(draggedItem, item);
      } else {
        item.parentNode.insertBefore(draggedItem, item.nextSibling);
      }
    });
  });
}

// Save the new provider order
export async function saveProviderOrder(container) {
  const settings = await getSettings();
  const enabledProviders = getEnabledProvidersOrDefault(settings);
  const items = container.querySelectorAll('.provider-item');
  const domOrder = Array.from(items).map(item => item.dataset.providerId);
  const previousOrder = Array.isArray(settings.providerOrder)
    ? settings.providerOrder
    : enabledProviders;
  const newOrder = preserveForeignCustomIds(
    domOrder,
    previousOrder,
    hasProviderDescriptor
  );
  const newEnabledOrder = preserveForeignCustomIds(
    domOrder.filter(id => enabledProviders.includes(id)),
    enabledProviders,
    hasProviderDescriptor
  );

  await saveSetting('providerOrder', newOrder);
  // Also update enabledProviders to match the new order among enabled items
  await saveSetting('enabledProviders', newEnabledOrder);
  showStatus('success', t('msgProviderSettingsUpdated'));
}

export async function toggleProvider(providerId) {
  const settings = await getSettings();
  const previousEnabledProviders = getEnabledProvidersOrDefault(settings);
  let enabledProviders = [...previousEnabledProviders];
  const providers = listProviders();
  const provider = providers.find(({ id }) => id === providerId);

  if (!provider) {
    return;
  }

  if (enabledProviders.includes(providerId)) {
    // Disable - but ensure at least one locally known provider remains enabled
    const localEnabledCount = enabledProviders.filter(id => hasProviderDescriptor(id)).length;
    if (localEnabledCount <= 1) {
      showStatus('error', t('msgOneProviderRequired'));
      return;
    }
    enabledProviders = enabledProviders.filter(id => id !== providerId);

  } else {
    // Enable
    enabledProviders.push(providerId);
  }

  enabledProviders = preserveForeignCustomIds(
    enabledProviders,
    previousEnabledProviders,
    hasProviderDescriptor
  );

  const previousOrder = Array.isArray(settings.providerOrder)
    ? settings.providerOrder
    : previousEnabledProviders;
  const providerOrder = preserveForeignCustomIds(
    appendProviderToOrder(
      settings.providerOrder,
      previousEnabledProviders,
      providerId,
      providers.map(({ id }) => id)
    ),
    previousOrder,
    hasProviderDescriptor
  );

  await saveSettings({ enabledProviders, providerOrder });
  await renderProviderList();
  showStatus('success', t('msgProviderSettingsUpdated'));
}

// T056: Load and display data statistics
async function loadDataStats() {
  const statPromptsEl = document.getElementById('stat-prompts');
  const statStorageEl = document.getElementById('stat-storage');
  try {
    const prompts = await getAllPrompts();

    if (statPromptsEl) {
      statPromptsEl.textContent = prompts.length;
    }

    // Estimate storage size
    const promptsSize = JSON.stringify(prompts).length;
    const sizeKB = Math.round(promptsSize / 1024);
    if (statStorageEl) {
      statStorageEl.textContent = `~${sizeKB} KB`;
    }
  } catch (error) {
    // Silently handle data stats errors
    if (statPromptsEl) {
      statPromptsEl.textContent = '0';
    }
    if (statStorageEl) {
      statStorageEl.textContent = '0 KB';
    }
  }
}

// Load default library count
async function loadLibraryCount() {
  const countElement = document.getElementById('library-count');
  if (!countElement) return;

  try {
    const language = await getDefaultLibraryLanguage();
    const libraryPath = getDefaultLibraryPath(language);
    const response = await fetch(chrome.runtime.getURL(libraryPath));
    const promptsArray = await response.json();
    const count = Array.isArray(promptsArray) ? promptsArray.length : 0;
    countElement.textContent = t('msgPromptsCount', count.toString());
  } catch (error) {
    console.error('Failed to load library count:', error);
    countElement.textContent = t('msgUnknownCount');
  }
}

// Get the appropriate default library path based on language
function getDefaultLibraryPath(language) {
  // Only Simplified Chinese uses translated prompts
  // All other languages fall back to English
  if (language === 'zh_CN') {
    return 'data/prompt-libraries/default-prompts-zh_CN.json';
  }
  
  // Default to English for all other languages (including zh_TW)
  return 'data/prompt-libraries/default-prompts.json';
}

// Get user's preferred language for default library
async function getDefaultLibraryLanguage() {
  try {
    const settings = await chrome.storage.sync.get({ language: null });
    
    // Only Simplified Chinese gets Chinese prompts
    if (settings.language === 'zh_CN') {
      return 'zh_CN';
    }
    
    // All other languages (including zh_TW) fall back to English
    return 'en';
  } catch (error) {
    return 'en';
  }
}

// T057-T064: Setup event listeners
function setupEventListeners() {
  document.addEventListener('panelize:themechange', () => {
    renderProviderList().catch((error) => {
      console.error('Failed to refresh provider icons after theme change:', error);
    });
  });

  // Theme change
  document.getElementById('theme-select').addEventListener('change', async (e) => {
    await saveSetting('theme', e.target.value);
    await applyTheme();  // Re-apply theme immediately
    await renderProviderList();
    showStatus('success', t('msgThemeUpdated'));
  });

  // Language change
  document.getElementById('language-select').addEventListener('change', async (e) => {
    const newLanguage = e.target.value;
    await saveSetting('language', newLanguage);

    // Reload translations with new language
    await initializeLanguage(newLanguage);

    // Re-translate the entire page
    translatePage();
    syncCustomProviderFormAvailability();
    updateCustomProviderOriginPreview();
    addFormModelCombobox?.refreshTranslations();
    activeInlineEditState?.refreshTranslations();
    await renderProviderList();

    // Show success message (now in the new language)
    showStatus('success', t('msgLanguageUpdated'));
  });

  // Keyboard shortcut toggle
  const shortcutToggle = document.getElementById('keyboard-shortcut-toggle');
  if (shortcutToggle) {
    shortcutToggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      await saveSetting('keyboardShortcutEnabled', enabled);
      updateShortcutHelperVisibility(enabled);
      showStatus('success', enabled ? t('msgShortcutEnabled') : t('msgShortcutDisabled'));
    });
  }

  // Source URL placement change
  const sourceUrlPlacementSelect = document.getElementById('source-url-placement-select');
  if (sourceUrlPlacementSelect) {
    sourceUrlPlacementSelect.addEventListener('change', async (e) => {
      await saveSetting('sourceUrlPlacement', e.target.value);
      showStatus('success', t('msgSourceUrlPlacementUpdated'));
    });
  }

  // Export data
  document.getElementById('export-btn').addEventListener('click', exportData);

  // Import data
  document.getElementById('import-btn').addEventListener('click', () => {
    const fileInput = document.getElementById('import-file');
    fileInput.value = ''; // Reset file input before opening to allow re-importing same file
    fileInput.click();
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await importData(file);
    }
  });

  // Danger Zone - Clear buttons
  document.getElementById('clear-prompts-btn').addEventListener('click', clearPrompts);
  document.getElementById('reset-settings-btn').addEventListener('click', resetSettingsOnly);

  // Default library import button
  document.getElementById('import-default-library')?.addEventListener('click', importDefaultLibraryHandler);

  // Custom library import button
  document.getElementById('import-custom-library')?.addEventListener('click', () => {
    const fileInput = document.getElementById('import-custom-library-file');
    fileInput.value = ''; // Reset file input before opening to allow re-importing same file
    fileInput.click();
  });

  document.getElementById('import-custom-library-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await importCustomLibraryHandler(file);
    }
  });

  // Custom prompt guide and template
  document.getElementById('open-custom-prompt-guide')?.addEventListener('click', async () => {
    const settings = await getSettings();
    const locale = settings.language || getCurrentBrowserLanguage();
    const guidePath = getPromptGuidePath(locale);
    const url = getExtensionResourceUrl(guidePath);
    window.open(url, '_blank', 'noopener');
  });

  document.getElementById('download-custom-prompt-template')?.addEventListener('click', () => {
    const url = getExtensionResourceUrl('data/prompt-libraries/custom-prompt-template.json');
    const link = document.createElement('a');
    link.href = url;
    link.download = 'custom-prompt-template.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
  });

  // Enter key behavior toggle
  const enterBehaviorToggle = document.getElementById('enter-behavior-toggle');
  if (enterBehaviorToggle) {
    enterBehaviorToggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      const settings = await getSettings();
      const enterBehavior = settings.enterKeyBehavior || {};
      enterBehavior.enabled = enabled;
      await saveSetting('enterKeyBehavior', enterBehavior);
      updateEnterBehaviorVisibility(enabled);
      showStatus('success', enabled ? t('msgEnterCustomEnabled') : t('msgEnterCustomDisabled'));
    });
  }

  // Preset selection
  const enterPresetSelect = document.getElementById('enter-preset-select');
  if (enterPresetSelect) {
    enterPresetSelect.addEventListener('change', async (e) => {
      await applyEnterKeyPreset(e.target.value);
      updateCustomEnterSettingsVisibility(e.target.value);
    });
  }

  // Custom modifier checkboxes
  ['newline-shift', 'newline-ctrl', 'newline-alt', 'newline-meta',
   'send-shift', 'send-ctrl', 'send-alt', 'send-meta'].forEach(id => {
    const checkbox = document.getElementById(id);
    if (checkbox) {
      checkbox.addEventListener('change', saveCustomEnterSettings);
    }
  });

  // T073: Version check button
  const checkUpdatesBtn = document.getElementById('check-updates-btn');
  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener('click', performVersionCheck);
  }

  // Multi-Panel: Open mode selection
  const openModeSelect = document.getElementById('open-mode-select');
  if (openModeSelect) {
    openModeSelect.addEventListener('change', async (e) => {
      await saveSetting('openMode', e.target.value);
      showStatus('success', t('msgOpenModeUpdated') || 'Open mode updated');
    });
  }

  // Multi-Panel: Share snapshot watermark
  const shareWatermarkToggle = document.getElementById('share-watermark-toggle');
  if (shareWatermarkToggle) {
    shareWatermarkToggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      await saveSetting('shareWatermarkEnabled', enabled);
      showStatus('success', enabled ? t('msgShareWatermarkEnabled') : t('msgShareWatermarkDisabled'));
    });
  }

  // Multi-Panel: Layout selection
  const multiPanelLayoutSelect = document.getElementById('multi-panel-layout-select');
  if (multiPanelLayoutSelect) {
    // Load saved layout
    chrome.storage.sync.get({ multiPanelLayout: '1x3' }, (result) => {
      const storedLayout = result.multiPanelLayout;
      const hasOption = Array.from(multiPanelLayoutSelect.options).some(option => option.value === storedLayout);
      multiPanelLayoutSelect.value = hasOption ? storedLayout : '1x3';
    });

    multiPanelLayoutSelect.addEventListener('change', async (e) => {
      await chrome.storage.sync.set({ multiPanelLayout: e.target.value });
      showStatus('success', t('msgLayoutUpdated') || 'Layout updated');
    });
  }
}

// T057: Export all data
async function exportData() {
  try {
    // Export prompts
    const promptsData = await exportPrompts();

    // Export settings
    const settingsData = await exportSettings();

    // Combine into single export file
    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      prompts: promptsData.prompts,
      settings: settingsData
    };

    // Create download
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `panelize-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    showStatus('success', t('msgDataExported'));
  } catch (error) {
    showStatus('error', t('msgDataExportFailed'));
  }
}

// T058-T062: Import data from file
async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.version) {
      throw new Error('Invalid export file format');
    }

    // Confirm import
    const confirmMsg = t('msgImportConfirm', [
      new Date(data.exportDate).toLocaleString(),
      (data.prompts?.length || 0).toString()
    ]);

    if (!confirm(confirmMsg)) {
      return;
    }

    // Import prompts
    let promptImportSummary = null;
    if (data.prompts && Array.isArray(data.prompts)) {
      promptImportSummary = await importPrompts({ prompts: data.prompts }, 'skip');
    }

    // Import settings (but preserve current enabled providers)
    if (data.settings) {
      const currentSettings = await getSettings();
      const settingsToImport = {
        ...data.settings,
        enabledProviders: currentSettings.enabledProviders // Don't overwrite provider settings
      };
      await importSettings(settingsToImport);
    }

    await loadSettings();
    await renderProviderList();
    await loadDataStats();

    // Show success toast
    if (promptImportSummary && promptImportSummary.imported > 0) {
      showToast('success', 'msgDataImportedWithCount', [promptImportSummary.imported.toString()]);
    } else {
      showToast('success', 'msgDataImported');
    }
  } catch (error) {
    showStatus('error', t('msgDataImportFailed'));
  }
}

// Danger Zone: Clear Prompts
async function clearPrompts() {
  if (!confirm(t('msgConfirmClearPrompts'))) {
    return;
  }

  try {
    await clearAllPrompts();
    await loadDataStats();
    showStatus('success', t('msgPromptsCleared'));
  } catch (error) {
    showStatus('error', t('msgClearPromptsFailed'));
  }
}

// Danger Zone: Reset Settings
async function resetSettingsOnly() {
  if (!confirm(t('msgConfirmResetSettings'))) {
    return;
  }

  try {
    await resetSettings();
    await loadSettings();
    await renderProviderList();
    showStatus('success', t('msgSettingsReset'));
  } catch (error) {
    showStatus('error', t('msgResetSettingsFailed'));
  }
}

// Status message helpers
function showStatus(type, message) {
  const elementId = type === 'error' ? 'status-error' : 'status-success';
  const element = document.getElementById(elementId);

  element.textContent = message;
  element.classList.add('show');

  setTimeout(() => {
    element.classList.remove('show');
  }, 3000);
}

// Toast notification helper - lightweight, non-intrusive notifications
export function showToast(type, messageKey, params = []) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  // Get translated message
  const message = t(messageKey, params);

  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  // Icon based on type
  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ'
  };

  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.textContent = icons[type] || '•';

  const messageSpan = document.createElement('span');
  messageSpan.className = 'toast-message';
  messageSpan.textContent = message;

  toast.append(iconSpan, messageSpan);

  container.appendChild(toast);

  // Auto remove after 3 seconds
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

// Validate prompt structure against expected format
function validatePromptStructure(prompt) {
  const errors = [];

  // Required fields
  if (!prompt.title || typeof prompt.title !== 'string') {
    errors.push('Missing or invalid "title" (string)');
  }
  if (!prompt.content || typeof prompt.content !== 'string') {
    errors.push('Missing or invalid "content" (string)');
  }
  if (!prompt.category || typeof prompt.category !== 'string') {
    errors.push('Missing or invalid "category" (string)');
  }

  // Tags should be array
  if (!Array.isArray(prompt.tags)) {
    errors.push('"tags" must be an array of strings');
  }

  // Variables should be array (can be empty)
  if (!Array.isArray(prompt.variables)) {
    errors.push('"variables" must be an array');
  }

  // Optional but typed fields
  if (prompt.isFavorite !== undefined && typeof prompt.isFavorite !== 'boolean') {
    errors.push('"isFavorite" should be boolean');
  }
  if (prompt.useCount !== undefined && typeof prompt.useCount !== 'number') {
    errors.push('"useCount" should be number');
  }
  if (prompt.lastUsed !== undefined && prompt.lastUsed !== null && typeof prompt.lastUsed !== 'number') {
    errors.push('"lastUsed" should be number or null');
  }

  return errors;
}

// Generate example prompt structure
function getPromptStructureExample() {
  return `Expected JSON structure (array of prompt objects):

[
  {
    "title": "Short descriptive title",
    "content": "Full prompt text. Use {variables} for placeholders.",
    "category": "Category name",
    "tags": ["tag1", "tag2"],
    "variables": ["variable1", "variable2"],
    "isFavorite": false,
    "useCount": 0,
    "lastUsed": null
  }
]

Required fields:
- title (string)
- content (string)
- category (string)
- tags (array of strings)
- variables (array of strings)

Optional fields:
- isFavorite (boolean, default: false)
- useCount (number, default: 0)
- lastUsed (number or null, default: null)

${t('msgPromptGuideTip')}`;
}

// Import Custom Prompt Library
async function importCustomLibraryHandler(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Check if it's an array
    if (!Array.isArray(data)) {
      showStatus('error', t('msgInvalidPromptFormat'));
      alert(`${t('msgInvalidFormat')}\n\n${getPromptStructureExample()}`);
      return;
    }

    // Validate first prompt as a sample
    if (data.length > 0) {
      const errors = validatePromptStructure(data[0]);
      if (errors.length > 0) {
        const errorMsg = `${t('msgInvalidPromptStructure')}:\n\n${errors.join('\n')}\n\n${getPromptStructureExample()}`;
        showStatus('error', t('msgInvalidPromptStructure'));
        alert(errorMsg);
        return;
      }
    }

    // Validate all prompts
    const validationErrors = [];
    data.forEach((prompt, index) => {
      const errors = validatePromptStructure(prompt);
      if (errors.length > 0) {
        validationErrors.push(`Prompt #${index + 1}: ${errors.join(', ')}`);
      }
    });

    if (validationErrors.length > 0) {
      const errorMsg = t('msgValidationErrors', validationErrors.length.toString()) + `:\n\n${validationErrors.slice(0, 5).join('\n')}${validationErrors.length > 5 ? '\n...' : ''}\n\n${getPromptStructureExample()}`;
      showStatus('error', t('msgValidationErrors', validationErrors.length.toString()));
      alert(errorMsg);
      return;
    }

    // Wrap in expected format
    const libraryData = { prompts: data };

    // Import using the prompt manager
    const result = await importDefaultLibrary(libraryData);

    // Show results with toast notification
    if (result.imported > 0) {
      showToast('success', 'msgCustomPromptsImported', [result.imported.toString(), result.skipped.toString()]);
    } else {
      showToast('info', 'msgAllPromptsExist');
    }

    // Refresh stats
    await loadDataStats();

  } catch (error) {
    if (error instanceof SyntaxError) {
      showStatus('error', t('msgInvalidJSON'));
      alert(`${t('msgJSONParseError')}\n\n${getPromptStructureExample()}`);
    } else {
      showStatus('error', t('msgCustomImportFailed'));
      console.error('Import error:', error);
    }
  }
}

// Import Default Prompt Library
async function importDefaultLibraryHandler() {
  const button = document.getElementById('import-default-library');

  try {
    button.disabled = true;
    button.textContent = t('msgImporting');

    // Get user's language preference
    const language = await getDefaultLibraryLanguage();
    const libraryPath = getDefaultLibraryPath(language);

    // Fetch the default library data
    const response = await fetch(chrome.runtime.getURL(libraryPath));
    const promptsArray = await response.json();

    // Wrap array in expected format { prompts: [...] }
    const libraryData = Array.isArray(promptsArray)
      ? { prompts: promptsArray }
      : promptsArray;

    // Import using the prompt manager
    const result = await importDefaultLibrary(libraryData);

    // Update UI
    if (result.imported > 0) {
      button.textContent = t('msgImported');
      button.style.background = '#4caf50';
      button.style.color = 'white';
      showToast('success', 'msgDefaultPromptsImported', [result.imported.toString(), result.skipped.toString()]);
    } else {
      button.textContent = t('msgAlreadyImported');
      button.disabled = true;
      showToast('info', 'msgAllPromptsExist');
    }

    // Refresh stats
    await loadDataStats();

  } catch (error) {
    showStatus('error', t('msgDefaultImportFailed'));
    button.disabled = false;
    button.textContent = t('btnImportDefault');
  }
}

// Enter Key Behavior Helper Functions
function updateEnterBehaviorVisibility(enabled) {
  const settingsDiv = document.getElementById('enter-behavior-settings');
  if (settingsDiv) {
    settingsDiv.style.display = enabled ? 'block' : 'none';
  }
}

function updateCustomEnterSettingsVisibility(preset) {
  const customDiv = document.getElementById('custom-enter-settings');
  if (customDiv) {
    customDiv.style.display = preset === 'custom' ? 'block' : 'none';
  }
}

function loadCustomEnterSettings(enterBehavior) {
  // Load newline modifiers
  document.getElementById('newline-shift').checked = enterBehavior.newlineModifiers.shift || false;
  document.getElementById('newline-ctrl').checked = enterBehavior.newlineModifiers.ctrl || false;
  document.getElementById('newline-alt').checked = enterBehavior.newlineModifiers.alt || false;
  document.getElementById('newline-meta').checked = enterBehavior.newlineModifiers.meta || false;

  // Load send modifiers
  document.getElementById('send-shift').checked = enterBehavior.sendModifiers.shift || false;
  document.getElementById('send-ctrl').checked = enterBehavior.sendModifiers.ctrl || false;
  document.getElementById('send-alt').checked = enterBehavior.sendModifiers.alt || false;
  document.getElementById('send-meta').checked = enterBehavior.sendModifiers.meta || false;
}

async function applyEnterKeyPreset(preset) {
  const settings = await getSettings();
  const enterBehavior = settings.enterKeyBehavior || {};

  enterBehavior.preset = preset;

  // Define preset configurations
  const presets = {
    default: {
      newlineModifiers: { shift: true, ctrl: false, alt: false, meta: false },
      sendModifiers: { shift: false, ctrl: false, alt: false, meta: false }
    },
    swapped: {
      newlineModifiers: { shift: false, ctrl: false, alt: false, meta: false },
      sendModifiers: { shift: true, ctrl: false, alt: false, meta: false }
    },
    slack: {
      newlineModifiers: { shift: false, ctrl: true, alt: false, meta: false },
      sendModifiers: { shift: false, ctrl: false, alt: false, meta: false }
    },
    discord: {
      newlineModifiers: { shift: false, ctrl: false, alt: false, meta: false },
      sendModifiers: { shift: false, ctrl: true, alt: false, meta: false }
    }
  };

  if (preset !== 'custom' && presets[preset]) {
    enterBehavior.newlineModifiers = presets[preset].newlineModifiers;
    enterBehavior.sendModifiers = presets[preset].sendModifiers;
    loadCustomEnterSettings(enterBehavior);
  }

  await saveSetting('enterKeyBehavior', enterBehavior);
  showStatus('success', t('msgPresetChanged', preset));
}

async function saveCustomEnterSettings() {
  const settings = await getSettings();
  const enterBehavior = settings.enterKeyBehavior || {};

  enterBehavior.preset = 'custom';
  enterBehavior.newlineModifiers = {
    shift: document.getElementById('newline-shift').checked,
    ctrl: document.getElementById('newline-ctrl').checked,
    alt: document.getElementById('newline-alt').checked,
    meta: document.getElementById('newline-meta').checked
  };
  enterBehavior.sendModifiers = {
    shift: document.getElementById('send-shift').checked,
    ctrl: document.getElementById('send-ctrl').checked,
    alt: document.getElementById('send-alt').checked,
    meta: document.getElementById('send-meta').checked
  };

  await saveSetting('enterKeyBehavior', enterBehavior);

  // Update preset dropdown to show custom
  const presetSelect = document.getElementById('enter-preset-select');
  if (presetSelect) {
    presetSelect.value = 'custom';
  }

  showStatus('success', t('msgCustomMappingSaved'));
}

// T073: Version Check Functions
async function loadVersionDisplay(shouldCheckForUpdates = true) {
  const versionInfo = await loadVersionInfo();
  const versionEl = document.getElementById('version');
  const commitHashEl = document.getElementById('commit-hash');
  if (!versionInfo) {
    if (versionEl) {
      versionEl.textContent = t('msgVersionUnknown');
    }
    if (commitHashEl) {
      commitHashEl.textContent = '';
    }
    return;
  }

  if (versionEl) {
    versionEl.textContent = t('labelVersion', versionInfo.version);
  }
  // Hide commit-hash element since we no longer use it
  if (commitHashEl) {
    commitHashEl.style.display = 'none';
  }

  if (shouldCheckForUpdates) {
    await performVersionCheck();
  }
}

async function performVersionCheck() {
  const button = document.getElementById('check-updates-btn');
  const statusDiv = document.getElementById('update-status');
  const downloadLink = document.getElementById('download-latest-link');

  try {
    button.disabled = true;
    button.textContent = t('msgChecking');
    statusDiv.style.display = 'none';

    const result = await checkForUpdates();

    if (downloadLink) {
      downloadLink.href = result.downloadUrl || result.releaseUrl;
    }

    if (result.error) {
      statusDiv.textContent = result.error;
      statusDiv.className = 'update-status update-error';
      statusDiv.style.display = 'block';
      showStatus('error', result.error);
    } else if (result.updateAvailable) {
      const latest = result.latestVersion;
      const current = result.currentVersion;
      statusDiv.innerHTML = t('msgUpdateStatusAvailable', [latest, current]);
      statusDiv.className = 'update-status update-available';
      statusDiv.style.display = 'block';
      showStatus('success', t('msgUpdateAvailable'));
    } else {
      statusDiv.textContent = t('msgLatestVersion');
      statusDiv.className = 'update-status update-current';
      statusDiv.style.display = 'block';
      showStatus('success', t('msgUpToDate'));
    }
  } catch (error) {
    statusDiv.textContent = t('msgCheckUpdatesFailed');
    statusDiv.className = 'update-status update-error';
    statusDiv.style.display = 'block';
    showStatus('error', t('msgCheckUpdatesFailed'));
    console.error('Version check error:', error);
  } finally {
    button.disabled = false;
    button.textContent = t('btnCheckUpdates');
  }
}

// Initialize on load
init();
