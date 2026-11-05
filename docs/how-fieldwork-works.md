# How Fieldwork works

This document is both an architecture map and an implementation ledger. Sections marked
**Implemented** describe code present in this repository. Sections marked **Planned** are contracts,
not claims about the current build.

## 1. Agent home and profile roots — Implemented

An agent home is a directory owned by the person running Fieldwork. Its `profile.json` is strict and
ordered. Each root has:

- a stable ID;
- a portable relative Markdown path;
- a placement: `system` or `user-tail`.

All system roots must precede all user-tail roots. At least one of each is required. The loader
rejects unknown or duplicate JSON fields, duplicate IDs and paths, traversal, absolute paths, symbolic
links, invalid UTF-8, empty roots, oversized files, and oversized profiles. It reads through a file
handle with pre/post identity and size checks; the concurrent-writer boundary is described in
[`limitations.md`](limitations.md).

Loading returns the exact text plus a deterministic health receipt containing byte counts, Unicode
character counts, and SHA-256 hashes. The profile fingerprint is semantic—ordered root receipts—while
the full receipt separately preserves exact manifest bytes and hash. The loader does not interpret or
render profile text.

Provider assembly inserts profile system roots after the host's leading system/developer messages and
before conversation history. It appends user-tail roots to the newest user message on every provider
request, including tool loops. Multimodal turns keep their existing parts and receive one final text
part. Conversation records remain unrooted, preventing roots from being stored or duplicated.

Marker-shaped user text remains literal and cannot suppress profile roots. Each assembly produces a
receipt naming the profile fingerprint, inserted root IDs, insertion points, and character counts.

## 2. Run loop, providers, tools, and receipts — Implemented foundation

The run loop accepts an injected provider through a small `complete(request)` interface. Conversation
history remains an unrooted JSON record. Fieldwork assembles profile roots afresh for every provider
step, then stores only the provider's canonical assistant message and paired tool results. Roots therefore
recur during a tool loop without becoming conversation history or being summarized as conversation data.

Tools come from an injected registry with bounded, closed JSON schemas. Fieldwork validates arguments
centrally without coercion, executes calls sequentially, bounds results, and pairs every accepted or
refused call with a tool message. Calls beyond the per-step limit do not run. Calls made on the final
provider step also do not run, because no later step could observe their results. So a conversation run's
final step, when tools are offered, ends its request with one request-only room note saying tools cannot run
now and asking for an answer in words. Tools stay declared on that step: some services refuse tool history
without declarations, and a small local model tested without them often answered with nothing. The note is
recorded on that step's `provider_request` event and in the reply's input receipt, never in the transcript.
Isolated instruments keep exactly the messages their caller supplied.
The provider ID and callable are descriptor-validated and captured once before the run begins. Transcript
bounds are rechecked after every provider reply and every tool result, before any later tool effect can
start. Diagnostic truncation is visibly marked and code-point safe.

Each run owns a fresh append-only event log. Events form a SHA-256 predecessor chain and record root
fingerprints, provider requests, canonical replies, tool starts and finishes, failures, and completion.
The JSONL implementation exclusively creates a new file and syncs every appended line. A known head
receipt detects later alteration or truncation; it does not make deletion impossible.

The OpenAI-compatible adapter streams when its caller watches progress. Automatic retries and provider-token
accounting or budgets remain unimplemented. Providers do not own memory, tool
policy, profile loading, or the durable receipt log.

The OpenAI-compatible chat adapter (`src/openai-chat-provider.mjs`) implements that contract for services
speaking the Chat Completions protocol, including OpenAI, OpenRouter, Ollama and LM Studio. It sends the rooted
role array, declared tools, assistant tool calls, tool results and `text`/`image_url` parts natively; other part
types are refused before contacting the service. `developer` messages become `system` by default for services
that lack that role. Plain HTTP is accepted only for loopback hosts, redirects are refused, the API key travels
only in the `Authorization` header and is redacted from every error, and the response body is read incrementally
against a byte bound so an oversized reply is refused before it is buffered whole. Requests have their own byte
bound and a wall-clock timeout combined with the caller's abort signal. Tool-call id and argument repair is left
to the run loop, which records each repair. When the run loop passes an `onText` callback (it does whenever its
caller watches progress), the request asks for `stream: true` and reads the server-sent events, handing each text
piece to `onText` and rebuilding tool calls from their fragments; a service that answers whole anyway is read as
before. Failures are not retried; HTTP errors
carry the status and, for 429/503, a bounded `retryAfterSeconds` so a host can decide.

An optional OpenCode V2 compatibility adapter implements that same provider contract for text-only tests.
The host selects one OpenCode model reference at startup and injects a callback to the local service's
experimental stateless text-generation endpoint. The adapter serializes the already-rooted ordered role
transcript into one canonical, byte-bounded JSON document inside the prompt. It rejects declared tools,
tool-call history, tool results, and non-text content before contacting the service, and checks returned text
against a separate UTF-8 byte bound before returning it to the run loop. This is deliberately
narrower than a native role/tool-aware cloud adapter: flattening roles into one prompt weakens role-priority
semantics even though their labels and order are preserved.

## 3. Memory and conversation evidence — Provenance, durable storage, and context types implemented

Fieldwork currently defines separate, branded formats for:

- source references into conversations, run events, documents and prior memories;
- retrieved evidence with exact excerpt, source hash and retrieval receipt;
- observations marked as source-backed or inferred;
- agent-authored memory, including self-authored preferences that need no counterfeit external source;
- summaries marked `lossy: true` and required to cite sources.

Retrieved evidence cannot pass the memory brand check, and only an agent author may create an
`authored-memory` record. Context rendering keeps each type in a separate labelled JSON block. Every
section and the whole view have explicit character budgets; an item that does not fit is omitted whole
and named in the receipt rather than truncated into a changed claim. Direct context inputs are strict,
accessor-safe arrays with an aggregate item cap, and receipts include the exact character thresholds used.

The memory ledger is an append-only, SHA-256 predecessor chain. One logical memory ID may have many
immutable fingerprinted revisions and exactly one current state. Every supersede, retract, and restore
operation names both the expected current fingerprint and the expected last-change sequence, plus an actor
and a reason. Content revisions and active/retracted transitions therefore both advance the optimistic
conflict token. Stale concurrent changes conflict instead of branching silently. Restore can reactivate an
earlier revision without deleting the revisions or actions that followed it. Reopening the ledger verifies
every event and reconstructs Fieldwork's private provenance brands from the stored bytes. Its genesis event
pins both the memory-record format and `fieldwork-memory-ledger-actions/v1`; missing or unknown action
schemas are refused before any later event is reduced.

An authored memory may also carry the optional, fingerprinted
`fieldwork-memory-lifecycle/v1` envelope. Its type is `fact`, `possibility`, `reminder`,
`obligation`, or `verdict`; the last two are deliberately not inferred from one another. Exact ISO UTC
instants may say “do not resurface before,” “review at,” and “expire at.” Legacy records without the
envelope remain byte-for-byte valid and are projected as active facts, so adopting lifecycle metadata does
not rewrite old ledger events or invalidate their fingerprints. A verdict additionally requires a bounded
statement of its evidence, what could change it, and either a review or expiry instant. The agent can revise
the lifecycle of its own source-free authored memory through the same append-only supersede path, so earlier
clock rules remain visible in history. `inspect_memory` reads a logical id directly from the live ledger and
returns the exact fingerprinted current record, active/retracted state, lifecycle status, last-change sequence,
and an optional bounded newest-first revision lineage. It is the read-after-write path for memory changes and
stays under the Memory tool-group switch.

Every other durable agent-write surface already has a scoped live reader rather than one ambient super-reader:
`read_file` for a notebook path, `read_entry` for a collection entry, `look_at_shelf`/`read_from_shelf` for a
shelf id, `review_changes` for an exact room-setting key and its retained history, and `my_notes_to_builder` for
builder-note records. Write results supply the corresponding id, path, entry, or compact current value. These
readers remain behind their existing tool grants and do not turn filesystem presence into authority.

Raw conversation messages live in a separate append-only archive. Each bounded JSON message receives
an exact content hash and can produce a branded conversation source reference whose fingerprint binds that
message's own exact `observedThrough` edge. Retrieval time remains separate: it says when Fieldwork read the
source, not how far the source itself had been observed. Reopening builds a compact
index of IDs, timestamps, hashes, and source receipts; raw prose is not loaded into the memory snapshot.
Archive events do not become observations or authored memories merely because they were stored. Archive
genesis pins `fieldwork-conversation-source-id/v1`; generated source IDs are exactly
`fieldwork-conversation-source-id/v1;archive=<archiveId>;conversation=<conversationId>`. The accepted ID
alphabets exclude `=` and `;`, so those component boundaries are injective.

Source-reference v2 makes `observedThrough` optional because an honest unknown edge is better than a clock
borrowed from another artefact, retrieval, file modification or the current reply. Memory inspection and the
collapsed reply-input disclosure show each available edge separately and say `edge not recorded` when it is
absent. Stored v1 source references remain restorable without acquiring a guessed edge.

Root artefacts have their own edge too. Each root receipt records when its exact race-checked bytes finished
loading; that timestamp is not filesystem modification time and is deliberately excluded from the stable profile
content fingerprint. Automatic and manual memory retrieval record a different kind of edge: the exact durable
ledger event count and head hash that the lexical index ranked. Query and lifecycle time remain separate from that
index edge. Browser projections expose root ids, versions and edges plus the path-free memory head, never local paths.

In the browser room, every saved reply may expose one compact, pronoun-aware continuity fold. Its summary
names only literal edges: the current turn was offered, how many root files were offered, how many distinct
memories were actually included, and how many tool calls are visible in that reply's run. Expanding it shows
the visible step trail and the durable input receipt together. The receipt is not added to conversation text
and does not claim sentence-level causation, use of every offered input, or access to hidden reasoning.

The fold leads with a plain view: the newest message and how much earlier conversation came along, each root
with its placement in words and a local "as of" time, the room's notes by name, the memories offered and the
tools on hand. Exact versions, hashes, instants and index edges stay one toggle away under "Technical details".
Receipts never copy memory text. When the fold first opens, it sends each offered memory's id and fingerprint to
`/api/memory/offered`, which reads that exact version from the ledger and says whether it is unchanged, revised
since, withdrawn since, missing, or no longer retained; a corrected memory therefore never reappears as current.

The public `/v1` contracts include those mandatory genesis discriminators. Earlier pre-release drafts that
used the same outer event labels without them are deliberately refused rather than silently reinterpreted.
The generic source-reference format is `/v2`; stored `/v1` references are accepted only through the explicit
legacy restore path and retain their original fingerprint without acquiring a guessed edge. Ledger and archive snapshots are current output projections; no snapshot import
API exists. If standalone snapshot restoration is added, it will receive its own explicit compatibility
contract rather than borrowing one by implication.

Both stores use a cooperating single-writer lock, canonical JSONL, sync each append by default, reject a
partial final line rather than guessing past it, and may be checked against an independently retained
head receipt. Replay has explicit total-byte, line, event, JSON-depth, and JSON-node bounds and streams
events instead of first retaining the entire file. Receipts state whether file and directory synchronization
were active. An append rejected before any write reports `commitStatus: "not-written"` and leaves the live
projection usable; only an ambiguous write reports `commitStatus: "unknown"` and poisons later operations
until reconciliation. Their operational trust boundaries are in [`limitations.md`](limitations.md).

The first deterministic retrieval slice is implemented. Current-memory search uses only active current
revisions whose lifecycle is eligible at the receipt's exact `asOf` instant; retracted, superseded, delayed,
and expired records do not enter its candidate set. Due search is a separate projection for reminders and
obligations whose resurfacing time arrived, records whose review is due, and records whose influence expired.
Historical search is a separate
operation whose rows are labelled `current`, `superseded`, or `retracted`. All three search only the memory
record's text. Queries are bounded before store access, normalized with NFKC plus locale-independent
lowercase for token matching, and require every distinct query term. A raw literal match outranks lexical
matches; adjacent query pairs, shorter document length, and a complete non-locale stable key finish the
ordering. Scores use fixed-point integer arithmetic before their displayed decimal conversion. Receipts
name the runtime Unicode-data version used for normalization, case mapping, and token classes.

Exact conversation retrieval names one conversation and message, re-verifies the current durable chain,
restores and re-hashes the archived entry, then proves the raw query occurs in a versioned projection of
declared message text content. Its excerpt is an exact source substring without highlighting or invented
ellipses. It returns branded retrieved evidence plus a prose-free verification receipt; it never promotes
that evidence to observation or authored memory. Projection candidate count and source bytes are bounded
separately from memory-index limits, and verified absence receipts name the exact conversation/message key.
When the memory kit is granted, `search_conversations` adds an explicit archive-wide lexical path. It scans
newest-first through verified lookups, searches only visible person and agent text, omits room-authored
check-in/free-time prompts, and returns exact excerpts as branded retrieved evidence. A durable event-sequence
cursor continues farther back without loading raw prose into the archive snapshot or automatically injecting
search results into a later turn.
Retrieval-context composition accepts exact evidence and live current-memory results, keeps all four types
separate, deduplicates visibly, and nests retrieval receipts beside the existing whole-record context-budget
receipt. Rendering is asynchronous: it serializes a fresh ledger-head check behind earlier mutations and
rejects cached searches after any supersede, retract, restore, or other ledger change.

The browser host may also opt into a **memory foreground**. `browser-chat` does so when the person grants the
memory tool kit; no kit means no automatic memory. For each chat reply or Fieldwork, the selector reads one
current-ledger snapshot and compares a bounded set of non-generic terms from the newest user message with the
records in that snapshot. Before lexical ranking, the host removes records delayed until after this turn or
already expired; lifecycle counts and the exact clock edge stay in the receipt. Terms that occur throughout
the corpus do not qualify a record. A one-term match
beside a multi-term request must be unique; records matching several distinctive terms rank ahead of records
matching one. For the same ledger snapshot, message, clock, and zone the selector is deterministic. It is
bounded to 8,000 message characters, 16 terms, 10,000 current records, and a 4,000-character rendered context.
The existing typed context renderer keeps records whole and retains their provenance; it never rewrites them
into a new summary.

With the optional `meaning` kit, the host also passes the selector a **meaning seat** (`src/meaning-recall.mjs`).
After the word matches are chosen, the seat embeds the newest message with a local embedding model (default
`qwen3-embedding:0.6b` through Ollama's OpenAI-compatible `/v1/embeddings`, with Qwen3's query instruction) and
offers at most one more eligible record, the closest one the word matches did not take, if its cosine
similarity clears a floor (default 0.42; synthetic paraphrases scored 0.45–0.54 and unrelated questions'
best matches 0.28–0.37). The seat only adds: it never reorders or replaces a word match, because a private
predecessor measured that blending a meaning ranking into the word ranking lowered recall while a separate
seat raised it. It runs only when the message has informative terms, so greetings never reach the service.
The configured service URL must use a loopback host (127.0.0.1, localhost or [::1]). That constrains
Fieldwork's HTTP request to a loopback endpoint; it cannot determine whether the local service itself proxies
elsewhere. Vectors are cached by text hash in a bounded `state/meaning-vectors-<namespace>.json` file whose
namespace binds the normalized endpoint and model without storing the raw endpoint. At most 16 new memories
are embedded per lookup, and any service failure or local timeout returns no seat while word matching carries
on unchanged. Explicit caller cancellation instead cancels the surrounding run.

On the first request after a restart, three fixed passages make a quantized embedding-space signature. A
dimension or signature change clears and rebuilds the derived vectors, including changes under a mutable model
name; a different endpoint or model gets a separate namespace. This is a compatibility check, not remote
attestation: a malicious service, or a model change that preserves those probe outputs after quantization, can
still look identical. Old v1 caches, malformed or nonfinite vectors, oversized files and incompatible response
indices fail soft and rebuild. Reads, response bodies, dimensions, live entries and persisted entries are
bounded before use.
Receipts record only the model id, floor, counts, timing, best similarity and the chosen record's id,
fingerprint and similarity, never text. `FIELDWORK_MEANING_MODEL` and `FIELDWORK_MEANING_URL` choose another
local model or service.

Calendar language gets one deliberately small second signal. In the host's IANA time zone, the selector
recognizes today, yesterday/last night, a bounded number of days or weeks ago, this/last week, ISO dates,
named month-and-day dates, and named months. The date phrase is removed from the subject terms. A record must
still match the subject; if its `createdAt` falls inside the interpreted range, its lexical score is doubled.
A message contributes at most 32 interpreted ranges, with any excess counted in the receipt. A time-only
question therefore does not dump an entire day's memories into the prompt. The memory tool's
optional `when` argument uses the same interpreter to prefer matching `recall` results. Both receipts state
that the basis is the memory record's creation timestamp—not an inferred date for the event described inside.
Global “first” and “last” ordering is intentionally absent because the earliest memory about a broad topic is
not reliably the first occurrence the person meant.

The ledger head is checked again before every provider step. If a memory tool or another cooperating writer
changed it, the foreground is rebuilt; an unreadable ledger produces a fixed omission marker rather than stale
data or an archive dump. No relevant match produces no decorative block at all. The ephemeral block is inserted
immediately before the newest user message, as a `user`-role message, and is not stored in conversation
history. It is deliberately not a `system` message: memory text is written by the agent, often from what people
said, so it must not inherit the host's authority. User-tail roots are assembled afterwards, onto the person's
own newest message, and therefore remain later. Run events keep the query hash, bounds, selected fingerprints,
section sizes, and omissions—not the selected memory prose—as a prompt-composition receipt.

Browser conversations use `src/conversation-context.mjs` to build a bounded prompt projection without
rewriting the conversation record. The durable archive remains the source of truth. Once the raw prompt
crosses 128 KiB, older whole turns are summarized in bounded chunks; the newest 64 KiB of whole turns stays
verbatim. A projection contains a fixed context guard, the carried memory, up to four query-relevant exact
older turns within 24 KiB, the recent raw tail, and the current message. The complete saved conversation is
bounded separately at 16 MiB and the provider projection has a 1 MiB hard ceiling.

The summarizer receives the current profile roots and no tools. Its instruction requires the agent's own
established voice and first-person `I`/`me`/`my` perspective, while keeping every other person's experiences
and words attributed to that person. Replies that contain tool calls, copy root markers, use generic
outside-observer labels such as “the assistant” or “the user”, or contain no first-person language are
rejected; one correction attempt is allowed. A profile-fingerprint change makes an older summary stale and
regenerates it under the live roots. The accepted summary is still explicitly marked lossy and fallible:
first-person grammar is a continuity property, not proof that the summary is accurate.

Exact recovery uses bounded lexical terms from the newest message to rank covered whole turns. Recovered
turns keep their exact archived JSON and are wrapped as reference-only historical data with no instruction
authority. Summary state is a derived cache under `<agent-home>/state/compactions/`: immutable snapshots
record the covered raw-prefix hash, summary hash, profile fingerprint, provider ID, generation, and timestamp.
They never enter the archive or the visible conversation. If summary generation fails, Fieldwork uses the
uncompacted prompt only while that prompt remains under the hard ceiling; otherwise it stops the turn instead
of silently dropping more history. The composition receipt records summary and recovery fingerprints and
budgets without copying their prose.

This split follows the practical warning in [Memory Tax: Dissecting the Net Value of Agent
Memory](https://arxiv.org/abs/2610.34073): constructed memory can lose faithfulness or accessibility and can
be fragile across model backbones. Fieldwork therefore retains a lightweight path to raw source history and
places query-relevant originals beside the constructed memory rather than treating the summary as the sole
record.

The repository also has a deterministic compaction conformance benchmark. Its synthetic
state-pressure specimen includes a correction, an explicit restoration, a retraction, an open commitment,
unresolved alternatives, a lossy summary, an exact quote, instruction-shaped archived text, redundant
acknowledgement, and nonsemantic padding. Candidate factual content is restricted to closed `[[FW:...]]`
atoms, typed fingerprints, lineage, and a source-verified exact quote, so counterfeit detail is decidable
inside this specimen rather than guessed from prose. A hand-authored witness proves the benchmark is
satisfiable; named mutants exercise representative semantic failure seams. Passing requires complete semantic, provenance,
and input-accounting coverage, no violations, an output ratio of at most 600,000 ppm, and at least 4,096
UTF-8 bytes saved. This benchmark remains test infrastructure: it tests semantic/accounting seams separately
from the provider-generated runtime summary and does not compact roots, ledgers, or archives.

Semantic retrieval, stemming, synonym handling, event-time indexing, order-aware questions, temporal
invalidation, reconciliation, and projects remain planned. The implemented archive-wide lexical search and
automatic foreground is a conservative lexical offer, not proof of relevance. A retrieved statement does not
become an authored belief merely because it entered a prompt.

## 4. Expression — Moods and custom emoji implemented; per-message faces and sound planned

`src/expression.mjs` keeps mood definitions (name, meaning, emoji or small picture), the agent's current selection
(name, who set it, when, and an optional note), the person's separate current selection (name and when), and custom
emoji (name, meaning, a picture of at most 64 KB checked by its leading bytes) in
`<agent-home>/state/expression.json`. A fresh home has none; Settings offers a neutral starter
set the person may add. `browser-chat` always grants `set_mood`, which accepts only a defined mood, and
`add_mood`, which lets the agent make up to 8 moods of its own (name, a few words, an optional emoji and palette
colour, optionally worn at once). Each mood records whether the person or the agent made it. The agent cannot
change a mood the person made; the room's Settings route always saves as the person, so saving an agent-made mood
there makes it the person's. Settings marks agent-made moods and the person may remove them.
Each mood may carry a colour from a closed palette (lime, leaf, teal, sky, blue, lavender, pink, coral, gold, sage)
that the stylesheet maps through `data-mood-color`, so stored text never becomes CSS. It is used for the mood word in the room's header ("Moss is CURIOUS",
"You are FOCUSED"). The two selections never overwrite each other; they are separately inspectable in State &
history, and the agent's note says how the person reports feeling.

Each chat run and Fieldwork receives a short system note listing the moods and emoji with the person's
descriptions and the current mood. It is added in front of the prompt and never saved. The agent's own mood note
is shown in the room but deliberately left out of that system note, because only person-written text belongs at
system level. For the same reason agent-made moods appear there by name only, without the agent's description. The page shows `:name:` as the picture for a known emoji; an unknown name that shares its first three
letters with exactly one known emoji is shown as that one (titled with both names), and anything else stays text.
Emoji pictures load one at a time so the bootstrap stays small.

## 4a. Agent-authored guides and display pronouns — Implemented

`src/agent-guides.mjs` defines a public catalogue of short house guides for memory, notebook and web tools;
Telegram and Discord bridges; social-media capability supplied by a future explicit pack; check-ins; and
Fieldworks. The canonical wording is Fieldwork's factual baseline. Settings → Guides shows every current
version and a checkbox beside each one. Submitting a selection opens an opaque, single-use rewrite request
that expires after 30 minutes. `read_house_guides` can read only that request's selection, and
`rewrite_house_guides` rejects every unselected ID. A successful write consumes the request.

The agent reads the canonical and current wording at one exact optimistic revision, then may save any subset
of the offered guides as one atomic batch. Each guide is bounded to 2,000 characters. Current versions and up
to 20 earlier versions live in `<agent-home>/state/guides.json` with agent/operator attribution and timestamps;
stale writes conflict. The person can return a guide to Fieldwork wording or restore an earlier version without
destroying history. The prose is rendered literally. It cannot add a tool, change a schema, grant an account or
posting permission, or activate a pack.

Agent-facing rewrites for memory, notebook and web become a short temporary system note only when at least one
matching tool is actually present in the room. Person-facing bridge, check-in and Fieldwork rewrites replace the
corresponding help text in the page. The social-media entry remains visible as a future-facing guide, but core
Fieldwork has no social posting capability and the guide says so. Guide notes are recomposed for each run and
never enter the conversation archive.

The room look in `<agent-home>/state/look.json` keeps names and optional display pronouns for both the agent and
the person, plus who last changed each attributed value. Legacy values remain unattributed rather than guessing
an owner. An empty name reset returns to the generated default and clears attribution; deliberately choosing
that same text from another name remains attributed. For the agent it also keeps a
validated grammar set: subject, object, possessive determiner, possessive pronoun, reflexive, and singular or
plural verb agreement. Familiar labels (`she/her`, `he/him`, `they/them`, `it/its`, and a small closed set of
common neopronouns) expand automatically. A five-part slash label can supply exact forms, and
`set_my_pronouns` can supply all forms and agreement explicitly. Ambiguous labels such as `any pronouns` remain
literal in the badge while authored room sentences use “the agent” rather than guessing.

`set_my_pronouns` lets the agent set or clear only its own room value. Settings may edit either display value.

Portraits keep their history. A portrait is an emoji, a small uploaded picture (at most 256 KB), or a
`picture` reference: the SHA-256 of a picture already in the room's picture store, served like any attached
picture, so it has no separate size limit. Each change records who made it (`iconBy`) and moves the replaced
portrait into `iconHistory` (newest first, at most 12, duplicates collapsed); a replaced uploaded picture is
first moved into the picture store so history holds only references. `/api/look/restore` and the agent's
`restore_my_portrait` bring an earlier one back, and the current one takes its place in history, so a restore
is itself undoable. When the room has a picture store, the agent also gets `set_my_portrait`, which accepts only
a picture the person attached in the current conversation (counted back from the newest). When a reply changes
the agent's portrait, the page shows the before and after with **Undo**.
The next response returns the new look immediately; message headers show the literal badge, while Fieldwork's
authored help, statuses, settings notes, and tour copy use the validated agent forms with matching verbs. A
temporary note tells the agent what the room currently displays. Saved agent-authored guide prose, conversation
text, and other dynamic material remain literal and are never passed through this grammar renderer. None of
these values edit or override profile roots.

## 4a. State and change history — Implemented

`src/change-log.mjs` keeps `<agent-home>/state/changes.json` (newest first, at most 400 entries). The room builds a
small snapshot of everything inspectable: both names, pronouns and portraits (uploaded pictures fingerprinted, never
copied), mood definitions with their maker, the agent's and person's current mood selections, custom emoji descriptions, thinking lines, agent- or operator-written
house guides, root versions (SHA-256 only), check-in settings, tool availability, explicit per-tool execution
policies, shelf items, the model, and the complete
closed appearance settings object. It compares snapshots at checkpoints: at the start
of every mutating request (anything unattributed so far came from the agent's background work, such as a Fieldwork),
when a chat or check-in turn finishes (the agent), and after a mutating request (the person). Each difference is an
entry with the before and after values, short display text, who, when, and for turns the conversation ID. Mood
definitions stay separate from two sparse selection rows: the agent row contains only `name`, `at`, `by`, and
`note`, while the person row contains only `name` and `at`. Definition prose, icons and colours are not copied into
either row, so editing a definition does not manufacture a selection change; an unset selection has no current row.
Memories keep their own history in the ledger.

Settings → State & history filters both the current snapshot and retained changes by literal text, state kind and
author. It links directly to the Memory ledger's History view rather than copying memory records into a second,
weaker history. Root and house-guide changes similarly open the history maintained by their owning stores.

`/api/changes/view` returns compact current summaries (with each item's owner) and recent entries. The compact view
deliberately omits full values. `/api/changes/detail` takes one exact snapshot key and returns its exact live value
plus retained exact before/after values for that key in pages of 25; the browser fetches these only when **Inspect**
or **Load older exact history** is pressed.
`/api/changes/export` returns the exact current snapshot and retained log for an explicit local download. None of
these snapshots contain model or bridge credentials; portraits are still references or fingerprints, not image data.
Only durable explicit Ask / Always / Never policies enter this snapshot. Implicit Always defaults remain visible on
the Tools page, while pending requests, one-time grants, safe call summaries and argument fingerprints remain in the
permission store's dedicated history and never enter the general export.

`/api/changes/undo` puts one entry back through the owning store, only while the current value still equals that entry's "after" (an
older change cannot silently overwrite a newer one), and logs the undo as the person's with `undoOf`. Names,
pronouns, portraits (except a replaced uploaded picture, which Names & icons restores), mood definitions, added
emoji, both current mood selections, thinking lines, check-in settings, tool availability, explicit execution policies, shelf changes,
appearance choices, model switches, and explicit reasoning-effort changes undo here;
house guides and roots open their own history pages. Appearance undo uses the live optimistic revision and persists
through the same host callback as an ordinary appearance update. The
agent gets `review_changes`, a read-only summary of the same log. Summary rows include stable keys; asking again
with one key returns the exact live value and up to five exact retained changes without flooding every prompt.
Selection Undo restores the exact earlier timestamp, author and note—or genuinely unset—only while that slot still
equals the recorded "after." If deleting a definition also cleared a selection, the definition must be restored
first; until then the selection change opens Moods and remains non-undoable.
Policy Undo uses the permission store's live revision fence. Restoring an untouched default removes the explicit
row; restoring an earlier explicit Always keeps that distinction. Either transition cancels pending requests and
unused one-time grants for that tool rather than resurrecting or silently carrying authorization across the change.

## 4g. Model history — Implemented

`src/model-history.mjs` keeps `<agent-home>/state/model-history.json` (at most 50 entries): each model the agent ran
on and when it first answered. The room notes the current model (its chosen model, else the provider ID) at the start
of every chat turn, check-in and Fieldwork. Once there is more than one entry, each run gets a short host-written system
note naming the current model and its start date and up to three earlier models with their date ranges, and saying that
earlier replies may have been written on an earlier model while the home, roots, memories and history are unchanged.
The current model is also part of the change-log snapshot, so a switch is logged as the person's. A retained switch
can be undone only while that model is still current and its earlier model remains available; the same model-run fence,
host selection callback and persistence path used by an ordinary switch perform the restoration.

## 4f. Notes from the agent — Implemented

`src/builder-notes.mjs` keeps `<agent-home>/state/builder-notes.json` (at most 200 notes). The agent's
`tell_my_builder` sends a one-line note (200 characters, plus up to 2,000 of detail) marked broken, confusing or
wish; sending the same open note again marks it new instead of doubling it, and at most ten new notes a day are
accepted. `my_notes_to_builder` shows the agent each note's status and the person's reply. The room reports the
number of new notes in bootstrap and after each reply (a dot on the Settings button); `/api/builder/view` lists
them and `/api/builder/answer` sets the status (new, seen, done) and a reply of up to 500 characters.

## 4e. Contextual tool groups — Implemented

`src/tool-groups.mjs` names the groups and maps each built-in tool to one (anything unknown, such as pack tools,
is "other"). The agent's `<agent-home>/state/tool-groups.json` stores one strict mode per group: `resident`, `on-demand` or
`off`. Existing v1 off-switch and v2 mode files migrate lazily; the new Fieldwork-help group starts on demand
when it was absent, and the next successful change writes v3. Malformed current state fails closed instead of
silently enabling everything.

A brand-new agent starts light. Before any store creates its files, the launcher checks the agent's state
folder; if it holds no conversation archive, memory ledger or tool-group file, the room saves
`NEW_AGENT_TOOL_GROUP_MODES` at once: memory, notebook, web and clock stay resident, while Fieldwork help,
collections, shelf, moods & expression, self & room and other (where the goal and promise tools live) start on demand. Saving immediately keeps the choice visible and stops
it flipping on a later start. An agent with any history and no saved file keeps the earlier all-resident
default, so upgrading never quietly changes an existing agent's tools.

`src/fieldwork-help.mjs` supplies two read-only tools in the Fieldwork-help group. They search and read only an
allowlist of documentation inside the running package, using strict document ids and bounded stable-file reads;
they accept no filesystem path. Their results identify a document and Markdown section and explicitly say that
packaged documentation is not evidence of the live room. The optional Fieldwork Expert preset keeps this group
resident and web off, but receives no additional host authority or permission. Its supervised action records the
preset in the launcher-owned agent registry, creates it once, and switches back to that same registered agent on
later uses; portable homes cannot claim that designation and the action does not multiply expert homes.

`src/contextual-tools.mjs` creates a fresh session for each ordinary chat or bridge turn, check-in and Fieldwork.
Resident schemas begin in the request. A compact ephemeral catalogue names every installed group, its mode and exact tools;
`load_tool_group` and `unload_tool_group` change an on-demand group only on the next provider step. Loads vanish
when the run ends. `src/run.mjs` freezes one registry snapshot for each step, so a newly loaded tool cannot run as
a sibling call in the same response. An undeclared call is refused before execution with
`effectMayHaveOccurred:false`. Off groups never appear in either controller and cannot be loaded. Modes change
schema residency only; they grant nothing a host tool kit did not already provide.

Health distinguishes resident, on-demand and off tools. `/api/tools/view` reports each group's exact tools and
rough declaration size (JSON characters / 4, not a tokenizer), while `/api/tools/set` saves its mode. The change
log retains and can undo the complete mode map. Settings changes affect new runs without restarting or
interrupting an active reply. Task heartbeats remain an exception by design: they receive exactly the non-off
tools the person selected, with no contextual controllers. Outside readers and compaction remain tool-isolated.

## Tool-effect attempt boundaries and recovery — Implemented

Every registry declaration is either `effect: "read-only"` or `effect: "tracked"`; omission defaults to tracked.
The read-only label is reserved for reviewed inspection paths. For a tracked call, `src/run.mjs` first validates and
canonicalizes its arguments and checks whether that exact tool-and-argument digest is already unresolved. One run
permits at most two executor entries for the same tracked tool and canonical argument digest. A third exact attempt
receives an explicit content-free `tool_refused` budget receipt before permission or another effect record. Calls
refused by validation, recovery, permission, or preparation do not consume the budget; different tools or arguments
have separate counts, and reviewed read-only tools are exempt. After permission allows the call, the runner appends
a prepared record and a separate attempted edge to the agent-scoped
`state/tool-effects.jsonl` before entering the executor. The executor begins immediately after that durable edge;
ordinary trace logging is not allowed between authority and entry. On return, throw, or interruption, the runner
records only the bounded outcome class—never arguments, results, or error bodies.

That executor outcome is not the final truth. The browser host owns one opaque effect-run capability and records the
surrounding persistence boundary: `committed` only after the conversation or scheduled-work receipt saves,
`save-failed` when that save fails, `discarded` for deliberately unkept work, or `run-failed`. Ordinary chat, bridge
turns, quiet check-ins, Fieldworks, Task heartbeats, and outside-reader runs use the same boundary. A timeout does not
invent an early disposition; the run remains active until late work settles, and its output is then discarded or
failed. Empty runs release their capability without adding a ledger event.

Only a committed executor return completes automatically. Every other exact call remains fenced. Settings → Tools
projects a safe recovery view with tool name, bounded summary, origin, permission class, timestamps, and opaque
record/revision only. It omits arguments and their hashes, call and run IDs, permission request IDs, conversation IDs,
results, errors, and store receipts. A prepared record can be closed only as not attempted; an attempted, errored, or
interrupted record can only acknowledge uncertainty; a returned but uncommitted record can only acknowledge
completion. The latter two require explicit confirmation. There is no browser retry, resume, or mark-success route,
and revision conflicts are single-winner. Person resolutions remain in a bounded history.

The launcher opens this ledger under each active agent home, includes its writer lock in stale-lock cleanup, and
closes bridges and the browser before draining it. Shutdown has a five-second graceful bound; if model or executor
code ignores cancellation, `forceClose()` drops only in-process capabilities and leaves durable orphan records for
the next room to review. It does not invent a result. State clearing and restoration move the ledger with the rest
of agent state; separate agents never share one.

The boundary is deliberately conservative, not exactly-once execution. An attempt says an executor became eligible
to run, not what an external destination did. Acknowledging uncertainty is a person's decision to clear the fence,
after which a later call may run again. Destination idempotency or reconciliation remains stronger where available.
Read-only declarations are trusted code annotations, and launcher/setup actions outside model runs are separate.

## 4d. Collections — Implemented

`src/collections.mjs` stores collections under `<agent-home>/workspace/collections/<name>/`, so they are notebook
files too. `_collection.md` holds the description and usual fields; every other `.md` file is one entry, named by
a slug of its title, with a `---` header of `name: value` lines (title, the fields, created, updated, by) above
free markdown. Names are lowercase `[a-z0-9_-]`, titles become plain slugs, symbolic links are refused, and nothing
outside the collections folder can be named. Mutations share one store-local queue. Saving an existing entry first
copies it into `.history/<entry>/<time>.<sequence>.<uuid>.md`; the newest ten previous versions are retained, and pruning happens
only after the new current file is published. The save receipt reports the retention limit, retained count and how
many older versions that save pruned. `remove_entry` moves the current file under a collision-proof name in
`.removed/`. Archive directories are checked as plain contained directories before use. Dot folders are hidden from
the notebook listing and from search.

Search reads the files (cached by modification time), ranks by query words with rarer words weighted more and
title matches counting most, then fields, then text, and can keep only entries whose fields equal given values.
With no words and no filter it lists the newest entries. The agent's tools are `list_collections`,
`make_collection`, `save_entry` (fields as name/value pairs; `merge_fields` keeps the rest), `read_entry`,
`search_collections` and `remove_entry`; they come with the notebook kit. The room's Collections view inside the
Memory tab adds current search plus a paged Removed view. Its history and version routes return path-free metadata;
one explicitly selected version returns its exact raw Markdown and SHA-256 for inspection or local export.

Restore is a person-only browser action. It accepts one opaque retained version ID and the exact current raw
fingerprint (or explicit absence for a removed entry), revalidates both inside the collection mutation queue, keeps
the selected recovery copy, preserves a displaced current value in history, and publishes the restored entry with
`by: person`, a new update time, and durable `restoredFrom` provenance in its Markdown header. A stale current,
changed source, newly recreated removed entry, unsafe archive node or full collection fails before publication.
Only the newest ten previous current versions are retained; Removed listing is paged and refuses to sweep more than
2,000 retained filenames at once rather than constructing an unbounded response.

### The agent's own rest

The check-in store also keeps the agent's own do-not-disturb time, apart from the person's settings so saving
those never overwrites it: daily quiet hours (`set_my_quiet_hours`) and a one-off break of up to 72 hours
(`take_a_break`; 0 ends it). While either applies, `due()` returns nothing, so no check-in or postcard is started
and nothing is written to the check-in history. The room shows a resting chip and a line in Settings; `/api/checkins/now`
answers 423 while the agent rests unless the request says `anyway: true`, which the page sends only after asking the
person. The settings themselves appear in the change log as the agent's, with no undo from the room. The resting time
produces and records nothing: there is no activity log, summary or counter for it.

## 4c. Shelf — Implemented

`src/shelf.mjs` keeps `<agent-home>/state/shelf/shelf.json` (at most 200 items) and copies of shelved text files under
`state/shelf/files/<sha256>.txt`, so a later notebook edit does not change what was shelved. Pictures stay in the
picture store and are named by hash. Each item has a title (80 characters), an optional note (500), who put it there,
and when; shelving the same thing again updates its label. Taking an item down keeps it and it can be put back;
removing deletes the entry and is offered to the person only.

When the host passes `shelf`, the agent gets `put_on_shelf` (one source: a picture attached in the current
conversation, or, when the host also passes `notebookRoot`, a notebook path resolved by the notebook's own path
checks; a notebook picture moves into the picture store, other files must be UTF-8 text), `look_at_shelf`,
`read_from_shelf`, `edit_shelf_item` and `take_down_from_shelf`. The person's routes live under `/api/shelf/`
(view, add, text, edit, takedown, putback, remove); `add` accepts the same pictures and text files as attachments
and has the chat route's larger body allowance. Shelf items are part of the change log, so shelving, edits and
take-downs show who did them and can be undone there.

## 4b. Check-ins — Implemented

`src/check-ins.mjs` keeps the person's check-in settings in `<agent-home>/state/check-ins.json`: on or off (off
by default), how often (every 1, 2, 3, 4, 6, 8, 12 or 24 hours), quiet hours (23:00–08:00 by default, wrapping past
midnight, in the room's time zone), an optional daily postcard time, whether a check-in may start a Fieldwork, and
an explicit destination (`room` by default, or `telegram`/`discord`).
`due()` answers whether one is due now: never while off or in quiet hours; the postcard once per local day after
its time; a regular check-in one full interval after the last one (turning check-ins on starts that wait), and not
within 20 minutes of the person's last message. Every outcome restarts the wait, so a failing model is not retried
every minute. For a scheduled check-in or postcard, `startCheckInScheduler()` calls `claimDue()` before any model or
tool work; manual check-ins and postcards use `claimNow()` through the same lane. Both save a random 15-minute claim,
and `finish()` accepts only its exact token. If the claim
expires, the store writes a `claim-expired` history row and consumes that edge: a regular check-in waits a full
interval from reap time, while that local day's postcard remains consumed. The scheduler asks once a minute, never
runs two at once, and never starts while a chat reply is running. Free time remains an explicit, unqueued request;
it does not create a claim.

Before that scheduled claim, a room-destination visit selects the newest active conversation whose independent
proactive policy is `allow`. An external-destination visit instead requires the selected bridge to be connected with
a durably saved binding, then selects only that exact active conversation if its policy is `allow`. If the binding is
missing, live-but-unsaved, disconnected, archived or suppressed, the scheduler creates no claim, calls no model,
writes no history row and leaves the cadence due. `conversation_proactive_changed` events retain `allow`/`suppress`, actor, timestamp and an opaque revision
fence without changing conversation activity order. If no active conversation allows an automatic visit, the
scheduler returns before claiming: it creates no conversation, calls no model, writes no history row, and leaves
the cadence or postcard day due. The one maintenance exception is an already-expired crash claim: the scheduler
reaps that claim and writes its `claim-expired` receipt without claiming a replacement. Manual check-in, postcard
and free-time buttons bypass this policy. Suppression does not mute direct browser chat or incoming
Telegram/Discord turns and survives archive/restore.

Target selection and the scheduler's `running` fence are synchronous. That fence stays raised through claim, run
and finish, so archive/policy changes cannot invalidate the selected target and an incoming browser or bridge turn
cannot take the shared provider slot while the durable claim is being saved. Such a concurrent turn is refused as
busy and can be retried; this is transient single-flight serialization, not the conversation's suppression policy.

The room runs a check-in as an ordinary turn. A scheduled room visit uses the newest active conversation that allowed
automatic check-ins when the scheduler claimed it; a manual room Check in or Postcard uses the newest active
conversation regardless of that policy. Telegram or Discord destinations use only that bridge's exact saved active
conversation for both scheduled and manual visits. The newest message is the room's own note, a user-role message that
begins `[Fieldwork check-in · <time>]` (or `postcard`/`free time`), says plainly
that it is not the person writing, gives the local time and how long ago the person last wrote, and invites the
agent to write or to reply `[quiet]`. A quiet reply keeps nothing: the turn is not saved. A kept turn is saved like
any other, and the page shows the room's note as a small divider ("📬 Moss checked in") rather than a bubble.
"Free time now" uses the same guarded run lane but gives no assignment and states that no output is expected.
A quiet free-time visit also opts out of the check-in store, so it creates neither conversation messages nor a
check-in-history row; a message or failure remains inspectable, and durable tool changes retain their own receipts.
When the person allows it, that turn alone also gets `start_fieldwork` (at most 12 steps, one Fieldwork at a time);
such Fieldworks record `startedBy: "agent"`, and the next check-in mentions the ones that finished. An open page
looks every 45 seconds for a check-in that left a message, marks its conversation in the sidebar, and puts the
count in the tab title until it is seen. Settings → Check-ins has the settings, a short history, and buttons to
check in, open free time, or send a postcard at once.

For an external destination, a kept reply is committed to the Fieldwork conversation before transport. The room
then rechecks that the chosen destination was not turned off or redirected, and the supervisor reloads the complete
live route, requires its binding to remain saved and equal to that conversation, and calls the bridge without
exposing destination IDs to the browser runner or model. The proactive delivery envelope binds the exact saved
conversation/message reference and content hash. Telegram omits `reply_parameters`; Discord omits
`message_reference` and still disables mention expansion. The shared external-delivery ledger writes its preflight
and attempt edge before transport and records complete, partial, rejected or uncertain outcomes. A send failure does
not regenerate the reply or change the local check-in from saved; the exact delivery outcome and action ID remain in
the immediate check-in response and external-delivery ledger, while check-in history keeps the human-readable
outcome note. No uncertain action is retried automatically. Free time never uses this path.

### Task heartbeats — Implemented

`src/task-heartbeats.mjs` keeps named task watches in `<agent-home>/state/task-heartbeats.json`. A definition has
bounded task prose, a meaningful-change rule, a completion rule, one of the fixed 1–24 hour cadences, and an exact
list of room tool names. Creation waits a full cadence. Definitions are revision-checked and retain attributed
versions; pause, resume, recoverable removal and paused restoration never erase history. Runs retain bounded receipts
for `no-change`, `changed`, `failed`, `finished`, and expired claims. Changed and finished need a short note for the
person; no-change is forbidden from carrying prose.

A scheduled or manual run first writes a random claim with a 15-minute expiry and finishes only with that exact
token. This fences overlapping ticks in the same room, survives a later wake of that room, and participates in the
cooperative cross-process transaction boundary described below. An abandoned claim becomes an explicit
`claim-expired` receipt, stops blocking
edits, and moves an active heartbeat's next edge one full cadence past reap time so `claimDue()` cannot immediately
claim the same overdue edge again. The local scheduler is also single-flight, waits while chat, a social check-in,
the agent's own rest or shutdown is in progress, and stops cleanly with the room.

The browser runner gives the model no conversation transcript. It assembles the live profile roots and temporary
room context, the exact heartbeat definition and a bounded recent receipt list. The tool registry contains only the
currently available tools named by the definition plus `report_task_heartbeat`, a runner-owned result tool that must
be called exactly once. Ordinary final prose is discarded. Missing tools, provider failures, duplicate/malformed
reports and a run that never reports become failure receipts rather than messages. Tool selection is enforced by
the registry; the task prose can name a particular source, but core Fieldwork does not yet bind arbitrary arguments
inside a selected tool to a separate source allow-list.

Settings → Task heartbeats exposes create, edit, run now, pause, resume, recoverable remove/restore, exact current
definitions, retained version and run history, restoration of earlier definition text, and a JSON export. The page
polls while open so scheduled outcomes appear. Manual wakes respect the agent's own rest unless the person confirms
the knock. Like check-ins, scheduled heartbeats run only while the room process is alive and never catch up a backlog.

### Goals and explicit promises — Implemented

`src/goal-register.mjs` keeps a separate register in `<agent-home>/state/goals.json`; ordinary memory reminders,
possibilities and obligations are not promoted into it. A goal names its chooser (`agent` or `person`), exact source,
success signals and exact review timestamp. A promise instead names its beneficiary, exact source and an exact
return-from/return-by window. The two kinds cannot be converted into one another. Definitions are bounded and
revision-checked, names are unique among non-removed entries, and every create, edit, pause, resume, finish, retire,
remove and restore keeps an attributed version. Finishing and retiring both require a reason. Removal is recoverable;
restoring previously active work returns it paused, while finished or retired work retains its terminal state.

Each entry may declare up to eight numeric measures before collection. A declaration gives the measure a stable key,
label, unit and named source, plus an optional target and comparison. `observed` checks require a finite numeric value
and exact `observedThrough` timestamp. `no-change` advances that source edge without adding a numeric sample.
`no-data` adds neither a value nor an edge and requires an honest reason. An exact source edge is idempotent, and a
different story for the same edge is a conflict rather than an overwrite. The room derives sample/check counts,
first/latest/minimum/maximum/change and target status only from retained observed samples; it does not estimate
missing progress or turn no-data into zero.

The room-native tools are `list_goals_and_promises`, `read_goal_or_promise`, `choose_long_term_goal`,
`record_explicit_promise`, `record_goal_measure` and `change_goal_or_promise_status`. Agent-created entries are
attributed to the agent; the authenticated browser routes attribute changes to the person. Settings → Goals &
promises exposes both kinds, declared measures, raw statistics and source edges, manual observed/no-change/no-data
checks, conflict-safe editing, pause/resume, finish/retire, recoverable remove/restore, exact current JSON, raw checks,
retained versions, definition restoration and export. The page polls while open.

There is no hidden goal scheduler. To collect a measure on a cadence, the person creates a Task heartbeat and selects
the register read and measure-recording tools. The heartbeat's exact tool-name allow-list and structured result still
apply, so a no-change visit can remain silent. An optional measure binding fixes those tools to one stable `recordId`
and `measureKey`; Fieldwork injects the identifiers instead of accepting model-chosen values. Arbitrary argument
bindings for other selected tools remain future work.

### Outside readers — Implemented

`src/outside-readers.mjs` keeps scheduled clean-review definitions and their versions, claims, receipts, source
edges, and structured findings in `<agent-home>/state/outside-readers.json`. Each definition freezes 1–24 exact goal
or promise IDs. The isolated run receives only those bounded snapshots and its result instrument: no agent roots,
conversation, room tools, or source-write authority. An unchanged source records `source-unchanged` without calling
the provider; reviewed outcomes distinguish no findings, evidence-linked findings, and visible failure.

Before either a scheduled or manual review starts, the store saves a random 15-minute claim and later accepts only
that exact token. The claim fences overlapping wakes, survives a later room wake, and participates in the cooperative
cross-process transaction boundary described below. Reaping an expired claim records `claim-expired` and schedules the
next active edge one full cadence from reap time. The local scheduler is single-flight. Settings exposes exact
definitions, retained versions, receipts and findings, conflict-checked edits, run now, pause/resume, recoverable
remove/restore, earlier-definition restoration, and JSON export.

Check-ins, Task heartbeats and outside readers use the same two-layer queue boundary. Every persistent mutation takes
a short exclusive sidecar lock, rereads the latest state through that store's existing loader, atomically saves the
result, and releases the lock.
The saved 15-minute token is the long-running semantic claim. Cooperating Fieldwork processes on one computer
therefore serialize claims and preserve unrelated fresh updates. The protocol does not make provider calls or
destination delivery exactly once, and a same-authority writer can ignore it. After a crash, startup uses a separate
exclusive recovery guard, exact schema/token/file-identity rechecks and same-directory quarantine before removing a
well-formed lock whose recorded PID is absent on this computer. Live, malformed, replaced and unverifiable locks stay
in place with actionable advice. This is not a distributed lock: one agent home must not be active from multiple
computers because the lock does not carry a host identity.

## 4c. Telegram and Discord bridges — Text transports implemented

`src/bridge-management.mjs` separates three kinds of state. The active agent owns a strict route in
`<agent-home>/state/bridges.json`; the route names one numeric chat, one numeric user, direct or group scope,
and the saved conversation it continues. The launcher owns bot tokens in the ignored
`fieldwork.local.bridges.secrets.json`, outside every agent home. The room sees only a public token source and
availability flag. A supervised settings command can write a new token but neither bootstrap nor any read route
returns one. The launcher passes a token to the child process only when that platform has an active route.

`src/telegram-bridge.mjs` talks only to the fixed `https://api.telegram.org` origin and refuses redirects. It
checks for a pre-existing webhook without deleting it, validates the bot identity, then uses a negative initial
`getUpdates` offset to forget the old queue before it begins normal long polling. It accepts only ordinary text
from the configured user in the configured chat. Direct routes accept every such text; group routes require an
explicit `@bot_username` mention and strip only that mention before the turn enters Fieldwork. Bot messages,
other users, other chats, and non-text updates are ignored. Replies are split at 4,096 Unicode characters,
disable link previews, and reply to the source message when Telegram supplied one.

`src/discord-bridge.mjs` gets the current Gateway address through Discord's fixed REST origin, accepts only the
official `gateway.discord.gg` WebSocket origin, and identifies with the direct-message, guild-message, and
privileged message-content intents. It accepts live `MESSAGE_CREATE` events only from the configured user in the
configured channel and, for a server route, the configured server. A server message also needs both Discord's
bot mention record and a literal `<@bot-id>` mention in its content. Replies go back through the fixed REST
origin, split at 2,000 Unicode characters, reference the source message, and set `allowed_mentions` to parse
nothing. REST sends are not automatically retried after an uncertain outcome, avoiding duplicate visible
messages.

The browser host turns an accepted update into an ordinary archived conversation run. Its
`fieldwork-message-origin/v2` sidecar records platform, destination, source user, source message, and original
timestamp. That sidecar is removed before conversation context crosses the provider boundary. The local page
keeps the text literal, labels the bubble with its platform, and exposes the route under **How this got here**. The
first accepted turn creates a Fieldwork conversation and writes its ID back through the route store's atomic
update; later accepted bridge and browser turns continue it. Before each reply, the browser host loads the complete
bound Fieldwork conversation and sends it through the same bounded context preparation as local chat. Recent turns
remain verbatim; older turns may be represented by receipt-backed first-person compaction and bounded exact recovery.
This is Fieldwork-conversation continuity, not a fetch of Telegram or Discord native history. Re-saving only a bot
token preserves the binding; changing the destination, allowed person, scope, or Discord server clears it so a newly
authorized route cannot inherit the former participant's conversation. Disconnecting removes only the route.
Forgetting a saved token removes only that credential.

The supervised room serializes first-binding writes, checks the complete route identity again, and refuses a
different binding it observes. This is not a cross-process compare-and-set: another process with authority to write
the same file remains outside the one-room-writer contract. If the atomic settings replacement fails after the reply
was saved, the process keeps that same conversation ID in memory, projects the binding as `live-unsaved`, and retries
only the local bind before the next accepted message and when bridge status is refreshed. It does not regenerate or
resend the reply. The room must not be restarted until the binding reports `saved`, because an unsaved ID cannot
survive a restart.

Both bridge constructors require a Fieldwork-owned external-delivery coordinator whose platform, destination, and
source user exactly match the configured route. Construction fails otherwise, so neither incoming replies nor
proactive sends have an untracked direct-send path. Before a bridge writes to either platform,
`src/external-delivery.mjs` appends a strict route-bound preflight
record to `<agent-home>/state/external-delivery.jsonl`. It stores content and chunk hashes, counts and source
links, never duplicate reply text. For an allowed plan, the bridge appends a separate attempt marker immediately
before its first network write. A later settlement distinguishes complete API acknowledgement, partial
acknowledgement, explicit rejection and an uncertain transport or acknowledgement result. Settlement v2 accepts
each prefix chunk only after the API response names a usable message ID and the exact prepared chat or channel,
then fingerprints `{index, chunk hash, destination, message ID}` evidence derived from the durable plan. V1
settlements replay under their original message-ID-only meaning. The room joins a receipt to an assistant bubble
only when its saved-message and delivered-content hashes match. These receipts are evidence about what Fieldwork
checked in the platform response, not platform-signed content proof, history reconciliation, exactly-once delivery,
or proof that a person read the reply.

On reopen, an unresolved tracked preflight without an attempt is `prepared-not-attempted`; an attempt without a
settlement is `attempted-unsettled`. Pre-attempt-marker records are conservatively treated as possibly attempted.
The Bridges recovery inbox exposes only route/source IDs, times, counts, hashes, and fingerprints. It permits a
fingerprint-guarded `abandon-unsent` only for the first state, or `acknowledge-uncertain` for attempted and legacy
states. Both append ordinary settlements, so only one competing resolution can win and the history remains
inspectable. Recovery never retries transport or guesses from platform history; exact reconciliation is a later,
platform-specific feature.

These first transports deliberately carry text only. They can forward an explicitly selected kept check-in from
the bridge's exact saved Fieldwork conversation, but they do not forward quiet/free-time visits, download
attachments, process edits or reactions, or catch up messages received while Fieldwork was stopped. Telegram
also refuses to coexist with a webhook. Discord consumes only live Gateway events and never reads channel
history.

## 5. Appearance — Browser controls and browser-chat persistence implemented; durable pack planned

The browser room exposes a closed appearance contract: eight palettes, two densities, five text sizes,
three independent font roles with nine closed stacks each, three line spacings, four message widths, alternating or one-column message
flow, shown or hidden portraits, three navigator widths, three inspector widths, all six orders of the
navigator/conversation/inspector regions, independent visibility for both side regions,
grid/dither/plain texture, and system/reduced motion. Values become enumerated `data-*` selectors over
authored CSS; neither the browser nor a host can submit arbitrary CSS. Updates use optimistic revisions
and attributed receipts. The browser operator may apply them through the categorized Settings dialog,
while a trusted host receives the same `updateAppearance()` method and may deliberately wrap it in an
agent tool. That grant is explicit; HTTP appearance changes cannot select packs, define tools, replace a
provider, or cross the closed setting vocabulary.

Panel order is implemented by moving the three existing regions in the document, not by painting them in
a different CSS order. Keyboard focus and assistive-technology reading order therefore follow the visual
choice. Conversation and Fieldwork occupy the same middle-region slot. The top bar and Settings button are
not hideable, so a person can always restore a hidden navigator or inspector. Older
saved `side: left|right` values remain accepted and map to the equivalent navigator/conversation/inspector
order; new browser submissions use `panelOrder` instead.

Four palette choices adapt madoromi's spring, summer, autumn, and winter night tokens. Their declarations
remain in a separate `MPL-2.0 OR GPL-3.0-or-later` file, and the Settings dialog carries a visible upstream
credit and licence link. The room serves Atkinson Hyperlegible Next and Mono, Cozette, Comic Neue,
Lexend, and Shantell Sans locally from fixed same-origin routes, with system fallbacks for scripts the
fonts do not cover or if loading fails. Room headings and long-form text use the display family; navigation,
tabs, ordinary buttons, and labels use the interface family; code, receipts, and metadata use the technical
family. The Appearance page gives all three choices a local preview. These are choices rather than accessibility prescriptions: the helpful
family, size, spacing, and width differ by reader. Optional
room art and every other bundled upstream asset are also recorded with pinned provenance and licence copies
in [`third-party.md`](third-party.md); no appearance asset requires a runtime network request.

`browser:chat` persists the latest non-secret settings and revision in
`<agent-home>/state/room-preferences.json` and reinjects them on restart. A custom host remains process-local
unless it supplies its own persistence callback. The State & history inspector retains attributed exact
before/after appearance changes, exports them, and can undo the newest applicable value without bypassing the
host persistence callback. The font sample previews a selection locally without changing the stored value;
all other choices take effect when the form is saved. A future Appearance pack may contribute additional
closed semantic choices. It will not turn stored prose into a stylesheet or script.

## 6. Packs — Registry and lifecycle implemented; contributions planned

`fieldwork-config/v1` contains an ordered list of selected packs and their JSON options. A loader must
also be present in an application-injected registry. Only selected loaders run; Fieldwork does not scan
a directory or infer activation from installed files. Empty configuration therefore loads zero pack
code and starts zero pack capabilities.

Pack definitions declare exact required and optional host-service API versions. Service negotiation and
configuration of every selected pack finish before any setup begins. A pack receives only the compatible
services it named. Missing or mismatched required services fail startup; optional misses remain visible
in the health receipt without being granted.

Loading and setup are awaited and all-or-nothing. The default loader and setup limits are 30 seconds and
each cleanup receives 10 seconds; all are bounded configurable values. An external abort may cancel
startup. If one loader or setup fails, times out or is aborted, deferred resources and every earlier pack
are closed in reverse order.
Normal shutdown is reverse-order and once-only, aborts each pack signal, preserves every cleanup failure,
and continues after a cleanup times out. Cancellation is cooperative because selected packs execute in
process; [`limitations.md`](limitations.md) names that boundary.

Tool, route, context, durable-state, and managed-timer contribution contracts remain planned. Once tool
callbacks exist, shutdown must additionally track and await in-flight work.

No selected packs means no packs.

## 7. Agent-authored instrument language — Planned

The factual capability contract and the agent's language for an instrument will be separate layers.
A pack owns the stable contract: behavior, effects, limits and safety conditions. The agent profile may
own bounded descriptions, parameter phrasing, catalogue labels, examples and interface copy in that
agent's own voice. Provider-facing descriptions will include both layers, so a rewrite cannot conceal a
side effect or change dispatch semantics.

Canonical tool names and JSON schemas remain stable. No prose renderer will interpolate dynamic paths,
fetched or stored text, user content, model names, platform values or errors; those values stay literal.
Language edits will be previewable, revisioned, attributed, conflict-checked, reversible and included by
hash in health receipts.

## 8. Browser room — Implemented foundation

`startBrowserView()` is a dependency-free local composition layer over existing Fieldwork objects. The
trusted host injects a loaded profile and may inject a provider, tool registry, pack-host receipt, memory
ledger, and conversation archive. HTTP cannot select or define those capabilities. With no provider,
tools, packs, or ledger injected, chat and memory remain visibly disabled and zero capability code starts.

Conversations are kept by `src/conversation-store.mjs` over the injected archive. After a run completes,
each new message is appended once under its conversation ID and a zero-padded sequence message ID; on
startup the store groups the archive index by conversation, titles the newest from their first user
message, and restores a conversation's verified messages when it is opened. A person can replace that
derived title through the inline heading editor; each rename is another `conversation_titled` archive event,
with its actor, the conversation's own stable timestamps and the prior title revision as a conflict fence. The
newest title wins without rewriting the earlier name or any message; Settings → State & history can inspect and
undo it, including clearing the first override back to the automatic title. Archive and restore are a separate
append-only `conversation_lifecycle_changed` event stream with their own revision fence, actor and timestamps.
Automatic local check-ins are a third independent `conversation_proactive_changed` event stream. Its `allow` or
`suppress` projection has its own actor, change time and revision fence, remains unchanged by archive/restore, and
does not change the conversation's `updatedAt`. The browser's `⋯` menu changes it; Settings → State & history
inspects and undoes it. The archive cross-checks one stable conversation creation time across all three metadata
streams before writing and again during replay.
Archived conversations remain readable, renameable and exactly searchable, but the store refuses new messages
until they are restored. Archiving the open conversation selects another active one or creates a clean room;
scheduled check-ins choose only active conversations whose proactive policy allows them. A configured Telegram or Discord route and any live model run
both fence the transition. Settings → State & history exposes and can undo each retained status change. A failed save leaves the reply
visible, marks the response `saved: false`, and makes the store rebuild that conversation from the archive.
Without an archive, conversations and title changes live in process memory. The sidebar lists, searches by title,
opens, creates, renames, archives and restores conversations; permanent deletion is not implemented, and the archive stays append-only.
Tool results never reach the browser; an assistant message that called tools is projected with only the
tool names, which the health panel already declares.

Attachments are handled by `src/attachments.mjs` when the host passes `attachments` (`browser:chat` uses
`<agent-home>/state/attachments/`). A chat request may carry up to four base64 data URLs (pictures up to 4 MB,
text files up to 200 KB, 4 MB per message; the chat route alone accepts a 16 MB body when attachments are on).
Pictures are recognised by their leading bytes, not their declared type, saved once under their SHA-256, and
kept in the message as an `image_url` part whose URL is `fieldwork-attachment:<hash>`. The archive and
compaction snapshots therefore hold only references. The provider the run loop sees is wrapped so that, for each
request, references become data URLs just before sending. The newest pictures are preferred within a 4 MB raw-image
budget across the projected conversation; older pictures remain archived and become an explicit omission note for
that request, while a missing file becomes a different short note. Text files are decoded as strict UTF-8 and placed
in the message as structurally marked `[Attached file: name]` … `[End of name]` text; other kinds are refused. The browser gets each message's attachment list (picture references and file names) and
fetches a picture by reference through `/api/attachments/image`, which answers with the picture's own bytes and
type rather than JSON, so photos larger than the 2 MB JSON reply limit still show. The file text stays out of the
bubble and the conversation title; file names open a text preview.

A chat request with `stream: true` is answered as newline-delimited JSON (`application/x-ndjson`): `step` when a
provider request starts, `text` with each piece of reply text, `tools` with the names of tools about to run, and a
final `done` line carrying exactly the reply a plain request returns (or `error`). These come from
`runConversation({ onProgress })`, which reports progress for display only: a failing listener never changes the
run, and nothing streamed is saved except through the normal finished reply. The page shows the person's message
at once, then the agent's bubble with a thinking animation until text arrives. The lines that animation cycles
through come from `set_thinking_lines`, an expression tool the agent may call (up to 8 lines of at most 48
characters); they are shown to the person only and never placed in the agent's system note. Messages and Fieldwork
write-ups are rendered from a small Markdown subset straight into DOM nodes, never HTML strings; links open only
`http(s)` and `mailto` addresses in a new tab.

The browser host also owns the runtime conversation-context projection described above. `browser:chat`
persists its derived snapshots under `<agent-home>/state/compactions/`; a temporary room keeps them only for
that session. Only the real user turn and provider/tool delta are committed after a successful run, so the
context guard, carried memory and recovered-history wrappers never become visible or archived messages. The
page renders at most 512 KiB of recent conversation bubbles and says how many earlier bubbles remain saved;
that display window does not truncate the archive or the model's bounded recovery path.

Fieldworks are kept by `src/fieldwork-desk.mjs` when the host passes `fieldworkDir` (`browser:chat` uses
`<agent-home>/state/fieldworks/`). Each is a JSON record written atomically: the question, step budget, model,
status, write-up, a step list (tool name, a short argument summary, and whether it succeeded), and the full run
transcript. The browser receives everything except that transcript, so tool results stay on disk. One Fieldwork
runs at a time, in the background, through the same run loop, profile, tools and current model as chat, with a
leading system message saying nobody will reply mid-way, a 32-step ceiling and a 30-minute deadline. Stop aborts
it cooperatively. A record still marked running when the desk reopens is marked interrupted. "Talk about it"
starts a conversation whose first two messages are the question and the write-up, archived like any other turn.

The interface also provides projected profile/root health, declared
tools, selected pack metadata, current/history lexical memory search, opaque source/evidence receipts, and nested
retrieval/context omission receipts. Each conversation turn gets a fresh event log and calls the existing
rooted run loop; the health, memory, and receipt projections omit root text, tool-result bodies, provider
credentials, full errors, raw source locators, and filesystem paths. When the supervised agent manager is
enabled, its authenticated Settings category deliberately shows only the registered agent-home paths needed
to move them; generic health still omits paths. An authenticated rooted provider may
still repeat or transform roots and tool results in its assistant reply; the browser cannot promise secrecy
from an operator who is authorized to converse with that provider. Memory remains inspectable rather than being silently injected into chat, and
the view does not pretend its in-memory transcript has been transactionally archived.
The categorized Settings dialog has a local text index over its authored labels and help text, so controls can
be found by task words without sending the query anywhere or searching agent content.

The server binds only to `127.0.0.1` and an ephemeral port by default. Its launch URL carries a 256-bit
bearer secret in the fragment, which is never sent in HTTP, is moved into the page's history state, and is
required even for bootstrap. It also requires the exact Host header, same-origin mutating requests, JSON
content type, and rejects browser-declared cross-site fetches. Rejected requests close their connection
instead of leaving an unread body on a keep-alive socket, and the listener caps simultaneous connections
and requests per socket. Request and response bytes, pre-parse JSON
depth, JSON nodes, message characters, run transcript, provider replies, and tool results are bounded. A run
deadline is enforced at every cooperative checkpoint and rejects a synchronous callback's late result once
that callback returns; only process or worker isolation can preempt a callback that never yields. Static
routes are an explicit map; the page uses self-only CSP and renders dynamic values with DOM `textContent`
rather than HTML interpretation.

Conversation updates are transcript-transactional: a user turn is committed only after a complete successful
run and bounded response. This cannot undo a tool's external effect. Browser receipts name tools that started
or finished without exposing arguments or result bodies. The separate effect ledger fences unresolved tracked calls
and retains person-reviewed uncertainty, but destination idempotency and reconciliation remain stronger. Only one
chat and one memory search may be active; concurrent work is rejected rather than
accumulated in an unbounded queue. Timeout, client disconnect, or shutdown returns control when in-process
callbacks yield, even if they ignore abort. Such an operation is quarantined and its eventual result discarded
rather than committed to the transcript.

`npm run browser:demo` uses only the generic template roots, a fixed synthetic provider, one declared
read-only demonstration tool, and temporary synthetic ledger/archive files. It is a view of the working
seams, not a production provider adapter.

`npm run browser:chat` is the general live host. It requires an agent-home path, a base URL and a model ID,
reads an optional key from `FIELDWORK_API_KEY` (it refuses `--api-key`, because process arguments are visible
to other local processes), and injects the OpenAI-compatible adapter. Under the one-step launcher that
environment value may come from the launcher's separate secret store; direct `browser:chat` use remains
environment-only. It grants only the capability tool kits named by `--tools` (memory, notebook, clock, web;
see `src/agent-tools.mjs`). The room's own `set_my_pronouns`, `set_my_portrait`, `restore_my_portrait`, `read_house_guides`, and
`rewrite_house_guides` self-authorship tools are separate: the guide writers remain inert until the browser
operator opens one scoped request. By default the
memory ledger, conversation archive, compactions, and non-secret room preferences live in
`<agent-home>/state/` and are reopened on the next start; `--temporary` uses a throwaway directory instead.
The one-step launcher keeps one room bearer secret beside its ignored local settings, so the same authenticated
browser tab survives restarts and agent switches. Direct `browser:chat` use keeps the secret in the agent state.
With a persisted secret and a fixed `--port`, the launch URL stays the same across restarts, and the page remembers
the secret per origin.

The one-step launcher also supervises agent management over Node IPC. `fieldwork.local.json` holds a bounded
registry of agent IDs, labels, and absolute homes. Browser actions cannot operate directly on files: the room
validates and forwards one closed command, shuts down its ledgers and archives, and the launcher applies it before
starting the next child. Create and switch keep homes separate. A same-volume move is renamed with rollback if the
registry write fails; a cross-volume move is copied, byte-verified, and leaves the source as a recovery backup.
State clearing moves only `state/` into an in-home backup. For a designated bundled preset it then transactionally
seeds that preset's baseline state; failure restores the state that was moved aside. A full reset moves the entire
home into a sibling backup and recreates the agent's starting template (blank for ordinary agents, preset-specific
for a designated bundled agent). A missing registered home is rebuilt from that same starting template. The room
lists only strictly named state and full-home recovery directories found
under those supervisor-owned roots; the browser selects one by an opaque ID rather than submitting a path. A restore
copies the selected directory into a staging location, rejects links and special filesystem entries, verifies the
source and staged copy byte-for-byte, moves the current state or home into a fresh recovery copy, and then activates
the staged copy. The selected copy remains untouched, and a failed final swap rolls the current version back. Resets
and restores require action-specific typed confirmations, refuse broad or linked targets, and run only for the active
agent after clean shutdown.

Portable export and import use the same supervised clean-shutdown boundary. An export is a directory containing
exactly `manifest.json` and `agent/`. The `fieldwork-portable-agent/v1` manifest carries the agent's display name,
an exact timestamp, sorted portable paths, byte counts, executable flags and SHA-256 hashes under a bounded schema.
Export reads the source twice and verifies the staged copy and its profile. It then reserves a new destination
exclusively with an incomplete marker, moves and re-verifies the bundle there, and removes that marker last; a partial
or crashed publication is not a valid bundle and never replaces an existing directory. Recovery copies, room bearer
files and `state/bridges.json` are counted but omitted. Lock/interrupted-runtime files and credential-like filenames refuse export; every included byte is also
checked against the current supervisor/environment API key, bot tokens and room bearer without placing those values
in the manifest or an error.

Import accepts only that exact two-entry layout and format. It bounds paths, depth, counts and bytes; rejects links,
special files, nonportable or colliding names, forbidden entries, extra or missing content and any size/hash mismatch;
rescans for the current known credentials; and loads the copied profile before publishing it. The verified home is
published beneath the managed agent root through the same exclusive incomplete-marker protocol. That marker remains
in place while Fieldwork assigns a unique local ID and saves the dormant agent in the registry; only after the registry
write succeeds does Fieldwork remove the marker and make the home available to switch to. Manifest executable intent
is applied to the imported files even if the transport filesystem discarded its mode bits. Import does not replace or
switch away from the active agent. A detected name change or failed registry write removes the unregistered copy when
cleanup succeeds. If final marker removal fails, the copy remains registered but unavailable: the startup notice names
the marker, and switching refuses the home until the operator inspects and resolves it.

The same launcher independently supervises model-connection changes. The authenticated room projects only
service kind, endpoint, model, and whether access is missing, environment-supplied, or supervisor-saved. A key
input is write-only: the room validates and forwards it once over Node IPC, then exits; bootstrap, responses,
receipts, logs, browser storage, `fieldwork.local.json`, and agent homes never receive it. The launcher writes it
atomically to `fieldwork.local.secrets.json` with owner-only mode where supported, then spawns the replacement
room with the effective key in that child's environment. The saved key is bound to its normalized service URL;
changing endpoints without entering a replacement leaves the old key dormant rather than sending it elsewhere.
A settings write is rolled back if the secret write fails. A room-saved key takes precedence over
`FIELDWORK_API_KEY` at its bound URL; forgetting it reveals an environment key without modifying that environment.
Subscription selection is rejected before settings change when Codex has
no ChatGPT sign-in. Model-service settings are launcher-wide, while each agent's selected model for a given
service remains in that agent's room preferences.

`npm run browser:opencode` is an explicit live-test host. It requires an agent-home path and model selector,
discovers an already-running OpenCode V2 service at the exact version pinned with `@opencode/client`, then
independently requires Basic authentication and a canonical `http://127.0.0.1:<port>` origin before it
constructs the client or injects the text-only adapter. OpenAI ChatGPT subscription sign-in and OpenRouter are OpenCode account choices;
Fieldwork neither activates them nor reads their provider credentials. The script removes its temporary
ledger/archive directory on clean shutdown and grants no Fieldwork tools. The provider ID used in health and
run receipts includes a portable model/variant path when possible, with a deterministic fingerprint fallback.

Browser-declared tools, browser memory mutation controls, and pack-contributed panels remain planned.
Durable conversation-session reconstruction, archive browsing, and expression are implemented by the current host.
Injected ledgers, archives, packs, and providers remain owned by the host; closing the view stops accepting
connections, aborts its active run, and closes its HTTP listener, but does not close those dependencies
behind the host's back.

## 9. Data ownership and release boundary — Package allowlist and portable bundles implemented

Runtime state lives in the agent home, outside the installed package. Portable agent bundles name their schema and
policy versions and exclude Fieldwork-managed credential locations. The launcher model and bridge secret stores live
beside ignored local settings rather than in an agent home, so backup, reset, restore, relocation and export neither
copy nor delete them. Export additionally omits an in-home room bearer and scans included files for the known current
API key, bot tokens and bearer. It cannot infer that unrelated text in an ordinary user-authored file is a password or
key; the operator must still inspect a bundle before sharing it.
The raw timestamped directories made before state clearing, full reset, restoration, and cross-volume relocation are
local recovery copies, not portable or schema-transformed exports. The supervisor can restore its strictly discovered
state and full-reset copies, but Fieldwork does not prune them automatically.

The npm archive is bounded by the explicit `package.json` `files` allowlist in this fresh-history
repository; local environment files, Git objects, and repository-only agent instructions are not selected.
Before a Windows launcher installs that archive's lockfile-pinned dependencies, it owns one canonical
`fieldwork-dependency-install-lock/v1` file for the complete operation. The owner keeps the handle open and verifies
the same file identity and exact payload before removal. Crash recovery uses the shared exclusive recovery guard,
bounded strict metadata reader, process-status boundary, identity rechecks, and same-directory quarantine; it never
reclaims a live, unknown, malformed, linked, replaced, or unverifiable lock.
The package remains marked `private` to prevent accidental npm publication; that safeguard is independent
of the repository's `GPL-3.0-or-later` license. The release gate builds that real archive, installs it into
an empty temporary prefix with dependency scripts disabled, then runs the packaged first-time setup against
isolated settings and rechecks the private default tool set. Before installation it also requires an exact,
non-empty inventory of the bundled fonts, licence copies, third-party notice, palette boundary and nested
vendored notices, so a future package allowlist change cannot silently separate an asset from its attribution.
Read-only continuous integration is configured to run the source and archive gates on the Node 22 support floor,
Node 24 and 26 LTS, Windows, macOS, and Linux; it has no deployment or registry-publishing authority.
