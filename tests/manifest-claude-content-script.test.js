import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readProjectFile = path => readFileSync(resolve(process.cwd(), path), 'utf8');
const manifest = JSON.parse(
  readProjectFile('manifest.json')
);
const multiPanelSource = readProjectFile('multi-panel/multi-panel.js');
const multiPanelStyles = readProjectFile('multi-panel/multi-panel.css');

describe('manifest Claude content script coverage', () => {
  it('keeps standard Claude integration without a main-world request interceptor', () => {
    const claudeRegistrations = manifest.content_scripts.filter(({ matches }) =>
      matches.includes('https://claude.ai/*')
    );
    const claudeScripts = claudeRegistrations.flatMap(({ js }) => js);

    expect(claudeScripts).toEqual(expect.arrayContaining([
      'content-scripts/enter-behavior-utils.js',
      'content-scripts/enter-behavior-claude.js',
      'content-scripts/text-injection-all-providers.js',
      'content-scripts/focus-toggle.js'
    ]));
    expect(claudeScripts.some(script => script.includes('claude-model-request'))).toBe(false);
    expect(claudeRegistrations.some(({ world }) => world === 'MAIN')).toBe(false);
  });

  it('does not render the retired Panelize model selector or warning banner', () => {
    expect(multiPanelSource).not.toContain('panel-claude-model-select');
    expect(multiPanelSource).not.toContain('embedded-model-limit-notice');
    expect(multiPanelStyles).not.toContain('.panel-claude-model-select');
    expect(multiPanelStyles).not.toContain('.embedded-model-limit-notice');
  });
});
