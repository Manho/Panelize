import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES_DIR = resolve(process.cwd(), '_locales');

// Strings added for the store rating prompt and the share snapshot.
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
  'shareFooterText',
  'labelShareWatermark',
  'descShareWatermark',
  'msgShareWatermarkEnabled',
  'msgShareWatermarkDisabled'
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
      expect(messages.shareFooterText.message, locale).toContain('Panelize');
      expect(messages.descShareWatermark.message, locale).toContain('panelize.dev');
    });
  });
});
