import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FRAME_TO_HOST_MESSAGES,
  HOST_TO_FRAME_MESSAGES,
} from '../modules/panel-message-contract.js';

const HOST_SENDER_FILES = [
  'multi-panel/multi-panel.js',
  'modules/panel-action-results.js',
  'modules/snapshot-capture.js',
];

const FRAME_SENDER_FILES = ['content-scripts/text-injection-all-providers.js'];

const sourceCache = new Map();

function readProjectSource(relativePath) {
  if (!sourceCache.has(relativePath)) {
    sourceCache.set(relativePath, readFileSync(resolve(process.cwd(), relativePath), 'utf8'));
  }
  return sourceCache.get(relativePath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsQuotedLiteral(source, literal) {
  const pattern = new RegExp(`['"]${escapeRegExp(literal)}['"]`);
  return pattern.test(source);
}

/**
 * Builds a lookup table of top-level string constants (`const FOO = 'BAR'`) and
 * frozen constant maps (`const MAP = Object.freeze({ KEY: 'VALUE' })`) inside a
 * source file so symbolic `type:` references passed to `postMessage` helpers
 * resolve to their concrete wire strings.
 */
function extractStringConstants(source) {
  const constants = new Map();

  // Simple string constants: `const PANELIZE_FOO = 'PANELIZE_FOO';`
  const simpleConstRegex = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(simpleConstRegex)) {
    constants.set(match[1], match[2]);
  }

  // Object map constants: `const SNAPSHOT_MESSAGES = Object.freeze({ PREPARE: '...' })`
  const objectConstRegex =
    /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:Object\.freeze\(\s*)?\{([\s\S]*?)\}\s*\)?;/g;
  const propRegex = /\b([A-Z][A-Z0-9_]*)\s*:\s*['"]([^'"]+)['"]/g;
  for (const objMatch of source.matchAll(objectConstRegex)) {
    const mapName = objMatch[1];
    const body = objMatch[2];
    for (const propMatch of body.matchAll(propRegex)) {
      constants.set(`${mapName}.${propMatch[1]}`, propMatch[2]);
    }
  }

  return constants;
}

function extractTypeAndActionFromObjectLiteral(objectBody, constants, types, actions) {
  // Matches `type: 'LITERAL'` or `type: SYMBOLIC_CONST`
  const typePropRegex = /\btype\s*:\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9_.]*))/g;
  for (const match of objectBody.matchAll(typePropRegex)) {
    if (match[1]) {
      types.add(match[1]);
    } else if (match[2] && constants.has(match[2])) {
      types.add(constants.get(match[2]));
    }
  }

  // Matches `action: 'fill'` or ternary `action: cond ? 'fill' : undefined`
  const actionPropRegex = /\baction\s*:\s*(?:[^,\n}]*\?\s*)?['"]([^'"]+)['"]/g;
  for (const match of objectBody.matchAll(actionPropRegex)) {
    actions.add(match[1]);
  }
}

/**
 * Reverse-scan extractor for host -> frame senders (`multi-panel/multi-panel.js`,
 * `modules/panel-action-results.js`, `modules/snapshot-capture.js`):
 * 1. `postToPanelFrame(panel, { ... })` object literals (`type:` and `action:`);
 * 2. `determinePanelMessageType(...)` return expressions (`'INJECT_TEXT*'`);
 * 3. `bridge.request(panel, TYPE_EXPR, ...)` snapshot requests;
 * 4. Direct `.postMessage({ ... }, origin)` object literals if any appear.
 */
function extractHostToFrameSentLiterals() {
  const types = new Set();
  const actions = new Set();

  for (const file of HOST_SENDER_FILES) {
    const source = readProjectSource(file);
    const constants = extractStringConstants(source);

    const postToPanelRegex = /\bpostToPanelFrame\s*\(\s*[^,]+,\s*\{([\s\S]*?)\}\s*\)/g;
    for (const match of source.matchAll(postToPanelRegex)) {
      extractTypeAndActionFromObjectLiteral(match[1], constants, types, actions);
    }

    const determineTypeFnRegex =
      /\bfunction\s+determinePanelMessageType\b[\s\S]*?\{([\s\S]*?)\n\}/g;
    for (const fnMatch of source.matchAll(determineTypeFnRegex)) {
      for (const strMatch of fnMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
        types.add(strMatch[1]);
      }
    }

    const bridgeRequestRegex =
      /\bbridge\.request\s*\(\s*[^,]+,\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9_.]*))/g;
    for (const match of source.matchAll(bridgeRequestRegex)) {
      if (match[1]) {
        types.add(match[1]);
      } else if (match[2] && constants.has(match[2])) {
        types.add(constants.get(match[2]));
      }
    }

    const directPostMessageRegex = /\.postMessage\s*\(\s*\{([\s\S]*?)\}\s*,/g;
    for (const match of source.matchAll(directPostMessageRegex)) {
      extractTypeAndActionFromObjectLiteral(match[1], constants, types, actions);
    }
  }

  return { types, actions };
}

/**
 * Reverse-scan extractor for frame -> host senders (`content-scripts/text-injection-all-providers.js`):
 * 1. `postToMultiPanelHost({ ... })` inline object literals (`type:` and `action:`);
 * 2. `const message = { ... }; ... postToMultiPanelHost(message)` staged payloads;
 * 3. `postMultiPanelProviderStatus(TYPE_EXPR, ...)` status helper calls;
 * 4. Direct `window.parent.postMessage({ ... }, ...)` object literals if any appear.
 */
function extractFrameToHostSentLiterals() {
  const types = new Set();
  const actions = new Set();

  for (const file of FRAME_SENDER_FILES) {
    const source = readProjectSource(file);
    const constants = extractStringConstants(source);

    const inlinePostRegex = /\bpostToMultiPanelHost\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    for (const match of source.matchAll(inlinePostRegex)) {
      extractTypeAndActionFromObjectLiteral(match[1], constants, types, actions);
    }

    const stagedMessageRegex =
      /\bconst\s+message\s*=\s*\{([\s\S]*?)\};[\s\S]{0,500}?\bpostToMultiPanelHost\s*\(\s*message\s*\)/g;
    for (const match of source.matchAll(stagedMessageRegex)) {
      extractTypeAndActionFromObjectLiteral(match[1], constants, types, actions);
    }

    const providerStatusCallRegex =
      /\bpostMultiPanelProviderStatus\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9_]*))/g;
    for (const match of source.matchAll(providerStatusCallRegex)) {
      if (match[1]) {
        types.add(match[1]);
      } else if (match[2] && constants.has(match[2])) {
        types.add(constants.get(match[2]));
      }
    }

    const directParentPostRegex = /\bwindow\.parent\.postMessage\s*\(\s*\{([\s\S]*?)\}\s*,/g;
    for (const match of source.matchAll(directParentPostRegex)) {
      extractTypeAndActionFromObjectLiteral(match[1], constants, types, actions);
    }
  }

  return { types, actions };
}

describe('panel-message-contract', () => {
  it('exports frozen host-to-frame and frame-to-host message lists with complete metadata', () => {
    expect(Object.isFrozen(HOST_TO_FRAME_MESSAGES)).toBe(true);
    expect(Object.isFrozen(FRAME_TO_HOST_MESSAGES)).toBe(true);
    expect(HOST_TO_FRAME_MESSAGES.length).toBeGreaterThan(0);
    expect(FRAME_TO_HOST_MESSAGES.length).toBeGreaterThan(0);

    for (const entry of [...HOST_TO_FRAME_MESSAGES, ...FRAME_TO_HOST_MESSAGES]) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.payloadFields)).toBe(true);
      expect(Object.isFrozen(entry.senderFiles)).toBe(true);
      expect(Object.isFrozen(entry.receiverFiles)).toBe(true);
      expect(typeof entry.type).toBe('string');
      expect(entry.type.length).toBeGreaterThan(0);
      expect(entry.payloadFields).toContain('type');
      expect(entry.senderFiles.length).toBeGreaterThan(0);
      expect(entry.receiverFiles.length).toBeGreaterThan(0);
    }
  });

  it('documents the three origin and source security rules in the module JSDoc header', () => {
    const contractSource = readProjectSource('modules/panel-message-contract.js');
    expect(contractSource).toContain('getProviderFrameOrigins(providerId)');
    expect(contractSource).toContain('event.origin === chrome-extension://<id>');
    expect(contractSource).toContain('iframe.contentWindow');
  });

  it('forward check: every listed host-to-frame message appears in a host sender and in the content-script receiver', () => {
    const receiverSource = readProjectSource('content-scripts/text-injection-all-providers.js');

    for (const entry of HOST_TO_FRAME_MESSAGES) {
      expect(entry.direction).toBe('host-to-frame');
      const appearsInListedSender = entry.senderFiles.some((senderFile) =>
        containsQuotedLiteral(readProjectSource(senderFile), entry.type)
      );
      expect(appearsInListedSender, `host sender missing ${entry.type}`).toBe(true);
      expect(
        containsQuotedLiteral(receiverSource, entry.type),
        `content-script receiver missing ${entry.type}`
      ).toBe(true);

      if (entry.action) {
        const actionInSender = entry.senderFiles.some((senderFile) =>
          containsQuotedLiteral(readProjectSource(senderFile), entry.action)
        );
        expect(actionInSender, `host sender missing action ${entry.action}`).toBe(true);
      }
    }
  });

  it('forward check: every listed frame-to-host message appears in the content-script sender and in its host receiver', () => {
    const senderSource = readProjectSource('content-scripts/text-injection-all-providers.js');

    for (const entry of FRAME_TO_HOST_MESSAGES) {
      expect(entry.direction).toBe('frame-to-host');
      expect(
        containsQuotedLiteral(senderSource, entry.type),
        `content-script sender missing ${entry.type}`
      ).toBe(true);

      const appearsInListedReceiver = entry.receiverFiles.some((receiverFile) =>
        containsQuotedLiteral(readProjectSource(receiverFile), entry.type)
      );
      expect(appearsInListedReceiver, `host receiver missing ${entry.type}`).toBe(true);

      if (entry.action) {
        expect(
          containsQuotedLiteral(senderSource, entry.action),
          `content-script sender missing action ${entry.action}`
        ).toBe(true);
        const actionInReceiver = entry.receiverFiles.some((receiverFile) =>
          containsQuotedLiteral(readProjectSource(receiverFile), entry.action)
        );
        expect(actionInReceiver, `host receiver missing action ${entry.action}`).toBe(true);
      }
    }
  });

  it('reverse check: every type and action passed to postMessage in host and frame senders is listed in the contract', () => {
    const listedHostTypes = new Set(HOST_TO_FRAME_MESSAGES.map((entry) => entry.type));
    const listedHostActions = new Set(
      HOST_TO_FRAME_MESSAGES.map((entry) => entry.action).filter(Boolean)
    );
    const extractedHost = extractHostToFrameSentLiterals();

    for (const sentType of extractedHost.types) {
      expect(listedHostTypes, `unlisted host-to-frame type "${sentType}"`).toContain(sentType);
    }
    for (const sentAction of extractedHost.actions) {
      expect(listedHostActions, `unlisted host-to-frame action "${sentAction}"`).toContain(
        sentAction
      );
    }

    const listedFrameTypes = new Set(FRAME_TO_HOST_MESSAGES.map((entry) => entry.type));
    const listedFrameActions = new Set(
      FRAME_TO_HOST_MESSAGES.map((entry) => entry.action).filter(Boolean)
    );
    const extractedFrame = extractFrameToHostSentLiterals();

    for (const sentType of extractedFrame.types) {
      expect(listedFrameTypes, `unlisted frame-to-host type "${sentType}"`).toContain(sentType);
    }
    for (const sentAction of extractedFrame.actions) {
      expect(listedFrameActions, `unlisted frame-to-host action "${sentAction}"`).toContain(
        sentAction
      );
    }
  });
});
