import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fonts = Object.freeze([
  {
    file: 'AtkinsonHyperlegibleNext-Variable.woff2',
    sha256: 'abde1ad5cf78b9ac575ef90d991f2e9101eb0b3b6668bde9a00e2e1e27d99afd',
  },
  {
    file: 'AtkinsonHyperlegibleNext-Italic-Variable.woff2',
    sha256: '34491c5a87f711d314637962f69267d28c7df3ed498082c990cdfbbc02ebf3f2',
  },
  {
    file: 'AtkinsonHyperlegibleMono-Variable.woff2',
    sha256: '4cf41c5cacdb2e98311929f3a482e95b2299ca34e6f389e8968a9075e355d58a',
  },
  {
    file: 'AtkinsonHyperlegibleMono-Italic-Variable.woff2',
    sha256: '6cc3d58e20a4126f837f96ad2ff750628cae6112b8b915794b5c82712b3c1550',
  },
  { file: 'CozetteVector.woff2', sha256: '7acfc852d16b31eceb7b7b46c34f841fe896508ad23e21443d243d782ece230d' },
  { file: 'CozetteVectorBold.woff2', sha256: '459f583822e14cc86a9549d327eb486f96cad7dfdd36e317d0b67b3bf05ddefe' },
  { file: 'ComicNeue-Regular.woff2', sha256: 'dc603c8b97ea803cc1377f15a8cd952ca2fb7408e322b8025099ad1cbf6eaf4f' },
  { file: 'ComicNeue-Bold.woff2', sha256: '6574953451e62da266e30a071b56393eacb6865a4a3c26ba2a73b1c3a37cf79e' },
  { file: 'ComicNeue-Italic.woff2', sha256: '09ab514b68ef3ddb55e03a7ec5a6b100caea5b36195a6d3f104250e3279efc65' },
  { file: 'ComicNeue-BoldItalic.woff2', sha256: 'b24900d4debe9a84621dac335edaf7a87144e00c04cedb83602f654b01daa0c5' },
  { file: 'Lexend-Regular.woff2', sha256: 'dc9905cb55fde950de4e2c1c3240a9ece5ab7b3a7db8d8840322236705e0c017' },
  { file: 'Lexend-Bold.woff2', sha256: 'e7d67b85eb8cd3bc444ff7ed005ade0290c94b2a7664b4289024d387ed58ffc7' },
  { file: 'Shantell_Sans-Normal-Regular.woff2', sha256: '679b07d8ecedbd0a998e8ac6bd144e004eba350c691ffd2a0e13fa41693cfeb9' },
  { file: 'Shantell_Sans-Normal-Bold.woff2', sha256: '89b85f2f73be7678c58686a3a4f534eb8f81dec5f7c0f200eb730dd8cf863c53' },
  { file: 'Shantell_Sans-Normal-Regular_Italic.woff2', sha256: 'd953d79e3963ea9c8aa3bc1fa28b25c2c6598f7bc233ef79677382cd85135abf' },
  { file: 'Shantell_Sans-Normal-Bold_Italic.woff2', sha256: 'b69764f4f7d8fc98816f7e3f254fe100e64223a9420ea33ed1417ee1d3273804' },
]);

test('bundled webfonts retain their pinned upstream bytes', async () => {
  for (const font of fonts) {
    const bytes = await readFile(new URL(`../browser/fonts/${font.file}`, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2', `${font.file} has WOFF2 magic`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), font.sha256, `${font.file} matches its pinned upstream hash`);
  }
});

test('each bundled font family carries its own license notice', async () => {
  const next = await readFile(new URL('../docs/licenses/atkinson-hyperlegible-next-OFL.txt', import.meta.url), 'utf8');
  const mono = await readFile(new URL('../docs/licenses/atkinson-hyperlegible-mono-OFL.txt', import.meta.url), 'utf8');
  assert.match(next, /Atkinson Hyperlegible Next Project Authors/);
  assert.match(mono, /Atkinson Hyperlegible Mono Project Authors/);
  assert.match(next, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(mono, /SIL OPEN FONT LICENSE Version 1\.1/);
  for (const file of ['comic-neue-OFL.txt', 'lexend-OFL.txt', 'shantell-sans-OFL.txt']) {
    const notice = await readFile(new URL(`../docs/licenses/${file}`, import.meta.url), 'utf8');
    assert.match(notice, /SIL OPEN FONT LICENSE Version 1\.1/, file);
  }
  const cozette = await readFile(new URL('../docs/licenses/cozette-MIT.txt', import.meta.url), 'utf8');
  assert.match(cozette, /MIT License/);
  assert.match(cozette, /Copyright \(c\) 2020, Ines/);
});

test('font faces stay local and non-blocking, with Atkinson variable weights', async () => {
  const css = await readFile(new URL('../browser/styles.css', import.meta.url), 'utf8');
  assert.match(css, /font-family:\s*"Atkinson Hyperlegible Next"/);
  assert.match(css, /font-family:\s*"Atkinson Hyperlegible Mono"/);
  for (const family of ['Cozette Vector', 'Comic Neue', 'Lexend', 'Shantell Sans']) {
    assert.match(css, new RegExp(`font-family:\\s*"${family}"`));
  }
  assert.equal((css.match(/@font-face/g) || []).length, fonts.length);
  assert.equal((css.match(/font-display:\s*swap/g) || []).length, fonts.length);
  assert.equal((css.match(/font-weight:\s*200 800/g) || []).length, 4);
  assert.doesNotMatch(css, /url\(\s*["']?https?:/i);
});
