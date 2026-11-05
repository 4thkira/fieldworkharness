# Agent-home template

Copy this directory outside the Fieldwork package and replace the bracketed prompts in `roots/`.
These files are intentionally unfinished: Fieldwork must not choose an agent's identity or relationship
for its operator. For tips and a worked example, see `docs/writing-roots.md` in the Fieldwork folder.

Root order is significant. `voice.md` is a user-tail root, so it remains later than assembled memory and
ordinary system context on each turn.

`fieldwork.json` selects capability packs. The template selects none. Adding a pack requires both an
entry in that file and a loader supplied by the application; files appearing on disk are not discovered.
