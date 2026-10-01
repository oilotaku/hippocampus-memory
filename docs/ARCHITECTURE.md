# Architecture: the hippocampus layout

The memory services are grouped after the regions of the hippocampal memory system. The grouping is an organizing
metaphor: it says which job a module does in the life of a memory (encode, separate, compare, recall, consolidate,
forget), so that a new change has an obvious home. It does not claim the code simulates neurons.

All memory modules live under `services/hippocampus/`. Shared infrastructure stays directly under `services/`.

## Region map

| Region | Role in the brain | Directory | Main modules |
|---|---|---|---|
| Entorhinal cortex | Input to the hippocampus; time cells and place cells tag each experience | `entorhinal/` | `scribe.js` (batches messages, one extraction call per batch, then hands the result to `dentate/encode.js`), `scribeConfig.js`, `scribePromptV2.js`, `timing.js` (the single source of a memory's age; wall-clock days today), `chatParser.js`, `chatImport.js` |
| Dentate gyrus | Pattern separation: similar experiences are stored apart | `dentate/` | `encode.js` (the write path: quote check, date fix, vector and local dedup, insert, entity links), `scribeQuality.js` (verbatim-quote check, cross-day dedup that never merges sentences differing in numbers, weekdays, or nouns, assistant small-talk filter, tolerant reply parser), `dateFix.js` (date and weekday consistency), `timeFields.js` (`raised_at`, `event_at`, time slot, weekday), `strength.js` (encoding strength: initial weight, evidence step) |
| CA1 | Comparator: checks input against what is stored; mismatch is novelty | `ca1/` | `verify.js` (optional pre-answer check), `correction.js` (user corrections, locating the wrong source, lessons fed back to Scribe), `entityResolver.js` (binding fragments to known entities) |
| CA3 | Pattern completion: recall a whole memory from a partial cue | `ca3/` | `recallGate.js` (whether and how much to recall), `recallPipeline.js` (budgeted memory block), `librarian.js` (full-text, vector, and entity channels fused with RRF, recall permission levels), `decay.js` (time factor in the ranking), `memory.js` (hard triggers, vector store), `workingMemory.js` (topic-aware pool), `intuition.js` (context-triggered behaviour patterns) |
| Amygdala | Emotional modulation of encoding strength and forgetting | `amygdala/` | Eight-dimension scores, time slots, OU baselines, turning-point attribution, anniversaries, fading (`index.js` re-exports all) |
| Sleep replay / systems consolidation | Offline replay turns episodes into semantic knowledge | `consolidation/` | `archivist/` (2-minute tick and the idle deep cycle: classify, link entities, episodes, sagas, overviews), `consolidator.js`, `summary.js` |
| Synaptic homeostasis | Global down-scaling during sleep; unused traces fade | `homeostasis/` | `lifecycle.js` (nightly GC, decay, retirement; thresholds in `lifecycleConfig.js`), `memoryBudget.js` (token budget for the memory block), `rhythmConfig.js` |
| Neocortex | Long-term semantic memory and the self | `cortex/` | `cognitiveModel/` (four-layer user model), `persona/` (core / relationship / situational persona, drift check, judgment updates), `entityProfile.js`, `userProfile.js`, `companionPersona.js` |

### Infrastructure (not a region, stays in `services/`)

| Module | Why it stays |
|---|---|
| `llm.js`, `memoryCrypto.js`, `memoryConfig.js`, `nameResolver.js`, `worldContext.js`, `tagRouting.js` | Used by almost every region (model calls, field encryption, configuration, display names). `nameResolver.js` resolves the configured user / assistant display names; it does not compare entities, so it is not part of CA1. |
| `context.js` | Builds the whole chat system prompt. Only part of it assembles memories (that part already lives in `ca3/recallPipeline.js`); splitting the rest would change code, not just move it. |
| `skillManager.js`, `tools/` | Assistant skills and the tool-call surface exposed to the chat model. |

Time helpers (`utils/time.js`, `utils/dateParse.js`) stay in `utils/`; the entorhinal, dentate and amygdala modules call them. Relative dates ("next Wednesday") are resolved by one parser, `utils/dateParse.js`, for both `event_at` and the date fix.

### Plug points for time and strength models

Three modules exist so that future models replace one function instead of edits across regions. Each currently reproduces the old behaviour exactly.

| Plug point | Today | Intended model |
|---|---|---|
| `entorhinal/timing.js` `memoryAgeDays()` | Wall-clock days since the memory | Subjective time (attentional gate, pacemaker-accumulator) |
| `ca3/decay.js` `timeFactorParts()` | Segmented exponential decay chosen by emotional weight, a recency step, slower time for long-term questions | Forgetting on a log-compressed timeline |
| `dentate/strength.js` | Initial weight from the extraction, weight from emotion intensity, +0.05 confidence per repeated mention | Encoding strength with spacing and retrieval-practice effects |

## Data flow

### Writing a memory

```
chat messages
   │
   ▼
entorhinal/  scribe.js ── one LLM call per batch: short facts + verbatim quote + emotion scores + event date;
   │                      lessons from ca1/correction.js are injected into the prompt;
   │                      a truncated reply is split in half and retried
   ▼
dentate/     encode.js ── the write path, in order:
   │           scribeQuality.js  quote must appear in the source; assistant small talk dropped
   │           dateFix.js        "3月19日（週三）" checked against the calendar and corrected
   │           dedup             same fact on another day adds evidence (strength.js);
   │                             near-identical sentences with different details stay separate traces
   │           timeFields.js     raised_at from the source messages, event_at from the quote
   ▼
index        memory_fragments (+ encrypted content, blind full-text index, vector store via ca3/memory.js)
   │         amygdala/store.js ── emotion columns, baseline and turning-point updates
   ▼
ca1/         entityResolver.js ── after the write, bind each fragment to known people / places / events
   │         correction.js ── user corrections locate the wrong source and fix the stored memory
   ▼
consolidation/  archivist tick (light) and deep cycle when the user is idle
   │            ── classify, grow entities, episodes, sagas, overviews
   ▼
cortex/      entity profiles, user model, persona   ◄── homeostasis/lifecycle.js decays and retires unused traces
```

### Recalling a memory

```
cue (current message)
   │
   ▼
ca3/  recallGate.js ── skip greetings and commands; choose result count
   │  recallPipeline.js ── hard triggers → retrieval → entity profiles → surfacing, within memoryBudget
   │  librarian.js ── full-text + vector + entity channels, RRF, emotion fading in the ranking;
   │                  time factor from decay.js, memory age from entorhinal/timing.js
   ▼
comparison ── each result carries a recall permission level (cite / cautious / …); the prompt tells the
   │           assistant how firmly it may state each one;
   │           optional ca1/verify.js checks the question's details against the memories (recall.verify)
   ▼
reply ── recallGate.markCitedFromReply() records which memories were actually cited
```

## Module state

Every module has exactly one instance. Module-level state (for example the working-memory pool in
`ca3/workingMemory.js`, the entity cache in `ca3/intuition.js`, the alias cache in `ca1/entityResolver.js`,
`archivistEvents` and the tool registry in `consolidation/archivist/runtime.js`) lives in the file under
`services/hippocampus/`. The old paths below only re-export it.

## Old paths

The reorganization (work item G5) was a pure move. Every old module path still works:

- `services/<name>.js` for a moved file is now a two-line forwarder:
  `module.exports = require('./hippocampus/<region>/<name>');`
- Every file of the moved directories `services/emotion/`, `services/persona/`, `services/archivist/`, and
  `services/cognitiveModel/` has a forwarder at its old path, including `index.js`. `services/archivist.js` and
  `services/cognitiveModel.js` keep forwarding to their directory entry.
- A forwarder returns the same object as the new path, so there is still one instance and one copy of any state.
  `tests/unit/g5_module_surface.test.js` checks this for all 72 moved modules, together with the export names,
  order, and types recorded before the move.
- `routes/`, `index.js`, `scripts/`, `tasks/`, and `tests/` still use the old paths. New code should require the
  new paths.
- One deliberate exception: moved modules still load the librarian through `services/librarian.js`, because several
  tests replace that path in `require.cache` with a stub before loading Scribe.
- `services/persona/probes.json` is data, not a module, so it moved without a forwarder to
  `services/hippocampus/cortex/persona/probes.json`.

Header comments inside moved files may still name their old path; the code is unchanged apart from relative
`require` paths and `__dirname`-relative paths.
