import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const styles = await fs.readFile(new URL('../browser/styles.css', import.meta.url), 'utf8');
const seasonal = await fs.readFile(new URL('../browser/madoromi-palettes.css', import.meta.url), 'utf8');
const browserView = await fs.readFile(new URL('../src/browser-view.mjs', import.meta.url), 'utf8');

function block(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing color block for ${selector}`);
  return match[1];
}

function color(declarations, name, palette) {
  const match = declarations.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'));
  assert.ok(match, `${palette} is missing a six-digit --${name} color`);
  return match[1];
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const bytes = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map(value => Number.parseInt(value, 16));
  return 0.2126 * channel(bytes[0]) + 0.7152 * channel(bytes[1]) + 0.0722 * channel(bytes[2]);
}

function contrast(left, right) {
  const brightest = Math.max(luminance(left), luminance(right));
  const darkest = Math.min(luminance(left), luminance(right));
  return (brightest + 0.05) / (darkest + 0.05);
}

test('every selectable palette keeps state-history controls readable', () => {
  const allowedBlock = browserView.match(/palette: Object\.freeze\(\[([\s\S]*?)\]\),/);
  assert.ok(allowedBlock, 'the selectable palette list remains discoverable');
  const allowed = [...allowedBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const palettes = new Map([['fieldwork', block(styles, ':root')]]);
  for (const source of [styles, seasonal]) {
    for (const match of source.matchAll(/html\[data-palette="([^"]+)"\]\s*\{([^}]*)\}/g)) {
      palettes.set(match[1], match[2]);
    }
  }
  assert.deepEqual([...palettes.keys()].sort(), [...allowed].sort(),
    'every selectable palette, and no dead palette, must enter the contrast audit');

  for (const [palette, declarations] of palettes) {
    const control = color(declarations, 'void', palette);
    const surrounding = color(declarations, 'bench', palette);
    const muted = color(declarations, 'muted', palette);
    const border = color(declarations, 'rule-hot', palette);
    const checks = [
      ['control text', color(declarations, 'paper', palette), control, '--void', 4.5],
      ['placeholder text', muted, control, '--void', 4.5],
      ['label text', muted, surrounding, '--bench', 4.5],
      ['border against its fill', border, control, '--void', 3],
      ['border against its surroundings', border, surrounding, '--bench', 3],
    ];
    for (const [purpose, foreground, background, backgroundName, minimum] of checks) {
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= minimum,
        `${palette} ${purpose} is ${ratio.toFixed(2)}:1 against ${backgroundName}; it must be at least ${minimum}:1`);
    }
  }
});
