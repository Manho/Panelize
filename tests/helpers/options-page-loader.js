/**
 * Tracks imported `options/options.js` module instances within a test suite so
 * tests deterministically await `initPromise` and tear down all document/window/
 * chrome listeners and timers in `afterEach` before Vitest tears down the DOM.
 */
export function createOptionsPageLoader() {
  const loadedModules = [];

  async function loadOptionsPage() {
    const optionsMod = await import('../../options/options.js');
    loadedModules.push(optionsMod);
    await optionsMod.initPromise;
    return optionsMod;
  }

  async function cleanupOptionsPages() {
    const modules = loadedModules.splice(0);
    for (const mod of modules) {
      await mod.initPromise?.catch(() => {});
      mod.cleanupOptionsPage?.();
    }
  }

  return {
    loadOptionsPage,
    cleanupOptionsPages,
  };
}
