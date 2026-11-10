import { getExtensionTopDomains } from './grok-websocket-cookies.js';

/**
 * Provider pages refuse to be framed (X-Frame-Options / CSP frame-ancestors),
 * so their sub_frame responses have those headers removed.
 *
 * The manifest ruleset `bypass_headers` does this for every top-level page.
 * Where the browser supports RuleCondition.topDomains (advertised through
 * RuleConditionKeys since Chrome 145), the same rules are installed as
 * dynamic rules restricted to this extension's own pages, and the manifest
 * ruleset is disabled once they are in place. Anywhere else, or if that
 * fails, the manifest ruleset stays enabled, as before.
 *
 * Chrome resets the enabled static rulesets to the manifest default on every
 * extension update while dynamic rules persist, so this must run again from
 * runtime.onInstalled.
 */
export const STATIC_FRAME_RULESET_ID = 'bypass_headers';
export const STATIC_FRAME_RULES_PATH = 'rules/bypass-headers.json';

// Scoped copies of static rule N use dynamic rule id SCOPED_RULE_ID_OFFSET + N.
export const SCOPED_RULE_ID_OFFSET = 3000;
const SCOPED_RULE_ID_MAX = 3999;

export function isScopedStaticRuleId(id) {
  return Number.isInteger(id) && id > SCOPED_RULE_ID_OFFSET && id <= SCOPED_RULE_ID_MAX;
}

export function restrictRuleToTopDomains(rule, topDomains) {
  return {
    ...rule,
    condition: { ...rule.condition, topDomains: [...topDomains] }
  };
}

export async function loadStaticFrameRules() {
  const response = await fetch(chrome.runtime.getURL(STATIC_FRAME_RULES_PATH));
  if (!response.ok) {
    throw new Error(`Failed to read ${STATIC_FRAME_RULES_PATH}: ${response.status}`);
  }
  const rules = await response.json();
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(`${STATIC_FRAME_RULES_PATH} has no rules`);
  }
  return rules;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function ruleSignature(rule) {
  return JSON.stringify(canonicalize({
    priority: rule.priority ?? 1,
    action: rule.action,
    condition: rule.condition
  }));
}

export function isSameRule(installedRule, desiredRule) {
  return Boolean(installedRule && desiredRule) &&
    installedRule.id === desiredRule.id &&
    ruleSignature(installedRule) === ruleSignature(desiredRule);
}

/**
 * Makes the managed dynamic rules equal to desiredRules, replacing any
 * installed rule whose content differs (for example one installed before
 * scoping was available). Rules outside isManagedId are left alone.
 */
async function applyManagedDynamicRules(desiredRules, isManagedId) {
  const desiredById = new Map(desiredRules.map((rule) => [rule.id, rule]));
  const installedManagedRules = (await chrome.declarativeNetRequest.getDynamicRules())
    .filter(({ id }) => isManagedId(id));
  const unchangedIds = new Set(installedManagedRules
    .filter((rule) => isSameRule(rule, desiredById.get(rule.id)))
    .map(({ id }) => id));
  const removeRuleIds = installedManagedRules
    .map(({ id }) => id)
    .filter((id) => !unchangedIds.has(id));
  const addRules = desiredRules.filter(({ id }) => !unchangedIds.has(id));

  if (removeRuleIds.length > 0 || addRules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
}

async function isStaticFrameRulesetEnabled() {
  const enabledRulesetIds = await chrome.declarativeNetRequest.getEnabledRulesets();
  return enabledRulesetIds.includes(STATIC_FRAME_RULESET_ID);
}

async function installScopedFrameRules(optionalRules, isManagedId, topDomains) {
  const scopedStaticRules = (await loadStaticFrameRules()).map((rule) => restrictRuleToTopDomains(
    { ...rule, id: SCOPED_RULE_ID_OFFSET + rule.id },
    topDomains
  ));
  if (!scopedStaticRules.every(({ id }) => isScopedStaticRuleId(id))) {
    throw new Error(`${STATIC_FRAME_RULES_PATH} has a rule id outside the scoped range`);
  }
  const scopedOptionalRules = optionalRules.map((rule) => restrictRuleToTopDomains(rule, topDomains));
  await applyManagedDynamicRules([...scopedStaticRules, ...scopedOptionalRules], isManagedId);

  // Turn the unscoped ruleset off only once every scoped copy is in place, so
  // provider frames are never left without a rule.
  const installedRules = await chrome.declarativeNetRequest.getDynamicRules();
  const allInstalled = scopedStaticRules.every((desiredRule) => installedRules
    .some((installedRule) => isSameRule(installedRule, desiredRule)));
  if (!allInstalled) {
    throw new Error('Scoped frame header rules are not installed');
  }
  if (await isStaticFrameRulesetEnabled()) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [STATIC_FRAME_RULESET_ID] });
  }
}

async function installUnscopedFrameRules(optionalRules, isManagedId) {
  // Re-enable the manifest ruleset before removing any scoped copy.
  if (!await isStaticFrameRulesetEnabled()) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [STATIC_FRAME_RULESET_ID] });
  }
  await applyManagedDynamicRules(optionalRules, isManagedId);
}

/**
 * Reconciles the frame header rules: the built-in provider rules plus the
 * rules of enabled optional providers (optionalRules). optionalRuleIds lists
 * every optional rule id this extension manages, enabled or not.
 */
export async function syncFrameHeaderRules({ optionalRules = [], optionalRuleIds = [] } = {}) {
  const dnr = typeof chrome === 'undefined' ? null : chrome.declarativeNetRequest;
  if (!dnr?.getDynamicRules || !dnr?.updateDynamicRules) {
    return;
  }

  const managedOptionalIds = new Set(optionalRuleIds);
  const isManagedId = (id) => managedOptionalIds.has(id) || isScopedStaticRuleId(id);
  const rulesetControl = Boolean(dnr.getEnabledRulesets && dnr.updateEnabledRulesets);
  const topDomains = getExtensionTopDomains();

  if (!rulesetControl) {
    await applyManagedDynamicRules(optionalRules, (id) => managedOptionalIds.has(id));
    return;
  }

  if (topDomains) {
    try {
      await installScopedFrameRules(optionalRules, isManagedId, topDomains);
      return;
    } catch (error) {
      console.warn('[Background] Keeping unscoped frame header rules:', error);
    }
  }

  await installUnscopedFrameRules(optionalRules, isManagedId);
}
