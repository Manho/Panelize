/**
 * Minimal ChatGPT-like page served in place of https://chatgpt.com inside
 * multi-panel iframes. The real content script drives it through the same
 * selectors it uses on the live site; the page mimics the site behaviors that
 * multi-panel focus protection has to defend against.
 *
 * Focus steals use plain `element.focus()` from page scripts, which is how
 * provider SPAs autofocus their composer after load, new chat, or send.
 *
 * @param {object} [config]
 * @param {number[]} [config.loadStealDelays] - Composer autofocus delays after load.
 * @param {number[]} [config.newChatStealDelays] - Autofocus delays after the new chat button is clicked.
 * @param {number[]} [config.sendStealDelays] - Autofocus delays after the send button is clicked.
 * @param {number} [config.busyAfterSendMs] - How long the stop button stays visible after send (0 = never shown).
 * @param {'legacy'|'current'} [config.composer] - `legacy` renders the `#prompt-textarea`
 *   composer. `current` renders the `[data-composer-markdown]` editor inside
 *   `form[data-chatgpt-composer]` with a generic submit button, after an
 *   inline edit form and a hidden composer, whose Send clicks count as stray.
 * @returns {string} HTML document.
 */
export function renderChatgptFixture({
  loadStealDelays = [],
  newChatStealDelays = [],
  sendStealDelays = [],
  busyAfterSendMs = 0,
  composer = 'legacy',
} = {}) {
  const config = { loadStealDelays, newChatStealDelays, sendStealDelays, busyAfterSendMs };
  const composerHtml = COMPOSER_HTML[composer];
  if (!composerHtml) {
    throw new Error(`Unknown ChatGPT fixture composer: ${composer}`);
  }
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ChatGPT fixture</title></head>
<body>
  <nav><button type="button" data-testid="new-chat-button" aria-label="New chat">New chat</button></nav>
${composerHtml}
  <script>
    const config = ${JSON.stringify(config)};
    const form = document.querySelector('form[data-type="unified-composer"]');
    const composer = form.querySelector('[contenteditable="true"]');
    const sendButton = form.querySelector('button[aria-label^="Send"]');
    window.__fixture = { steals: [], sends: 0, newChats: 0, sentTexts: [], straySends: [] };

    document.addEventListener('submit', (event) => event.preventDefault());
    document.querySelectorAll('button[aria-label^="Send"]').forEach((button) => {
      if (button !== sendButton) {
        button.addEventListener('click', () => {
          window.__fixture.straySends.push(button.closest('form').dataset.fixtureRole);
        });
      }
    });

    function scheduleComposerFocus(delays, reason) {
      delays.forEach((delay) => {
        setTimeout(() => {
          composer.focus();
          window.__fixture.steals.push({ reason, delay });
        }, delay);
      });
    }

    scheduleComposerFocus(config.loadStealDelays, 'load');

    document.querySelector('[data-testid="new-chat-button"]').addEventListener('click', () => {
      window.__fixture.newChats += 1;
      composer.textContent = '';
      scheduleComposerFocus(config.newChatStealDelays, 'new-chat');
    });

    sendButton.addEventListener('click', () => {
      window.__fixture.sends += 1;
      window.__fixture.sentTexts.push(composer.textContent);
      composer.textContent = '';
      scheduleComposerFocus(config.sendStealDelays, 'send');
      if (config.busyAfterSendMs > 0) {
        setTimeout(() => {
          form.insertAdjacentHTML('beforeend',
            '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>');
          setTimeout(() => {
            document.querySelector('[data-testid="stop-button"]')?.remove();
          }, config.busyAfterSendMs);
        }, 100);
      }
    });
  </script>
</body>
</html>`;
}

const COMPOSER_HTML = {
  legacy: `
  <form data-type="unified-composer">
    <input type="file" accept="image/*" multiple hidden>
    <div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div>
    <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
  </form>`,

  // Attributes observed on the live composer that has no `#prompt-textarea`.
  current: `
  <form data-fixture-role="edit-message">
    <textarea aria-label="Edit message">Earlier message</textarea>
    <button type="submit" aria-label="Send">Send</button>
  </form>
  <form data-fixture-role="hidden-composer" data-chatgpt-composer data-composer-placement="home" hidden>
    <div data-composer-markdown contenteditable="true" role="textbox" class="ProseMirror"></div>
    <button type="submit" aria-label="Send">Send</button>
  </form>
  <form data-type="unified-composer" data-chatgpt-composer data-composer-placement="thread">
    <div data-composer-markdown contenteditable="true" role="textbox" class="ProseMirror" aria-label="Chat with ChatGPT"></div>
    <button type="submit" aria-label="Send">Send</button>
  </form>`,
};
