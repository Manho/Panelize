import { notifyMessage } from '../modules/messaging.js';
import {
  saveConversation,
  findConversationByConversationId
} from '../modules/history-manager.js';
import { t, initializeLanguage } from '../modules/i18n.js';

// Install event - setup context menus
const DEFAULT_SHORTCUT_SETTING = { keyboardShortcutEnabled: true };
let keyboardShortcutEnabled = true;

async function loadShortcutSetting() {
  try {
    const result = await chrome.storage.sync.get(DEFAULT_SHORTCUT_SETTING);
    keyboardShortcutEnabled = result.keyboardShortcutEnabled;
  } catch (error) {
    // Fallback to default if storage unavailable
    keyboardShortcutEnabled = true;
  }
}

// 新增：打开 Multi-Panel 独立窗口的函数
async function openMultiPanel() {
  const multiPanelUrl = chrome.runtime.getURL('multi-panel/multi-panel.html');

  // 检查是否已有 Multi-Panel 窗口打开
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.url === multiPanelUrl) {
        // 已有窗口，聚焦它
        await chrome.windows.update(win.id, { focused: true });
        return;
      }
    }
  }

  // 创建新窗口
  await chrome.windows.create({
    url: multiPanelUrl,
    type: 'popup',
    width: 1400,
    height: 900
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await createContextMenus();
  await loadShortcutSetting();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadShortcutSetting();
});

// Create/update context menus dynamically based on enabled providers
async function createContextMenus() {
  // Remove all existing menus
  await chrome.contextMenus.removeAll();

  // Initialize language before creating menus
  await initializeLanguage();

  // Get enabled providers from settings
  const settings = await chrome.storage.sync.get({
    enabledProviders: ['chatgpt', 'claude', 'gemini', 'google', 'grok', 'deepseek', 'copilot', 'perplexity']
  });

  const enabledProviders = settings.enabledProviders;

  // Create main context menu item
  chrome.contextMenus.create({
    id: 'open-smarter-panel',
    title: t('contextMenuSendTo'),
    contexts: ['page', 'selection', 'link']
  });

  // Create submenu for each enabled provider
  const providerNames = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini',
    grok: 'Grok',
    deepseek: 'DeepSeek',
    google: 'Google',
    copilot: 'Microsoft Copilot',
    perplexity: 'Perplexity'
  };

  enabledProviders.forEach(providerId => {
    chrome.contextMenus.create({
      id: `provider-${providerId}`,
      parentId: 'open-smarter-panel',
      title: providerNames[providerId] || providerId,
      contexts: ['page', 'selection', 'link']
    });
  });

  // Add Prompt Library option
  chrome.contextMenus.create({
    id: 'open-prompt-library',
    parentId: 'open-smarter-panel',
    title: t('contextMenuPromptLibrary'),
    contexts: ['page', 'selection', 'link']
  });
}

// Listen for settings changes and update context menus
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.enabledProviders || changes.language) {
    createContextMenus();
  }
});

// Context menu click handler - opens Multi-Panel and sends message
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (!tab) {
      return;
    }

    // 先打开 Multi-Panel 窗口
    await openMultiPanel();

    if (info.menuItemId.startsWith('provider-')) {
      const providerId = info.menuItemId.replace('provider-', '');

      // Get source URL placement setting
      const settings = await chrome.storage.sync.get({ sourceUrlPlacement: 'end' });
      const placement = settings.sourceUrlPlacement;

      // Check if text is selected
      if (info.selectionText) {
        // Format content with source based on user preference
        let contentToSend;
        if (placement === 'none') {
          contentToSend = info.selectionText;
        } else if (placement === 'beginning') {
          contentToSend = `Source: ${info.pageUrl}\n\n${info.selectionText}`;
        } else {
          // default: 'end'
          contentToSend = `${info.selectionText}\n\nSource: ${info.pageUrl}`;
        }

        // Wait for multi-panel to load, then send message to switch provider
        setTimeout(() => {
          notifyMessage({
            action: 'switchProvider',
            payload: { providerId, selectedText: contentToSend }
          }).catch(() => {
            // Multi-Panel may not be ready yet, silently ignore
          });
        }, 500);
      } else {
        // No text selected - extract page content
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'extractPageContent'
          });

          if (response && response.success) {
            // Send extracted content to multi-panel
            setTimeout(() => {
              notifyMessage({
                action: 'switchProvider',
                payload: { providerId, selectedText: response.content }
              }).catch(() => {
                // Multi-Panel may not be ready yet, silently ignore
              });
            }, 500);
          } else {
            // Extraction failed - send empty to provider
            setTimeout(() => {
              notifyMessage({
                action: 'switchProvider',
                payload: { providerId, selectedText: '' }
              }).catch(() => {});
            }, 500);
          }
        } catch (error) {
          // Content script not ready or extraction failed
          // Send empty to provider
          setTimeout(() => {
            notifyMessage({
              action: 'switchProvider',
              payload: { providerId, selectedText: '' }
            }).catch(() => {});
          }, 500);
        }
      }
    } else if (info.menuItemId === 'open-prompt-library') {
      // Get source URL placement setting
      const settings = await chrome.storage.sync.get({ sourceUrlPlacement: 'end' });
      const placement = settings.sourceUrlPlacement;

      // Check if text is selected
      if (info.selectionText) {
        // Format content with source based on user preference
        let contentToSend;
        if (placement === 'none') {
          contentToSend = info.selectionText;
        } else if (placement === 'beginning') {
          contentToSend = `Source: ${info.pageUrl}\n\n${info.selectionText}`;
        } else {
          // default: 'end'
          contentToSend = `${info.selectionText}\n\nSource: ${info.pageUrl}`;
        }

        // Wait for multi-panel to load, then switch to prompt library
        setTimeout(() => {
          notifyMessage({
            action: 'openPromptLibrary',
            payload: { selectedText: contentToSend }
          }).catch(() => {
            // Multi-Panel may not be ready yet, ignore error
          });
        }, 500);
      } else {
        // No text selected - extract page content
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'extractPageContent'
          });

          if (response && response.success) {
            // Send extracted content to multi-panel
            setTimeout(() => {
              notifyMessage({
                action: 'openPromptLibrary',
                payload: { selectedText: response.content }
              }).catch(() => {
                // Multi-Panel may not be ready yet, ignore error
              });
            }, 500);
          } else {
            // Extraction failed - send empty
            setTimeout(() => {
              notifyMessage({
                action: 'openPromptLibrary',
                payload: { selectedText: '' }
              }).catch(() => {});
            }, 500);
          }
        } catch (error) {
          // Content script not ready or extraction failed
          // Send empty
          setTimeout(() => {
            notifyMessage({
              action: 'openPromptLibrary',
              payload: { selectedText: '' }
            }).catch(() => {});
          }, 500);
        }
      }
    }
  } catch (error) {
    // Silently handle context menu errors
  }
});

// Handle action clicks (toolbar button) - opens Multi-Panel
chrome.action.onClicked.addListener(async (tab) => {
  if (!keyboardShortcutEnabled) {
    return;
  }

  await openMultiPanel();
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'sync') return;

  if (changes.keyboardShortcutEnabled) {
    keyboardShortcutEnabled = changes.keyboardShortcutEnabled.newValue !== false;
  }
});

// Listen for conversation saves, duplicate checks, and version checks
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveConversationFromPage') {
    // Handle conversation save from ChatGPT page
    handleSaveConversation(message.payload, sender).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === 'checkDuplicateConversation') {
    // Handle duplicate check request
    handleCheckDuplicate(message.payload).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === 'fetchLatestCommit') {
    // Handle version check request from options page
    handleFetchLatestCommit().then(sendResponse);
    return true; // Keep channel open for async response
  }
  return true;
});

// Handle version check by fetching latest commit from GitHub API
async function handleFetchLatestCommit() {
  try {
    const GITHUB_API_URL = 'https://api.github.com/repos/xiaolai/insidebar-ai/commits/main';

    const response = await fetch(GITHUB_API_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      success: true,
      data: {
        sha: data.sha,
        shortSha: data.sha.substring(0, 7),
        date: data.commit.committer.date,
        message: data.commit.message
      }
    };
  } catch (error) {
    console.error('[Background] Error fetching latest commit:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Handle duplicate conversation check - now with direct database access
async function handleCheckDuplicate(payload) {
  try {
    const { conversationId } = payload;

    if (!conversationId) {
      return { isDuplicate: false };
    }

    // Query IndexedDB directly without requiring sidebar
    const existingConversation = await findConversationByConversationId(conversationId);

    if (existingConversation) {
      return {
        isDuplicate: true,
        existingConversation: existingConversation
      };
    }

    return { isDuplicate: false };
  } catch (error) {
    console.error('[Background] Error checking duplicate:', error);
    // Propagate error instead of silently returning false
    throw error;
  }
}

// Handle saving conversation - now with direct database access
async function handleSaveConversation(conversationData, sender) {
  try {
    // Save directly to IndexedDB without requiring sidebar
    const savedConversation = await saveConversation(conversationData);

    // Notify multi-panel to refresh chat history if it's open
    try {
      await notifyMessage({
        action: 'refreshChatHistory',
        payload: { conversationId: savedConversation.id }
      });
    } catch (error) {
      // Multi-Panel may not be open, that's okay
    }

    return { success: true, data: savedConversation };
  } catch (error) {
    console.error('[Background] Error saving conversation:', error);
    return { success: false, error: error.message };
  }
}

// Listen for keyboard shortcuts - simplified for Multi-Panel mode
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'open-prompt-library' || command === 'open-multi-panel') {
    // Open Multi-Panel
    await openMultiPanel();

    // If it's prompt library command, also send message to open it
    if (command === 'open-prompt-library') {
      setTimeout(() => {
        notifyMessage({
          action: 'openPromptLibrary',
          payload: {}
        }).catch(() => {
          // Multi-Panel may not be ready yet, ignore error
        });
      }, 500);
    }
  } else if (command === 'toggle-focus') {
    // In Multi-Panel mode, toggle-focus just opens/focuses the Multi-Panel
    await openMultiPanel();
  }
});
