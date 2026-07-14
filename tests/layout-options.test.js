import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');

const multiPanelHtml = readProjectFile('multi-panel/multi-panel.html');
const multiPanelCss = readProjectFile('multi-panel/multi-panel.css');
const multiPanelJs = readProjectFile('multi-panel/multi-panel.js');
const optionsHtml = readProjectFile('options/options.html');

describe('ten-panel layout options', () => {
  it.each(['1x9', '1x10', '2x5'])('shows the %s layout in both selectors', (layout) => {
    expect(multiPanelHtml).toContain(`data-layout="${layout}"`);
    expect(optionsHtml).toContain(`<option value="${layout}">`);
  });

  it.each(['1x9', '1x10', '2x5'])('defines the %s grid and preview styles', (layout) => {
    expect(multiPanelCss).toContain(`.layout-${layout} {`);
    expect(multiPanelCss).toContain(`.layout-${layout}-preview {`);
  });

  it('raises the panel limit and declares the new capacities', () => {
    expect(multiPanelJs).toContain('const MAX_PANELS = 10;');
    expect(multiPanelJs).toContain("'1x9': 9");
    expect(multiPanelJs).toContain("'1x10': 10");
    expect(multiPanelJs).toContain("'2x5': 10");
  });
});
