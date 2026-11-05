# Contributing to Fieldwork

Fieldwork is a local-first home for persistent AI agents. Contributions should keep its public,
profile-driven boundary intact: the engine provides mechanisms, while the person running it supplies
the agent's identity, relationships, voice, accounts, and data.

## Set up a development checkout

Fieldwork requires Node.js 22 or newer. Install exactly the dependency tree recorded in
`npm-shrinkwrap.json` without running dependency lifecycle scripts:

```sh
npm ci --no-fund --no-audit --ignore-scripts
```

`npm run browser:demo` starts a temporary synthetic room without an account or API key. The URL it
prints contains a local room password after `#`; treat the complete URL as private even in demo work.

## Make a focused change

- Keep examples and fixtures synthetic. Never copy a real profile, transcript, account identifier,
  token, local path, private asset, or private Git history into this repository.
- Do not prescribe an agent's name, personality, relationships, vocabulary, pronouns, or appearance.
- Keep dynamic, fetched, stored, user-authored, profile-authored, model, platform, path, and error text
  literal. Do not pass it through authored-name or prose template rendering.
- No configured capability means no capability. Filesystem presence alone must not activate a pack,
  tool, account, or bridge.
- Persistent changes must remain attributed, conflict-checked, inspectable, and reversible. Retrieved
  evidence must not silently become agent memory.
- Update the user-facing documentation and synthetic regression coverage when behavior changes.
- Preserve unrelated work already present in the checkout.

Local settings, secrets, agent homes, recovery copies, and runtime state are deliberately ignored.
Do not force-add them. `docs/limitations.md` is part of the contract: a new guarantee should name where
it stops as well as where it works.

## Verify the change

Run the narrowest relevant test file while developing. Before asking for review, run both complete
gates from the repository root:

```sh
npm run check
npm run release:check
```

`npm run check` performs the syntax and behavior suite. `npm run release:check` builds the real npm
archive without publishing it, checks its file and credential boundary, installs it into an isolated
temporary prefix with dependency scripts disabled, verifies that packaged relative Markdown links resolve
inside that archive (reference-style links are deliberately refused), and exercises packaged first-time setup.

In the change description, separate the checks you actually ran from browser or platform behavior you
did not exercise. A source test is not evidence that a live bridge delivered a message.

## Security reports

Do not put credentials, private agent data, or unredacted exploit details in a public issue. Follow
[`SECURITY.md`](SECURITY.md) and use GitHub's private vulnerability-reporting form. The
[`Fieldwork community guidelines`](CODE_OF_CONDUCT.md) describe the boundaries for project spaces,
including private adult use, agent self-authorship, necessary explicit reproduction material, and the
private route for sensitive community reports.
