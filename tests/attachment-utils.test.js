import { describe, expect, it } from 'vitest';
import {
  API_PANEL_FILE_INPUT_ACCEPT,
  MAX_API_INLINE_TEXT_SIZE,
  MAX_ATTACHMENT_COUNT,
  MAX_DOCUMENT_COUNT,
  MAX_DOCUMENT_SIZE,
  MAX_IMAGE_SIZE,
  MAX_TOTAL_ATTACHMENT_SIZE,
  UNIFIED_FILE_INPUT_ACCEPT,
  classifyAttachmentCandidate,
  formatFileSize,
  formatInlineTextDocumentBlock,
  getAttachmentBadge,
  getFileExtension,
  isDocumentAttachment,
  isImageAttachment,
  isPlainTextDocument,
  matchesInputAccept,
  prepareAttachmentsForOpenModeHandoff,
  validateAttachmentBytes,
  validateAttachmentFile
} from '../modules/attachment-utils.js';

function makeFile(name, type, bytesOrString) {
  const part = typeof bytesOrString === 'string'
    ? new TextEncoder().encode(bytesOrString)
    : bytesOrString;
  const blob = new Blob([part], { type });
  return new File([blob], name, { type });
}

function makeFakeSizedFile(name, type, size, bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])) {
  return {
    name,
    type,
    size,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

describe('attachment-utils classification and validation', () => {
  it('extracts lowercase file extensions cleanly', () => {
    expect(getFileExtension('report.PDF')).toBe('.pdf');
    expect(getFileExtension('my.archive.docx')).toBe('.docx');
    expect(getFileExtension('noext')).toBe('');
    expect(getFileExtension('.hidden')).toBe('');
    expect(getFileExtension('folder/sub/notes.md')).toBe('.md');
  });

  it('classifies images and supported documents including empty MIME fallbacks', () => {
    expect(classifyAttachmentCandidate({ name: 'photo.png', type: 'image/png' })).toMatchObject({
      ok: true,
      kind: 'image',
      mimeType: 'image/png'
    });
    expect(classifyAttachmentCandidate({ name: 'notes.md', type: '' })).toMatchObject({
      ok: true,
      kind: 'document',
      ext: '.md',
      mimeType: 'text/markdown',
      isPlainText: true,
      badge: 'MD'
    });
    expect(classifyAttachmentCandidate({ name: 'data.csv', type: 'application/vnd.ms-excel' })).toMatchObject({
      ok: true,
      kind: 'document',
      ext: '.csv',
      mimeType: 'text/csv',
      isPlainText: true,
      badge: 'CSV',
      badgeTone: 'csv'
    });
    expect(classifyAttachmentCandidate({ name: 'paper.pdf', type: 'application/octet-stream' })).toMatchObject({
      ok: true,
      kind: 'document',
      ext: '.pdf',
      mimeType: 'application/pdf',
      isPlainText: false,
      badge: 'PDF',
      badgeTone: 'pdf'
    });
    expect(classifyAttachmentCandidate({ name: 'spec.docx', type: 'application/zip' })).toMatchObject({
      ok: true,
      kind: 'document',
      ext: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      isPlainText: false,
      badge: 'DOCX',
      badgeTone: 'docx'
    });
  });

  it('rejects unsafe and unsupported file types (.svg, .html, .js, .zip, .doc)', () => {
    for (const candidate of [
      { name: 'vector.svg', type: 'image/svg+xml' },
      { name: 'page.html', type: 'text/html' },
      { name: 'script.js', type: 'application/javascript' },
      { name: 'archive.zip', type: 'application/zip' },
      { name: 'legacy.doc', type: 'application/msword' },
      { name: 'binary.exe', type: 'application/octet-stream' }
    ]) {
      expect(classifyAttachmentCandidate(candidate).ok, candidate.name).toBe(false);
    }
  });

  it('verifies PDF and DOCX magic bytes and rejects spoofed files', async () => {
    const validPdf = makeFile('paper.pdf', 'application/pdf', '%PDF-1.7\n1 0 obj\nendobj');
    const validPdfResult = await validateAttachmentFile(validPdf);
    expect(validPdfResult.ok).toBe(true);
    expect(validPdfResult.mimeType).toBe('application/pdf');
    expect(validPdfResult.bytes).toBeInstanceOf(ArrayBuffer);

    const fakePdf = makeFile('fake.pdf', 'application/pdf', '<html>not a pdf</html>');
    const fakePdfResult = await validateAttachmentFile(fakePdf);
    expect(fakePdfResult).toMatchObject({ ok: false, errorCode: 'invalid-file-content' });

    const validDocx = makeFile('spec.docx', '', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    const validDocxResult = await validateAttachmentFile(validDocx);
    expect(validDocxResult.ok).toBe(true);
    expect(validDocxResult.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    const fakeDocx = makeFile('fake.docx', '', 'plain text pretending to be docx');
    const fakeDocxResult = await validateAttachmentFile(fakeDocx);
    expect(fakeDocxResult).toMatchObject({ ok: false, errorCode: 'invalid-file-content' });
  });

  it('validates UTF-8 plain text files and rejects binary NUL payloads disguised as .txt', async () => {
    const validTxt = makeFile('readme.txt', '', 'Hello Panelize\nLine 2');
    const validTxtResult = await validateAttachmentFile(validTxt);
    expect(validTxtResult).toMatchObject({
      ok: true,
      kind: 'document',
      mimeType: 'text/plain',
      isPlainText: true,
      textContent: 'Hello Panelize\nLine 2'
    });

    const binaryTxt = makeFile('binary.txt', 'text/plain', new Uint8Array([0x48, 0x69, 0x00, 0x01]));
    const binaryTxtResult = await validateAttachmentFile(binaryTxt);
    expect(binaryTxtResult).toMatchObject({ ok: false, errorCode: 'invalid-file-content' });

    expect(
      validateAttachmentBytes(new Uint8Array([0x25, 0x50, 0x44]), classifyAttachmentCandidate({ name: 'a.pdf', type: '' }))
    ).toMatchObject({ ok: false, errorCode: 'invalid-file-content' });
  });

  it('enforces per-file size, combined size, total count, and document count guardrails', async () => {
    const oversizedDoc = makeFakeSizedFile('huge.pdf', 'application/pdf', MAX_DOCUMENT_SIZE + 1);
    expect(await validateAttachmentFile(oversizedDoc)).toMatchObject({
      ok: false,
      errorCode: 'document-too-large'
    });

    const oversizedImg = makeFakeSizedFile('huge.png', 'image/png', MAX_IMAGE_SIZE + 1);
    expect(await validateAttachmentFile(oversizedImg)).toMatchObject({
      ok: false,
      errorCode: 'image-too-large'
    });

    const existingHeavy = [
      { id: '1', kind: 'image', size: 15 * 1024 * 1024 },
      { id: '2', kind: 'document', size: 8 * 1024 * 1024 }
    ];
    const pushesOverTotal = makeFakeSizedFile('extra.pdf', 'application/pdf', 3 * 1024 * 1024);
    expect(await validateAttachmentFile(pushesOverTotal, existingHeavy)).toMatchObject({
      ok: false,
      errorCode: 'total-size-exceeded',
      maxTotalSize: MAX_TOTAL_ATTACHMENT_SIZE
    });

    const fiveDocs = Array.from({ length: MAX_DOCUMENT_COUNT }, (_, idx) => ({
      id: `doc-${idx}`,
      kind: 'document',
      size: 100
    }));
    const sixthDoc = makeFile('sixth.txt', 'text/plain', 'hello');
    expect(await validateAttachmentFile(sixthDoc, fiveDocs)).toMatchObject({
      ok: false,
      errorCode: 'max-document-count'
    });

    // Adding an image when 5 documents are already attached is still allowed up to MAX_ATTACHMENT_COUNT
    const imgFile = makeFile('photo.png', 'image/png', new Uint8Array([1, 2, 3]));
    expect((await validateAttachmentFile(imgFile, fiveDocs)).ok).toBe(true);

    const tenItems = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, idx) => ({
      id: `img-${idx}`,
      kind: 'image',
      size: 100
    }));
    expect(await validateAttachmentFile(imgFile, tenItems)).toMatchObject({
      ok: false,
      errorCode: 'max-count'
    });
  });

  it('exposes expected accept strings and kind helpers', () => {
    expect(UNIFIED_FILE_INPUT_ACCEPT).toContain('image/*');
    expect(UNIFIED_FILE_INPUT_ACCEPT).toContain('.pdf');
    expect(UNIFIED_FILE_INPUT_ACCEPT).toContain('.docx');
    expect(UNIFIED_FILE_INPUT_ACCEPT).toContain('.txt');
    expect(API_PANEL_FILE_INPUT_ACCEPT).toContain('.txt');
    expect(API_PANEL_FILE_INPUT_ACCEPT).not.toContain('.pdf');

    expect(isImageAttachment({ kind: 'image' })).toBe(true);
    expect(isDocumentAttachment({ kind: 'document' })).toBe(true);
    expect(isPlainTextDocument({ kind: 'document', name: 'a.csv', type: 'text/csv' })).toBe(true);
    expect(isPlainTextDocument({ kind: 'document', name: 'a.pdf', type: 'application/pdf' })).toBe(false);
    expect(getAttachmentBadge({ name: 'report.pdf' })).toEqual({ label: 'PDF', tone: 'pdf' });
  });
});

describe('matchesInputAccept', () => {
  it('matches empty accept and wildcard accept against any file', () => {
    expect(matchesInputAccept({ accept: '' }, { name: 'report.pdf', type: 'application/pdf' })).toBe(true);
    expect(matchesInputAccept('*/*', { name: 'report.pdf', type: 'application/pdf' })).toBe(true);
  });

  it('rejects PDF on image-only inputs and accepts PDF on pdf/document inputs', () => {
    const imgInput = { getAttribute: () => 'image/*' };
    expect(matchesInputAccept(imgInput, { name: 'report.pdf', type: 'application/pdf' })).toBe(false);
    expect(matchesInputAccept(imgInput, { name: 'photo.png', type: 'image/png' })).toBe(true);

    const pdfInput = { getAttribute: () => '.pdf,application/pdf' };
    expect(matchesInputAccept(pdfInput, { name: 'report.pdf', type: 'application/pdf' })).toBe(true);
    expect(matchesInputAccept(pdfInput, { name: 'report.pdf', type: '' })).toBe(true);
    expect(matchesInputAccept(pdfInput, { name: 'photo.png', type: 'image/png' })).toBe(false);
  });

  it('matches MIME wildcards, exact MIMEs with charset params, and case-insensitive extensions', () => {
    expect(matchesInputAccept('text/*', { name: 'notes.md', type: 'text/markdown; charset=utf-8' })).toBe(true);
    expect(
      matchesInputAccept('.DOCX, .PDF', { name: 'spec.docx', type: 'application/octet-stream' })
    ).toBe(true);
    expect(
      matchesInputAccept('application/pdf', { name: 'unnamed', type: 'application/pdf' })
    ).toBe(true);
    expect(matchesInputAccept('image/png,image/jpeg', { name: 'anim.gif', type: 'image/gif' })).toBe(false);
  });
});

describe('formatting and Open Mode handoff helpers', () => {
  it('formats byte sizes cleanly', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(850)).toBe('850 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(18 * 1024)).toBe('18 KB');
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe('2.4 MB');
  });

  it('formats plain-text inline document blocks and avoids backtick fence collisions', () => {
    const formatted = formatInlineTextDocumentBlock(
      { name: 'notes.md', ext: '.md' },
      '```js\nconsole.log(1);\n```'
    );
    expect(formatted.truncated).toBe(false);
    expect(formatted.text).toContain('[Attached file: notes.md]');
    expect(formatted.text).toContain('````md\n');

    const longText = 'a'.repeat(MAX_API_INLINE_TEXT_SIZE + 500);
    const truncated = formatInlineTextDocumentBlock({ name: 'big.txt' }, longText);
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toContain('truncated to 200 KB');
  });

  it('omits binary PDFs and oversized attachments during Open Mode handoff while preserving lightweight items', () => {
    const result = prepareAttachmentsForOpenModeHandoff([
      {
        id: 'img-1',
        kind: 'image',
        name: 'small.png',
        type: 'image/png',
        size: 100,
        dataUrl: 'data:image/png;base64,AAAA'
      },
      {
        id: 'doc-txt',
        kind: 'document',
        name: 'notes.txt',
        type: 'text/plain',
        ext: '.txt',
        size: 12,
        isPlainText: true,
        textContent: 'hello world!'
      },
      {
        id: 'doc-pdf',
        kind: 'document',
        name: 'paper.pdf',
        type: 'application/pdf',
        ext: '.pdf',
        size: 5 * 1024 * 1024,
        bytes: new ArrayBuffer(10)
      }
    ]);

    expect(result.preservedImages).toHaveLength(1);
    expect(result.preservedAttachments).toHaveLength(2);
    expect(result.omittedCount).toBe(1);
    expect(result.omittedNames).toEqual(['paper.pdf']);
  });
});
