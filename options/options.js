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
  loadCustomProviders,
  MAX_CUSTOM_PROVIDER_NAME_LENGTH,
  removeCustomProvider,
  subscribeCustomProvidersChanged,
  validateCustomProviderUrl
} from '../modules/custom-providers.js';
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

function getCustomProviderFormElements() {
  return {
    form: document.getElementById('custom-provider-form'),
    nameInput: document.getElementById('custom-provider-name'),
    urlInput: document.getElementById('custom-provider-url'),
    addButton: document.getElementById('custom-provider-add-btn'),
    originPreview: document.getElementById('custom-provider-origin-preview'),
    errorMessage: document.getElementById('custom-provider-error'),
    unsupportedNote: document.getElementById('custom-provider-unsupported')
  };
}

export function syncCustomProviderFormAvailability() {
  const { nameInput, urlInput, addButton, unsupportedNote } = getCustomProviderFormElements();
  const supported = supportsScopedFrameRules();
  const disabled = !supported || isSubmittingCustomProvider;

  if (unsupportedNote) {
    unsupportedNote.textContent = t('msgCustomProviderUnsupportedChrome');
    unsupportedNote.hidden = supported;
  }
  if (nameInput) {
    nameInput.disabled = disabled;
  }
  if (urlInput) {
    urlInput.disabled = disabled;
  }
  if (addButton) {
    addButton.disabled = disabled;
  }
}

function clearCustomProviderFormError() {
  const { nameInput, urlInput, errorMessage } = getCustomProviderFormElements();
  nameInput?.removeAttribute('aria-invalid');
  urlInput?.removeAttribute('aria-invalid');
  if (errorMessage) {
    errorMessage.textContent = '';
    errorMessage.hidden = true;
  }
}

function setCustomProviderFormError(message, invalidField = null) {
  const { nameInput, urlInput, errorMessage } = getCustomProviderFormElements();
  nameInput?.removeAttribute('aria-invalid');
  urlInput?.removeAttribute('aria-invalid');
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

  const { nameInput, urlInput } = getCustomProviderFormElements();
  if (!supportsScopedFrameRules()) {
    const message = t('msgCustomProviderUnsupportedChrome');
    setCustomProviderFormError(message);
    showStatus('error', message);
    return;
  }

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
  const urlCheck = validateCustomProviderUrl(rawUrl);
  if (!urlCheck.ok) {
    const message = getCustomProviderUrlErrorMessage(urlCheck.reason);
    setCustomProviderFormError(message, urlInput);
    urlInput?.focus?.();
    return;
  }

  let id;
  let frameRuleId;
  try {
    id = generateCustomProviderId();
    frameRuleId = allocateCustomFrameRuleId();
  } catch (allocationError) {
    const message = t('errCustomProviderSaveFailed');
    setCustomProviderFormError(message);
    showStatus('error', message);
    return;
  }

  const createdAt = Date.now();
  const permissionOrigin = `${urlCheck.origin}/*`;

  clearCustomProviderFormError();
  isSubmittingCustomProvider = true;
  syncCustomProviderFormAvailability();

  // Synchronously invoke chrome.permissions.request before any await so Chrome
  // preserves the transient user activation from clicking Add / pressing Enter.
  let permissionPromise;
  try {
    permissionPromise = chrome?.permissions?.request
      ? chrome.permissions.request({ origins: [permissionOrigin] })
      : Promise.resolve(false);
  } catch (requestSyncError) {
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
    } catch (requestError) {
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

    let addedToLocal = false;
    try {
      const savedRecord = await addCustomProvider({
        id,
        name: trimmedName,
        url: urlCheck.url,
        frameRuleId,
        createdAt
      });
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

      if (nameInput) nameInput.value = '';
      if (urlInput) urlInput.value = '';
      updateCustomProviderOriginPreview();
      clearCustomProviderFormError();
      await renderProviderList();
      showStatus('success', t('msgCustomProviderAdded', savedRecord.name));
    } catch (persistError) {
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

  const origin = descriptor.frameOrigins[0] || null;
  const providerName = descriptor.name;

  await removeCustomProvider(providerId);

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
  const { form, nameInput, urlInput } = getCustomProviderFormElements();
  syncCustomProviderFormAvailability();
  updateCustomProviderOriginPreview();

  if (!form || form.dataset.customFormBound === 'true') {
    return;
  }
  form.dataset.customFormBound = 'true';

  nameInput?.addEventListener('input', () => {
    clearCustomProviderFormError();
  });

  urlInput?.addEventListener('input', () => {
    clearCustomProviderFormError();
    updateCustomProviderOriginPreview();
  });

  urlInput?.addEventListener('blur', () => {
    if (!supportsScopedFrameRules()) {
      return;
    }
    const raw = urlInput.value;
    if (!raw || raw.trim().length === 0) {
      return;
    }
    const check = validateCustomProviderUrl(raw);
    if (!check.ok) {
      setCustomProviderFormError(getCustomProviderUrlErrorMessage(check.reason), urlInput);
    }
  });

  form.addEventListener('submit', (event) => {
    handleCustomProviderFormSubmit(event);
  });
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

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn-provider-delete';
  deleteButton.dataset.action = 'delete-custom-provider';
  deleteButton.dataset.providerId = provider.id;
  deleteButton.textContent = t('btnDelete');
  deleteButton.setAttribute('aria-label', t('ariaDeleteCustomProvider', provider.name));

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

  deleteButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteButton.hidden = true;
    confirmBox.hidden = false;
    confirmButton.focus?.();
  });

  cancelButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    confirmBox.hidden = true;
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
  group.append(deleteButton, confirmBox);
  return group;
}

function createProviderListItemElement(
  provider,
  { isEnabledPreference, hasAccess, googleProviderMode, descriptor }
) {
  const isCustom = descriptor?.access === 'custom';
  const isEnabled = isEnabledPreference && hasAccess;

  const item = document.createElement('div');
  item.className = isEnabled ? 'provider-item draggable' : 'provider-item';
  item.dataset.providerId = provider.id;
  item.dataset.enabledPreference = String(isEnabledPreference);
  item.dataset.hasAccess = String(hasAccess);
  if (isCustom) {
    item.dataset.customProvider = 'true';
  }
  item.setAttribute('draggable', String(isEnabled));

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

  if (isCustom && descriptor.frameOrigins?.[0]) {
    const origin = descriptor.frameOrigins[0];
    const originBadge = document.createElement('span');
    originBadge.className = 'provider-origin-badge';
    const shadow = originBadge.attachShadow({ mode: 'open' });
    const bdiEl = document.createElement('bdi');
    bdiEl.dir = 'ltr';
    bdiEl.style.direction = 'ltr';
    bdiEl.style.unicodeBidi = 'isolate';
    bdiEl.appendChild(document.createElement('slot'));
    shadow.appendChild(bdiEl);
    originBadge.textContent = origin;
    originBadge.title = origin;
    info.appendChild(originBadge);
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
  try {
    const prompts = await getAllPrompts();

    document.getElementById('stat-prompts').textContent = prompts.length;

    // Estimate storage size
    const promptsSize = JSON.stringify(prompts).length;
    const sizeKB = Math.round(promptsSize / 1024);
    document.getElementById('stat-storage').textContent = `~${sizeKB} KB`;
  } catch (error) {
    // Silently handle data stats errors
    document.getElementById('stat-prompts').textContent = '0';
    document.getElementById('stat-storage').textContent = '0 KB';
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
  if (!versionInfo) {
    document.getElementById('version').textContent = t('msgVersionUnknown');
    document.getElementById('commit-hash').textContent = '';
    return;
  }

  document.getElementById('version').textContent = t('labelVersion', versionInfo.version);
  // Hide commit-hash element since we no longer use it
  const commitHashEl = document.getElementById('commit-hash');
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
