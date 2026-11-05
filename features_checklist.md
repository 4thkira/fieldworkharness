# Fieldwork: what it does and what's next

Nov 3, 2026

Fieldwork is a free home for an AI companion that runs on your own computer. You write who your agent is; Fieldwork keeps its memories, its belongings and its history honest and in your hands. Below is everything it can do today, then what is coming.

## Your agent's home

Each agent lives in an ordinary folder on your computer that you own, can open, and can back up.

- **Who it is, in plain files.** Three short notes, “identity”, “relationships” and “voice”, say who your agent is, who it knows and how it talks. You edit them right in the room, and the newest 50 replaced versions of each note remain available to restore.
- **Starts blank.** A new agent has no personality, accounts or add-ons until you give them.
- **Several separate agent homes.** Make, rename, switch between or move agents from Settings. Each keeps its own memories, chats, files and look.
- **Backups before anything drastic.** Clearing or resetting an agent first saves a recovery copy, and you can restore an old copy later.
- **Easy start and stop.** Double-click to start; a short set of questions the first time. Stop and restart buttons in the corner, and a guided tour (the ? button) that explains each part of the room.

## Talking with it

You chat in a page in your web browser that only your own computer can reach.

- **Saved conversations** in a sidebar, searchable and renameable by title, with a dot when your agent wrote while you were away. Archive one to move it into a small collapsed list; Restore brings it back without losing its messages.
- **Replies appear as they are written.** Your message shows at once, a little animation plays while the agent thinks (it can pick its own words and faces for it), and the answer streams in word by word when the selected service streams; otherwise the completed answer appears at once.
- **Nicely formatted messages:** headings, bold, lists, quotes, code, tables and links.
- **Pictures and text files.** Attach with the paperclip, drag them in, or paste a picture. Models that can see pictures look at them; you can preview attached files.
- **A compact continuity fold** under each reply adopts the agent's pronouns and marks the current turn, root files, memories actually offered, and tools actually called. Expand it for visible steps and exact input edges: current and carried conversation, root-file versions, temporary room notes, memories offered or omitted and why, and the tool schemas available on each model step. Its receipt survives a restart without entering the conversation itself, and it never pretends to expose hidden reasoning or sentence-level causes.
- **Several model connections:** use a local service (Ollama, LM Studio), a hosted one (OpenRouter, OpenAI), or your ChatGPT subscription. Provider feature support varies; switch among models offered by the active service from the top of the chat without restarting, and choose an explicit reasoning effort where the model/service supports one.
- **Your own touches:** names, icons and pronouns for you and your agent; colour themes and optional dither;
  nine display fonts; five text scales; line spacing and message width; one-column or alternating messages;
  portrait visibility; and independently sized, reordered or hidden navigator and inspector panels. These
  choices persist per agent, and the topbar Settings control always remains available to restore a panel.

## Memory

Your agent remembers on purpose, and every memory says where it came from.

- **It writes things down itself:** facts, possibilities, reminders, explicitly chosen obligations and
  evidence-backed verdicts, with tools you choose to give it. Memories can wait until a date, come due for
  review, or expire without being erased.
- **Sources stay attached.** “I saw this”, “someone told me” and “this is a summary” are kept as different kinds of memory, never blended.
- **Corrections never erase.** Revising or forgetting a memory keeps its history, so you can see what changed.
- **Relevant memories come along automatically** when they match what you just said, with a note of what was picked and what was left out.
- **Search the exact conversation record:** when you grant the memory tools, the agent can search exact words across whole saved conversations. Results are paged, source-attributed excerpts and do not silently become memories.
- **Dates it understands:** “what did we talk about yesterday?” prefers memories written that day.
- **Long conversations keep their record and continuity cues.** The full chat stays in the archive; when it grows too long for one model prompt, older parts become fallible first-person notes and a few lexically relevant exact turns can return beside the recent conversation.
- **The Memory tab** separates what is current, what is due for review and full history, including scheduled,
  expired, corrected, superseded and retracted records.

## On its own

Your agent can do things while you are busy or away, always within limits you set.

- **Fieldworks:** give it a question or task and a number of steps; it works on it in the background. You read the write-up, see every step it took, and can bring it into a chat to talk it over.
- **Check-ins:** if you switch them on, it writes to you on its own, as often as you choose, never in your quiet hours, and only when it has something to say. If it has nothing, it stays quiet and nothing is sent.
- **Per-conversation automatic check-ins:** stop scheduled local visits from returning to one conversation without archiving it or muting direct chat and bridge replies. The choice survives restart, has exact State & history inspection and Undo, and manual Check in/Postcard/Free time still works.
- **Task heartbeats:** name one task to revisit, choose an exact tool list and cadence, say what counts as a meaningful change and what finishes it, then inspect, run, pause, edit, remove or restore it. Every run keeps a receipt; “no change” produces no message.
- **Outside reader:** schedule a clean, read-only second look over 1–24 exact goals or promises. It receives only those stable record IDs, keeps source edges and evidence references, and may report no findings; review leads never change the source or count as proof.
- **Free time without an assignment:** “Free time now” opens an unstructured visit with no task and no expected output. If the agent stays quiet, no conversation or check-in-history entry is made; lasting changes still keep their normal receipts.
- **A daily postcard:** a short note about its day at a time you pick.
- **Fieldworks of its own:** you can let it start a small Fieldwork during a check-in, to look into something it is curious about.
- **Its own rest:** your agent can set its own quiet hours or take a break of up to three days. The room will not wake it then, shows a 🌙 resting sign, and records nothing about that time. You can still write to it, and “Check in now” asks before knocking.

## Being itself

Your agent has room to make the place its own, and supported room-managed changes keep attributed history and restore controls.

- **Moods:** it picks how it feels from moods you set up, each with a colour, shown at the top of the room. It can also invent a few moods of its own, and you can share your own mood with it. Its current mood and yours stay separate, with exact attributed history and conflict-safe Undo back to an earlier choice or no choice.
- **Custom emoji:** upload little pictures and say what each one means; your agent uses them in its replies.
- **Thinking lines:** the words and faces shown while it is thinking are its choice.
- **Pronouns and portrait:** it can choose the pronouns shown beside its name, and make a picture you sent it its portrait. Up to 12 recent portraits are kept, and the chat offers Undo.
- **Its own wording:** you can invite it to rewrite how the room explains its tools, in its own voice. Up to 20 earlier versions of each guide remain available to restore.
- **A shelf:** a little gallery where it keeps pictures and files it wants to show or keep safe. Taking something down keeps it; only you can delete for good.
- **Collections:** little databases it builds and searches (plants, recipes, a dream log), kept as plain files in its notebook. The newest ten previous versions are retained; removed entries are moved aside instead of deleted. Current, historical and removed Markdown can be inspected and exported exactly, and fingerprint-fenced Restore never consumes the selected recovery copy.
- **A notebook:** a folder of its own for notes and files.

## You stay in charge

Capabilities begin with explicit setup choices, and supported room-managed changes keep inspectable history.

- **State & history:** one searchable page filters current room state and retained changes by text, kind and
  author. It includes conversation titles, archive status and automatic-check-in policy, identity, expression (including mood definitions and both current selections), guides, roots, check-ins, tool
  availability and explicit execution policies, shelf items, model, reasoning effort and appearance; implicit Always defaults remain
  visible on the Tools page without filling the general ledger.
  Inspect opens exact values, export keeps them, and conflict-safe Undo records itself. Memory remains in its
  hash-chained ledger and opens directly from this page rather than being duplicated. Your agent can inspect
  the same room-state log by exact key.
- **Contextual tool groups:** make a group Resident, On demand or Off per agent, and see roughly how much its schemas cost. Ordinary chats, bridge turns, check-ins and Fieldworks get a compact catalogue of every installed group; on-demand schemas load only after the agent asks and only for that run, while Off cannot be loaded. A brand-new agent starts light (Collections, Shelf, Moods & expression, Self & room and Other on demand); existing agents keep their modes.
- **A last step in words:** on the last step of a reply, a one-line room note tells the agent that tools can't run any more, so it answers with what it has. The note shows in "How it got there" and is never saved into the conversation. If the agent still reaches for a tool, the room says it ran out of steps.
- **Blank-roots notice:** while identity, relationships or voice still hold only the template's bracketed instructions, Health and the empty conversation say so, with a pointer to the worked example in `docs/writing-roots.md`.
- **Memory by meaning (optional):** with the `meaning` kit, automatic memory gives one extra seat to the saved memory closest in meaning to your message, using a small embedding model on this computer. It only adds above a similarity floor, never pushes out a word match, and the reply's fold says "close in meaning to the message".
- **Per-tool execution permission:** availability only decides what can be offered. Ask, Always or Never separately
  decides whether each configurable tool may run. Ask refuses the current call; a one-time choice permits only the
  next exact retry with the same tool, argument fingerprint, safe summary and origin, expires after 15 minutes and
  never resumes automatically. Unattended routes refuse Ask without leaving a pending choice. Internal room controls
  remain outside this person-policy list; removed or reclassified tools retire their old policies into history.
  Explicit policies also appear in State & history with exact inspection, export and conflict-safe Undo. Undoing
  back to an untouched default removes the explicit policy instead of manufacturing an explicit Always. Requests,
  one-time grants, decisions and execution paths stay in the dedicated Tools history without exposing raw arguments
  or results.
- **Nothing switches itself on.** Each tool kit is off until you name it, and files on disk never activate anything.
- **Local durable state by default.** Agent homes, receipts and room state stay on your computer. Complete prompts and tool results go to the model service you configure, and bridge content goes to a platform only when you configure that bridge. Credentials saved through Settings live in separate ignored launcher files, never in the agent's folder, browser storage or receipts; optional environment fallbacks remain in the launcher process or user environment instead.
- **Honest receipts:** every reply records which steps ran and which tools were used, without storing hidden reasoning.

## Beyond the room

You can also talk to your agent from Telegram or Discord, carefully fenced.

- **One exact person, one exact place:** each bridge answers only the person you name, in the chat or channel you name, and only when mentioned in groups.
- **The same conversation:** bridged messages continue a saved chat, marked with where they came from.
- **Tokens kept apart:** bot tokens saved through Settings live in a separate ignored launcher file and are never shown again after saving; an environment fallback remains in the launcher environment instead, and software with your account authority can read either source.
- **Interrupted delivery stays honest:** a durable marker separates replies that were prepared but never attempted
  from replies that may have reached the platform. Settings shows the unresolved receipts without message text;
  you can abandon a definitely unsent reply or acknowledge an attempted one as uncertain. Neither action resends it.

## To do

The next five are small and mostly came from agents themselves; the larger safety work follows.

**Next up**

- [x] **“This is broken”:** a way for the agent to send its builder a note when something in the room is not working. *(review suggestion)*
- [x] **“Your model changed”:** a short note the agent receives after its model is switched, so it knows instead of pretending nothing happened. *(review suggestion)*
- [x] **Free time:** a check-in with no task and no expected output; a quiet visit adds no conversation or check-in-history entry. *(review suggestion)*
- [x] **Search everything said:** let the agent search exact wording across whole past conversations, not only what it wrote down, so it can check the record instead of relying on fallible recall. *(review suggestion)*
- [x] **“What could it see?”:** for each reply, show exactly what the agent was given: its files, the memories offered and why, and what was left out for space. *(review suggestion)*

**Soon**

- [ ] **Safe recovery** when work is interrupted: check what happened instead of guessing, and never repeat an action
  automatically. Telegram and Discord mark a durable attempt edge immediately before the first send and offer
  fingerprint-checked operator resolution without automatic resend. In-run tools now default to tracked: an exact
  tool-and-arguments fence is prepared and armed before executor entry, returned effects close only after the owning
  chat or scheduled receipt is saved, and Settings → Tools offers no Retry—only state-valid, revision-checked person
  acknowledgements. The ledger survives restart, switching, backup, and restore. Bridge settlement v2 now binds each
  accepted message ID to the prepared chunk hash and exact destination returned by the platform API, while replaying
  older v1 receipts without inventing that evidence. The Windows dependency bootstrap now uses the same guarded,
  identity-checked stale-lock recovery rather than guessing from a loose PID file. Platform-history reconciliation,
  destination idempotency, and other host actions outside model runs remain.
- [x] **Ask before acting:** each configurable in-run tool has a durable, per-agent Ask / Always / Never policy;
  tools without an explicit policy default to Always for compatibility. Ask saves a bounded safe summary and refuses
  that call. Allow once binds the next retry to the same tool, arguments fingerprint, summary and origin, expires in
  15 minutes, is consumed once, and never resumes work automatically. Unattended runs refuse Ask without creating a
  pending trap, while internal harness controls are excluded. Permission history and run receipts separate the ask,
  decision and attempted execution. This is an execution gate, not proof of effect or recovery: launcher/setup actions
  outside model runs are not covered, and the atomic JSON store assumes one room writer rather than providing a
  cross-process lock.
- [x] **Time-aware notes and expiring verdicts:** memories distinguish facts, tentative possibilities, reminders, explicitly chosen obligations and current verdicts. Exact “do not resurface before,” review and expiry clocks are fingerprinted and revisioned; verdicts require evidence, change criteria and a review or expiry edge. Ordinary recall and automatic context exclude delayed and expired influence, while the agent's due-review tool and the room's Due/History views keep every clock and earlier revision inspectable. *(review suggestion)*
- [ ] **Pre-flight refusal:** external actions can require explicit, inspectable checks such as resolved identities, absolute dates, a named time zone and destination-specific text before anything is sent. Telegram and Discord replies now establish the shared durable gate: their constructors require an exact-route Fieldwork delivery coordinator, with no untracked direct-send fallback; exact route, content, saved-reply binding and chunk-plan checks are recorded before transport, with refusal, rejection, partial acknowledgement and uncertainty kept distinct. Publisher-specific identity, clock and prose rules remain. *(review suggestion)*
- [x] **Claim tokens for queued work:** one wake claims an item before acting, so overlapping schedules cannot cheerfully do the same thing twice. Scheduled and manual check-ins/postcards, Task heartbeats and outside readers save a 15-minute token before model or tool work and finish only with that exact token. Every persistent mutation of those queue stores takes a short cooperative cross-process transaction lock, rereads the latest disk state through the store's existing loader, then atomically saves; cooperating Fieldwork processes on one computer therefore cannot both claim the same edge or erase unrelated fresh updates. Expiry leaves `claim-expired`; heartbeat and outside-reader expiry defer the next edge by a full cadence. General in-run tool effects keep their separate attempt/outcome fence and recovery inbox. At startup, a separate exclusive recovery guard, exact schema/token/file-identity rechecks and same-directory quarantine allow only a well-formed lock whose recorded PID is absent on this computer to be removed; live, malformed, replaced and unverifiable locks remain with actionable advice. Neither boundary makes provider requests or destination delivery exactly once, cross-machine use of one agent home is unsupported because locks carry no host identity, and a noncooperating same-authority writer can bypass the protocol. *(review suggestion)*
- [x] **Quiet at conversation size:** each conversation has an independent, append-only allow/suppress policy for scheduled local check-ins. Suppression neither archives the record nor mutes direct browser/Telegram/Discord replies; manual visits bypass it, archive/restore preserves it, and State & history can inspect and undo it. If every active conversation is suppressed, no new claim or model call occurs and the still-due wake is not consumed. An already-expired crash claim is still reaped into its honest history receipt without claiming a replacement. This is deliberately separate from a check-in's `[quiet]` (“nothing today”) outcome and does not grant outbound bridge delivery. *(review suggestion)*
- [x] **A freshness edge per source:** each conversation source keeps its own exact observed-through edge; each root records when its exact race-checked bytes finished loading without changing the stable content fingerprint; and each memory search records the exact durable ledger head its index ranked. Memory inspection and the collapsed reply-input disclosure show those boundaries separately, path-free, and say when an edge was not recorded instead of borrowing one shared “now.” *(review suggestion)*
- [x] **Read after writing:** persistent agent writes have a scoped live reader: exact memory id, notebook path,
  collection entry, shelf id, room-change key or builder-note record. Memory inspection includes the current
  fingerprinted record, active/retracted state and an optional bounded revision lineage. *(review suggestion)*
- [x] **Long-term goals and a promise register with honest measures:** goals and explicit promises now have a
  separate durable register rather than being inferred from reminders or tentative possibilities. A goal retains who
  chose it, its exact source, success signals and review date; a promise retains its beneficiary, exact source and
  chosen return window. Both have conflict-checked revisions, attributed history, pause/resume, evidence-backed
  finish, honest retirement/abandonment, recoverable removal, restoration, exact inspection and export. Optional
  numeric measures name their source before collection; raw observed samples, no-change edges and no-data reasons are
  retained, and statistics are derived only from those samples with one observed-through edge per measure. Task
  heartbeats can receive the register's explicit read/record tools for scheduled collection, or optionally bind them
  to one exact measure by stable `recordId` and `measureKey`. Bound runs receive source-specific read/record schemas
  whose identifiers are injected by the server rather than chosen by the model. Standalone heartbeats remain the
  default, and binding never silently synchronizes the heartbeat and register item's lifecycles. *(review suggestion)*
- [x] **An outside reader on a schedule:** an optional clean reviewer reads only 1–24 exact goals or promises
  selected by stable ID; future records are never swept in automatically. It uses the room's current model connection
  without agent roots, current chat, room tools or source-write authority. Source-unchanged wakes skip the provider;
  reviewed runs distinguish no findings, structured evidence-linked review leads, and visible failure. The corpus is
  never silently truncated, findings are explicitly not proof, and no result changes a source record or acts for its
  author. Definitions, retained versions, receipts and findings are inspectable and exportable; edits are
  conflict-checked and removal is recoverable. Each run claims before it starts; expiry records `claim-expired` and
  schedules the next active edge one full cadence from reap time. *(review suggestion)*
- [x] **Task heartbeats:** a named, task-specific watch distinct from the room’s open-ended social check-in.
  Each durable definition names the task, cadence, exact room tools, meaningful-change rule and completion rule.
  Runs are transcriptless, must use one structured verdict, and keep a receipt even when the result is “no change”
  and no message. Settings can inspect exact values and retained versions, export them, run now, pause, edit,
  restore earlier text, remove recoverably or restore paused. Claims expire after 15 minutes rather than becoming
  haunted work; expiry records `claim-expired` and schedules the next active edge one full cadence from reap time.
  Tool selection is code-enforced. An optional goal-or-promise measure binding additionally fixes the
  register read/record tools to one stable `recordId` and `measureKey` with server-injected identifiers; ordinary
  standalone definitions and independent lifecycle controls remain unchanged. *(review suggestion)*
- [ ] **Meaning-based retrieval over raw history and memory:** find “sad” when the exact conversation said
  “blue,” rerank source-preserving candidates, and reopen complete source turns with dates, speakers and receipts.
  Keep exact search beside it, name how every result was found, and make transformed-memory additions beat the
  raw-history baseline in a synthetic coverage and dependency-path benchmark. Compare bounded model-directed
  Markdown navigation too: model families may benefit differently, but this does not imply unrestricted shell or
  host-filesystem access. *(Bao et al., RAW-RAG; review suggestion)*
- [ ] **Per-person notes:** what the agent thinks of each person, changing slowly over time. *(review suggestion)*
- [x] **Continue the bound Fieldwork conversation before a Telegram or Discord reply:** every accepted bridge turn
  loads the route's complete saved Fieldwork conversation through the same bounded context pipeline as browser chat.
  Recent turns remain verbatim; older turns may be carried as receipt-backed first-person compaction and bounded
  exact recovery. Route metadata stays inspectable in the archive but out of model prompts. This does not fetch
  arbitrary native platform history or stopped-time backlog. Changing the destination, allowed person, scope, or
  Discord server starts a new conversation rather than handing the former route's context to a newly allowed account.
  The supervised room serializes first binding, rechecks the complete route identity and refuses a different binding
  it observes; this is not a cross-process compare-and-set. A failed local save remains visibly live-but-unsaved and
  retries only that idempotent save on status refresh or before a later message, never the reply transport.
  *(review suggestion)*
- [x] **Check-in messages delivered to Telegram or Discord:** Check-ins default to the room and may explicitly
  select one platform. Scheduled and manual visits use only that connected bridge's exact durably saved active
  conversation; a missing, unsaved, archived or suppressed target stops before unattended model work and does not
  consume the scheduled edge. A kept reply is saved locally first, then destination and full route identity are
  rechecked before a proactive delivery bound to the saved reply's conversation, message and content hashes. Quiet
  and free-time visits stay local. Refusal, rejection, partial acceptance, uncertainty and receipt-write failure
  remain distinct; the local reply survives and no uncertain send is retried automatically.
- [x] Rename conversations from the room heading; names are append-only archive events.
- [x] Archive and restore conversations without rewriting their messages; status changes are revisioned, attributed, inspectable and undoable.
- [ ] Permanently delete conversations.
- [ ] PDFs and documents as attachments.
- [x] Change installed tool-group residency without restarting. A saved Resident / On demand / Off mode changes new runs immediately.
  Ordinary chat, bridges, check-ins and Fieldworks receive a compact catalogue and next-step load/unload controls;
  each provider step keeps one frozen registry, transient loads reset after the run, and Off stays impossible to
  load. Task heartbeats retain their exact selected tools, and undo restores the complete mode map.
- [ ] Web page screenshots for Fieldworks.

**Later**

- [x] Export and import a whole agent without Fieldwork-managed passwords or keys. The active home becomes a
  versioned directory bundle with a bounded, hashed manifest; recovery copies, room credentials and live bridge
  bindings stay behind. Credential-like files or bytes matching a current Fieldwork API key, bot token or room
  bearer refuse the export. Import rechecks every path, byte count and hash, then registers a separate dormant
  agent without switching to it. Fieldwork cannot identify an unrelated secret manually written into an ordinary
  note, so a bundle still needs human review before it is shared.
- [ ] A safer home for add-ons: each says what it can reach, runs separately, and shows what changed when updated.
- [ ] Optional outside tools (MCP), held to the same rules as built-in ones.
- [ ] Budgets for time, model usage and repeated actions. An exact tracked tool and canonical-input digest may now
  enter its executor at most twice in one run; a third attempt is visibly refused before another effect record or
  executor entry. Different inputs and read-only inspection remain available. Time, provider-usage, cross-run and
  destination-level budgets remain.
- [x] **Closed-page check-ins:** automatic local check-ins and postcards belong to the running room process, not
  page JavaScript, so they continue with every browser tab closed. Reopening the room reveals the saved result.
  Fieldwork itself must remain running; stopped or sleeping time is not replayed as a backlog.
- [ ] Replay a past reply with another model, with all actions simulated.
- [ ] More than one Fieldwork at a time.
- [ ] For fun: a mood tint at the edge of the room, a dedicated visual mood timeline, a mood dot on each message, and stickers the agent draws itself.

**Not building, on purpose**

- A “fully autonomous” mode switched on by default.
- A raw command-line tool that can do anything on your computer.
- Memory that rewrites itself silently.
- Sending private chats to cloud tracing services.
- An add-on store before add-ons are safely separated.
- Automatic retries before actions are safe to recover.
- Requiring a scheduled or autonomous visit to invent output when “no change” is the honest result.
- A personality Fieldwork supplies or requires the agent to perform; durable, testable habits belong in the room, while identity and voice belong to the agent and person.
- Calling a soft restriction a “sandbox”.
- Swarms of agents as a headline feature.
