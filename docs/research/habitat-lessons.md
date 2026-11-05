# Habitat lessons carried into public Fieldwork

This is a sanitized architecture audit, not a copy of a private agent home. A mature private Fieldwork
installation was used to identify mechanisms worth keeping; every public claim below is re-checked against
public source and synthetic tests. No private profile, transcript, account identifier, destination, token,
asset, fixture, or configuration is part of this document or the test suite.

## Persona and continuity audit

| Lesson | Public Fieldwork status | Evidence and remaining edge |
|---|---|---|
| Identity is ordered, inspectable input rather than a hidden prompt | Implemented | `profile.json` declares every root; `src/profile.mjs` checks the order and hashes the exact bytes. |
| Durable identity and last-mile voice need different placements | Implemented | System roots precede assembled context; user-tail roots are attached to the newest user turn by `src/root-context.mjs`. |
| A root change should affect the next reply | Implemented for room edits | The root editor reloads the profile after a conflict-checked, versioned save. An edit made directly on disk while the room is running still needs a restart; per-run disk refresh is a remaining hardening task. |
| Long-context compaction should sound like the agent remembering, not an observer reporting on it | Implemented | `src/conversation-context.mjs` gives the compactor the live roots, requires first person, rejects an outside-observer result once, and records the perspective in its receipt. |
| Compression must not replace the record | Implemented | The append-only conversation archive keeps exact turns; carried memory is derived state, and relevant exact older turns can be reopened into a bounded prompt. |
| Raw history is the retrieval baseline, not merely backup material | Implemented foundation | Exact archived turns and source-attributed lexical search exist. [RAW-RAG evidence](raw-history-retrieval.md) motivates a source-preserving semantic candidate-and-rerank path; that path and its synthetic coverage benchmark remain unimplemented. |
| Memory is evidence with provenance, not fluent biography | Implemented | `src/provenance.mjs` separates authored memory, observations, retrieved evidence and lossy summaries; revisions and retractions remain in `src/memory-ledger.mjs`. |
| Memory needs clocks as well as contents | Implemented | `src/memory-lifecycle.mjs` distinguishes facts, possibilities, reminders, chosen obligations and verdicts; delayed or expired records leave ordinary recall and automatic context without leaving history, and due review is explicit rather than silent renewal. |
| Persistence is the courtesy of returning | Implemented | The profile keeps a durable name, the notebook outlives a session, and check-ins can reopen contact. A distinct goal/promise register now keeps chooser or beneficiary, exact source, review or return clocks, status and attributed history without inferring commitments from ordinary prose. |
| Automatic memory must be small, relevant and measurable | Implemented foundation | `src/memory-foreground.mjs` selects a bounded current set against the newest message and exposes selection and omission receipts. Matching is lexical, plus an optional meaning seat. |
| Meaning gets a seat, not a vote | Implemented (opt-in) | The predecessor found that blending an embedding ranking into keyword ranking lowered recall, while one separate seat for the best meaning match raised it. `src/meaning-recall.mjs` follows that shape with a local model, a similarity floor and a text-free receipt. |
| Agents must not share roots, state or presentation accidentally | Implemented | The supervised registry gives each agent a separate home; switching closes the current room before opening the other, and model/appearance preferences live in that agent's state. |
| Retrieved material and message origin must remain visible as metadata | Implemented foundation | Run receipts, memory sources, `src/message-origin.mjs`, the per-reply disclosure, and Telegram route sidecars preserve the path without placing provenance prose inside the message or provider prompt. |

## Control-room audit

| Wanted capability | Status |
|---|---|
| Restart the running harness without erasing it | Implemented: the top-bar restart is supervised and preserves the room address and state. |
| Set the whole installation or one agent back to zero | Implemented: clear-state and full-agent reset are separate, confirmation-gated, and recovery-backed. |
| Restore an earlier state or whole agent | Implemented: discovered copies are selected by opaque ID, staged, byte-verified and left intact. |
| Multiple agents, switching, renaming and directory relocation | Implemented. |
| Carry a whole agent to another Fieldwork installation | Implemented: a versioned, bounded and hashed directory bundle excludes Fieldwork-managed credentials, recovery copies and live bridge bindings; import verifies it and registers a dormant agent. |
| Search a comprehensive settings surface | Implemented foundation: Settings categories are locally searchable by task words, including Telegram and Discord bridge controls. |
| Choose a model service and enter an API key in the room | Implemented: a supervised, write-only key path stores the secret outside agent homes and restarts cleanly. |
| Edit identity, relationships and voice | Implemented: named roots are editable, versioned, conflict-checked and reversible. |
| Agent and person icons | Implemented. |
| Agent-set display pronouns | Implemented: the agent can set or clear only its own room value; familiar sets inflect Fieldwork-authored UI copy with verb agreement, explicit uncommon forms are supported, ambiguous labels fall back to “the agent,” and profile roots remain unchanged. |
| Moods and user-described custom emoji | Implemented; the agent can select a supplied mood and make a bounded number of its own. |
| Let the agent rewrite selected house/tool guides in its own voice | Implemented: checkbox selection becomes a short-lived, single-use capability; writes are ID-scoped, attributed, versioned, conflict-checked and reversible, while prose cannot grant tools or accounts. |
| Local check-ins while the person is away | Implemented, including quiet hours, quiet outcomes, postcards and optional agent-started Fieldworks. |
| Taskless free time with legitimate silence | Implemented as a manual unstructured visit; quiet creates no conversation or check-in-history row, while lasting changes remain inspectable. |
| Named task heartbeats with legitimate no-change | Implemented: each durable watch has a cadence, exact tool-name allow-list, meaningful-change and completion rules, expiring claim fence, structured outcome, retained receipts and reversible definition history. Runs are transcriptless; an optional goal-measure binding fixes the register tools to one stable record and measure, while arbitrary argument binding for other tools remains future work. |
| Long-term goals, explicit promises and honest measures | Implemented: a separate durable register preserves chooser or beneficiary, exact source, review or return window, conflict-checked definition/status history and legitimate retirement. Declared measures retain raw observed/no-change/no-data checks and compute statistics only from named-source samples with per-measure edges. A task heartbeat can bind the public read/record tools to one exact record and measure with server-injected identifiers. |
| Search the complete conversation record | Implemented as an opt-in memory-kit tool with verified, source-attributed excerpts and cursor pagination; results remain evidence, not memory. |
| Explain how each reply got there | Implemented for local replies through message disclosures and run receipts; bridged user turns also expose their literal route. |
| Discord and Telegram bridges | Narrow text transports implemented for one exact route and allowed person per platform. |
| Deliver check-ins through a bridge | Implemented only after explicit destination selection and an exact saved bridge binding; the local reply is saved first, and connection alone grants no unsolicited-delivery authority. |

## Invariants for the public bridge layer

The private predecessor made the failure modes concrete. A public bridge should carry these mechanisms,
reimplemented against synthetic fixtures:

1. **Transport state is not conversation state.** Disconnecting a bot must not delete the transcript; a
   saved conversation may be rebound deliberately.
2. **Tokens are write-only supervisor secrets.** They do not belong in agent homes, browser storage,
   receipts, exports, URLs, logs, or ordinary settings.
3. **A destination is an allowlist, not a suggestion.** Platform, account, user, chat/channel and scope are
   validated before listening or sending. Group/channel listening needs an explicit acknowledgement.
4. **Reconnect is visible.** Saved, connecting, connected, paused and failed are distinct states with a
   bounded error receipt. Restart recovery reports each attempted connection.
5. **Old traffic is not a new invitation.** Initial connection records the platform cursor and does not
   answer backlog. Redelivery is deduplicated by platform message ID.
6. **Every message keeps its route and delivery state.** Incoming and outgoing records retain platform,
   destination and source message identifiers as metadata; rendered prose stays literal. Outgoing state keeps
   refusal, rejection, partial acknowledgement, complete API acknowledgement and uncertainty distinct.
7. **Retries stop before visible output.** A provider transport failure may be retried only before a response
   or external action begins, preventing duplicate replies.
8. **Retuning need not sever transport.** A connected conversation can change its model for the next turn
   without dropping the listener or losing conversation identity.
9. **Bridge check-ins are a separate grant.** Local check-ins do not silently begin messaging a phone; each
   destination must opt in, respect quiet hours, and serialize with ordinary replies.
10. **Attachments cross a hostile boundary.** Type comes from downloaded bytes, sizes and hosts are bounded,
    and no platform URL or file name becomes trusted instruction text.

The Telegram and Discord text bridges now satisfy items 1-6, 8 and 9 at their documented boundaries. Platform
sends are never retried after an uncertain visible outcome. Item 9 requires an explicit per-conversation
proactive-delivery choice and reuses the bridge's ordinary serialization and quiet-hour boundary. Items 7 and 10
remain deliberately unimplemented.
