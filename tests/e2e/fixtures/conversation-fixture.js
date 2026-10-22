/**
 * Long chat page served in place of a provider inside multi-panel iframes,
 * for "Full answers" snapshots. It is laid out like ChatGPT: the
 * conversation scrolls in its own container under a sticky header, and the
 * composer floats over the bottom of it, with a "Scroll to bottom" button
 * floating over the middle of the conversation and, optionally, a notice
 * stacked on the composer. Optional parts mimic what Gemini draws: a
 * section heading that sticks under the header with a shadow and a fade
 * below it, a wide table with a sticky header row in a horizontally
 * scrolling box, and a fade drawn by the composer's ::before over the
 * bottom of the conversation. Every part has a solid color, so a
 * column of the stitched image tells which parts were captured, in which
 * order and how often.
 *
 * On load the conversation is scrolled to the bottom, as chat apps do.
 *
 * @param {object} options
 * @param {string} options.prompt - Text of the user message.
 * @param {number[][]} options.blocks - RGB color of each answer block.
 * @param {number} [options.blockHeight] - Height of each answer block.
 * @param {boolean} [options.notice] - Show a text notice right above the
 *   composer, like Claude's "You've used 90% of your session limit".
 * @param {boolean} [options.stickyHeading] - Sticky heading after the first block.
 * @param {boolean} [options.wideTable] - Wide table after the second block.
 * @param {boolean} [options.fade] - Composer ::before fade over the conversation.
 * @param {boolean} [options.userRole] - Mark the user message with
 *   data-message-author-role="user", as ChatGPT does.
 * @param {number} [options.minWidth] - Width the page needs, like an app
 *   shell with a min-width (Kimi, ChatGLM); narrower panels scale it down.
 * @returns {string} HTML document.
 */
export function renderConversationFixture({
  prompt,
  blocks,
  blockHeight = CONVERSATION_COLORS.blockHeight,
  notice = false,
  stickyHeading = false,
  wideTable = false,
  fade = false,
  userRole = false,
  minWidth = 0,
}) {
  const rgb = (color) => `rgb(${color.join(', ')})`;
  const escape = (text) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  const table = `<div class="table-wrap"><table>
      <thead><tr>${'<th>Field</th>'.repeat(8)}</tr></thead>
      <tbody>${`<tr>${'<td>Value</td>'.repeat(8)}</tr>`.repeat(CONVERSATION_COLORS.tableRows)}</tbody>
    </table></div>`;
  const answer = blocks
    .map((color, index) => [
      `<div class="block" data-block="${index}" style="background: ${rgb(color)}"></div>`,
      index === 0 && stickyHeading ? '<h2 class="sticky-heading">Section</h2>' : '',
      index === 1 && wideTable ? table : '',
    ].join(''))
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
  .notice { position: absolute; left: 0; right: 0; bottom: 100%; height: ${CONVERSATION_COLORS.noticeHeight}px; background: ${rgb(CONVERSATION_COLORS.notice)}; font: 14px/${CONVERSATION_COLORS.noticeHeight}px sans-serif; }
  .notice span { margin-left: 120px; color: white; }
  .sticky-heading { position: sticky; top: ${CONVERSATION_COLORS.headerHeight}px; z-index: 1; height: ${CONVERSATION_COLORS.headingHeight}px; margin: 0 24px; background: ${rgb(CONVERSATION_COLORS.heading)}; box-shadow: 0 8px 12px rgba(0, 0, 0, 0.5); font: 16px/${CONVERSATION_COLORS.headingHeight}px sans-serif; color: transparent; }
  .sticky-heading::after { content: ''; position: absolute; left: 0; right: 0; top: 100%; height: 24px; background: linear-gradient(rgba(0, 0, 0, 0.4), transparent); }
  .table-wrap { margin: 0 24px; overflow-x: auto; }
  table { width: 1600px; border-collapse: collapse; font: 14px sans-serif; color: transparent; }
  th { position: sticky; top: 0; height: ${CONVERSATION_COLORS.tableHeaderHeight}px; padding: 0; background: ${rgb(CONVERSATION_COLORS.tableHeader)}; }
  td { height: ${CONVERSATION_COLORS.tableRowHeight}px; padding: 0; background: ${rgb(CONVERSATION_COLORS.tableRow)}; }
  form.fade::before { content: ''; position: absolute; left: 0; right: 0; bottom: 100%; height: ${CONVERSATION_COLORS.fadeHeight}; pointer-events: none; background: linear-gradient(transparent, ${rgb(CONVERSATION_COLORS.fade)} 30%); }
  #scroll-down { position: absolute; top: 45%; left: 16px; width: ${CONVERSATION_COLORS.floatingSize}px; height: ${CONVERSATION_COLORS.floatingSize}px; padding: 0; border: 0; border-radius: 50%; background: ${rgb(CONVERSATION_COLORS.floating)}; }
</style>
</head>
<body>
  ${minWidth ? `<div class="min-width" style="min-width: ${minWidth}px; height: 1px"></div>` : ''}
  <div id="thread">
    <header></header>
    <div class="earlier"></div>
    <div class="user"${userRole ? ' data-message-author-role="user"' : ''}>${escape(prompt)}</div>
    <div class="answer">${answer}</div>
    <div class="spacer"></div>
  </div>
  <form${fade ? ' class="fade"' : ''} data-type="unified-composer" data-chatgpt-composer data-composer-placement="thread">
    ${notice ? '<div class="notice"><span>You\'ve used 90% of your session limit</span></div>' : ''}
    <div data-composer-markdown contenteditable="true" role="textbox" class="ProseMirror" aria-label="Chat with ChatGPT"></div>
    <button type="submit" aria-label="Send">Send</button>
  </form>
  <button id="scroll-down" type="button" aria-label="Scroll to bottom"></button>
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
  floating: [255, 0, 255],
  notice: [0, 160, 0],
  headerHeight: 48,
  composerHeight: 80,
  blockHeight: 300,
  floatingSize: 36,
  noticeHeight: 40,
  heading: [255, 128, 0],
  headingHeight: 40,
  tableHeader: [0, 80, 160],
  tableHeaderHeight: 36,
  tableRow: [90, 0, 140],
  tableRowHeight: 48,
  tableRows: 4,
  fade: [255, 255, 0],
  // Taller than the part of the conversation left out of each stitched screen.
  fadeHeight: '35vh',
});
