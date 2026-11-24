/**
 * Attachment validation, MIME normalization, HTML `accept` matching,
 * formatting helpers, and Open Mode handoff guards for Panelize.
 *
 * Supports mixed image + document uploads with zero runtime dependencies.
 */

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB per image
export const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024; // 10 MB per document
export const MAX_TOTAL_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB combined
export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_DOCUMENT_COUNT = 5;
export const MAX_API_INLINE_TEXT_SIZE = 200 * 1024; // 200 KB per plain-text file
export const MAX_OPEN_MODE_HANDOFF_BYTES = 4 * 1024 * 1024; // 4 MB safe storage.session budget

const IMAGE_MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
});

const BLOCKED_IMAGE_MIMES = new Set(['image/svg+xml']);
const BLOCKED_EXTENSIONS = new Set([
  '.svg',
  '.html',
  '.htm',
  '.xhtml',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.exe',
  '.dmg',
  '.app',
  '.sh',
  '.bat',
  '.cmd',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.doc',
  '.xls',
  '.ppt'
]);

export const DOCUMENT_TYPE_REGISTRY = Object.freeze({
  '.pdf': Object.freeze({
    ext: '.pdf',
    mimeType: 'application/pdf',
    allowedMimes: Object.freeze(['application/pdf', '', 'application/octet-stream']),
    isPlainText: false,
    badge: 'PDF',
    badgeTone: 'pdf',
    magicBytes: Object.freeze([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
  }),
  '.docx': Object.freeze({
    ext: '.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    allowedMimes: Object.freeze([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '',
      'application/octet-stream',
      'application/zip',
      'application/x-zip-compressed'
    ]),
    isPlainText: false,
    badge: 'DOCX',
    badgeTone: 'docx',
    magicBytes: Object.freeze([0x50, 0x4b, 0x03, 0x04]) // PK\x03\x04
  }),
  '.txt': Object.freeze({
    ext: '.txt',
    mimeType: 'text/plain',
    allowedMimes: Object.freeze(['text/plain', '']),
    isPlainText: true,
    badge: 'TXT',
    badgeTone: 'text',
    magicBytes: null
  }),
  '.md': Object.freeze({
    ext: '.md',
    mimeType: 'text/markdown',
    allowedMimes: Object.freeze(['text/markdown', 'text/x-markdown', 'text/plain', '']),
    isPlainText: true,
    badge: 'MD',
    badgeTone: 'text',
    magicBytes: null
  }),
  '.markdown': Object.freeze({
    ext: '.markdown',
    mimeType: 'text/markdown',
    allowedMimes: Object.freeze(['text/markdown', 'text/x-markdown', 'text/plain', '']),
    isPlainText: true,
    badge: 'MD',
    badgeTone: 'text',
    magicBytes: null
  }),
  '.csv': Object.freeze({
    ext: '.csv',
    mimeType: 'text/csv',
    allowedMimes: Object.freeze([
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'text/plain',
      ''
    ]),
    isPlainText: true,
    badge: 'CSV',
    badgeTone: 'csv',
    magicBytes: null
  }),
  '.json': Object.freeze({
    ext: '.json',
    mimeType: 'application/json',
    allowedMimes: Object.freeze(['application/json', 'text/json', 'text/plain', '']),
    isPlainText: true,
    badge: 'JSON',
    badgeTone: 'text',
    magicBytes: null
  }),
  '.yaml': Object.freeze({
    ext: '.yaml',
    mimeType: 'text/yaml',
    allowedMimes: Object.freeze([
      'text/yaml',
      'application/yaml',
      'application/x-yaml',
      'text/x-yaml',
      'text/plain',
      ''
    ]),
    isPlainText: true,
    badge: 'YAML',
    badgeTone: 'text',
    magicBytes: null
  }),
  '.yml': Object.freeze({
    ext: '.yml',
    mimeType: 'text/yaml',
    allowedMimes: Object.freeze([
      'text/yaml',
      'application/yaml',
      'application/x-yaml',
      'text/x-yaml',
      'text/plain',
      ''
    ]),
    isPlainText: true,
    badge: 'YAML',
    badgeTone: 'text',
    magicBytes: null
  }),
  '.xml': Object.freeze({
    ext: '.xml',
    mimeType: 'application/xml',
    allowedMimes: Object.freeze(['application/xml', 'text/xml', 'text/plain', '']),
    isPlainText: true,
    badge: 'XML',
    badgeTone: 'text',
    magicBytes: null
  }),
  '.tsv': Object.freeze({
    ext: '.tsv',
    mimeType: 'text/tab-separated-values',
    allowedMimes: Object.freeze(['text/tab-separated-values', 'text/plain', '']),
    isPlainText: true,
    badge: 'TSV',
    badgeTone: 'csv',
    magicBytes: null
  }),
  '.log': Object.freeze({
    ext: '.log',
    mimeType: 'text/plain',
    allowedMimes: Object.freeze(['text/plain', '']),
    isPlainText: true,
    badge: 'LOG',
    badgeTone: 'text',
    magicBytes: null
  })
});

export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.freeze(Object.keys(DOCUMENT_TYPE_REGISTRY));
export const SUPPORTED_PLAIN_TEXT_EXTENSIONS = Object.freeze(
  SUPPORTED_DOCUMENT_EXTENSIONS.filter(ext => DOCUMENT_TYPE_REGISTRY[ext].isPlainText)
);

export const UNIFIED_FILE_INPUT_ACCEPT = [
  'image/*',
  ...SUPPORTED_DOCUMENT_EXTENSIONS
].join(',');

export const API_PANEL_FILE_INPUT_ACCEPT = [
  'image/*',
  ...SUPPORTED_PLAIN_TEXT_EXTENSIONS
].join(',');

/**
 * Strips MIME parameters (e.g. "; charset=utf-8") and normalizes case.
 *
 * @param {string} mimeType
 * @returns {string}
 */
export function normalizeMimeType(mimeType) {
  if (typeof mimeType !== 'string') {
    return '';
  }
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Extracts lowercase extension with leading dot (e.g. ".pdf"), or "" if none.
 *
 * @param {string} filename
 * @returns {string}
 */
export function getFileExtension(filename) {
  if (typeof filename !== 'string') {
    return '';
  }
  const trimmed = filename.trim();
  const baseName = trimmed.split(/[/\\]/).pop() || '';
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) {
    return '';
  }
  return baseName.slice(dotIndex).toLowerCase();
}

function resolveAttachmentExtension(item) {
  if (typeof item?.ext === 'string' && /^\.[a-z0-9]+$/i.test(item.ext.trim())) {
    return item.ext.trim().toLowerCase();
  }
  return getFileExtension(item?.name || '');
}

/**
 * Normalizes an attachment's kind ('image' or 'document').
 *
 * @param {object} item
 * @returns {'image' | 'document'}
 */
export function normalizeAttachmentKind(item) {
  if (!item || typeof item !== 'object') {
    return 'document';
  }
  if (item.kind === 'image' || item.kind === 'document') {
    return item.kind;
  }
  const mime = normalizeMimeType(item.type || item.mimeType || '');
  if (mime.startsWith('image/') && !BLOCKED_IMAGE_MIMES.has(mime)) {
    return 'image';
  }
  if (typeof item.dataUrl === 'string' && /^data:image\/(?!svg\+xml)/i.test(item.dataUrl)) {
    return 'image';
  }
  const ext = getFileExtension(item.name || '');
  if (ext && Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXTENSION, ext)) {
    return 'image';
  }
  return 'document';
}

export function isImageAttachment(item) {
  return normalizeAttachmentKind(item) === 'image';
}

export function isDocumentAttachment(item) {
  return normalizeAttachmentKind(item) === 'document';
}

/**
 * Checks whether an attachment is a supported UTF-8 plain-text document.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isPlainTextDocument(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }
  if (isImageAttachment(item)) {
    return false;
  }
  if (item.isPlainText === true) {
    return true;
  }
  if (item.isPlainText === false) {
    return false;
  }
  const ext = resolveAttachmentExtension(item);
  if (ext && Object.prototype.hasOwnProperty.call(DOCUMENT_TYPE_REGISTRY, ext)) {
    return DOCUMENT_TYPE_REGISTRY[ext].isPlainText;
  }
  const mime = normalizeMimeType(item.type || item.mimeType || '');
  return (
    mime === 'text/plain' ||
    mime === 'text/markdown' ||
    mime === 'text/x-markdown' ||
    mime === 'text/csv' ||
    mime === 'application/csv' ||
    mime === 'application/json' ||
    mime === 'text/yaml' ||
    mime === 'application/yaml' ||
    mime === 'application/xml' ||
    mime === 'text/xml' ||
    mime === 'text/tab-separated-values'
  );
}

/**
 * Synchronously classifies a File/file-like candidate by extension and MIME.
 *
 * @param {{ name?: string, type?: string, size?: number }} file
 * @returns {object}
 */
export function classifyAttachmentCandidate(file) {
  if (!file || typeof file !== 'object') {
    return { ok: false, errorCode: 'unsupported-type' };
  }

  const name = typeof file.name === 'string' ? file.name : '';
  const ext = getFileExtension(name);
  const rawMime = normalizeMimeType(file.type || '');

  if (BLOCKED_EXTENSIONS.has(ext) || BLOCKED_IMAGE_MIMES.has(rawMime)) {
    return { ok: false, errorCode: 'unsupported-type', ext, mimeType: rawMime };
  }

  // Supported document by extension
  if (ext && Object.prototype.hasOwnProperty.call(DOCUMENT_TYPE_REGISTRY, ext)) {
    const spec = DOCUMENT_TYPE_REGISTRY[ext];
    if (!spec.allowedMimes.includes(rawMime)) {
      return { ok: false, errorCode: 'unsupported-type', ext, mimeType: rawMime };
    }
    return {
      ok: true,
      kind: 'document',
      ext: spec.ext,
      mimeType: spec.mimeType,
      isPlainText: spec.isPlainText,
      badge: spec.badge,
      badgeTone: spec.badgeTone,
      magicBytes: spec.magicBytes
    };
  }

  // Supported image by MIME or extension (with empty/octet-stream MIME fallback)
  if (rawMime.startsWith('image/')) {
    return {
      ok: true,
      kind: 'image',
      ext: ext || '',
      mimeType: rawMime,
      isPlainText: false,
      badge: 'IMG',
      badgeTone: 'image',
      magicBytes: null
    };
  }

  if (
    ext &&
    Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXTENSION, ext) &&
    (rawMime === '' || rawMime === 'application/octet-stream')
  ) {
    return {
      ok: true,
      kind: 'image',
      ext,
      mimeType: IMAGE_MIME_BY_EXTENSION[ext],
      isPlainText: false,
      badge: 'IMG',
      badgeTone: 'image',
      magicBytes: null
    };
  }

  // Clipboard/nameless document with explicit canonical MIME (e.g. text/plain, application/pdf)
  if (!ext && rawMime) {
    if (rawMime === 'application/pdf') {
      const spec = DOCUMENT_TYPE_REGISTRY['.pdf'];
      return {
        ok: true,
        kind: 'document',
        ext: spec.ext,
        mimeType: spec.mimeType,
        isPlainText: false,
        badge: spec.badge,
        badgeTone: spec.badgeTone,
        magicBytes: spec.magicBytes
      };
    }
    if (rawMime === DOCUMENT_TYPE_REGISTRY['.docx'].mimeType) {
      const spec = DOCUMENT_TYPE_REGISTRY['.docx'];
      return {
        ok: true,
        kind: 'document',
        ext: spec.ext,
        mimeType: spec.mimeType,
        isPlainText: false,
        badge: spec.badge,
        badgeTone: spec.badgeTone,
        magicBytes: spec.magicBytes
      };
    }
  }

  return { ok: false, errorCode: 'unsupported-type', ext, mimeType: rawMime };
}

/**
 * Validates raw document bytes with magic-byte or UTF-8 non-binary probing.
 *
 * @param {ArrayBuffer | Uint8Array} inputBytes
 * @param {object} classification - Output from classifyAttachmentCandidate.
 * @returns {{ ok: boolean, errorCode?: string, textContent?: string }}
 */
export function validateAttachmentBytes(inputBytes, classification) {
  if (!classification || !classification.ok) {
    return { ok: false, errorCode: 'unsupported-type' };
  }
  if (classification.kind === 'image') {
    return { ok: true };
  }

  const view = inputBytes instanceof Uint8Array
    ? inputBytes
    : inputBytes instanceof ArrayBuffer
      ? new Uint8Array(inputBytes)
      : ArrayBuffer.isView(inputBytes)
        ? new Uint8Array(inputBytes.buffer, inputBytes.byteOffset, inputBytes.byteLength)
        : null;

  if (!view) {
    return { ok: false, errorCode: 'invalid-file-content' };
  }

  if (Array.isArray(classification.magicBytes) || Object.isFrozen(classification.magicBytes)) {
    const magic = classification.magicBytes;
    if (magic && magic.length > 0) {
      if (view.byteLength < magic.length) {
        return { ok: false, errorCode: 'invalid-file-content' };
      }
      for (let i = 0; i < magic.length; i += 1) {
        if (view[i] !== magic[i]) {
          return { ok: false, errorCode: 'invalid-file-content' };
        }
      }
      return { ok: true };
    }
  }

  if (classification.isPlainText) {
    // Reject binary files masquerading as text (NUL byte probe in first 8 KB and full scan up to 64 KB)
    const probeLen = Math.min(view.byteLength, 65536);
    for (let i = 0; i < probeLen; i += 1) {
      if (view[i] === 0x00) {
        return { ok: false, errorCode: 'invalid-file-content' };
      }
    }
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const textContent = decoder.decode(view);
      return { ok: true, textContent };
    } catch {
      return { ok: false, errorCode: 'invalid-file-content' };
    }
  }

  return { ok: true };
}

/**
 * Estimates byte size of an attachment item (from size, ArrayBuffer, or dataUrl).
 *
 * @param {object} item
 * @returns {number}
 */
export function estimateAttachmentBytes(item) {
  if (!item || typeof item !== 'object') {
    return 0;
  }
  if (typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0) {
    return item.size;
  }
  if (item.bytes instanceof ArrayBuffer) {
    return item.bytes.byteLength;
  }
  if (ArrayBuffer.isView(item.bytes)) {
    return item.bytes.byteLength;
  }
  if (typeof item.dataUrl === 'string') {
    const commaIdx = item.dataUrl.indexOf(',');
    if (commaIdx !== -1) {
      const base64Len = item.dataUrl.length - commaIdx - 1;
      return Math.floor((base64Len * 3) / 4);
    }
    return item.dataUrl.length;
  }
  if (typeof item.textContent === 'string') {
    return new TextEncoder().encode(item.textContent).byteLength;
  }
  return 0;
}

async function readFileAsArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') {
    return await file.arrayBuffer();
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Full async validation of a candidate File against format, count, size, and content guardrails.
 *
 * @param {File} file
 * @param {Array<object>} [existingAttachments=[]]
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
export async function validateAttachmentFile(file, existingAttachments = [], options = {}) {
  const maxImageSize = options.maxImageSize ?? MAX_IMAGE_SIZE;
  const maxDocumentSize = options.maxDocumentSize ?? MAX_DOCUMENT_SIZE;
  const maxTotalSize = options.maxTotalSize ?? MAX_TOTAL_ATTACHMENT_SIZE;
  const maxCount = options.maxCount ?? MAX_ATTACHMENT_COUNT;
  const maxDocumentCount = options.maxDocumentCount ?? MAX_DOCUMENT_COUNT;

  const classification = classifyAttachmentCandidate(file);
  if (!classification.ok) {
    return classification;
  }

  const existing = Array.isArray(existingAttachments) ? existingAttachments : [];
  if (existing.length >= maxCount) {
    return { ok: false, errorCode: 'max-count', maxCount };
  }

  if (classification.kind === 'document') {
    const currentDocumentCount = existing.filter(isDocumentAttachment).length;
    if (currentDocumentCount >= maxDocumentCount) {
      return { ok: false, errorCode: 'max-document-count', maxDocumentCount };
    }
  }

  const size = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0;
  if (classification.kind === 'image' && size > maxImageSize) {
    return { ok: false, errorCode: 'image-too-large', maxSize: maxImageSize, size };
  }
  if (classification.kind === 'document' && size > maxDocumentSize) {
    return { ok: false, errorCode: 'document-too-large', maxSize: maxDocumentSize, size };
  }

  const existingBytes = existing.reduce((sum, item) => sum + estimateAttachmentBytes(item), 0);
  if (existingBytes + size > maxTotalSize) {
    return {
      ok: false,
      errorCode: 'total-size-exceeded',
      maxTotalSize,
      totalSize: existingBytes + size
    };
  }

  if (classification.kind === 'document') {
    const bytes = await readFileAsArrayBuffer(file);
    const contentCheck = validateAttachmentBytes(bytes, classification);
    if (!contentCheck.ok) {
      return {
        ok: false,
        errorCode: contentCheck.errorCode || 'invalid-file-content',
        ext: classification.ext,
        mimeType: classification.mimeType
      };
    }

    return {
      ok: true,
      kind: 'document',
      ext: classification.ext,
      mimeType: classification.mimeType,
      isPlainText: classification.isPlainText,
      badge: classification.badge,
      badgeTone: classification.badgeTone,
      size: bytes.byteLength,
      bytes,
      ...(typeof contentCheck.textContent === 'string'
        ? { textContent: contentCheck.textContent }
        : {})
    };
  }

  return {
    ok: true,
    kind: 'image',
    ext: classification.ext,
    mimeType: classification.mimeType,
    isPlainText: false,
    badge: classification.badge,
    badgeTone: classification.badgeTone,
    size
  };
}

/**
 * Formats byte count into a human-readable compact string (e.g. "18 KB", "2.4 MB").
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  const kb = value / 1024;
  if (kb < 1024) {
    return kb < 10 ? `${kb.toFixed(1).replace(/\.0$/, '')} KB` : `${Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1).replace(/\.0$/, '')} MB`;
}

/**
 * Returns badge label and tone for a document attachment.
 *
 * @param {object} attachment
 * @returns {{ label: string, tone: 'pdf' | 'docx' | 'csv' | 'text' }}
 */
export function getAttachmentBadge(attachment) {
  if (attachment?.badge && attachment?.badgeTone) {
    return { label: attachment.badge, tone: attachment.badgeTone };
  }
  const ext = resolveAttachmentExtension(attachment);
  if (ext && Object.prototype.hasOwnProperty.call(DOCUMENT_TYPE_REGISTRY, ext)) {
    const spec = DOCUMENT_TYPE_REGISTRY[ext];
    return { label: spec.badge, tone: spec.badgeTone };
  }
  const mime = normalizeMimeType(attachment?.type || attachment?.mimeType || '');
  if (mime === 'application/pdf') {
    return { label: 'PDF', tone: 'pdf' };
  }
  if (mime === DOCUMENT_TYPE_REGISTRY['.docx'].mimeType) {
    return { label: 'DOCX', tone: 'docx' };
  }
  if (mime === 'text/csv' || mime === 'application/csv') {
    return { label: 'CSV', tone: 'csv' };
  }
  return { label: 'DOC', tone: 'text' };
}

/**
 * Standard HTML `<input type="file" accept="...">` matching algorithm.
 *
 * Accepts either a DOM input element (reading its `accept` attribute/property)
 * or a raw accept string, plus a File or attachment metadata object.
 *
 * @param {HTMLInputElement | string | null | undefined} inputOrAccept
 * @param {{ name?: string, type?: string, mimeType?: string, ext?: string }} fileOrMeta
 * @returns {boolean}
 */
export function matchesInputAccept(inputOrAccept, fileOrMeta) {
  if (!inputOrAccept || !fileOrMeta) {
    return false;
  }

  let acceptAttr = '';
  if (typeof inputOrAccept === 'string') {
    acceptAttr = inputOrAccept;
  } else if (typeof inputOrAccept === 'object') {
    if (typeof inputOrAccept.getAttribute === 'function') {
      acceptAttr = inputOrAccept.getAttribute('accept') ?? inputOrAccept.accept ?? '';
    } else {
      acceptAttr = inputOrAccept.accept ?? '';
    }
  }

  const trimmedAccept = String(acceptAttr || '').trim();
  if (!trimmedAccept) {
    return true;
  }

  const fileName = typeof fileOrMeta.name === 'string' ? fileOrMeta.name : '';
  const fileExt = (
    typeof fileOrMeta.ext === 'string' && fileOrMeta.ext.startsWith('.')
      ? fileOrMeta.ext.toLowerCase()
      : getFileExtension(fileName)
  );

  let fileMime = normalizeMimeType(fileOrMeta.type || fileOrMeta.mimeType || '');
  if (!fileMime && fileExt) {
    if (Object.prototype.hasOwnProperty.call(DOCUMENT_TYPE_REGISTRY, fileExt)) {
      fileMime = DOCUMENT_TYPE_REGISTRY[fileExt].mimeType;
    } else if (Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXTENSION, fileExt)) {
      fileMime = IMAGE_MIME_BY_EXTENSION[fileExt];
    }
  }

  const tokens = trimmedAccept
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
      // Also match when a file has canonical MIME matching the extension token
      if (!fileExt && fileMime) {
        const docSpec = DOCUMENT_TYPE_REGISTRY[token];
        if (docSpec && docSpec.mimeType === fileMime) {
          return true;
        }
        const imgMime = IMAGE_MIME_BY_EXTENSION[token];
        if (imgMime && imgMime === fileMime) {
          return true;
        }
      }
      continue;
    }
    if (token.endsWith('/*')) {
      const prefix = token.slice(0, -1); // e.g. "image/" or "text/"
      if (fileMime && fileMime.startsWith(prefix)) {
        return true;
      }
      continue;
    }
    const normalizedToken = normalizeMimeType(token);
    if (normalizedToken && fileMime && fileMime === normalizedToken) {
      return true;
    }
  }

  return false;
}

/**
 * Formats a plain-text document into a structured fenced context block for Custom API prompts.
 *
 * @param {{ name?: string, ext?: string, type?: string }} attachment
 * @param {string} textContent
 * @param {number} [maxBytes=MAX_API_INLINE_TEXT_SIZE]
 * @returns {{ text: string, truncated: boolean }}
 */
export function formatInlineTextDocumentBlock(attachment, textContent, maxBytes = MAX_API_INLINE_TEXT_SIZE) {
  const safeName = typeof attachment?.name === 'string' && attachment.name.trim()
    ? attachment.name.trim()
    : 'document.txt';
  const raw = typeof textContent === 'string' ? textContent : '';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(raw);
  let body = raw;
  let truncated = false;

  if (encoded.byteLength > maxBytes) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    body = decoder.decode(encoded.subarray(0, maxBytes));
    truncated = true;
  }

  // Choose a fence longer than any backtick run in body so markdown/code blocks never break out.
  let fence = '```';
  const matches = body.match(/`{3,}/g);
  if (matches) {
    const maxRun = Math.max(...matches.map(run => run.length));
    fence = '`'.repeat(maxRun + 1);
  }

  const ext = resolveAttachmentExtension({ ext: attachment?.ext, name: safeName }).replace(/^\./, '');
  const langTag = /^[a-z0-9_-]{1,12}$/i.test(ext) ? ext : 'text';
  const header = `[Attached file: ${safeName}${truncated ? ' (truncated to 200 KB)' : ''}]`;
  return {
    text: `${header}\n${fence}${langTag}\n${body}\n${fence}`,
    truncated
  };
}

/**
 * Filters and serializes attachments safely for chrome.storage.session handoff during Open Mode switch.
 * Never attempts to JSON-serialize raw ArrayBuffers and enforces a strict byte cap so session storage
 * never hits the MV3 10 MB quota error.
 *
 * @param {Array<object>} attachments
 * @param {number} [maxTotalBytes=MAX_OPEN_MODE_HANDOFF_BYTES]
 * @returns {{ preservedImages: Array<object>, preservedAttachments: Array<object>, omittedCount: number, omittedNames: Array<string> }}
 */
export function prepareAttachmentsForOpenModeHandoff(attachments = [], maxTotalBytes = MAX_OPEN_MODE_HANDOFF_BYTES) {
  const list = Array.isArray(attachments) ? attachments : [];
  const preservedImages = [];
  const preservedAttachments = [];
  const omittedNames = [];
  let accumulatedBytes = 0;

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const kind = normalizeAttachmentKind(item);

    if (kind === 'image' && typeof item.dataUrl === 'string' && item.dataUrl.length > 0) {
      // Base64 strings occupy roughly dataUrl.length bytes in JSON storage
      const serializedBytes = item.dataUrl.length;
      if (accumulatedBytes + serializedBytes <= maxTotalBytes) {
        const cleanImage = {
          id: item.id,
          kind: 'image',
          name: item.name,
          type: item.type,
          ext: item.ext || getFileExtension(item.name || ''),
          size: estimateAttachmentBytes(item),
          dataUrl: item.dataUrl
        };
        preservedImages.push(cleanImage);
        preservedAttachments.push(cleanImage);
        accumulatedBytes += serializedBytes;
      } else {
        omittedNames.push(item.name || 'image');
      }
      continue;
    }

    // Preserve lightweight plain-text documents (which have UTF-8 textContent and no binary bloat)
    if (
      kind === 'document' &&
      isPlainTextDocument(item) &&
      typeof item.textContent === 'string'
    ) {
      const textBytes = new TextEncoder().encode(item.textContent).byteLength;
      if (textBytes <= MAX_API_INLINE_TEXT_SIZE && accumulatedBytes + textBytes <= maxTotalBytes) {
        const badge = getAttachmentBadge(item);
        preservedAttachments.push({
          id: item.id,
          kind: 'document',
          name: item.name,
          type: item.type,
          ext: item.ext || getFileExtension(item.name || ''),
          size: textBytes,
          isPlainText: true,
          badge: badge.label,
          badgeTone: badge.tone,
          textContent: item.textContent
        });
        accumulatedBytes += textBytes;
        continue;
      }
    }

    // Binary documents (PDF/DOCX) or oversized attachments are not placed into storage.session
    omittedNames.push(item.name || 'document');
  }

  return {
    preservedImages,
    preservedAttachments,
    omittedCount: omittedNames.length,
    omittedNames
  };
}
