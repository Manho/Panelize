/**
 * Long chat page served in place of a provider inside multi-panel iframes,
 * for "Full answers" snapshots. It is laid out like ChatGPT: the
 * conversation scrolls in its own container under a sticky header, and the
 * composer floats over the bottom of it. Every part has a solid color, so a
 * column of the stitched image tells which parts were captured, in which
 * order and how often.
 *
 * On load the conversation is scrolled to the bottom, as chat apps do.
 *
 * @param {object} options
 * @param {string} options.prompt - Text of the user message.
 * @param {number[][]} options.blocks - RGB color of each answer block.
 * @param {number} [options.blockHeight] - Height of each answer block.
 * @returns {string} HTML document.
 */
export function renderConversationFixture({ prompt, blocks, blockHeight = CONVERSATION_COLORS.blockHeight }) {
  const rgb = (color) => `rgb(${color.join(', ')})`;
  const escape = (text) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  const answer = blocks
    .map((color, index) => `<div class="block" data-block="${index}" style="background: ${rgb(color)}"></div>`)
    .join('');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Conversation fixture</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: ${rgb(CONVERSATION_COLORS.page)}; }
  #thread { position: absolute; inset: 0; overflow-y: auto; }
  header { position: sticky; top: 0; height: ${CONVERSATION_COLORS.headerHeight}px; background: ${rgb(CONVERSATION_COLORS.header)}; }
  .earlier { height: 600px; margin: 0 24px; background: ${rgb(CONVERSATION_COLORS.earlier)}; }
  .user { margin: 40px 24px 24px; padding: 12px; background: ${rgb(CONVERSATION_COLORS.user)}; font: 16px/24px sans-serif; color: rgb(250, 230, 150); }
  .block { height: ${blockHeight}px; margin: 0 24px; }
  .spacer { height: ${CONVERSATION_COLORS.composerHeight + 24}px; }
  form { position: absolute; left: 0; right: 0; bottom: 0; height: ${CONVERSATION_COLORS.composerHeight}px; margin: 0; background: ${rgb(CONVERSATION_COLORS.composer)}; }
  [data-composer-markdown] { height: 40px; margin: 12px; background: white; }
</style>
</head>
<body>
  <div id="thread">
    <header></header>
    <div class="earlier"></div>
    <div class="user">${escape(prompt)}</div>
    <div class="answer">${answer}</div>
    <div class="spacer"></div>
  </div>
  <form data-type="unified-composer" data-chatgpt-composer data-composer-placement="thread">
    <div data-composer-markdown contenteditable="true" role="textbox" class="ProseMirror" aria-label="Chat with ChatGPT"></div>
    <button type="submit" aria-label="Send">Send</button>
  </form>
  <script>
    const thread = document.getElementById('thread');
    thread.scrollTop = thread.scrollHeight;
  </script>
</body>
</html>`;
}

/** Colors and sizes of the fixture parts, for reading the image back. */
export const CONVERSATION_COLORS = Object.freeze({
  page: [255, 255, 255],
  header: [200, 0, 0],
  composer: [0, 0, 200],
  earlier: [150, 150, 150],
  user: [60, 60, 60],
  headerHeight: 48,
  composerHeight: 80,
  blockHeight: 300,
});
