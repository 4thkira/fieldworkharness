# Current limitations and trust boundaries

Fieldwork should state the edge of each guarantee as plainly as the guarantee itself.

## Agent-home files are local trusted input

The profile loader rejects traversal, absolute paths, nonportable names, static symbolic links and
canonical paths outside the agent home. It opens a file handle, applies pre- and post-read identity and
size checks, and uses `O_NOFOLLOW` where the operating system exposes it.

This is race-resistant validation, not an operating-system sandbox. Node does not expose the same
directory-handle-relative primitives on every supported platform. A malicious process that can rewrite
the agent home concurrently may still be able to win a carefully timed path race. Agent-home permissions
must therefore exclude untrusted local writers while a profile is loading.

## Collection recovery is bounded, not an append-only ledger

Collections are ordinary local Markdown files with a store-local mutation queue, not a cross-process transactional
database. Saving retains the newest ten displaced current values and reports pruning. If the operating system refuses
an older-version deletion, Fieldwork keeps the extra file and then fails closed on inspection or mutation above ten;
fix that local permission problem and archive the surplus file before continuing rather than letting history grow unseen.
Removed entries are retained separately, but inspection refuses to sweep more than 2,000 removed filenames at once.
Restore fingerprints the exact selected and current bytes, preserves the selected recovery copy, and publishes with
an atomic rename. These checks prevent stale writes inside one cooperating room; another process with filesystem
permission can still race or alter the files, and the operation will fail closed when the changed bytes are observed.

## Packs are selected trusted code

Configuration and service negotiation follow least authority, but a selected pack executes JavaScript in
the Fieldwork process. Setup and cleanup waits have time limits, receive abort signals, and roll back
registered resources. They cannot forcibly interrupt a CPU-bound loop or reclaim a resource a pack opened
without returning or registering a cleanup. Code requiring hostile-code isolation belongs in a separate
process or sandbox, not in the pack lifecycle.

## Durable logs have a cooperating writer boundary

The memory, conversation, reply-context, external-delivery and tool-effect logs create a sidecar writer lock
before opening their JSONL file. This prevents two cooperating Fieldwork processes from appending competing
successors. It is not an operating-system mandatory lock: another process with filesystem permission can
ignore it and alter the file. A crash may leave a stale lock. At startup, the launcher removes a known,
canonical lock only under a separate exclusive recovery guard, after exact token/file-identity rechecks,
same-directory quarantine, and evidence that the recorded PID is absent on this computer. Live, malformed,
replaced and unverifiable locks remain for inspection. The lock contains an owner token, process ID, and
creation time; it has no host identity, so this recovery boundary does not support one active agent home
shared across computers.

Locks are pathname-based. A trusted, exclusively writable parent directory and absence of hard-link aliases
remain requirements: two aliases for one inode can have different sidecar names, and a hostile local writer
can ignore, replace, or race a sidecar. Fieldwork checks a lock's inode before removal and opens existing
logs without create semantics, but this is still cooperative locking rather than an OS sandbox.

Each append is synced by default. Parent-directory entries are also synced where the operating system
supports it. Receipts expose both choices; opting out of file sync weakens crash durability. A crash can
still leave a partial final filesystem write, so reopen requires every event to end in a complete newline
and refuses to truncate or infer a torn tail.

Failures detected before the first write byte—such as event, clock, line, or total-size rejection—return
`commitStatus: "not-written"` and do not poison the writer. That status does not cover a failure from the
write/sync/stat sequence itself.

A complete line can also reach storage immediately before `write()` or `sync()` reports failure. No
filesystem API can truthfully convert that into “definitely committed” or “definitely absent.” Fieldwork
marks this as an **unknown commit outcome**, poisons live projections, and returns both the prior head and
candidate event receipt. The store must be closed and reopened against the independently retained prior
head before retrying. Recovery uses that receipt or a reviewed backup; it never guesses.

## Hash chains detect; they do not prevent

Run events, memory-ledger events, and conversation-archive events include predecessor hashes. A separately
retained head receipt can detect altered, reordered or truncated events. The chain cannot prevent deletion,
and a log plus a replacement head can be forged by an actor who controls both. Backups or an external
receipt store supply the independent witness.

## Context and memory remain bounded views

The current run loop bounds transcript, reply, tool-call and tool-result JSON. Memory context also has
whole-record character budgets. Retrieval bounds raw and normalized query size, token count, candidate
count, source/index bytes, index tokens, result count, and context-composition input before rendering.
The optional automatic memory foreground adds its own message, term, corpus, source-byte, index-token,
selection, section, and total-character limits. Provider-token accounting and budgets are not implemented;
the OpenAI-compatible adapter can stream text but these character and byte limits are not token limits.
Character counts, lexical terms and JSON bytes are not provider token counts.

Runtime conversation compaction is a lossy, provider-generated prompt projection, not a semantic guarantee.
Fieldwork requires first-person language under the current profile roots, but that check cannot prove that the
model preserved every fact, captured the agent's style well, or attributed every ambiguous pronoun correctly.
It may also vary with the provider that generated it. The summary is marked fallible, its source-prefix hash
is recorded, and a profile change invalidates it; switching models does not automatically rewrite it.
Query-relevant exact turns and the recent raw tail are stronger evidence, while the append-only transcript is
the source of truth.

Raw recovery is deliberately lexical. It can miss paraphrases, synonyms, misspellings, concepts expressed
only in images or tool results, and a relevant turn that exceeds the recovery byte budget. It selects at most
four covered whole turns within 24 KiB and never splices an over-budget turn. The saved conversation stops at
16 MiB, the projected prompt at 1 MiB, and summary generation at eight bounded chunks per update. If both
compaction and the bounded raw fallback fail, the new user turn is not committed.

The test suite's compaction benchmark is not a general semantic verifier. Its completeness claim is bounded
to one deterministic synthetic specimen and its closed factual atoms, typed fingerprints, exact quote, and
accounting envelope. The hand-authored witness is a satisfiability proof, not a compaction algorithm. The
reported ratio measures canonical UTF-8 JSON bytes, not provider tokens, recall on arbitrary prose, or
runtime memory quality.

Current lexical retrieval is deliberately narrow. It is conjunctive, searches memory-record text only, and
does not understand synonyms, morphology, spelling variants, negation, quoted falsehoods, or words such as
“latest.” Historical search is explicit and cannot be fed into retrieval-context composition. Exact
conversation retrieval requires a known conversation and message ID. The optional memory kit adds
`search_conversations`, but it is an on-demand newest-first scan rather than an index: it matches a literal
phrase or all normalized query words, can be slow on a very large archive, and returns bounded pages that the
agent must continue with the supplied event-sequence cursor. It searches only visible person/agent string
content or strict `{type:"text", text}` parts; room-authored check-in/free-time prompts, tools and system
messages are excluded. Malformed declared text is refused or skipped rather than treated as ordinary speech.
Exact means the canonical JSON value retained by the archive, not unavailable pre-archive wire bytes.

The automatic memory foreground is a separate, opt-in lexical heuristic. It removes a fixed set of generic
English terms, measures the remaining terms against the current ledger, and rejects terms common across that
corpus. This improves precision for direct subject-word overlap, but it is not a semantic search. It can miss
paraphrases and morphology, and a distinctive shared word can still select a memory that is beside the point.
Its context preamble therefore preserves type and provenance and says that the records are not automatically
beliefs or instructions. Failure or a changing ledger yields less context with a fixed marker; it never falls
back to the complete ledger.

Date awareness is about **record creation time**, not automatically about the event in the prose. Relative
days and named dates use the host's local IANA time zone and handle daylight-saving day lengths, but a memory
written today about an event last year still counts as written today. Date cues only boost records that also
match subject words; a time-only foreground request adds nothing. `recall` likewise accepts a separate `when`
phrase and marks which returned rows match it rather than hiding nonmatching lexical results. “First” and
“last” are not interpreted because global oldest/newest ordering can answer a different question from the one
the person meant.

Lifecycle dates are strict UTC instants supplied by the caller; Fieldwork does not guess them from phrases
inside a memory. `notBefore` suppresses ordinary recall and automatic foreground until its edge, while
`expiresAt` suppresses them at and after its edge. `reviewAt` marks an item due but does not itself make its
claim false or remove it from current retrieval; use an expiry when a judgment must stop steering replies
pending review. Due items remain due until an agent explicitly revises, reschedules, or retracts them. The
Due view and `review_due_memories` are inspection paths, not a scheduler: they do not wake a stopped room or
silently renew a verdict.

An exact retrieval result carries the selected content path and code-point offsets as a transient match
sidecar. The branded evidence and rendered context retain the exact excerpt and source reference, but not
those occurrence coordinates. If identical text appears more than once in a message, rendered evidence can
prove the substring and message source but cannot distinguish which identical occurrence was selected.

NFKC, lowercase mapping, and Unicode letter/number classes come from Node's Unicode tables. Retrieval
receipts record `process.versions.unicode`; deterministic ranking comparisons across machines require the
same recorded Unicode-data version as well as the same Fieldwork query format.

Each exact lookup currently verifies the complete archive chain, so its work is linear in archive size.
Current run logs and archived messages are evidence, not agent-authored memory, and no event becomes a
belief merely because it appears in a provider request. A first-person carried summary is likewise fallible
conversation context rather than canonical authored memory. Reconciliation remains unimplemented.

Source-reference fingerprints prove that a reference's fields are internally consistent. They do not prove
that a caller-supplied source exists, that an excerpt occurs in it, or that an independently controlled
archive still retains it. Retrieval code must verify those claims against the source store; provenance
fingerprints are attribution receipts, not external attestations.

## Check-ins need the room running

Check-ins are scheduled by the running room process, not by page JavaScript, so closing every browser tab does not
stop them; reopening the room only reveals and badges results that were saved meanwhile. Fieldwork itself must stay
running. While its process is stopped or the computer is asleep nothing runs. Missed intervals are not replayed as
a backlog; after the room returns, the scheduler may handle only the one edge that is currently due. "The person
last wrote" is known only since the room started. A check-in runs with the agent's usual tools, so whatever those
tools may do unattended (write memories, read web pages, start a Fieldwork when allowed) it may do while the person
is away. Messages arrive in the room by default. An explicit Telegram or Discord destination can additionally send
a kept check-in through that platform's connected, durably bound route; there is no phone or email channel beyond
those bridge choices. Manual free time shares the same tool boundaries but always stays local. A quiet free-time visit creates no conversation or check-in-history row, but any lasting tool change
still keeps the normal store/change receipt rather than becoming hidden activity.

The per-conversation automatic-check-in switch governs scheduled check-ins and postcards, including one aimed at
its bound bridge conversation. It does not
mute direct browser messages, incoming Telegram/Discord turns, or any external source, and it does not authorize
outbound bridge delivery by itself; the separate check-in destination does. Manual Check in/Postcard/Free time requests bypass it. When every eligible active conversation is
off, the room checks again on the scheduler's next minute tick; it does not claim or consume the still-due edge.
It does still reap an already-expired crash claim so the room cannot display an abandoned visit as running forever;
that maintenance receipt consumes only the old uncertain edge. Direct and bridge turns remain enabled, but the
room's single-flight fence may briefly ask them to retry while a check-in is choosing, claiming, running or saving.

Scheduled and manual check-ins and postcards save a 15-minute claim before model or tool work and finish only with
its exact token. If a claim expires, a `claim-expired` history row consumes the uncertain edge: the regular interval
restarts at reap time, while that local postcard day stays consumed. This prevents the same running room or a later
wake from immediately repeating the visit. Manual free time is unqueued and remains outside this claim lane.

An external check-in requires the chosen bridge to be connected and its conversation binding to be durably saved.
Without that exact active binding, a scheduled wake stops before claim or model work and leaves the cadence due; a
manual request reports that the bridge is not ready. A kept reply is saved locally before any platform request. The
destination and complete live route are rechecked immediately before transport. If transport is refused, rejected,
partial or uncertain, the local reply remains and the check-in history names that outcome; Fieldwork does not retry
it automatically. Closing Fieldwork asks in-flight generation and delivery to abort, drains cooperative work before
closing the delivery ledger, and never replays stopped time. A platform request accepted just before cancellation
can still settle as accepted or uncertain; shutdown cannot take that external event back.

Task heartbeats share that process boundary: they run only while the Fieldwork room is alive and do not replay a
backlog after restart. Their exact tool-name allow-list is enforced. An optional goal-or-promise measure binding is
the narrow source-bound exception: it retains one stable `recordId` and `measureKey`, replaces the generic register
read/record tools with schemas that do not accept those identifiers, and injects the fixed values on the server.
Other selected tools remain name-scoped unless their own schema supplies a narrower boundary. A standalone heartbeat
remains the default. Heartbeat results are task receipts, not chat messages or phone notifications. A provider run
that exceeds its 15-minute claim is recorded as `claim-expired`; a late result cannot complete that old token, and
the next active edge is deferred one full cadence from reap time instead of being reclaimed immediately.

The goal and promise register has no scheduler of its own. Automatic measure collection exists only when a running
room has a separately configured Task heartbeat with the register tools selected, so stopped time is neither sampled
nor backfilled. A heartbeat may bind its register access to one exact declared measure; the saved binding fixes both
the record and measure identifiers while the register's stored declaration still constrains the measure shape and
named source. This is an authority boundary, not lifecycle coupling. Pausing, finishing, retiring, removing or
restoring the heartbeat does not change the register item, and changing the register item's status does not silently
pause, finish, retire, remove or restore the heartbeat.

A named source and `observedThrough` timestamp are provenance claims, not independent proof that the source exists,
is complete, or was read correctly. Raw statistics prove only what the register computed from its retained explicit
samples. They do not prove causal progress, compare unlike source refreshes, or turn missing data into evidence. Use
`no-change` only when the named source was observed through a new edge, and `no-data` when it was not. Finishing a
goal or promise records a person's or agent's stated reason; it does not automatically verify that reason against an
external system.

Root load timestamps prove only when those exact checked bytes finished loading. They are not file modification
times and do not prove an external editor has finished. A memory-index edge proves only which durable ledger head
was ranked; it has no wall-clock meaning and does not make the sources cited by a memory any fresher. Query time,
root edges, provenance-source edges and index heads must not be collapsed into one room-wide “fresh as of” claim.

The outside reader is a clean review role on the room's current configured model connection, not a separate person,
account, model family or independent source of truth. A definition freezes 1–24 exact goal-or-promise record IDs;
later register entries are not added automatically. Each run receives only the bounded snapshots for those records
and an internal structured-result instrument: no agent roots, current conversation, room tools, or source-write
authority. The records are still untrusted text and can mislead the reviewer. A valid reference proves only that the
cited record, version, or measure check was in the supplied snapshot; it does not prove the reviewer's interpretation.

Scheduled reviews run only while the room is alive and are not backfilled after stopped time. An unchanged source
edge is recorded without a model call. “No findings” means only that this model returned no structured leads from
that exact bounded snapshot; it does not establish consistency, completeness, promise fulfillment, or absence of a
problem. A corpus that exceeds the review budget fails instead of being silently sampled or truncated. Findings are
retained review leads, not corrections: they never revise memory, change a goal or promise, send a message, or act on
the author’s behalf. Editing, pausing, removing, restoring, or undoing a review definition likewise never changes its
source records. Each review claims before it runs and finishes only with that exact token. Expiry records
`claim-expired` and defers the next active edge by a full cadence from reap time.

Every persistent mutation of the check-in, Task heartbeat, and outside-reader queue stores takes a short cooperative
sidecar lock, rereads the authoritative disk state through that store's existing loader, and atomically replaces it
before release. The persistent 15-minute token remains the long-running claim. Cooperating Fieldwork
processes on one computer therefore serialize claims and preserve unrelated updates.
A synchronous `view()` or `inspect()` can lag another process until that store's next asynchronous operation or
reopen; check-in `due()` and `resting()` have the same cache boundary.

After a crash, startup removes a stale lock only under a separate recovery guard, after exact
schema/token/file-identity rechecks, same-directory quarantine, and evidence that the recorded PID is absent on this
computer. Live, malformed, replaced and unverifiable locks fail closed for inspection. This is not a distributed
lock: the metadata has no host identity, so one agent home must not be active from multiple computers or a remote
owner could look absent locally. Claim expiry and cadence use the host wall clock, so a clock jump can hasten or delay
an edge. A noncooperating or hostile same-authority writer can ignore or race the protocol. None of these claims makes
a provider call or destination delivery exactly once. In-run tools have a separate locked attempt/outcome ledger and
person-reviewed recovery; reconciliation and destination-supported idempotency remain stronger, and host actions
outside model runs are separate.

The Windows dependency bootstrap uses the same guarded recovery mechanics for its repository-local install lock and
keeps its owned handle open through `npm ci`. Old loose-format, malformed, linked, changed, live, and unknown-owner
locks are retained; the timeout names both the lock and recovery guard for manual inspection. This remains a
cooperative same-computer protocol: the lock has no host identity, PID reuse can conservatively retain a dead lock,
and software with the same filesystem authority can ignore the protocol.

## The Telegram and Discord bridges are narrow bot routes, not hardened remote logins

Bot tokens are write-only to the browser and stored separately from agent homes, but they are plain JSON in the
ignored launcher secret file and present in the supervised child process environment while that agent's route is
active. Software running as the same operating-system account may be able to read either. The platform and the
configured model service also see message content in transit; this is not a local-only conversation once a
bridge is enabled.

Telegram checks an exact chat and user ID; a group also requires the bot's username to be explicitly mentioned.
Discord checks an exact channel and user ID; a server route additionally checks the server ID and requires a
literal bot mention. Those IDs are platform assertions, not cryptographic end-user authentication performed by
Fieldwork. Anyone controlling the allowed platform account can speak through that route. Anyone holding the
local room bearer token can replace the route or bot token. Telegram group privacy, Discord channel permissions,
the privileged Discord Message Content intent, and which events either platform delivers remain configuration
outside Fieldwork.

On every process start the listener deliberately uses Telegram's negative-offset `getUpdates` behavior to forget
the queued backlog. Messages sent while Fieldwork is stopped, starting, or reconnecting can therefore be skipped;
the bridge favors “old traffic is not a new invitation” over guaranteed delivery. Updates accepted by a running
process are remembered only in a bounded in-memory deduplication set. If a process dies after Telegram considers
an update consumed but before the reply is sent, Fieldwork does not recover or replay it.

Discord consumes only live Gateway events and never calls channel-history endpoints. Messages sent while the
listener is stopped or disconnected are therefore absent rather than replayed on reconnect. It starts a fresh
identified Gateway session instead of persisting Discord session/resume credentials. If Discord or the network
closes the connection, the status becomes failed and the listener reconnects after a bounded delay.

“The same conversation” means the route's bound Fieldwork conversation, not the surrounding native platform
history. Every accepted bridge turn loads that complete saved conversation through the room's normal bounded
context pipeline, including earlier accepted bridge and browser turns. In a long conversation, recent turns remain
verbatim while older turns may be carried as fallible first-person compaction and bounded exact recovery. Messages
Fieldwork never accepted—stopped-time backlog, unrelated channel traffic, native thread/topic context, edits,
reactions, and attachments—are absent. Changing a route's destination, allowed person, scope, or Discord server
starts a new bound conversation instead of exposing the prior route's context; rotating only its bot token does not.
The first binding is saved after the first conversation reply. If that local atomic write fails, the running process
keeps the conversation live and marks the binding **live but not saved**. Status refreshes and later accepted messages
retry only that idempotent local save, never the platform send. Restarting before it reports saved loses that route
link, so the UI explicitly says not to restart in this state.

Only text is accepted. Attachments, captions, edits, reactions, topics/threads, commands without text, and rich
platform objects are ignored. Long replies are split at each platform's content limit. Telegram webhooks are
refused and left untouched; Fieldwork will not silently delete another integration's configuration. Discord
replies disable all automatic mention parsing. A Discord REST send is not retried after a failure because its
visible outcome may be uncertain; a multi-part reply can therefore be partial. Provider or archive failures
return a generic retry message to the allowed user and keep exact diagnostics in the launcher terminal.

The bridge constructors require Fieldwork's durable delivery coordinator with the exact platform, destination, and
allowed source user; they fail before listening when it is missing, unrecognized, or route-mismatched. There is no
untracked direct-send fallback. The delivery sidecar is append-only and records a durable preflight before the first
platform request, followed by an acknowledgement settlement when one can be written. It distinguishes explicit API rejection from an
ambiguous network or response failure and keeps part counts for split replies. If the platform accepted a reply
but the settlement write failed, the UI truthfully remains uncertain and Fieldwork does not resend. New settlement
v2 receipts call a part accepted only when the Telegram or Discord API returned both a usable message ID and the
exact prepared chat or channel; they bind that response to the prepared chunk hash. Older v1 receipts remain
inspectable as message-ID-only evidence and are never retroactively strengthened. Neither form is a read receipt,
platform-signed content proof, history reconciliation, or evidence that a person saw the message.

The message-origin sidecar is durable archive metadata and is removed before the provider request, but it is
visible to anyone who can open the local room or read the conversation archive. It contains the literal platform,
destination, user, and source-message IDs. Check-ins cross a bridge only after the person selects that explicit
destination, and only through the route's exact saved Fieldwork conversation. The saved local reply, route recheck,
durable preflight, attempt edge and settlement keep the action inspectable, but they still cannot make platform
delivery exactly once or prove that the person read it.

The current supervisor keeps one saved token per platform and each agent keeps at most one route per platform.
Switching agents switches the active route; it does not keep several agents listening concurrently. Multiple bot
accounts, multiple chats for one agent, and simultaneous multi-agent listeners need an account registry rather
than overloading this first route file.

## Agent-written guide prose is not executable policy

The guide rewrite request enforces who may write, which guide IDs were selected, one-use expiry, size bounds,
revision conflicts, attribution, history, and reset/restore. It cannot mechanically prove that a rewrite kept
every fact in the canonical guide. The room therefore shows the complete current text for inspection and keeps
the Fieldwork wording one click away. Tool schemas, bridge allowlists, pack selection, HTTP routes, and host
permissions remain authoritative even when guide prose claims otherwise.

Custom memory, notebook and web guides ride as a temporary system note only when their matching tools are
present, so inaccurate or overconfident wording can still influence how a model chooses to use a legitimately
granted tool. It cannot expand that tool's validated arguments or host-side authority. Display pronouns are
similarly presentation state: changing them does not edit identity roots or establish anything outside this
local room. The room expands only a closed list of familiar labels or a complete five-part form; an ambiguous
label falls back to “the agent” rather than guessed grammar. The substitution applies only to Fieldwork-authored
UI slots. Agent-authored guides, conversation text, profile text, fetched text, and errors remain literal.

## Agent tool kits run with the host's authority

`src/agent-tools.mjs` provides memory, notebook, clock and web kits; a host grants each one explicitly.
The one-step first-run suggestion includes memory, notebook and clock but leaves outbound web reading off.
Granting `web` is an affirmative network-access choice, and scheduled work may use it unattended once granted.
The memory kit records `authored-memory` revisions attributed to the agent and keeps every superseded or
retracted version; it cannot restore or erase history. `update_memory_lifecycle` is limited to the calling
agent's own source-free authored records, rejects no-op or contradictory edits, and retains the previous
lifecycle as a superseded revision. `review_due_memories` reads clocks without acknowledging them. When a
conjunctive `recall` finds nothing, it retries each word separately and labels the result as broadened,
because the lexical index has no spelling variants.

The notebook confines paths to its root: relative, forward-slash, a closed character set, no dot-prefixed
names, and no symbolic link anywhere on the path, checked before and after creating folders. Like profile
loading, this is race-resistant validation, not an operating-system sandbox; a hostile local writer that can
swap a folder for a link between the check and the write may still win. Writes go through an exclusive
temporary file and a rename, and files are bounded at 1 MiB.

`read_web_page` resolves every address for a host and refuses the whole answer set if any result is loopback,
private, link-local, carrier-grade NAT, site-local or multicast. It then connects directly to one of that checked
snapshot's numeric addresses while retaining the original HTTP `Host` authority and HTTPS certificate/SNI name;
it never resolves the name again for that connection. Every redirect gets a new checked and pinned snapshot.
This closes the DNS-rebinding gap between validation and connection, but it cannot stop an allowed public server
from acting as its own proxy or returning information it obtained elsewhere. Pages are capped at 2 MiB, compressed
responses are refused, and accepted pages are returned as plain text.

The one-step launcher keeps the room's bearer secret beside its ignored `fieldwork.local.json`. When a custom
`FIELDWORK_SETTINGS` file is inside this checkout, the repo's `*.room-secret` rule also ignores its derived bearer
file. A settings file elsewhere needs the same protection from its own containing repository. Direct
`browser:chat` use keeps it in `<agent-home>/state/room-secret`. The page keeps it in `localStorage` for that
exact origin, so the plain loopback address keeps working after the first launch and across agent switches.
Anything able to read that file or that browser profile can open the room.

A crash, forced stop, or closed terminal window can leave either a durable writer lock or one of the short
check-in, Task-heartbeat and outside-reader transaction locks behind. Before opening state, `browser:chat` uses
the guarded, identity-checked recovery above only for those known lock names and only when the recorded PID is
absent on this computer (and `npm start` has already found no room answering on the configured port). A live,
unknown, malformed or replaced lock is reported and retained. A reused process ID can make a dead writer look
alive, in which case the lock is kept safely; a live owner on another computer can look absent, which is why
cross-machine sharing of one active agent home is unsupported. Individual stores never steal their incumbent
lock. The room's ⏻ button, Ctrl+C, and SIGHUP/SIGBREAK all close the stores cleanly; Windows may end the process
before SIGHUP is handled when a terminal window is closed, which is what guarded startup recovery covers.

Root edits from the browser rewrite only files the profile already names, are conflict-checked against the file's
hash, keep the replaced text in `state/root-history/` (the newest 50 versions per root), and are undone
automatically if the edited profile no longer loads. Anyone holding the room's password can read and change those
files. Icons are stored as data URLs (PNG, JPEG, WebP or GIF, at most 256 KB, checked by their leading bytes); the
page's content policy allows `data:` images and nothing else from outside.

## The first browser room is local composition, not a complete host

The browser server accepts only preconstructed Fieldwork dependencies and binds to `127.0.0.1`; by default it has no
remote-listening mode, provider credential surface, CORS grant, direct tool runner, or HTTP pack activation.
The one-step host may explicitly inject the closed agent-manager contract; only then does authenticated bootstrap
show registered agent-home paths and accept create, switch, rename, move, clear-state, and reset commands.
It may separately inject a closed model-connection manager. That adds a write-only API-key route and service
settings to the authenticated room, but no route can read the current key. Anyone holding the room password can
still replace or forget a saved key and choose where future rooted prompts are sent, which is powerful local
operator authority.
Bootstrap and later requests require the 256-bit bearer secret carried in the launch
URL fragment. The page immediately removes that fragment from the visible URL and retains it in history
state. Exact Host/Origin checks and Fetch Metadata rejection remain browser-CSRF defenses, not native-process
authentication by themselves. Automatic browser launch necessarily passes the complete URL to the operating
system's URL opener, so it can also appear in local process command-line inspection during launch. The launch URL is the
local authority: a process that can read host stdout, browser history state, process command lines, process memory,
or the operator's screen may steal it. Stronger isolation requires OS-authenticated IPC or a trusted browser bridge.

The browser origin is the loopback host and port, not the bearer nonce. The default ephemeral port makes
accidental reuse less likely, but a service worker planted while another server controlled that exact origin
can intercept a later first navigation before Fieldwork's CSP or headers are seen. A fixed port increases
that risk. Where another local process or prior browser content is hostile, use a fresh browser profile or an
OS-authenticated bridge rather than treating a loopback origin as newly created authority.

The token does not make a compromised same-origin script safe. The fixed CSP and literal DOM rendering are
therefore part of the boundary, not decoration. Browser projections omit raw source IDs/locators, paths,
root text and direct tool-result bodies, but the rooted provider sees roots and tool results and may repeat,
summarize, transform or encode them in an assistant reply. If the browser operator must not learn those
values, the host must inject a sanitized profile and non-secret tools or avoid rooted chat entirely.

With an archive injected, completed turns are archived and conversations are rebuilt after a restart.
An interrupted or failed run is not archived. Reopening a conversation looks up each message separately,
and each lookup re-verifies the archive chain, so opening is slow for very large archives. Titles are the
first user message, shown to anyone who can open the room. Current builds read older archives and default their
missing automatic-check-in policy to `allow`; after the first `conversation_proactive_changed` event, an older
strict build will reject that new event type rather than silently discard it. Back up the agent before downgrading.
Attached pictures stay in
`state/attachments/` until removed by hand; nothing cleans up pictures no conversation still uses, and the
same picture attached twice is stored once. A provider that cannot accept pictures may reject the request or
ignore the picture; Fieldwork does not know in advance which models can see. Provider requests include at most
4 MB of raw picture data, preferring the newest turns; older pictures stay in the archive and are represented to
the model by an explicit omission note for that request. With an empty query the Memory tab lists the newest
matching records by ledger sequence: Current excludes delayed and expired influence, Due shows reached clock
edges, and History includes every retained state. Memory search is inspection only and browser memory
mutation remains unimplemented. Automatic memory context runs only when the host opts in; `browser-chat` ties
that opt-in to the memory tool kit. A real provider must be injected by a trusted host; the synthetic demo
provider is not a vendor adapter.

The browser shows only a 512 KiB recent bubble window for a long conversation. Its omission notice means the
earlier messages remain in the archive, not that every earlier message was supplied to the current provider.
The provider sees the bounded carried-memory/recent-tail/exact-recovery projection. Derived compaction
snapshots are immutable caches in the agent's state directory; they are not hash-chained archive events and
can be deleted or replaced by someone with filesystem authority. Their hashes detect accidental mismatch at
load time, not hostile replacement by an actor who can rewrite both state and receipts.

The OpenAI-compatible chat adapter sends the complete rooted prompt, declared tools and tool results to the
configured service; that service is a trusted boundary for everything it receives. A key in
`FIELDWORK_API_KEY` lives in Fieldwork's process memory and environment, so any local process able to read
those can read it. The Windows helper writes it to the current user's environment (the registry), which is also
readable by processes running as that user. A key saved through Settings lives as plain JSON in the ignored
`fieldwork.local.secrets.json` beside the launcher settings, with owner-only mode requested where supported.
It is separate from every agent home and therefore excluded from agent reset, relocation, recovery copies, and
future portable exports, but any software running with the user's filesystem authority can read or replace it.
The key is never stored in `fieldwork.local.json`, room preferences, browser storage, logged, placed in a URL,
returned by bootstrap, or included in receipts or errors, and refused
redirects keep it from following a response to another origin. Loopback `http` is unencrypted by design and
must not be reverse-proxied to a network. "OpenAI-compatible" services differ: some reject `developer`, image
parts, or tools, and small local models may call tools badly or describe tools that were never declared. The
adapter reports such failures as they come back; it does not retry or count provider tokens. It streams when
the room asks, but a service that ignores `stream: true` is read whole, so its replies simply appear at once.

The opt-in ChatGPT subscription provider (`src/chatgpt-subscription-provider.mjs`) uses the private endpoint the
Codex app uses, `https://chatgpt.com/backend-api/codex/responses`. It is not a documented public API and may change
or be withdrawn. Fieldwork reads the access token from `CODEX_HOME/auth.json` (default `~/.codex`), asks
`codex app-server` to renew it when it is within five minutes of expiry or after a 401, and never writes that file.
The token travels only in the Authorization header to that exact host, redirects are refused, and errors redact it.
Anything able to read the Codex sign-in file can use the subscription; that boundary belongs to Codex. Requests are
`store: false`, and reasoning items are not replayed between turns, so long tool loops may reason less continuously
than in Codex itself.

Model switching is opt-in for the host: `browser:chat` offers the service's own model list (its `GET /models`, or
the subscription's list from Codex), and the browser can choose only from that list, never while a reply is running.
`browser:chat` persists the selection per agent and per service fingerprint; changing the configured default
invalidates an older selection. Anyone holding the room's password can therefore move the agent to a more expensive
model the service offers and make that selection survive a restart.

The optional OpenCode V2 live-test host is a compatibility bridge, not a full-fidelity provider adapter. It
discovers an already-running service through `@opencode/client`, requiring the exact pinned client version,
then independently rejects every endpoint except an authenticated canonical `http://127.0.0.1:<port>` origin.
It keeps the service authorization in process memory and never asks OpenCode to reveal the selected provider's API key or OAuth token. OpenCode's
own credential store, configuration, built-in provider plugins, account selection, and network requests are
therefore a separate trusted boundary. The external model receives the complete rooted prompt.

OpenCode's experimental stateless text endpoint accepts one prompt rather than an ordered role array or
Fieldwork tool declarations. The bridge consequently encodes the ordered roles as canonical JSON inside a
single prompt. Role labels and order survive, but native system/developer priority does not; prompt-injection
resistance is weaker than with a provider API that receives those roles directly. The bridge rejects tools,
tool history, tool results, and non-text media. Its API may also change with OpenCode because the endpoint is
explicitly experimental. The host pins `@opencode/client` and fixes the model at process startup; browser
HTTP still cannot connect an account, select another model, or activate a provider.

The adapter checks a separate reply-byte limit after generation returns. That protects Fieldwork's state but
cannot prevent `@opencode/client` from buffering the local service's complete HTTP response first; the
authenticated loopback service remains trusted not to return a memory-exhausting body.

Appearance settings are a closed, revision-checked projection. `browser:chat` persists the current revision in a
non-secret, atomically replaced preferences file; it is not hash-chained and anyone with filesystem authority can
edit or remove it. Custom hosts are not durable unless they persist and reinject updates. `updateAppearance()`
allows a host to grant the same contract to an agent tool deliberately; Fieldwork does not grant that tool.

Agent management is local operator authority, not an agent tool. Anyone holding the room password can create or
switch agents, rename the registry label, request a directory move, export or import a portable agent, or trigger a
confirmation-gated reset or restore.
Those filesystem actions run only after the current room closes its state handles. Recovery copies consume disk space
and are not automatically pruned. Restore accepts only supervisor-discovered copies for the active agent, refuses
links and special entries, stages and byte-verifies the selected copy, and preserves both the selected copy and the
version it replaces. Same-volume moves are atomic renames; cross-volume moves copy and hash every regular file, refuse
symlinks, and retain the former location as a backup. Files may still change outside Fieldwork, disk or power failure
can defeat any userspace transaction or rollback, and an operator should inspect backups before deleting them.

A portable agent is a directory, not an encrypted or signed archive. Its bounded manifest, per-file SHA-256 hashes,
whole-payload hash, strict paths and staged verification detect mismatch; they do not authenticate who made a bundle
or stop someone who can replace both its payload and manifest. Do not import an untrusted bundle: its roots can direct
future model behavior and its workspace can contain arbitrary regular files. Import refuses links, special entries,
forbidden runtime state, malformed profiles and nonportable or colliding paths, but it does not judge the meaning or
safety of otherwise valid content. The imported home is registered dormant and cannot run schedules or reconnect a
bridge until the operator explicitly switches to it; bridge bindings are never included.

Directory publication cannot be a single cross-platform no-clobber rename. Fieldwork instead creates the final
directory exclusively, keeps an invalid `.fieldwork-portable-incomplete` marker while moving and rechecking verified
content, and removes the marker last. A crash before registry persistence can leave a visibly incomplete,
unregistered directory for the operator to remove. A crash or marker-removal failure after registry persistence can
instead leave a registered but unavailable agent; switching refuses that home while the marker remains. In either
case the marker makes the interrupted state inspectable, and Fieldwork never replaces an existing destination.

Export omits recovery copies, room bearer files and the live bridge-binding file, and it refuses common
credential-file names, lock files and interrupted Fieldwork staging names. It scans every included byte for the model
API key, bot tokens and room bearer currently known to the supervisor, failing without echoing a match. That scan
cannot recognize an unrelated password, private key or token manually written into an ordinary note, nor a credential
unknown to the current launcher. Inspect the completed bundle before sharing it. The current bounds are 20,000 files,
10,000 directories, 2 GiB total, 512 MiB per file and 64 path segments; larger homes need another transfer method.

Model-connection management is also local operator authority, not an agent tool. It closes the active room before
the supervisor rewrites settings or its separate secret store. The settings write is rolled back if saving a new
key fails, but a simultaneous external edit, disk failure, or failed rollback can still leave an ambiguous remainder.
The secret store is one launcher-wide key rather than a provider keyring; saving a new key replaces the previous
saved value. A saved key is bound to the exact normalized service URL it was entered for, so changing endpoints
without entering a new key leaves it dormant rather than disclosing it to another provider. It takes precedence
over `FIELDWORK_API_KEY` only at that URL. The environment fallback remains deliberately unbound and is used for
whichever OpenAI-compatible endpoint the launcher currently selects until the environment value is removed.

Run timeout and shutdown cancellation remain cooperative inside the provider or tool. The HTTP layer races
the run against timeout/disconnect, rejects concurrent chat, stops accepting connections before shutdown,
and discards any late result from an abort-ignoring operation once control returns. A synchronous callback
can block the event loop past the deadline or forever; Fieldwork can reject its late result but cannot send a
timely response. The callback can also retain resources or complete an external side effect after the browser has
returned 504. Tracked tools are not rolled back with the transcript: their durable attempt/outcome boundary blocks
automatic repetition and exposes uncertainty for person review, but it is not external proof. Destination-side
idempotency remains preferable. Within one run, the same tracked tool and canonical argument digest may enter its
executor at most twice; a third exact attempt is refused without creating another effect action. This fixed budget
does not cap different arguments, calls across separate runs, wall-clock time, provider usage, or read-only tools.
Shutdown waits up to five seconds for browser work and effect dispositions, then
drops only in-process effect capabilities and preserves the durable orphan; a forced temporary room is left for
operating-system cleanup rather than raced with late code. Code that requires enforceable cancellation or wall-clock
isolation belongs in a worker or separate process. The browser view owns its per-run event logs
and HTTP listener. It deliberately does not close the injected ledger, archive, pack host, or provider,
whose lifecycle remains the embedding host's responsibility.
