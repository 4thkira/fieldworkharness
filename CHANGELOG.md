# Changelog

User-visible changes are recorded here before a release is cut.

## Unreleased

## 0.1.0-alpha.1

First public prerelease.

### Added

- An optional Fieldwork Expert under Settings → Agents. It is a separate, explicitly opened help
  agent with bounded read-only search over the documentation packaged with the running build. It
  cites document sections, treats Health and receipts as the live evidence boundary, needs no web
  access, and receives no extra permissions; ordinary new agents still begin blank.
- An optional `meaning` kit: automatic memory gives one extra seat to the saved memory closest in meaning to
  the newest message, using a local embedding model (default `qwen3-embedding:0.6b` through Ollama), so a
  message about "my dog" can find a memory about "the puppy". The seat only adds above a similarity floor and
  never reorders word matches; Fieldwork sends text only to its configured loopback endpoint; receipts and the reply
  fold say when a memory was found by meaning. In a live room with local `qwen3.5:4b` and the light starting
  tool set, two paraphrased questions each got the right memory and the reply used it.
- A per-agent, per-service reasoning-effort control under Settings → Connection. ChatGPT subscription
  models use their live Codex catalogue choices; OpenAI-compatible models can request the public
  Chat Completions effort values. Provider default sends no override, and explicit changes are saved,
  receipted, inspectable, and undoable.
- A notice in Health and the empty conversation while any root still holds only the template's bracketed
  instructions, and a plain-language guide with a worked synthetic example: `docs/writing-roots.md`.
- A history-clean public-repository exporter and deterministic GitHub Release artifact builder. Both
  commands are local-only, refuse dirty or changing source, and never push, tag, or publish to npm.
- A security policy, private-reporting route, Fieldwork community guidelines, versioned release notes,
  and explicit GitHub-only distribution contract.
- Per-conversation automatic check-in controls, closed-page scheduling, and an explicit option to
  deliver kept check-in replies through an already connected Telegram or Discord conversation.
- Portable, bounded agent export and import that excludes Fieldwork-managed credentials, recovery
  copies, and live bridge bindings.
- Read-only CI and packaged-release verification on the Node.js 22 floor and Node 24/26 LTS lines,
  across Windows, macOS, and Linux.

### Changed

- "How it got there" now leads with plain words: the newest message and earlier conversation, each agent file
  with when it was read, the room's notes by name, what each offered memory actually said, and the tools on
  hand. Versions, hashes, and exact times moved behind a "Technical details" toggle. Receipts still never copy
  memory text: the fold reads the exact offered version from the ledger when opened, and says when a memory
  was revised or withdrawn since.
- Health, the Telegram and Discord bridges, State & history, Task heartbeats, Goals & promises, and the
  Outside reader now explain themselves in plain words. Health leads with status and file count, shows
  each root as "read first" or "read last" with a local time, and keeps exact versions in a collapsed
  keyboard-accessible Verify disclosure.
- The last step of a conversation run now ends its request with a one-line room note saying tools cannot run
  and asking for an answer in words. Tools stay declared on that step. The note appears in the reply's
  "How it got there" fold and is never saved to the conversation. In local tests with `qwen3.5:4b`, the
  model reached for another tool on the last step in 3 of 3 tries without the note, and answered in words in
  7 of 8 tries with it. If a model still calls a tool there, the call is refused as before and the room now
  says the agent ran out of steps.
- A brand-new agent starts with Fieldwork help, Collections, Shelf, Moods & expression, Self & room, and Other
  (the goal and promise tools) on demand. With the suggested Memory, Notebook, and Clock kits, a new room
  declares only the resident tool schemas plus the loader instead of the entire catalogue. The choice is saved
  on first start; agents that already have a conversation or memory keep their current modes.
- The synthetic demo now removes demo folders left behind by earlier runs that were stopped without Ctrl+C,
  but only when every lock inside names a process that is no longer running. It also cleans up when its
  console window is closed.
- Startup now guardedly recovers only verified Fieldwork state locks whose recorded PID is absent on this
  computer; live, malformed, replaced, or unverifiable locks are preserved with actionable launcher advice.
- Check-in, Task heartbeat, and outside-reader persistent state mutations now cooperate across processes sharing
  one agent home: each reloads current disk state under a short exclusive transaction lock, while the saved
  15-minute token remains the long-running claim.
- Bridge replies continue the exact saved Fieldwork conversation and bind acknowledgement evidence
  to the prepared destination and content.
- Windows launcher dependency setup is lockfile-pinned and receipt-checked before startup; its canonical install lock
  uses guarded, identity-checked stale recovery and refuses live, unknown, malformed, linked, or replaced locks.

### Fixed

- Meaning recall and OpenAI-compatible model requests now keep their configured deadline alive on
  Node.js 22 even when the remote service never answers, while still giving an explicit caller
  cancellation precedence and clearing the deadline after every settled request.
- The Fieldwork Expert designation now survives every managed lifecycle path: state clearing reseeds its
  closed Help-resident/Web-off baseline, full reset and missing-home recovery use the Expert template, and
  failed preset-state setup restores the exact state moved into recovery.
- Stopping a chat or Fieldwork now cancels an in-progress meaning lookup instead of waiting for its local timeout.
  A canceled, failed, or unsaved chat no longer leaves its attachments available to later agent tools, and model
  or reasoning-effort changes wait until a running Fieldwork has finished so its recorded model stays truthful.
- Reply provenance keeps the full bounded lexical selection plus meaning seats, preserves distinct revisions of
  one memory, batches exact-memory lookups at the server limit, and exposes full hashes and root read edges in
  keyboard-accessible disclosures instead of hover-only text.
- Bracket-only authored roots are no longer mistaken for untouched templates. New-agent light tool modes are
  saved before later setup can fail, and the final-step note now stays immediately before the user-tail voice root.
- The mood note near the start of every request said when the mood was set to the minute ("set 7 minutes
  ago"), so its words changed every turn and the model had to re-read the whole conversation instead of
  reusing its cached prompt. It now says so in coarse steps ("within the last hour", "2 days ago"). On a
  2,000-token synthetic conversation with local `qwen3.5:4b`, the next turn's prompt took about 1,100 ms
  to process before and 145–203 ms after, and the saving grows with longer conversations.
- The Windows launcher test no longer fails where `NoDefaultCurrentDirectoryInExePath` is set.

### Security

- Meaning-vector caches and embedding replies are byte-, count- and dimension-bounded; cached vectors must be
  finite and normalized, response indices must be exact, and endpoint/model/space changes rebuild rather than
  silently mixing incompatible embeddings. The space probe is a compatibility check, not service attestation.
- The optional web reader now validates every DNS answer and pins the chosen public numeric address to the actual
  HTTP(S) connection, repeating the check for each redirect; canonical IPv4-mapped IPv6 private addresses are refused.
- Malformed model and bridge secret-store JSON now fails with a generic parse error instead of letting a runtime
  parser include credential source text in startup diagnostics.
- Launcher settings, model and bridge secret stores, and room bearer files are read through bounded, no-follow,
  identity-checked handles so links, replacements, and oversized local files fail closed.
- The main first-run instructions now identify the launch URL fragment as the room's local password and explain
  when the plain loopback address is safe to reuse.
- Known audited documentation and test fixtures now use synthetic agent names, paths, portraits, and shelf prose
  rather than the private-derived examples they replaced.
- Every Telegram and Discord reply or proactive send requires an exact-route durable delivery coordinator and
  uses a durable preflight plus, when allowed, attempt and settlement receipts; uncertain or partially accepted
  sends are not retried automatically.
- The packaged-release gate rejects known Fieldwork configuration and secret paths, currently configured
  API/bot/room credential values, runtime state, and Git metadata. It requires every bundled font, licence copy,
  and reviewed Églantine file to be present and non-empty; checks every accepted relative Markdown link inside the
  extracted archive; and exercises first-time setup from that archive. It cannot recognize an unrelated credential
  hidden in an otherwise allowed file, so candidate inspection remains required.
