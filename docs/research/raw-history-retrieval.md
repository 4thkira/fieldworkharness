# Raw history retrieval as the memory baseline

Status: design evidence, not an implemented semantic index. Reviewed 2026-11-02 against
version 1 of Bao et al., submitted 2026-10-22.

Primary sources:

- [Is Complex Agentic Memory Always Needed? Naive RAG Is Stronger Than We Thought](https://arxiv.org/html/2610.30755v1)
- [Official RAW-RAG implementation and reproduction guide](https://github.com/Litmeb/RAW-RAG)

## What the paper establishes

RAW-RAG retains source conversation text, divides it into overlapping windows, uses dense retrieval to
produce candidates, reranks those candidates, and gives selected raw evidence to the reader. The evaluated
default uses 256-token windows with 32-token overlap, 128 dense candidates, and 15 reranked results; selected
windows remain linked to source messages so reader evidence can expand back to complete turns.

Across the paper's four main benchmarks and seven benchmark-reader settings, this baseline ranks first among
the compared memory systems in six settings. Its reported winning margins are 0.13 to 5.53 percentage points.
The retrieval ablations matter more to Fieldwork than the headline:

- removing the reranker costs 3.92 points on the reported MemoryAgentBench ablation;
- keeping only one result costs 11.73 points;
- moderate final result counts are comparatively stable, while flooding the reader with 120 results loses
  14.57 points;
- atomic-fact extraction, summary augmentation, and graph expansion do not improve the raw baseline in the
  tested representation-reader combination.

The diagnostic split between evidence **coverage** and reader **utilization** is particularly useful. Systems
differ more in whether they supply sufficient evidence than in whether the reader answers correctly once that
evidence is present. Raw evidence also retains dependency paths: which value changed, in what order, and what
earlier state the change affects. Retrieving a final answer-shaped fact without that path can still be
insufficient.

## What the paper does not establish

This is an arXiv preprint evaluating offline questions over public conversation benchmarks. It does not prove
that raw retrieval is best for interactive operation, multimodal history, privacy-constrained retention, weak
readers, or every model. One main setting favors MemMachine, and the appendix's PersonaMem-v2 comparison places
RAW-RAG third. The authors also identify reader dependence, raw-storage growth, privacy, deletion, dispersed
low-similarity evidence, repeated query-time reasoning, and overlapping-window duplication as open edges.

Most importantly for Fieldwork, the paper explicitly separates question answering from operational memory.
An agent still may need authoritative current state, scheduled review, tool triggers, conflict-checked updates,
and actual erasure. Raw history can be the evidence substrate without replacing those mechanisms.

## Fieldwork's current position

Fieldwork already satisfies the source-preservation half of this result:

- the append-only conversation archive remains the exact record;
- compaction is a fallible derived projection and never replaces that record;
- long-context recovery reopens bounded whole earlier turns, not fragments of the compaction;
- `search_conversations` returns verified raw excerpts with source receipts and does not silently promote them
  into authored memory;
- the memory ledger keeps operationally useful current state, lifecycle clocks, corrections, and retractions
  separate from retrieved evidence.

The missing baseline is meaning-based retrieval and reranking over raw conversation history. Current archive
search and long-context recovery are lexical. They can recover an exact shared term but miss a paraphrase such
as “blue” in response to a query about sadness.

## Decision for a future retrieval slice

Build and evaluate a source-preserving raw-history path before adding more memory transformation:

1. Treat any semantic index as derived and rebuildable. The archive remains authoritative.
2. Keep every indexed window linked to exact conversation, message, speaker, observed time, archive head, and
   source hash. Reader evidence should reopen complete source turns in chronological order.
3. Use a two-stage design: broad meaning-based candidates, then reranking. Do not adopt the paper's exact
   window and result counts without measuring Fieldwork's intended readers and context budgets.
4. Keep exact lexical search beside semantic retrieval. Receipts must name which path found each result.
5. Record the temporal cutoff, embedding/reranker identity or fingerprint, candidate count, selected count,
   context bytes, omitted evidence, and rebuilt-index boundary. A stale index must fail to less evidence, not
   silently claim completeness.
6. Do not send private history to an embedding or reranking service merely because one is configured for chat.
   Indexing is a separate explicit capability with a visible local/cloud boundary.
7. On conversation removal or retention changes, invalidate every derived window that cites the affected source.
   Rebuilding an index must never resurrect text absent from the authoritative archive.

### A second baseline: model-directed files

A practitioner suggestion supplied during Fieldwork review argues that some model families do better when they
can write durable Markdown and deliberately navigate it later than when a harness mechanically retrieves context
for them. That is not evidence for unrestricted shell access, and it is not in tension with RAW-RAG's benchmark:
the two approaches test different combinations of model ability, tool affordance, and retrieval policy.

Fieldwork should therefore measure a constrained file-navigation baseline too. The agent gets its existing bounded
notebook tools, literal directory listings, paged reads, and normal receipts—never an ambient shell, arbitrary host
filesystem access, or a hidden automatic file selection. Success means the model can decide what to write, where to
look, and which exact material to reopen. Failure remains attributable either to navigation, evidence coverage, or
reader use instead of being folded into one vague “memory” score.

## Evaluation gate

A synthetic public benchmark should compare at least:

- the current exact lexical archive search;
- the current lexical whole-turn recovery used during compaction;
- model-directed navigation over a bounded durable Markdown notebook, with no automatic retrieval;
- source-preserving semantic candidates without reranking;
- the same candidates with reranking;
- optional authored-memory or summary augmentation, never substituted for the raw evidence.

Measure evidence coverage, dependency-path coverage, answer accuracy conditional on sufficient evidence, total
answer accuracy, ingestion and query latency, stored bytes, reader-visible bytes, and retrieval omissions.
Include corrections, conflicting values, temporal cutoffs, multi-turn demonstrations, low-similarity paraphrases,
and quoted false claims. Run the comparison with the actual reader classes Fieldwork supports; a result from one
strong hosted model is not a universal retrieval policy. Report results by model family instead of silently choosing
one memory architecture for every reader.

Until that gate exists, Fieldwork should preserve the raw record, keep semantic retrieval unchecked on the
feature list, and resist adding an elaborate memory structure merely because it sounds more agentic.
