# Third-party material

## Madoromi palettes

`browser/madoromi-palettes.css` adapts the published colour tokens for the four night flavours of
[madoromi](https://madoromi.moonwit.ch/) by
[samhain](https://github.com/the-moonwitch): `haru-yoru`, `natsu-yoru`, `aki-yoru`, and `fuyu-yoru`.
The inspected upstream revision is
[`f8bcc5aa1ec3f731fcba9471be7caa5df1ab5695`](https://github.com/the-moonwitch/madoromi/commit/f8bcc5aa1ec3f731fcba9471be7caa5df1ab5695).
Its source of truth is
[`palettes/madoromi.json`](https://github.com/the-moonwitch/madoromi/blob/f8bcc5aa1ec3f731fcba9471be7caa5df1ab5695/palettes/madoromi.json),
with semantic usage documented in its
[`style-guide.md`](https://github.com/the-moonwitch/madoromi/blob/f8bcc5aa1ec3f731fcba9471be7caa5df1ab5695/palettes/style-guide.md).
The inspected generated CSS is Git blob `3fde5c23783e3325b18a465da15d2cde7ac3c1ca`; the palette JSON is
Git blob `b31ff12804c0569fe30ad14815b8a4dc7f219c0a`.

Madoromi's code and themes are licensed under the Mozilla Public License 2.0. The adapted palette file is
available under `MPL-2.0 OR GPL-3.0-or-later`; copies are included at
[`licenses/MPL-2.0.txt`](licenses/MPL-2.0.txt) and [`../LICENSE`](../LICENSE).
That copy is upstream Git blob `89fe5b2004873b5f5237874446f65df5c02f9dc2` (raw-file SHA-256
`5eba353fe5076ac3432177f8ab1cf75e3afcd0584251e37c3bfead5f447d040e`).

Fieldwork does not bundle madoromi's fonts, scans, images, scripts, markup, or layout code. Iroshizuku is a
trademark of Pilot Corporation; neither madoromi nor Fieldwork is affiliated with Pilot.

## Églantine Marginalia

The optional margin garden (Settings → Appearance → Margin garden; off unless chosen) is drawn by
[Églantine Marginalia](https://github.com/cadaeix/eglantine-marginalia) by cadaeix, at commit
`ec2a6d9c27cdb1069a39243258b20938e60f40c8`. Its built JavaScript is vendored, unchanged, in
[`../vendor/eglantine-marginalia/`](../vendor/eglantine-marginalia/README.md) and runs locally
with no network access.

The complete reviewed vendor tree is 35 regular UTF-8 files, including 32 non-empty JavaScript files. Its
`fieldwork-vendor-tree-v1` canonical SHA-256 is
`43e75e92a2f65c1dac26892cc255b6ff636fa133ca98259fa5b6b79d220b0e0d`. The digest starts with the UTF-8
domain separator `fieldwork-vendor-tree-v1\n`; each file is decoded as strict UTF-8 and Git's possible CRLF
checkout conversion is normalized back to LF. For each POSIX relative path in bytewise sorted order it then
hashes the decimal UTF-8 path length, `:`, the path bytes, `:`, the decimal canonical file length, `:`, and the
canonical file bytes. `.gitattributes` pins this vendor tree to LF for new checkouts. The source test fails on
additions, removals, links, empty JavaScript, invalid UTF-8, or any content change other than CRLF conversion.

It is licensed MIT; a copy is at
[`licenses/eglantine-marginalia-LICENSE.txt`](licenses/eglantine-marginalia-LICENSE.txt). Upstream
carries Florilegium's MIT notice, copied at
[`licenses/eglantine-marginalia-florilegium-LICENSE.txt`](licenses/eglantine-marginalia-florilegium-LICENSE.txt).

Fieldwork does not include or load the calendar's animal and tool engravings (`figures/`). Those
have their own sources and attributions; adding them later would need each figure's provenance
carried with it, which the library's MIT license does not replace.

## Atkinson Hyperlegible fonts

Fieldwork bundles the upright and italic WOFF2 variable fonts from
[Atkinson Hyperlegible Next](https://github.com/googlefonts/atkinson-hyperlegible-next) at commit
[`7925f50f649b3813257faf2f4c0b381011f434f1`](https://github.com/googlefonts/atkinson-hyperlegible-next/commit/7925f50f649b3813257faf2f4c0b381011f434f1)
and [Atkinson Hyperlegible Mono](https://github.com/googlefonts/atkinson-hyperlegible-next-mono) at
commit
[`154d50362016cc3e873eb21d242cd0772384c8f9`](https://github.com/googlefonts/atkinson-hyperlegible-next-mono/commit/154d50362016cc3e873eb21d242cd0772384c8f9).
Both are upstream release 2.001. The files are served locally from [`../browser/fonts/`](../browser/fonts/);
the browser never contacts a font service.

The vendored files are unchanged and have these SHA-256 hashes:

- `AtkinsonHyperlegibleNext-Variable.woff2` — `abde1ad5cf78b9ac575ef90d991f2e9101eb0b3b6668bde9a00e2e1e27d99afd`
- `AtkinsonHyperlegibleNext-Italic-Variable.woff2` — `34491c5a87f711d314637962f69267d28c7df3ed498082c990cdfbbc02ebf3f2`
- `AtkinsonHyperlegibleMono-Variable.woff2` — `4cf41c5cacdb2e98311929f3a482e95b2299ca34e6f389e8968a9075e355d58a`
- `AtkinsonHyperlegibleMono-Italic-Variable.woff2` — `6cc3d58e20a4126f837f96ad2ff750628cae6112b8b915794b5c82712b3c1550`

Both families are licensed under the SIL Open Font License 1.1. The upstream notices and full
license text are included at
[`licenses/atkinson-hyperlegible-next-OFL.txt`](licenses/atkinson-hyperlegible-next-OFL.txt) and
[`licenses/atkinson-hyperlegible-mono-OFL.txt`](licenses/atkinson-hyperlegible-mono-OFL.txt).

## Cozette

Fieldwork bundles the regular and bold vector WOFF2 files from
[Cozette](https://github.com/the-moonwitch/Cozette), release
[`v.1.30.0`](https://github.com/the-moonwitch/Cozette/releases/tag/v.1.30.0), at commit
[`d2282e728aa64949b0a1e6489920ceb0772944fa`](https://github.com/the-moonwitch/Cozette/commit/d2282e728aa64949b0a1e6489920ceb0772944fa).
Cozette is a compact pixel typeface with a native 6 by 13 design. Fieldwork uses the upstream vector webfont
for browser compatibility, offers it only as an opt-in display choice, and does not claim that vector
rasterization will reproduce every native bitmap size exactly.

The unchanged files have these SHA-256 hashes:

- `CozetteVector.woff2` — `7acfc852d16b31eceb7b7b46c34f841fe896508ad23e21443d243d782ece230d`
- `CozetteVectorBold.woff2` — `459f583822e14cc86a9549d327eb486f96cad7dfdd36e317d0b67b3bf05ddefe`

Cozette is licensed under the MIT License; its notice and full text are included at
[`licenses/cozette-MIT.txt`](licenses/cozette-MIT.txt).

## Comic Neue

Fieldwork bundles the regular, bold, italic, and bold italic WOFF2 files from
[Comic Neue](https://github.com/crozynski/comicneue), release
[`2.51`](https://github.com/crozynski/comicneue/releases/tag/2.51), at commit
[`1fa968608b1f4f7f1775824df3d2081fc93e2e9f`](https://github.com/crozynski/comicneue/commit/1fa968608b1f4f7f1775824df3d2081fc93e2e9f).

The unchanged files have these SHA-256 hashes:

- `ComicNeue-Regular.woff2` — `dc603c8b97ea803cc1377f15a8cd952ca2fb7408e322b8025099ad1cbf6eaf4f`
- `ComicNeue-Bold.woff2` — `6574953451e62da266e30a071b56393eacb6865a4a3c26ba2a73b1c3a37cf79e`
- `ComicNeue-Italic.woff2` — `09ab514b68ef3ddb55e03a7ec5a6b100caea5b36195a6d3f104250e3279efc65`
- `ComicNeue-BoldItalic.woff2` — `b24900d4debe9a84621dac335edaf7a87144e00c04cedb83602f654b01daa0c5`

Comic Neue is licensed under the SIL Open Font License 1.1; its upstream notice and full text are included
at [`licenses/comic-neue-OFL.txt`](licenses/comic-neue-OFL.txt).

## Lexend

Fieldwork bundles regular and bold static WOFF2 instances from
[Lexend](https://github.com/googlefonts/lexend) at commit
[`7894f02b2e7eabc48595f1d4eff3b17b48c6e651`](https://github.com/googlefonts/lexend/commit/7894f02b2e7eabc48595f1d4eff3b17b48c6e651).

The unchanged files have these SHA-256 hashes:

- `Lexend-Regular.woff2` — `dc9905cb55fde950de4e2c1c3240a9ece5ab7b3a7db8d8840322236705e0c017`
- `Lexend-Bold.woff2` — `e7d67b85eb8cd3bc444ff7ed005ade0290c94b2a7664b4289024d387ed58ffc7`

Lexend is licensed under the SIL Open Font License 1.1; its upstream notice and full text are included at
[`licenses/lexend-OFL.txt`](licenses/lexend-OFL.txt).

## Shantell Sans

Fieldwork bundles the regular, bold, italic, and bold italic WOFF2 files from
[Shantell Sans](https://github.com/arrowtype/shantell-sans), release
[`1.011`](https://github.com/arrowtype/shantell-sans/releases/tag/1.011), at commit
[`68f5eca1490a58973b2a814d3a7d0f61291fd0c9`](https://github.com/arrowtype/shantell-sans/commit/68f5eca1490a58973b2a814d3a7d0f61291fd0c9).

The unchanged files have these SHA-256 hashes:

- `Shantell_Sans-Normal-Regular.woff2` — `679b07d8ecedbd0a998e8ac6bd144e004eba350c691ffd2a0e13fa41693cfeb9`
- `Shantell_Sans-Normal-Bold.woff2` — `89b85f2f73be7678c58686a3a4f534eb8f81dec5f7c0f200eb730dd8cf863c53`
- `Shantell_Sans-Normal-Regular_Italic.woff2` — `d953d79e3963ea9c8aa3bc1fa28b25c2c6598f7bc233ef79677382cd85135abf`
- `Shantell_Sans-Normal-Bold_Italic.woff2` — `b69764f4f7d8fc98816f7e3f254fe100e64223a9420ea33ed1417ee1d3273804`

Shantell Sans is licensed under the SIL Open Font License 1.1; its upstream notice and full text are
included at [`licenses/shantell-sans-OFL.txt`](licenses/shantell-sans-OFL.txt).

All six bundled font families are served only from Fieldwork's fixed same-origin routes. The room does not
contact a font CDN, and it presents the families as display choices rather than making efficacy claims about a
particular reader or disability.
