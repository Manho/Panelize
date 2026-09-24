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
 * @returns {string} HTML document.
 */
export function renderChatgptFixture({
  loadStealDelays = [],
  newChatStealDelays = [],
  sendStealDelays = [],
  busyAfterSendMs = 0,
} = {}) {
  const config = { loadStealDelays, newChatStealDelays, sendStealDelays, busyAfterSendMs };
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ChatGPT fixture</title></head>
<body>
  <nav><button type="button" data-testid="new-chat-button" aria-label="New chat">New chat</button></nav>
  <form data-type="unified-composer">
    <div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div>
    <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
  </form>
  <script>
    const config = ${JSON.stringify(config)};
    const composer = document.getElementById('prompt-textarea');
    const form = document.querySelector('form[data-type="unified-composer"]');
    window.__fixture = { steals: [], sends: 0, newChats: 0, sentTexts: [] };

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

    document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
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
