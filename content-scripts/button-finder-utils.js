/**
 * Button Finder Utility for Content Scripts
 * Provides multi-language, priority-based button finding with fallback strategies
 *
 * NOTE: This file must be loaded BEFORE any enter-behavior-*.js files in manifest.json
 * It exports functions to window.ButtonFinderUtils
 */

(function() {
  'use strict';

  // Create global namespace for button finder utilities
  window.ButtonFinderUtils = window.ButtonFinderUtils || {};

  /**
   * Multi-language text maps for button matching
   * Each array contains translations in priority order
   */
  const TEXT_MAPS = {
    // Send button texts across languages
    send: [
      'Send',           // English
      '发送',           // Chinese Simplified
      '送信',           // Japanese
      'Отправить',      // Russian
      'Enviar',         // Spanish
      'Envoyer',        // French
      'Senden',         // German
      'Invia',          // Italian
      '보내기'          // Korean
    ],

    // Submit button texts
    submit: [
      'Submit',         // English
      '提交',           // Chinese Simplified
      '送信',           // Japanese
      'Отправить',      // Russian
      'Enviar',         // Spanish
      'Soumettre',      // French
      'Senden',         // German
      'Invia',          // Italian
      '제출'            // Korean
    ],

    // Save button texts
    save: [
      'Save',           // English
      '保存',           // Chinese Simplified
      '保存',           // Chinese Traditional
      '保存',           // Japanese
      'Сохранить',      // Russian
      'Guardar',        // Spanish
      'Enregistrer',    // French
      'Speichern',      // German
      'Salva',          // Italian
      '저장'            // Korean
    ],

    // Update button texts
    update: [
      'Update',         // English
      '更新',           // Chinese Simplified
      '更新',           // Chinese Traditional & Japanese
      'Обновить',       // Russian
      'Actualizar',     // Spanish
      'Mettre à jour',  // French
      'Aktualisieren',  // German
      'Aggiorna',       // Italian
      '업데이트'         // Korean
    ],

    // Share button texts (for language detection)
    share: [
      'Share',          // English
      '分享',           // Chinese Simplified
      '分享',           // Chinese Traditional
      '共有',           // Japanese
      'Поделиться',     // Russian
      'Compartir',      // Spanish
      'Partager',       // French
      'Teilen',         // German
      'Condividi',      // Italian
      '공유'            // Korean
    ]
  };

  /**
   * Selector types for button finding strategies
   */
  const SELECTOR_TYPES = {
    CSS: 'css',           // Direct CSS selector
    TEXT: 'text',         // Text content matching (multi-language)
    ARIA: 'aria',         // ARIA label matching (multi-language)
    FUNCTION: 'function'  // Custom matcher function
  };

  /**
   * Find button using prioritized selector array
   * Tries each selector in order until a match is found
   *
   * @param {Array} selectors - Array of selector configurations
   * @returns {HTMLElement|null} Found button element or null
   *
   * @example
   * const button = window.ButtonFinderUtils.findButton([
   *   'button[data-testid="send"]',  // Try data-testid first
   *   { type: 'css', value: 'button[type="submit"]' },  // Then structural selector
   *   { type: 'aria', textKey: 'send' },  // Then multi-language ARIA
   *   { type: 'text', textKey: 'send' }   // Finally multi-language text
   * ]);
   */
  window.ButtonFinderUtils.findButton = function(selectors) {
    if (!Array.isArray(selectors)) {
      console.error('[Button Finder] selectors must be an array');
      return null;
    }

    for (let i = 0; i < selectors.length; i++) {
      const selector = selectors[i];
      try {
        const element = trySelector(selector);
        if (element) {
          // Log which selector succeeded (helpful for debugging)
          if (typeof selector === 'string') {
            console.debug(`[Button Finder] Found via selector[${i}]:`, selector);
          } else {
            console.debug(`[Button Finder] Found via selector[${i}]:`, selector.type);
          }
          return element;
        }
      } catch (error) {
        console.warn(`[Button Finder] Error trying selector[${i}]:`, error);
        continue;
      }
    }

    console.warn('[Button Finder] No button found after trying all selectors');
    return null;
  };

  /** Yuanbao uses the same control for Send and Stop Answering. */
  window.ButtonFinderUtils.isYuanbaoSendControl = function(button) {
    const label = button?.getAttribute('aria-label');
    const className = String(button?.className || '');
    return Boolean(
      (label === 'Send' || label === '发送' || label === '發送') &&
      button.getAttribute('aria-disabled') !== 'true' &&
      !/(disabled|sendNot|loading|sending|sendStop)/i.test(className) &&
      button.querySelector('svg')?.getAttribute('viewBox') === '0 0 48 48'
    );
  };

  const AI_STUDIO_SEND_BUTTON_SELECTORS = [
    'ms-prompt-box ms-run-button button',
    'ms-run-button button.run-button',
    'button[aria-label*="Run" i]',
    'button[mattooltip*="Send prompt" i]'
  ];

  /**
   * Google AI Studio (<ms-run-button>) reuses the same <button ms-button>
   * element for Run (idle), Stop (running/streaming), and Add (addInsteadOfRun).
   */
  window.ButtonFinderUtils.isAiStudioSendControl = function(button) {
    if (!button) {
      return false;
    }

    const disabledAttr = button.getAttribute?.('disabled');
    const className = String(button.className || '');
    if (
      button.disabled === true ||
      (disabledAttr !== null && disabledAttr !== undefined && disabledAttr !== 'false') ||
      button.getAttribute?.('aria-disabled') === 'true' ||
      button.classList?.contains?.('disabled') ||
      /\bdisabled\b/i.test(className)
    ) {
      return false;
    }

    if (button.querySelector?.('.spin')) {
      return false;
    }

    const ariaLabel = String(button.getAttribute?.('aria-label') || '').trim();
    const matTooltip = String(
      button.getAttribute?.('mattooltip') ||
      button.getAttribute?.('matTooltip') ||
      button.getAttribute?.('title') ||
      ''
    ).trim();
    if (
      /(cancel generation|\bstop\b)/i.test(ariaLabel) ||
      /(cancel generation|\bstop\b)/i.test(matTooltip)
    ) {
      return false;
    }

    const labelNode = button.querySelector?.('.run-button-label');
    const labelText = String(labelNode?.textContent ?? '').trim();
    const textContent = String(button.textContent ?? '').trim();

    if (/stop/i.test(labelText) || /stop/i.test(textContent)) {
      return false;
    }

    if (
      /^add$/i.test(labelText) ||
      /^add$/i.test(ariaLabel) ||
      /^add$/i.test(matTooltip) ||
      /^add(\s|$)/i.test(textContent)
    ) {
      return false;
    }

    return Boolean(
      button.closest?.('ms-run-button') ||
      button.classList?.contains?.('run-button') ||
      /\brun-button\b/.test(className) ||
      labelNode ||
      /\brun\b|send prompt/i.test(ariaLabel) ||
      /send prompt|\brun\b/i.test(matTooltip) ||
      /\brun\b/i.test(textContent)
    );
  };

  /**
   * Provider-aware send button finder.
   */
  window.ButtonFinderUtils.findSendButton = function(provider) {
    if (
      provider === 'aistudio' ||
      (!provider && typeof window !== 'undefined' && window.location?.hostname === 'aistudio.google.com')
    ) {
      for (const selector of AI_STUDIO_SEND_BUTTON_SELECTORS) {
        try {
          if (typeof document.querySelectorAll === 'function') {
            const buttons = document.querySelectorAll(selector);
            for (const button of buttons) {
              if (window.ButtonFinderUtils.isAiStudioSendControl(button)) {
                return button;
              }
            }
          }
          if (typeof document.querySelector === 'function') {
            const button = document.querySelector(selector);
            if (window.ButtonFinderUtils.isAiStudioSendControl(button)) {
              return button;
            }
          }
        } catch (error) {
          console.warn('[Button Finder] Error trying AI Studio selector:', selector, error);
        }
      }
      return null;
    }

    if (Array.isArray(provider)) {
      return window.ButtonFinderUtils.findButton(provider);
    }

    return null;
  };

  window.ButtonFinderUtils.AI_STUDIO_SEND_BUTTON_SELECTORS = AI_STUDIO_SEND_BUTTON_SELECTORS;

  /**
   * Try a single selector configuration
   * @private
   */
  function trySelector(config) {
    // String selector = direct CSS querySelector
    if (typeof config === 'string') {
      const element = document.querySelector(config);
      return element;
    }

    // Object = advanced selector configuration
    if (typeof config !== 'object' || config === null) {
      console.warn('[Button Finder] Invalid selector config:', config);
      return null;
    }

    const { type, value, textKey, matcher } = config;

    switch (type) {
      case SELECTOR_TYPES.CSS:
        return document.querySelector(value);

      case SELECTOR_TYPES.TEXT:
        return findByTextContent(textKey);

      case SELECTOR_TYPES.ARIA:
        return findByAriaLabel(textKey);

      case SELECTOR_TYPES.FUNCTION:
        if (typeof matcher !== 'function') {
          console.warn('[Button Finder] FUNCTION type requires matcher function');
          return null;
        }
        return matcher();

      default:
        console.warn('[Button Finder] Unknown selector type:', type);
        return null;
    }
  }

  /**
   * Find button by text content using multi-language text map
   * @private
   */
  function findByTextContent(textKey) {
    const texts = TEXT_MAPS[textKey];
    if (!texts || !Array.isArray(texts)) {
      console.warn('[Button Finder] Invalid textKey for TEXT search:', textKey);
      return null;
    }

    const buttons = document.querySelectorAll('button');
    return Array.from(buttons).find(btn => {
      const btnText = btn.textContent?.trim();
      return btnText && texts.some(text => btnText === text);
    });
  }

  /**
   * Find button by aria-label using multi-language text map
   * @private
   */
  function findByAriaLabel(textKey) {
    const texts = TEXT_MAPS[textKey];
    if (!texts || !Array.isArray(texts)) {
      console.warn('[Button Finder] Invalid textKey for ARIA search:', textKey);
      return null;
    }

    const buttons = document.querySelectorAll('button');
    return Array.from(buttons).find(btn => {
      const ariaLabel = btn.getAttribute('aria-label');
      return ariaLabel && texts.some(text => ariaLabel.includes(text));
    });
  }

  // Expose TEXT_MAPS and SELECTOR_TYPES for use in content scripts
  window.ButtonFinderUtils.TEXT_MAPS = TEXT_MAPS;
  window.ButtonFinderUtils.SELECTOR_TYPES = SELECTOR_TYPES;

})();
