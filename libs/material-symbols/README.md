# Material Symbols Outlined (subset)

The extension pages load this font locally, so icons render without
contacting Google Fonts.

- Source: Google Fonts, Material Symbols Outlined (`fontVersion` in
  `font-source.json`), subset with `icon_names=`. The exact CSS and font URLs
  are recorded in `font-source.json`.
- Axes: `FILL` and `GRAD` only. Weight and optical size are fixed at the
  400/24 defaults that `multi-panel.css` and `options.css` use.
- Glyphs: only the icon names listed in `font-source.json`, with their
  ligatures, so an icon renders from its name as text.
- License: Apache-2.0, see `LICENSE`.

## Adding an icon

Icons are written as markup, `<span class="material-symbols-outlined">name</span>`,
or assigned as a literal to an element found with
`querySelector('.material-symbols-outlined')`. After adding one, regenerate the
subset from the repo root:

```sh
node scripts/build-material-symbols-font.js
```

The script scans the packaged HTML and JS for icon names
(`scripts/material-symbols.js`), downloads the matching subset and rewrites
`material-symbols-outlined.woff2`, `material-symbols-outlined.css` and
`font-source.json`. `tests/material-symbols-font.test.js` fails while a used
icon name is missing from the subset, since it would render as plain text.
