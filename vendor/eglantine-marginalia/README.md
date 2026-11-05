# Églantine Marginalia (vendored)

Built JavaScript from [cadaeix/eglantine-marginalia](https://github.com/cadaeix/eglantine-marginalia)
at commit `ec2a6d9c27cdb1069a39243258b20938e60f40c8`, licensed MIT (see `LICENSE`; the
Florilegium notice it carries is in `florilegium-LICENSE.txt`).

Only the `.js` files of `dist/` are here, unchanged. They were built with the project's own
`tsc -p tsconfig.build.json`. The `figures/` engravings are **not** included.

Why vendored: upstream does not commit `dist/`, so installing it from GitHub would make every
Fieldwork install need git, download TypeScript, Vite and Vitest, and run a build script. A copy
of the output keeps Fieldwork installable offline, with nothing run at install time.

To update: build a newer commit the same way, replace these files, update the commit above and in
`docs/third-party.md`, and run `npm test`.
