import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES_DIR = resolve(process.cwd(), '_locales');

// Strings added for the store rating prompt, the share snapshot and the
// panel resize handles.
const FEATURE_KEYS = [
  'ratingPromptMessage',
  'ratingPromptRate',
  'ratingPromptLater',
  'ratingPromptNever',
  'shareButtonText',
  'shareButtonTitle',
  'shareDialogTitle',
  'shareDialogClose',
  'sharePrivacyWarning',
  'shareCopyButton',
  'shareDownloadButton',
  'shareCopied',
  'shareCopyFailed',
  'shareCaptureCancelled',
  'shareCaptureWrongSurface',
  'shareCaptureFailed',
  'shareCaptureLayoutChanged',
  'shareModeLabel',
  'shareModeCurrent',
  'shareModeFull',
  'shareTitleLabel',
  'shareTitlePlaceholder',
  'shareSnapshotTagline',
  'shareSnapshotPromptLabel',
  'shareSnapshotCaption',
  'shareSnapshotSubline',
  'shareTruncatedNote',
  'shareCaptureTabHidden',
  'shareCurrentViewOnly',
  'shareOutOfViewNote',
  'shareShortcutHint',
  'shareToolbarHint',
  'shareProgressPreparing',
  'shareProgressStep',
  'shareProgressHoldPointer',
  'shareProgressCancel',
  'shareStreamStatus',
  'shareStreamStop',
  'labelShareWatermark',
  'descShareWatermark',
  'msgShareWatermarkEnabled',
  'msgShareWatermarkDisabled',
  'panelResizeHandle'
];

const locales = readdirSync(LOCALES_DIR);

describe('share and rating strings', () => {
  it('covers all ten shipped locales', () => {
    expect(locales.sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'ru', 'zh_CN', 'zh_TW']);
  });

  it.each(locales)('%s translates every new string', (locale) => {
    const messages = JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
    FEATURE_KEYS.forEach((key) => {
      expect(messages[key]?.message?.trim(), `${locale}.${key}`).toBeTruthy();
    });
  });

  it('keeps the brand and site name in the watermark strings', () => {
    locales.forEach((locale) => {
      const messages = JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
      expect(messages.descShareWatermark.message, locale).toContain('Panelize');
      expect(messages.descShareWatermark.message, locale).toContain('panelize.dev');
      expect(messages.shareToolbarHint.message, locale).toContain('Panelize');
    });
  });

  it('keeps every substitution in the snapshot strings', () => {
    const substitutions = {
      shareSnapshotSubline: ['$1'],
      shareTruncatedNote: ['$1'],
      shareCurrentViewOnly: ['$1'],
      shareOutOfViewNote: ['$1'],
      shareShortcutHint: ['$1'],
      shareProgressStep: ['$1', '$2']
    };
    locales.forEach((locale) => {
      const messages = JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
      Object.entries(substitutions).forEach(([key, values]) => {
        values.forEach((value) => expect(messages[key].message, `${locale}.${key}`).toContain(value));
      });
    });
  });
});
