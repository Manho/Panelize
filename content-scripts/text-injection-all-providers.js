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
  // Origin of this extension's own pages, e.g. chrome-extension://<id>. Only
  // the Multi-Panel page embedding this frame may drive it.
  const EXTENSION_ORIGIN = getExtensionOrigin();
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
  // Ancestors with these cut off what lies outside them.
  const SNAPSHOT_CLIPPING_OVERFLOW = /^(hidden|clip|auto|scroll|overlay)$/;
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
    'ms-chat-turn .chat-turn-container.user', // Google AI Studio
    'ms-chat-turn .user-prompt-container', // Google AI Studio
    'ms-chat-turn [data-turn-role="User"]', // Google AI Studio
    'ms-chat-turn[data-turn-role="user"]', // Google AI Studio
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
  const AISTUDIO_STOP_BUTTON_SELECTORS = [
    'ms-run-button .spin',
    'ms-run-button button[mattooltip*="Cancel generation" i]',
    'ms-run-button button[aria-label*="Cancel generation" i]',
    'ms-run-button button[aria-label*="Stop" i]'
  ];
  // AI Studio remembers temporary mode across visits (aiStudioUserPreference), so a bare
  // /prompts/new_chat stays temporary after ?temporary=true. Normal mode must opt out explicitly.
  const AISTUDIO_NEW_CHAT_URL = 'https://aistudio.google.com/prompts/new_chat?temporary=false';
  const AISTUDIO_TEMP_CHAT_URL = 'https://aistudio.google.com/prompts/new_chat?temporary=true';
  const CHATGPT_SEND_TRACKING_IDLE_DELAY_MS = 800;
  const CHATGPT_SEND_TRACKING_NO_BUSY_TIMEOUT_MS = 2000;
  const MULTI_PANEL_USER_INTERACTION_TRACKING_TIMEOUT_MS = 90000;
  const TEMP_CHAT_POLL_INTERVAL_MS = 200;
  const TEMP_CHAT_POLL_TIMEOUT_MS = 1200;
  const YUANBAO_TEMP_CHAT_CLICK_COOLDOWN_MS = 5000;
  const IMAGE_UPLOAD_PREVIEW_TIMEOUT_MS = 6000;
  const DOCUMENT_UPLOAD_PREVIEW_TIMEOUT_MS = 10000;
  // ChatGPT renders its attachment card as soon as React handles the input's
  // change event, so each attempt only waits briefly. Two attempts plus the gap
  // must stay well under the 8s single-attachment panel action timeout.
  const CHATGPT_PREVIEW_ATTEMPT_TIMEOUT_MS = 2500;
  const CHATGPT_PREVIEW_RETRY_DELAY_MS = 300;
  const SLOW_COMPOSER_PROVIDERS = new Set([
    'deepseek', 'kimi', 'doubao', 'chatglm', 'zai-global', 'yuanbao'
  ]);
  const IMAGE_INJECTION_REASONS = Object.freeze({
    CONTROL_NOT_FOUND: 'control-not-found',
    UNSUPPORTED: 'unsupported',
    TYPE_NOT_ACCEPTED: 'type-not-accepted',
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
      'textarea[placeholder="Message DeepSeek"]',
      'textarea[placeholder*="DeepSeek"]:not([name="user query"])',
      'textarea[placeholder="How can I help you?"]',
      'textarea.ds-scroll-area:not([name="user query"])',
      'textarea[class*="ds-"]:not([name="user query"])',
      'textarea:not([name="user query"])',
      'div[contenteditable="true"]'
    ],
    kimi: [
      'div[contenteditable="true"].chat-input-editor',
      'div.chat-input-editor[contenteditable]',
      '.chat-input-editor[data-lexical-editor="true"]',
      '.chat-input-editor',
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
      // Legacy ("返回旧版") composer first, then the GLM-5.4 el-textarea composer.
      '#search-input-box textarea.scroll-display-none',
      'textarea.scroll-display-none',
      '.input-area textarea.el-textarea__inner',
      'textarea.el-textarea__inner'
    ],
    'zai-global': [
      'textarea[placeholder="How can I help you today?"]',
      'textarea.input-scroll'
    ],
    yuanbao: [
      '.chat-command-editor-specail .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"][data-placeholder]'
    ],
    aistudio: [
      'ms-prompt-box textarea[formcontrolname="promptText"]',
      'ms-prompt-box textarea.textarea',
      'ms-prompt-box textarea[aria-label="Enter a prompt"]',
      'ms-prompt-box textarea',
      'textarea[formcontrolname="promptText"]'
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
    aistudio: true,
    google: true  // Google AI Mode supports images
  };

  // Provider-specific file input selectors for image and document upload
  const FILE_INPUT_SELECTORS = {
    // Ordered by preference. The live composer form also mounts a mobile
    // camera-capture input first in DOM order; findChatgptFileInput() drops it
    // whenever another input exists. The bare selector keeps legacy layouts working.
    chatgpt: [
      'input[type="file"][data-testid="file-upload-input"]:not([capture])',
      'input[type="file"][aria-label="Attach files"]:not([capture])',
      [
        'input[type="file"][multiple]:not([capture]):not([accept])',
        'input[type="file"][multiple]:not([capture])[accept=""]',
        'input[type="file"][multiple]:not([capture])[accept*="*/*"]'
      ].join(', '),
      'input[type="file"][aria-label="Attach photos"]:not([capture])',
      'input[type="file"][aria-label="Attach photos or videos"]:not([capture])',
      'input[type="file"]:not([capture])',
      'input[type="file"]'
    ],
    claude: ['input[type="file"]'],
    gemini: [
      'input.hidden-file-input[type="file"]',
      'input-container input[type="file"]',
      'uploader input[type="file"]',
      'input[type="file"]'
    ],
    doubao: ['#input-engine-container input[type="file"]', 'input[type="file"]'],
    'qwen-cn': ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    'qwen-global': [
      '.message-input-container input#filesUpload',
      '#dropzone-container input#filesUpload',
      'input[type="file"]'
    ],
    chatglm: [
      // The first three entries are the GLM-5.4 composer-scoped inputs (see CHATGLM_COMPOSER_FILE_INPUT_SELECTOR_COUNT).
      '.input-area .upload-attachment-picker input.file-input[type="file"]',
      '.input-area input.file-input[type="file"]',
      '.upload-attachment-picker input.file-input[type="file"]',
      '.upload-popover input.el-upload__input[type="file"]',
      'input.el-upload__input[type="file"]',
      'input[type="file"]'
    ],
    'zai-global': ['input[type="file"][multiple]', 'input[type="file"]'],
    yuanbao: ['input[type="file"][multiple]', 'input[type="file"]'],
    aistudio: ['ms-prompt-box input[type="file"]', 'input[type="file"]'],
    google: ['input[type="file"]']
  };

  // Provider-specific upload button selectors (to click before file input)
  const UPLOAD_BUTTON_SELECTORS = {
    chatgpt: ['button[aria-label="Attach files"]', 'button[data-testid="composer-attach-button"]', 'button:has(svg path[d*="M9"])'],
    claude: ['button[aria-label="Attach file"]', 'button[aria-label="Upload file"]', 'fieldset button:has(svg)'],
    gemini: [
      'input-container button[aria-label="Upload & tools"]',
      'uploader button[aria-label="Upload & tools"]',
      'button[aria-label="Upload & tools"]',
      'input-container button[aria-label="Open upload file menu"]',
      'uploader button[aria-label="Open upload file menu"]',
      'button[aria-label="Open upload file menu"]',
      'input-container button[aria-label="Upload file"]',
      'button[aria-label="Upload file"]',
      'button[mattooltip="Upload file"]',
      'input-container button[aria-label="Add files"]',
      'button[aria-label="Add files"]',
      'input-container button[aria-label="上传和工具"]',
      'uploader button[aria-label="上传和工具"]',
      'button[aria-label="上传和工具"]',
      'input-container button[aria-label*="Upload" i]',
      'uploader button[aria-label*="Upload" i]',
      '.input-area-container button[aria-label*="Upload" i]',
      'input-container button[aria-label*="上传"]',
      'uploader button[aria-label*="上传"]',
      '.input-area-container button[aria-label*="上传"]',
      'input-container button.upload-card-button',
      'uploader button',
      'input-container .add-button',
      '.input-area-container .add-button',
      'input-container button:has(mat-icon[fonticon="add"])',
      'input-container button:has(mat-icon[fonticon="plus"])',
      '.input-area-container button:has(mat-icon[fonticon="add"])',
      '.input-area-container button:has(mat-icon[fonticon="plus"])'
    ],
    doubao: [
      '#input-engine-container button[data-slot="dropdown-menu-trigger"][aria-haspopup="menu"]'
    ],
    yuanbao: [
      'button[data-new-input-control="add-tools-trigger"]',
      'button[aria-label="Add"]'
    ],
    aistudio: [
      'ms-prompt-box button[aria-label*="Insert" i]',
      'ms-prompt-box button[aria-label*="Add" i]',
      'ms-prompt-box button[aria-label*="Upload" i]',
      'button[aria-label="Insert assets such as images, videos, files, or audio"]',
      'button[aria-label*="Upload" i]'
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
      'button[data-testid="fruitjuice-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
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
      'button[type="submit"]',
      '.ds-icon-button[role="button"]:not([aria-disabled="true"]):not(.ds-icon-button--disabled):has(svg path[d*="M8.3125"])',
      'button.ds-icon-button:not([aria-disabled="true"]):not(.ds-icon-button--disabled):has(svg path[d*="M8.3125"])'
    ],
    kimi: [
      // Priority: clickable send button containers that are not disabled
      '.send-button-container:not(.disabled)',
      '.send-button:not(.disabled)',
      '[role="button"][class*="send"]:not([class*="disabled"])',
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
      '.enter.is-main-chat',
      // GLM-5.4 composer
      '.input-area button.send-button[aria-label="发送"]',
      'button.send-button[aria-label="发送"]',
      '.input-area button.send-button',
      'button.send-button'
    ],
    'zai-global': [
      'button.sendMessageButton'
    ],
    yuanbao: [
      '#yuanbao-send-btn[aria-label="Send"]',
      '#yuanbao-send-btn'
    ],
    aistudio: [
      'ms-prompt-box ms-run-button button',
      'ms-run-button button.run-button',
      'button[aria-label*="Run" i]',
      'button[mattooltip*="Send prompt" i]'
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
    aistudio: [
      'button[data-test-clear="outside"][aria-label="New chat"]',
      'button[data-test-clear="outside"]',
      'button[aria-label="New chat"]'
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
    aistudio: 'https://aistudio.google.com/prompts/new_chat?temporary=false',
    google: 'https://www.google.com/search?udm=50'
  };

  const TEMP_CHAT_BUTTON_SELECTORS = {
    chatgpt: [
      'button[aria-label="Turn on temporary chat"]',
      'button[aria-label="Temporary chat"]'
    ],
    claude: ['button[aria-label="Use incognito"]'],
    gemini: [
      'button[data-test-id="temp-chat-button"]',
      'button[aria-label="Temporary chat"]',
      // Current Gemini header exposes a stateful aria-label instead of data-test-id.
      'button[aria-label="Turn on temporary chat"]',
      'button[aria-label="Turn off temporary chat"]'
    ],
    grok: ['a[href="/c#private"][aria-label="Switch to Private Chat"]'],
    yuanbao: [
      '[role="button"][aria-label="Enter Temporary Chat"]',
      '[role="button"][aria-label="Exit Temporary Chat"]',
      '[role="button"][aria-label="进入临时对话"]',
      '[role="button"][aria-label="退出临时对话"]',
      '[role="button"][aria-label="進入臨時對話"]',
      '[role="button"][aria-label="退出臨時對話"]'
    ],
    aistudio: [
      'button[data-test-incognito-toggle][aria-label="Toggle temporary chat"]',
      'button[data-test-incognito-toggle]',
      'button[aria-label="Toggle temporary chat"]'
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
    } else if (hostname === 'aistudio.google.com') {
      return 'aistudio';
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

    const style = typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(element)
      : null;
    if (style && (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none')) {
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

    postToMultiPanelHost({
      type,
      requestId,
      provider,
      phase,
      context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT
    });
  }

  function postMultiPanelActionResult(requestId, provider, result) {
    if (!requestId || !provider || window.parent === window) {
      return;
    }

    const isSkipped = Boolean(result?.skipped);
    const hasSkippedAttachments = Array.isArray(result?.skippedAttachments) && result.skippedAttachments.length > 0;
    const includeAttachmentProtocol = Boolean(
      result?.includeAttachmentProtocol || isSkipped || hasSkippedAttachments
    );

    const message = {
      type: PANELIZE_ACTION_RESULT,
      context: MULTI_PANEL_ACTION_RESULT_CONTEXT,
      requestId,
      provider,
      action: 'fill',
      status: isSkipped ? 'skipped' : (result.ok ? 'succeeded' : 'failed')
    };

    if (Array.isArray(result?.succeededImageIds)) {
      message.succeededImageIds = result.succeededImageIds;
      if (includeAttachmentProtocol) {
        message.succeededAttachmentIds = result.succeededImageIds;
      }
    }

    if (!result.ok && Array.isArray(result?.attemptedImageIds)) {
      message.attemptedImageIds = result.attemptedImageIds;
      if (includeAttachmentProtocol) {
        message.attemptedAttachmentIds = result.attemptedImageIds;
      }
    }

    if (hasSkippedAttachments) {
      message.skippedAttachments = result.skippedAttachments;
    }

    if (!result.ok || isSkipped) {
      message.reason = result.reason || (isSkipped ? IMAGE_INJECTION_REASONS.UNSUPPORTED : IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }

    postToMultiPanelHost(message);
  }

  function postTemporaryChatEnabled(provider = detectProvider()) {
    if (!provider || window.parent === window) {
      return;
    }

    postToMultiPanelHost({
      type: PANELIZE_TEMP_CHAT_ENABLED,
      provider,
      context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT
    });
  }

  function postProviderLocation(provider = detectProvider()) {
    if (!provider || window.parent === window) {
      return;
    }

    postToMultiPanelHost({
      type: PANELIZE_PROVIDER_LOCATION,
      provider,
      url: window.location.href,
      context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT
    });
  }

  function getCurrentGoogleAccountPrefix() {
    const match = /^\/u\/(\d+)(?:\/|$)/.exec(window.location.pathname || '');
    return match ? `/u/${match[1]}` : '';
  }

  function isSameOriginGeminiAccountSwitchUrl(targetUrl) {
    if (!targetUrl || targetUrl.origin !== window.location.origin) {
      return false;
    }

    if (targetUrl.searchParams.has('authuser')) {
      return true;
    }

    const match = /^\/u\/(\d+)(?:\/|$)/.exec(targetUrl.pathname);
    if (!match) {
      return false;
    }

    const strippedPath = targetUrl.pathname.replace(/^\/u\/\d+(?=\/|$)/, '') || '/';
    if (strippedPath === '/' || strippedPath === '/app' || strippedPath === '/app/') {
      return true;
    }

    return `/u/${match[1]}` !== getCurrentGoogleAccountPrefix();
  }

  /**
   * Keeps same-origin Gemini Google account-switch links (`/u/<n>/app`, `?authuser=<n>`)
   * inside the embedded panel iframe when the page marks them `target="_blank"`
   * or `target="_top"`, without hijacking ordinary same-account conversation links.
   */
  function setupSameOriginAccountNavigation() {
    document.addEventListener('click', (event) => {
      if (!isMultiPanelFrame()) {
        return;
      }

      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const provider = detectProvider();
      if (provider !== 'gemini') {
        return;
      }

      const rawTarget = event.composedPath?.()[0] || event.target;
      const anchor = typeof rawTarget?.closest === 'function'
        ? rawTarget.closest('a[href]')
        : rawTarget?.parentElement?.closest?.('a[href]') || null;
      if (!anchor) {
        return;
      }

      const targetAttr = (anchor.getAttribute('target') || '').trim().toLowerCase();
      if (targetAttr !== '_blank' && targetAttr !== '_top' && targetAttr !== '_parent') {
        return;
      }

      let resolvedUrl;
      try {
        resolvedUrl = new URL(anchor.getAttribute('href'), window.location.href);
      } catch {
        return;
      }

      if (!isSameOriginGeminiAccountSwitchUrl(resolvedUrl)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      window.location.assign(resolvedUrl.toString());
    }, true);
  }

  function setupProviderLocationReporting() {
    let lastReportedUrl = null;

    const reportIfChanged = () => {
      const currentUrl = window.location.href;
      if (currentUrl === lastReportedUrl) {
        return;
      }

      const previousUrl = lastReportedUrl;
      lastReportedUrl = currentUrl;
      postProviderLocation();
      if (previousUrl && detectProvider() === 'chatgpt') {
        handleChatgptRouteChange(previousUrl, currentUrl);
      }
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

  function getExtensionOrigin() {
    try {
      const baseUrl = chrome.runtime.getURL('');
      // String form: URL#origin is "null" for non-special schemes in some engines.
      const origin = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
      return /^[a-z][a-z0-9+.-]*:\/\/[^/]+$/.test(origin) ? origin : null;
    } catch (error) {
      console.warn('[Text Injection] Extension origin unavailable; panel messages are ignored:', error);
      return null;
    }
  }

  /**
   * Panel messages type and send prompts in the user's session, so they are
   * accepted only from the extension page that embeds this frame. Any page
   * holding a reference to this window can post, and it controls the data.
   */
  function isFromMultiPanelHost(event) {
    return EXTENSION_ORIGIN !== null
      && event.origin === EXTENSION_ORIGIN
      && event.source === window.parent;
  }

  /**
   * Returns true only when this frame is directly embedded by our extension's
   * Multi-Panel host, never in a standalone tab, a nested sub-iframe, or a
   * third-party/same-origin web frame.
   */
  function canPostToMultiPanelHost() {
    if (EXTENSION_ORIGIN === null || !window.parent || window.parent === window) {
      return false;
    }
    // Nested sub-frames (e.g. a provider's own child iframe inside Multi-Panel)
    // have an intermediate parent frame rather than the top-level Multi-Panel host.
    // Guard against synthetic test windows that mock `window.parent` without
    // updating `window.top` (leaving `window.top === window`).
    if (window.top && window.top !== window && window.parent !== window.top) {
      return false;
    }
    const ancestors = window.location?.ancestorOrigins;
    if (ancestors && typeof ancestors.length === 'number' && ancestors.length > 0) {
      return ancestors.length === 1 && ancestors[0] === EXTENSION_ORIGIN;
    }
    // Fallback for engines without `location.ancestorOrigins` (e.g. Firefox):
    // if `window.parent.location.origin` is readable without a cross-origin
    // SecurityError, the parent is same-origin with this web page, not the
    // extension host.
    try {
      const parentOrigin = window.parent.location?.origin;
      if (typeof parentOrigin === 'string' && parentOrigin !== EXTENSION_ORIGIN) {
        return false;
      }
    } catch {
      // Cross-origin parent (expected when embedded inside the extension page).
    }
    return true;
  }

  /**
   * Posts to the Multi-Panel page embedding this frame. Targets the extension
   * origin, never '*', so a third-party page framing the provider learns
   * nothing (conversation URL, status); nothing is posted unless directly
   * embedded by our extension origin (avoiding Chrome targetOrigin mismatch
   * warnings on standalone tabs or nested provider sub-iframes).
   */
  function postToMultiPanelHost(message) {
    if (!canPostToMultiPanelHost()) {
      return;
    }
    window.parent.postMessage(message, EXTENSION_ORIGIN);
  }

  function isMultiPanelFrame() {
    if (window.parent === window || window.parent !== window.top) {
      return false;
    }
    const ancestors = window.location?.ancestorOrigins;
    if (ancestors && typeof ancestors.length === 'number' && ancestors.length > 0) {
      if (EXTENSION_ORIGIN !== null) {
        return ancestors.length === 1 && ancestors[0] === EXTENSION_ORIGIN;
      }
      return ancestors.length === 1 && /^(chrome|moz)-extension:/.test(ancestors[0]);
    }
    try {
      const parentOrigin = window.parent.location?.origin;
      if (typeof parentOrigin === 'string' && !/^(chrome|moz)-extension:/.test(parentOrigin)) {
        return false;
      }
    } catch {
      // Cross-origin parent.
    }
    return true;
  }

  /**
   * Boxes filling the viewport hold the app itself, even when they scroll or
   * float; so do those filling most of it beside a side rail, e.g. Qwen's
   * content box next to its rail of icons.
   */
  function isPageShellBox(rect, viewportWidth, viewportHeight) {
    return rect.right >= viewportWidth - 1 && rect.width >= viewportWidth / 2
      && rect.height >= viewportHeight / 2;
  }

  /**
   * Width the page's layout needs, in CSS pixels: the furthest an element
   * held open by a pixel min-width reaches from where it starts. Only the app
   * shell is scanned: floating layers (menus, popovers) and content of
   * scrolling boxes (chat lists, code blocks, tables) are left out. It does
   * not depend on the viewport width, so a page laid out at the width it
   * needs keeps asking for it. Returns 0 when nothing is held open.
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
        needed = Math.max(needed, Math.ceil(rect.left + window.scrollX + minWidth));
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
      postToMultiPanelHost({
        type: PANELIZE_PAGE_WIDTH,
        provider,
        neededWidth,
        context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT
      });
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

      if ((tracking.provider === 'chatgpt' || tracking.provider === 'aistudio') && chatgptSendTracking?.requestId === tracking.requestId) {
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

  function findAiStudioBusyButton() {
    for (const selector of AISTUDIO_STOP_BUTTON_SELECTORS) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }

    const runButton = document.querySelector('ms-run-button button');
    if (!runButton) {
      return null;
    }

    if (runButton.querySelector('.spin')) {
      return runButton;
    }

    const tooltip = (runButton.getAttribute('mattooltip') || '').toLowerCase();
    const ariaLabel = (runButton.getAttribute('aria-label') || '').toLowerCase();
    const labelText = (runButton.querySelector('.run-button-label')?.textContent || runButton.textContent || '')
      .trim()
      .toLowerCase();

    if (
      tooltip.includes('cancel generation') ||
      tooltip.includes('stop') ||
      ariaLabel.includes('cancel generation') ||
      ariaLabel.includes('stop') ||
      labelText === 'stop'
    ) {
      return runButton;
    }

    return null;
  }

  function findProviderBusyButton(provider = 'chatgpt') {
    if (provider === 'aistudio') {
      return findAiStudioBusyButton();
    }
    return findChatgptBusyButton();
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

    const { requestId, phase, provider = 'chatgpt' } = tracking;
    chatgptSendTracking = null;

    if (reportIdle) {
      postMultiPanelProviderStatus(PANELIZE_PROVIDER_IDLE, requestId, phase, provider);
    }
  }

  function evaluateChatgptSendTrackingState() {
    const tracking = chatgptSendTracking;
    if (!tracking) {
      return;
    }

    const provider = tracking.provider || 'chatgpt';

    if (findProviderBusyButton(provider)) {
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
        postMultiPanelProviderStatus(PANELIZE_PROVIDER_BUSY, tracking.requestId, tracking.phase, provider);
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
      if (findProviderBusyButton(provider)) {
        evaluateChatgptSendTrackingState();
        return;
      }

      currentTracking.phase = 'idle';
      stopChatgptSendTracking({ reportIdle: true });
    }, CHATGPT_SEND_TRACKING_IDLE_DELAY_MS);
  }

  function startChatgptSendTracking(requestId, provider = 'chatgpt') {
    if (!requestId) {
      return;
    }

    stopChatgptSendTracking();

    const tracking = {
      requestId,
      provider,
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

        if (typeof tracking.idleTimerId === 'number' && findProviderBusyButton(provider)) {
          clearTimeout(tracking.idleTimerId);
          tracking.idleTimerId = null;
        }

        evaluateChatgptSendTrackingState();
      });

      tracking.observer.observe(observerTarget, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: provider === 'aistudio'
          ? ['data-testid', 'aria-label', 'disabled', 'aria-disabled', 'class', 'mattooltip']
          : ['data-testid', 'aria-label', 'disabled', 'aria-disabled']
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

  const touchedFormControls = new WeakSet();

  function setFormControlValue(element, value) {
    const previousValue = element.value ?? '';
    const wasPreviouslyTouched = touchedFormControls.has(element);
    touchedFormControls.add(element);

    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus?.();
    }

    const prototype = element.tagName === 'INPUT'
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    // Chrome MV3 content scripts run in an isolated world where React's main-world
    // `node._valueTracker` expando is invisible. When re-filling a previously touched
    // control that was cleared or left at the same value, flush an empty input event
    // first so React's main-world tracker syncs to '' before observing the new value.
    if (
      wasPreviouslyTouched &&
      !element._valueTracker &&
      value !== '' &&
      (previousValue === '' || previousValue === value)
    ) {
      if (previousValue !== '') {
        if (nativeSetter) {
          nativeSetter.call(element, '');
        } else {
          element.value = '';
        }
      }
      try {
        element.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'deleteContentBackward',
          data: null
        }));
      } catch {
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }

    // Reset React's internal _valueTracker so controlled inputs (e.g. DeepSeek)
    // always observe programmatic refills even after clearing or deleting text.
    if (element._valueTracker && typeof element._valueTracker.setValue === 'function') {
      try {
        element._valueTracker.setValue(
          previousValue === value ? (value === '' ? '__panelize_cleared__' : '') : previousValue
        );
      } catch {
        // Ignore React tracker errors
      }
    }

    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: value === '' ? 'deleteContentBackward' : 'insertText',
        data: value === '' ? null : value
      }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));

    if (typeof element.value === 'string') {
      try {
        element.selectionStart = element.selectionEnd = element.value.length;
      } catch {
        // Ignore selection range errors on unsupported input types
      }
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

  function clearRichTextInput(provider, element, { focus = true } = {}) {
    if (focus !== false) {
      element.focus();
    }

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

    if (provider === 'chatglm' && isChatGLMGlm54SendButton(element)) {
      return !element.classList.contains('send-button--disabled');
    }

    if (provider === 'aistudio') {
      if (typeof window.ButtonFinderUtils?.isAiStudioSendControl === 'function') {
        return window.ButtonFinderUtils.isAiStudioSendControl(element) === true;
      }

      if (element.classList.contains('disabled')) {
        return false;
      }

      if (element.querySelector?.('.spin')) {
        return false;
      }

      const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
      const matTooltip = (element.getAttribute('mattooltip') || '').toLowerCase();
      const labelElement = element.querySelector?.('.run-button-label');
      const labelText = (labelElement ? labelElement.textContent : element.textContent || '')
        .trim()
        .toLowerCase();

      if (
        ariaLabel.includes('cancel generation') ||
        ariaLabel.includes('stop') ||
        matTooltip.includes('cancel generation') ||
        matTooltip.includes('stop') ||
        labelText === 'stop' ||
        labelText === 'add' ||
        ariaLabel === 'add'
      ) {
        return false;
      }

      return true;
    }

    if (
      element.classList.contains('disabled') ||
      element.classList.contains('ds-button--disabled') ||
      element.classList.contains('ds-icon-button--disabled') ||
      element.closest?.('.disabled, .ds-button--disabled, .ds-icon-button--disabled, [aria-disabled="true"]')
    ) {
      return false;
    }

    return true;
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

  function findGoogleFileInput(attachmentData = null) {
    const fileInputs = querySelectorAllDeep('input[type="file"]');
    const isDoc = isDocumentAttachmentData(attachmentData);

    if (isDoc) {
      let exactMatch = null;
      let wildcardFallback = null;
      for (const input of fileInputs) {
        const accept = (input.getAttribute('accept') || '').trim().toLowerCase();
        if (!accept || accept === '*/*') {
          if (!wildcardFallback) wildcardFallback = input;
          continue;
        }
        if (acceptsAttachmentFile(input, attachmentData)) {
          exactMatch = input;
          break;
        }
      }
      return exactMatch || wildcardFallback;
    }

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

  async function openGoogleImagePicker(attachmentData = null) {
    // The current AI Mode composer only renders its hidden file inputs inside
    // the "+" menu ("添加图片" / "上传文件" items), so the menu has to be opened first.
    const menuTrigger = findGoogleComposerMenuTrigger();
    if (menuTrigger) {
      if (menuTrigger.getAttribute('aria-expanded') !== 'true') {
        menuTrigger.click();
      }
      await sleep(150);
      const menuInput = findGoogleFileInput(attachmentData);
      if (menuInput) {
        return menuInput;
      }
      // If inputs exist in the menu (e.g. image + PDF) and none accept this file, return early so caller can skip.
      if (isDocumentAttachmentData(attachmentData) && querySelectorAllDeep('input[type="file"]').length > 0) {
        return null;
      }
    }

    const uploadButton = findDeepFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.google);
    if (uploadButton) {
      uploadButton.click();
      await sleep(150);
    }

    let fileInput = findGoogleFileInput(attachmentData);
    if (fileInput) {
      return fileInput;
    }

    const keywords = isDocumentAttachmentData(attachmentData)
      ? ['upload file', 'add file', 'upload pdf', 'pdf', '上传文件', '添加文件', '文件', '更多输入项']
      : ['更多输入项', 'add image', 'upload image', 'upload file', 'image', 'photo', '上传图片', '上传文件', '图片', '照片', '图像'];
    const menuAction = findDeepClickableElementByKeywords(keywords);

    if (menuAction) {
      menuAction.click();
      await sleep(150);
    }

    fileInput = findGoogleFileInput(attachmentData);
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

    return findGoogleFileInput(attachmentData);
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

  function isUsableTextInputCandidate(element) {
    if (!element || element.disabled || element.readOnly || element.hidden) {
      return false;
    }
    if (
      element.getAttribute('aria-hidden') === 'true' ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.getAttribute('aria-readonly') === 'true' ||
      element.getAttribute('contenteditable') === 'false'
    ) {
      return false;
    }
    const style = typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(element)
      : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) {
      return false;
    }
    return true;
  }

  // Find text input element by selector, preferring visible & enabled composers
  // over hidden helper/inline-edit textareas earlier in DOM order.
  function findTextInputElement(selector) {
    if (!selector || typeof selector !== 'string') {
      return null;
    }

    try {
      const matches = document.querySelectorAll(selector);
      let nonHiddenFallback = null;
      for (const candidate of matches) {
        if (!isUsableTextInputCandidate(candidate)) {
          continue;
        }
        if (isVisibleElement(candidate)) {
          return candidate;
        }
        if (!nonHiddenFallback) {
          nonHiddenFallback = candidate;
        }
      }
      return nonHiddenFallback;
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
  function clickSendButton(provider, providerMode = null, { allowEnterFallback = true } = {}) {
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

    // ChatGPT's send button lives in the composer's form; DeepSeek's lives in the
    // composer ancestor. Scoping the search keeps unrelated toolbar/inline buttons
    // from being clicked.
    const searchRoot = provider === 'chatgpt'
      ? getChatgptComposer()?.findForm() || document
      : provider === 'deepseek'
        ? findClosestAncestorContaining(findProviderInput('deepseek'), 'div[role="button"], button') || document
        : document;

    const hasDisabledPrimaryDeepSeekSend = provider === 'deepseek' && Boolean(
      searchRoot.querySelector('div[role="button"].ds-button--primary.ds-button--filled.ds-button--disabled')
    );

    // Try each selector (unless DeepSeek's primary send button is present and disabled)
    for (const selector of hasDisabledPrimaryDeepSeekSend ? [] : selectors) {
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
            const chatgptCandidateText = provider === 'chatgpt'
              ? readChatgptEditorText(findProviderInput('chatgpt'))
              : '';
            const chatgptStartHref = provider === 'chatgpt' ? window.location.href : '';
            const chatgptWasBusyBeforeSend = provider === 'chatgpt'
              ? Boolean(findChatgptBusyButton())
              : false;
            console.log('[Text Injection] Clicking send button:', selector);
            if (provider === 'chatglm' && !isChatGLMGlm54SendButton(targetElement)) {
              // Legacy ChatGLM submits from its mousedown handler; HTMLElement.click() skips it.
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
            if (provider === 'chatgpt' && chatgptCandidateText.trim().length > 0) {
              confirmAndRecordChatgptSend(chatgptCandidateText, chatgptStartHref, {
                wasBusyBeforeSend: chatgptWasBusyBeforeSend
              });
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

    if (!allowEnterFallback) {
      return false;
    }

    // GLM-5.4 renders a real send-button that stays disabled while attachments upload; an
    // Enter keypress submits nothing then, so report the send as pending instead.
    if (provider === 'chatglm' && hasDisabledChatGLMGlm54SendButton()) {
      console.log('[Text Injection] ChatGLM send-button is disabled; send is pending');
      return false;
    }

    // Special handling for DeepSeek - trigger Enter key if button not found
    if (provider === 'deepseek') {
      console.log('[Text Injection] DeepSeek send button not found, trying Enter key');
      try {
        const input = findProviderInput('deepseek');
        if (input) {
          console.log('[Text Injection] Triggering Enter key on DeepSeek input');
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

  function hasDisabledSlowSendControl(provider) {
    if (provider === 'deepseek') {
      return Boolean(
        document.querySelector(
          'div[role="button"].ds-button--primary.ds-button--filled.ds-button--disabled, .ds-icon-button[aria-disabled="true"], .ds-icon-button--disabled'
        )
      );
    }
    if (provider === 'kimi') {
      return Boolean(
        document.querySelector('.send-button-container.disabled, .send-button.disabled')
      );
    }
    if (provider === 'chatglm') {
      return hasDisabledChatGLMGlm54SendButton();
    }
    return false;
  }

  function scheduleAutoSubmit(provider, providerMode = null) {
    const initialDelay = SLOW_COMPOSER_PROVIDERS.has(provider) ? 800 : 500;
    const extraRetryDelays = SLOW_COMPOSER_PROVIDERS.has(provider) ? [400, 800, 1200] : [];

    setTimeout(() => {
      const waitForSlowControl = hasDisabledSlowSendControl(provider);
      if (clickSendButton(provider, providerMode, { allowEnterFallback: !waitForSlowControl })) {
        return;
      }
      if (!waitForSlowControl || extraRetryDelays.length === 0) {
        console.warn('[Text Injection] Failed to click send button for', provider);
        return;
      }

      let settled = false;
      extraRetryDelays.forEach((retryOffset, index) => {
        setTimeout(() => {
          if (settled) {
            return;
          }
          const isLastAttempt = index === extraRetryDelays.length - 1;
          if (clickSendButton(provider, providerMode, { allowEnterFallback: isLastAttempt })) {
            settled = true;
          } else if (isLastAttempt) {
            console.warn('[Text Injection] Failed to click send button for', provider);
          }
        }, retryOffset);
      });
    }, initialDelay);
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
    if (document.querySelector('button[aria-label="Turn off temporary chat"]')) {
      return true;
    }

    const button = control ||
      document.querySelector('button[data-test-id="temp-chat-button"]') ||
      document.querySelector('button[aria-label="Temporary chat"]');

    if (!button) {
      return false;
    }

    return (
      button.getAttribute('aria-label') === 'Turn off temporary chat' ||
      button.classList.contains('temp-chat-on') ||
      isTemporaryChatControlActive(button)
    );
  }

  function isAiStudioTemporaryChatEnabled(control = null) {
    try {
      const currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.get('temporary') === 'true') {
        return true;
      }
    } catch (error) {
      // Ignore invalid URL parse errors
    }

    const indicator = document.querySelector('ms-incognito-mode-indicator');
    if (indicator && isVisibleElement(indicator) && Boolean(indicator.textContent?.trim())) {
      return true;
    }

    const button = control ||
      document.querySelector('button[data-test-incognito-toggle]') ||
      document.querySelector('button[aria-label="Toggle temporary chat"]');

    if (!button) {
      return false;
    }

    return isTemporaryChatControlActive(button);
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
      case 'aistudio':
        return isAiStudioTemporaryChatEnabled(control);
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

  function handleAiStudioNewChat(options = {}) {
    const shouldUseTemporaryChat = options?.temporaryChat === true ||
      (options?.temporaryChat !== false && isTemporaryChatAlreadyEnabled('aistudio'));
    const targetUrl = shouldUseTemporaryChat
      ? AISTUDIO_TEMP_CHAT_URL
      : AISTUDIO_NEW_CHAT_URL;
    console.log('[Text Injection] Navigating AI Studio to new chat URL:', targetUrl);
    window.location.href = targetUrl;
    return true;
  }

  // ChatGPT persists the new-chat composer draft (it survives the New chat button,
  // reloads, and is restored with the last sent prompt), so both Multi-Panel New
  // Chat and post-send reloads must clear it explicitly. The composer re-renders
  // after navigation and may restore the draft late, so clear across a short
  // hydration window, stopping once the user types.
  const CHATGPT_NEW_CHAT_CLEAR_DELAYS_MS = [0, 150, 400, 900, 1800, 3500];
  const CHATGPT_NEW_CHAT_MOUNT_POLL_MS = 250;
  const CHATGPT_PENDING_NEW_CHAT_CLEAR_KEY = 'panelize:chatgpt-pending-new-chat-clear';
  const CHATGPT_PENDING_NEW_CHAT_CLEAR_TTL_MS = 15000;
  const CHATGPT_SENT_DRAFTS_KEY = 'panelize:chatgpt-sent-drafts';
  const CHATGPT_SENT_DRAFTS_MAX = 20;
  const CHATGPT_SENT_DRAFTS_TTL_MS = 24 * 60 * 60 * 1000;
  const CHATGPT_RELOAD_CLEAR_WINDOW_MS = 15000;
  const CHATGPT_SEND_CONFIRM_POLL_MS = 150;
  const CHATGPT_SEND_CONFIRM_MAX_ATTEMPTS = 10;
  const CHATGPT_NON_EDITING_KEYS = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
    'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'ContextMenu', 'Pause', 'PrintScreen'
  ]);
  let chatgptNewChatClearTimerIds = [];
  let chatgptNewChatMountObserver = null;
  let chatgptActiveClearMatchSentOnly = false;

  function isEmbeddedChatgptFrame() {
    return window.self !== window.top && detectProvider() === 'chatgpt';
  }

  function isChatgptHomePath(pathname = window.location?.pathname || '') {
    return pathname === '' || pathname === '/';
  }

  function normalizeChatgptDraftText(text) {
    if (typeof text !== 'string') {
      return '';
    }
    return text.replace(/\r\n?/g, '\n').trim();
  }

  function readChatgptEditorText(editor) {
    if (!editor) {
      return '';
    }
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      return editor.value || '';
    }
    const blockChildren = Array.from(editor.children || []).filter(
      child => child.tagName === 'P' || child.tagName === 'DIV'
    );
    if (blockChildren.length > 0) {
      return blockChildren
        .map(block => {
          const clone = block.cloneNode(true);
          clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
          return (clone.textContent || '').replace(/\n$/, '');
        })
        .join('\n');
    }
    return editor.textContent || '';
  }

  function getChatgptDraftStorages() {
    const storages = [];
    const isTemporaryChat =
      new URLSearchParams(window.location?.search || '').get('temporary-chat') === 'true';
    if (!isTemporaryChat) {
      try {
        if (window.localStorage) storages.push(window.localStorage);
      } catch (error) {
        // Ignore restricted storage contexts.
      }
    }
    try {
      if (window.sessionStorage) storages.push(window.sessionStorage);
    } catch (error) {
      // Ignore restricted storage contexts.
    }
    return storages;
  }

  function readSentChatgptDrafts() {
    const now = Date.now();
    const seen = new Set();
    const entries = [];
    for (const storage of getChatgptDraftStorages()) {
      let raw = null;
      try {
        raw = storage.getItem(CHATGPT_SENT_DRAFTS_KEY);
      } catch (error) {
        continue;
      }
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          const text = normalizeChatgptDraftText(item?.text);
          const at = Number(item?.at);
          if (!text || !Number.isFinite(at) || now - at > CHATGPT_SENT_DRAFTS_TTL_MS || seen.has(text)) {
            continue;
          }
          seen.add(text);
          entries.push({ text, at });
        }
      } catch (error) {
        // Ignore malformed storage data.
      }
    }
    entries.sort((a, b) => b.at - a.at);
    return entries.slice(0, CHATGPT_SENT_DRAFTS_MAX);
  }

  function recordSentChatgptDraft(rawText) {
    const text = normalizeChatgptDraftText(rawText);
    if (!text) {
      return;
    }
    const next = [
      { text, at: Date.now() },
      ...readSentChatgptDrafts().filter(entry => entry.text !== text)
    ].slice(0, CHATGPT_SENT_DRAFTS_MAX);
    const serialized = JSON.stringify(next);
    for (const storage of getChatgptDraftStorages()) {
      try {
        storage.setItem(CHATGPT_SENT_DRAFTS_KEY, serialized);
        break;
      } catch (error) {
        // Fall through to the next available storage backend.
      }
    }
  }

  function isRecordedSentChatgptDraft(rawText) {
    const normalized = normalizeChatgptDraftText(rawText);
    if (!normalized) {
      return false;
    }
    return readSentChatgptDrafts().some(entry => entry.text === normalized);
  }

  function confirmAndRecordChatgptSend(
    candidateText,
    startHref = window.location.href,
    { wasBusyBeforeSend = false } = {}
  ) {
    if (!isEmbeddedChatgptFrame()) {
      return;
    }
    const normalized = normalizeChatgptDraftText(candidateText);
    if (!normalized) {
      return;
    }

    const isConfirmedSent = () => {
      const editor = findProviderInput('chatgpt');
      const current = normalizeChatgptDraftText(readChatgptEditorText(editor));
      if (!current) {
        return true;
      }
      if (!wasBusyBeforeSend && findChatgptBusyButton()) {
        return true;
      }
      if (window.location.href !== startHref && !isChatgptHomePath()) {
        return true;
      }
      return false;
    };

    if (isConfirmedSent()) {
      recordSentChatgptDraft(normalized);
      return;
    }

    let attempts = 0;
    const poll = () => {
      attempts += 1;
      if (isConfirmedSent()) {
        recordSentChatgptDraft(normalized);
        return;
      }
      if (attempts < CHATGPT_SEND_CONFIRM_MAX_ATTEMPTS) {
        setTimeout(poll, CHATGPT_SEND_CONFIRM_POLL_MS);
      }
    };
    setTimeout(poll, CHATGPT_SEND_CONFIRM_POLL_MS);
  }

  function clearPendingChatgptNewChatComposerClearMarker() {
    try {
      window.sessionStorage?.removeItem(CHATGPT_PENDING_NEW_CHAT_CLEAR_KEY);
    } catch (error) {
      // Ignore restricted storage contexts.
    }
  }

  function markPendingChatgptNewChatComposerClear() {
    try {
      window.sessionStorage?.setItem(CHATGPT_PENDING_NEW_CHAT_CLEAR_KEY, String(Date.now()));
    } catch (error) {
      // Ignore restricted storage contexts.
    }
  }

  function clearChatgptComposerDraftOnce({ matchSentOnly = false, focus = true } = {}) {
    const editor = findProviderInput('chatgpt');
    if (!editor) {
      return false;
    }
    const currentText = readChatgptEditorText(editor);
    if (currentText.trim().length > 0) {
      if (matchSentOnly && !isRecordedSentChatgptDraft(currentText)) {
        return true;
      }
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        setFormControlValue(editor, '');
      } else {
        clearRichTextInput('chatgpt', editor, { focus });
      }
      console.log(
        matchSentOnly
          ? '[Text Injection] Cleared restored sent ChatGPT draft after reload'
          : '[Text Injection] Cleared persisted ChatGPT draft after new chat'
      );
    }
    return true;
  }

  function disconnectChatgptNewChatMountObserver() {
    if (chatgptNewChatMountObserver) {
      chatgptNewChatMountObserver.disconnect();
      chatgptNewChatMountObserver = null;
    }
  }

  function clearChatgptNewChatScheduledTimers() {
    chatgptNewChatClearTimerIds.forEach(timerId => clearTimeout(timerId));
    chatgptNewChatClearTimerIds = [];
  }

  function cancelChatgptNewChatComposerClear({ clearReloadMarker = true } = {}) {
    clearChatgptNewChatScheduledTimers();
    disconnectChatgptNewChatMountObserver();
    chatgptActiveClearMatchSentOnly = false;
    if (clearReloadMarker) {
      clearPendingChatgptNewChatComposerClearMarker();
    }
    document.removeEventListener('keydown', handleChatgptNewChatUserInput, true);
    document.removeEventListener('beforeinput', handleChatgptNewChatUserInput, true);
  }

  function handleChatgptNewChatUserInput(event) {
    if (!event?.isTrusted) {
      return;
    }
    if (event.type === 'keydown') {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        CHATGPT_NON_EDITING_KEYS.has(event.key) ||
        /^F\d{1,2}$/.test(event.key || '')
      ) {
        return;
      }
    }
    cancelChatgptNewChatComposerClear();
  }

  function startChatgptPostMountClearPasses({
    consumeReloadMarker = false,
    matchSentOnly = false,
    focus = true
  } = {}) {
    clearChatgptNewChatScheduledTimers();
    disconnectChatgptNewChatMountObserver();
    chatgptActiveClearMatchSentOnly = matchSentOnly;
    if (consumeReloadMarker) {
      clearPendingChatgptNewChatComposerClearMarker();
    }
    if (matchSentOnly) {
      const observeRoot = document.body || document.documentElement;
      if (typeof MutationObserver === 'function' && observeRoot) {
        chatgptNewChatMountObserver = new MutationObserver(() => {
          clearChatgptComposerDraftOnce({ matchSentOnly: true, focus });
        });
        chatgptNewChatMountObserver.observe(observeRoot, {
          childList: true,
          subtree: true,
          characterData: true
        });
      }
    }
    CHATGPT_NEW_CHAT_CLEAR_DELAYS_MS.forEach((delay, index) => {
      const timerId = setTimeout(() => {
        clearChatgptComposerDraftOnce({ matchSentOnly, focus });
        if (index === CHATGPT_NEW_CHAT_CLEAR_DELAYS_MS.length - 1) {
          cancelChatgptNewChatComposerClear({ clearReloadMarker: consumeReloadMarker });
        }
      }, delay);
      chatgptNewChatClearTimerIds.push(timerId);
    });
  }

  function scheduleChatgptNewChatComposerClear({
    waitForMountUntilMs = 0,
    consumeReloadMarkerOnMount = false,
    matchSentOnly = false,
    focus = true
  } = {}) {
    cancelChatgptNewChatComposerClear({ clearReloadMarker: false });
    chatgptActiveClearMatchSentOnly = matchSentOnly;
    document.addEventListener('keydown', handleChatgptNewChatUserInput, true);
    document.addEventListener('beforeinput', handleChatgptNewChatUserInput, true);

    if (!waitForMountUntilMs || findProviderInput('chatgpt')) {
      startChatgptPostMountClearPasses({
        consumeReloadMarker: consumeReloadMarkerOnMount,
        matchSentOnly,
        focus
      });
      return;
    }

    const remainingTtlMs = Math.max(0, waitForMountUntilMs - Date.now());
    if (remainingTtlMs === 0) {
      cancelChatgptNewChatComposerClear({ clearReloadMarker: consumeReloadMarkerOnMount });
      return;
    }

    const checkMountedOrExpired = () => {
      if (findProviderInput('chatgpt')) {
        startChatgptPostMountClearPasses({
          consumeReloadMarker: consumeReloadMarkerOnMount,
          matchSentOnly,
          focus
        });
        return true;
      }
      if (Date.now() >= waitForMountUntilMs) {
        cancelChatgptNewChatComposerClear({ clearReloadMarker: consumeReloadMarkerOnMount });
        return true;
      }
      return false;
    };

    const observeRoot = document.documentElement || document;
    if (typeof MutationObserver === 'function' && observeRoot) {
      chatgptNewChatMountObserver = new MutationObserver(() => {
        checkMountedOrExpired();
      });
      chatgptNewChatMountObserver.observe(observeRoot, {
        childList: true,
        subtree: true,
        attributes: true
      });
    }

    const scheduleNextMountPoll = () => {
      const msLeft = waitForMountUntilMs - Date.now();
      if (msLeft <= 0) {
        cancelChatgptNewChatComposerClear({ clearReloadMarker: consumeReloadMarkerOnMount });
        return;
      }
      const pollTimerId = setTimeout(() => {
        if (!checkMountedOrExpired()) {
          scheduleNextMountPoll();
        }
      }, Math.min(CHATGPT_NEW_CHAT_MOUNT_POLL_MS, msLeft));
      chatgptNewChatClearTimerIds.push(pollTimerId);
    };

    scheduleNextMountPoll();
  }

  function scheduleChatgptSentDraftReloadClear() {
    if (!isEmbeddedChatgptFrame() || !isChatgptHomePath()) {
      return;
    }
    if (
      (chatgptNewChatClearTimerIds.length > 0 || Boolean(chatgptNewChatMountObserver)) &&
      !chatgptActiveClearMatchSentOnly
    ) {
      return;
    }
    if (readSentChatgptDrafts().length === 0) {
      return;
    }
    scheduleChatgptNewChatComposerClear({
      waitForMountUntilMs: Date.now() + CHATGPT_RELOAD_CLEAR_WINDOW_MS,
      consumeReloadMarkerOnMount: false,
      matchSentOnly: true,
      focus: false
    });
  }

  function handleChatgptRouteChange(previousUrl, currentUrl) {
    if (!isEmbeddedChatgptFrame()) {
      return;
    }
    try {
      const prevPath = new URL(previousUrl).pathname;
      const nextPath = new URL(currentUrl).pathname;
      if (!isChatgptHomePath(prevPath) && isChatgptHomePath(nextPath)) {
        scheduleChatgptSentDraftReloadClear();
      }
    } catch (error) {
      // Ignore malformed URLs.
    }
  }

  function setupChatgptSentDraftTracking() {
    if (!isEmbeddedChatgptFrame()) {
      return;
    }
    const sendButtonSelector = SEND_BUTTON_SELECTORS.chatgpt.join(', ');
    const captureFromEditor = () => {
      const editor = findProviderInput('chatgpt');
      const text = readChatgptEditorText(editor);
      if (!text.trim()) {
        return;
      }
      const startHref = window.location.href;
      const wasBusyBeforeSend = Boolean(findChatgptBusyButton());
      setTimeout(() => confirmAndRecordChatgptSend(text, startHref, { wasBusyBeforeSend }), 0);
    };

    document.addEventListener('click', (event) => {
      const target = event?.target;
      if (!(target instanceof Element)) return;
      const sendButton = target.closest(sendButtonSelector);
      if (!sendButton || !isProviderSendControlEnabled('chatgpt', sendButton)) return;
      const composerForm = getChatgptComposer()?.findForm();
      if (composerForm && sendButton.closest('form') !== composerForm) return;
      captureFromEditor();
    }, true);

    document.addEventListener('submit', (event) => {
      const composerForm = getChatgptComposer()?.findForm();
      if (composerForm && event?.target !== composerForm) return;
      captureFromEditor();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (
        !event ||
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      ) {
        return;
      }
      const editor = findProviderInput('chatgpt');
      if (!editor) return;
      const target = event.target;
      if (target !== editor && !(target instanceof Node && editor.contains(target))) {
        return;
      }
      captureFromEditor();
    }, true);
  }

  function resumePendingChatgptNewChatComposerClear() {
    if (!isEmbeddedChatgptFrame()) {
      return;
    }

    let rawTimestamp = null;
    try {
      rawTimestamp = window.sessionStorage?.getItem(CHATGPT_PENDING_NEW_CHAT_CLEAR_KEY) || null;
    } catch (error) {
      rawTimestamp = null;
    }

    if (rawTimestamp !== null) {
      const timestamp = Number(rawTimestamp);
      const deadlineMs = timestamp + CHATGPT_PENDING_NEW_CHAT_CLEAR_TTL_MS;
      if (!Number.isFinite(timestamp) || Date.now() >= deadlineMs) {
        clearPendingChatgptNewChatComposerClearMarker();
      } else {
        scheduleChatgptNewChatComposerClear({
          waitForMountUntilMs: deadlineMs,
          consumeReloadMarkerOnMount: true
        });
        return;
      }
    }

    scheduleChatgptSentDraftReloadClear();
  }

  // Find and click new chat button
  function clickNewChatButton(provider, providerMode = null, options = {}) {
    // Special handling for Google
    if (provider === 'google') {
      return handleGoogleNewSearch(providerMode);
    }

    // Special handling for AI Studio: navigate directly to /prompts/new_chat(?temporary=true)
    // to bypass the <ms-confirm-clear-dialog> modal triggered by in-page clear buttons
    // when a prompt has unsaved or temporary turns.
    if (provider === 'aistudio') {
      return handleAiStudioNewChat(options);
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

    // Fallback: Try to find any visible, enabled link or button containing "new" text.
    // Never click hidden or collapsed sidebar controls (e.g. narrow ChatGPT's unmounted
    // desktop Octane link, which throws "Home navigation identity unavailable").
    try {
      const allButtons = document.querySelectorAll('button, a, div[role="button"]');
      for (const elem of allButtons) {
        if (!isVisibleElement(elem) || !isElementEnabled(elem) || !isSameOriginNewChatCandidate(elem)) {
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
      const geminiAccountPrefix = provider === 'gemini' ? getCurrentGoogleAccountPrefix() : '';
      const resolvedFallbackUrl = (provider === 'chatgpt' && options?.temporaryChat === true)
        ? 'https://chatgpt.com/?temporary-chat=true'
        : (geminiAccountPrefix ? `https://gemini.google.com${geminiAccountPrefix}/app` : fallbackUrl);
      if (provider === 'chatgpt') {
        clearChatgptComposerDraftOnce();
        markPendingChatgptNewChatComposerClear();
      }
      console.log('[Text Injection] Using fallback URL for new chat:', resolvedFallbackUrl);
      if (resolvedFallbackUrl.startsWith('http')) {
        window.location.href = resolvedFallbackUrl;
      } else {
        window.location.href = window.location.origin + resolvedFallbackUrl;
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
          document.dispatchEvent(new Event('selectionchange'));
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

        if (provider === 'kimi' || element.getAttribute('data-lexical-editor') === 'true') {
          // Kimi's Lexical editor reconciles `beforeinput` asynchronously on microtasks;
          // Chromium's synchronous `execCommand('insertText')` splits multiline text on `\n`
          // and drops lines during long prompts. Dispatching a cancelable `paste` event lets
          // Lexical insert the full text atomically, falling back cleanly when unhandled.
          try {
            if (typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
              const beforeText = element.textContent || '';
              const dataTransfer = new DataTransfer();
              dataTransfer.setData('text/plain', text);
              const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: dataTransfer
              });
              if (!pasteEvent.clipboardData) {
                Object.defineProperty(pasteEvent, 'clipboardData', {
                  configurable: true,
                  value: dataTransfer
                });
              }
              element.dispatchEvent(pasteEvent);
              if (pasteEvent.defaultPrevented) {
                queueMicrotask(() => {
                  if ((element.textContent || '') !== beforeText) {
                    return;
                  }
                  let fallbackInserted = false;
                  try {
                    fallbackInserted = document.execCommand('insertText', false, text);
                  } catch {
                    // Ignore unsupported execCommand fallback
                  }
                  if (!fallbackInserted && (element.textContent || '') === beforeText) {
                    element.appendChild(document.createTextNode(text));
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                });
                return true;
              }
            }
          } catch (e) {
            // Fall through to execCommand / DOM insertion if synthetic paste is unavailable
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

  const CONTENTEDITABLE_BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'
  ]);

  function readContentEditableBlockText(root) {
    if (!root) {
      return '';
    }

    const extractInline = (node) => {
      if (!node) return '';
      if (node.nodeType === 3) {
        return node.nodeValue || '';
      }
      if (node.nodeType !== 1) {
        return '';
      }
      if (node.tagName === 'BR') {
        return '\n';
      }
      let out = '';
      for (const child of node.childNodes) {
        out += extractInline(child);
      }
      return out;
    };

    const children = [...(root.childNodes || [])];
    const hasBlockChild = children.some(
      child => child.nodeType === 1 && CONTENTEDITABLE_BLOCK_TAGS.has(child.tagName)
    );
    if (!hasBlockChild) {
      return extractInline(root).replace(/\r\n/g, '\n');
    }

    const lines = [];
    let inlineBuffer = '';
    const flushInline = () => {
      if (inlineBuffer.length > 0) {
        lines.push(inlineBuffer.replace(/\n$/, ''));
        inlineBuffer = '';
      }
    };

    for (const child of children) {
      if (child.nodeType === 1 && CONTENTEDITABLE_BLOCK_TAGS.has(child.tagName)) {
        flushInline();
        const rawBlock = extractInline(child).replace(/\r\n/g, '\n');
        // Empty paragraph `<p><br></p>` represents a single blank line `''`
        lines.push(rawBlock === '\n' ? '' : rawBlock.replace(/\n$/, ''));
      } else {
        inlineBuffer += extractInline(child);
      }
    }
    flushInline();
    return lines.join('\n');
  }

  // Helper function to inject text into provider's input field
  function inputEndsWithText(element, text) {
    if (!element || typeof text !== 'string') {
      return false;
    }
    const isFormControl = element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';
    const currentText = isFormControl ? element.value : element.textContent;
    if (typeof currentText === 'string' && currentText.endsWith(text)) {
      return true;
    }
    if (isFormControl) {
      return false;
    }
    const normalizedTarget = text.replace(/\r\n/g, '\n').trimEnd();
    if (!normalizedTarget) {
      return false;
    }
    const blockText = readContentEditableBlockText(element).trimEnd();
    if (blockText.endsWith(normalizedTarget)) {
      return true;
    }
    return blockText.replace(/\n+/g, '\n').endsWith(normalizedTarget.replace(/\n+/g, '\n'));
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
          scheduleAutoSubmit(provider, providerMode);
        }
        return true;
      }
    }

    console.warn('[Text Injection] No input element found for provider:', provider);
    return false;
  }

  function getComposerRootForAttachmentCheck(provider, input) {
    if (provider === 'chatgpt') {
      return getChatgptComposerForm() || input?.closest?.('form') || input?.parentElement || null;
    }
    if (provider === 'deepseek') return getDeepSeekComposer();
    if (provider === 'kimi') return getKimiComposer();
    if (provider === 'grok') return getGrokComposer();
    if (provider === 'yuanbao') return getYuanbaoComposer();
    if (provider === 'gemini') return getGeminiComposerRoot(input);
    if (provider === 'qwen-global') return getQwenGlobalComposerRoot(input);
    if (provider === 'chatglm') {
      return input?.closest?.('.input-area, #search-input-box') || input?.parentElement || null;
    }
    return input?.closest?.('form, ms-prompt-box, .input-area-container, .chat-editor, #chat-box') ||
      input?.parentElement ||
      null;
  }

  function isProviderComposerCleared(provider, candidateImages = [], providerMode = null) {
    const input = provider === 'google'
      ? findGoogleInput(providerMode)
      : findProviderInput(provider);
    if (!input) {
      return false;
    }

    const isFormControl = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT';
    const currentText = isFormControl ? (input.value || '') : (input.textContent || '');
    if (currentText.trim().length > 0) {
      return false;
    }

    const composerRoot = getComposerRootForAttachmentCheck(provider, input);
    // Gemini and Qwen Global run their own rejection-filtered checks below, so an
    // "Upload failed: paper.pdf" alert is never mistaken for a staged attachment.
    // ChatGLM's GLM-5.4 picker wrapper also names errored cards, so it runs its own check too.
    // ChatGPT's check also matches duplicate-suffixed names ("Mizuho(4).png").
    const usesFilteredPreviewCheck = provider === 'gemini' ||
      provider === 'qwen-global' ||
      provider === 'chatglm' ||
      provider === 'chatgpt';
    if (
      composerRoot &&
      !usesFilteredPreviewCheck &&
      (candidateImages || []).some(img => img?.name && countFilenamePreviewEvidence(composerRoot, img.name) > 0)
    ) {
      return false;
    }

    if (provider === 'deepseek') {
      if (
        composerRoot &&
        (composerRoot.querySelectorAll('img[src^="blob:"]').length > 0 ||
          composerRoot.querySelectorAll('[class*="file-card"], [class*="attachment"], [data-file-name], [data-filename]').length > 0 ||
          [...composerRoot.querySelectorAll('.ds-animated-size-item')].some(
            item => (item.textContent || '').trim().length > 0 || Boolean(item.querySelector('img'))
          ) ||
          (candidateImages || []).some(
            img => img?.name && countDeepSeekCardPreviews(composerRoot, img.name, { scopeToComposerOnly: true }) > 0
          ))
      ) {
        return false;
      }
    } else if (provider === 'kimi') {
      if (
        composerRoot &&
        (countKimiAttachmentPreviews(composerRoot) > 0 ||
          countKimiPendingAttachmentPreviews(composerRoot) > 0 ||
          countKimiDocumentPreviews(composerRoot) > 0)
      ) {
        return false;
      }
    } else if (provider === 'grok') {
      if (
        countGrokAttachmentContainerItems(composerRoot, { scopeToComposerOnly: true }) > 0 ||
        (candidateImages || []).some(
          img => img?.name && countGrokAttachmentFilenameEvidence(composerRoot, img.name, { scopeToComposerOnly: true }) > 0
        )
      ) {
        return false;
      }
    } else if (provider === 'yuanbao') {
      if ((candidateImages || []).some(img => img?.name && countYuanbaoCompletedPreviews(img.name, img) > 0)) {
        return false;
      }
    } else if (provider === 'gemini') {
      if (
        composerRoot &&
        (countGeminiAttachmentPreviews(composerRoot, null, { excludeRejectionUi: true }) > 0 ||
          (candidateImages || []).some(
            img => img?.name && countGeminiAttachmentPreviews(composerRoot, img, { excludeRejectionUi: true }) > 0
          ))
      ) {
        return false;
      }
    } else if (provider === 'chatglm') {
      if (countChatGLMStagedAttachments(composerRoot, candidateImages) > 0) {
        return false;
      }
    } else if (provider === 'chatgpt') {
      if (countChatgptStagedAttachmentCards(composerRoot, candidateImages) > 0) {
        return false;
      }
    } else if (provider === 'qwen-global') {
      if (
        composerRoot &&
        (countQwenAttachmentPreviews('qwen-global', '', { root: composerRoot }) > 0 ||
          (candidateImages || []).some(
            img => img?.name && countQwenAttachmentPreviews('qwen-global', img.name, { root: composerRoot }) > 0
          ))
      ) {
        return false;
      }
    }

    return true;
  }

  const PARTIAL_RETRY_PROVIDERS = new Set(['gemini', 'chatglm', 'yuanbao', 'chatgpt']);

  /**
   * On a retry with an empty editor, splits fallback attachments into the ones still
   * staged in the composer (Gemini chips, ChatGLM GLM-5.4 cards, Yuanbao FileList cards,
   * ChatGPT composer attachment cards) and the ones that must be re-delivered. Returns
   * null when the regular all-or-nothing retry decision applies.
   */
  function getPartialRetryPlan(provider, fallbackAttachments) {
    if (!PARTIAL_RETRY_PROVIDERS.has(provider)) {
      return null;
    }
    const input = findProviderInput(provider);
    if (!input) {
      return null;
    }
    const isFormControl = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT';
    const currentText = isFormControl ? (input.value || '') : (input.textContent || '');
    if (currentText.trim().length > 0) {
      return null;
    }
    if (provider === 'gemini') {
      const { chipCount, retained, missing } = reconcileGeminiRetainedAttachments(
        getGeminiComposerRoot(input),
        fallbackAttachments
      );
      if (chipCount === 0 || missing.length === 0) {
        return null;
      }
      return { retained, missing };
    }
    let retained = [];
    let missing = [];
    if (provider === 'chatgpt') {
      const composerRoot = getComposerRootForAttachmentCheck(provider, input);
      (fallbackAttachments || []).forEach(attachment => {
        const isStaged = Boolean(attachment?.name) &&
          countChatgptNamedAttachmentPreviews(composerRoot, attachment.name) > 0;
        (isStaged ? retained : missing).push(attachment);
      });
      // The composer still holds other cards (so it is not "cleared"), but none of
      // the fallback attachments: re-deliver all of them instead of acknowledging.
      return missing.length > 0 ? { retained, missing } : null;
    }
    if (provider === 'chatglm') {
      if (!hasChatGLMGlm54UploadList()) {
        return null;
      }
      ({ retained, missing } = reconcileChatGLMRetainedAttachments(
        getComposerRootForAttachmentCheck(provider, input),
        fallbackAttachments
      ));
    } else {
      (fallbackAttachments || []).forEach(attachment => {
        const isStaged = Boolean(attachment?.name) && countYuanbaoCompletedPreviews(attachment.name, attachment) > 0;
        (isStaged ? retained : missing).push(attachment);
      });
    }
    if (retained.length === 0 || missing.length === 0) {
      return null;
    }
    return { retained, missing };
  }

  // Handle image & document injection message
  async function handleImageInjection(event) {
    const {
      text,
      images,
      fallbackImages,
      attachments,
      fallbackAttachments,
      autoSubmit,
      requestId,
      retry = false
    } = event.data;
    const hasAttachmentProtocol = Array.isArray(attachments);
    const incomingAttachments = hasAttachmentProtocol ? attachments : images;
    const incomingFallback = Array.isArray(fallbackAttachments) ? fallbackAttachments : fallbackImages;
    const provider = detectProvider();
    const providerMode = provider === 'google'
      ? normalizeGoogleProviderMode(event.data.providerMode)
      : null;

    if (!provider) {
      console.warn('[Image Injection] Provider not detected');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND, [], undefined, {
        includeAttachmentProtocol: hasAttachmentProtocol
      });
    }

    const toSkippedList = (items, reason = IMAGE_INJECTION_REASONS.UNSUPPORTED) =>
      (Array.isArray(items) ? items : []).map(item => ({
        ...(item?.id ? { id: item.id } : {}),
        name: item?.name || 'attachment',
        reason
      }));

    if (provider === 'google' && providerMode === GOOGLE_PROVIDER_MODE_SEARCH) {
      console.warn('[Image Injection] Google Search mode does not support attachments, skipping');
      const hasText = Boolean(text && text.trim());
      const skippedAttachments = toSkippedList(incomingAttachments, IMAGE_INJECTION_REASONS.UNSUPPORTED);
      if (hasText) {
        // Retry-aware: a Retry Failed must not append the caption a second time.
        const textInjected = injectText(
          provider,
          text,
          autoSubmit,
          providerMode,
          { skipIfAlreadyPresent: Boolean(retry) }
        );
        if (!textInjected) {
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND, [], undefined, {
            includeAttachmentProtocol: hasAttachmentProtocol,
            skippedAttachments
          });
        }
      }
      return hasText
        ? createImageInjectionSuccess([], {
          includeAttachmentProtocol: true,
          skippedAttachments
        })
        : createImageInjectionSkipped(IMAGE_INJECTION_REASONS.UNSUPPORTED, skippedAttachments);
    }

    if (!PROVIDER_IMAGE_SUPPORT[provider]) {
      console.warn('[Image Injection] Provider does not support attachments:', provider);
      const hasText = Boolean(text && text.trim());
      if (hasText) {
        injectText(provider, text, autoSubmit, providerMode);
      }
      const skippedAttachments = toSkippedList(incomingAttachments, IMAGE_INJECTION_REASONS.UNSUPPORTED);
      return hasText
        ? createImageInjectionSuccess([], {
          includeAttachmentProtocol: true,
          skippedAttachments
        })
        : createImageInjectionSkipped(IMAGE_INJECTION_REASONS.UNSUPPORTED, skippedAttachments);
    }

    const normalizedFallbackAttachments = Array.isArray(incomingFallback) ? incomingFallback : [];
    const fallbackSucceededIds = normalizedFallbackAttachments
      .map(att => att?.id)
      .filter(id => typeof id === 'string');
    const composerClearedOnRetry = Boolean(
      retry &&
      normalizedFallbackAttachments.length > 0 &&
      isProviderComposerCleared(provider, normalizedFallbackAttachments, providerMode)
    );
    // Gemini, ChatGLM and Yuanbao: retained previews are reconciled with fallback
    // attachments, so a surviving preview never acknowledges attachments that are no
    // longer staged.
    const partialRetryPlan = Boolean(
      retry &&
      !composerClearedOnRetry &&
      normalizedFallbackAttachments.length > 0
    )
      ? getPartialRetryPlan(provider, normalizedFallbackAttachments)
      : null;
    const toAttachmentIds = (items) => items.map(att => att?.id).filter(id => typeof id === 'string');
    const effectiveAttachments = composerClearedOnRetry
      ? normalizedFallbackAttachments
      : (partialRetryPlan ? partialRetryPlan.missing : incomingAttachments);
    const effectiveRetry = composerClearedOnRetry || partialRetryPlan ? false : retry;
    const failureAttemptedIds = composerClearedOnRetry
      ? toAttachmentIds(effectiveAttachments)
      : (partialRetryPlan ? fallbackSucceededIds : undefined);

    if (!effectiveAttachments || effectiveAttachments.length === 0) {
      if (retry && text && text.trim()) {
        const textInjected = injectText(
          provider,
          text,
          autoSubmit,
          providerMode,
          { skipIfAlreadyPresent: true }
        );
        return textInjected
          ? createImageInjectionSuccess(fallbackSucceededIds, {
            includeAttachmentProtocol: hasAttachmentProtocol
          })
          : createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND, [], undefined, {
            includeAttachmentProtocol: hasAttachmentProtocol
          });
      }
      if (retry && normalizedFallbackAttachments.length > 0) {
        return createImageInjectionSuccess(fallbackSucceededIds, {
          includeAttachmentProtocol: hasAttachmentProtocol
        });
      }
      console.warn('[Image Injection] No attachments provided');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR, [], undefined, {
        includeAttachmentProtocol: hasAttachmentProtocol
      });
    }

    console.log(`[Image Injection] Injecting ${effectiveAttachments.length} attachment(s) to ${provider}`);

    try {
      // Fills protect the unified input's focus too, so report a click in
      // the panel to hand focus back to the user.
      if (requestId) {
        startMultiPanelUserInteractionTracking(requestId, provider);
      } else {
        stopMultiPanelUserInteractionTracking();
      }

      if ((provider === 'chatgpt' || provider === 'aistudio') && autoSubmit && requestId) {
        startChatgptSendTracking(requestId, provider);
      }

      const succeededAttachmentIds = partialRetryPlan ? toAttachmentIds(partialRetryPlan.retained) : [];
      const skippedAttachments = [];
      const attachmentResults = [];

      // Inject attachments sequentially
      for (const attachment of effectiveAttachments) {
        const result = await injectSingleImage(provider, attachment, { retry: effectiveRetry });
        attachmentResults.push(result);
        if (result.skipped) {
          skippedAttachments.push({
            ...(attachment?.id ? { id: attachment.id } : {}),
            name: attachment?.name || 'attachment',
            reason: result.reason || IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED
          });
          continue;
        }
        if (result.ok) {
          if (attachment.id && typeof attachment.id === 'string') {
            succeededAttachmentIds.push(attachment.id);
          }
        } else {
          break;
        }
        // Wait a bit between attachments
        await sleep(200);
      }
      if (partialRetryPlan) {
        succeededAttachmentIds.sort((a, b) => fallbackSucceededIds.indexOf(a) - fallbackSucceededIds.indexOf(b));
      }

      const firstFailure = attachmentResults.find(result => !result.ok && !result.skipped);
      const allNonSkippedInjected = !firstFailure && attachmentResults.length === effectiveAttachments.length;
      const allAttachmentsSkipped =
        allNonSkippedInjected &&
        skippedAttachments.length === effectiveAttachments.length &&
        succeededAttachmentIds.length === 0;

      if (!allNonSkippedInjected) {
        console.warn('[Image Injection] One or more attachments failed to inject for:', provider);
      }

      if (!allAttachmentsSkipped) {
        // Wait for uploads to settle
        await sleep(500);
      }

      // Then inject text if provided
      const hasText = Boolean(text && text.trim());
      let textInjected = true;
      if (hasText) {
        if (!allAttachmentsSkipped) {
          await sleep(300);
        }
        textInjected = injectText(
          provider,
          text,
          autoSubmit && allNonSkippedInjected,
          providerMode,
          { skipIfAlreadyPresent: effectiveRetry }
        );
      } else if (autoSubmit) {
        if (!allNonSkippedInjected) {
          console.warn('[Image Injection] Skipping auto-submit because attachment injection failed for:', provider);
          return createImageInjectionFailure(
            firstFailure?.reason || IMAGE_INJECTION_REASONS.INJECTION_ERROR,
            succeededAttachmentIds,
            failureAttemptedIds,
            { includeAttachmentProtocol: hasAttachmentProtocol, skippedAttachments }
          );
        }
        if (!allAttachmentsSkipped) {
          await sleep(300);
          clickSendButton(provider, providerMode);
        }
      }

      if (!allNonSkippedInjected) {
        return createImageInjectionFailure(
          firstFailure?.reason || IMAGE_INJECTION_REASONS.INJECTION_ERROR,
          succeededAttachmentIds,
          failureAttemptedIds,
          { includeAttachmentProtocol: hasAttachmentProtocol, skippedAttachments }
        );
      }

      if (!textInjected) {
        return createImageInjectionFailure(
          IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND,
          succeededAttachmentIds,
          failureAttemptedIds,
          { includeAttachmentProtocol: hasAttachmentProtocol, skippedAttachments }
        );
      }

      if (allAttachmentsSkipped && !hasText) {
        return createImageInjectionSkipped(
          skippedAttachments[0]?.reason || IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED,
          skippedAttachments
        );
      }

      return createImageInjectionSuccess(succeededAttachmentIds, {
        includeAttachmentProtocol: hasAttachmentProtocol || skippedAttachments.length > 0,
        skippedAttachments
      });
    } catch (error) {
      console.error('[Image Injection] Error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR, [], failureAttemptedIds, {
        includeAttachmentProtocol: hasAttachmentProtocol
      });
    }
  }

  function createImageInjectionSuccess(succeededImageIds = [], options = {}) {
    return {
      ok: true,
      succeededImageIds,
      ...(options.includeAttachmentProtocol ? { includeAttachmentProtocol: true } : {}),
      ...(Array.isArray(options.skippedAttachments) && options.skippedAttachments.length > 0
        ? { skippedAttachments: options.skippedAttachments }
        : {})
    };
  }

  function createImageInjectionSkipped(reason = IMAGE_INJECTION_REASONS.UNSUPPORTED, skippedAttachments = []) {
    return {
      ok: true,
      skipped: true,
      reason,
      succeededImageIds: [],
      includeAttachmentProtocol: true,
      ...(Array.isArray(skippedAttachments) && skippedAttachments.length > 0
        ? { skippedAttachments }
        : {})
    };
  }

  function createImageInjectionFailure(reason, succeededImageIds = [], attemptedImageIds = undefined, options = {}) {
    return {
      ok: false,
      reason,
      succeededImageIds,
      ...(Array.isArray(attemptedImageIds) ? { attemptedImageIds } : {}),
      ...(options.includeAttachmentProtocol ? { includeAttachmentProtocol: true } : {}),
      ...(Array.isArray(options.skippedAttachments) && options.skippedAttachments.length > 0
        ? { skippedAttachments: options.skippedAttachments }
        : {})
    };
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
        result = await injectImageToChatGPT(imageData, { retry });
        break;
      case 'claude':
        result = await injectImageToClaude(imageData);
        break;
      case 'gemini':
        result = await injectImageToGemini(imageData);
        break;
      case 'aistudio':
        result = await injectImageToAiStudio(imageData);
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

  const ATTACHMENT_EXTENSION_TO_MIME = Object.freeze({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.xml': 'application/xml',
    '.tsv': 'text/tab-separated-values',
    '.log': 'text/plain'
  });

  function getAttachmentExtension(fileOrMeta) {
    if (typeof fileOrMeta?.ext === 'string' && /^\.[a-z0-9]+$/i.test(fileOrMeta.ext.trim())) {
      return fileOrMeta.ext.trim().toLowerCase();
    }
    const name = typeof fileOrMeta?.name === 'string' ? fileOrMeta.name.trim() : '';
    const dotIdx = name.lastIndexOf('.');
    return dotIdx > 0 && dotIdx < name.length - 1 ? name.slice(dotIdx).toLowerCase() : '';
  }

  function isDocumentAttachmentData(item) {
    if (!item || typeof item !== 'object') {
      return false;
    }
    if (item.kind === 'document') {
      return true;
    }
    if (item.kind === 'image') {
      return false;
    }
    const mime = String(item.type || '').split(';')[0].trim().toLowerCase();
    if (mime.startsWith('image/')) {
      return false;
    }
    if (typeof item.dataUrl === 'string' && /^data:image\//i.test(item.dataUrl)) {
      return false;
    }
    return Boolean(item.bytes || typeof item.textContent === 'string' || mime);
  }

  function getPreviewTimeoutMs(attachmentData) {
    return isDocumentAttachmentData(attachmentData)
      ? DOCUMENT_UPLOAD_PREVIEW_TIMEOUT_MS
      : IMAGE_UPLOAD_PREVIEW_TIMEOUT_MS;
  }

  function matchesInputAccept(fileInput, fileOrMeta) {
    if (!fileInput || !fileOrMeta) {
      return false;
    }
    const acceptAttr = String(fileInput.getAttribute?.('accept') ?? fileInput.accept ?? '').trim();
    if (!acceptAttr) {
      return true;
    }
    const fileExt = getAttachmentExtension(fileOrMeta);
    let fileMime = String(fileOrMeta.type || '').split(';')[0].trim().toLowerCase();
    if (!fileMime && fileExt && ATTACHMENT_EXTENSION_TO_MIME[fileExt]) {
      fileMime = ATTACHMENT_EXTENSION_TO_MIME[fileExt];
    }

    const tokens = acceptAttr
      .split(',')
      .map(token => token.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) {
      return true;
    }

    for (const token of tokens) {
      if (token === '*/*') {
        return true;
      }
      if (token.startsWith('.')) {
        if (fileExt && fileExt === token) {
          return true;
        }
        if (!fileExt && fileMime && ATTACHMENT_EXTENSION_TO_MIME[token] === fileMime) {
          return true;
        }
        continue;
      }
      if (token.endsWith('/*')) {
        const prefix = token.slice(0, -1);
        if (fileMime && fileMime.startsWith(prefix)) {
          return true;
        }
        continue;
      }
      const normalizedToken = token.split(';')[0].trim();
      if (normalizedToken && fileMime && fileMime === normalizedToken) {
        return true;
      }
    }
    return false;
  }

  function acceptsImageFiles(fileInput) {
    const accept = (fileInput?.getAttribute('accept') || '').toLowerCase();
    return !accept || accept.includes('image/') || [
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.apng'
    ].some(extension => accept.includes(extension));
  }

  function acceptsAttachmentFile(fileInput, attachmentData) {
    if (!fileInput) {
      return false;
    }
    if (!attachmentData) {
      return acceptsImageFiles(fileInput);
    }
    return matchesInputAccept(fileInput, attachmentData);
  }

  function toLocalUint8Array(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object ArrayBuffer]' || value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (
      ArrayBuffer.isView(value) ||
      (value.buffer && typeof value.byteLength === 'number' && typeof value.byteOffset === 'number')
    ) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  async function createAttachmentFile(attachmentData) {
    const fileName = attachmentData?.name || 'attachment';
    const fileExt = getAttachmentExtension(attachmentData);
    const mimeType = (attachmentData?.type || '').trim() || ATTACHMENT_EXTENSION_TO_MIME[fileExt] || 'application/octet-stream';

    const localBytes = toLocalUint8Array(attachmentData?.bytes);
    if (localBytes) {
      return new File([localBytes], fileName, { type: mimeType });
    }
    if (typeof attachmentData?.textContent === 'string' && isDocumentAttachmentData(attachmentData)) {
      return new File([attachmentData.textContent], fileName, { type: mimeType });
    }
    const blob = await dataUrlToBlob(attachmentData.dataUrl);
    return new File([blob], fileName, { type: mimeType || blob.type });
  }

  async function createImageFile(imageData) {
    return createAttachmentFile(imageData);
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

  const REJECTION_UI_SELECTOR = [
    '[role="alert"]',
    '[role="alertdialog"]',
    '[role="status"]',
    '[aria-live="assertive"]',
    '[class*="toast"]',
    '[class*="snackbar"]',
    '[class*="snack-bar"]',
    'mat-snack-bar-container',
    'simple-snack-bar',
  ].join(', ');
  const REJECTION_TEXT_RE =
    /\b(?:fail(?:ed|ure|s)?|errors?|unsupported|not supported|rejected|unable|cannot|can't|couldn't|could not|too large)\b/i;

  function getAttachmentFileNameStem(fileName) {
    const trimmed = (fileName || '').trim();
    const dotIdx = trimmed.lastIndexOf('.');
    if (dotIdx <= 0 || dotIdx >= trimmed.length - 1) {
      return '';
    }
    const ext = trimmed.slice(dotIdx).toLowerCase();
    if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) {
      return '';
    }
    return trimmed.slice(0, dotIdx).trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Matches a filename stem only as a standalone token, so the stem "a" of
   * "a.pdf" never matches inside words such as "failed".
   */
  function createFileNameTokenRegExp(token, flags = 'u') {
    if (!token) {
      return null;
    }
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(token)}(?![\\p{L}\\p{N}_])`, flags);
  }

  function containsFileNameToken(text, token) {
    const re = createFileNameTokenRegExp(token);
    return Boolean(re && text && re.test(text));
  }

  /**
   * True when an element is page-level rejection UI (alerts, status toasts,
   * snackbars) or carries failure wording beyond the file name itself, so an
   * "Upload failed: paper.pdf" banner never counts as an attachment preview.
   */
  function isRejectionUiElement(element, normalizedName) {
    if (element.closest(REJECTION_UI_SELECTOR)) {
      return true;
    }
    const ownText = [
      getElementAccessibleText(element),
      (element.getAttribute('data-file-name') || '').toLowerCase(),
      (element.getAttribute('data-filename') || '').toLowerCase(),
    ].join(' ');
    let withoutName = normalizedName ? ownText.split(normalizedName).join(' ') : ownText;
    const normalizedStem = normalizedName ? getAttachmentFileNameStem(normalizedName).toLowerCase() : '';
    const stemRe = createFileNameTokenRegExp(normalizedStem, 'gu');
    if (stemRe) {
      withoutName = withoutName.replace(stemRe, ' ');
    }
    return REJECTION_TEXT_RE.test(withoutName);
  }

  function countFilenamePreviewEvidence(root, fileName, { excludeRejectionUi = false } = {}) {
    if (!root) {
      return 0;
    }

    const normalizedName = (fileName || '').trim().toLowerCase();
    if (!normalizedName) {
      return 0;
    }
    const evidence = new Set();

    root.querySelectorAll(
      'img[alt], button, [role="button"], [aria-label], [title], [data-file-name], [data-filename], [class*="file"], [class*="attachment"], [class*="chip"], [role="listitem"]'
    ).forEach(element => {
      if (element.closest('textarea, input, [contenteditable="true"]')) {
        return;
      }
      if (excludeRejectionUi && isRejectionUiElement(element, normalizedName)) {
        return;
      }
      const alt = (element.getAttribute('alt') || '').trim().toLowerCase();
      const fileNameData = (
        element.getAttribute('data-file-name') ||
        element.getAttribute('data-filename') ||
        ''
      ).trim().toLowerCase();
      const accessibleText = getElementAccessibleText(element);
      const isFileElement = element.matches('[class*="file"], [class*="attachment"], [class*="chip"], [role="listitem"]');
      const smallText = isFileElement && (element.textContent || '').length <= 240
        ? (element.textContent || '').trim().toLowerCase()
        : '';
      if (
        alt === normalizedName ||
        fileNameData === normalizedName ||
        accessibleText.includes(normalizedName) ||
        (smallText && smallText.includes(normalizedName))
      ) {
        evidence.add(element.closest('button, [role="button"], [role="listitem"]') || element);
      }
    });

    return evidence.size;
  }

  function getProviderImageKey(provider, imageData) {
    const imageKey = imageData?.id && typeof imageData.id === 'string'
      ? imageData.id
      : `${imageData?.name || ''}\u0000${imageData?.type || ''}\u0000${imageData?.dataUrl || imageData?.size || ''}`;
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
      pendingUpload.previousCount,
      getPreviewTimeoutMs(imageData)
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

  function findYuanbaoFileInput(attachmentData = null) {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    return inputs.find(input => input.multiple && acceptsAttachmentFile(input, attachmentData)) ||
      inputs.find(input => acceptsAttachmentFile(input, attachmentData)) ||
      null;
  }

  // Card roots only: the double underscore excludes Name/Info/Status/Retry child elements.
  const YUANBAO_FILE_LIST_ITEM_SELECTOR = '[class*="FileList_inputFileListItem__"]';
  const YUANBAO_FILE_LIST_ITEM_RETRY_SELECTOR = '[class*="FileList_inputFileListItemRetry__"]';

  function getYuanbaoFileListRoot() {
    return document.querySelector('[data-input-resource-area]') || document;
  }

  /** True when `element` and its ancestors up to `boundary` are rendered (no display:none / visibility:hidden). */
  function isRenderedWithin(element, boundary) {
    if (typeof window.getComputedStyle !== 'function') {
      return true;
    }
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false;
      }
      if (node === boundary) {
        break;
      }
    }
    return true;
  }

  /**
   * Every Yuanbao card embeds a "Re-upload" retry overlay that stays display:none while the
   * upload is fine, so a card only counts as failed when that overlay is actually rendered.
   */
  function isYuanbaoFileListItemSettled(item) {
    const cls = String(item.className || '').toLowerCase();
    if (cls.includes('loading') || cls.includes('uploading') || cls.includes('error')) {
      return false;
    }
    return ![...item.querySelectorAll(YUANBAO_FILE_LIST_ITEM_RETRY_SELECTOR)]
      .some(retry => isRenderedWithin(retry, item));
  }

  /** Document cards render the name without its extension plus an uppercase type badge. */
  function yuanbaoDocumentItemMatchesName(item, normalizedName) {
    const title = (item.getAttribute('title') || '').trim().toLowerCase();
    const dataName = (item.getAttribute('data-file-name') || item.getAttribute('data-filename') || '').trim().toLowerCase();
    if (title === normalizedName || dataName === normalizedName) {
      return true;
    }
    const nameEl = item.querySelector('[class*="FileList_inputFileListItemPdfInfoName__"]');
    if (!nameEl) {
      return (item.textContent || '').trim().toLowerCase().includes(normalizedName);
    }
    const label = (nameEl.getAttribute('title') || nameEl.textContent || '').trim().toLowerCase();
    if (label === normalizedName) {
      return true;
    }
    const stem = getAttachmentFileNameStem(normalizedName).toLowerCase();
    if (!stem || label !== stem) {
      return false;
    }
    // "sample.pdf" and "sample.txt" share a stem, so the type badge must agree when shown.
    const badge = (item.querySelector('[class*="FileList_fileType__"]')?.textContent || '').trim().toLowerCase();
    return !badge || badge === normalizedName.slice(stem.length + 1);
  }

  function yuanbaoImageItemMatchesName(item, normalizedName) {
    const hostedImages = [...item.querySelectorAll('img')]
      .filter(image => /^https:\/\//.test(image.getAttribute('src') || ''));
    if (hostedImages.length === 0) {
      return false;
    }
    const ariaLabel = (item.getAttribute('aria-label') || '').trim().toLowerCase();
    return (Boolean(normalizedName) && ariaLabel.endsWith(normalizedName)) ||
      hostedImages.some(image => (image.getAttribute('alt') || '').trim().toLowerCase() === normalizedName);
  }

  function countYuanbaoCompletedPreviews(fileName, attachmentData = null) {
    const normalizedName = (fileName || '').trim().toLowerCase();
    if (!normalizedName) {
      return 0;
    }
    const isDoc = isDocumentAttachmentData(attachmentData);
    return [...getYuanbaoFileListRoot().querySelectorAll(YUANBAO_FILE_LIST_ITEM_SELECTOR)]
      .filter(item => isYuanbaoFileListItemSettled(item) && (isDoc
        ? yuanbaoDocumentItemMatchesName(item, normalizedName)
        : yuanbaoImageItemMatchesName(item, normalizedName)))
      .length;
  }

  function closeYuanbaoAddMenu() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  }

  /**
   * Yuanbao keeps its `<input type="file">` mounted after an upload, but the input's change
   * handler is one-shot: a mounted input is silently ignored until Add -> "Local Files" /
   * "Upload Image" is clicked again. Every file therefore goes through this menu click.
   */
  async function openYuanbaoImagePicker(composer, attachmentData = null) {
    const menuLabels = isDocumentAttachmentData(attachmentData)
      ? ['Local Files', 'Upload File', 'Add File', '本地文件', '上传文件', '添加文件']
      : ['Upload Image', '上传图片'];
    const findUploadAction = () => findVisibleElementByExactText('button, [role="menuitem"]', menuLabels);

    // Clicking the trigger while its menu is already open could toggle the menu shut.
    let uploadAction = findUploadAction();
    if (!uploadAction) {
      const addButton = composer?.querySelector('[data-new-input-control="add-tools-trigger"]') ||
        findFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.yuanbao);
      if (!addButton) {
        return null;
      }
      addButton.click();
      await sleep(100);
      uploadAction = findUploadAction();
    }
    if (!uploadAction) {
      closeYuanbaoAddMenu();
      return null;
    }

    uploadAction.click();
    // The input may already be mounted, so give the re-armed handler a beat before dispatching.
    await sleep(100);
    return waitForFileInput(() => findYuanbaoFileInput(attachmentData), 1000);
  }

  async function injectImageToYuanbao(imageData, { retry = false } = {}) {
    try {
      const composer = getYuanbaoComposer();
      if (!composer) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const countCompleted = () => countYuanbaoCompletedPreviews(imageData.name, imageData);
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

      // Never reuse an already-mounted input directly: only the menu click re-arms it.
      const fileInput = await openYuanbaoImagePicker(composer, imageData);
      if (!fileInput) {
        if (isDocumentAttachmentData(imageData) &&
          !findYuanbaoFileInput(imageData) &&
          document.querySelectorAll('input[type="file"]').length > 0) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const previousCount = countCompleted();
      const file = await createAttachmentFile(imageData);
      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }
      dispatchFileInputEvents(fileInput);

      const accepted = await waitForPreviewIncrease(
        countCompleted,
        previousCount,
        getPreviewTimeoutMs(imageData)
      );
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

  const GROK_ATTACHMENT_REGION_SELECTOR = [
    '[role="list"][aria-label="Conversation attachments"]',
    '[role="region"][aria-label="Attachments"]'
  ].join(', ');
  const GROK_ATTACH_BUTTON_SELECTOR = [
    'button[aria-label="Attach"]',
    'button[data-testid="attach-button"]',
    'button[aria-label="Add files, skills, and connectors"]',
    'button[aria-label*="Add files" i]',
    'button[aria-label*="Attach" i]'
  ].join(', ');
  const DEEPSEEK_PENDING_CLASS_RE = /(?:^|[-_\s])(?:loading|uploading|parsing|pending|error|fail(?:ed)?)(?:$|[-_\s])/i;
  const DEEPSEEK_PENDING_TEXT_RE = /\b(?:uploading|parsing|loading)\b|上传中|解析中/i;

  function getGrokEditor() {
    return document.querySelector('[data-testid="chat-input"] [contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][aria-label="Ask Grok anything"]') ||
      document.querySelector('[role="textbox"][aria-label="Message Grok"]') ||
      document.querySelector('.tiptap.ProseMirror[role="textbox"], .tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"]') ||
      document.querySelector('form textarea');
  }

  function getGrokComposer() {
    const editor = getGrokEditor();
    if (!editor) {
      return null;
    }
    return editor.closest('form') ||
      editor.closest('[class*="composer"]') ||
      findClosestAncestorContaining(editor, 'input[type="file"]', 10) ||
      editor.parentElement ||
      null;
  }

  function walkGrokComposerAncestors(composer, maxDepth = 3) {
    const ancestors = [];
    let current = composer;
    for (let depth = 0; current && depth <= maxDepth; depth++) {
      if (current === document.body || current === document.documentElement) {
        break;
      }
      if (
        depth > 0 &&
        (current.querySelector('nav, aside') || current.querySelectorAll('form').length > 1)
      ) {
        break;
      }
      ancestors.push(current);
      current = current.parentElement;
    }
    return ancestors;
  }

  function getGrokFileInputs(composer) {
    for (const scope of walkGrokComposerAncestors(composer, 3)) {
      const inputs = [...scope.querySelectorAll('input[type="file"]')];
      if (inputs.length > 0) {
        return inputs;
      }
    }
    return [];
  }

  function findGrokFileInput(composer, attachmentData = null) {
    const inputs = getGrokFileInputs(composer);
    return inputs.find(input => input.multiple && acceptsAttachmentFile(input, attachmentData)) ||
      inputs.find(input => acceptsAttachmentFile(input, attachmentData)) ||
      null;
  }

  function findGrokAttachButton(composer) {
    for (const scope of walkGrokComposerAncestors(composer, 2)) {
      const button = scope.querySelector(GROK_ATTACH_BUTTON_SELECTOR);
      if (button) {
        return button;
      }
    }
    return null;
  }

  function getGrokAttachmentRegions(composer, { scopeToComposerOnly = false } = {}) {
    const regions = new Set();
    for (const scope of walkGrokComposerAncestors(composer, 2)) {
      scope.querySelectorAll(GROK_ATTACHMENT_REGION_SELECTOR).forEach(region => {
        regions.add(region);
      });
    }
    if (!scopeToComposerOnly && regions.size === 0) {
      document.querySelectorAll(GROK_ATTACHMENT_REGION_SELECTOR).forEach(region => {
        regions.add(region);
      });
    }
    return [...regions];
  }

  function isGrokAttachmentNodeRejected(element, region, normalizedName = '') {
    if (isRejectionUiElement(element, normalizedName)) {
      return true;
    }
    const parent = element.parentElement;
    if (parent && parent !== region && region.contains(parent) && isRejectionUiElement(parent, normalizedName)) {
      return true;
    }
    return false;
  }

  function countGrokAttachmentContainerItems(composer, { scopeToComposerOnly = false } = {}) {
    let total = 0;
    for (const region of getGrokAttachmentRegions(composer, { scopeToComposerOnly })) {
      if (region.matches('[role="list"][aria-label="Conversation attachments"]')) {
        total += [...region.children].filter(child => !isRejectionUiElement(child, '')).length;
        continue;
      }
      const removeButtons = [...region.querySelectorAll('button[aria-label^="Remove " i]')].filter(
        btn => !isGrokAttachmentNodeRejected(btn, region)
      );
      if (removeButtons.length > 0) {
        total += removeButtons.length;
        continue;
      }
      const openButtons = [...region.querySelectorAll('button[aria-label^="Open " i]')].filter(
        btn => !isGrokAttachmentNodeRejected(btn, region)
      );
      if (openButtons.length > 0) {
        total += openButtons.length;
        continue;
      }
      total += [...region.children].filter(
        child =>
          !isRejectionUiElement(child, '') &&
          ((child.textContent || '').trim().length > 0 ||
            Boolean(child.querySelector('img, button, [data-file-name], [data-filename]')))
      ).length;
    }
    return total;
  }

  function countGrokAttachmentFilenameEvidence(composer, fileName, { scopeToComposerOnly = false } = {}) {
    const normalizedName = (fileName || '').trim().toLowerCase();
    if (!normalizedName) {
      return 0;
    }

    const regionEvidence = new Set();
    for (const region of getGrokAttachmentRegions(composer, { scopeToComposerOnly })) {
      region.querySelectorAll('button[aria-label], [role="button"][aria-label], img[alt], [data-file-name], [data-filename], span, div').forEach(element => {
        if (element.closest('textarea, input, [contenteditable="true"]')) {
          return;
        }
        const ariaLabel = (element.getAttribute('aria-label') || '').trim().toLowerCase();
        const alt = (element.getAttribute('alt') || '').trim().toLowerCase();
        const dataName = (
          element.getAttribute('data-file-name') ||
          element.getAttribute('data-filename') ||
          ''
        ).trim().toLowerCase();
        const isExactLeaf =
          element.childElementCount === 0 &&
          (element.textContent || '').trim().toLowerCase() === normalizedName;
        const matches =
          alt === normalizedName ||
          dataName === normalizedName ||
          ariaLabel === `open ${normalizedName}` ||
          ariaLabel === `remove ${normalizedName}` ||
          (ariaLabel && ariaLabel.includes(normalizedName)) ||
          isExactLeaf;
        if (!matches) {
          return;
        }
        if (isGrokAttachmentNodeRejected(element, region, normalizedName)) {
          return;
        }
        regionEvidence.add(element.closest('button, [role="button"]') || element);
      });
    }

    // Grok may render the visible attachment chip in a portal outside the form.
    // The filename is exposed as the preview button/image accessible name.
    const filenameEvidence = countFilenamePreviewEvidence(
      scopeToComposerOnly ? composer : document,
      fileName,
      { excludeRejectionUi: true }
    );
    return Math.max(regionEvidence.size, filenameEvidence);
  }

  async function injectImageToGrok(imageData) {
    try {
      const composer = getGrokComposer();
      if (!composer) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const file = await createAttachmentFile(imageData);
      let fileInput = findGrokFileInput(composer, imageData);
      if (!fileInput) {
        if (isDocumentAttachmentData(imageData) && getGrokFileInputs(composer).length > 0) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }
        const attachButton = findGrokAttachButton(composer);
        if (!attachButton) {
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
        }
        // Grok ignores synthetic clicks when deciding whether to open its
        // attachment menu. Its native composer file input is still usable;
        // only use synthetic UI events to wake a lazily mounted input.
        attachButton.click();
        dispatchDragEventsToWakeInput(composer, file);
        fileInput = await waitForFileInput(() => findGrokFileInput(composer, imageData));
      }
      if (!fileInput) {
        if (isDocumentAttachmentData(imageData) && getGrokFileInputs(composer).length > 0) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const previousContainerCount = countGrokAttachmentContainerItems(composer);
      const previousFilenameCount = countGrokAttachmentFilenameEvidence(composer, imageData.name);
      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }
      dispatchFileInputEvents(fileInput);

      const accepted = await waitForPreviewIncrease(
        () => (
          countGrokAttachmentContainerItems(composer) > previousContainerCount ||
          countGrokAttachmentFilenameEvidence(composer, imageData.name) > previousFilenameCount
            ? 1
            : 0
        ),
        0,
        getPreviewTimeoutMs(imageData)
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

  function findDeepSeekFileInput(composer, attachmentData = null) {
    const inputs = [...(composer?.querySelectorAll('input[type="file"]') || [])];
    return inputs.find(input => input.multiple && acceptsAttachmentFile(input, attachmentData)) ||
      inputs.find(input => acceptsAttachmentFile(input, attachmentData)) ||
      null;
  }

  function isDeepSeekCardPendingOrRejected(card, normalizedName) {
    if (!card || isRejectionUiElement(card, normalizedName)) {
      return true;
    }
    if (
      card.matches?.('[aria-busy="true"]') ||
      Boolean(card.querySelector?.('[aria-busy="true"], [role="progressbar"]'))
    ) {
      return true;
    }
    const nodes = [card, ...(card.querySelectorAll?.('[class]') || [])];
    for (const node of nodes) {
      const cls = node.getAttribute?.('class') || '';
      if (cls && DEEPSEEK_PENDING_CLASS_RE.test(cls)) {
        return true;
      }
    }
    const text = (card.textContent || '').trim().toLowerCase();
    const withoutName = normalizedName ? text.split(normalizedName).join(' ') : text;
    return DEEPSEEK_PENDING_TEXT_RE.test(withoutName);
  }

  function countDeepSeekCardPreviews(composer, fileName, { scopeToComposerOnly = false } = {}) {
    const normalizedName = (fileName || '').trim().toLowerCase();
    if (!normalizedName) {
      return 0;
    }

    const cards = new Set();
    const animatedScope = scopeToComposerOnly ? composer : document;
    animatedScope?.querySelectorAll('.ds-animated-size-item').forEach(item => {
      if (item.closest('textarea, input, [contenteditable="true"]')) {
        return;
      }
      const text = (item.textContent || '').trim().toLowerCase();
      if (!text || text.length > 240 || !text.includes(normalizedName)) {
        return;
      }
      if (isDeepSeekCardPendingOrRejected(item, normalizedName)) {
        return;
      }
      cards.add(item);
    });

    if (composer) {
      composer.querySelectorAll('div, span, p').forEach(element => {
        if (element.childElementCount > 0 || element.closest('textarea, input, [contenteditable="true"]')) {
          return;
        }
        if ((element.textContent || '').trim().toLowerCase() !== normalizedName) {
          return;
        }
        const animatedItem = element.closest('.ds-animated-size-item');
        let card = animatedItem && composer.contains(animatedItem) ? animatedItem : element;
        if (!animatedItem) {
          let current = element;
          while (
            current.parentElement &&
            current.parentElement !== composer &&
            !current.parentElement.querySelector('textarea, input[type="file"], [contenteditable="true"]')
          ) {
            current = current.parentElement;
          }
          card = current;
        }
        if (isDeepSeekCardPendingOrRejected(card, normalizedName)) {
          return;
        }
        cards.add(card);
      });
    }

    return cards.size;
  }

  async function injectImageToDeepSeek(imageData) {
    try {
      const composer = getDeepSeekComposer();
      if (!composer) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const file = await createAttachmentFile(imageData);
      let fileInput = findDeepSeekFileInput(composer, imageData);
      if (!fileInput) {
        dispatchDragEventsToWakeInput(composer, file);
        fileInput = await waitForFileInput(() => findDeepSeekFileInput(composer, imageData));
      }
      if (!fileInput) {
        if (isDocumentAttachmentData(imageData) && composer.querySelectorAll('input[type="file"]').length > 0) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      // DeepSeek renders attachment previews beside the composer controls rather
      // than consistently inside the nearest file-input ancestor, and document
      // cards use hashed classes inside `.ds-animated-size-item`. Track filename,
      // card, and composer blob thumbnail baselines independently so historical
      // chat attachments with the same filename never mask a new upload.
      const previousFilenameCount = countFilenamePreviewEvidence(document, imageData.name, { excludeRejectionUi: true });
      const previousCardCount = countDeepSeekCardPreviews(composer, imageData.name);
      const previousBlobCount = composer.querySelectorAll('img[src^="blob:"]').length;
      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }
      dispatchFileInputEvents(fileInput);

      const accepted = await waitForPreviewIncrease(
        () => (
          countFilenamePreviewEvidence(document, imageData.name, { excludeRejectionUi: true }) > previousFilenameCount ||
          countDeepSeekCardPreviews(composer, imageData.name) > previousCardCount ||
          composer.querySelectorAll('img[src^="blob:"]').length > previousBlobCount
            ? 1
            : 0
        ),
        0,
        getPreviewTimeoutMs(imageData)
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

  const KIMI_DOCUMENT_CARD_SELECTOR = '.file-card, .file-item, .attachment-card, .attachment-item';
  const KIMI_DOCUMENT_CARD_LOOSE_SELECTOR =
    `${KIMI_DOCUMENT_CARD_SELECTOR}, [class*="file-card"], [class*="file-item"], [class*="attachment-item"]`;

  /**
   * True for list/container wrappers around document cards. A wrapper inherits
   * its children's filenames through textContent and must never be counted as
   * a card itself.
   */
  function isKimiCardContainer(element) {
    if (!element || typeof element.matches !== 'function') {
      return false;
    }
    if (element.matches('[role="list"]')) {
      return true;
    }
    const classes = Array.from(element.classList || []);
    if (classes.some(cls => /(?:^|[-_])list$/i.test(cls))) {
      return true;
    }
    return Boolean(element.querySelector(KIMI_DOCUMENT_CARD_SELECTOR));
  }

  function hasKimiPendingOrErrorClass(element) {
    const cls = String(element?.className || '').toLowerCase();
    return cls.includes('loading') || cls.includes('uploading') || cls.includes('error') || cls.includes('fail');
  }

  /**
   * Maps a matched node (for example a nested `.file-card-title`) to the card
   * that owns it. Exact card classes win; otherwise the outermost loosely
   * matching ancestor inside the composer is used.
   */
  function resolveKimiDocumentCard(element, composer) {
    const exactCard = element.closest(KIMI_DOCUMENT_CARD_SELECTOR);
    if (exactCard && composer.contains(exactCard)) {
      return exactCard;
    }
    let owner = element;
    let parent = element.parentElement;
    while (parent && parent !== composer && composer.contains(parent)) {
      if (isKimiCardContainer(parent)) {
        break;
      }
      if (parent.matches(KIMI_DOCUMENT_CARD_LOOSE_SELECTOR)) {
        owner = parent;
      }
      parent = parent.parentElement;
    }
    return owner;
  }

  /** True when the node or any ancestor up to the composer is still uploading or failed. */
  function isInsideKimiPendingOrErrorCard(element, composer) {
    for (let node = element; node && node !== composer; node = node.parentElement) {
      if (hasKimiPendingOrErrorClass(node)) {
        return true;
      }
    }
    return false;
  }

  function countKimiDocumentPreviews(composer, fileName = '') {
    if (!composer) {
      return 0;
    }
    const healthyCards = new Set();
    composer.querySelectorAll(KIMI_DOCUMENT_CARD_LOOSE_SELECTOR).forEach(el => {
      if (
        el.matches('.image-thumbnail') ||
        isKimiCardContainer(el) ||
        isInsideKimiPendingOrErrorCard(el, composer)
      ) {
        return;
      }
      const card = resolveKimiDocumentCard(el, composer);
      if (!card.matches('.image-thumbnail') && !isKimiCardContainer(card)) {
        healthyCards.add(card);
      }
    });
    if (!fileName) {
      return healthyCards.size;
    }

    const normalized = fileName.trim().toLowerCase();
    const matchingCards = [...healthyCards].filter(card =>
      (card.textContent || '').toLowerCase().includes(normalized)
    );
    if (matchingCards.length > 0) {
      return matchingCards.length;
    }
    // Filename attributes can live outside card text (titles, aria labels).
    // Count each owning card once and ignore anything under a pending/error card.
    const evidenceCards = new Set(healthyCards);
    composer.querySelectorAll('[data-file-name], [data-filename], [title], [aria-label]').forEach(el => {
      if (isKimiCardContainer(el) || isInsideKimiPendingOrErrorCard(el, composer)) {
        return;
      }
      const raw = (
        el.getAttribute('data-file-name') ||
        el.getAttribute('data-filename') ||
        el.getAttribute('title') ||
        el.getAttribute('aria-label') ||
        ''
      ).trim().toLowerCase();
      if (raw.includes(normalized)) {
        const card = resolveKimiDocumentCard(el, composer);
        if (!isKimiCardContainer(card)) {
          evidenceCards.add(card);
        }
      }
    });
    return evidenceCards.size;
  }

  function countKimiPendingAttachmentPreviews(composer) {
    return composer?.querySelectorAll(
      '.image-thumbnail.loading, .file-card.loading, .file-item.loading, [class*="file-card"].loading, [class*="attachment"].loading'
    ).length || 0;
  }

  function getKimiImageKey(imageData) {
    if (imageData && imageData.id && typeof imageData.id === 'string') {
      return imageData.id;
    }
    return `${imageData?.name || ''}\u0000${imageData?.type || ''}\u0000${imageData?.dataUrl || imageData?.size || ''}`;
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
    if (
      !thumbnail.matches('.image-thumbnail') &&
      thumbnail.matches('.success')
    ) {
      return 'success';
    }
    return thumbnail.matches('.loading') ? 'loading' : 'failed';
  }

  async function waitForTrackedKimiThumbnail(thumbnail, timeoutMs = IMAGE_UPLOAD_PREVIEW_TIMEOUT_MS) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const state = getKimiThumbnailState(thumbnail);
      if (state !== 'loading') {
        return state;
      }
      await sleep(100);
    }

    return getKimiThumbnailState(thumbnail);
  }

  async function reconcilePendingKimiImage(imageKey, composer, countCompleted, timeoutMs) {
    const pendingUpload = pendingKimiImageUploads.get(imageKey);
    if (!pendingUpload) {
      return null;
    }

    // Kimi replaces the original loading thumbnail during upload finalization.
    // The verified success-count increase preserves reconciliation across that
    // replacement while the retry flag keeps it scoped to the failed Fill.
    if (countCompleted() > pendingUpload.previousSuccessCount) {
      pendingKimiImageUploads.delete(imageKey);
      return createImageInjectionSuccess();
    }

    const state = await waitForTrackedKimiThumbnail(pendingUpload.thumbnail, timeoutMs);
    if (
      state === 'success' ||
      countCompleted() > pendingUpload.previousSuccessCount
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

  async function waitForKimiPendingPreview(composer, countCompleted, previousSuccessCount, timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (countCompleted() > previousSuccessCount) {
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
  async function findKimiFileInput(composer, attachmentData = null) {
    const composerInputs = [...composer.querySelectorAll('input[type="file"]')];
    const matchingComposerInput = composerInputs.find(input => acceptsAttachmentFile(input, attachmentData));
    if (matchingComposerInput) {
      return matchingComposerInput;
    }
    if (composerInputs.length > 0 && !attachmentData) {
      return composerInputs[0];
    }

    const toolkitTrigger = composer.querySelector('.toolkit-trigger-btn');
    if (!toolkitTrigger) {
      return composerInputs[0] || null;
    }

    let uploadEntry = findVisibleElementByExactText('label', ['文件和图片', 'Files and images']);
    if (!uploadEntry) {
      toolkitTrigger.click();
      await sleep(100);
      uploadEntry = findVisibleElementByExactText('label', ['文件和图片', 'Files and images']);
    }
    return uploadEntry?.querySelector('input[type="file"]') || composerInputs[0] || null;
  }

  async function injectImageToKimi(imageData, { retry = false } = {}) {
    try {
      const composer = getKimiComposer();
      if (!composer) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const isDoc = isDocumentAttachmentData(imageData);
      const timeoutMs = getPreviewTimeoutMs(imageData);
      const countCompleted = () => isDoc
        ? countKimiDocumentPreviews(composer, imageData.name)
        : countKimiAttachmentPreviews(composer);

      // A Kimi upload can finish after the first Fill has already timed out.
      // Reconcile the exact thumbnail/card created by that attempt before retrying.
      const imageKey = getKimiImageKey(imageData);
      if (retry) {
        const reconciledResult = await reconcilePendingKimiImage(imageKey, composer, countCompleted, timeoutMs);
        if (reconciledResult) {
          return reconciledResult;
        }
      } else {
        pendingKimiImageUploads.clear();
      }

      const previousCount = countCompleted();
      if (countKimiPendingAttachmentPreviews(composer) > 0) {
        if (pendingKimiImageUploads.has(imageKey)) {
          const pendingAccepted = await waitForKimiPendingPreview(
            composer,
            countCompleted,
            previousCount,
            timeoutMs
          );
          return pendingAccepted
            ? createImageInjectionSuccess()
            : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
        }
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
      }

      const fileInput = await findKimiFileInput(composer, imageData);
      if (!fileInput) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.UNSUPPORTED);
      }
      if (!acceptsAttachmentFile(fileInput, imageData)) {
        return isDoc
          ? createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED)
          : createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const file = await createAttachmentFile(imageData);
      const cardSelector = '.image-thumbnail, .file-card, .file-item, [class*="file-card"], [class*="attachment-item"]';
      const previousThumbnails = new Set(composer.querySelectorAll(cardSelector));
      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }
      dispatchFileInputEvents(fileInput);

      const accepted = await waitForPreviewIncrease(
        countCompleted,
        previousCount,
        timeoutMs
      );
      if (accepted) {
        pendingKimiImageUploads.delete(imageKey);
        return createImageInjectionSuccess();
      }

      const newThumbnail = [...composer.querySelectorAll(cardSelector)]
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

  function findMatchingFileInputFromSelectors(selectors, attachmentData) {
    const seen = new Set();
    const candidates = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }
    }
    const matched = candidates.find(input => acceptsAttachmentFile(input, attachmentData)) || null;
    return { matched, hadAnyInput: candidates.length > 0 };
  }

  const CHATGPT_CAMERA_INPUT_LABEL_RE = /take a photo|拍照/i;
  const CHATGPT_ATTACHMENT_CARD_SELECTOR = '[class*="composer-attachment"], [data-testid*="attachment"]';
  const CHATGPT_REMOVE_LABEL_PREFIX_RE = /^\s*(?:remove|移除|删除)\s*/i;

  function isChatgptCameraCaptureInput(input) {
    return input.hasAttribute('capture') ||
      CHATGPT_CAMERA_INPUT_LABEL_RE.test(input.getAttribute('aria-label') || '');
  }

  function getChatgptComposerForm() {
    return window.PanelizeChatgptComposer?.findForm() || null;
  }

  /**
   * Picks ChatGPT's composer file input, composer-scoped first, in the order of
   * FILE_INPUT_SELECTORS.chatgpt. Camera-capture inputs ("Take a photo") are
   * only used when no other file input is mounted.
   */
  function findChatgptFileInput(attachmentData) {
    const form = getChatgptComposerForm();
    const scopes = form ? [form, document] : [document];
    const seen = new Set();
    const ordered = [];
    for (const scope of scopes) {
      for (const selector of FILE_INPUT_SELECTORS.chatgpt) {
        for (const input of scope.querySelectorAll(selector)) {
          if (!seen.has(input)) {
            seen.add(input);
            ordered.push(input);
          }
        }
      }
    }
    const nonCameraInputs = ordered.filter(input => !isChatgptCameraCaptureInput(input));
    const pool = nonCameraInputs.length > 0 ? nonCameraInputs : ordered;
    const matched = pool.find(input => acceptsAttachmentFile(input, attachmentData)) || null;
    return { matched, hadAnyInput: ordered.length > 0 };
  }

  function getChatgptAttachmentRoot(fileInput = null, editor = null) {
    return getChatgptComposerForm() ||
      editor?.closest?.('form') ||
      fileInput?.closest?.('form') ||
      document.body;
  }

  /**
   * Matches ChatGPT's displayed attachment name against the uploaded file name,
   * including the duplicate suffix ChatGPT appends ("sample.pdf" -> "sample(4).pdf").
   */
  function createChatgptAttachmentNameMatcher(fileName) {
    const name = (fileName || '').trim().toLowerCase();
    if (!name) {
      return null;
    }
    const stem = getAttachmentFileNameStem(name);
    const suffixed = stem
      ? new RegExp(`^${escapeRegExp(stem)}\\s*\\(\\d+\\)${escapeRegExp(name.slice(name.lastIndexOf('.')))}$`, 'u')
      : null;
    return candidate => {
      const value = (candidate || '').trim().toLowerCase();
      return Boolean(value) && (value === name || Boolean(suffixed?.test(value)));
    };
  }

  function isChatgptEditorNode(element) {
    return Boolean(element.closest('textarea, input, [contenteditable="true"]'));
  }

  function getChatgptAttachmentCards(root) {
    if (!root) {
      return [];
    }
    const cards = new Set();
    root.querySelectorAll(CHATGPT_ATTACHMENT_CARD_SELECTOR).forEach(element => {
      if (
        element === root ||
        element.matches('button, input') ||
        isChatgptEditorNode(element) ||
        element.querySelector('input[type="file"], textarea, [contenteditable="true"]')
      ) {
        return;
      }
      cards.add(element);
    });
    root.querySelectorAll('button[aria-label]').forEach(button => {
      const label = button.getAttribute('aria-label') || '';
      if (!CHATGPT_REMOVE_LABEL_PREFIX_RE.test(label) || !label.replace(CHATGPT_REMOVE_LABEL_PREFIX_RE, '').trim()) {
        return;
      }
      const card = button.closest(CHATGPT_ATTACHMENT_CARD_SELECTOR);
      cards.add(card && root.contains(card) && card !== root ? card : (button.parentElement || button));
    });
    // Count each card once even when nested elements match the card selector.
    return [...cards].filter(card => ![...cards].some(other => other !== card && other.contains(card)));
  }

  function isChatgptCardRejected(card, fileName) {
    return isRejectionUiElement(card, (fileName || '').trim().toLowerCase());
  }

  /**
   * Staged (non-errored) composer attachment cards. A card stays staged when it
   * is clean relative to any candidate name, so a file named "error-log.txt" is
   * not mistaken for an error card.
   */
  function countChatgptStagedAttachmentCards(root, candidateAttachments = []) {
    const names = ['', ...(candidateAttachments || []).map(item => item?.name || '').filter(Boolean)];
    return getChatgptAttachmentCards(root)
      .filter(card => names.some(name => !isChatgptCardRejected(card, name)))
      .length;
  }

  function getChatgptNamedAttachmentEvidence(root, fileName) {
    const matchesName = createChatgptAttachmentNameMatcher(fileName);
    if (!root || !matchesName) {
      return [];
    }
    const evidence = new Set();
    root.querySelectorAll('button[aria-label], [role="button"][aria-label], img[alt], [data-file-name], [data-filename], div, span, p').forEach(element => {
      if (isChatgptEditorNode(element)) {
        return;
      }
      const label = element.getAttribute('aria-label') || '';
      const candidates = [
        CHATGPT_REMOVE_LABEL_PREFIX_RE.test(label) ? label.replace(CHATGPT_REMOVE_LABEL_PREFIX_RE, '') : '',
        element.getAttribute('alt') || '',
        element.getAttribute('data-file-name') || '',
        element.getAttribute('data-filename') || '',
        element.childElementCount === 0 && (element.textContent || '').length <= 240 ? element.textContent : ''
      ];
      if (!candidates.some(matchesName)) {
        return;
      }
      const card = element.closest(CHATGPT_ATTACHMENT_CARD_SELECTOR);
      const evidenceNode = card && root.contains(card) && card !== root ? card : element;
      if (isChatgptCardRejected(evidenceNode, fileName) || isRejectionUiElement(element, (fileName || '').trim().toLowerCase())) {
        return;
      }
      evidence.add(evidenceNode);
    });
    return [...evidence];
  }

  function countChatgptNamedAttachmentPreviews(root, fileName) {
    return getChatgptNamedAttachmentEvidence(root, fileName).length;
  }

  function countChatgptAttachmentThumbnails(root, fileName) {
    if (!root) {
      return 0;
    }
    return [...root.querySelectorAll('img')].filter(img => {
      if (isChatgptEditorNode(img) || !/^(?:data:image\/|blob:|https?:)/i.test(img.getAttribute('src') || '')) {
        return false;
      }
      const card = img.closest(CHATGPT_ATTACHMENT_CARD_SELECTOR);
      return !(card && root.contains(card) && isChatgptCardRejected(card, fileName));
    }).length;
  }

  function getChatgptAttachmentEvidence(root, fileName) {
    return {
      cards: getChatgptAttachmentCards(root).filter(card => !isChatgptCardRejected(card, fileName)).length,
      named: countChatgptNamedAttachmentPreviews(root, fileName),
      thumbnails: countChatgptAttachmentThumbnails(root, fileName)
    };
  }

  function hasNewChatgptAttachmentEvidence(root, fileName, baseline) {
    const current = getChatgptAttachmentEvidence(root, fileName);
    return current.cards > baseline.cards ||
      current.named > baseline.named ||
      current.thumbnails > baseline.thumbnails;
  }

  // ChatGPT-specific image & document injection
  async function injectImageToChatGPT(imageData, { retry = false } = {}) {
    try {
      const pendingKey = getProviderImageKey('chatgpt', imageData);
      const { matched: firstInput, hadAnyInput } = findChatgptFileInput(imageData);
      if (!firstInput) {
        if (hadAnyInput && isDocumentAttachmentData(imageData)) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }
        console.warn('[Image Injection] ChatGPT: No file input found');
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const root = getChatgptAttachmentRoot(firstInput);
      const pendingUpload = pendingProviderImageUploads.get(pendingKey);
      pendingProviderImageUploads.delete(pendingKey);
      if (
        retry &&
        pendingUpload &&
        Date.now() - pendingUpload.startedAt < 30000 &&
        countChatgptNamedAttachmentPreviews(root, imageData.name) > pendingUpload.previousCount
      ) {
        // The earlier attempt's preview landed after it reported preview-timeout.
        console.log('[Image Injection] ChatGPT: Late preview confirmed on retry');
        return createImageInjectionSuccess();
      }

      // Compare every attempt with the baseline taken before the first dispatch,
      // so a slow preview from attempt one is never followed by a duplicate upload.
      const baseline = getChatgptAttachmentEvidence(root, imageData.name);
      const hasPreview = () => hasNewChatgptAttachmentEvidence(root, imageData.name, baseline);
      const file = await createAttachmentFile(imageData);
      let fileInput = firstInput;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
          // An unhydrated composer (right after reload or New chat) drops the first
          // change event; React may also remount the input once it hydrates.
          await sleep(CHATGPT_PREVIEW_RETRY_DELAY_MS);
          if (hasPreview()) {
            return createImageInjectionSuccess();
          }
          fileInput = findChatgptFileInput(imageData).matched;
          if (!fileInput) {
            break;
          }
          console.warn('[Image Injection] ChatGPT: No attachment preview yet, retrying file input once');
        }
        if (!assignFilesToInput(fileInput, [file])) {
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
        }
        dispatchFileInputEvents(fileInput);
        const accepted = await waitForPreviewIncrease(
          () => (hasPreview() ? 1 : 0),
          0,
          CHATGPT_PREVIEW_ATTEMPT_TIMEOUT_MS
        );
        if (accepted) {
          console.log('[Image Injection] ChatGPT: Attachment preview confirmed');
          return createImageInjectionSuccess();
        }
      }

      console.warn('[Image Injection] ChatGPT: No attachment preview appeared after retry');
      rememberPendingProviderImage('chatgpt', imageData, baseline.named);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    } catch (error) {
      console.error('[Image Injection] ChatGPT error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  // Claude-specific image & document injection
  async function injectImageToClaude(imageData) {
    try {
      const initial = findMatchingFileInputFromSelectors(FILE_INPUT_SELECTORS.claude, imageData);
      if (initial.matched) {
        const file = await createAttachmentFile(imageData);
        if (!assignFilesToInput(initial.matched, [file])) {
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
        }
        dispatchFileInputEvents(initial.matched);
        console.log('[Image Injection] Claude: File input triggered');
        return createImageInjectionSuccess();
      }

      // Try clicking the attachment button first
      const attachBtnSelectors = UPLOAD_BUTTON_SELECTORS.claude;
      for (const selector of attachBtnSelectors) {
        const btn = document.querySelector(selector);
        if (btn) {
          btn.click();
          await sleep(300);
          const afterClick = findMatchingFileInputFromSelectors(FILE_INPUT_SELECTORS.claude, imageData);
          if (afterClick.matched) {
            const file = await createAttachmentFile(imageData);
            if (!assignFilesToInput(afterClick.matched, [file])) {
              return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
            }
            dispatchFileInputEvents(afterClick.matched);
            console.log('[Image Injection] Claude: File input triggered after button click');
            return createImageInjectionSuccess();
          }
          if (afterClick.hadAnyInput && isDocumentAttachmentData(imageData)) {
            return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
          }
        }
      }

      if (initial.hadAnyInput && isDocumentAttachmentData(imageData)) {
        return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
      }

      console.warn('[Image Injection] Claude: No file input found');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
    } catch (error) {
      console.error('[Image Injection] Claude error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  const GEMINI_DISALLOWED_TRIGGER_TESTID_RE = /side-?nav|sidebar|drawer|menu-button|send/i;
  const GEMINI_DISALLOWED_TRIGGER_LABEL_RE =
    /\b(?:open|close|toggle)\s+sidebar\b|\bsidebar\b|\bside\s*nav\b|\bmain\s+menu\b|\bnavigation\b|\bsend\b|侧边栏|导航|发送/i;

  const GEMINI_SIDEBAR_ANCESTOR_SELECTOR = 'nav, aside, header, side-navigation, bard-sidenav, mat-sidenav';
  const GEMINI_PREVIEW_CHIP_ANCESTOR_SELECTOR =
    'uploader-file-preview, .file-preview-chip, mat-basic-chip, [data-test-id="file-preview"], [data-test-id="image-preview"]';
  const GEMINI_REMOVE_CONTROL_LABEL_RE = /^(?:close|remove|delete)\b/i;
  const GEMINI_UPLOAD_MENU_SURFACE_SELECTORS = [
    '.cdk-overlay-container',
    '.cdk-overlay-pane',
    'mat-menu',
    '.mat-mdc-menu-panel',
    '[role="menu"]'
  ];

  function getGeminiComposerRoot(editor = null) {
    const resolvedEditor = editor || querySelectorDeep('.ql-editor') || querySelectorDeep('[contenteditable="true"]');
    return (
      resolvedEditor?.closest?.('input-container') ||
      resolvedEditor?.closest?.('input-area-v2') ||
      resolvedEditor?.closest?.('.input-area-container') ||
      resolvedEditor?.closest?.('.input-area, [class*="input-area"], form') ||
      querySelectorDeep('input-container') ||
      querySelectorDeep('input-area-v2, .input-area-container, .input-area') ||
      resolvedEditor?.parentElement ||
      null
    );
  }

  function isGeminiDisallowedUploadTrigger(element) {
    if (!element || element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
      return true;
    }
    if (element.closest?.(GEMINI_SIDEBAR_ANCESTOR_SELECTOR)) {
      return true;
    }
    // Never treat an attachment chip's own controls (e.g. "close upload plan") as the uploader.
    if (element.closest?.(GEMINI_PREVIEW_CHIP_ANCESTOR_SELECTOR)) {
      return true;
    }
    if (GEMINI_REMOVE_CONTROL_LABEL_RE.test((element.getAttribute?.('aria-label') || '').trim())) {
      return true;
    }
    const testId = (
      element.getAttribute?.('data-test-id') ||
      element.getAttribute?.('data-testid') ||
      ''
    ).trim();
    if (testId && GEMINI_DISALLOWED_TRIGGER_TESTID_RE.test(testId)) {
      return true;
    }
    const labelText = [
      getElementAccessibleText(element),
      (element.getAttribute?.('mattooltip') || '').trim().toLowerCase()
    ].join(' ');
    return GEMINI_DISALLOWED_TRIGGER_LABEL_RE.test(labelText);
  }

  function findGeminiUploadTrigger(composerRoot = null) {
    const acceptTrigger = (el) => isVisibleElement(el) && !isGeminiDisallowedUploadTrigger(el);
    if (composerRoot) {
      const scopedSelectors = [
        'button[aria-label="Upload & tools"]',
        'button[aria-label="Open upload file menu"]',
        'button[aria-label="Upload file"]',
        'button[mattooltip="Upload file"]',
        'button[aria-label="Add files"]',
        'button[aria-label="上传和工具"]',
        'button[data-test-id*="upload" i]',
        '[data-test-id*="uploader" i] button',
        'uploader button[aria-label*="Upload" i]',
        'uploader button',
        'button.upload-card-button',
        'button[aria-label*="Upload" i]',
        'button[aria-label*="上传"]',
        '.add-button',
        'button:has(mat-icon[fonticon="add"])',
        'button:has(mat-icon[fonticon="plus"])'
      ];
      for (const selector of scopedSelectors) {
        try {
          const candidates = querySelectorAllDeep(selector, composerRoot);
          for (const candidate of candidates) {
            if (acceptTrigger(candidate)) {
              return candidate;
            }
          }
        } catch (error) {
          console.warn('[Image Injection] Gemini scoped trigger selector failed:', selector, error);
        }
      }
    }
    return findDeepFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.gemini, (el) => !isGeminiDisallowedUploadTrigger(el));
  }

  /**
   * File inputs Gemini exposes for the active composer: inputs inside the
   * composer itself plus inputs mounted in its opened upload menu overlay.
   * Unrelated inputs elsewhere on the page (sidebars, other widgets) are ignored.
   */
  function getGeminiScopedFileInputs(composerRoot = null) {
    const scopeRoots = [composerRoot || document];
    GEMINI_UPLOAD_MENU_SURFACE_SELECTORS.forEach((selector) => {
      querySelectorAllDeep(selector).forEach((surface) => scopeRoots.push(surface));
    });
    // Sidebar chrome is excluded even when the composer root degrades to the page body.
    const inputs = new Set();
    scopeRoots.forEach((root) => {
      querySelectorAllDeep('input[type="file"]', root).forEach((input) => {
        if (!input.closest?.(GEMINI_SIDEBAR_ANCESTOR_SELECTOR)) {
          inputs.add(input);
        }
      });
    });
    return [...inputs];
  }

  /** Scoped file inputs that live on an upload-menu overlay surface (not in the composer itself). */
  function getGeminiOverlayFileInputs(composerRoot = null) {
    return getGeminiScopedFileInputs(composerRoot).filter((input) =>
      GEMINI_UPLOAD_MENU_SURFACE_SELECTORS.some((selector) => input.closest?.(selector)) &&
      !(composerRoot && composerRoot.contains(input))
    );
  }

  const GEMINI_STALE_UPLOAD_MENU_SETTLE_MS = 1500;
  const GEMINI_UPLOAD_MENU_REMOUNT_WAIT_MS = 1000;

  function findGeminiMatchingFileInput(attachmentData, composerRoot = null) {
    const candidates = getGeminiScopedFileInputs(composerRoot).filter((input) =>
      acceptsAttachmentFile(input, attachmentData)
    );
    if (candidates.length === 0) {
      return null;
    }
    // Prefer Gemini Hydrogen's explicit accept-matched hidden-file-input elements.
    return (
      candidates.find((input) => input.classList?.contains('hidden-file-input') && Boolean((input.getAttribute('accept') || '').trim())) ||
      candidates.find((input) => input.classList?.contains('hidden-file-input')) ||
      candidates.find((input) => Boolean((input.getAttribute('accept') || '').trim())) ||
      candidates[0]
    );
  }

  function closeGeminiUploadMenu(uploadBtn = null) {
    // Target the opened menu first: a comma-joined selector would return the outer pane in DOM order.
    const overlayTarget =
      document.querySelector('.mat-mdc-menu-panel') ||
      document.querySelector('[role="menu"]') ||
      document.querySelector('.cdk-overlay-pane') ||
      uploadBtn ||
      document;
    if (!overlayTarget) {
      return;
    }
    const escapeInit = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
    overlayTarget.dispatchEvent(new KeyboardEvent('keydown', escapeInit));
  }

  const GEMINI_PREVIEW_CHIP_SELECTOR =
    'uploader-file-preview, .file-preview-chip, [data-test-id="file-preview"], [data-test-id="image-preview"]';

  function isInvalidGeminiPreviewContainer(element, normalizedName = '', excludeRejectionUi = true) {
    if (!element) return true;
    if (element.closest?.('textarea, input, [contenteditable="true"], .cdk-describedby-message-container, .cdk-visually-hidden')) {
      return true;
    }
    if (element.matches?.('.error, .failed, [data-status="error"], [aria-invalid="true"]')) {
      return true;
    }
    return excludeRejectionUi && isRejectionUiElement(element, normalizedName);
  }

  /**
   * Collects the distinct, non-rejected attachment chips currently staged in
   * Gemini's composer (named chips, label-only chips and bare blob previews).
   */
  function collectGeminiRetainedPreviewChips(root) {
    const searchRoot = root || document;
    const chips = new Set();
    const addCanonical = (element) => {
      const canonical = element.closest?.('uploader-file-preview, .file-preview-chip') || element;
      if (!isInvalidGeminiPreviewContainer(element) && !isInvalidGeminiPreviewContainer(canonical)) {
        chips.add(canonical);
      }
    };
    querySelectorAllDeep(GEMINI_PREVIEW_CHIP_SELECTOR, searchRoot).forEach(addCanonical);
    querySelectorAllDeep('.gem-attachment-text', searchRoot).forEach(addCanonical);
    querySelectorAllDeep('img[src^="blob:"], img[src^="data:image/"]', searchRoot).forEach((img) => {
      if (!img.closest?.('nav, aside, header')) {
        addCanonical(img);
      }
    });
    return [...chips];
  }

  const GEMINI_TYPE_BADGE_FAMILIES = {
    pdf: 'pdf',
    doc: 'doc',
    docx: 'doc',
    word: 'doc',
    txt: 'txt',
    text: 'txt',
    md: 'md',
    markdown: 'md',
    csv: 'csv',
    json: 'json',
    xls: 'xls',
    xlsx: 'xls',
    ppt: 'ppt',
    pptx: 'ppt'
  };

  function getGeminiAttachmentTypeFamily(attachmentData) {
    const name = (attachmentData?.name || '').trim();
    const ext = (getAttachmentFileNameStem(name)
      ? name.slice(name.lastIndexOf('.') + 1)
      : (attachmentData?.ext || '').replace(/^\./, '')
    ).toLowerCase();
    return GEMINI_TYPE_BADGE_FAMILIES[ext] || ext;
  }

  /**
   * Reconciles staged Gemini chips one-to-one with retry fallback attachments.
   * A chip satisfies at most one attachment; a chip's visible type badge
   * (PDF/DOCX/...) must agree with the attachment's type when present.
   * Returns the retained attachments and the ones still missing from the composer.
   */
  function reconcileGeminiRetainedAttachments(composerRoot, attachments) {
    const chips = collectGeminiRetainedPreviewChips(composerRoot).map((chip) => {
      const parts = [
        (chip.getAttribute?.('data-file-name') || '').trim().toLowerCase(),
        (chip.getAttribute?.('data-filename') || '').trim().toLowerCase(),
        getElementAccessibleText(chip)
      ];
      chip.querySelectorAll?.('.gem-attachment-text, [aria-label], [title], img[alt]').forEach((child) => {
        parts.push(
          (child.textContent || '').trim().toLowerCase(),
          (child.getAttribute?.('aria-label') || '').trim().toLowerCase(),
          (child.getAttribute?.('title') || '').trim().toLowerCase(),
          (child.getAttribute?.('alt') || '').trim().toLowerCase()
        );
      });
      chip.querySelectorAll?.('span, div').forEach((child) => {
        if (child.children.length === 0) {
          parts.push((child.textContent || '').trim().toLowerCase());
        }
      });
      const filtered = parts.filter(Boolean);
      const badgeFamilies = new Set();
      filtered.forEach((part) => {
        const family = GEMINI_TYPE_BADGE_FAMILIES[part];
        if (family) badgeFamilies.add(family);
      });
      return {
        parts: filtered,
        combined: filtered.join(' '),
        badgeFamilies,
        hasImageMedia: Boolean(chip.matches?.('img') || chip.querySelector?.('img, canvas'))
      };
    });

    const claimed = new Set();
    const assignments = new Map();
    const matchesName = (chip, attachment) => {
      const name = (attachment?.name || '').trim().toLowerCase();
      if (!name) return false;
      if (chip.combined.includes(name)) return 'full';
      const stem = getAttachmentFileNameStem(name).toLowerCase();
      return stem && chip.parts.some(part => containsFileNameToken(part, stem)) ? 'stem' : false;
    };
    const tryAssign = (accept) => {
      attachments.forEach((attachment, attachmentIndex) => {
        if (assignments.has(attachmentIndex)) return;
        const chipIndex = chips.findIndex((chip, index) => !claimed.has(index) && accept(chip, attachment));
        if (chipIndex >= 0) {
          claimed.add(chipIndex);
          assignments.set(attachmentIndex, chipIndex);
        }
      });
    };
    const badgeAgrees = (chip, attachment) =>
      chip.badgeFamilies.size === 0 || chip.badgeFamilies.has(getGeminiAttachmentTypeFamily(attachment));

    // Strongest evidence first so weaker chips never steal a better-matching attachment.
    tryAssign((chip, attachment) => matchesName(chip, attachment) === 'full');
    tryAssign((chip, attachment) =>
      matchesName(chip, attachment) === 'stem' && chip.badgeFamilies.has(getGeminiAttachmentTypeFamily(attachment)));
    tryAssign((chip, attachment) => matchesName(chip, attachment) === 'stem' && badgeAgrees(chip, attachment));
    tryAssign((chip, attachment) => !isDocumentAttachmentData(attachment) && chip.hasImageMedia);

    const retained = [];
    const missing = [];
    attachments.forEach((attachment, index) => {
      (assignments.has(index) ? retained : missing).push(attachment);
    });
    return { chipCount: chips.length, retained, missing };
  }

  function countGeminiAttachmentPreviews(root, attachmentData = null, { excludeRejectionUi = true } = {}) {
    const searchRoot = root || document;
    const fileName = typeof attachmentData === 'string' ? attachmentData : (attachmentData?.name || '');
    const normalizedName = fileName.trim().toLowerCase();
    const normalizedStem = normalizedName ? getAttachmentFileNameStem(normalizedName).toLowerCase() : '';
    const isImageAttachment = attachmentData && typeof attachmentData === 'object'
      ? !isDocumentAttachmentData(attachmentData)
      : false;

    const matchedChips = new Set();
    const chipMatchesName = (element) => {
      if (!normalizedName) {
        return true;
      }
      const parts = [
        (element.getAttribute?.('data-file-name') || '').trim().toLowerCase(),
        (element.getAttribute?.('data-filename') || '').trim().toLowerCase(),
        getElementAccessibleText(element)
      ];
      element.querySelectorAll?.('.gem-attachment-text, [aria-label], [title], img[alt]').forEach((child) => {
        parts.push(
          (child.textContent || '').trim().toLowerCase(),
          (child.getAttribute?.('aria-label') || '').trim().toLowerCase(),
          (child.getAttribute?.('title') || '').trim().toLowerCase(),
          (child.getAttribute?.('alt') || '').trim().toLowerCase()
        );
      });
      const combined = parts.filter(Boolean).join(' ');
      if (combined.includes(normalizedName)) {
        return true;
      }
      return Boolean(normalizedStem && parts.some(part => containsFileNameToken(part, normalizedStem)));
    };

    const isInvalidPreviewContainer = (element) =>
      isInvalidGeminiPreviewContainer(element, normalizedName, excludeRejectionUi);

    const chipElements = querySelectorAllDeep(GEMINI_PREVIEW_CHIP_SELECTOR, searchRoot);
    for (const chip of chipElements) {
      if (isInvalidPreviewContainer(chip)) {
        continue;
      }
      const canonicalChip = chip.closest?.('uploader-file-preview, .file-preview-chip') || chip;
      if (isInvalidPreviewContainer(canonicalChip)) {
        continue;
      }
      const hasImageMedia = Boolean(canonicalChip.querySelector?.('img, canvas'));
      if (!normalizedName || chipMatchesName(canonicalChip) || (isImageAttachment && hasImageMedia)) {
        matchedChips.add(canonicalChip);
      }
    }

    const attachmentTextElements = querySelectorAllDeep('.gem-attachment-text', searchRoot);
    for (const labelEl of attachmentTextElements) {
      if (isInvalidPreviewContainer(labelEl)) {
        continue;
      }
      const canonicalChip = labelEl.closest?.('uploader-file-preview, .file-preview-chip') || labelEl;
      if (matchedChips.has(canonicalChip) || isInvalidPreviewContainer(canonicalChip)) {
        continue;
      }
      const text = (labelEl.textContent || '').trim().toLowerCase();
      if (
        !normalizedName ||
        text.includes(normalizedName) ||
        (normalizedStem && containsFileNameToken(text, normalizedStem))
      ) {
        matchedChips.add(canonicalChip);
      }
    }

    if (!normalizedName || isImageAttachment) {
      const previewImages = querySelectorAllDeep('img[src^="blob:"], img[src^="data:image/"]', searchRoot);
      for (const img of previewImages) {
        if (img.closest?.('nav, aside, header') || isInvalidPreviewContainer(img)) {
          continue;
        }
        const canonicalChip = img.closest?.('uploader-file-preview, .file-preview-chip') || img;
        matchedChips.add(canonicalChip);
      }
    }

    const filenameEvidence = normalizedName
      ? countFilenamePreviewEvidence(searchRoot, fileName, { excludeRejectionUi })
      : 0;

    return Math.max(matchedChips.size, filenameEvidence);
  }

  const GEMINI_CLASSIC_PASTE_PREVIEW_PROBE_MS = 300;

  // Gemini-specific image & document injection
  async function injectImageToGemini(imageData) {
    try {
      const isDoc = isDocumentAttachmentData(imageData);
      const file = await createAttachmentFile(imageData);
      const editorSelectors = ['.ql-editor', '[contenteditable="true"]', 'div[contenteditable]'];
      let editor = null;
      for (const selector of editorSelectors) {
        editor = querySelectorDeep(selector);
        if (editor) break;
      }
      const composerRoot = getGeminiComposerRoot(editor);
      const isHydrogenComposer = Boolean(
        composerRoot?.matches?.('input-container, uploader') ||
        composerRoot?.querySelector?.('uploader, input-container, button[aria-label="Upload & tools"], [file-drop-zone]') ||
        querySelectorDeep('input-container, uploader')
      );

      let fileInput = findGeminiMatchingFileInput(imageData, composerRoot);
      let openedUploadMenu = false;
      let clickedUploadBtn = null;

      if (!fileInput && (isDoc || isHydrogenComposer)) {
        const findMatch = () => findGeminiMatchingFileInput(imageData, composerRoot);
        const uploadBtn = findGeminiUploadTrigger(composerRoot);
        // No input matched yet, so any overlay input mounted now belongs to an incompatible
        // (e.g. image/*,video/*) menu that may swallow the trigger click below.
        const hadStaleOverlayBeforeClick = getGeminiOverlayFileInputs(composerRoot).length > 0;
        if (uploadBtn) {
          clickedUploadBtn = uploadBtn;
          uploadBtn.click();
          openedUploadMenu = true;
          fileInput = await waitForFileInput(findMatch, 600);
        }

        // A just-dismissed upload menu can still be detaching with only its image/*,video/*
        // input mounted; the trigger click is swallowed until that overlay is gone (it may
        // finish detaching during the wait above). Dismiss it, wait for its inputs to
        // unmount, then re-open the menu once before deciding the file type is not accepted.
        if (
          !fileInput &&
          uploadBtn &&
          (hadStaleOverlayBeforeClick || getGeminiOverlayFileInputs(composerRoot).length > 0)
        ) {
          await sleep(50);
          closeGeminiUploadMenu(clickedUploadBtn);
          const settleStart = Date.now();
          while (
            Date.now() - settleStart < GEMINI_STALE_UPLOAD_MENU_SETTLE_MS &&
            !(fileInput = findMatch()) &&
            getGeminiOverlayFileInputs(composerRoot).length > 0
          ) {
            await sleep(100);
          }
          const retryBtn = fileInput ? null : findGeminiUploadTrigger(composerRoot);
          if (retryBtn) {
            console.log('[Image Injection] Gemini: Re-opening upload menu after a stale overlay settled');
            clickedUploadBtn = retryBtn;
            retryBtn.click();
            fileInput = await waitForFileInput(findMatch, GEMINI_UPLOAD_MENU_REMOUNT_WAIT_MS);
          }
        }
      }

      if (fileInput) {
        const shouldConfirmPreview =
          openedUploadMenu ||
          isHydrogenComposer ||
          Boolean(fileInput.classList?.contains('hidden-file-input'));
        const previewScope = composerRoot || document;
        const previousPreviewCount = shouldConfirmPreview
          ? countGeminiAttachmentPreviews(previewScope, imageData, { excludeRejectionUi: true })
          : 0;

        if (!assignFilesToInput(fileInput, [file])) {
          if (openedUploadMenu) {
            await sleep(50);
            closeGeminiUploadMenu(clickedUploadBtn);
          }
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
        }

        dispatchFileInputEvents(fileInput);

        if (openedUploadMenu) {
          // Dismiss the overlay after change so Angular processes the upload before unmounting menu inputs.
          await sleep(50);
          closeGeminiUploadMenu(clickedUploadBtn);
        }

        if (shouldConfirmPreview) {
          const confirmed = await waitForPreviewIncrease(
            () => countGeminiAttachmentPreviews(previewScope, imageData, { excludeRejectionUi: true }),
            previousPreviewCount,
            getPreviewTimeoutMs(imageData)
          );
          console.log('[Image Injection] Gemini: Hidden file input upload', confirmed ? 'confirmed' : 'timed out');
          return confirmed
            ? createImageInjectionSuccess()
            : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
        }

        console.log('[Image Injection] Gemini: Attachment injected via file input');
        return createImageInjectionSuccess();
      }

      if (openedUploadMenu) {
        const hadIncompatibleInputs = isDoc && getGeminiScopedFileInputs(composerRoot).length > 0;
        await sleep(50);
        closeGeminiUploadMenu(clickedUploadBtn);
        if (hadIncompatibleInputs) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }
      }

      const dropzone = querySelectorDeep('div.xap-uploader-dropzone[file-drop-zone], [file-drop-zone]');

      if (isDoc) {
        // Fallback: single drop sequence on Hydrogen dropzone or classic editor (never blind paste + drop).
        const dropTarget = dropzone || editor;
        if (!dropTarget) {
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
        }
        const previousCount = countGeminiAttachmentPreviews(document, imageData, { excludeRejectionUi: true });
        dispatchFileDragEvents(dropTarget, file);
        const confirmed = await waitForPreviewIncrease(
          () => countGeminiAttachmentPreviews(document, imageData, { excludeRejectionUi: true }),
          previousCount,
          getPreviewTimeoutMs(imageData)
        );
        console.log('[Image Injection] Gemini: Document drop', confirmed ? 'confirmed' : 'not confirmed');
        return confirmed
          ? createImageInjectionSuccess()
          : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
      }

      console.log('[Image Injection] Gemini: Starting image injection');

      if (!editor) {
        console.warn('[Image Injection] Gemini: Editor not found');
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

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

      const pastePreviewScope = composerRoot || document;
      const previousPastePreviewCount = countGeminiAttachmentPreviews(pastePreviewScope, imageData, {
        excludeRejectionUi: true
      });
      editor.dispatchEvent(pasteEvent);
      console.log('[Image Injection] Gemini: Paste event dispatched');

      // A consumed paste (or one that already produced a preview) is the upload;
      // a second drop would hand the same image to another upload handler.
      if (pasteEvent.defaultPrevented) {
        return createImageInjectionSuccess();
      }
      const pastePreviewed = await waitForPreviewIncrease(
        () => countGeminiAttachmentPreviews(pastePreviewScope, imageData, { excludeRejectionUi: true }),
        previousPastePreviewCount,
        GEMINI_CLASSIC_PASTE_PREVIEW_PROBE_MS
      );
      if (pastePreviewed) {
        return createImageInjectionSuccess();
      }

      // Paste went unhandled: use drop as the transport, on the outer dropzone when present.
      const dropTarget = dropzone || editor;
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dataTransfer
      });
      dropTarget.dispatchEvent(dropEvent);
      console.log('[Image Injection] Gemini: Drop event dispatched');

      return createImageInjectionSuccess();
    } catch (error) {
      console.error('[Image Injection] Gemini error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  // Google AI Studio image & document injection
  async function injectImageToAiStudio(imageData) {
    try {
      const isDoc = isDocumentAttachmentData(imageData);
      const file = await createAttachmentFile(imageData);

      if (isDoc) {
        const direct = findMatchingFileInputFromSelectors(FILE_INPUT_SELECTORS.aistudio, imageData);
        if (direct.matched) {
          if (!assignFilesToInput(direct.matched, [file])) {
            return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
          }
          dispatchFileInputEvents(direct.matched);
          console.log('[Image Injection] AI Studio: Document injected via file input');
          return createImageInjectionSuccess();
        }
        if (direct.hadAnyInput) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }

        const uploadButton = findDeepFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.aistudio) ||
          findFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.aistudio);
        if (uploadButton) {
          uploadButton.click();
          await sleep(150);
          const afterClick = findMatchingFileInputFromSelectors(FILE_INPUT_SELECTORS.aistudio, imageData);
          if (afterClick.matched) {
            if (!assignFilesToInput(afterClick.matched, [file])) {
              return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
            }
            dispatchFileInputEvents(afterClick.matched);
            return createImageInjectionSuccess();
          }
          if (afterClick.hadAnyInput) {
            return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
          }
        }

        const dropTarget =
          document.querySelector('ms-prompt-box [msfilecopypaste]') ||
          document.querySelector('ms-prompt-box .prompt-box-container') ||
          findProviderInput('aistudio');
        if (dropTarget) {
          const confirmed = await dropDocumentAndConfirmPreview(dropTarget, file, imageData);
          return confirmed
            ? createImageInjectionSuccess()
            : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
        }
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const pasteTarget =
        findProviderInput('aistudio') ||
        document.querySelector('ms-prompt-box [msfilecopypaste]') ||
        document.querySelector('ms-prompt-box .prompt-box-container') ||
        document.querySelector('[msfilecopypaste]');

      if (pasteTarget) {
        if (typeof pasteTarget.focus === 'function') {
          pasteTarget.focus();
        }

        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer
        });

        pasteTarget.dispatchEvent(pasteEvent);
        console.log('[Image Injection] AI Studio: Paste event dispatched');
        return true;
      }

      if (await tryFileInputUpload('aistudio', imageData)) {
        console.log('[Image Injection] AI Studio: File input fallback succeeded');
        return true;
      }

      const uploadButton = findDeepFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.aistudio) ||
        findFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.aistudio);
      if (uploadButton) {
        uploadButton.click();
        await sleep(100);
        if (await tryFileInputUpload('aistudio', imageData)) {
          console.log('[Image Injection] AI Studio: File input after upload button click succeeded');
          return true;
        }
      }

      console.warn('[Image Injection] AI Studio: Paste target and file input not found');
      return false;
    } catch (error) {
      console.error('[Image Injection] AI Studio error:', error);
      return false;
    }
  }

  // Google AI Mode image & document injection
  async function injectImageToGoogle(imageData) {
    try {
      const isDoc = isDocumentAttachmentData(imageData);
      let fileInput = findGoogleFileInput(imageData);
      if (!fileInput) {
        fileInput = await openGoogleImagePicker(imageData);
      }

      if (fileInput) {
        const file = await createAttachmentFile(imageData);
        const assigned = assignFilesToInput(fileInput, [file]);
        if (!assigned) {
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
        }
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        // Close the "+" menu only after the change event: the inputs live in
        // the menu, and closing it first could detach them from the page.
        await sleep(50);
        closeGoogleComposerMenu();
        console.log('[Image Injection] Google: File input triggered');
        return createImageInjectionSuccess();
      }
      // Sample the menu's inputs before Escape: closing the "+" menu unmounts
      // them, which would turn an incompatible type into control-not-found.
      const sawIncompatibleInputs = isDoc && querySelectorAllDeep('input[type="file"]').length > 0;
      await sleep(50);
      closeGoogleComposerMenu();
      if (sawIncompatibleInputs) {
        return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
      }
      console.warn('[Image Injection] Google: No file input found');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
    } catch (error) {
      console.error('[Image Injection] Google error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  async function injectImageToDoubao(imageData) {
    try {
      const isDoc = isDocumentAttachmentData(imageData);
      const file = await createAttachmentFile(imageData);

      for (let attempt = 0; attempt < 3; attempt++) {
        let fileInput = await waitForDoubaoFileInput(500, imageData);

        if (!fileInput) {
          const uploadButton = findDeepFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.doubao) ||
            findFirstVisibleElement(UPLOAD_BUTTON_SELECTORS.doubao);

          if (uploadButton) {
            uploadButton.click();
            await sleep(200);
            if (isDoc) {
              const fileMenuAction = findVisibleElementByExactText(
                'button, [role="menuitem"], li',
                ['Upload File', '上传文件', '添加文件', '文件']
              );
              if (fileMenuAction) {
                fileMenuAction.click();
                await sleep(150);
              }
            }
            fileInput = await waitForDoubaoFileInput(800, imageData);
          }
        }

        if (!fileInput) {
          if (isDoc && document.querySelectorAll('#input-engine-container input[type="file"], input[type="file"]').length > 0) {
            return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
          }
          console.warn('[Image Injection] Doubao: No file input found on attempt', attempt + 1);
          continue;
        }

        const previousCount = countDoubaoAttachmentPreviews(imageData.name);
        const assigned = assignFilesToInput(fileInput, [file]);
        if (!assigned) {
          await sleep(200);
          continue;
        }

        dispatchFileInputEvents(fileInput);

        const uploadAccepted = await waitForDoubaoImagePreview(
          previousCount,
          imageData.name,
          isDoc ? DOCUMENT_UPLOAD_PREVIEW_TIMEOUT_MS : 1200
        );

        if (uploadAccepted) {
          console.log('[Image Injection] Doubao: Attachment preview detected');
          return createImageInjectionSuccess();
        }

        console.warn('[Image Injection] Doubao: Upload did not produce a preview');
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
      }

      console.warn('[Image Injection] Doubao: Upload did not produce a preview after retries');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
    } catch (error) {
      console.error('[Image Injection] Doubao error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  async function injectImageToQwen(provider, imageData) {
    try {
      const file = await createAttachmentFile(imageData);

      if (provider === 'qwen-global') {
        return await injectImageToQwenGlobal(file, imageData);
      }

      return await injectImageToQwenChina(file, imageData);
    } catch (error) {
      console.error('[Image Injection] Qwen error:', provider, error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  async function injectImageToQwenChina(file, attachmentData) {
    const composer = document.querySelector('[data-chat-input-layout="true"]');
    if (!composer) {
      console.warn('[Image Injection] Qwen China composer not found');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
    }

    const timeoutMs = getPreviewTimeoutMs(attachmentData);
    const previewCount = countQwenAttachmentPreviews('qwen-cn', attachmentData?.name);
    let fileInput = findQwenFileInput('qwen-cn', attachmentData);

    // Prefer waking Qwen China's lazy file input without dropping the file.
    if (!fileInput) {
      dispatchDragEventsToWakeInput(composer, file);
      fileInput = await waitForQwenFileInput('qwen-cn', 1000, attachmentData);
    }

    if (!fileInput) {
      // The current Qwen China composer can accept the native drop directly
      // without ever mounting a file input. Only its new preview is success.
      if (countQwenAttachmentPreviews('qwen-cn', attachmentData?.name) <= previewCount) {
        dispatchFileDragEvents(composer, file);
      }
      const accepted = await waitForQwenImagePreview('qwen-cn', previewCount, timeoutMs, attachmentData?.name);
      if (!accepted) {
        console.warn('[Image Injection] Qwen China attachment input and preview not found');
      }
      return accepted
        ? createImageInjectionSuccess()
        : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    }

    if (!assignFilesToInput(fileInput, [file])) {
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }

    dispatchFileInputEvents(fileInput);

    const accepted = await waitForQwenImagePreview('qwen-cn', previewCount, timeoutMs, attachmentData?.name);
    if (!accepted) {
      console.warn('[Image Injection] Qwen China upload did not produce a preview');
    }
    return accepted
      ? createImageInjectionSuccess()
      : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
  }

  function findQwenGlobalDropTarget() {
    const textarea = document.querySelector('.message-input-textarea') || findProviderInput('qwen-global');
    const form = textarea?.closest?.('form');
    if (form) {
      return form;
    }
    const grandParent = textarea?.parentElement?.parentElement;
    if (grandParent && grandParent !== document.body && grandParent !== document.documentElement) {
      return grandParent;
    }
    return (
      document.querySelector('#dropzone-container') ||
      textarea?.parentElement ||
      textarea ||
      null
    );
  }

  /**
   * Outer Qwen Global composer boundary: the dropzone form/container that wraps
   * .message-input-container, where Qwen attaches image and file previews.
   */
  function getQwenGlobalComposerRoot(input = null) {
    const textarea = input || document.querySelector('.message-input-textarea') || findProviderInput('qwen-global');
    if (!textarea) {
      return document.querySelector('#dropzone-container') || null;
    }
    // Resolve one selector at a time: a combined closest() returns the nearest
    // match and could stop at an inner wrapper inside the outer dropzone form.
    for (const selector of ['form#dropzone-container', 'form', '#dropzone-container', '[class*="dropzone"]']) {
      const outer = textarea.closest?.(selector);
      if (outer) {
        return outer;
      }
    }
    const container = textarea.closest?.('.message-input-container');
    const dropTarget = findQwenGlobalDropTarget();
    if (container && dropTarget && dropTarget !== container && dropTarget.contains(container)) {
      return dropTarget;
    }
    return container || dropTarget || textarea.parentElement || null;
  }

  async function injectImageToQwenGlobal(file, attachmentData) {
    const isDoc = isDocumentAttachmentData(attachmentData);
    const timeoutMs = getPreviewTimeoutMs(attachmentData);
    const previewCount = getQwenGlobalPreviewEvidence(attachmentData?.name);

    if (isDoc) {
      const dropTarget = findQwenGlobalDropTarget();
      const fileInput = findQwenFileInput('qwen-global', attachmentData);
      if (!dropTarget && !fileInput) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      // Live chat.qwen.ai ignores synthetic change events on React-controlled #filesUpload,
      // while DragEvent drop on the composer form/wrapper immediately uploads documents.
      // Try drop first with a bounded probe window when #filesUpload also exists so we
      // avoid both duplicate uploads and burning the full 10s timeout on an unresponsive input.
      // A drop the page consumed (preventDefault) is an upload in progress: wait out
      // the full preview timeout rather than re-sending the file through #filesUpload.
      const dropProbeWindowMs = fileInput ? Math.min(1000, timeoutMs) : timeoutMs;
      if (dropTarget) {
        const dropConsumed = dispatchFileDragEvents(dropTarget, file);
        const dropAccepted = await waitForQwenImagePreview(
          'qwen-global',
          previewCount,
          dropConsumed ? timeoutMs : dropProbeWindowMs,
          attachmentData?.name
        );
        if (dropAccepted) {
          return createImageInjectionSuccess();
        }
        if (dropConsumed) {
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
        }
      }

      if (fileInput) {
        if (!assignFilesToInput(fileInput, [file])) {
          return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
        }
        dispatchFileInputEvents(fileInput);
        const remainingTimeoutMs = dropTarget ? Math.max(1000, timeoutMs - dropProbeWindowMs) : timeoutMs;
        const accepted = await waitForQwenImagePreview(
          'qwen-global',
          previewCount,
          remainingTimeoutMs,
          attachmentData?.name
        );
        return accepted
          ? createImageInjectionSuccess()
          : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
      }

      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    }

    const editor = document.querySelector('.message-input-textarea');

    if (!editor) {
      console.warn('[Image Injection] Qwen Global editor not found');
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    editor.focus();
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    }));

    const accepted = await waitForQwenImagePreview('qwen-global', previewCount, timeoutMs, attachmentData?.name);
    if (!accepted) {
      console.warn('[Image Injection] Qwen Global upload did not produce an image preview');
    }
    return accepted
      ? createImageInjectionSuccess()
      : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
  }

  /**
   * Dispatches one drop sequence and resolves true only after new filename
   * preview evidence for this document appears, so a drop that no page handler
   * consumed is never acknowledged as an upload. Alerts, toasts and other
   * rejection UI never count as preview evidence.
   */
  async function dropDocumentAndConfirmPreview(target, file, attachmentData) {
    const fileName = attachmentData?.name || file?.name || '';
    const countEvidence = () =>
      countFilenamePreviewEvidence(document, fileName, { excludeRejectionUi: true });
    const previousCount = countEvidence();
    dispatchFileDragEvents(target, file);
    return waitForPreviewIncrease(
      countEvidence,
      previousCount,
      getPreviewTimeoutMs(attachmentData)
    );
  }

  /**
   * Dispatches dragenter/dragover/drop with the file and returns true when a
   * page handler consumed the drop (called preventDefault()).
   */
  function dispatchFileDragEvents(target, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    let dropConsumed = false;

    ['dragenter', 'dragover', 'drop'].forEach(type => {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
      if (!event.dataTransfer) {
        try {
          Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
        } catch {
          // Ignore non-configurable native DragEvent property.
        }
      }
      target.dispatchEvent(event);
      if (type === 'drop') {
        dropConsumed = event.defaultPrevented;
      }
    });
    return dropConsumed;
  }

  function findQwenFileInput(provider, attachmentData = null) {
    const selectors = FILE_INPUT_SELECTORS[provider] || [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (acceptsAttachmentFile(el, attachmentData)) {
          return el;
        }
      }
    }
    return null;
  }

  async function waitForQwenFileInput(provider, timeoutMs, attachmentData = null) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const fileInput = findQwenFileInput(provider, attachmentData);
      if (fileInput) {
        return fileInput;
      }

      await sleep(100);
    }

    return null;
  }

  function countQwenAttachmentPreviews(provider, fileName = '', { root = null } = {}) {
    if (provider === 'qwen-cn') {
      const composer = root || document.querySelector('[data-chat-input-layout="true"]') || document;
      const imgCount = composer.querySelectorAll('img[alt="avatar"]').length;
      const docCount = fileName ? countFilenamePreviewEvidence(composer, fileName, { excludeRejectionUi: true }) : 0;
      return Math.max(imgCount, docCount);
    }
    const evidence = getQwenGlobalPreviewEvidence(fileName, { root });
    return Math.max(evidence.images, evidence.cards, evidence.filenames, evidence.composerFilenames);
  }

  /**
   * Qwen Global preview evidence split by kind, scoped to the outer composer.
   * Each kind is compared against its own baseline so an existing document card
   * can never mask a newly pasted image preview (or vice versa).
   */
  function getQwenGlobalPreviewEvidence(fileName = '', { root = null } = {}) {
    const searchRoot = root || getQwenGlobalComposerRoot() || document;
    const normalizedName = (fileName || '').trim().toLowerCase();
    const imgCount = [...searchRoot.querySelectorAll('.vision-item-image')]
      .filter((el) => !isRejectionUiElement(el, normalizedName)).length;
    const docCardCount = [...searchRoot.querySelectorAll(
      '[class*="file-item"], [class*="attachment-item"], [class*="file-card"], [data-file-name], [data-filename]'
    )].filter(
      (el) => !el.closest('textarea, input, [contenteditable="true"]') && !isRejectionUiElement(el, normalizedName)
    ).length;
    const filenameCount = fileName
      ? countFilenamePreviewEvidence(searchRoot, fileName, { excludeRejectionUi: true })
      : 0;
    let composerFilenameCount = 0;
    if (normalizedName) {
      const evidence = new Set();
      searchRoot.querySelectorAll('span, div, p, li, button, [role="listitem"]').forEach((el) => {
        if (el.closest('textarea, input, [contenteditable="true"]') || isRejectionUiElement(el, normalizedName)) {
          return;
        }
        if (el.children.length > 0) {
          return;
        }
        const text = (el.textContent || '').trim().toLowerCase();
        if (text && text.length <= 240 && text.includes(normalizedName)) {
          evidence.add(el.parentElement && el.parentElement !== searchRoot ? el.parentElement : el);
        }
      });
      composerFilenameCount = evidence.size;
    }
    return {
      images: imgCount,
      cards: docCardCount,
      filenames: filenameCount,
      composerFilenames: composerFilenameCount
    };
  }

  function hasQwenPreviewIncrease(provider, previous, fileName = '') {
    if (provider === 'qwen-global' && previous && typeof previous === 'object') {
      const current = getQwenGlobalPreviewEvidence(fileName);
      return Object.keys(current).some((key) => current[key] > (previous[key] || 0));
    }
    return countQwenAttachmentPreviews(provider, fileName) > previous;
  }

  async function waitForQwenImagePreview(provider, previousCount, timeoutMs, fileName = '') {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (hasQwenPreviewIncrease(provider, previousCount, fileName)) {
        console.log('[Image Injection] Qwen attachment preview detected for:', provider);
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  // Profile/avatar/settings dialogs mount their own (image-only) file inputs that must never
  // receive composer attachments, e.g. GLM-5.4's `.user-profile-edit-dialogs__hidden-input`.
  const CHATGLM_DECOY_FILE_INPUT_SELECTOR =
    '.user-profile-edit-dialogs__hidden-input, .user-profile-edit-dialogs input[type="file"]';
  // Broad ancestor heuristics only apply to the generic fallback selectors, so an unrelated
  // page wrapper class can never hide the explicitly scoped composer input.
  const CHATGLM_FALLBACK_DECOY_ANCESTOR_SELECTOR =
    '[class*="user-profile"], [class*="avatar"], [class*="setting"], .el-dialog';
  const CHATGLM_COMPOSER_FILE_INPUT_SELECTOR_COUNT = 3;
  const CHATGLM_UPLOAD_CARD_SELECTOR = '.upload-list .upload-card';
  const CHATGLM_UPLOAD_CARD_UNSETTLED_CLASS_RE = /(?:^|[-_])(?:error|failed|fail|loading|uploading|pending)$/i;
  const CHATGLM_UPLOAD_CARD_UNSETTLED_STATE_RE = /^(?:error|failed|fail|loading|uploading|pending)$/i;
  const CHATGLM_UPLOAD_CARD_UNSETTLED_DESCENDANT_SELECTOR = [
    '.is-loading',
    '[class*="--error"]',
    '[class*="--failed"]',
    '[class*="--loading"]',
    '[class*="--uploading"]',
    '[class*="__error"]',
    '[class*="__fail"]',
    '[class*="__loading"]',
    '[class*="__uploading"]',
    '[role="alert"]'
  ].join(', ');

  function isChatGLMDecoyFileInput(input, { fromFallbackSelector = true } = {}) {
    return Boolean(
      input?.matches?.(CHATGLM_DECOY_FILE_INPUT_SELECTOR) ||
      (fromFallbackSelector && input?.closest?.(CHATGLM_FALLBACK_DECOY_ANCESTOR_SELECTOR))
    );
  }

  /** GLM-5.4 renders a real `<button class="send-button">`; the legacy UI uses a mousedown div. */
  function isChatGLMGlm54SendButton(element) {
    return Boolean(element?.matches?.('button.send-button'));
  }

  /** True when a GLM-5.4 send-button is mounted but disabled (e.g. while attachments upload). */
  function hasDisabledChatGLMGlm54SendButton() {
    const buttons = [...document.querySelectorAll('button.send-button')];
    return buttons.length > 0 && !buttons.some(button => isProviderSendControlEnabled('chatglm', button));
  }

  function isChatGLMUploadCardErrored(card) {
    return [...card.classList].some(token => /(?:^|[-_])(?:error|failed|fail)$/i.test(token)) ||
      /^(?:error|failed|fail)$/i.test((card.getAttribute('data-status') || card.getAttribute('data-state') || '').trim()) ||
      Boolean(card.querySelector('[class*="--error"], [class*="--failed"], [class*="__error"], [class*="__fail"], [role="alert"]'));
  }

  /** A card counts as a confirmed upload only once it is neither errored nor still uploading. */
  function isChatGLMUploadCardSettled(card) {
    if ([...card.classList].some(token => CHATGLM_UPLOAD_CARD_UNSETTLED_CLASS_RE.test(token))) {
      return false;
    }
    const state = (card.getAttribute('data-status') || card.getAttribute('data-state') || '').trim();
    if (CHATGLM_UPLOAD_CARD_UNSETTLED_STATE_RE.test(state) || card.getAttribute('aria-busy') === 'true') {
      return false;
    }
    return !card.querySelector(CHATGLM_UPLOAD_CARD_UNSETTLED_DESCENDANT_SELECTOR);
  }

  const CHATGLM_NAME_ELLIPSIS_RE = /\.{3}|\u2026/;
  const CHATGLM_TRUNCATED_NAME_MIN_CHARS = 3;

  /**
   * True when a GLM-5.4 card label names `fileName`: the exact name, the name without its
   * extension, or a truncated label such as "日本中部京都红叶之旅_..." / "日本...(1).docx".
   */
  function chatGLMCardLabelMatchesName(label, fileName) {
    const text = (label || '').trim().toLowerCase();
    const name = (fileName || '').trim().toLowerCase();
    if (!text || !name) {
      return false;
    }
    if (text === name) {
      return true;
    }
    const stem = getAttachmentFileNameStem(name).toLowerCase();
    if (stem && text === stem) {
      return true;
    }
    const ellipsis = text.match(CHATGLM_NAME_ELLIPSIS_RE);
    if (!ellipsis) {
      return false;
    }
    const head = text.slice(0, ellipsis.index).trim();
    const tail = text.slice(ellipsis.index + ellipsis[0].length).trim();
    return head.length + tail.length >= CHATGLM_TRUNCATED_NAME_MIN_CHARS &&
      head.length + tail.length < name.length &&
      name.startsWith(head) &&
      name.endsWith(tail);
  }

  function getChatGLMUploadCardLabels(card) {
    return [...card.querySelectorAll('.upload-card__name')]
      .flatMap(nameEl => [nameEl.textContent || '', nameEl.getAttribute('title') || ''])
      .map(label => label.trim())
      .filter(Boolean);
  }

  function chatGLMUploadCardMatchesName(card, fileName) {
    return getChatGLMUploadCardLabels(card).some(label => chatGLMCardLabelMatchesName(label, fileName));
  }

  /** GLM-5.4 image cards render only a thumbnail, without a `.upload-card__name` label. */
  function isChatGLMUnnamedUploadCard(card) {
    return getChatGLMUploadCardLabels(card).length === 0;
  }

  function hasChatGLMGlm54UploadList() {
    return Boolean(document.querySelector('.upload-attachment-picker, .upload-list'));
  }

  /**
   * Snapshots each kind of ChatGLM attachment evidence separately so a new upload is
   * confirmed by any kind growing past its own baseline (mixed doc + image never stall).
   * GLM-5.4 evidence is correlated with the requested file: a named card must match its
   * name, and unnamed (thumbnail-only) cards only count for images. With `settledOnly`
   * false (the baseline), still-uploading cards are included, so an unrelated card that
   * was already loading can never confirm the new file just by finishing.
   */
  function snapshotChatGLMAttachmentPreviews(attachmentData, { settledOnly = true } = {}) {
    const fileName = attachmentData?.name || '';
    const normalizedName = fileName.trim().toLowerCase();
    const previewList = document.querySelector('.file-list-box-content-list');
    const cards = [...document.querySelectorAll(CHATGLM_UPLOAD_CARD_SELECTOR)]
      .filter(card => (settledOnly ? isChatGLMUploadCardSettled(card) : !isChatGLMUploadCardErrored(card)));
    // The GLM-5.4 picker wrapper carries every card's filename, including errored ones,
    // so generic filename evidence is only used for the legacy UI.
    const legacyNames = normalizedName && !hasChatGLMGlm54UploadList()
      ? countFilenamePreviewEvidence(document, fileName)
      : 0;
    return {
      legacyList: previewList ? previewList.children.length : 0,
      legacyNames,
      cardNames: normalizedName
        ? cards.filter(card => chatGLMUploadCardMatchesName(card, fileName)).length
        : 0,
      unnamedImageCards: isDocumentAttachmentData(attachmentData)
        ? 0
        : cards.filter(isChatGLMUnnamedUploadCard).length
    };
  }

  function hasChatGLMAttachmentPreviewIncrease(previous, current) {
    return Object.keys(current).some(key => current[key] > (previous[key] || 0));
  }

  /**
   * Splits fallback attachments into the ones still staged as non-errored GLM-5.4 cards and
   * the ones that must be re-delivered. Each card backs at most one attachment: documents
   * need a name match, images take a name match or else an unnamed thumbnail card.
   */
  function reconcileChatGLMRetainedAttachments(composerRoot, attachments) {
    const cardRoot = composerRoot?.querySelector?.('.upload-list') ? composerRoot : document;
    // Uploading cards still occupy the composer, so a retry must not upload them again.
    const cards = [...cardRoot.querySelectorAll(CHATGLM_UPLOAD_CARD_SELECTOR)]
      .filter(card => !isChatGLMUploadCardErrored(card));
    const claimed = new Set();
    const retainedIndexes = new Set();
    const claim = (predicate) => {
      (attachments || []).forEach((attachment, index) => {
        if (retainedIndexes.has(index)) return;
        const card = cards.find(candidate => !claimed.has(candidate) && predicate(candidate, attachment));
        if (card) {
          claimed.add(card);
          retainedIndexes.add(index);
        }
      });
    };
    claim((card, attachment) => Boolean(attachment?.name) && chatGLMUploadCardMatchesName(card, attachment.name));
    claim((card, attachment) => !isDocumentAttachmentData(attachment) && isChatGLMUnnamedUploadCard(card));
    const retained = [];
    const missing = [];
    (attachments || []).forEach((attachment, index) => {
      (retainedIndexes.has(index) ? retained : missing).push(attachment);
    });
    return { cardCount: cards.length, retained, missing };
  }

  /** Attachments still staged in the ChatGLM composer (errored GLM-5.4 cards excluded). */
  function countChatGLMStagedAttachments(composerRoot, candidateImages = []) {
    const previewList = document.querySelector('.file-list-box-content-list');
    const legacyListCount = previewList ? previewList.children.length : 0;
    // Only cards that back one of the candidate attachments count, so a user's unrelated
    // upload never stands in for a fallback attachment that is no longer staged.
    const retainedCount = reconcileChatGLMRetainedAttachments(composerRoot, candidateImages).retained.length;
    const legacyNameCount = composerRoot && !hasChatGLMGlm54UploadList()
      ? (candidateImages || []).filter(img => img?.name && countFilenamePreviewEvidence(composerRoot, img.name) > 0).length
      : 0;
    return legacyListCount + retainedCount + legacyNameCount;
  }

  async function waitForChatGLMImagePreview(previousSnapshot, timeoutMs, attachmentData) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (hasChatGLMAttachmentPreviewIncrease(previousSnapshot, snapshotChatGLMAttachmentPreviews(attachmentData))) {
        console.log('[Image Injection] ChatGLM attachment preview detected');
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  function getChatGLMCandidateFileInputs() {
    const candidates = [];
    FILE_INPUT_SELECTORS.chatglm.forEach((selector, index) => {
      const fromFallbackSelector = index >= CHATGLM_COMPOSER_FILE_INPUT_SELECTOR_COUNT;
      for (const input of document.querySelectorAll(selector)) {
        if (!candidates.includes(input) && !isChatGLMDecoyFileInput(input, { fromFallbackSelector })) {
          candidates.push(input);
        }
      }
    });
    return candidates;
  }

  function findChatGLMFileInput(attachmentData = null) {
    return getChatGLMCandidateFileInputs().find(input => acceptsAttachmentFile(input, attachmentData)) || null;
  }

  async function waitForChatGLMFileInput(timeoutMs, attachmentData = null) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const fileInput = findChatGLMFileInput(attachmentData);
      if (fileInput) {
        return fileInput;
      }

      await sleep(100);
    }

    return null;
  }

  async function injectImageToChatGLM(imageData) {
    try {
      const isDoc = isDocumentAttachmentData(imageData);
      let fileInput = findChatGLMFileInput(imageData);

      if (!fileInput) {
        const triggerSelector = isDoc
          ? '.upload-file-btn-container, .upload-btn-container, .upload-image-btn-container'
          : '.upload-image-btn-container';
        const uploadButton = document.querySelector(triggerSelector);
        if (uploadButton) {
          uploadButton.click();
          fileInput = await waitForChatGLMFileInput(1000, imageData);
        }
      }

      if (!fileInput) {
        if (isDoc && getChatGLMCandidateFileInputs().length > 0) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }
        console.warn('[Image Injection] ChatGLM input not found');
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const previousSnapshot = snapshotChatGLMAttachmentPreviews(imageData, { settledOnly: false });
      const file = await createAttachmentFile(imageData);

      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }

      dispatchFileInputEvents(fileInput);

      const accepted = await waitForChatGLMImagePreview(
        previousSnapshot,
        getPreviewTimeoutMs(imageData),
        imageData
      );
      if (!accepted) {
        console.warn('[Image Injection] ChatGLM upload did not produce a preview');
      }
      return accepted
        ? createImageInjectionSuccess()
        : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    } catch (error) {
      console.error('[Image Injection] ChatGLM error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  function countZaiGlobalAttachmentPreviews(fileName = '') {
    const imgCount = document.querySelectorAll('.chip-scroll img[data-cy="image"]').length;
    const chipContainer = document.querySelector('.chip-scroll');
    const chipCount = chipContainer ? chipContainer.children.length : 0;
    const filenameCount = fileName ? countFilenamePreviewEvidence(document, fileName) : 0;
    return Math.max(imgCount, chipCount, filenameCount);
  }

  async function waitForZaiGlobalImagePreview(previousCount, timeoutMs, fileName = '') {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (countZaiGlobalAttachmentPreviews(fileName) > previousCount) {
        console.log('[Image Injection] Z.ai Global attachment preview detected');
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  async function injectImageToZaiGlobal(imageData) {
    try {
      const isDoc = isDocumentAttachmentData(imageData);
      const allInputs = [...document.querySelectorAll('input[type="file"]')];
      const fileInput =
        allInputs.find(input => input.multiple && acceptsAttachmentFile(input, imageData)) ||
        allInputs.find(input => acceptsAttachmentFile(input, imageData)) ||
        null;
      if (!fileInput) {
        if (isDoc && allInputs.length > 0) {
          return createImageInjectionSkipped(IMAGE_INJECTION_REASONS.TYPE_NOT_ACCEPTED);
        }
        console.warn('[Image Injection] Z.ai Global input not found');
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.CONTROL_NOT_FOUND);
      }

      const previousCount = countZaiGlobalAttachmentPreviews(imageData.name);
      const file = await createAttachmentFile(imageData);

      if (!assignFilesToInput(fileInput, [file])) {
        return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
      }

      dispatchFileInputEvents(fileInput);

      const accepted = await waitForZaiGlobalImagePreview(
        previousCount,
        getPreviewTimeoutMs(imageData),
        imageData.name
      );
      if (!accepted) {
        console.warn('[Image Injection] Z.ai Global upload did not produce a preview');
      }
      return accepted
        ? createImageInjectionSuccess()
        : createImageInjectionFailure(IMAGE_INJECTION_REASONS.PREVIEW_TIMEOUT);
    } catch (error) {
      console.error('[Image Injection] Z.ai Global error:', error);
      return createImageInjectionFailure(IMAGE_INJECTION_REASONS.INJECTION_ERROR);
    }
  }

  async function waitForDoubaoFileInput(timeoutMs = 800, attachmentData = null) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const candidates = [
        ...document.querySelectorAll('#input-engine-container input[type="file"]'),
        ...document.querySelectorAll('input[type="file"]')
      ];
      const fileInput = candidates.find(input => acceptsAttachmentFile(input, attachmentData)) || null;

      if (fileInput) {
        return fileInput;
      }

      await sleep(100);
    }

    return null;
  }

  function countDoubaoAttachmentPreviews(fileName = '') {
    const groupImages = document.querySelectorAll('.semi-image-preview-group img, .semi-image-preview-group').length;
    const blobImages = document.querySelectorAll(
      '#input-engine-container img[src^="blob:"], #input-engine-container img[src*="blob:"]'
    ).length;
    const fileCards = document.querySelectorAll(
      '#input-engine-container [class*="file-card"], #input-engine-container [class*="file-item"], #input-engine-container [class*="attachment-item"]'
    ).length;
    const filenameEvidence = fileName ? countFilenamePreviewEvidence(document, fileName) : 0;
    return Math.max(groupImages, blobImages, fileCards, filenameEvidence);
  }

  async function waitForDoubaoImagePreview(previousCount = 0, fileName = '', timeoutMs = 1200) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (countDoubaoAttachmentPreviews(fileName) > previousCount) {
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

      const file = await createAttachmentFile(imageData);

      // Focus the element first
      targetElement.focus();
      dispatchFileDragEvents(targetElement, file);

      return true;
    } catch (error) {
      console.error('[Image Injection] Drag-drop upload failed:', error);
      return false;
    }
  }

  // Fallback: Try to upload attachment via file input
  async function tryFileInputUpload(provider, imageData) {
    try {
      const fileInputSelectors = FILE_INPUT_SELECTORS[provider] || [];

      // First try specific selectors matching accept
      let fileInput = null;
      for (const selector of fileInputSelectors) {
        for (const candidate of document.querySelectorAll(selector)) {
          if (acceptsAttachmentFile(candidate, imageData)) {
            fileInput = candidate;
            break;
          }
        }
        if (fileInput) break;
      }

      // If no direct file input, try to find any matching file input
      if (!fileInput) {
        const allFileInputs = document.querySelectorAll('input[type="file"]');
        for (const input of allFileInputs) {
          if (acceptsAttachmentFile(input, imageData)) {
            fileInput = input;
            break;
          }
        }
      }

      if (!fileInput) {
        console.warn('[Image Injection] No file input found');
        return false;
      }

      const file = await createAttachmentFile(imageData);
      if (!assignFilesToInput(fileInput, [file])) {
        return false;
      }

      dispatchFileInputEvents(fileInput);

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

    // Every message type below acts on the page; check the sender first.
    if (!isFromMultiPanelHost(event)) {
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
      if (provider === 'chatgpt' || provider === 'aistudio') {
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
        if ((provider === 'chatgpt' || provider === 'aistudio') && event.data.requestId) {
          startChatgptSendTracking(event.data.requestId, provider);
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
      if (provider === 'chatgpt' || provider === 'aistudio') {
        stopChatgptSendTracking();
      }
      const providerMode = provider === 'google'
        ? normalizeGoogleProviderMode(event.data.providerMode)
        : null;
      console.log('[Text Injection] NEW_CHAT message received, provider:', provider);
      console.log('[Text Injection] Current URL:', window.location.href);
      if (provider) {
        console.log('[Text Injection] Creating new chat for', provider);
        clickNewChatButton(provider, providerMode, {
          temporaryChat: event.data.temporaryChat
        });
        if (provider === 'chatgpt') {
          scheduleChatgptNewChatComposerClear();
        }
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
      if (provider === 'chatgpt' && chatgptActiveClearMatchSentOnly) {
        clearChatgptComposerDraftOnce({ matchSentOnly: true, focus: false });
      }
      // A fill right after New Chat must not be wiped by the pending draft clear.
      cancelChatgptNewChatComposerClear();
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
    if (detectProvider() === 'chatgpt' && chatgptActiveClearMatchSentOnly) {
      clearChatgptComposerDraftOnce({ matchSentOnly: true, focus: false });
    }
    cancelChatgptNewChatComposerClear();

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
    if (provider === 'chatgpt' || provider === 'aistudio') {
      if (shouldAutoSubmit && event.data.requestId) {
        startChatgptSendTracking(event.data.requestId, provider);
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
          scheduleAutoSubmit(provider, providerMode);
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
                scheduleAutoSubmit(provider, providerMode);
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
    const box = {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(viewport.width, left + container.clientWidth),
      bottom: Math.min(viewport.height, top + container.clientHeight)
    };
    // Only what clipping ancestors show, e.g. not the part of a box scrolled
    // sideways that is hidden under the side rail beside it.
    for (let node = container.parentElement; node && !isSnapshotDocumentScroller(node); node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (!SNAPSHOT_CLIPPING_OVERFLOW.test(style.overflowX) && !SNAPSHOT_CLIPPING_OVERFLOW.test(style.overflowY)) {
        continue;
      }
      const nodeRect = node.getBoundingClientRect();
      const nodeLeft = nodeRect.left + node.clientLeft;
      const nodeTop = nodeRect.top + node.clientTop;
      box.left = Math.max(box.left, nodeLeft);
      box.top = Math.max(box.top, nodeTop);
      box.right = Math.min(box.right, nodeLeft + node.clientWidth);
      box.bottom = Math.min(box.bottom, nodeTop + node.clientHeight);
    }
    return box;
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
   * Rendered messages that start like the prompt, best first: a match in a
   * known user message beats any other, e.g. an answer heading repeating the
   * question; then a match at the start of a text node (a message bubble)
   * beats one in the middle of a paragraph, e.g. an answer quoting it; then
   * a match in the main conversation beats one elsewhere; then the latest wins.
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
          const rank = (element.closest(SNAPSHOT_USER_TURN_SELECTORS) ? 0 : 4)
            + (segment.start === offset ? 0 : 2) + (container === main ? 0 : 1);
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
    postToMultiPanelHost({
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
    });
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
    const isOffTarget = () => session.alignTarget !== null
      && Math.abs(getSnapshotScrollTop(session.container) - session.alignTarget) > SNAPSHOT_ALIGN_TOLERANCE_PX;
    if (isOffTarget()) {
      // The page scrolled itself meanwhile (e.g. back to the bottom).
      scrollSnapshotContainer(session.container, session.alignTarget);
      await settleSnapshotScreen(session);
    }
    if (isOffTarget()) {
      // It keeps doing so: a stitch from here would miss the start, so the
      // panel is shown as it is; a current view just is not aligned.
      session.alignedBy = null;
      session.alignTarget = null;
      session.matched = false;
      postSnapshotState(data.requestId, session, stitch ? { error: 'unaligned' } : {});
      return;
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
  setupSameOriginAccountNavigation();
  setupProviderLocationReporting();
  setupPageWidthReporting();
  setupChatgptSentDraftTracking();
  resumePendingChatgptNewChatComposerClear();
  window.addEventListener('message', handleTextInjection);
})();
