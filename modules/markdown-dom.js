const SAFE_LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

/**
 * Validates and normalizes an external Markdown link href.
 * Allows only `https:`, `http:`, and `mailto:` schemes; rejects `javascript:`,
 * `data:`, `vbscript:`, `file:`, `chrome-extension:`, and relative/unparseable URLs.
 *
 * @param {string} rawHref
 * @returns {string | null}
 */
export function sanitizeMarkdownLinkHref(rawHref) {
  if (typeof rawHref !== 'string') {
    return null;
  }
  const trimmed = rawHref.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!SAFE_LINK_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

const INLINE_TOKEN_PATTERN =
  /(`[^`\n]+`)|(\[([^\]\n]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|((?<![A-Za-z0-9_])__([^_\n]+)__(?![A-Za-z0-9_]))|(\*([^*\n]+)\*)|((?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_]))|(~~([^~\n]+)~~)/;

function appendInlineNodes(doc, parent, text) {
  if (!text) {
    return;
  }

  let lastIndex = 0;
  const tokenRegex = new RegExp(INLINE_TOKEN_PATTERN.source, 'g');
  let match = tokenRegex.exec(text);

  while (match !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
    }

    if (match[1]) {
      const code = doc.createElement('code');
      code.className = 'md-inline-code';
      code.textContent = match[1].slice(1, -1);
      parent.appendChild(code);
    } else if (match[2]) {
      const label = match[3];
      const rawUrl = match[4];
      const safeHref = sanitizeMarkdownLinkHref(rawUrl);
      if (safeHref) {
        const anchor = doc.createElement('a');
        anchor.setAttribute('href', safeHref);
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
        appendInlineNodes(doc, anchor, label);
        parent.appendChild(anchor);
      } else {
        parent.appendChild(doc.createTextNode(match[0]));
      }
    } else if (match[5] || match[7]) {
      const strong = doc.createElement('strong');
      appendInlineNodes(doc, strong, match[6] ?? match[8]);
      parent.appendChild(strong);
    } else if (match[9] || match[11]) {
      const em = doc.createElement('em');
      appendInlineNodes(doc, em, match[10] ?? match[12]);
      parent.appendChild(em);
    } else if (match[13]) {
      const del = doc.createElement('del');
      appendInlineNodes(doc, del, match[14]);
      parent.appendChild(del);
    }

    lastIndex = match.index + match[0].length;
    match = tokenRegex.exec(text);
  }

  if (lastIndex < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(lastIndex)));
  }
}

function appendInlineWithLineBreaks(doc, parent, lines) {
  lines.forEach((line, idx) => {
    if (idx > 0) {
      parent.appendChild(doc.createElement('br'));
    }
    appendInlineNodes(doc, parent, line);
  });
}

function isTableSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) {
    return false;
  }
  const cells = splitTableRow(trimmed);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseTableAlignments(separatorLine) {
  return splitTableRow(separatorLine).map((raw) => {
    const cell = raw.trim();
    const startsColon = cell.startsWith(':');
    const endsColon = cell.endsWith(':');
    if (startsColon && endsColon) return 'center';
    if (endsColon) return 'right';
    if (startsColon) return 'left';
    return null;
  });
}

function buildCodeBlockElement(doc, language, codeLines, { onCopyCode = null } = {}) {
  const wrapper = doc.createElement('div');
  wrapper.className = 'md-code-block';

  const header = doc.createElement('div');
  header.className = 'md-code-header';

  const langSpan = doc.createElement('span');
  langSpan.className = 'md-code-lang';
  langSpan.textContent = language || 'code';
  header.appendChild(langSpan);

  const codeText = codeLines.join('\n');
  if (typeof onCopyCode === 'function') {
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'md-code-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      onCopyCode(codeText, copyBtn);
    });
    header.appendChild(copyBtn);
  }

  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  if (language) {
    code.dataset.language = language;
  }
  code.textContent = codeText;
  pre.appendChild(code);

  wrapper.append(header, pre);
  return wrapper;
}

/**
 * Renders Markdown text into a safe `DocumentFragment` using pure DOM creation
 * (`createElement` + `createTextNode`). Zero HTML-string sinks are ever used, so
 * raw HTML tags, inline event handlers, and unsafe link protocols are completely inert.
 *
 * @param {string} markdown
 * @param {{
 *   document?: Document,
 *   onCopyCode?: ((code: string, button: HTMLButtonElement) => void) | null
 * }} [options]
 * @returns {DocumentFragment}
 */
export function renderMarkdownToFragment(markdown, options = {}) {
  const doc = options?.document || globalThis.document;
  const fragment = doc.createDocumentFragment();
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return fragment;
  }

  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '') {
      index += 1;
      continue;
    }

    // Fenced code block (``` or ~~~)
    const fenceMatch = /^(`{3,}|~{3,})([^\s`~]*)\s*$/.exec(trimmed);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1];
      const fenceChar = fenceMarker[0];
      const fenceLen = fenceMarker.length;
      const language = fenceMatch[2] || '';
      const codeLines = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index].trim();
        if (
          candidate.startsWith(fenceChar.repeat(fenceLen)) &&
          new RegExp(`^\\${fenceChar}{${fenceLen},}\\s*$`).test(candidate)
        ) {
          index += 1;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }
      fragment.appendChild(buildCodeBlockElement(doc, language, codeLines, options));
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      fragment.appendChild(doc.createElement('hr'));
      index += 1;
      continue;
    }

    // ATX Heading (# .. ######)
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = doc.createElement(`h${level}`);
      appendInlineNodes(doc, heading, headingMatch[2]);
      fragment.appendChild(heading);
      index += 1;
      continue;
    }

    // GFM Table
    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1])
    ) {
      const headerCells = splitTableRow(line);
      const alignments = parseTableAlignments(lines[index + 1]);
      if (headerCells.length === alignments.length && headerCells.length >= 2) {
        const tableWrap = doc.createElement('div');
        tableWrap.className = 'md-table-wrap';
        const table = doc.createElement('table');
        const thead = doc.createElement('thead');
        const headRow = doc.createElement('tr');
        headerCells.forEach((cellText, colIdx) => {
          const th = doc.createElement('th');
          if (alignments[colIdx]) {
            th.style.textAlign = alignments[colIdx];
          }
          appendInlineNodes(doc, th, cellText);
          headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        index += 2;
        const tbody = doc.createElement('tbody');
        while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
          const rowCells = splitTableRow(lines[index]);
          const tr = doc.createElement('tr');
          for (let colIdx = 0; colIdx < headerCells.length; colIdx += 1) {
            const td = doc.createElement('td');
            if (alignments[colIdx]) {
              td.style.textAlign = alignments[colIdx];
            }
            appendInlineNodes(doc, td, rowCells[colIdx] ?? '');
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          index += 1;
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        fragment.appendChild(tableWrap);
        continue;
      }
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      const blockquote = doc.createElement('blockquote');
      blockquote.appendChild(
        renderMarkdownToFragment(quoteLines.join('\n'), { ...options, document: doc })
      );
      fragment.appendChild(blockquote);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = doc.createElement('ul');
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        const li = doc.createElement('li');
        appendInlineNodes(doc, li, lines[index].replace(/^\s*[-*+]\s+/, ''));
        ul.appendChild(li);
        index += 1;
      }
      fragment.appendChild(ul);
      continue;
    }

    // Ordered list
    const orderedMatch = /^\s*(\d+)\.\s+/.exec(line);
    if (orderedMatch) {
      const ol = doc.createElement('ol');
      const startNum = Number(orderedMatch[1]);
      if (Number.isInteger(startNum) && startNum !== 1) {
        ol.start = startNum;
      }
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        const li = doc.createElement('li');
        appendInlineNodes(doc, li, lines[index].replace(/^\s*\d+\.\s+/, ''));
        ol.appendChild(li);
        index += 1;
      }
      fragment.appendChild(ol);
      continue;
    }

    // Paragraph (collect consecutive non-block lines)
    const paragraphLines = [];
    while (index < lines.length) {
      const current = lines[index];
      const currentTrimmed = current.trim();
      if (
        currentTrimmed === '' ||
        /^(`{3,}|~{3,})/.test(currentTrimmed) ||
        /^(?:-{3,}|\*{3,}|_{3,})$/.test(currentTrimmed) ||
        /^#{1,6}\s+/.test(currentTrimmed) ||
        /^>\s?/.test(currentTrimmed) ||
        /^\s*[-*+]\s+/.test(current) ||
        /^\s*\d+\.\s+/.test(current) ||
        (current.includes('|') &&
          index + 1 < lines.length &&
          isTableSeparatorLine(lines[index + 1]))
      ) {
        break;
      }
      paragraphLines.push(current);
      index += 1;
    }

    if (paragraphLines.length > 0) {
      const p = doc.createElement('p');
      appendInlineWithLineBreaks(doc, p, paragraphLines);
      fragment.appendChild(p);
    } else {
      index += 1;
    }
  }

  return fragment;
}
