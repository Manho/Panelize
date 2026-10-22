// Text injection handler for all AI providers
// Self-contained script without module imports (for iframe compatibility)

(function() {
  'use strict';

  const GOOGLE_PROVIDER_MODE_AI = 'ai';
  const GOOGLE_PROVIDER_MODE_SEARCH = 'search';
  const MULTI_PANEL_PROVIDER_STATUS_CONTEXT = 'multi-panel-provider-status';
  const MULTI_PANEL_ACTION_RESULT_CONTEXT = 'multi-panel-action-result';
  const PANELIZE_ACTION_RESULT = 'PANELIZE_ACTION_RESULT';
  const PANELIZE_PROVIDER_BUSY = 'PANELIZE_PROVIDER_BUSY';
  const PANELIZE_PROVIDER_IDLE = 'PANELIZE_PROVIDER_IDLE';
  const PANELIZE_PROVIDER_USER_INTERACTION = 'PANELIZE_PROVIDER_USER_INTERACTION';
  const PANELIZE_TEMP_CHAT_ENABLED = 'PANELIZE_TEMP_CHAT_ENABLED';
  const PANELIZE_PROVIDER_LOCATION = 'PANELIZE_PROVIDER_LOCATION';
  const PANELIZE_RESTORE_USER_FOCUS = 'PANELIZE_RESTORE_USER_FOCUS';
  const PANELIZE_SNAPSHOT_PREPARE = 'PANELIZE_SNAPSHOT_PREPARE';
  const PANELIZE_SNAPSHOT_SCROLL = 'PANELIZE_SNAPSHOT_SCROLL';
  const PANELIZE_SNAPSHOT_RESTORE = 'PANELIZE_SNAPSHOT_RESTORE';
  const PANELIZE_SNAPSHOT_STATE = 'PANELIZE_SNAPSHOT_STATE';
  const MULTI_PANEL_SNAPSHOT_CONTEXT = 'multi-panel-snapshot';
  const PANELIZE_PAGE_WIDTH = 'PANELIZE_PAGE_WIDTH';
  const PAGE_WIDTH_REPORT_THROTTLE_MS = 500;
  // The app shell is near the top of the tree; deeper nodes are content.
  const PAGE_WIDTH_MAX_DEPTH = 12;
  const PAGE_WIDTH_MAX_ELEMENTS = 1000;
  const PAGE_WIDTH_SCROLLING_OVERFLOW = /^(auto|scroll)$/;
  // Normalized prompt prefix that identifies the user's message.
  const SNAPSHOT_MATCH_KEY_LENGTH = 40;
  const SNAPSHOT_MIN_MATCH_KEY_LENGTH = 2;
  const SNAPSHOT_MAX_MATCH_CANDIDATES = 50;
  const SNAPSHOT_ALIGN_MARGIN_PX = 16;
  const SNAPSHOT_PAINT_SETTLE_MS = 100;
  const SNAPSHOT_PAINT_TIMEOUT_MS = 400;
  // A conversation list fills a good part of the frame; smaller scrolling
  // boxes are code blocks or collapsed messages.
  const SNAPSHOT_MIN_CONTAINER_HEIGHT_RATIO = 0.3;
  // Pinned bars cover at most this share of the container at each edge.
  const SNAPSHOT_MAX_EDGE_RATIO = 0.4;
  const SNAPSHOT_OVERLAY_MIN_WIDTH_RATIO = 0.5;
  const SNAPSHOT_EDGE_TOLERANCE_PX = 24;
  // Floating buttons and fades hidden while stitching are at most this share
  // of the visible conversation high; taller layers are backgrounds.
  const SNAPSHOT_MAX_FLOATING_HEIGHT_RATIO = 0.5;
  const SNAPSHOT_HIDDEN_MASK_PROPERTIES = ['mask-image', '-webkit-mask-image'];
  const SNAPSHOT_SKIPPED_TEXT_PARENTS = [
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select',
    '[contenteditable=""]', '[contenteditable="true"]', '[aria-hidden="true"]'
  ].join(', ');
  // Chat history lists and links repeat prompts as titles; they are not the
  // conversation.
  const SNAPSHOT_NAVIGATION_PARENTS = 'nav, aside, [role="navigation"], [role="complementary"], a[href]';
  // User messages by role attribute or known bubble, for when the prompt is
  // not on the page (e.g. typed into the provider directly).
  const SNAPSHOT_USER_TURN_SELECTORS = [
    '[data-message-author-role="user"]', // ChatGPT
    '[data-testid="user-message"]', // Claude
    'user-query', // Gemini
    '[class*="items-end"] .message-bubble', // Grok
    '[data-role="user"]',
    '[data-author="user"]',
    '[data-message-role="user"]',
    '[data-sender="user"]',
    '[data-content="user-message"]', // Copilot
    '[data-testid="send_message"]', // Doubao
    '.chat-content-item-user', // Kimi
    '.chat-user-message' // Qwen
  ].join(', ');
  // How far an aligned message may be from where it was put.
  const SNAPSHOT_ALIGN_TOLERANCE_PX = 2;
  // Paints to wait for a virtual list to grow back to the position it had.
  const SNAPSHOT_RESTORE_ATTEMPTS = 10;
  // Inline properties set to take a sticky box out of sticking, keeping its
  // place in the flow.
  const SNAPSHOT_UNSTICK_PROPERTIES = ['position', 'top', 'right', 'bottom', 'left'];
  // Marks pseudo-elements to hide (e.g. "before after") and the document
  // whose pointer is hidden; styled by SNAPSHOT_STYLE_RULES.
  const SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE = 'data-panelize-snapshot-hide';
  const SNAPSHOT_HIDE_CURSOR_ATTRIBUTE = 'data-panelize-snapshot-cursor';
  const SNAPSHOT_STYLE_RULES = `
    [${SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE}~="before"]::before,
    [${SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE}~="after"]::after { visibility: hidden !important; }
    [${SNAPSHOT_HIDE_CURSOR_ATTRIBUTE}], [${SNAPSHOT_HIDE_CURSOR_ATTRIBUTE}] *,
    [${SNAPSHOT_HIDE_CURSOR_ATTRIBUTE}] *::before, [${SNAPSHOT_HIDE_CURSOR_ATTRIBUTE}] *::after { cursor: none !important; }
  `;
  const SNAPSHOT_STYLE_ELEMENT_ID = 'panelize-snapshot-style';
  const USER_FOCUS_RESTORE_WINDOW_MS = 2000;
  const CHATGPT_STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"]';
  const CHATGPT_SEND_TRACKING_IDLE_DELAY_MS = 800;
  const CHATGPT_SEND_TRACKING_NO_BUSY_TIMEOUT_MS = 2000;
  const MULTI_PANEL_USER_INTERACTION_TRACKING_TIMEOUT_MS = 90000;
  const TEMP_CHAT_POLL_INTERVAL_MS = 200;
  const TEMP_CHAT_POLL_TIMEOUT_MS = 1200;
  const YUANBAO_TEMP_CHAT_CLICK_COOLDOWN_MS = 5000;
  const IMAGE_UPLOAD_PREVIEW_TIMEOUT_MS = 6000;
  const SLOW_COMPOSER_PROVIDERS = new Set([
    'deepseek', 'kimi', 'doubao', 'chatglm', 'zai-global', 'yuanbao'
  ]);
  const IMAGE_INJECTION_REASONS = Object.freeze({
    CONTROL_NOT_FOUND: 'control-not-found',
    UNSUPPORTED: 'unsupported',
    PREVIEW_TIMEOUT: 'preview-timeout',
    INJECTION_ERROR: 'injection-error'
  });
  let googleSearchReplaceOnNextFill = true;
  let chatgptSendTracking = null;
  let multiPanelUserInteractionTracking = null;
  let yuanbaoTemporaryChatActivation = null;
  let yuanbaoTemporaryChatLastClickAt = -Infinity;
  // Element the user focused with the interaction reported to multi-panel,
  // in case the parent's focus restore took focus away before it heard back.
  let lastUserFocus = null;
  const pendingKimiImageUploads = new Map();
  const pendingProviderImageUploads = new Map();
  // Scroll container and positions of the snapshot being taken.
  let snapshotSession = null;
  // Constructed sheet with SNAPSHOT_STYLE_RULES, adopted while a snapshot runs.
  let snapshotStyleSheet = null;

  // Provider-specific selectors. ChatGPT's composer lookup lives in
  // chatgpt-composer.js, shared with the other ChatGPT content scripts.
  const PROVIDER_SELECTORS = {
    claude: [
      '.ProseMirror[role="textbox"]',
      '.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]'
    ],
    gemini: ['.ql-editor'],
    grok: ['.tiptap', '.ProseMirror', 'textarea'],
    deepseek: [
      'textarea[placeholder="How can I help you?"]',
      'textarea.ds-scroll-area',
      'textarea[class*="ds-"]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    kimi: [
      '.chat-input-editor',
      'div[contenteditable="true"].chat-input-editor',
      'div.chat-input-editor[contenteditable]',
      'div[contenteditable="true"]'
    ],
    doubao: [
      '#input-engine-container .ProseMirror[contenteditable="true"]',
      '#input-engine-container .semi-input-textarea-wrapper textarea',
      '.semi-input-textarea-wrapper textarea',
      '#input-engine-container textarea',
      'textarea.semi-input-textarea',
      'textarea.semi-input-textarea[placeholder="发消息..."]',
      'textarea[placeholder="发消息..."]',
      '[data-slate-editor="true"][contenteditable="true"]',
      '.flow-chat-editor [data-slate-editor="true"][contenteditable="true"]',
      '.flow-chat-editor [contenteditable="true"][role="textbox"]',
      '.flow-chat-editor [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]'
    ],
    'qwen-cn': [
      '[data-chat-input-layout="true"] [data-chat-input-body="true"] [data-slate-editor="true"][contenteditable="true"][role="textbox"]'
    ],
    'qwen-global': [
      '#message-input-container textarea.message-input-textarea',
      '.message-input-container textarea.message-input-textarea'
    ],
    chatglm: [
      '#search-input-box textarea.scroll-display-none',
      'textarea.scroll-display-none'
    ],
    'zai-global': [
      'textarea[placeholder="How can I help you today?"]',
      'textarea.input-scroll'
    ],
    yuanbao: [
      '.chat-command-editor-specail .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"][data-placeholder]'
    ],
    google: [
      'textarea.ITIRGe',
      'textarea[aria-label="Ask anything"]',
      'textarea[maxlength="8192"]'
    ]
  };

  const GOOGLE_AI_INPUT_SELECTORS = [
    'textarea.ITIRGe',
    'textarea[aria-label="Ask anything"]',
    'textarea[maxlength="8192"]'
  ];

  const GOOGLE_SEARCH_INPUT_SELECTORS = [
    'input[name="q"]',
    'textarea[name="q"]',
    'input.gLFyf',
    'textarea.gLFyf'
  ];

  // Provider image support configuration
  const PROVIDER_IMAGE_SUPPORT = {
    chatgpt: true,
    claude: true,
    gemini: true,
    grok: true,
    deepseek: true,
    kimi: true,
    doubao: true,
    'qwen-cn': true,
    'qwen-global': true,
    chatglm: true,
    'zai-global': true,
    yuanbao: true,
    google: true  // Google AI Mode supports images
  };

  // Provider-specific file input selectors for image upload
  const FILE_INPUT_SELECTORS = {
    chatgpt: ['input[type="file"][data-testid="file-upload-input"]', 'input[type="file"]'],
    claude: ['input[type="file"]'],
    gemini: ['input[type="file"]'],
    doubao: ['input[type="file"]'],
    'qwen-cn': ['input[type="file"][accept*="image"]'],
    'qwen-global': [
      '.message-input-container input#filesUpload',
      '#dropzone-container input#filesUpload'
    ],
    chatglm: ['input.el-upload__input[type="file"]'],
    'zai-global': ['input[type="file"][multiple][accept*=".png"]'],
    yuanbao: ['input[type="file"][multiple][accept*="image"]'],
    google: ['input[type="file"]']
  };

  // Provider-specific upload button selectors (to click before file input)
  const UPLOAD_BUTTON_SELECTORS = {
    chatgpt: ['button[aria-label="Attach files"]', 'button[data-testid="composer-attach-button"]', 'button:has(svg path[d*="M9"])'],
    claude: ['button[aria-label="Attach file"]', 'button[aria-label="Upload file"]', 'fieldset button:has(svg)'],
    gemini: ['button[aria-label="Upload file"]', 'button[mattooltip="Upload file"]', '.add-button', 'button:has(mat-icon)'],
    doubao: [
      '#input-engine-container button[data-slot="dropdown-menu-trigger"][aria-haspopup="menu"]'
    ],
    yuanbao: [
      'button[data-new-input-control="add-tools-trigger"]',
      'button[aria-label="Add"]'
    ],
    google: [
      'button[aria-label="更多输入项"]',
      'button[aria-label="Upload image"]',
      'button[aria-label="上传图片"]',
      'button[aria-label="上传文件"]',
      'button[aria-label="Add image"]',
      'button[aria-label="Upload image"]',
      'button[aria-label="Add"]',
      'button[title="Add image"]',
      'button[title="Upload image"]',
      'button[data-xid*="image"]',
      'button[data-xid*="upload"]'
    ]
  };

  // Provider-specific send button selectors
  const SEND_BUTTON_SELECTORS = {
    chatgpt: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      'form button[type="submit"]'
    ],
    claude: [
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'fieldset button[type="button"]:has(svg)',
      'button.bg-accent-main-100'
    ],
    gemini: [
      'button[aria-label="Send message"]',
      'button[aria-label="发送"]',
      'button.send-button',
      'button[mattooltip="Send message"]',
      '.input-area-container button:has(mat-icon[fonticon="arrow_upward"])',
      'button[aria-label="Submit"]'
    ],
    grok: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button[type="submit"]',
      'form button:has(svg)'
    ],
    deepseek: [
      // Current site: a design-system div button that is disabled by class.
      'div[role="button"].ds-button--primary.ds-button--filled:not(.ds-button--disabled)',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ],
    kimi: [
      // Priority: clickable send button containers that are not disabled
      '.send-button-container:not(.disabled)',
      'div[class*="send"]:not([class*="disabled"])',
      // Backup: look for send icon and click its parent
      'svg[name="Send"]',
      '.send-icon',
      // Try to find button by aria-label
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]'
    ],
    doubao: [
      '#flow-end-msg-send',
      'button#flow-end-msg-send',
      '#input-engine-container button#flow-end-msg-send',
      'button[data-testid="send-button"]',
      'button[data-test-id="send-button"]',
      'button[aria-label="Send"]',
      'button[aria-label="发送"]',
      'button[type="submit"]'
    ],
    'qwen-cn': [
      '[data-chat-input-layout="true"] button[aria-label="发送消息"]'
    ],
    'qwen-global': [
      '#message-input-container .chat-prompt-send-button button.send-button',
      '.message-input-container .chat-prompt-send-button button.send-button'
    ],
    chatglm: [
      '#search-input-box .enter.is-main-chat .enter-icon-container',
      '#search-input-box .enter.is-main-chat',
      '.enter.is-main-chat'
    ],
    'zai-global': [
      'button.sendMessageButton'
    ],
    yuanbao: [
      '#yuanbao-send-btn[aria-label="Send"]',
      '#yuanbao-send-btn'
    ],
    google: [
      'button[data-xid="input-plate-send-button"]',
      'button[aria-label="Send"]',
      'button.OEueve'
    ]
  };

  // Provider-specific new chat button selectors and URLs
  const NEW_CHAT_BUTTON_SELECTORS = {
    chatgpt: [
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
      'a[href="/"]',
      'nav a[href="/"]',
      'aside a[href="/"]',
      '[data-testid="new-chat-button"]'
    ],
    claude: [
      'button[aria-label="Start new chat"]',
      'button[aria-label*="new chat"]',
      'a[href="/new"]',
      'a[href="https://claude.ai/new"]',
      'div[role="button"][aria-label*="New"]'
    ],
    gemini: [
      'button[aria-label="New chat"]',
      'button[aria-label*="New"]',
      'a[aria-label="New chat"]'
    ],
    grok: [
      'a[href="/"]',
      'button[aria-label*="New"]',
      'a[href*="new"]'
    ],
    deepseek: [
      // Current site: the sidebar "New chat" item is a focusable div with an
      // icon and a label and no role; its only class is a build hash.
      'div[tabindex="0"]:not([role]):has(> .ds-icon):has(> span)',
      'button[aria-label*="New"]',
      'a[href="/"]',
      'div[class*="new-chat"]'
    ],
    kimi: [
      'a.new-chat-btn',
      'a[href="/"]',
      '.sidebar a[href="/"]'
    ],
    doubao: [
      '#flow_chat_sidebar [data-testid="create_conversation_button"]',
      '#flow_chat_sidebar > div.cursor-pointer',
      '#flow_chat_sidebar > div[class*="cursor-pointer"]',
      'button[data-testid="new-chat-button"]',
      'button[data-test-id="new-chat-button"]',
      'button[data-testid="new-conversation-button"]',
      'button[data-test-id="new-conversation-button"]',
      'a[href="/chat/"]',
      'a[href="/chat"]',
      'button[aria-label*="New"]',
      'button[aria-label*="新建"]'
    ],
    'qwen-cn': [
      '#new-nav-tab-wrapper [data-session-switch-target="new-chat"]',
      '#new-nav-tab-wrapper button:has([data-icon-type="qwpcicon-newDialogue"])'
    ],
    'qwen-global': [
      'button.new-chat',
      '[role="button"].new-chat',
      '[data-testid="sidebar-new-chat-button"]'
    ],
    chatglm: ['.aside-subjects .new-session'],
    'zai-global': [
      'button[aria-label="New Chat"]',
      'button.navNewChat'
    ],
    yuanbao: [
      '[role="button"][aria-label="New Chat"]',
      '.yb-new-chat-entry__item[aria-label="New Chat"]',
      '.yb-projects-section__item-new-chat[aria-label="New Chat"]',
      '[role="button"][aria-label="新建对话"]',
      '[role="button"][aria-label="新建對話"]'
    ],
    google: [
      'button[aria-label="New search"]',
      'a[aria-label="Google"]',
      'a[href^="/search"][href*="udm="]'
    ]
  };

  // Fallback URLs for creating new chat when button not found
  const NEW_CHAT_URLS = {
    chatgpt: 'https://chatgpt.com/',
    claude: 'https://claude.ai/new',
    gemini: 'https://gemini.google.com/app',
    grok: 'https://grok.com/',
    deepseek: 'https://chat.deepseek.com/',
    kimi: 'https://www.kimi.com/',
    doubao: 'https://www.doubao.com/chat/',
    'qwen-cn': 'https://www.qianwen.com/',
    'qwen-global': 'https://chat.qwen.ai/c/new-chat',
    chatglm: 'https://chatglm.cn/',
    'zai-global': 'https://chat.z.ai/',
    // Keep this in sync with YUANBAO_DEFAULT_URL in modules/providers.js.
    yuanbao: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    google: 'https://www.google.com/search?udm=50'
  };

  const TEMP_CHAT_BUTTON_SELECTORS = {
    chatgpt: ['button[aria-label="Turn on temporary chat"]'],
    claude: ['button[aria-label="Use incognito"]'],
    gemini: [
      'button[data-test-id="temp-chat-button"]',
      'button[aria-label="Temporary chat"]'
    ],
    grok: ['a[href="/c#private"][aria-label="Switch to Private Chat"]'],
    yuanbao: [
      '[role="button"][aria-label="Enter Temporary Chat"]',
      '[role="button"][aria-label="Exit Temporary Chat"]',
      '[role="button"][aria-label="进入临时对话"]',
      '[role="button"][aria-label="退出临时对话"]',
      '[role="button"][aria-label="進入臨時對話"]',
      '[role="button"][aria-label="退出臨時對話"]'
    ]
  };

  // Detect which provider we're on based on hostname
  function detectProvider() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;
    const search = window.location.search;

    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) {
      return 'chatgpt';
    } else if (hostname.includes('claude.ai')) {
      return 'claude';
    } else if (hostname.includes('gemini.google.com')) {
      return 'gemini';
    } else if (hostname.includes('grok.com')) {
      return 'grok';
    } else if (hostname.includes('deepseek.com')) {
      return 'deepseek';
    } else if (hostname.includes('kimi.com')) {
      return 'kimi';
    } else if (hostname.includes('doubao.com')) {
      return 'doubao';
    } else if (hostname === 'www.qianwen.com') {
      return 'qwen-cn';
    } else if (hostname === 'chat.qwen.ai') {
      return 'qwen-global';
    } else if (hostname === 'chatglm.cn') {
      return 'chatglm';
    } else if (hostname === 'chat.z.ai') {
      return 'zai-global';
    } else if (hostname === 'yuanbao.tencent.com') {
      return 'yuanbao';
    } else if (hostname.includes('google.com') || hostname.includes('google.') || hostname === 'www.google.com') {
      // Google Search / AI Mode
      // Always return 'google' for any google.com page
      // The handleGoogleNewSearch will navigate to homepage which works for all cases
      return 'google';
    }
    return null;
  }

  function normalizeGoogleProviderMode(mode) {
    return mode === GOOGLE_PROVIDER_MODE_SEARCH
      ? GOOGLE_PROVIDER_MODE_SEARCH
      : GOOGLE_PROVIDER_MODE_AI;
  }

  function resetGoogleSearchFillSession() {
    googleSearchReplaceOnNextFill = true;
  }

  function isVisibleElement(element) {
    if (!element || element.offsetParent === null || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : null;

    if (!rect) {
      return true;
    }

    if (rect.width === 0 && rect.height === 0) {
      return element.offsetParent !== null;
    }

    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || Number.POSITIVE_INFINITY;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || Number.POSITIVE_INFINITY;

    return Boolean(
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth
    );
  }

  function findFirstVisibleElement(selectors, accept = null) {
    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          if (isVisibleElement(element) && (!accept || accept(element))) {
            return element;
          }
        }
      } catch (error) {
        console.warn('[Text Injection] Error finding visible element with selector:', selector, error);
      }
    }

    return null;
  }

  function getElementAccessibleText(element) {
    return [
      element?.getAttribute?.('aria-label') || '',
      element?.getAttribute?.('title') || '',
      element?.textContent || ''
    ]
      .join(' ')
      .trim()
      .toLowerCase();
  }

  function findDeepFirstVisibleElement(selectors, accept = null) {
    for (const selector of selectors) {
      try {
        const elements = querySelectorAllDeep(selector);
        for (const element of elements) {
          if (isVisibleElement(element) && (!accept || accept(element))) {
            return element;
          }
        }
      } catch (error) {
        console.warn('[Text Injection] Error finding deep visible element with selector:', selector, error);
      }
    }

    return null;
  }

  function findDeepClickableElementByKeywords(keywords) {
    const loweredKeywords = keywords.map(keyword => keyword.toLowerCase());
    const candidates = querySelectorAllDeep('button, [role="button"], [role="menuitem"], label');

    for (const candidate of candidates) {
      if (!isVisibleElement(candidate)) {
        continue;
      }

      const searchableText = getElementAccessibleText(candidate);
      if (loweredKeywords.some(keyword => searchableText.includes(keyword))) {
        return candidate;
      }
    }

    return null;
  }

  function getGoogleInputSelectors(mode) {
    return normalizeGoogleProviderMode(mode) === GOOGLE_PROVIDER_MODE_SEARCH
      ? GOOGLE_SEARCH_INPUT_SELECTORS
      : GOOGLE_AI_INPUT_SELECTORS;
  }

  function postMultiPanelProviderStatus(type, requestId, phase, provider = detectProvider()) {
    if (!requestId || window.parent === window) {
      return;
    }

    window.parent.postMessage({
      type,
      requestId,
      provider,
      phase,
      context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT
    }, '*');
  }

  function postMultiPanelActionResult(requestId, provider, result) {
    if (!requestId || !provider || window.parent === window) {
      return;
    }

    const message = {
      type: PANELIZE_ACTION_RESULT,
      context: MULTI_PANEL_ACTION_RESULT_CONTEXT,
      requestId,
      provider,
      action: 'fill',
      status: result.ok ? 'succeeded' : 'failed'
    };

    if (Array.isArray(result?.succeededImageIds)) {
      message.succeededImageIds = result.succeededImageIds;
    }

    if (!result.ok) {
      message.reason = result.reason || IMAGE_INJECTION_REASONS.INJECTION_ERROR;
    }

    window.parent.postMessage(message, '*');
  }

  function postTemporaryChatEnabled(provider = detectProvider()) {
    if (!provider || window.parent === window) {
      return;
    }

    window.parent.postMessage({
      type: PANELIZE_TEMP_CHAT_ENABLED,
      provider,
      context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT
    }, '*');
  }

  function postProviderLocation(provider = detectProvider()) {
    if (!provider || window.parent === window) {
      return;
    }

    window.parent.postMessage({
      type: PANELIZE_PROVIDER_LOCATION,
      provider,
      url: window.location.href,
      context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT
    }, '*');
  }

  function setupProviderLocationReporting() {
    let lastReportedUrl = null;

    const reportIfChanged = () => {
      const currentUrl = window.location.href;
      if (currentUrl === lastReportedUrl) {
        return;
      }

      lastReportedUrl = currentUrl;
      postProviderLocation();
    };

    const wrapHistoryMethod = (methodName) => {
      const original = window.history?.[methodName];
      if (typeof original !== 'function') {
        return;
      }

      try {
        window.history[methodName] = function(...args) {
          const result = original.apply(this, args);
          setTimeout(reportIfChanged, 0);
          return result;
        };
      } catch (error) {
        console.warn('[Text Injection] Unable to wrap history method:', methodName, error);
      }
    };

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    window.addEventListener('popstate', reportIfChanged);
    window.addEventListener('hashchange', reportIfChanged);
    reportIfChanged();
  }

  function isMultiPanelFrame() {
    if (window.parent === window || window.parent !== window.top) {
      return false;
    }
    const embedder = window.location.ancestorOrigins?.[0];
    return embedder === undefined || /^(chrome|moz)-extension:/.test(embedder);
  }

  /** Boxes filling the viewport hold the app itself, even when they scroll or float. */
  function isPageShellBox(rect, viewportWidth, viewportHeight) {
    return rect.left <= 1 && rect.right >= viewportWidth - 1 && rect.height >= viewportHeight / 2;
  }

  /**
   * Width the page's layout needs, in CSS pixels: the furthest an element
   * held open by a pixel min-width reaches from where it starts. Only the app
   * shell is scanned: floating layers (menus, popovers) and content of
   * scrolling boxes (chat lists, code blocks, tables) are left out. Returns 0
   * when nothing needs more room than the viewport.
   */
  function measurePageNeededWidth() {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    if (!document.body || !(viewportWidth > 0)) {
      return 0;
    }
    let needed = 0;
    let visited = 0;
    const queue = Array.from(document.body.children, (element) => ({ element, depth: 1 }));
    for (let index = 0; index < queue.length && visited < PAGE_WIDTH_MAX_ELEMENTS; index += 1) {
      const { element, depth } = queue[index];
      visited += 1;
      const style = window.getComputedStyle(element);
      if (style.display === 'none') {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const shell = isPageShellBox(rect, viewportWidth, viewportHeight);
      if ((style.position === 'absolute' || style.position === 'fixed') && !shell) {
        continue;
      }
      const minWidth = style.minWidth.endsWith('px') ? parseFloat(style.minWidth) : 0;
      const startsOnScreen = rect.left >= -1 && rect.left < viewportWidth - 1;
      if (minWidth > 0 && rect.height > 0 && startsOnScreen && style.visibility !== 'hidden') {
        const reach = rect.left + window.scrollX + minWidth;
        if (reach > viewportWidth + 1) {
          needed = Math.max(needed, Math.ceil(reach));
        }
      }
      const scrolls = PAGE_WIDTH_SCROLLING_OVERFLOW.test(style.overflowX)
        || PAGE_WIDTH_SCROLLING_OVERFLOW.test(style.overflowY);
      if (depth < PAGE_WIDTH_MAX_DEPTH && (shell || !scrolls)) {
        for (const child of element.children) {
          queue.push({ element: child, depth: depth + 1 });
        }
      }
    }
    return needed;
  }

  /**
   * Tells the multi-panel host how wide this page needs to be, so a panel
   * narrower than that can scale the page down to fit instead of cutting it.
   */
  function setupPageWidthReporting() {
    if (!isMultiPanelFrame() || typeof ResizeObserver !== 'function') {
      return;
    }
    let lastReported = null;
    let timer = null;

    const report = () => {
      timer = null;
      // Snapshots move content around; measure once they are done.
      if (snapshotSession) {
        schedule();
        return;
      }
      const provider = detectProvider();
      const neededWidth = measurePageNeededWidth();
      if (!provider || neededWidth === lastReported) {
        return;
      }
      lastReported = neededWidth;
      window.parent.postMessage({
        type: PANELIZE_PAGE_WIDTH,
        provider,
        neededWidth,
        context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT
      }, '*');
    };

    function schedule() {
      if (timer === null) {
        timer = setTimeout(report, PAGE_WIDTH_REPORT_THROTTLE_MS);
      }
    }

    new ResizeObserver(schedule).observe(document.documentElement);
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
    schedule();
  }

  function rememberUserFocus() {
    const entry = { element: null, at: Date.now() };
    lastUserFocus = entry;
    // Focus moves after pointerdown, so capture the element it lands on.
    const captureFocus = (event) => {
      if (lastUserFocus === entry && !entry.element) {
        entry.element = event.target;
      }
    };
    document.addEventListener('focusin', captureFocus, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('focusin', captureFocus, true), USER_FOCUS_RESTORE_WINDOW_MS);
  }

  function restoreUserFocus() {
    const entry = lastUserFocus;
    lastUserFocus = null;
    if (!entry?.element?.isConnected || Date.now() - entry.at > USER_FOCUS_RESTORE_WINDOW_MS) {
      return;
    }

    try {
      entry.element.focus({ preventScroll: true });
    } catch {
      entry.element.focus();
    }
  }

  function stopMultiPanelUserInteractionTracking() {
    const tracking = multiPanelUserInteractionTracking;
    if (!tracking) {
      return;
    }

    if (typeof tracking.timeoutId === 'number') {
      clearTimeout(tracking.timeoutId);
    }

    if (tracking.interactionHandler) {
      document.removeEventListener('pointerdown', tracking.interactionHandler, true);
      document.removeEventListener('keydown', tracking.interactionHandler, true);
    }

    multiPanelUserInteractionTracking = null;
  }

  function startMultiPanelUserInteractionTracking(requestId, provider = detectProvider()) {
    if (!requestId || !provider) {
      return;
    }

    stopMultiPanelUserInteractionTracking();

    const tracking = {
      requestId,
      provider,
      timeoutId: null,
      interactionHandler: null
    };

    tracking.interactionHandler = (event) => {
      if (multiPanelUserInteractionTracking !== tracking || !event.isTrusted) {
        return;
      }

      rememberUserFocus();
      postMultiPanelProviderStatus(
        PANELIZE_PROVIDER_USER_INTERACTION,
        tracking.requestId,
        'user-interaction',
        tracking.provider
      );

      if (tracking.provider === 'chatgpt' && chatgptSendTracking?.requestId === tracking.requestId) {
        stopChatgptSendTracking();
      }

      stopMultiPanelUserInteractionTracking();
    };

    document.addEventListener('pointerdown', tracking.interactionHandler, true);
    document.addEventListener('keydown', tracking.interactionHandler, true);

    tracking.timeoutId = setTimeout(() => {
      if (multiPanelUserInteractionTracking !== tracking) {
        return;
      }

      stopMultiPanelUserInteractionTracking();
    }, MULTI_PANEL_USER_INTERACTION_TRACKING_TIMEOUT_MS);

    multiPanelUserInteractionTracking = tracking;
  }

  function findChatgptBusyButton() {
    return document.querySelector(CHATGPT_STOP_BUTTON_SELECTOR);
  }

  function stopChatgptSendTracking({ reportIdle = false } = {}) {
    const tracking = chatgptSendTracking;
    if (!tracking) {
      return;
    }

    if (tracking.observer) {
      tracking.observer.disconnect();
    }

    if (typeof tracking.idleTimerId === 'number') {
      clearTimeout(tracking.idleTimerId);
    }

    if (typeof tracking.noBusyTimerId === 'number') {
      clearTimeout(tracking.noBusyTimerId);
    }

    const { requestId, phase } = tracking;
    chatgptSendTracking = null;

    if (reportIdle) {
      postMultiPanelProviderStatus(PANELIZE_PROVIDER_IDLE, requestId, phase, 'chatgpt');
    }
  }

  function evaluateChatgptSendTrackingState() {
    const tracking = chatgptSendTracking;
    if (!tracking) {
      return;
    }

    if (findChatgptBusyButton()) {
      if (typeof tracking.noBusyTimerId === 'number') {
        clearTimeout(tracking.noBusyTimerId);
        tracking.noBusyTimerId = null;
      }

      if (typeof tracking.idleTimerId === 'number') {
        clearTimeout(tracking.idleTimerId);
        tracking.idleTimerId = null;
      }

      if (tracking.phase !== 'busy') {
        tracking.phase = 'busy';
        postMultiPanelProviderStatus(PANELIZE_PROVIDER_BUSY, tracking.requestId, tracking.phase, 'chatgpt');
      }
      return;
    }

    if (tracking.phase !== 'busy' || typeof tracking.idleTimerId === 'number') {
      return;
    }

    tracking.idleTimerId = setTimeout(() => {
      const currentTracking = chatgptSendTracking;
      if (!currentTracking || currentTracking.requestId !== tracking.requestId) {
        return;
      }

      currentTracking.idleTimerId = null;
      if (findChatgptBusyButton()) {
        evaluateChatgptSendTrackingState();
        return;
      }

      currentTracking.phase = 'idle';
      stopChatgptSendTracking({ reportIdle: true });
    }, CHATGPT_SEND_TRACKING_IDLE_DELAY_MS);
  }

  function startChatgptSendTracking(requestId) {
    if (!requestId) {
      return;
    }

    stopChatgptSendTracking();

    const tracking = {
      requestId,
      phase: 'pending',
      observer: null,
      idleTimerId: null,
      noBusyTimerId: null
    };

    const observerTarget = document.body;
    if (observerTarget) {
      tracking.observer = new MutationObserver(() => {
        if (chatgptSendTracking !== tracking) {
          return;
        }

        if (typeof tracking.idleTimerId === 'number' && findChatgptBusyButton()) {
          clearTimeout(tracking.idleTimerId);
          tracking.idleTimerId = null;
        }

        evaluateChatgptSendTrackingState();
      });

      tracking.observer.observe(observerTarget, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-testid', 'aria-label', 'disabled', 'aria-disabled']
      });
    }

    tracking.noBusyTimerId = setTimeout(() => {
      if (chatgptSendTracking !== tracking || tracking.phase !== 'pending') {
        return;
      }

      stopChatgptSendTracking();
    }, CHATGPT_SEND_TRACKING_NO_BUSY_TIMEOUT_MS);

    chatgptSendTracking = tracking;
    evaluateChatgptSendTrackingState();
  }

  function findGoogleInput(mode) {
    return findFirstVisibleElement(getGoogleInputSelectors(mode));
  }

  function setFormControlValue(element, value) {
    const prototype = element.tagName === 'INPUT'
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    if (typeof element.value === 'string') {
      element.selectionStart = element.selectionEnd = element.value.length;
    }
  }

  function dispatchEditorKeyEvent(element, key, code, modifiers = {}) {
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code,
      keyCode: key === 'Backspace' ? 8 : key === 'a' ? 65 : 13,
      which: key === 'Backspace' ? 8 : key === 'a' ? 65 : 13,
      ctrlKey: modifiers.ctrl || false,
      metaKey: modifiers.meta || false,
      shiftKey: modifiers.shift || false,
      altKey: modifiers.alt || false,
      bubbles: true,
      cancelable: true
    }));
  }

  function clearRichTextInput(provider, element) {
    element.focus();

    if (provider !== 'kimi' && provider !== 'doubao') {
      element.innerHTML = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    dispatchEditorKeyEvent(element, 'a', 'KeyA', { ctrl: true, meta: true });
    document.execCommand('selectAll', false, null);

    setTimeout(() => {
      dispatchEditorKeyEvent(element, 'Backspace', 'Backspace');
      document.execCommand('delete', false, null);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));

      const hasResidualContent = element.textContent.trim().length > 0 ||
        element.querySelector('img, figure, [data-slate-node], [data-slate-string], [data-slate-zero-width]');

      if (provider === 'doubao' && hasResidualContent) {
        element.innerHTML = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 10);
  }

  function buildGoogleSearchFillValue(currentValue, nextText) {
    const normalizedCurrent = (currentValue || '').trim();
    const normalizedNext = (nextText || '').trim();

    if (!normalizedNext) {
      return normalizedCurrent;
    }

    if (googleSearchReplaceOnNextFill || !normalizedCurrent) {
      return normalizedNext;
    }

    return `${normalizedCurrent}${normalizedNext}`.trim();
  }

  function clearGoogleInput(mode) {
    const input = findGoogleInput(mode);
    if (!input) {
      return false;
    }

    setFormControlValue(input, '');

    if (normalizeGoogleProviderMode(mode) === GOOGLE_PROVIDER_MODE_SEARCH) {
      resetGoogleSearchFillSession();
    }

    return true;
  }

  function isElementEnabled(element) {
    return Boolean(
      element &&
      !element.disabled &&
      element.getAttribute('aria-disabled') !== 'true'
    );
  }

  function isProviderSendControlEnabled(provider, element) {
    if (!isElementEnabled(element)) {
      return false;
    }

    if (provider === 'yuanbao') {
      return window.ButtonFinderUtils?.isYuanbaoSendControl(element) === true;
    }

    return !element.classList.contains('disabled');
  }

  function fillGoogleSearchInput(text) {
    const input = findGoogleInput(GOOGLE_PROVIDER_MODE_SEARCH);
    if (!input || !text || typeof text !== 'string') {
      return false;
    }

    const nextValue = buildGoogleSearchFillValue(input.value || '', text);
    setFormControlValue(input, nextValue);
    googleSearchReplaceOnNextFill = false;
    return true;
  }

  function navigateToGoogleSearchResults(query) {
    const normalizedQuery = (query || '').trim();
    if (!normalizedQuery) {
      return false;
    }

    const searchUrl = new URL('/search', window.location.origin);
    searchUrl.searchParams.set('q', normalizedQuery);
    window.location.assign(searchUrl.toString());
    return true;
  }

  function findGoogleFileInput() {
    const fileInputs = querySelectorAllDeep('input[type="file"]');
    let fallbackInput = null;

    for (const input of fileInputs) {
      const accept = (input.getAttribute('accept') || '').toLowerCase();
      if (accept && accept.includes('image') && !accept.includes('.pdf') && !accept.includes('application/pdf')) {
        return input;
      }

      if (!fallbackInput && (!accept || accept.includes('image') || accept.includes('*'))) {
        fallbackInput = input;
      }
    }

    return fallbackInput;
  }

  /**
   * Finds the AI Mode composer "+" menu trigger. Its aria-label is localized
   * ("添加文件、工具并选择模型"), so it is located structurally as the menu button
   * sharing the smallest ancestor with the visible composer textarea. The page
   * also renders an unrelated "添加笔记本" button that must not be clicked.
   */
  function findGoogleComposerMenuTrigger() {
    const composerInput = findDeepFirstVisibleElement(GOOGLE_AI_INPUT_SELECTORS);
    for (let ancestor = composerInput?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const trigger = [...ancestor.querySelectorAll('button[aria-haspopup="menu"]')]
        .find(isVisibleElement);
      if (trigger) {
        return trigger;
      }
    }
    return null;
  }

  function closeGoogleComposerMenu() {
    const trigger = findGoogleComposerMenuTrigger();
    if (trigger?.getAttribute('aria-expanded') !== 'true') {
      return;
    }
    const escape = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', escape));
  }

  async function openGoogleImagePicker() {
    // The current AI Mode composer only renders its hidden file inputs inside
    // the "+" menu ("添加图片" item), so the menu has to be opened first.
    const menuTrigger = findGoogleComposerMenuTrigger();
    if (menuTrigger) {
      if (menuTrigger.getAttribute('aria-expanded') !== 'true') {
        menuTrigger.click();
      }
      await sleep(150);
      const menuInput = findGoogleFileInput();
      if (menuInput) {
        return menuInput;
      }
    }

    const uploadButton = findDeepFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.google);
    if (uploadButton) {
      uploadButton.click();
      await sleep(150);
    }

    let fileInput = findGoogleFileInput();
    if (fileInput) {
      return fileInput;
    }

    const imageMenuAction = findDeepClickableElementByKeywords([
      '更多输入项',
      'add image',
      'upload image',
      'upload file',
      'image',
      'photo',
      '上传图片',
      '上传文件',
      '图片',
      '照片',
      '图像'
    ]);

    if (imageMenuAction) {
      imageMenuAction.click();
      await sleep(150);
    }

    fileInput = findGoogleFileInput();
    if (fileInput) {
      return fileInput;
    }

    const addAction = findDeepClickableElementByKeywords([
      'add',
      'attach',
      'plus',
      '添加',
      '附件'
    ]);

    if (addAction) {
      addAction.click();
      await sleep(150);
    }

    return findGoogleFileInput();
  }

  function assignFilesToInput(fileInput, files) {
    if (!fileInput || !files || files.length === 0) {
      return false;
    }

    try {
      const dataTransfer = new DataTransfer();
      files.forEach(file => dataTransfer.items.add(file));
      fileInput.files = dataTransfer.files;
      return true;
    } catch (error) {
      try {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          value: files
        });
        return true;
      } catch (fallbackError) {
        console.error('[Image Injection] Failed to assign files to input:', fallbackError);
        return false;
      }
    }
  }

  // Find text input element by selector
  function findTextInputElement(selector) {
    if (!selector || typeof selector !== 'string') {
      return null;
    }

    try {
      return document.querySelector(selector);
    } catch (error) {
      console.error('Error finding element:', error);
      return null;
    }
  }

  function getChatgptComposer() {
    const composer = window.PanelizeChatgptComposer;
    if (!composer) {
      console.warn('[Text Injection] ChatGPT composer lookup missing; chatgpt-composer.js did not load');
      return null;
    }
    return composer;
  }

  function getProviderInputSelectors(provider) {
    if (provider === 'chatgpt') {
      return getChatgptComposer()?.EDITOR_SELECTORS || null;
    }
    return PROVIDER_SELECTORS[provider] || null;
  }

  function* findProviderInputs(provider) {
    if (provider === 'chatgpt') {
      yield getChatgptComposer()?.findEditor() || null;
      return;
    }
    for (const selector of PROVIDER_SELECTORS[provider] || []) {
      yield findTextInputElement(selector);
    }
  }

  function findProviderInput(provider) {
    for (const element of findProviderInputs(provider)) {
      if (element) return element;
    }
    return null;
  }

  function clickGoogleSendButton(mode) {
    const normalizedMode = normalizeGoogleProviderMode(mode);

    if (normalizedMode === GOOGLE_PROVIDER_MODE_SEARCH) {
      const input = findGoogleInput(normalizedMode);
      if (!input) {
        console.warn('[Text Injection] Google Search input not found');
        return false;
      }
      const query = (input.value || '').trim();
      if (!query) {
        return false;
      }

      console.log('[Text Injection] Navigating Google Search mode to results page');
      resetGoogleSearchFillSession();
      return navigateToGoogleSearchResults(query);
    }

    const sendButton = findFirstVisibleElement(SEND_BUTTON_SELECTORS.google);
    if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
      sendButton.click();
      return true;
    }

    const input = findGoogleInput(normalizedMode);
    if (!input) {
      return false;
    }

    input.focus();
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });
    input.dispatchEvent(enterEvent);
    return true;
  }

  // Find and click send button
  function clickSendButton(provider, providerMode = null) {
    if (provider === 'google') {
      return clickGoogleSendButton(providerMode);
    }

    if (provider === 'doubao' && window.ButtonFinderUtils?.findButton) {
      const sendButton = window.ButtonFinderUtils.findButton([
        { type: 'css', value: '#flow-end-msg-send' },
        { type: 'css', value: 'button[type="submit"]' },
        { type: 'aria', textKey: 'send' },
        { type: 'text', textKey: 'send' }
      ]);

      if (sendButton && isElementEnabled(sendButton)) {
        sendButton.click();
        return true;
      }
    }

    const selectors = SEND_BUTTON_SELECTORS[provider];
    if (!selectors) {
      console.warn('[Text Injection] No send button selectors for provider:', provider);
      return false;
    }

    console.log('[Text Injection] Attempting to click send button for provider:', provider);

    // ChatGPT's send button lives in the composer's form; searching only there
    // keeps another form's Send (e.g. an inline edit) from being clicked.
    const searchRoot = provider === 'chatgpt'
      ? getChatgptComposer()?.findForm() || document
      : document;

    // Try each selector
    for (const selector of selectors) {
      try {
        const elements = searchRoot.querySelectorAll(selector);
        console.log(`[Text Injection] Found ${elements.length} elements with selector:`, selector);

        for (const element of elements) {
          // Handle SVG elements - try to find parent button
          let targetElement = element;
          if (element.tagName === 'svg' || element.tagName === 'SVG') {
            // Look for parent button or clickable container
            let parent = element.parentElement;
            while (parent && parent !== document.body) {
              if (parent.tagName === 'BUTTON' || 
                  parent.role === 'button' || 
                  parent.classList.contains('send-button-container') ||
                  parent.onclick ||
                  parent.getAttribute('role') === 'button') {
                targetElement = parent;
                break;
              }
              parent = parent.parentElement;
            }
          }
          
          // Check if element or its parent is disabled
          if (isProviderSendControlEnabled(provider, targetElement)) {
            console.log('[Text Injection] Clicking send button:', selector, targetElement);
            if (provider === 'chatglm') {
              // ChatGLM submits from its mousedown handler; HTMLElement.click() skips it.
              targetElement.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                view: window,
                button: 0,
                buttons: 1
              }));
            } else {
              targetElement.click();
            }
            return true;
          } else {
            console.log('[Text Injection] Button found but disabled:', selector);
          }
        }
      } catch (error) {
        console.warn('[Text Injection] Error finding button with selector:', selector, error);
      }
    }

    // Special handling for DeepSeek - trigger Enter key if button not found
    if (provider === 'deepseek') {
      console.log('[Text Injection] DeepSeek send button not found, trying Enter key');
      try {
        const inputSelectors = PROVIDER_SELECTORS.deepseek;
        for (const selector of inputSelectors) {
          const input = document.querySelector(selector);
          if (input) {
            console.log('[Text Injection] Triggering Enter key on DeepSeek input');
            // Trigger multiple events for better compatibility
            const events = [
              new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
              new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
              new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
            ];

            events.forEach(event => input.dispatchEvent(event));
            return true;
          }
        }
      } catch (error) {
        console.warn('[Text Injection] Error in DeepSeek Enter key fallback:', error);
      }
    }

    // Special handling for providers that can fall back to Enter on the editor
    if (
      provider === 'kimi' ||
      provider === 'doubao' ||
      provider === 'qwen-cn' ||
      provider === 'qwen-global' ||
      provider === 'chatglm' ||
      provider === 'zai-global'
    ) {
      console.log('[Text Injection] Provider send button not found, trying Enter key on input:', provider);
      try {
        const inputSelectors = PROVIDER_SELECTORS[provider];
        for (const selector of inputSelectors) {
          const input = document.querySelector(selector);
          if (input) {
            console.log('[Text Injection] Triggering Enter key on provider input:', provider);
            // Focus first
            input.focus();
            // Trigger multiple events for better compatibility
            const events = [
              new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
              new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
              new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
            ];

            events.forEach(event => input.dispatchEvent(event));
            return true;
          }
        }
      } catch (error) {
        console.warn('[Text Injection] Error in provider Enter key fallback:', provider, error);
      }
    }

    console.warn('[Text Injection] Send button not found or disabled for:', provider);
    console.warn('[Text Injection] Available buttons:', document.querySelectorAll('button'));
    return false;
  }

  // Special handler for Google to create "new search"
  function handleGoogleNewSearch(mode) {
    const normalizedMode = normalizeGoogleProviderMode(mode);
    console.log('[Text Injection] Handling Google new search for mode:', normalizedMode);
    resetGoogleSearchFillSession();
    window.location.href = normalizedMode === GOOGLE_PROVIDER_MODE_SEARCH
      ? 'https://www.google.com/'
      : 'https://www.google.com/search?udm=50';
    return true;
  }

  function isTemporaryChatControlActive(element) {
    if (!element) {
      return false;
    }

    if (element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-checked') === 'true') {
      return true;
    }

    const dataState = (element.dataset?.state || '').toLowerCase();
    if (dataState === 'active' || dataState === 'on' || dataState === 'checked' || dataState === 'selected') {
      return true;
    }

    const classTokens = element.classList
      ? [...element.classList].map(token => token.toLowerCase())
      : String(element.className || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

    return ['active', 'selected', 'checked', 'toggled', 'enabled', 'on'].some(token => classTokens.includes(token));
  }

  function isGeminiTemporaryChatEnabled(control = null) {
    const button = control ||
      document.querySelector('button[data-test-id="temp-chat-button"]') ||
      document.querySelector('button[aria-label="Temporary chat"]');

    if (!button) {
      return false;
    }

    return button.classList.contains('temp-chat-on') || isTemporaryChatControlActive(button);
  }

  function isTemporaryChatAlreadyEnabled(provider, control = null) {
    const currentUrl = new URL(window.location.href);

    switch (provider) {
      case 'chatgpt':
        return currentUrl.searchParams.get('temporary-chat') === 'true';
      case 'claude':
        return currentUrl.searchParams.has('incognito');
      case 'grok':
        return currentUrl.hash === '#private' || isTemporaryChatControlActive(control);
      case 'gemini': {
        return isGeminiTemporaryChatEnabled(control);
      }
      case 'yuanbao':
        return (
          currentUrl.searchParams.get('chatMode') === 'temp' ||
          /^(Exit Temporary Chat|退出临时对话|退出臨時對話)$/
            .test(control?.getAttribute('aria-label') || '')
        );
      default:
        return false;
    }
  }

  function enableTemporaryChat(provider) {
    if (provider !== 'yuanbao') {
      return activateTemporaryChat(provider);
    }
    if (yuanbaoTemporaryChatActivation) {
      return yuanbaoTemporaryChatActivation;
    }

    const activation = activateTemporaryChat(provider);
    yuanbaoTemporaryChatActivation = activation;
    const clearActivation = () => {
      if (yuanbaoTemporaryChatActivation === activation) {
        yuanbaoTemporaryChatActivation = null;
      }
    };
    activation.then(clearActivation, clearActivation);
    return activation;
  }

  async function activateTemporaryChat(provider) {
    const selectors = TEMP_CHAT_BUTTON_SELECTORS[provider];
    if (!selectors || selectors.length === 0) {
      console.log('[Temporary Chat] Provider does not support temporary chat:', provider);
      return false;
    }

    if (isTemporaryChatAlreadyEnabled(provider)) {
      postTemporaryChatEnabled(provider);
      return true;
    }

    const deadline = Date.now() + TEMP_CHAT_POLL_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const button = findDeepFirstVisibleElement(selectors) || findFirstVisibleElement(selectors);
      if (isTemporaryChatAlreadyEnabled(provider, button)) {
        postTemporaryChatEnabled(provider);
        return true;
      }

      if (button && isElementEnabled(button)) {
        if (
          provider === 'yuanbao' &&
          Date.now() - yuanbaoTemporaryChatLastClickAt < YUANBAO_TEMP_CHAT_CLICK_COOLDOWN_MS
        ) {
          await sleep(TEMP_CHAT_POLL_INTERVAL_MS);
          continue;
        }
        if (provider === 'yuanbao') {
          // Parent retries for five seconds; never toggle this control twice in that cycle.
          yuanbaoTemporaryChatLastClickAt = Date.now();
        }
        button.click();
        if (provider !== 'yuanbao') {
          postTemporaryChatEnabled(provider);
          return true;
        }

        const confirmationDeadline = Date.now() + TEMP_CHAT_POLL_TIMEOUT_MS;
        while (Date.now() <= confirmationDeadline) {
          const currentControl = findDeepFirstVisibleElement(selectors) ||
            findFirstVisibleElement(selectors);
          if (isTemporaryChatAlreadyEnabled(provider, currentControl)) {
            postTemporaryChatEnabled(provider);
            return true;
          }
          await sleep(TEMP_CHAT_POLL_INTERVAL_MS);
        }
        return false;
      }

      await sleep(TEMP_CHAT_POLL_INTERVAL_MS);
    }

    console.log('[Temporary Chat] Temporary chat control not found for provider:', provider);
    return false;
  }

  // Links in chat content (e.g. Claude citations to news.sina.com.cn) can match
  // loose href selectors; a new-chat control never leaves the provider's origin.
  function isSameOriginNewChatCandidate(element) {
    const anchor = element.closest('a[href]');
    if (!anchor) {
      return true;
    }

    try {
      return new URL(anchor.getAttribute('href'), window.location.href).origin === window.location.origin;
    } catch (error) {
      return false;
    }
  }

  // Find and click new chat button
  function clickNewChatButton(provider, providerMode = null) {
    // Special handling for Google
    if (provider === 'google') {
      return handleGoogleNewSearch(providerMode);
    }

    const selectors = NEW_CHAT_BUTTON_SELECTORS[provider];
    if (!selectors) {
      console.warn('[Text Injection] No new chat button selectors for provider:', provider);
      return false;
    }

    // Try to find and click button
    const button = findDeepFirstVisibleElement(selectors, isSameOriginNewChatCandidate) ||
      findFirstVisibleElement(selectors, isSameOriginNewChatCandidate);
    if (button) {
      console.log('[Text Injection] Clicking new chat button via visible selector match');
      button.click();
      return true;
    }

    // Fallback: Try to find any link or button containing "new" text
    try {
      const allButtons = document.querySelectorAll('button, a, div[role="button"]');
      for (const elem of allButtons) {
        if (!isSameOriginNewChatCandidate(elem)) {
          continue;
        }

        const text = (elem.textContent || '').toLowerCase();
        const ariaLabel = (elem.getAttribute('aria-label') || '').toLowerCase();
        const href = elem.getAttribute('href') || '';

        if (text.includes('new chat') ||
          text.includes('new conversation') ||
          text.includes('start new') ||
          text.includes('新建会话') ||
          text.includes('新建对话') ||
          text.includes('开启新对话') ||
          ariaLabel.includes('new chat') ||
          ariaLabel.includes('new conversation') ||
          ariaLabel.includes('start new') ||
          ariaLabel.includes('新建会话') ||
          ariaLabel.includes('新建对话') ||
          (href === '/' && elem.closest('nav, aside'))) {
          console.log('[Text Injection] Found new chat button by text search');
          elem.click();
          return true;
        }
      }
    } catch (error) {
      console.warn('[Text Injection] Error in text-based button search:', error);
    }

    // Ultimate fallback: navigate to new chat URL
    const fallbackUrl = NEW_CHAT_URLS[provider];
    if (fallbackUrl) {
      console.log('[Text Injection] Using fallback URL for new chat:', fallbackUrl);
      if (fallbackUrl.startsWith('http')) {
        window.location.href = fallbackUrl;
      } else {
        window.location.href = window.location.origin + fallbackUrl;
      }
      return true;
    }

    console.warn('[Text Injection] New chat button not found for:', provider);
    return false;
  }

  // Inject text into an element (textarea or contenteditable)
  function injectTextIntoElement(element, text, provider = null) {
    if (!element || !text || typeof text !== 'string' || text.trim() === '') {
      return false;
    }

    try {
      const isTextarea = element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';
      const isContentEditable = element.isContentEditable || element.getAttribute('contenteditable') === 'true';

      if (!isTextarea && !isContentEditable) {
        console.warn('Element is not a textarea or contenteditable:', element);
        return false;
      }

      if (isTextarea) {
        // For textarea/input elements
        const currentValue = element.value || '';
        const newValue = currentValue + text;

        setFormControlValue(element, newValue);
      } else {
        // For contenteditable elements - append text without clearing existing content
        element.focus();

        // Move cursor to end first
        try {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false); // Collapse to end
          selection.removeAllRanges();
          selection.addRange(range);
        } catch (e) {
          // Ignore selection errors in cross-origin context
        }

        if (provider === 'qwen-cn') {
          // Qwen China uses Slate's beforeinput handler as its source of truth.
          // A DOM-only insertion is visible but leaves the send control disabled.
          const beforeInputEvent = new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: text,
            bubbles: true,
            cancelable: true,
            composed: true
          });

          if (!element.dispatchEvent(beforeInputEvent)) {
            return true;
          }
        }

        // Use execCommand insertText to append - works well with ProseMirror/Lexical/Quill
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, text);
        } catch (e) {
          // execCommand not available in some contexts
        }

        if (!inserted) {
          // Fallback: manually append text node
          const textNode = document.createTextNode(text);
          element.appendChild(textNode);
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Ensure cursor is at the end after insertion
        try {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        } catch (e) {
          // Ignore selection errors in cross-origin context
        }
      }

      return true;
    } catch (error) {
      console.error('Error injecting text:', error);
      return false;
    }
  }

  function handleGoogleTextInjection(text, autoSubmit, providerMode) {
    const normalizedMode = normalizeGoogleProviderMode(providerMode);

    if (normalizedMode === GOOGLE_PROVIDER_MODE_SEARCH) {
      const success = fillGoogleSearchInput(text);
      if (success && autoSubmit) {
        setTimeout(() => clickGoogleSendButton(normalizedMode), 100);
      }
      return success;
    }

    const input = findGoogleInput(normalizedMode);
    if (!input) {
      return false;
    }

    const success = injectTextIntoElement(input, text);
    if (success && autoSubmit) {
      setTimeout(() => clickGoogleSendButton(normalizedMode), 500);
    }
    return success;
  }

  // ===== Image Injection Functions =====

  // Helper function to inject text into provider's input field
  function inputEndsWithText(element, text) {
    const isFormControl = element?.tagName === 'TEXTAREA' || element?.tagName === 'INPUT';
    const currentText = isFormControl ? element.value : element?.textContent;
    return typeof currentText === 'string' && currentText.endsWith(text);
  }

  function injectText(
    provider,
    text,
    autoSubmit,
    providerMode = null,
    { skipIfAlreadyPresent = false } = {}
  ) {
    if (provider === 'google') {
      const input = findGoogleInput(providerMode);
      if (skipIfAlreadyPresent && inputEndsWithText(input, text)) {
        return true;
      }
      return handleGoogleTextInjection(text, autoSubmit, providerMode);
    }

    if (!getProviderInputSelectors(provider)) {
      console.warn('[Text Injection] No selectors for provider:', provider);
      return false;
    }

    for (const element of findProviderInputs(provider)) {
      if (!element) continue;
      if (skipIfAlreadyPresent && inputEndsWithText(element, text)) {
        return true;
      }
      const success = injectTextIntoElement(element, text, provider);
      if (success) {
        console.log('[Text Injection] Text injected via injectText helper for', provider);
        if (autoSubmit) {
          // Use longer delay for providers whose composer state updates asynchronously
          const delay = SLOW_COMPOSER_PROVIDERS.has(provider) ? 800 : 500;
          setTimeout(() => clickSendButton(provider, providerMode), delay);
        }
        return true;
      }
    }

    console.warn('[Text Injection] No input element found for provider:', provider);
    return false;
  }

  // Handle image injection message
  async function handleImageInjection(event) {
    const { text, images, autoSubmit, requestId, retry = false } = event.data;
    const provider = detectProvider();
    const providerMode = provider === 'google'
      ? normalizeGoogleProviderMode(event.data.providerMode)
      : null;

    if (!provider) {
      console.warn('[Image Injection] Provider not detected');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND, []);
    }

    if (provider === 'google' && providerMode === GOOGLE_PROVIDER_MODE_SEARCH) {
      console.warn('[Image Injection] Google Search mode does not support image injection, falling back to text only');
      if (text && text.trim()) {
        handleGoogleTextInjection(text, autoSubmit, providerMode);
      }
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.UNSUPPORTED, []);
    }

    if (!PROVIDER_IMAGE_SUPPORT[provider]) {
      console.warn('[Image Injection] Provider does not support images:', provider);
      // For providers that don't support images, just inject text
      if (text) {
        injectText(provider, text, autoSubmit, providerMode);
      }
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.UNSUPPORTED, []);
    }

    if (!images || images.length === 0) {
      if (retry && text && text.trim()) {
        const textInjected = injectText(
          provider,
          text,
          autoSubmit,
          providerMode,
          { skipIfAlreadyPresent: true }
        );
        return textInjected
          ? createImageInjectionSuccess([])
          : createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND, []);
      }
      console.warn('[Image Injection] No images provided');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR, []);
    }

    console.log(`[Image Injection] Injecting ${images.length} images to ${provider}`);

    try {
      // Fills protect the unified input's focus too, so report a click in
      // the panel to hand focus back to the user.
      if (requestId) {
        startMultiPanelUserInteractionTracking(requestId, provider);
      } else {
        stopMultiPanelUserInteractionTracking();
      }

      if (provider === 'chatgpt' && autoSubmit && requestId) {
        startChatgptSendTracking(requestId);
      }

      const succeededImageIds = [];
      const imageInjectionResults = [];

      // Inject images first
      for (const image of images) {
        const result = await injectSingleImage(provider, image, { retry });
        imageInjectionResults.push(result);
        if (result.ok) {
          if (image.id && typeof image.id === 'string') {
            succeededImageIds.push(image.id);
          }
        } else {
          break;
        }
        // Wait a bit between images
        await sleep(200);
      }

      const allImagesInjected = imageInjectionResults.length === images.length &&
        imageInjectionResults.every(result => result.ok);
      if (!allImagesInjected) {
        console.warn('[Image Injection] One or more images failed to inject for:', provider);
      }

      // Wait for images to upload
      await sleep(500);

      // Then inject text if provided
      let textInjected = true;
      if (text && text.trim()) {
        await sleep(300);
        textInjected = injectText(
          provider,
          text,
          autoSubmit && allImagesInjected,
          providerMode,
          { skipIfAlreadyPresent: retry }
        );
      } else if (autoSubmit) {
        if (!allImagesInjected) {
          console.warn('[Image Injection] Skipping auto-submit because image injection failed for:', provider);
          const firstFailure = imageInjectionResults.find(result => !result.ok);
          return createImageInjectionFailure(
            firstFailure?.reason || IMAGE_INJECTION_REASONS.INJECTION_ERROR,
            succeededImageIds
          );
        }
        // If no text but autoSubmit is true, click send button
        await sleep(300);
        clickSendButton(provider, providerMode);
      }

      if (!allImagesInjected) {
        const firstFailure = imageInjectionResults.find(result => !result.ok);
        return createImageInjectionFailure(
          firstFailure?.reason || IMAGE_INJECTION_REASONS.INJECTION_ERROR,
          succeededImageIds
        );
      }

      if (!textInjected) {
        return createImageInjectionFailure(
          IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND,
          succeededImageIds
        );
      }

      return createImageInjectionSuccess(succeededImageIds);
    } catch (error) {
      console.error('[Image Injection] Error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR, []);
    }
  }

  function createImageInjectionSuccess(succeededImageIds = []) {
    return { ok: true, succeededImageIds };
  }

  function createImageInjectionFailure(reason, succeededImageIds = []) {
    return { ok: false, reason, succeededImageIds };
  }

  function normalizeImageInjectionResult(result) {
    if (result && typeof result.ok === 'boolean') {
      return result;
    }

    return result
      ? createImageInjectionSuccess()
      : createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
  }

  // Inject a single image to the provider using provider-specific strategy
  async function injectSingleImage(provider, imageData, { retry = false } = {}) {
    console.log('[Image Injection] Injecting image to', provider);

    // Use provider-specific strategies
    let result;
    switch (provider) {
      case 'chatgpt':
        result = await injectImageToChatGPT(imageData);
        break;
      case 'claude':
        result = await injectImageToClaude(imageData);
        break;
      case 'gemini':
        result = await injectImageToGemini(imageData);
        break;
      case 'grok':
        result = await injectImageToGrok(imageData);
        break;
      case 'deepseek':
        result = await injectImageToDeepSeek(imageData);
        break;
      case 'kimi':
        result = await injectImageToKimi(imageData, { retry });
        break;
      case 'doubao':
        result = await injectImageToDoubao(imageData);
        break;
      case 'qwen-cn':
      case 'qwen-global':
        result = await injectImageToQwen(provider, imageData);
        break;
      case 'chatglm':
        result = await injectImageToChatGLM(imageData);
        break;
      case 'zai-global':
        result = await injectImageToZaiGlobal(imageData);
        break;
      case 'yuanbao':
        result = await injectImageToYuanbao(imageData, { retry });
        break;
      case 'google':
        result = await injectImageToGoogle(imageData);
        break;
      default:
        // Fallback: try file input first, then drag-drop
        if (await tryFileInputUpload(provider, imageData)) {
          result = true;
          break;
        }
        result = await tryDragDropUpload(provider, imageData);
        break;
    }

    return normalizeImageInjectionResult(result);
  }

  function findClosestAncestorContaining(element, selector, maxDepth = 8) {
    let current = element;

    for (let depth = 0; current && depth <= maxDepth; depth++) {
      if (current === document.body || current === document.documentElement) {
        return null;
      }
      try {
        if (current.querySelector?.(selector)) {
          return current;
        }
      } catch (error) {
        console.warn('[Image Injection] Invalid scoped selector:', selector, error);
        return null;
      }
      current = current.parentElement;
    }

    return null;
  }

  function findVisibleElementByExactText(selector, expectedTexts) {
    const normalizedTexts = expectedTexts.map(text => text.trim().toLowerCase());

    for (const element of document.querySelectorAll(selector)) {
      const text = (element.textContent || '').trim().toLowerCase();
      if (normalizedTexts.includes(text) && isVisibleElement(element)) {
        return element;
      }
    }

    return null;
  }

  function acceptsImageFiles(fileInput) {
    const accept = (fileInput?.getAttribute('accept') || '').toLowerCase();
    return !accept || accept.includes('image/') || [
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.apng'
    ].some(extension => accept.includes(extension));
  }

  async function createImageFile(imageData) {
    const blob = await dataUrlToBlob(imageData.dataUrl);
    return new File([blob], imageData.name, { type: imageData.type });
  }

  function dispatchFileInputEvents(fileInput) {
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dispatchDragEventsToWakeInput(target, file) {
    if (!target) {
      return;
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    ['dragenter', 'dragover', 'dragleave'].forEach(type => {
      target.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer
      }));
    });
  }

  async function waitForFileInput(findFileInput, timeoutMs = 1000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const fileInput = findFileInput();
      if (fileInput) {
        return fileInput;
      }
      await sleep(100);
    }

    return null;
  }

  async function waitForPreviewIncrease(getCount, previousCount, timeoutMs = IMAGE_UPLOAD_PREVIEW_TIMEOUT_MS) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (getCount() > previousCount) {
        return true;
      }
      await sleep(100);
    }

    return false;
  }

  function countFilenamePreviewEvidence(root, fileName) {
    if (!root) {
      return 0;
    }

    const normalizedName = (fileName || '').trim().toLowerCase();
    const evidence = new Set();

    root.querySelectorAll(
      'img[alt], button, [role="button"], [aria-label], [title], [data-file-name], [data-filename]'
    ).forEach(element => {
      const alt = (element.getAttribute('alt') || '').trim().toLowerCase();
      const fileNameData = (
        element.getAttribute('data-file-name') ||
        element.getAttribute('data-filename') ||
        ''
      ).trim().toLowerCase();
      const accessibleText = getElementAccessibleText(element);
      if (
        alt === normalizedName ||
        fileNameData === normalizedName ||
        accessibleText.includes(normalizedName)
      ) {
        evidence.add(element.closest('button, [role="button"]') || element);
      }
    });

    return evidence.size;
  }

  function getProviderImageKey(provider, imageData) {
    const imageKey = imageData?.id && typeof imageData.id === 'string'
      ? imageData.id
      : `${imageData?.name || ''}\u0000${imageData?.type || ''}\u0000${imageData?.dataUrl || ''}`;
    return `${provider}\u0000${imageKey}`;
  }

  async function reconcilePendingProviderImage(provider, imageData, countCompletedPreviews) {
    const imageKey = getProviderImageKey(provider, imageData);
    const pendingUpload = pendingProviderImageUploads.get(imageKey);
    if (!pendingUpload) {
      return null;
    }

    if (countCompletedPreviews() > pendingUpload.previousCount) {
      pendingProviderImageUploads.delete(imageKey);
      return createImageInjectionSuccess();
    }

    if (Date.now() - pendingUpload.startedAt >= 30000) {
      pendingProviderImageUploads.delete(imageKey);
      return null;
    }

    const accepted = await waitForPreviewIncrease(
      countCompletedPreviews,
      pendingUpload.previousCount
    );
    if (accepted) {
      pendingProviderImageUploads.delete(imageKey);
      return createImageInjectionSuccess();
    }

    return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
  }

  function rememberPendingProviderImage(provider, imageData, previousCount) {
    pendingProviderImageUploads.set(getProviderImageKey(provider, imageData), {
      previousCount,
      startedAt: Date.now()
    });
  }

  function getYuanbaoComposer() {
    const editor = document.querySelector(
      '.chat-command-editor-specail .ql-editor[contenteditable="true"]'
    ) || document.querySelector('.ql-editor[contenteditable="true"][data-placeholder]');
    return findClosestAncestorContaining(editor, '[data-new-input-control="add-tools-trigger"]') ||
      editor?.closest('[data-input-editor-area="true"]')?.parentElement ||
      editor?.parentElement?.parentElement ||
      null;
  }

  function findYuanbaoFileInput() {
    return [...document.querySelectorAll('input[type="file"]')]
      .find(input => input.multiple && acceptsImageFiles(input)) || null;
  }

  function countYuanbaoCompletedPreviews(fileName) {
    const normalizedName = (fileName || '').trim().toLowerCase();
    return [...document.querySelectorAll('img[alt]')].filter(image => {
      const source = image.getAttribute('src') || '';
      const alt = (image.getAttribute('alt') || '').trim().toLowerCase();
      return (
        alt === normalizedName &&
        /^https:\/\//.test(source) &&
        image.closest('[class*="FileList_inputFileListItem"]')
      );
    }).length;
  }

  async function openYuanbaoImagePicker(composer) {
    const addButton = composer?.querySelector('[data-new-input-control="add-tools-trigger"]') ||
      findFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.yuanbao);
    if (!addButton) {
      return null;
    }

    addButton.click();
    await sleep(100);

    const uploadAction = findVisibleElementByExactText(
      'button, [role="menuitem"]',
      ['Upload Image', '上传图片']
    );
    if (!uploadAction) {
      return null;
    }

    uploadAction.click();
    return waitForFileInput(findYuanbaoFileInput, 1000);
  }

  async function injectImageToYuanbao(imageData, { retry = false } = {}) {
    try {
      const composer = getYuanbaoComposer();
      if (!composer) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const countCompleted = () => countYuanbaoCompletedPreviews(imageData.name);
      if (retry) {
        const reconciled = await reconcilePendingProviderImage(
          'yuanbao',
          imageData,
          countCompleted
        );
        if (reconciled) {
          return reconciled;
        }
      }

      let fileInput = findYuanbaoFileInput();
      if (!fileInput) {
        fileInput = await openYuanbaoImagePicker(composer);
      }
      if (!fileInput) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const previousCount = countCompleted();
      const file = await createImageFile(imageData);
      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }
      dispatchFileInputEvents(fileInput);

      const accepted = await waitForPreviewIncrease(countCompleted, previousCount);
      if (accepted) {
        pendingProviderImageUploads.delete(getProviderImageKey('yuanbao', imageData));
        return createImageInjectionSuccess();
      }

      rememberPendingProviderImage('yuanbao', imageData, previousCount);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    } catch (error) {
      console.error('[Image Injection] Yuanbao error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  function getGrokComposer() {
    const editor = document.querySelector('[data-testid="chat-input"] [contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][aria-label="Ask Grok anything"]');
    return editor?.closest('form') || null;
  }

  function findGrokFileInput(composer) {
    return [...(composer?.querySelectorAll('input[type="file"]') || [])]
      .find(input => acceptsImageFiles(input)) || null;
  }

  function countGrokAttachmentPreviews(composer, fileName) {
    const attachmentList = composer?.querySelector('[role="list"][aria-label="Conversation attachments"]');
    const attachmentListCount = attachmentList?.children.length || 0;

    // Grok may render the visible attachment chip in a portal outside the form.
    // The filename is exposed as the preview button/image accessible name.
    const filenameEvidence = countFilenamePreviewEvidence(document, fileName);
    return Math.max(attachmentListCount, filenameEvidence);
  }

  async function injectImageToGrok(imageData) {
    try {
      const composer = getGrokComposer();
      if (!composer) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const attachButton = composer.querySelector('button[aria-label="Attach"], button[data-testid="attach-button"]');
      if (!attachButton) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const file = await createImageFile(imageData);
      let fileInput = findGrokFileInput(composer);
      if (!fileInput) {
        // Grok ignores synthetic clicks when deciding whether to open its
        // attachment menu. Its native composer file input is still usable;
        // only use synthetic UI events to wake a lazily mounted input.
        attachButton.click();
        dispatchDragEventsToWakeInput(composer, file);
        fileInput = await waitForFileInput(() => findGrokFileInput(composer));
      }
      if (!fileInput) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const previousCount = countGrokAttachmentPreviews(composer, imageData.name);
      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }
      dispatchFileInputEvents(fileInput);

      const accepted = await waitForPreviewIncrease(
        () => countGrokAttachmentPreviews(composer, imageData.name),
        previousCount
      );
      return accepted
        ? createImageInjectionSuccess()
        : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    } catch (error) {
      console.error('[Image Injection] Grok error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  function getDeepSeekComposer() {
    const editor = document.querySelector('textarea[placeholder="Message DeepSeek"]') ||
      document.querySelector('textarea.ds-scroll-area') ||
      document.querySelector('textarea');
    return findClosestAncestorContaining(editor, 'input[type="file"]');
  }

  function findDeepSeekFileInput(composer) {
    return [...(composer?.querySelectorAll('input[type="file"]') || [])]
      .find(input => input.multiple && acceptsImageFiles(input)) || null;
  }

  async function injectImageToDeepSeek(imageData) {
    try {
      const composer = getDeepSeekComposer();
      if (!composer) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const file = await createImageFile(imageData);
      let fileInput = findDeepSeekFileInput(composer);
      if (!fileInput) {
        dispatchDragEventsToWakeInput(composer, file);
        fileInput = await waitForFileInput(() => findDeepSeekFileInput(composer));
      }
      if (!fileInput) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      // DeepSeek renders attachment previews beside the composer controls rather
      // than consistently inside the nearest file-input ancestor.
      const previousCount = countFilenamePreviewEvidence(document, imageData.name);
      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }
      dispatchFileInputEvents(fileInput);

      const accepted = await waitForPreviewIncrease(
        () => countFilenamePreviewEvidence(document, imageData.name),
        previousCount
      );
      return accepted
        ? createImageInjectionSuccess()
        : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    } catch (error) {
      console.error('[Image Injection] DeepSeek error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  function getKimiComposer() {
    const editor = document.querySelector('.chat-input-editor[contenteditable="true"]') ||
      document.querySelector('.chat-input-editor');
    return editor?.closest('.chat-editor') || editor?.closest('#chat-box') || null;
  }

  function countKimiAttachmentPreviews(composer) {
    // Kimi promotes the thumbnail to `success` only after its upload API has
    // returned a signed remote image URL. Error thumbnails use a different
    // status class and must not be acknowledged as successful attachments.
    return composer?.querySelectorAll(
      '.image-thumbnail.success .image-wrapper.image-detail img.image-main'
    ).length || 0;
  }

  function countKimiPendingAttachmentPreviews(composer) {
    return composer?.querySelectorAll('.image-thumbnail.loading').length || 0;
  }

  function getKimiImageKey(imageData) {
    if (imageData && imageData.id && typeof imageData.id === 'string') {
      return imageData.id;
    }
    return `${imageData?.name || ''}\u0000${imageData?.type || ''}\u0000${imageData?.dataUrl || ''}`;
  }

  function getKimiThumbnailState(thumbnail) {
    if (!thumbnail?.isConnected) {
      return 'missing';
    }
    if (
      thumbnail.matches('.image-thumbnail.success') &&
      thumbnail.querySelector('.image-wrapper.image-detail img.image-main')
    ) {
      return 'success';
    }
    return thumbnail.matches('.image-thumbnail.loading') ? 'loading' : 'failed';
  }

  async function waitForTrackedKimiThumbnail(thumbnail) {
    const start = Date.now();

    while (Date.now() - start < IMAGE_UPLOAD_PREVIEW_TIMEOUT_MS) {
      const state = getKimiThumbnailState(thumbnail);
      if (state !== 'loading') {
        return state;
      }
      await sleep(100);
    }

    return getKimiThumbnailState(thumbnail);
  }

  async function reconcilePendingKimiImage(imageKey, composer) {
    const pendingUpload = pendingKimiImageUploads.get(imageKey);
    if (!pendingUpload) {
      return null;
    }

    // Kimi replaces the original loading thumbnail during upload finalization.
    // The verified success-count increase preserves reconciliation across that
    // replacement while the retry flag keeps it scoped to the failed Fill.
    if (countKimiAttachmentPreviews(composer) > pendingUpload.previousSuccessCount) {
      pendingKimiImageUploads.delete(imageKey);
      return createImageInjectionSuccess();
    }

    const state = await waitForTrackedKimiThumbnail(pendingUpload.thumbnail);
    if (
      state === 'success' ||
      countKimiAttachmentPreviews(composer) > pendingUpload.previousSuccessCount
    ) {
      pendingKimiImageUploads.delete(imageKey);
      return createImageInjectionSuccess();
    }
    if (state === 'loading') {
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    }

    pendingKimiImageUploads.delete(imageKey);
    return null;
  }

  async function waitForKimiPendingPreview(composer, previousSuccessCount) {
    const start = Date.now();

    while (Date.now() - start < IMAGE_UPLOAD_PREVIEW_TIMEOUT_MS) {
      if (countKimiAttachmentPreviews(composer) > previousSuccessCount) {
        return true;
      }
      if (countKimiPendingAttachmentPreviews(composer) === 0) {
        return false;
      }
      await sleep(100);
    }

    return false;
  }

  /**
   * Returns Kimi's native upload input. The current composer keeps a hidden
   * multi-file input (no accept attribute) next to the toolkit trigger, and its
   * "Add files & images" menu item only forwards a click to it. Older builds
   * rendered the input inside a "文件和图片" label in the toolkit menu.
   */
  async function findKimiFileInput(composer) {
    const composerInput = composer.querySelector('input[type="file"]');
    if (composerInput) {
      return composerInput;
    }

    const toolkitTrigger = composer.querySelector('.toolkit-trigger-btn');
    if (!toolkitTrigger) {
      return null;
    }

    let uploadEntry = findVisibleElementByExactText('label', ['文件和图片', 'Files and images']);
    if (!uploadEntry) {
      toolkitTrigger.click();
      await sleep(100);
      uploadEntry = findVisibleElementByExactText('label', ['文件和图片', 'Files and images']);
    }
    return uploadEntry?.querySelector('input[type="file"]') || null;
  }

  async function injectImageToKimi(imageData, { retry = false } = {}) {
    try {
      const composer = getKimiComposer();
      if (!composer) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      // A Kimi upload can finish after the first Fill has already timed out.
      // Reconcile the exact thumbnail created by that attempt before retrying.
      const imageKey = getKimiImageKey(imageData);
      if (retry) {
        const reconciledResult = await reconcilePendingKimiImage(imageKey, composer);
        if (reconciledResult) {
          return reconciledResult;
        }
      } else {
        pendingKimiImageUploads.clear();
      }

      const previousCount = countKimiAttachmentPreviews(composer);
      if (countKimiPendingAttachmentPreviews(composer) > 0) {
        if (pendingKimiImageUploads.has(imageKey)) {
          const pendingAccepted = await waitForKimiPendingPreview(composer, previousCount);
          return pendingAccepted
            ? createImageInjectionSuccess()
            : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
        }
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
      }

      const fileInput = await findKimiFileInput(composer);
      if (!fileInput) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.UNSUPPORTED);
      }
      if (!acceptsImageFiles(fileInput)) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const file = await createImageFile(imageData);
      const previousThumbnails = new Set(composer.querySelectorAll('.image-thumbnail'));
      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }
      dispatchFileInputEvents(fileInput);

      const accepted = await waitForPreviewIncrease(
        () => countKimiAttachmentPreviews(composer),
        previousCount
      );
      if (accepted) {
        pendingKimiImageUploads.delete(imageKey);
        return createImageInjectionSuccess();
      }

      const newThumbnail = [...composer.querySelectorAll('.image-thumbnail')]
        .find(thumbnail => !previousThumbnails.has(thumbnail));
      const thumbnailState = getKimiThumbnailState(newThumbnail);
      if (thumbnailState === 'success') {
        pendingKimiImageUploads.delete(imageKey);
        return createImageInjectionSuccess();
      }
      if (thumbnailState === 'loading') {
        pendingKimiImageUploads.set(imageKey, {
          thumbnail: newThumbnail,
          previousSuccessCount: previousCount
        });
      }
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    } catch (error) {
      console.error('[Image Injection] Kimi error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  // ChatGPT-specific image injection
  async function injectImageToChatGPT(imageData) {
    try {
      // ChatGPT: find and use file input directly
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        const blob = await dataUrlToBlob(imageData.dataUrl);
        const file = new File([blob], imageData.name, { type: imageData.type });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[Image Injection] ChatGPT: File input triggered');
        return true;
      }
      console.warn('[Image Injection] ChatGPT: No file input found');
      return false;
    } catch (error) {
      console.error('[Image Injection] ChatGPT error:', error);
      return false;
    }
  }

  // Claude-specific image injection
  async function injectImageToClaude(imageData) {
    try {
      // Claude: find the file input (it's usually hidden)
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        const blob = await dataUrlToBlob(imageData.dataUrl);
        const file = new File([blob], imageData.name, { type: imageData.type });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[Image Injection] Claude: File input triggered');
        return true;
      }

      // Try clicking the attachment button first
      const attachBtnSelectors = UPLOAD_BUTTON_SELECTORS.claude;
      for (const selector of attachBtnSelectors) {
        const btn = document.querySelector(selector);
        if (btn) {
          btn.click();
          await sleep(300);
          // Now try to find and use the file input
          const input = document.querySelector('input[type="file"]');
          if (input) {
            const blob = await dataUrlToBlob(imageData.dataUrl);
            const file = new File([blob], imageData.name, { type: imageData.type });
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            input.files = dataTransfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('[Image Injection] Claude: File input triggered after button click');
            return true;
          }
        }
      }

      console.warn('[Image Injection] Claude: No file input found');
      return false;
    } catch (error) {
      console.error('[Image Injection] Claude error:', error);
      return false;
    }
  }

  // Gemini-specific image injection
  async function injectImageToGemini(imageData) {
    try {
      console.log('[Image Injection] Gemini: Starting image injection');

      // Strategy: Simulate paste event with image
      // Find the editor (Quill editor or contenteditable)
      const editorSelectors = ['.ql-editor', '[contenteditable="true"]', 'div[contenteditable]'];
      let editor = null;
      
      for (const selector of editorSelectors) {
        editor = querySelectorDeep(selector);
        if (editor) {
          console.log('[Image Injection] Gemini: Found editor:', selector);
          break;
        }
      }
      
      if (!editor) {
        console.warn('[Image Injection] Gemini: Editor not found');
        return false;
      }

      // Convert dataUrl to blob
      const blob = await dataUrlToBlob(imageData.dataUrl);
      const file = new File([blob], imageData.name, { type: imageData.type });
      
      // Create DataTransfer for clipboard data
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      
      // Focus the editor first
      editor.focus();
      
      // Simulate paste event with the image
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
      });
      
      editor.dispatchEvent(pasteEvent);
      console.log('[Image Injection] Gemini: Paste event dispatched');
      
      // Also try drag-drop as fallback if paste doesn't work
      await sleep(100);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dataTransfer
      });
      editor.dispatchEvent(dropEvent);
      console.log('[Image Injection] Gemini: Drop event dispatched');
      
      return true;
    } catch (error) {
      console.error('[Image Injection] Gemini error:', error);
      return false;
    }
  }

  // Google AI Mode image injection
  async function injectImageToGoogle(imageData) {
    try {
      let fileInput = findGoogleFileInput();
      if (!fileInput) {
        fileInput = await openGoogleImagePicker();
      }

      if (fileInput) {
        const blob = await dataUrlToBlob(imageData.dataUrl);
        const file = new File([blob], imageData.name, { type: imageData.type });
        const assigned = assignFilesToInput(fileInput, [file]);
        if (!assigned) {
          return false;
        }
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        // Close the "+" menu only after the change event: the inputs live in
        // the menu, and closing it first could detach them from the page.
        await sleep(50);
        closeGoogleComposerMenu();
        console.log('[Image Injection] Google: File input triggered');
        return true;
      }
      console.warn('[Image Injection] Google: No file input found');
      return false;
    } catch (error) {
      console.error('[Image Injection] Google error:', error);
      return false;
    }
  }

  async function injectImageToDoubao(imageData) {
    try {
      const blob = await dataUrlToBlob(imageData.dataUrl);
      const file = new File([blob], imageData.name, { type: imageData.type });

      for (let attempt = 0; attempt < 3; attempt++) {
        let fileInput = await waitForDoubaoFileInput(500);

        if (!fileInput) {
          const uploadButton = findDeepFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.doubao) ||
            findFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.doubao);

          if (uploadButton) {
            uploadButton.click();
            await sleep(200);
            fileInput = await waitForDoubaoFileInput(800);
          }
        }

        if (!fileInput) {
          console.warn('[Image Injection] Doubao: No file input found on attempt', attempt + 1);
          continue;
        }

        const assigned = assignFilesToInput(fileInput, [file]);
        if (!assigned) {
          await sleep(200);
          continue;
        }

        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        const uploadAccepted = await waitForDoubaoImagePreview(1200);

        if (uploadAccepted) {
          console.log('[Image Injection] Doubao: Image preview detected');
          return true;
        }

        console.warn('[Image Injection] Doubao: Upload did not produce an image preview');
        return false;
      }

      console.warn('[Image Injection] Doubao: Upload did not produce a preview after retries');
      return false;
    } catch (error) {
      console.error('[Image Injection] Doubao error:', error);
      return false;
    }
  }

  async function injectImageToQwen(provider, imageData) {
    try {
      const blob = await dataUrlToBlob(imageData.dataUrl);
      const file = new File([blob], imageData.name, { type: imageData.type });

      if (provider === 'qwen-global') {
        return await injectImageToQwenGlobal(file);
      }

      return await injectImageToQwenChina(file);
    } catch (error) {
      console.error('[Image Injection] Qwen error:', provider, error);
      return false;
    }
  }

  async function injectImageToQwenChina(file) {
    const composer = document.querySelector('[data-chat-input-layout="true"]');
    if (!composer) {
      console.warn('[Image Injection] Qwen China composer not found');
      return false;
    }

    const previewCount = countQwenImagePreviews('qwen-cn');
    let fileInput = findQwenFileInput('qwen-cn');

    // Prefer waking Qwen China's lazy file input without dropping the image.
    if (!fileInput) {
      dispatchDragEventsToWakeInput(composer, file);
      fileInput = await waitForQwenFileInput('qwen-cn', 1000);
    }

    if (!fileInput) {
      // The current Qwen China composer can accept the native drop directly
      // without ever mounting a file input. Only its new preview is success.
      if (countQwenImagePreviews('qwen-cn') <= previewCount) {
        dispatchFileDragEvents(composer, file);
      }
      const accepted = await waitForQwenImagePreview('qwen-cn', previewCount, 6000);
      if (!accepted) {
        console.warn('[Image Injection] Qwen China image input and preview not found');
      }
      return accepted;
    }

    if (!assignFilesToInput(fileInput, [file])) {
      return false;
    }

    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    const accepted = await waitForQwenImagePreview('qwen-cn', previewCount, 6000);
    if (!accepted) {
      console.warn('[Image Injection] Qwen China upload did not produce an image preview');
    }
    return accepted;
  }

  async function injectImageToQwenGlobal(file) {
    const editor = document.querySelector('.message-input-textarea');

    if (!editor) {
      console.warn('[Image Injection] Qwen Global editor not found');
      return false;
    }

    const previewCount = countQwenImagePreviews('qwen-global');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    editor.focus();
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    }));

    const accepted = await waitForQwenImagePreview('qwen-global', previewCount, 6000);
    if (!accepted) {
      console.warn('[Image Injection] Qwen Global upload did not produce an image preview');
    }
    return accepted;
  }

  function dispatchFileDragEvents(target, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    ['dragenter', 'dragover', 'drop'].forEach(type => {
      target.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer
      }));
    });
  }

  function findQwenFileInput(provider) {
    const selectors = FILE_INPUT_SELECTORS[provider] || [];
    return selectors
      .map(selector => document.querySelector(selector))
      .find(Boolean) || null;
  }

  async function waitForQwenFileInput(provider, timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const fileInput = findQwenFileInput(provider);
      if (fileInput) {
        return fileInput;
      }

      await sleep(100);
    }

    return null;
  }

  function countQwenImagePreviews(provider) {
    const selector = provider === 'qwen-cn'
      ? '[data-chat-input-layout="true"] img[alt="avatar"]'
      : '.vision-item-image';
    return document.querySelectorAll(selector).length;
  }

  async function waitForQwenImagePreview(provider, previousCount, timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (countQwenImagePreviews(provider) > previousCount) {
        console.log('[Image Injection] Qwen image preview detected for:', provider);
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  function countChatGLMImagePreviews() {
    const previewList = document.querySelector('.file-list-box-content-list');
    return previewList ? previewList.children.length : 0;
  }

  async function waitForChatGLMImagePreview(previousCount, timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (countChatGLMImagePreviews() > previousCount) {
        console.log('[Image Injection] ChatGLM image preview detected');
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  function findChatGLMFileInput() {
    return document.querySelector('.upload-popover input.el-upload__input[type="file"]') ||
      document.querySelector('input.el-upload__input[type="file"]');
  }

  async function waitForChatGLMFileInput(timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const fileInput = findChatGLMFileInput();
      if (fileInput) {
        return fileInput;
      }

      await sleep(100);
    }

    return null;
  }

  async function injectImageToChatGLM(imageData) {
    try {
      let fileInput = findChatGLMFileInput();

      if (!fileInput) {
        const uploadButton = document.querySelector('.upload-image-btn-container');
        if (uploadButton) {
          uploadButton.click();
          fileInput = await waitForChatGLMFileInput(1000);
        }
      }

      if (!fileInput) {
        console.warn('[Image Injection] ChatGLM image input not found');
        return false;
      }

      const previousCount = countChatGLMImagePreviews();
      const blob = await dataUrlToBlob(imageData.dataUrl);
      const file = new File([blob], imageData.name, { type: imageData.type });

      if (!assignFilesToInput(fileInput, [file])) {
        return false;
      }

      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      const accepted = await waitForChatGLMImagePreview(previousCount, 6000);
      if (!accepted) {
        console.warn('[Image Injection] ChatGLM upload did not produce an image preview');
      }
      return accepted;
    } catch (error) {
      console.error('[Image Injection] ChatGLM error:', error);
      return false;
    }
  }

  function countZaiGlobalImagePreviews() {
    return document.querySelectorAll('.chip-scroll img[data-cy="image"]').length;
  }

  async function waitForZaiGlobalImagePreview(previousCount, timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (countZaiGlobalImagePreviews() > previousCount) {
        console.log('[Image Injection] Z.ai Global image preview detected');
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  async function injectImageToZaiGlobal(imageData) {
    try {
      const fileInput = document.querySelector('input[type="file"][multiple][accept*=".png"]');
      if (!fileInput) {
        console.warn('[Image Injection] Z.ai Global image input not found');
        return false;
      }

      const previousCount = countZaiGlobalImagePreviews();
      const blob = await dataUrlToBlob(imageData.dataUrl);
      const file = new File([blob], imageData.name, { type: imageData.type });

      if (!assignFilesToInput(fileInput, [file])) {
        return false;
      }

      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      const accepted = await waitForZaiGlobalImagePreview(previousCount, 6000);
      if (!accepted) {
        console.warn('[Image Injection] Z.ai Global upload did not produce an image preview');
      }
      return accepted;
    } catch (error) {
      console.error('[Image Injection] Z.ai Global error:', error);
      return false;
    }
  }

  async function waitForDoubaoFileInput(timeoutMs = 800) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const fileInput = document.querySelector('#input-engine-container input[type="file"]') ||
        document.querySelector('input[type="file"]');

      if (fileInput) {
        return fileInput;
      }

      await sleep(100);
    }

    return null;
  }

  function hasDoubaoImagePreview() {
    return Boolean(
      document.querySelector('.semi-image-preview-group') ||
      document.querySelector('#input-engine-container img[src^="blob:"]') ||
      document.querySelector('#input-engine-container img[src*="blob:"]')
    );
  }

  async function waitForDoubaoImagePreview(timeoutMs = 1200) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (hasDoubaoImagePreview()) {
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  // Generic drag-drop fallback for providers without a dedicated adapter.
  async function tryDragDropUpload(provider, imageData) {
    try {
      const targetElement = findProviderInput(provider);

      if (!targetElement) {
        console.warn('[Image Injection] No target element found for drag-drop');
        return false;
      }

      // Convert dataUrl to blob
      const blob = await dataUrlToBlob(imageData.dataUrl);

      // Create File object from blob
      const file = new File([blob], imageData.name, { type: imageData.type });

      // Create DataTransfer with file
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      // Focus the element first
      targetElement.focus();

      // Dispatch drag events sequence
      const dragEnterEvent = new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dataTransfer
      });

      const dragOverEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dataTransfer
      });

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dataTransfer
      });

      targetElement.dispatchEvent(dragEnterEvent);
      targetElement.dispatchEvent(dragOverEvent);
      targetElement.dispatchEvent(dropEvent);

      return true;
    } catch (error) {
      console.error('[Image Injection] Drag-drop upload failed:', error);
      return false;
    }
  }

  // Fallback: Try to upload image via file input
  async function tryFileInputUpload(provider, imageData) {
    try {
      const fileInputSelectors = FILE_INPUT_SELECTORS[provider] || [];

      // First try specific selectors
      let fileInput = null;
      for (const selector of fileInputSelectors) {
        fileInput = document.querySelector(selector);
        if (fileInput) break;
      }

      // If no direct file input, try to find any file input
      if (!fileInput) {
        const allFileInputs = document.querySelectorAll('input[type="file"]');
        for (const input of allFileInputs) {
          if (!input.accept || input.accept.includes('image') || input.accept.includes('*')) {
            fileInput = input;
            break;
          }
        }
      }

      if (!fileInput) {
        console.warn('[Image Injection] No file input found');
        return false;
      }

      // Convert dataUrl to blob
      const blob = await dataUrlToBlob(imageData.dataUrl);

      // Create File object
      const file = new File([blob], imageData.name, { type: imageData.type });

      // Create FileList-like object
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      // Trigger change event
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      return true;
    } catch (error) {
      console.error('[Image Injection] File input upload failed:', error);
      return false;
    }
  }

  // Convert data URL to Blob
  function dataUrlToBlob(dataUrl) {
    return new Promise((resolve, reject) => {
      try {
        const arr = dataUrl.split(',');
        const mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
          u8arr[n] = bstr.charCodeAt(n);
        }
        resolve(new Blob([u8arr], { type: mime }));
      } catch (error) {
        reject(error);
      }
    });
  }

  // Sleep utility
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Shadow DOM query helper functions
  function querySelectorDeep(selector, root = document) {
    // Try to find in current root element
    const element = root.querySelector(selector);
    if (element) return element;
    
    // Recursively search all shadow DOM
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        const found = querySelectorDeep(selector, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function querySelectorAllDeep(selector, root = document) {
    const elements = [...root.querySelectorAll(selector)];
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        elements.push(...querySelectorAllDeep(selector, el.shadowRoot));
      }
    }
    return elements;
  }

  // Handle text injection message
  function handleTextInjection(event) {
    // Validate event data structure
    if (!event || !event.data || typeof event.data !== 'object') {
      return;
    }

    if (handleSnapshotMessage(event)) {
      return;
    }

    if (event.data.type === PANELIZE_RESTORE_USER_FOCUS && event.data.context === 'multi-panel') {
      restoreUserFocus();
      return;
    }

    // Handle CLEAR_INPUT messages
    if (event.data.type === 'CLEAR_INPUT' && event.data.context === 'multi-panel') {
      const provider = detectProvider();
      stopMultiPanelUserInteractionTracking();
      if (provider === 'chatgpt') {
        stopChatgptSendTracking();
      }
      if (provider) {
        const providerMode = provider === 'google'
          ? normalizeGoogleProviderMode(event.data.providerMode)
          : null;

        if (provider === 'google') {
          clearGoogleInput(providerMode);
          console.log('[Text Injection] Input cleared for', provider, 'mode:', providerMode);
          return;
        }

        const element = findProviderInput(provider);
        if (element) {
          const isTextarea = element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';
          if (isTextarea) {
            setFormControlValue(element, '');
          } else {
            clearRichTextInput(provider, element);
          }
          console.log('[Text Injection] Input cleared for', provider);
        }
      }
      return;
    }

    // Handle TRIGGER_SEND messages (send without injecting text)
    if (event.data.type === 'TRIGGER_SEND' && event.data.context === 'multi-panel') {
      const provider = detectProvider();
      if (provider) {
        const providerMode = provider === 'google'
          ? normalizeGoogleProviderMode(event.data.providerMode)
          : null;
        if (event.data.requestId) {
          startMultiPanelUserInteractionTracking(event.data.requestId, provider);
        } else {
          stopMultiPanelUserInteractionTracking();
        }
        if (provider === 'chatgpt' && event.data.requestId) {
          startChatgptSendTracking(event.data.requestId);
        }
        console.log('[Text Injection] Triggering send for', provider);
        clickSendButton(provider, providerMode);
      }
      return;
    }

    // Handle NEW_CHAT messages (create new chat)
    if (event.data.type === 'NEW_CHAT' && event.data.context === 'multi-panel') {
      const provider = detectProvider();
      stopMultiPanelUserInteractionTracking();
      if (provider === 'chatgpt') {
        stopChatgptSendTracking();
      }
      const providerMode = provider === 'google'
        ? normalizeGoogleProviderMode(event.data.providerMode)
        : null;
      console.log('[Text Injection] NEW_CHAT message received, provider:', provider);
      console.log('[Text Injection] Current URL:', window.location.href);
      if (provider) {
        console.log('[Text Injection] Creating new chat for', provider);
        clickNewChatButton(provider, providerMode);
      } else {
        console.warn('[Text Injection] Provider not detected for NEW_CHAT');
      }
      return;
    }

    if (event.data.type === 'ENABLE_TEMP_CHAT' && event.data.context === 'multi-panel') {
      const provider = detectProvider();
      if (provider) {
        void enableTemporaryChat(provider);
      }
      return;
    }

    // Handle INJECT_TEXT_WITH_IMAGES messages
    if (event.data.type === 'INJECT_TEXT_WITH_IMAGES' && event.data.context === 'multi-panel') {
      const provider = detectProvider();
      void handleImageInjection(event)
        .then(result => {
          postMultiPanelActionResult(event.data.requestId, provider, result);
        })
        .catch(error => {
          console.error('[Image Injection] Unhandled fill error:', error);
          postMultiPanelActionResult(
            event.data.requestId,
            provider,
            createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR)
          );
        });
      return;
    }

    // Only handle INJECT_TEXT messages
    if (event.data.type !== 'INJECT_TEXT') {
      return;
    }

    // Validate text payload
    const text = event.data.text;
    if (!text || typeof text !== 'string' || text.length === 0) {
      console.warn('[Text Injection] Invalid text payload');
      return;
    }

    // Sanity check: reject extremely large payloads (> 1MB)
    if (text.length > 1048576) {
      console.error('[Text Injection] Text payload too large:', text.length, 'bytes');
      return;
    }

    const autoSubmit = event.data.autoSubmit === true;
    const context = event.data.context;

    // Security check: Only allow autoSubmit from multi-panel context
    // This prevents other contexts from accidentally auto-submitting when
    // multi-panel sends messages to its iframes
    const shouldAutoSubmit = autoSubmit && context === 'multi-panel';

    const provider = detectProvider();
    if (!provider) {
      console.warn('Unknown provider, cannot inject text');
      return;
    }

    const providerMode = provider === 'google'
      ? normalizeGoogleProviderMode(event.data.providerMode)
      : null;

    if (event.data.requestId) {
      startMultiPanelUserInteractionTracking(event.data.requestId, provider);
    } else {
      stopMultiPanelUserInteractionTracking();
    }
    if (provider === 'chatgpt') {
      if (shouldAutoSubmit && event.data.requestId) {
        startChatgptSendTracking(event.data.requestId);
      } else {
        stopChatgptSendTracking();
      }
    }

    if (provider === 'google') {
      const success = handleGoogleTextInjection(text, shouldAutoSubmit, providerMode);
      if (success) {
        console.log('[Text Injection] Text injected into Google using mode:', providerMode);
        return;
      }

      console.warn('[Text Injection] Google editor not found on first try, retrying...');
      [500, 1000].forEach((delay, index, delays) => {
        setTimeout(() => {
          const retried = handleGoogleTextInjection(text, shouldAutoSubmit, providerMode);
          if (!retried && index === delays.length - 1) {
            console.error('[Text Injection] Google editor not found after retries');
          }
        }, delay);
      });
      return;
    }

    if (!getProviderInputSelectors(provider)) {
      console.warn('No selectors configured for provider:', provider);
      return;
    }

    // Try each selector until we find an element
    const element = findProviderInput(provider);

    if (element) {
      const success = injectTextIntoElement(element, text, provider);
      if (success) {
        console.log('[Text Injection] Text injected into', provider);

        // Auto-submit if requested (only from multi-panel context)
        if (shouldAutoSubmit) {
          // Wait for framework-managed composer state to catch up before sending.
          const delay = SLOW_COMPOSER_PROVIDERS.has(provider) ? 800 : 500;
          setTimeout(() => {
            console.log('[Text Injection] Attempting to click send button for', provider);
            const clicked = clickSendButton(provider, providerMode);
            if (!clicked) {
              console.warn('[Text Injection] Failed to click send button for', provider);
            }
          }, delay);
        }
      } else {
        console.error(`[Text Injection] Failed to inject text into ${provider}`);
      }
    } else {
      console.warn(`[Text Injection] ${provider} editor not found on first try, retrying...`);
      // Retry after a short delay in case page is still loading
      // Use multiple retries for DeepSeek
      const retryDelays = provider === 'deepseek' ? [1000, 2000] : [1000];

      retryDelays.forEach((delay, index) => {
        setTimeout(() => {
          const retryElement = findProviderInput(provider);
          if (retryElement) {
            const success = injectTextIntoElement(retryElement, text, provider);
            if (success) {
              console.log('[Text Injection] Text injected on retry into', provider);
              if (shouldAutoSubmit) {
                const submitDelay = SLOW_COMPOSER_PROVIDERS.has(provider) ? 800 : 500;
                setTimeout(() => {
                  console.log('[Text Injection] Attempting to click send button for', provider, 'after retry');
                  clickSendButton(provider, providerMode);
                }, submitDelay);
              }
            }
          } else if (index === retryDelays.length - 1) {
            console.error(`[Text Injection] ${provider} editor not found after ${retryDelays.length} retries`);
            console.error('[Text Injection] Available textareas:', document.querySelectorAll('textarea'));
            console.error('[Text Injection] Available contenteditable:', document.querySelectorAll('[contenteditable="true"]'));
          }
        }, delay);
      });
    }
  }

  // ===== Share snapshot: align and scroll the conversation for a capture =====
  // The multi-panel page captures the whole tab, so all it needs from a
  // provider frame is where the conversation scrolls and which part of it is
  // covered by the provider's own header and composer. Only geometry is sent
  // back; no page text leaves the frame.

  function normalizeSnapshotMatchText(text) {
    return String(text || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s​-‍⁠﻿*_`]+/g, '');
  }

  function getSnapshotMatchKey(prompt) {
    return Array.from(normalizeSnapshotMatchText(prompt)).slice(0, SNAPSHOT_MATCH_KEY_LENGTH).join('');
  }

  function getSnapshotViewport() {
    return {
      width: window.innerWidth || document.documentElement?.clientWidth || 0,
      height: window.innerHeight || document.documentElement?.clientHeight || 0
    };
  }

  function isSnapshotDocumentScroller(element) {
    return !element || element === document.scrollingElement
      || element === document.documentElement || element === document.body;
  }

  function isSnapshotScrollable(element) {
    if (isSnapshotDocumentScroller(element)) {
      const scroller = document.scrollingElement || document.documentElement;
      return Boolean(scroller) && scroller.scrollHeight > scroller.clientHeight + 1;
    }
    const overflowY = window.getComputedStyle(element).overflowY;
    return /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
  }

  function isSnapshotElementRendered(element) {
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility();
    }
    return true;
  }

  function getSnapshotContainerRect(container) {
    const viewport = getSnapshotViewport();
    if (isSnapshotDocumentScroller(container)) {
      return { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
    }
    // Client box: excludes borders and scrollbars.
    const rect = container.getBoundingClientRect();
    const left = rect.left + container.clientLeft;
    const top = rect.top + container.clientTop;
    return {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(viewport.width, left + container.clientWidth),
      bottom: Math.min(viewport.height, top + container.clientHeight)
    };
  }

  function isLargeSnapshotContainer(element) {
    const viewport = getSnapshotViewport();
    if (isSnapshotDocumentScroller(element)) {
      return true;
    }
    const rect = getSnapshotContainerRect(element);
    return rect.bottom - rect.top >= viewport.height * SNAPSHOT_MIN_CONTAINER_HEIGHT_RATIO;
  }

  /**
   * The scrolling ancestor that moves the element: the main conversation
   * when it holds the element, otherwise the large ancestor that scrolls the
   * furthest, so that a wrapper scrolling a few pixels is not taken for the
   * conversation.
   * @param {Element} element
   * @param {Element} main - findMainSnapshotScrollContainer().
   */
  function findSnapshotScrollContainer(element, main) {
    const ancestors = [];
    for (let node = element; node && !isSnapshotDocumentScroller(node); node = node.parentElement) {
      if (isSnapshotScrollable(node) && isLargeSnapshotContainer(node)) {
        ancestors.push(node);
      }
    }
    if (isSnapshotScrollable(null)) {
      ancestors.push(document.scrollingElement || document.documentElement);
    }
    if (ancestors.includes(main)) {
      return main;
    }
    return ancestors.reduce((best, node) => (
      !best || getSnapshotMaxScrollTop(node) > getSnapshotMaxScrollTop(best) ? node : best
    ), null);
  }

  /** Largest visible scrolling element; the document when nothing else scrolls. */
  function findMainSnapshotScrollContainer() {
    let best = null;
    let bestArea = 0;
    for (const element of document.body?.querySelectorAll('*') || []) {
      if (!isSnapshotScrollable(element) || !isLargeSnapshotContainer(element)) {
        continue;
      }
      const rect = getSnapshotContainerRect(element);
      const area = Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
      if (area > bestArea) {
        best = element;
        bestArea = area;
      }
    }
    return best || document.scrollingElement || document.documentElement;
  }

  /** Whether the element can be the start of a turn in the conversation. */
  function isSnapshotConversationElement(element) {
    if (!isSnapshotElementRendered(element) || element.closest(SNAPSHOT_NAVIGATION_PARENTS)) {
      return false;
    }
    // Fixed boxes (dialogs, toasts) do not scroll with the conversation.
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (window.getComputedStyle(node).position === 'fixed') {
        return false;
      }
    }
    return true;
  }

  function collectSnapshotTextIndex() {
    const segments = [];
    let text = '';
    if (!document.body) {
      return { segments, text };
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(SNAPSHOT_SKIPPED_TEXT_PARENTS)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const normalized = normalizeSnapshotMatchText(node.nodeValue);
      if (normalized) {
        segments.push({ node, start: text.length });
        text += normalized;
      }
    }
    return { segments, text };
  }

  function findSnapshotSegment(segments, offset) {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (segments[middle].start <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return segments[low];
  }

  /**
   * Rendered messages that start like the prompt, best first: a match at the
   * start of a text node (a message bubble) beats one in the middle of a
   * paragraph, e.g. an answer quoting the question; then a match in the
   * main conversation beats one elsewhere; then the latest wins.
   * @returns {{element: Element, container: Element}[]}
   */
  function findSnapshotPromptMatches(prompt, main) {
    const key = getSnapshotMatchKey(prompt);
    if (Array.from(key).length < SNAPSHOT_MIN_MATCH_KEY_LENGTH) {
      return [];
    }
    const { segments, text } = collectSnapshotTextIndex();
    const candidates = [];
    let offset = text.lastIndexOf(key);
    for (let checked = 0; offset !== -1 && checked < SNAPSHOT_MAX_MATCH_CANDIDATES; checked += 1) {
      const segment = findSnapshotSegment(segments, offset);
      const element = segment.node.parentElement;
      if (element && isSnapshotConversationElement(element)) {
        const container = findSnapshotScrollContainer(element, main);
        if (container) {
          const rank = (segment.start === offset ? 0 : 2) + (container === main ? 0 : 1);
          candidates.push({ element, container, rank });
        }
      }
      offset = offset > 0 ? text.lastIndexOf(key, offset - 1) : -1;
    }
    // Array sort is stable, so the latest stays first within a rank.
    return candidates.sort((a, b) => a.rank - b.rank);
  }

  /** The latest user message found by role attributes or known bubbles. */
  function findSnapshotUserTurn(main) {
    const elements = Array.from(document.querySelectorAll(SNAPSHOT_USER_TURN_SELECTORS));
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements[index];
      if (!isSnapshotConversationElement(element)) {
        continue;
      }
      const container = findSnapshotScrollContainer(element, main);
      if (container) {
        return { element, container };
      }
    }
    return null;
  }

  function getSnapshotScrollTop(container) {
    return isSnapshotDocumentScroller(container) ? window.scrollY : container.scrollTop;
  }

  function getSnapshotMaxScrollTop(container) {
    const scroller = isSnapshotDocumentScroller(container)
      ? document.scrollingElement || document.documentElement
      : container;
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function clampSnapshotScrollTop(container, top) {
    return Math.max(0, Math.min(getSnapshotMaxScrollTop(container), Math.round(top)));
  }

  function scrollSnapshotContainer(container, top) {
    const target = clampSnapshotScrollTop(container, top);
    // "instant" overrides a smooth scroll-behavior set by the page.
    if (isSnapshotDocumentScroller(container)) {
      window.scrollTo({ top: target, behavior: 'instant' });
    } else if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: target, behavior: 'instant' });
    } else {
      container.scrollTop = target;
    }
  }

  function isSnapshotScrolledContent(element, container) {
    // Absolute elements scroll with the content when their containing block
    // is the scroll container or inside it.
    const containingBlock = element.offsetParent;
    if (!containingBlock) {
      return false;
    }
    if (isSnapshotDocumentScroller(container)) {
      return true;
    }
    return containingBlock === container || container.contains(containingBlock);
  }

  /**
   * Visible part of the container minus bars pinned over its top or bottom:
   * sticky or fixed headers, the composer and its fade. Narrow floating
   * buttons are ignored.
   */
  function getSnapshotClip(container, provider) {
    const rect = getSnapshotContainerRect(container);
    const clip = { ...rect };
    const height = rect.bottom - rect.top;
    const width = rect.right - rect.left;
    if (height <= 0 || width <= 0) {
      return clip;
    }
    const maxEdge = height * SNAPSHOT_MAX_EDGE_RATIO;
    const scope = isSnapshotDocumentScroller(container) ? document.body : container;
    const candidates = Array.from(scope?.querySelectorAll('*') || []);
    if (!isSnapshotDocumentScroller(container)) {
      // Fixed bars elsewhere in the page can still cover the container.
      candidates.push(...Array.from(document.body.querySelectorAll('*')).filter((element) => (
        !container.contains(element) && !element.contains(container)
      )));
    }

    const pinBar = (barRect) => {
      if (barRect.width < width * SNAPSHOT_OVERLAY_MIN_WIDTH_RATIO || barRect.height <= 0) {
        return;
      }
      if (barRect.bottom <= rect.top || barRect.top >= rect.bottom
        || barRect.right <= rect.left || barRect.left >= rect.right) {
        return;
      }
      if (barRect.top <= rect.top + SNAPSHOT_EDGE_TOLERANCE_PX && barRect.bottom - rect.top <= maxEdge) {
        clip.top = Math.max(clip.top, barRect.bottom);
      } else if (barRect.bottom >= rect.bottom - SNAPSHOT_EDGE_TOLERANCE_PX && rect.bottom - barRect.top <= maxEdge) {
        clip.bottom = Math.min(clip.bottom, barRect.top);
      }
    };

    // Absolute bars outside the container that sit over it, so that their
    // own layers count too, e.g. a header's fading backdrop.
    const overlayingBars = new Set();
    const isInOverlayingBar = (element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (overlayingBars.has(node)) {
          return true;
        }
      }
      return false;
    };

    for (const element of candidates) {
      const style = window.getComputedStyle(element);
      const position = style.position;
      if (position !== 'sticky' && position !== 'fixed' && position !== 'absolute') {
        continue;
      }
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        continue;
      }
      if (position === 'absolute' && container.contains(element) && isSnapshotScrolledContent(element, container)) {
        continue;
      }
      if (position === 'absolute' && !container.contains(element)) {
        // Absolute siblings only count when they sit over the container.
        // Layers without pointer events are not hit, so they count through
        // the bar they belong to.
        const sample = document.elementFromPoint?.(
          Math.round((rect.left + rect.right) / 2),
          Math.round(element.getBoundingClientRect().top + 1)
        );
        if (sample && element.contains(sample)) {
          overlayingBars.add(element);
        } else if (!isInOverlayingBar(element)) {
          continue;
        }
      }
      pinBar(element.getBoundingClientRect());
    }

    // The composer, also when it is a plain block laid over the conversation.
    const input = findSnapshotComposerInput(provider);
    if (input) {
      let box = null;
      for (let node = input; node && node !== container && !node.contains(container); node = node.parentElement) {
        const nodeRect = node.getBoundingClientRect();
        if (nodeRect.height > maxEdge || nodeRect.width > width + 2) {
          break;
        }
        box = nodeRect;
      }
      if (box && box.top < clip.bottom && box.bottom > rect.top + height - maxEdge
        && box.right > rect.left && box.left < rect.right) {
        clip.bottom = Math.min(clip.bottom, box.top);
      }
    }

    if (clip.bottom - clip.top < height * (1 - SNAPSHOT_MAX_EDGE_RATIO * 2)) {
      // Something went wrong (e.g. a full-height overlay); keep the container.
      return { ...rect };
    }
    return {
      left: Math.round(clip.left),
      top: Math.round(clip.top),
      right: Math.round(clip.right),
      bottom: Math.round(clip.bottom)
    };
  }

  function findSnapshotComposerInput(provider) {
    if (provider === 'google') {
      return findGoogleInput(GOOGLE_PROVIDER_MODE_AI);
    }
    return provider ? findProviderInput(provider) : null;
  }

  /**
   * The outermost box that keeps the element put while the container
   * scrolls: an ancestor inside the container that is fixed, stuck to an
   * edge, or absolute against a box outside the scrolled content. For an
   * element outside the container, its outermost ancestor that does not
   * hold the container.
   * @returns {Element|null} Null when the element scrolls with the content.
   */
  function getSnapshotPinningNode(element, container) {
    const outside = !isSnapshotDocumentScroller(container) && !container.contains(element);
    const containerRect = getSnapshotContainerRect(container);
    let pinning = null;
    for (let node = element; node && node !== container && node !== document.body && !node.contains(container);
      node = node.parentElement) {
      if (outside) {
        pinning = node;
        continue;
      }
      const position = window.getComputedStyle(node).position;
      if (position === 'fixed') {
        pinning = node;
      } else if (position === 'sticky') {
        // Sticky boxes in the middle of the content (e.g. code block
        // headers) scroll like the rest until they reach an edge.
        const rect = node.getBoundingClientRect();
        if (Math.abs(rect.top - containerRect.top) <= SNAPSHOT_EDGE_TOLERANCE_PX
          || Math.abs(rect.bottom - containerRect.bottom) <= SNAPSHOT_EDGE_TOLERANCE_PX) {
          pinning = node;
        }
      } else if (position === 'absolute' && !isSnapshotDocumentScroller(container)
        && !isSnapshotScrolledContent(node, container)) {
        pinning = node;
      }
    }
    return pinning;
  }

  function isSnapshotPinned(element, container) {
    return Boolean(getSnapshotPinningNode(element, container));
  }

  function overlapsSnapshotClip(rect, clip) {
    return rect.width > 0 && rect.height > 0
      && rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right;
  }

  function hasSnapshotReadableText(element) {
    // Icon fonts use private-use characters, which are not letters.
    return /[\p{L}\p{N}]/u.test(element.textContent || '');
  }

  function saveSnapshotInlineStyle(element, property) {
    return {
      element,
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property)
    };
  }

  function restoreSnapshotInlineStyles(savedStyles) {
    // Newest first, so a property saved twice ends up as it started.
    for (const { element, property, value, priority } of [...savedStyles].reverse()) {
      if (value) {
        element.style.setProperty(property, value, priority);
      } else {
        element.style.removeProperty(property);
      }
    }
  }

  /**
   * Adds SNAPSHOT_STYLE_RULES to the page. A constructed sheet is not
   * subject to the page's style-src policy; a style element is the fallback.
   */
  function installSnapshotStyles() {
    try {
      if (typeof CSSStyleSheet === 'function' && Array.isArray(document.adoptedStyleSheets)) {
        if (!snapshotStyleSheet) {
          snapshotStyleSheet = new CSSStyleSheet();
          snapshotStyleSheet.replaceSync(SNAPSHOT_STYLE_RULES);
        }
        if (!document.adoptedStyleSheets.includes(snapshotStyleSheet)) {
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, snapshotStyleSheet];
        }
        return;
      }
    } catch (error) {
      console.warn('[Snapshot] Constructed stylesheet unavailable, using a style element:', error);
    }
    if (!document.getElementById(SNAPSHOT_STYLE_ELEMENT_ID)) {
      const style = document.createElement('style');
      style.id = SNAPSHOT_STYLE_ELEMENT_ID;
      style.textContent = SNAPSHOT_STYLE_RULES;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function removeSnapshotStyles() {
    if (snapshotStyleSheet && Array.isArray(document.adoptedStyleSheets)) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== snapshotStyleSheet);
    }
    document.getElementById(SNAPSHOT_STYLE_ELEMENT_ID)?.remove();
  }

  /**
   * Whether a pseudo-element is a fade or shadow laid over the page, e.g.
   * Gemini's gradient drawn by the composer's ::before over the bottom of
   * the conversation.
   */
  function isSnapshotFadePseudo(element, pseudo) {
    const style = window.getComputedStyle(element, `::${pseudo}`);
    if (!style?.content || style.content === 'none' || style.content === 'normal' || style.display === 'none') {
      return false;
    }
    if (!/^(absolute|fixed|sticky)$/.test(style.position)) {
      return false;
    }
    return (style.backgroundImage || '').includes('gradient')
      || (Boolean(style.boxShadow) && style.boxShadow !== 'none');
  }

  /** Hides the element's fading pseudo-elements. @returns {boolean} Whether anything new was hidden. */
  function hideSnapshotFadePseudos(session, element) {
    const marked = (element.getAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE) || '').split(/\s+/).filter(Boolean);
    const missing = ['before', 'after'].filter((pseudo) => !marked.includes(pseudo) && isSnapshotFadePseudo(element, pseudo));
    if (missing.length === 0) {
      return false;
    }
    if (!session.hiddenPseudos.has(element)) {
      session.hiddenPseudos.set(element, element.getAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE));
    }
    installSnapshotStyles();
    element.setAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE, [...marked, ...missing].join(' '));
    return true;
  }

  /**
   * Takes sticky boxes in the middle of the conversation out of sticking,
   * e.g. section headings and table headers, which would otherwise be pinned
   * over every stitched screen. Boxes at the very start or end of the
   * conversation are page chrome (a header, the composer dock) that the clip
   * leaves out, so they keep sticking. An un-stuck box keeps its place in
   * the flow, so nothing else moves and the scroll height stays the same.
   * Runs after every scroll, because pages render parts as they show up.
   * @returns {boolean} Whether anything new was un-stuck.
   */
  function unstickSnapshotContent(session) {
    const { container } = session;
    const isDocument = isSnapshotDocumentScroller(container);
    const scope = isDocument ? document.body : container;
    const scroller = isDocument ? document.scrollingElement || document.documentElement : container;
    // Top of the scrolled content, in viewport pixels.
    const contentTop = getSnapshotContainerRect(container).top - getSnapshotScrollTop(container);
    const input = findSnapshotComposerInput(session.provider);
    let changed = false;
    for (const element of scope?.querySelectorAll('*') || []) {
      if (session.unstuckElements.has(element) || session.keptStickyElements.has(element) || !element.style) {
        continue;
      }
      const style = window.getComputedStyle(element);
      if (style.position !== 'sticky') {
        continue;
      }
      if (input && element.contains(input)) {
        session.keptStickyElements.add(element);
        continue;
      }
      const saved = SNAPSHOT_UNSTICK_PROPERTIES.map((property) => saveSnapshotInlineStyle(element, property));
      element.style.setProperty('position', 'relative', 'important');
      SNAPSHOT_UNSTICK_PROPERTIES.slice(1).forEach((property) => element.style.setProperty(property, 'auto', 'important'));
      // Where it sits in the flow, now that it no longer sticks.
      const rect = element.getBoundingClientRect();
      const top = rect.top - contentTop;
      if (top <= SNAPSHOT_EDGE_TOLERANCE_PX || top + rect.height >= scroller.scrollHeight - SNAPSHOT_EDGE_TOLERANCE_PX) {
        restoreSnapshotInlineStyles(saved);
        session.keptStickyElements.add(element);
        continue;
      }
      session.savedStyles.push(...saved);
      session.unstuckElements.add(element);
      // Shadows and fades only made sense while it was stuck over the text.
      if (style.boxShadow && style.boxShadow !== 'none') {
        session.savedStyles.push(saveSnapshotInlineStyle(element, 'box-shadow'));
        element.style.setProperty('box-shadow', 'none', 'important');
      }
      hideSnapshotFadePseudos(session, element);
      changed = true;
    }
    return changed;
  }

  /**
   * Hides what would repeat on every stitched screen or clutter a current
   * view: buttons and fades pinned over the visible conversation (e.g.
   * "Scroll to bottom"), shadows of bars around it, fades drawn by
   * pseudo-elements of the composer or of the conversation's boxes, notices
   * stacked on a composer laid over it (e.g. "You've used 90% of your
   * limit"), overlay scrollbars, and masks that fade the edges of the
   * conversation. While stitching, pinned text goes too (e.g. a heading
   * kept on screen); a current view keeps it. The composer itself stays and
   * layout is kept. Runs after every scroll, because some buttons only show
   * up once the conversation is no longer at the bottom.
   * @returns {boolean} Whether anything new was hidden.
   */
  function hideSnapshotFloatingElements(session) {
    const { container, clip } = session;
    const clipHeight = clip.bottom - clip.top;
    if (!container || clipHeight <= 0 || clip.right <= clip.left) {
      return false;
    }
    const hidden = session.hiddenElements;
    let changed = false;
    const hide = (element) => {
      hidden.add(element);
      session.savedStyles.push(saveSnapshotInlineStyle(element, 'visibility'));
      element.style.setProperty('visibility', 'hidden', 'important');
      changed = true;
    };

    // Overlay scrollbars show up after every scroll; they take no room, so
    // hiding them does not move the content.
    const scroller = isSnapshotDocumentScroller(container)
      ? document.scrollingElement || document.documentElement
      : container;
    if (!session.hidesScrollbar) {
      const style = window.getComputedStyle(scroller);
      const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      if (scroller.offsetWidth > 0 && scroller.offsetWidth - scroller.clientWidth <= borders) {
        session.hidesScrollbar = true;
        session.savedStyles.push(saveSnapshotInlineStyle(scroller, 'scrollbar-width'));
        scroller.style.setProperty('scrollbar-width', 'none', 'important');
        changed = true;
      }
    }

    // Boxes whose pseudo-elements may be fades over the conversation: the
    // conversation and its ancestors, the composer and its ancestors, and
    // whatever is pinned or was un-stuck.
    const input = findSnapshotComposerInput(session.provider);
    const fadeHosts = new Set(session.unstuckElements);
    for (let node = container; node && node.style; node = node.parentElement) {
      fadeHosts.add(node);
      if (session.unmaskedElements.has(node)) {
        continue;
      }
      const style = window.getComputedStyle(node);
      const masked = SNAPSHOT_HIDDEN_MASK_PROPERTIES.some((property) => {
        const value = style.getPropertyValue(property);
        return value && value !== 'none';
      });
      if (masked) {
        session.unmaskedElements.add(node);
        SNAPSHOT_HIDDEN_MASK_PROPERTIES.forEach((property) => {
          session.savedStyles.push(saveSnapshotInlineStyle(node, property));
          node.style.setProperty(property, 'none', 'important');
        });
        changed = true;
      }
    }
    for (let node = input?.parentElement; node && node !== document.body; node = node.parentElement) {
      fadeHosts.add(node);
    }

    // Shadows cast by bars next to the clip, e.g. under a header, fall on
    // the edge of every screen.
    const containerRect = getSnapshotContainerRect(container);
    const nearClip = {
      left: containerRect.left,
      right: containerRect.right,
      top: clip.top - SNAPSHOT_EDGE_TOLERANCE_PX,
      bottom: clip.bottom + SNAPSHOT_EDGE_TOLERANCE_PX
    };
    for (const element of document.body?.querySelectorAll('*') || []) {
      if (hidden.has(element) || element === container || element.contains(container)
        || (session.matchElement && element.contains(session.matchElement))) {
        continue;
      }
      const style = window.getComputedStyle(element);
      const position = style.position;
      if (position !== 'sticky' && position !== 'fixed' && position !== 'absolute') {
        continue;
      }
      if (style.display === 'none' || !isSnapshotPinned(element, container)) {
        continue;
      }
      fadeHosts.add(element);
      const rect = element.getBoundingClientRect();
      if (style.boxShadow && style.boxShadow !== 'none' && !session.quietedElements.has(element)
        && overlapsSnapshotClip(rect, nearClip)) {
        session.quietedElements.add(element);
        session.savedStyles.push(saveSnapshotInlineStyle(element, 'box-shadow'));
        element.style.setProperty('box-shadow', 'none', 'important');
        changed = true;
      }
      if (rect.height > clipHeight * SNAPSHOT_MAX_FLOATING_HEIGHT_RATIO || !overlapsSnapshotClip(rect, clip)) {
        continue;
      }
      if (input && element.contains(input)) {
        continue;
      }
      const isButton = element.matches('button, [role="button"]');
      if (!session.stitch && !isButton && hasSnapshotReadableText(element)) {
        continue;
      }
      hide(element);
    }

    for (const element of fadeHosts) {
      if (element.style && hideSnapshotFadePseudos(session, element)) {
        changed = true;
      }
    }

    // The clip ends at the input box, so whatever else the pinned composer
    // shows over the conversation sits next to the input's ancestors.
    const dock = input && getSnapshotPinningNode(input, container);
    if (dock) {
      for (let node = input; node !== dock; node = node.parentElement) {
        for (const sibling of node.parentElement.children) {
          if (sibling !== node && !hidden.has(sibling) && sibling.style
            && !(session.matchElement && sibling.contains(session.matchElement))
            && window.getComputedStyle(sibling).display !== 'none'
            && overlapsSnapshotClip(sibling.getBoundingClientRect(), clip)) {
            hide(sibling);
          }
        }
      }
    }
    return changed;
  }

  /** Puts back every style, mark and pointer a snapshot changed; scroll positions stay. */
  function restoreSnapshotPage(session) {
    if (!session) {
      return;
    }
    restoreSnapshotInlineStyles(session.savedStyles);
    session.savedStyles = [];
    session.hiddenPseudos.forEach((value, element) => {
      if (value === null) {
        element.removeAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE);
      } else {
        element.setAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE, value);
      }
    });
    session.hiddenPseudos.clear();
    session.hidesScrollbar = false;
    session.hiddenElements.clear();
    session.unmaskedElements.clear();
    session.unstuckElements.clear();
    session.keptStickyElements.clear();
    session.quietedElements.clear();
    document.documentElement.removeAttribute(SNAPSHOT_HIDE_CURSOR_ATTRIBUTE);
    removeSnapshotStyles();
  }

  /** Un-sticks and hides what should not be captured, then waits for the result to show. */
  async function settleSnapshotScreen(session) {
    await waitForSnapshotPaint();
    if (!session.hideFloating) {
      return;
    }
    // A second pass for what only appeared after the first one.
    for (let pass = 0; pass < 2; pass += 1) {
      const unstuck = session.stitch && unstickSnapshotContent(session);
      const hidden = hideSnapshotFloatingElements(session);
      if (!unstuck && !hidden) {
        break;
      }
      await waitForSnapshotPaint();
    }
  }

  function waitForSnapshotPaint() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      // Frames can be throttled when hidden; the timeout keeps replies coming.
      setTimeout(finish, SNAPSHOT_PAINT_TIMEOUT_MS);
      if (typeof requestAnimationFrame !== 'function') {
        setTimeout(finish, SNAPSHOT_PAINT_SETTLE_MS);
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, SNAPSHOT_PAINT_SETTLE_MS)));
    });
  }

  function postSnapshotState(requestId, session, extra = {}) {
    const container = session?.container || null;
    window.parent.postMessage({
      type: PANELIZE_SNAPSHOT_STATE,
      context: MULTI_PANEL_SNAPSHOT_CONTEXT,
      requestId,
      sessionId: session?.id || null,
      provider: detectProvider(),
      matched: Boolean(session?.matched),
      // 'prompt', 'user-turn' or 'top'; null when the panel was left as it was.
      alignedBy: session?.alignedBy || null,
      scrollTop: container ? getSnapshotScrollTop(container) : 0,
      maxScrollTop: container ? getSnapshotMaxScrollTop(container) : 0,
      originalScrollTop: container ? session.scrolled.get(container)?.top ?? null : null,
      clip: session?.clip || null,
      viewport: getSnapshotViewport(),
      ...extra
    }, '*');
  }

  /** Captures this container: remembers where it was, un-sticks its content and measures its clip. */
  function useSnapshotContainer(session, container) {
    if (session.container === container) {
      return;
    }
    session.container = container;
    if (!session.scrolled.has(container)) {
      const top = getSnapshotScrollTop(container);
      const maxScrollTop = getSnapshotMaxScrollTop(container);
      session.scrolled.set(container, {
        top,
        maxScrollTop,
        atEnd: top >= maxScrollTop - SNAPSHOT_ALIGN_TOLERANCE_PX
      });
    }
    session.keptStickyElements.clear();
    if (session.stitch) {
      // Before measuring, so a heading stuck at the top is not taken for a header.
      unstickSnapshotContent(session);
    }
    session.clip = getSnapshotClip(container, session.provider);
  }

  /**
   * Scrolls the element just under the provider's header, not behind it,
   * and checks that it got there: the container scrolled as asked and the
   * element moved with it. Otherwise the container is put back.
   * @returns {boolean} Whether the element is aligned.
   */
  function alignSnapshotElement(session, { element, container }, alignedBy) {
    useSnapshotContainer(session, container);
    const before = getSnapshotScrollTop(container);
    const elementTop = element.getBoundingClientRect().top;
    const target = clampSnapshotScrollTop(container, before + elementTop - session.clip.top - SNAPSHOT_ALIGN_MARGIN_PX);
    scrollSnapshotContainer(container, target);
    const after = getSnapshotScrollTop(container);
    const moved = elementTop - element.getBoundingClientRect().top;
    if (Math.abs(after - target) > SNAPSHOT_ALIGN_TOLERANCE_PX
      || Math.abs(moved - (after - before)) > SNAPSHOT_ALIGN_TOLERANCE_PX) {
      scrollSnapshotContainer(container, before);
      return false;
    }
    session.alignedBy = alignedBy;
    session.alignTarget = target;
    session.matched = alignedBy === 'prompt';
    session.matchElement = element;
    return true;
  }

  async function handleSnapshotPrepare(data) {
    // A capture that never restored, e.g. when the page went away.
    restoreSnapshotPage(snapshotSession);
    snapshotSession = null;
    const stitch = Boolean(data.stitch);
    const session = {
      id: data.sessionId,
      provider: detectProvider(),
      stitch,
      hideFloating: stitch || Boolean(data.hideFloating),
      container: null,
      clip: null,
      matched: false,
      alignedBy: null,
      alignTarget: null,
      matchElement: null,
      // Scroll position of every container touched, to put them back.
      scrolled: new Map(),
      hiddenElements: new Set(),
      unmaskedElements: new Set(),
      unstuckElements: new Set(),
      keptStickyElements: new Set(),
      quietedElements: new Set(),
      hiddenPseudos: new Map(),
      hidesScrollbar: false,
      savedStyles: []
    };
    snapshotSession = session;
    if (data.hideCursor) {
      // Tab sharing can draw the pointer into the frames.
      installSnapshotStyles();
      document.documentElement.setAttribute(SNAPSHOT_HIDE_CURSOR_ATTRIBUTE, '');
    }

    const main = findMainSnapshotScrollContainer();
    useSnapshotContainer(session, main);
    if (data.align && typeof data.prompt === 'string') {
      for (const match of findSnapshotPromptMatches(data.prompt, main)) {
        if (alignSnapshotElement(session, match, 'prompt')) {
          break;
        }
      }
    }
    if (!session.alignedBy && stitch) {
      const turn = findSnapshotUserTurn(main);
      if (turn) {
        alignSnapshotElement(session, turn, 'user-turn');
      }
    }
    if (!session.alignedBy && stitch) {
      // Never stitch from wherever the panel happened to be scrolled.
      useSnapshotContainer(session, main);
      scrollSnapshotContainer(main, 0);
      session.alignedBy = 'top';
      session.alignTarget = 0;
    }

    if (session.alignedBy || session.hideFloating) {
      await settleSnapshotScreen(session);
    }
    if (session.alignTarget !== null
      && Math.abs(getSnapshotScrollTop(session.container) - session.alignTarget) > SNAPSHOT_ALIGN_TOLERANCE_PX) {
      // The page scrolled itself meanwhile (e.g. back to the bottom).
      scrollSnapshotContainer(session.container, session.alignTarget);
      await settleSnapshotScreen(session);
    }
    postSnapshotState(data.requestId, session);
  }

  async function handleSnapshotScroll(data) {
    const session = snapshotSession;
    if (!session || session.id !== data.sessionId || typeof data.scrollTop !== 'number') {
      postSnapshotState(data.requestId, null, { error: 'no-session' });
      return;
    }
    scrollSnapshotContainer(session.container, data.scrollTop);
    await settleSnapshotScreen(session);
    postSnapshotState(data.requestId, session);
  }

  async function handleSnapshotRestore(data) {
    const session = snapshotSession;
    if (!session || session.id !== data.sessionId) {
      postSnapshotState(data.requestId, null, { error: 'no-session' });
      return;
    }
    snapshotSession = null;
    restoreSnapshotPage(session);
    const positions = Array.from(session.scrolled).reverse();
    let { scrolled, heldBack } = restoreSnapshotScrollPositions(positions, false);
    // A virtual list (DeepSeek) renders the rows near its old position only
    // once scrolled there, so its range can be short at first and hold it
    // back: follow the range while it grows back.
    for (let attempt = 0; heldBack && !snapshotSession && attempt < SNAPSHOT_RESTORE_ATTEMPTS; attempt += 1) {
      await waitForSnapshotPaint();
      scrolled = false;
      ({ heldBack } = restoreSnapshotScrollPositions(positions, true));
    }
    if (scrolled) {
      await waitForSnapshotPaint();
    }
    postSnapshotState(data.requestId, session, { restored: true });
  }

  /**
   * Scrolls each container back; one that was at the end goes back to the
   * end. With `onlyHeldBack`, only containers left at the end of the short
   * range seen last time are touched; one that moved off it was scrolled by
   * the page meanwhile and is left alone.
   * @returns {{scrolled: boolean, heldBack: boolean}} heldBack: a range is
   *   still shorter than the position needs.
   */
  function restoreSnapshotScrollPositions(positions, onlyHeldBack) {
    let scrolled = false;
    let heldBack = false;
    for (const [container, position] of positions) {
      const current = getSnapshotScrollTop(container);
      if (onlyHeldBack && (position.heldAt === undefined || Math.abs(current - position.heldAt) > 1)) {
        continue;
      }
      const max = getSnapshotMaxScrollTop(container);
      const target = position.atEnd ? max : position.top;
      if (Math.abs(current - target) > 1) {
        scrollSnapshotContainer(container, target);
        scrolled = true;
      }
      const needed = position.atEnd ? position.maxScrollTop : position.top;
      const reached = getSnapshotMaxScrollTop(container);
      position.heldAt = reached < needed - 1 ? getSnapshotScrollTop(container) : undefined;
      heldBack = heldBack || position.heldAt !== undefined;
    }
    return { scrolled, heldBack };
  }

  /** Returns true when the message belonged to the snapshot protocol. */
  function handleSnapshotMessage(event) {
    const type = event.data.type;
    if (type !== PANELIZE_SNAPSHOT_PREPARE && type !== PANELIZE_SNAPSHOT_SCROLL && type !== PANELIZE_SNAPSHOT_RESTORE) {
      return false;
    }
    // Only the page embedding this frame may scroll it.
    if (event.data.context !== 'multi-panel' || event.source !== window.parent) {
      return true;
    }
    const handler = type === PANELIZE_SNAPSHOT_PREPARE
      ? handleSnapshotPrepare
      : type === PANELIZE_SNAPSHOT_SCROLL ? handleSnapshotScroll : handleSnapshotRestore;
    handler(event.data).catch((error) => {
      console.warn('[Snapshot] Could not prepare the conversation:', error);
      postSnapshotState(event.data.requestId, null, { error: 'failed' });
    });
    return true;
  }

  // Listen for messages from the multi-panel host
  setupProviderLocationReporting();
  setupPageWidthReporting();
  window.addEventListener('message', handleTextInjection);
})();
