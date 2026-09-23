/**
 * Provider pages for temporary chat E2E. Each page exposes the controls the
 * real content script looks for (TEMP_CHAT_BUTTON_SELECTORS and
 * NEW_CHAT_BUTTON_SELECTORS) and records what happened in `window.__fixture`.
 *
 * - gemini: the temporary chat toggle renders `tempButtonDelayMs` after load
 *   or after an in-page new chat, and a new chat turns temporary mode off,
 *   which is why multi-panel has to retry ENABLE_TEMP_CHAT.
 * - grok: temporary mode lives in the `#private` URL hash; the in-page new
 *   chat link and the private chat link use client-side routing.
 * - kimi: has no temporary chat control at all.
 *
 * @param {'gemini' | 'grok' | 'kimi'} provider
 * @param {object} [options]
 * @param {number} [options.tempButtonDelayMs] - Gemini toggle render delay.
 * @returns {string} HTML document.
 */
export function renderTemporaryChatFixture(provider, { tempButtonDelayMs = 0 } = {}) {
  const controls = {
    gemini: `
      <button type="button" aria-label="New chat" id="new-chat">New chat</button>
      <div id="temp-slot"></div>
      <div class="ql-editor" contenteditable="true"></div>`,
    grok: `
      <a href="/" id="new-chat">Home</a>
      <a href="/c#private" aria-label="Switch to Private Chat" id="private-chat">Private</a>
      <textarea></textarea>`,
    kimi: `
      <a href="/" class="new-chat-btn" id="new-chat">New chat</a>
      <div class="chat-input-editor" contenteditable="true"></div>`,
  }[provider];

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${provider} fixture</title></head>
<body>
  ${controls}
  <script>
    const provider = ${JSON.stringify(provider)};
    const tempButtonDelayMs = ${JSON.stringify(tempButtonDelayMs)};
    window.__fixture = { messages: [], newChatClicks: 0, tempChatClicks: 0 };

    window.addEventListener('message', (event) => {
      if (event.data && event.data.context === 'multi-panel') {
        window.__fixture.messages.push({ type: event.data.type, at: Date.now() });
      }
    });

    let tempButtonTimerId = null;
    function renderGeminiTempButton() {
      const slot = document.getElementById('temp-slot');
      slot.innerHTML = '';
      clearTimeout(tempButtonTimerId);
      tempButtonTimerId = setTimeout(() => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.testId = 'temp-chat-button';
        button.setAttribute('aria-label', 'Temporary chat');
        button.textContent = 'Temporary chat';
        button.addEventListener('click', () => {
          window.__fixture.tempChatClicks += 1;
          button.classList.toggle('temp-chat-on');
        });
        slot.appendChild(button);
      }, tempButtonDelayMs);
    }

    const newChat = document.getElementById('new-chat');
    newChat.addEventListener('click', (event) => {
      event.preventDefault();
      window.__fixture.newChatClicks += 1;
      if (provider === 'gemini') {
        renderGeminiTempButton();
      } else if (provider === 'grok') {
        history.pushState(null, '', '/');
      }
    });

    if (provider === 'gemini') {
      renderGeminiTempButton();
    }

    if (provider === 'grok') {
      document.getElementById('private-chat').addEventListener('click', (event) => {
        event.preventDefault();
        window.__fixture.tempChatClicks += 1;
        history.pushState(null, '', '/c#private');
      });
    }
  </script>
</body>
</html>`;
}
