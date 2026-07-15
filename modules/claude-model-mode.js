export const CLAUDE_MODEL_OVERRIDE_MESSAGE_TYPE = 'PANELIZE_CLAUDE_MODEL_OVERRIDE';

export const CLAUDE_MODEL_MODE_DEFAULT = 'default';
export const CLAUDE_MODEL_MODE_SONNET_5 = 'sonnet-5';
export const CLAUDE_MODEL_MODE_OPUS_4_8 = 'opus-4-8';
export const CLAUDE_MODEL_MODE_HAIKU_4_5 = 'haiku-4-5';
export const DEFAULT_CLAUDE_MODEL_MODE = CLAUDE_MODEL_MODE_DEFAULT;

/** Supported user-facing Claude model modes and their request identifiers. */
export const CLAUDE_MODEL_OPTIONS = Object.freeze([
  Object.freeze({
    mode: CLAUDE_MODEL_MODE_DEFAULT,
    label: 'Claude default',
    modelId: ''
  }),
  Object.freeze({
    mode: CLAUDE_MODEL_MODE_OPUS_4_8,
    label: 'Opus 4.8',
    modelId: 'claude-opus-4-8'
  }),
  Object.freeze({
    mode: CLAUDE_MODEL_MODE_SONNET_5,
    label: 'Sonnet 5',
    modelId: 'claude-sonnet-5'
  }),
  Object.freeze({
    mode: CLAUDE_MODEL_MODE_HAIKU_4_5,
    label: 'Haiku 4.5',
    modelId: 'claude-haiku-4-5-20251001'
  })
]);

const CLAUDE_MODEL_OPTIONS_BY_MODE = new Map(
  CLAUDE_MODEL_OPTIONS.map(option => [option.mode, option])
);

/**
 * Normalize a stored Claude model mode to a supported value.
 *
 * @param {unknown} mode Stored model mode.
 * @returns {string} A supported Claude model mode.
 */
export function normalizeClaudeModelMode(mode) {
  return CLAUDE_MODEL_OPTIONS_BY_MODE.has(mode)
    ? mode
    : DEFAULT_CLAUDE_MODEL_MODE;
}

/**
 * Get the display and request metadata for a Claude model mode.
 *
 * @param {unknown} mode Claude model mode.
 * @returns {{mode: string, label: string, modelId: string}}
 */
export function getClaudeModelOption(mode) {
  return CLAUDE_MODEL_OPTIONS_BY_MODE.get(normalizeClaudeModelMode(mode));
}

/**
 * Build the parent-to-frame message used to configure Claude request overrides.
 *
 * @param {unknown} mode Claude model mode.
 * @returns {{type: string, mode: string, model: string}}
 */
export function createClaudeModelOverrideMessage(mode) {
  const option = getClaudeModelOption(mode);
  return {
    type: CLAUDE_MODEL_OVERRIDE_MESSAGE_TYPE,
    mode: option.mode,
    model: option.modelId
  };
}
