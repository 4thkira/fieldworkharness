# Fieldwork public repository

This repository is built from a default-deny boundary.

- Keep examples synthetic. Do not copy private profiles, transcripts, account identifiers,
  local paths, assets, fixtures, or Git history into this tree.
- A profile is data supplied by the person running Fieldwork. The engine must not prescribe
  an agent's name, personality, relationships, vocabulary, or appearance.
- No configured packs means no packs. Filesystem presence alone never activates a capability.
- Dynamic, fetched, stored, user-authored, profile-authored, path, model, platform, and error
  text remains literal. Never pass it through an authored-name or prose template renderer.
- Durable changes are versioned, attributed, conflict-checked, and reversible.
- Retrieved material remains attributed evidence; it does not silently become agent memory.
- Run the relevant focused tests, then the complete suite, before committing.
- Release history is born here. Never import commits or objects from a private source repo.
