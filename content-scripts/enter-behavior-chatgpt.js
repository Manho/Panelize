// ChatGPT Enter/Shift+Enter behavior swap
// Supports customizable key combinations via settings

// Helper: Create a synthetic Enter KeyboardEvent with specified modifiers
function createEnterEvent(modifiers = {}) {
  return new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    shiftKey: modifiers.shift || false,
    ctrlKey: modifiers.ctrl || false,
    metaKey: modifiers.meta || false,
    altKey: modifiers.alt || false
  });
}

// Helper: Find ChatGPT's Send button within `root` (works for both main prompt and editing)
function findSendButton(root = document) {
  // Try specific data-testid attributes first (faster)
  const byTestId = root.querySelector('button[data-testid="send-button"]') ||
                   root.querySelector('button[data-testid="fruitjuice-send-button"]');
  if (byTestId) return byTestId;

  // Fallback: search by text content or aria-label
  return Array.from(root.querySelectorAll('button')).find(btn =>
    btn.textContent.trim() === 'Send' ||
    btn.getAttribute('aria-label')?.includes('Send') ||
    btn.getAttribute('aria-label')?.includes('send')
  );
}

function handleEnterSwap(event) {
  // Only handle trusted Enter key events
  // Skip if IME composition is in progress (e.g., Chinese/Japanese input method)
  if (!event.isTrusted || event.code !== "Enter" || event.isComposing) {
    return;
  }

  if (!enterKeyConfig || !enterKeyConfig.enabled) {
    return;
  }

  // Get the currently focused element
  const activeElement = document.activeElement;

  // Check if this is ChatGPT's input area:
  // 1. Main prompt: contenteditable composer editor (see chatgpt-composer.js)
  // 2. Editing area: Regular textarea element (appears when editing old messages)
  const isMainPrompt = Boolean(window.PanelizeChatgptComposer?.isEditor(activeElement)) &&
                       activeElement.contentEditable === "true";

  const isEditingTextarea = activeElement &&
                           activeElement.tagName === "TEXTAREA" &&
                           activeElement.offsetParent !== null; // visible check

  if (!isMainPrompt && !isEditingTextarea) {
    return;
  }

  // Check if this matches newline action
  if (matchesModifiers(event, enterKeyConfig.newlineModifiers)) {
    if (isEditingTextarea) {
      // For regular textarea: let native Enter behavior work
      // Don't preventDefault - just return and let browser handle it
      return;
    } else {
      // For ProseMirror: intercept and send Shift+Enter
      event.preventDefault();
      event.stopImmediatePropagation();

      // ProseMirror treats Shift+Enter as newline
      const newEvent = createEnterEvent({ shift: true });
      activeElement.dispatchEvent(newEvent);
    }
  }
  // Check if this matches send action
  else if (matchesModifiers(event, enterKeyConfig.sendModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();

    // Find and click the Send button (more reliable for both element types).
    // The main prompt's own form holds its button, so another form's Send is never clicked.
    const composerForm = isMainPrompt ? window.PanelizeChatgptComposer.findForm(activeElement) : null;
    const sendButton = findSendButton(composerForm || document);

    if (sendButton && !sendButton.disabled) {
      sendButton.click();
    } else {
      // Fallback: dispatch Meta+Enter for ProseMirror
      const newEvent = createEnterEvent({ meta: true });
      activeElement.dispatchEvent(newEvent);
    }
  }
  else {
    // Block any other Enter combinations (Ctrl+Enter, Alt+Enter, Meta+Enter, etc.)
    // This prevents ChatGPT's native keyboard shortcuts from interfering with user settings.
    // For example, ChatGPT natively uses Ctrl+Enter to send messages, but if the user
    // configured "swapped" mode (Enter=newline, Shift+Enter=send), then Ctrl+Enter
    // should do nothing to avoid confusion and ensure only the configured keys work.
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

// Apply the setting on initial load
applyEnterSwapSetting();
