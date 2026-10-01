# Hippocampus Memory

A self-organizing long-term memory system for AI assistants and companions. It extracts facts from conversations, checks each fact against what was actually said, organizes facts into a star map of people, places, and events, and recalls them during chat. It can run fully on a local model, so conversations never leave your machine, and memories are encrypted at rest.

> **Adapted from [Memory Constellations](https://github.com/ClaraShafiq/MemoryConstellations)** by **Clara Shafiq & Draco Malfoy**, released under the MIT License. The original copyright notice is preserved in [`LICENSE`](LICENSE), and the complete git history is kept. See [Acknowledgments](#acknowledgments).

---

## Status

| Area | State |
|---|---|
| Extract, organize, recall pipeline | Working |
| Local model (Ollama) instead of cloud APIs | Working, verified end to end |
| Verbatim-quote check on extracted facts | Working |
| Cross-day deduplication with evidence counting | Working |
| Two-character Chinese full-text search | Working |
| Field encryption (fail-closed, v2 format, key rotation) | Working for chat messages and API keys |
| SSRF protection for user-supplied endpoints | Working |
| Encryption of memory content with a blind search index | Working (on by default) |
| Archivist and cognitive model split into focused modules | Done |
| Memory modules regrouped by hippocampal region (`services/hippocampus/`, old paths kept as forwarders) | Done |
| All Chinese text in code, prompts, and UI in Traditional Chinese (Simplified input still matches) | Done |
| Three-layer persona (core / relationship / situational) with versioned, reviewable, rollback-able relationship proposals | Working |
| Stable traits (confidence ≥ 0.7) and the relationship layer injected into the chat prompt under their own small token budget | Working |
| Entity `judgment` updated incrementally against the previous version (small edits with cited sources only) | Working |
| Daily persona drift check against anchor answers, with automatic rollback of the relationship layer | Working (embedding channel needs ChromaDB; falls back to bigram Jaccard) |
| Retrieval timing gate: skip memory lookup for greetings and commands, adaptive result count, context-triggered surfacing, upcoming-event reminders, capped hard triggers | Working (on by default; `recall.gate=false` restores the old behaviour) |
| `injected_count` (put in the prompt) split from `cited_count` (actually used) | Working; `cited_count` is fed by the `recall_memory` tool, and by `recallGate.markCitedFromReply()` for hosts that can pass the assistant's reply |
| Eight-dimension emotion engine: per-fragment scores, personal time-of-day baselines, turning-point attribution to entities, anniversaries, fading | Working (on by default, `emotion.enabled`) |
| Does not invent answers: asked about something never mentioned or with a wrong detail, the memory system says it is not mentioned or corrects the detail (short set 35/35, 80k-token set 118/118), while answering from the whole transcript invented an answer in 9 of 59 such questions at 80k tokens | Measured with both extraction prompts (long set 71/74 each), see [Verification details](#verification-details) |
| Scribe extraction no longer loses whole batches: truncated replies are salvaged or split, a failed batch stops the run instead of being skipped, each batch gets the messages right before it as context | Working (see [Verification details](#verification-details)) |
| Scribe prompt v2: half the length, one consistent "record every concrete detail" rule instead of conflicting keep-it-short / never-miss-anything rules | Working (default; `scribe.prompt=legacy` restores the original prompt byte for byte) |
| Pre-answer check (CA1 comparator): when a question names a concrete detail, one extra model call checks it against the retrieved memories and adds a `<memory_check>` note when they disagree or say nothing | Optional (`recall.verify`, off by default); measured no gain, see [Verification details](#verification-details) |
| Retrieval ranking v2: entities boost instead of flooding, no penalty for full-text-only hits, time decay orders but never filters | Working (on by default; `librarian.ranking=legacy` restores the old ranking) |
| Retrieval benchmark on LoCoMo and a Traditional Chinese synthetic set (`eval/`) | Done; see [Retrieval evaluation](#retrieval-evaluation) |
| Time information: local time and weekday for the extractor, per-memory conversation dates, dates shown when memories are injected | Working |
| End-to-end evaluation (extraction, recall, answering, grading) with a long-context baseline | Done on the Chinese synthetic set; see [End-to-end evaluation](#end-to-end-evaluation) |

---

## How it works

```
Chat messages
    │
    ▼
Scribe ── extracts short facts into memory_fragments
    │    ── every fact must carry a verbatim quote; the code checks
    │       that the quote really appears in the source messages
    │    ── duplicates across days add evidence instead of new rows;
    │       sentences that differ in numbers, weekdays, or nouns are never merged
    │
    ▼
Archivist ── 2-minute tick
    │    ├─ light mode: link fragments to entities, expire timed states, merge duplicate entities
    │    └─ deep cycle (user idle ≥ 60 min, enough free RAM): classify, grow entities,
    │       consolidate fragments into episodes, cluster episodes into sagas,
    │       regenerate entity overviews
    │
    ▼
Librarian ── at chat time
    │    ── full-text (two-character Chinese tokens, bm25), vector, and entity channels
    │    ── fused with RRF (k = 60); episodes weighted over raw fragments
    │    ── each result tagged with a recall permission level
    │
    ▼
System prompt ── relevant memories, entity profiles, and user state,
                 kept within a configurable token budget
```

The code is organized after the hippocampal memory system: input encoding (`entorhinal/`), pattern separation (`dentate/`), comparison (`ca1/`), pattern completion (`ca3/`), emotional modulation (`amygdala/`), sleep-time consolidation (`consolidation/`), forgetting (`homeostasis/`), and long-term semantic memory (`cortex/`), all under `services/hippocampus/`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the region map, the write and recall data flow, and how the old module paths still resolve.

### Memory layers

| Layer | Table | Contents |
|---|---|---|
| Fragments | `memory_fragments` | Single facts of at most 80 characters, each with its source `quote` and an `evidence_count` |
| Entities | `entity_profiles` | People, places, events, hobbies, and projects, each with facts, current status, and judgment |
| Episodes | `memories` (layer = episode) | Narratives merged from fragments, 100 to 250 characters |
| Sagas | `memory_sagas` | Arcs across entities (experimental) |
| User model | `user_model`, `user_patterns` | Timed states, recent developments, and long-term behavior patterns |

Behavior-pattern confidence does not decay just because time passes. It rises with confirming evidence and drops mildly on contradiction, with a floor of 0.20. A contradiction from an independent source can flag the pattern for LLM review.

### Recall permission levels

| Level | Condition | How the assistant should use it |
|---|---|---|
| Cite | Hit by two channels and less than 30 days old | May state it as fact |
| Cautious | One channel, or 30 to 90 days old | Phrase it as "I seem to recall…" |
| Associate only | Older than 90 days, or surfaced at random | Internal context only; never assert it |

Without a vector store, only one channel can hit, so no result reaches the Cite level.

### Lifecycle

| What | Active to cooling | Cooling to frozen | Frozen to tombstone |
|---|---|---|---|
| Fragments | 14 days without access | 30 more days; vector removed | 90 more days; content wiped |
| Episodes | Permanent | 6 months to mature | 12 months to archived |

Recalling a memory resets its timer.

---

## Security and privacy

- **Fail-closed field encryption.** Values are encrypted with AES-256-GCM in the format `enc:v2:<key id>:<nonce>:<ciphertext>`. Encryption failures throw instead of writing plaintext. Decryption failures return nothing instead of placeholder text, so garbage is never written back or sent to a model. Ciphertext can be bound to its row with associated data, and keys can be rotated. The older v1 format is still readable.
- **Memory content encrypted at rest.** Chat messages, stored API keys, fragment content and quotes, episode titles and content, and entity facts, status, judgment, and overviews are all encrypted, each bound to its table and column. Reads are decrypted transparently at the database layer, so encrypted text never reaches a model, the API, or the star map. A wrong key refuses to start instead of slowly corrupting data. Keys can be rotated with `node scripts/rotate_memory_keys.js`.
- **Blind full-text index.** Two-character tokens are hashed with a key derived from the encryption key before indexing, so the search index holds no readable text. Content hashes used for deduplication are keyed too.
- **Still in plain text.** Entity names and aliases, tags, fragment insights, some entity relationship fields, the user model and patterns, and any text sent to ChromaDB.
- **SSRF protection.** Any endpoint a user can set is resolved through DNS first, and every resolved address is checked. Private, loopback, link-local, and reserved ranges are rejected, including encoded forms such as `http://2130706433/` and IPv4-mapped IPv6. Only HTTPS is allowed, credentials in URLs are rejected, redirects are refused, and connections are pinned to the verified address. A local model is allowed only through an exact-origin allowlist in `LLM_ENDPOINT_ALLOWLIST`.
- **Local inference.** With Ollama, extraction, consolidation, and embeddings all run on your own machine.

---

## Quick start

Requires Node.js 20 or newer. The native SQLite module ships prebuilt binaries, so no compiler is needed.

```bash
git clone https://github.com/oilotaku/hippocampus-memory.git
cd hippocampus-memory
bash scripts/setup.sh        # copies templates, installs dependencies, initializes the database
```

Edit three files:

```bash
.env                  # encryption key, session secret, login password, model settings
memory_config.json    # names, relationship, rhythm, token budget
core-prompt.txt       # the assistant's personality
```

### Option A: local model with Ollama (recommended for privacy)

```bash
# In Ollama: a chat model (for example qwen3:8b) and an embedding model (bge-m3)
node scripts/setup_llm.js --provider ollama --model <your chat model>
```

Then add this to `.env` so the SSRF guard allows your local endpoint:

```
LLM_ENDPOINT_ALLOWLIST=http://127.0.0.1:11434
```

Set `OLLAMA_CONTEXT_LENGTH=16384` for Ollama itself; its default context is too small for a full extraction batch. On CPU, one extraction call for 10 messages took about 4.5 minutes in testing, so treat the pipeline as a background job.

### Option B: cloud API

Put an OpenRouter, DeepSeek, or Gemini key in `.env`. See `.env.example`.

```bash
npm start
# open http://localhost:3000/memory.html
```

The full walkthrough is in [`OSS_SETUP.md`](OSS_SETUP.md).

---

## Configuration

### `.env`

| Variable | Required | Purpose |
|---|---|---|
| `SANCTUARY_ENCRYPTION_KEY` | Yes | Current encryption key, 64 hex characters (`openssl rand -hex 32`) |
| `SANCTUARY_ENCRYPTION_KEY_ID` | No | ID written into new ciphertext, default `k1` |
| `SANCTUARY_ENCRYPTION_KEYS_OLD` | No | Older keys for decryption after rotation, as `kid=hex,kid=hex` |
| `MEMORY_ENCRYPTION` | No | `on` (default) encrypts memory bodies at rest (fragment content/quote, episode title/content, constellation facts/status/judgment/overview) and uses a keyed blind index for full-text search; `off` stores them in plain text. Switching either way is handled on the next start. Rotate keys with `node scripts/rotate_memory_keys.js [--dry-run]` |
| `SESSION_SECRET` | Yes | Session secret, 64 hex characters |
| `LOGIN_PASSWORD` | Yes | Web login password |
| `API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY` | For cloud models | Model provider keys |
| `LLM_ENDPOINT_ALLOWLIST` | For local models | Comma-separated exact origins allowed to be private or plain HTTP |
| `LLM_REQUEST_TIMEOUT_MS` | No | Request timeout; local endpoints default to 5 minutes, cloud to 30 seconds |
| `DB_PATH` | No | SQLite database path |
| `CHROMA_URL` | No | ChromaDB address for the vector channel |
| `PORT` | No | Web port, default 3000 |

### `memory_config.json`

Personalization lives here: user and assistant names, relationship, and colors. Settings added in this version:

| Key | Default | Purpose |
|---|---|---|
| `rhythm.deep_cycle_idle_minutes` | 60 | Idle minutes before the deep cycle runs |
| `rhythm.deep_cycle_min_free_mb` | 1200 | Skip the deep cycle below this much free RAM; lower it on small machines |
| `context.memory_token_budget` | 1200 | Token budget for memory blocks in the system prompt; whole memories are dropped from the end, never cut in the middle |
| `persona.auto_apply` | true | Apply relationship-layer proposals automatically (at most `persona.weekly_apply_limit` per 7 days); `false` keeps every proposal `pending` for manual review through `/api/persona/proposals` |
| `persona.drift_check` | true | Run the daily persona drift check; `false` disables it entirely |
| `persona.min_evidence` / `persona.min_days` | 3 / 3 | A stable trait becomes a proposal only with this many distinct evidence fragments spread over this many different days |
| `persona.min_confidence` | 0.7 | Minimum trait confidence for proposals and for chat-prompt injection |
| `persona.weekly_apply_limit` | 2 | Maximum automatic applications per rolling 7 days |
| `persona.max_prompt_lines` / `persona.prompt_token_budget` | 5 / 300 | Size limits of the `<relationship_context>` block (separate from `context.memory_token_budget`) |
| `persona.drift_threshold` | 0.75 | Mean embedding cosine similarity below which drift is declared |
| `persona.drift_threshold_jaccard` | 0.2 | Same, when embeddings are unavailable and bigram Jaccard is used instead |
| `persona.drift_samples` | 1 | Answers averaged per probe question (temperature is always 0) |
| `persona.judgment_max_change` | 0.4 | Largest allowed change ratio (edit distance / longer length) when an entity's `judgment` is rewritten; larger or uncited rewrites keep the old version |
| `recall.gate` | true | Master switch for the retrieval timing gate. `false` restores the old behaviour exactly: search 8 fragments on every message, random 40% surfacing, unlimited hard triggers, novelty and lifecycle keyed on `read_count` |
| `recall.candidate_k / max_k` | 16 / 8 | Candidates fetched, and the most fragments kept after the relative cutoff |
| `recall.relative_cutoff` | 0.5 | Keep only results scoring at least this fraction of the top result, then trim to the token budget (whole fragments only) |
| `recall.budget_share` | 0.3 / 0.5 / 0.2 | Split of `context.memory_token_budget` between core blocks (hard triggers, entity files), retrieval, and surfacing plus upcoming events; normalized to sum to 1 |
| `recall.min_chars / command_max_chars` | 4 / 14 | Very short messages, and short command-style messages, skip lookup unless they name a known entity, contain a cue word, or are questions |
| `recall.smalltalk_words / command_prefixes / cue_words / question_words` | see example file | Word lists (Simplified and Traditional both match). Smalltalk and commands skip lookup; cue words ("last time", "remember", ...), question words, known entity names or aliases, and long-term/summary/fact intents force it |
| `recall.topic_overlap / continuation_minutes` | 0.3 / 30 | If a message shares this fraction of two-character tokens with the previous one within this many minutes, reuse working memory instead of searching again |
| `recall.surface_idle_hours` | 6 | Idle hours before the next message may bring up an old, never-injected fragment; fragments created on the same month and day in an earlier year also surface |
| `recall.surface_cooldown_days / surface_max / surface_noise` | 7 / 2 / 0.15 | Cooldown after a fragment surfaces, how many may surface at once, and the Gaussian jitter used when choosing among candidates |
| `recall.prospective_days / prospective_max` | 7 / 3 | Events dated within this many days are added to an upcoming-events block even if the message did not match them. Dates are parsed from fragment text (`M月D日`, `M/D`, `下週X`, `週X`, `明天`, ...) relative to when the fragment was written; an `event_at` column is used if present |
| `recall.verify` | false | Pre-answer check (CA1). When the message names a weekday, date, number, time word or known entity and memories were retrieved, one model call (temperature 0) judges whether the memories support it: `supported`, `contradicted` or `unknown`. For the last two a `<memory_check>` block after the memories tells the answering model not to use a near-miss memory as the answer. A failed or slow check is skipped. Off by default because it measured no gain |
| `recall.verify_max_memories / verify_timeout_ms` | 8 / 30000 | Memories shown to the check, and how long to wait for it |
| `recall.hard_trigger_max` | 3 | Most hard-trigger memories injected per message; tags now match on two-character tokens instead of raw substrings |
| `recall.cite_min_overlap / cite_min_shared` | 0.3 / 3 | How much of a fragment's two-character tokens must appear in a reply for `markCitedFromReply()` to count it as cited |
| `scribe.max_output_tokens` | 16384 | Output limit for one extraction batch. The original fixed 4096 was below what a 60-message batch needs (median about 5,500-6,100 tokens), so most batches were truncated and, before this fix, discarded. Truncated replies are now split in half and retried, so a lower limit costs extra calls rather than memories |
| `scribe.temperature` | 0.3 | Extraction temperature; 0 is allowed |
| `scribe.prompt` | `v2` | Extraction prompt. `v2` is the reorganized prompt (4,077 instead of 9,507 characters; records every concrete detail the user mentions and leaves duplicates to the deterministic deduplication). It extracts more, more consistently, and answered more questions correctly without inventing more. `legacy` is the original prompt, locked byte for byte by a test |
| `librarian.ranking` | `v2` | Retrieval ranking. `legacy` restores the original: entity channel injects its latest 10 fragments at fixed ranks, full-text-only hits ×0.7, time decay used as a score cutoff |
| `librarian.entity_boost` | 0.1 | Candidates already found by full text or vectors that link to an entity named in the message get relevance × (1 + boost). The user's and assistant's own names never trigger it |
| `librarian.fts_only_penalty` | 1.0 | Relevance multiplier for results found by full text only (no vector confirmation) |
| `librarian.decay_weight` | 0.05 | Exponent on time decay in the rank score. Decay only reorders, it never removes a result; 0 ignores time |
| `librarian.min_relevance` | 0.005 | Drop threshold on fused relevance (excluding decay, importance, novelty), so old but relevant memories are still returned |
| `librarian.candidate_overfetch` | 2 | Full text fetches this many times the limit, so boosting and time ordering can promote results from just outside the top |

#### Emotion engine (`emotion.*`)

| Key | Default | Purpose |
|---|---|---|
| `emotion.enabled` | true | Master switch. `false`: Scribe stops emitting emotion fields and nothing else in this section runs |
| `emotion.timezone` | `Asia/Taipei` | IANA timezone for time-of-day slots (morning 05-11, noon 11-17, evening 17-23, night 23-05) and weekday |
| `emotion.noise_floor` | 0.2 | Scores at or below this are background noise; subtracted before `intensity` / `valence` |
| `emotion.prior_mu` / `prior_sigma` | 0.2 / 0.15 | Population prior for a dimension's baseline and spread |
| `emotion.tau_hours` | 6 | Recovery time (prior only, not learned) |
| `emotion.obs_noise` | 0.07 | Kalman observation noise (std) |
| `emotion.shrink_slot_n0` / `shrink_user_n0` | 8 / 10 | Hierarchical shrinkage strength: slot baseline toward the user's own mean, user mean toward the population prior |
| `emotion.learning_min_samples` | 50 | Fewer informative fragments than this means "still learning" |
| `emotion.anomaly_sigma` | 2 | Deviation from the personal, time-of-day baseline that counts as an emotional turning point |
| `emotion.attribution_half_life_days` | 30 | Decay of the entity x emotion and topic x time-of-day statistics |
| `emotion.fade_half_life_neg_days` / `fade_half_life_pos_days` | 60 / 120 | Fading affect bias for ranking (negative fades faster); raw scores are never changed |

Scribe emits the eight scores (joy, trust, fear, surprise, sadness, disgust, anger, anticipation, each 0-1) and an `event_at` date for every fact in the same LLM call. Each fragment stores `raised_at` (earliest source message), `event_at`, `created_at`, plus local `raised_slot` and `weekday`. Read-only API (login required): `GET /api/emotion/baseline`, `/entities`, `/topic-slots`, `/anniversaries`, `/events`. Library entry points are in `services/hippocampus/amygdala/` (also reachable as `services/emotion/`) (`getAnniversaries(db, date)`, `effectiveIntensity(fragment, now)`).

---

## Assistant tools

The assistant gets four memory tools automatically:

- **`recall_memory`**: search memories by keyword, or trace a memory back to its source messages.
- **`browse_memories`**: browse constellations, open an entity, or search within one.
- **`update_current_state`**: record, update, or resolve a timed state about the user (up to 90 days), with optional recurring reminders.
- **`correct_memory`**: record a correction. Ten active corrections are merged into editing guidelines that are fed back into extraction.

---

## Testing

```bash
npm test                      # unit and characterization tests
node tests/smoke_memory.js    # memory pipeline smoke test (the ChromaDB check fails if Chroma is not running)
node scripts/e2e_ollama.js    # end-to-end run against a real local Ollama
```

### Retrieval evaluation

`eval/locomo_retrieval.js` loads each conversation straight into the memory store (no LLM extraction) and checks whether the evidence turns for each question come back in the top k. Datasets are not included in the repository:

- **LoCoMo**: download `locomo10.json` from [snap-research/locomo](https://github.com/snap-research/locomo) into `data/locomo/` (10 conversations, 1,986 questions).
- **Traditional Chinese synthetic set**: `eval/synth/generate_zh.py` has two Claude CLI instances chat across sessions while a third judges and corrects the dialogue and writes questions in LoCoMo format (the set used here: 3 conversations, 18 sessions, 144 questions). Point `LOCOMO_DATA` at the result.

```bash
node eval/locomo_retrieval.js --variants A,C    # A = product default without vectors, C = A plus a bge-m3 vector channel
node eval/locomo_aggregate.js                   # writes eval/results/retrieval_summary.{json,md}
node eval/locomo_tune.js eval/tune/grid1.json   # parameter sweeps via LIBRARIAN_OVERRIDE
```

Results for the product default (evidence found in the top 20, and mean reciprocal rank):

| Dataset | Variant | Legacy ranking | Ranking v2 |
|---|---|---|---|
| LoCoMo | A (no vectors) | 4.0%, MRR 0.034 | 67.4%, MRR 0.369 |
| LoCoMo | C (with vectors) | | 77.5%, MRR 0.441 |
| Chinese synthetic | A (no vectors) | 73.4%, MRR 0.303 | 95.0%, MRR 0.710 |
| Chinese synthetic | C (with vectors) | | 97.8%, MRR 0.739 |

The legacy ranking scored far below plain full-text search (MRR 0.370 on LoCoMo) because the entity channel filled the top ranks with each entity's latest fragments. Tuning notes are in `eval/results/ranking_tuning.md`, full tables in `eval/results/*/retrieval_summary.md`.

### End-to-end evaluation

`eval/locomo_e2e.js` runs the whole pipeline on one conversation: the Scribe extracts memories batch by batch (`extract`), then each question is answered from the memories the recall gate injects and graded by an LLM (`qa`). The `longctx` mode is a baseline that skips the memory system and puts the whole transcript in the prompt.

The extraction model, the answering model and the grader can be set separately (`E2E_LLM_BASE`/`E2E_MODEL`, `E2E_ANSWER_BASE`/`E2E_ANSWER_MODEL`, `E2E_JUDGE_BASE`/`E2E_JUDGE_MODEL`), so a comparison can change only the extractor. `eval/claude_shim.py` exposes the Claude CLI (`claude -p`) as a local OpenAI-compatible endpoint for these runs; it binds to 127.0.0.1 only and turns extended thinking off by default. Memories are sent to Anthropic in plain text this way, so use it with synthetic or public data only.

```bash
python3 eval/claude_shim.py                                   # 127.0.0.1:18765
E2E_LLM_BASE=http://127.0.0.1:18765/v1 E2E_MODEL=haiku E2E_TAG=claude node eval/locomo_e2e.js extract 0
E2E_LLM_BASE=http://127.0.0.1:18765/v1 E2E_MODEL=haiku E2E_TAG=claude \
  E2E_ANSWER_BASE=http://127.0.0.1:18765/v1 E2E_ANSWER_MODEL=haiku node eval/locomo_e2e.js qa 0 C --vector
E2E_LLM_BASE=http://127.0.0.1:18765/v1 E2E_MODEL=haiku node eval/locomo_e2e.js longctx 0 LC
```

Results on the Traditional Chinese synthetic set (3 conversations of about 7.8k tokens each, 144 questions; `eval/synth/generate_zh.py --sessions 20` or `--sessions 60` makes longer ones). Answers were produced by Claude Haiku 4.5 and graded by Claude Sonnet; the memory system used full-text plus a bge-m3 vector channel:

| Setup | Correct | Time questions |
|---|---|---|
| Whole transcript in the prompt (no memory system) | 86% | 17/30 |
| Memory system, Claude Haiku extracting | 63–72% (4 runs) | 10–13/30 |
| Memory system, qwen3-8b (local, CPU) extracting | 40% | 0/30 |

What this shows:

- **The extraction model matters most.** The 8B model wrote about half as many memories and none of the dates, and took 3.7 hours on CPU for what Claude did in 4 minutes.
- **Extraction varies a lot between runs.** The same code on the same conversation scored 36 and 19 correct in two runs, a larger swing than any single change measured so far.
- **The memory system invents less.** On questions whose answer never came up it said "not mentioned" or corrected the detail 35/35 times; the whole-transcript baseline invented an answer twice.
- **Short histories do not need a memory system.** At under 10k tokens, putting the transcript in the prompt is simply more accurate.
- **Longer histories did not close the gap, up to about 80k tokens.** The same comparison on longer synthetic sets (two conversations each):

  | History length | Whole transcript | Memory system (two runs) | Gap |
  |---|---|---|---|
  | about 7.8k tokens (6 sessions) | 86% | 69% | 17 points |
  | about 26k tokens (20 sessions) | 81% | 71% | 10 points |
  | about 80k tokens (60 sessions) | 88% | 69% | 19 points |

  These memory-system rows use the original `legacy` extraction prompt; with the current default (`v2`) the short and long sets reach 79% and 78%. Claude Haiku answered just as well with an 80k-token transcript as with a short one, so no crossover appeared. What did change with length is invention: on questions whose answer never came up, the whole-transcript baseline made something up in 9 of 59 cases at 80k tokens (for example giving one dog's allergy to another dog, or one weekday's class price for another weekday), while the memory system answered correctly 118/118 times. The memory system's losses are concentrated in multi-hop questions (43% vs 94%) and single facts the extractor skipped (70% vs 96%), which points back at extraction rather than retrieval.
- **The original extractor silently dropped most batches.** Its 4,096-token output limit truncated most replies, a truncated reply discarded the whole batch, and the next successful batch moved the cursor past it. With that limit reproduced, only 13% of the evidence was ever stored. The evaluation shim had not applied the limit, so earlier runs did not show this. After the fix the same setup keeps 79%. See [Verification details](#verification-details).
- **A shorter, consistent extraction prompt helps most.** Prompt v2, now the default, raised the short set from 69% to 79% (the whole-transcript baseline is 86%) and the long set from 71% to 78% (baseline 81%). It also made extraction steadier: evidence coverage went from 78% ± 11% to 86% ± 8% across repeated runs. It stores about 25% more memories without inventing more answers.
- **The apparent lure-question problem was a grading artifact.** Trick questions such as "Is her pottery class on Saturday morning?" (it is on Sunday) were first graded as correct only when the answer was a refusal, so "No, it is on Sunday morning" counted as wrong. Graded so that rejecting or correcting the false premise also counts, every memory-system setup scores 94-100% on these questions, and the earlier "v2 drops lure questions from 78% to 65%" disappears (71/74 for both prompts on the long set). All tables now use this rule.
- **The pre-answer check (CA1) did not help.** With lure questions already near 100%, it has nothing left to fix there, and on answerable questions it was within run-to-run noise on the short set (117/144 against 111 and 116) and slightly lower on the long set (75% and 74% against 80% and 75%). It stays available as `recall.verify` but off.
- **The time fix helped time questions slightly** (22/60 to 26/60 over two runs each); the overall score did not move beyond run-to-run noise.


### Verification details

The numbers behind the summary above. Every setup used the same questions; only the part named in the "Setup" column changed. The raw per-question results (questions, gold answers, model answers, both grades, retrieved memories) stay outside the repository with the datasets.

How a run is checked:

1. **Extraction**: the Scribe processes the conversation in batches of up to 60 messages; every stored memory must quote its source message word for word.
2. **Recall**: for each question the recall gate decides whether to search, then full text and the vector channel retrieve memories, which are injected with their conversation dates.
3. **Answering**: Claude Haiku answers from the injected memories only, or says "not mentioned".
4. **Grading**: an LLM compares the answer with the gold answer. Unanswerable questions (a premise that is wrong or never came up) count as correct when the answer says it is not mentioned or explicitly rejects or corrects the premise, and wrong when it answers as if the premise were true.
5. **Tracing**: each question's evidence turns are checked against the turns the stored memories quote and the memories that were retrieved, which locates where a wrong answer lost the information.

#### Datasets

All three sets were generated with `eval/synth/generate_zh.py`: two Claude Haiku instances chat as the user and the assistant, and Claude Sonnet plans the timeline, edits contradictions and writes the questions. Each session has 16 messages.

| Set | Conversations | Sessions each | Messages each | Transcript size | Questions | Multi-hop | Time | Reasoning | Single fact | Unanswerable | Generation cost (API-equivalent) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Short | 3 | 6 | 96 | about 7.8k tokens | 144 | 21 | 30 | 9 | 49 | 35 | $5.91 |
| Long | 2 | 20 | 320 | about 26k tokens | 123 | 16 | 24 | 7 | 39 | 37 | $5.59 |
| Very long | 2 | 60 | 960 | about 80k tokens | 238 | 34 | 48 | 13 | 84 | 59 | $22.08 |

#### Accuracy by question type

Graded by Claude Sonnet (see the grader comparison below). Answers were always produced by Claude Haiku 4.5; the memory system used full text plus a bge-m3 vector channel. "Unanswerable" counts answers that say "not mentioned" or reject the false premise. The CA1 rows reuse the memories extracted in the prompt v2 runs, so they differ from those runs only by the check and by answering noise. Rows without "prompt v2" used the `legacy` extraction prompt.

| Set | Setup | Overall | Multi-hop | Time | Reasoning | Single fact | Unanswerable |
|---|---|---|---|---|---|---|---|
| Short | Whole transcript in the prompt | **124/144 (86%)** | 18/21 (86%) | 17/30 (57%) | 8/9 (89%) | 48/49 (98%) | 33/35 (94%) |
| Short | Memory system, Claude extracting, before time fix, run 1 | **104/144 (72%)** | 15/21 (71%) | 10/30 (33%) | 8/9 (89%) | 36/49 (73%) | 35/35 (100%) |
| Short | Memory system, Claude extracting, before time fix, run 2 | **92/144 (64%)** | 12/21 (57%) | 12/30 (40%) | 5/9 (56%) | 29/49 (59%) | 34/35 (97%) |
| Short | Memory system, Claude extracting, after time fix, run 1 | **97/144 (67%)** | 11/21 (52%) | 13/30 (43%) | 4/9 (44%) | 35/49 (71%) | 34/35 (97%) |
| Short | Memory system, Claude extracting, after time fix, run 2 | **102/144 (71%)** | 12/21 (57%) | 13/30 (43%) | 8/9 (89%) | 35/49 (71%) | 34/35 (97%) |
| Short | Memory system, qwen3-8b extracting (local CPU) | **59/144 (41%)** | 4/21 (19%) | 0/30 (0%) | 3/9 (33%) | 17/49 (35%) | 35/35 (100%) |
| Short | Memory system, Claude extracting, prompt v2, run 1 | **111/144 (77%)** | 15/21 (71%) | 18/30 (60%) | 7/9 (78%) | 36/49 (73%) | 35/35 (100%) |
| Short | Memory system, Claude extracting, prompt v2, run 2 | **116/144 (81%)** | 17/21 (81%) | 19/30 (63%) | 6/9 (67%) | 41/49 (84%) | 33/35 (94%) |
| Short | Prompt v2 run 1 memories + CA1 check | **117/144 (81%)** | 16/21 (76%) | 18/30 (60%) | 6/9 (67%) | 42/49 (86%) | 35/35 (100%) |
| Long | Whole transcript in the prompt | **100/123 (81%)** | 13/16 (81%) | 11/24 (46%) | 5/7 (71%) | 36/39 (92%) | 35/37 (95%) |
| Long | Memory system, Claude extracting, run 1 | **89/123 (72%)** | 9/16 (56%) | 12/24 (50%) | 3/7 (43%) | 30/39 (77%) | 35/37 (95%) |
| Long | Memory system, Claude extracting, run 2 | **85/123 (69%)** | 7/16 (44%) | 8/24 (33%) | 3/7 (43%) | 31/39 (79%) | 36/37 (97%) |
| Long | Memory system, Claude extracting, prompt v2, run 1 | **99/123 (80%)** | 10/16 (62%) | 12/24 (50%) | 4/7 (57%) | 37/39 (95%) | 36/37 (97%) |
| Long | Memory system, Claude extracting, prompt v2, run 2 | **92/123 (75%)** | 11/16 (69%) | 10/24 (42%) | 3/7 (43%) | 33/39 (85%) | 35/37 (95%) |
| Long | Prompt v2 run 1 memories + CA1 check | **92/123 (75%)** | 10/16 (62%) | 9/24 (38%) | 5/7 (71%) | 33/39 (85%) | 35/37 (95%) |
| Long | Prompt v2 run 2 memories + CA1 check | **91/123 (74%)** | 10/16 (62%) | 11/24 (46%) | 4/7 (57%) | 30/39 (77%) | 36/37 (97%) |
| Very long | Whole transcript in the prompt | **210/238 (88%)** | 32/34 (94%) | 35/48 (73%) | 12/13 (92%) | 81/84 (96%) | 50/59 (85%) |
| Very long | Memory system, Claude extracting, run 1 | **167/238 (70%)** | 16/34 (47%) | 27/48 (56%) | 7/13 (54%) | 58/84 (69%) | 59/59 (100%) |
| Very long | Memory system, Claude extracting, run 2 | **161/238 (68%)** | 13/34 (38%) | 22/48 (46%) | 8/13 (62%) | 59/84 (70%) | 59/59 (100%) |

#### Extraction stability: prompt v2 versus legacy

Extraction only (no answering), short set, each prompt run three times on each of the three conversations. "Evidence recall" is the share of the questions' evidence turns that at least one stored memory quotes; "run-to-run agreement" is the Jaccard overlap of the covered evidence turns between runs of the same conversation. Produced by `eval/stability_report.py`.

| Prompt | Prompt length | Memories per conversation | Evidence recall | Worst run | Run-to-run agreement |
|---|---|---|---|---|---|
| legacy | 9,507 characters (about 5.4k tokens) | 46.6 | 77.8% ± 11.4% | 48.1% | 78.1% |
| v2 | 4,077 characters (about 2.3k tokens) | 57.9 | 85.9% ± 8.4% | 73.1% | 91.9% |

#### Output truncation: before and after the fix

Extraction only, short set, default prompt, two runs per row. The Claude CLI cannot cap its output, so the shim was run with `SHIM_ENFORCE_MAX_TOKENS=1`: when a reply exceeds the requested `max_tokens` it is cut proportionally and returned with `finish_reason: "length"`, as a real API would.

| Code | Output limit | Batches lost | Batches split and retried | Model calls | Memories stored | Evidence recall |
|---|---|---|---|---|---|---|
| Before the fix | 4,096 | 8 of 12 | — | 21 | 49 | 13.1% ± 13.8% |
| After the fix | 4,096 | 0 of 12 | 8 | 30 | 252 | 79.0% ± 4.3% |
| After the fix | 16,384 (new default) | 0 of 12 | 0 | 12 | 260 | 79.4% ± 10.1% |

#### Memory system runs in detail

Each row is one conversation in one run. "Evidence turns covered" is how many dialogue turns at least one stored memory quotes. Wrong answers are split by where the evidence was lost: never extracted, extracted but not retrieved, or retrieved but answered wrongly.

| Set | Run | Conversation | Memories stored | Evidence turns covered | Correct | Lost at extraction | Lost at retrieval | Lost at answering |
|---|---|---|---|---|---|---|---|---|
| Short | Claude extracting, before time fix, run 1 | zh-1 | 53 | 37/96 | 36/48 (75%) | 1 | 4 | 7 |
| Short | Claude extracting, before time fix, run 1 | zh-2 | 40 | 26/96 | 34/48 (71%) | 6 | 1 | 7 |
| Short | Claude extracting, before time fix, run 1 | zh-3 | 37 | 31/96 | 34/48 (71%) | 5 | 1 | 8 |
| Short | Claude extracting, before time fix, run 2 | zh-1 | 26 | 20/96 | 19/48 (40%) | 11 | 3 | 15 |
| Short | Claude extracting, before time fix, run 2 | zh-2 | 64 | 40/96 | 37/48 (77%) | 2 | 3 | 6 |
| Short | Claude extracting, before time fix, run 2 | zh-3 | 44 | 31/96 | 35/48 (73%) | 5 | 2 | 4 |
| Short | Claude extracting, after time fix, run 1 | zh-1 | 40 | 29/96 | 26/48 (54%) | 10 | 1 | 11 |
| Short | Claude extracting, after time fix, run 1 | zh-2 | 52 | 31/96 | 36/48 (75%) | 3 | 3 | 6 |
| Short | Claude extracting, after time fix, run 1 | zh-3 | 35 | 30/96 | 35/48 (73%) | 5 | 1 | 6 |
| Short | Claude extracting, after time fix, run 2 | zh-1 | 46 | 34/96 | 36/48 (75%) | 3 | 1 | 7 |
| Short | Claude extracting, after time fix, run 2 | zh-2 | 36 | 25/96 | 30/48 (62%) | 8 | 1 | 9 |
| Short | Claude extracting, after time fix, run 2 | zh-3 | 39 | 30/96 | 35/48 (73%) | 5 | 2 | 5 |
| Short | qwen3-8b extracting (local CPU) | zh-1 | 18 | 16/96 | 19/48 (40%) | 12 | 1 | 15 |
| Short | qwen3-8b extracting (local CPU) | zh-2 | 16 | 13/96 | 17/48 (35%) | 20 | 1 | 10 |
| Short | qwen3-8b extracting (local CPU) | zh-3 | 36 | 28/96 | 22/48 (46%) | 10 | 2 | 14 |
| Long | Claude extracting, run 1 | zh-11 | 148 | 105/320 | 46/63 (73%) | 2 | 5 | 7 |
| Long | Claude extracting, run 1 | zh-12 | 175 | 117/320 | 36/60 (60%) | 3 | 4 | 11 |
| Long | Claude extracting, run 2 | zh-11 | 172 | 119/320 | 44/63 (70%) | 3 | 3 | 9 |
| Long | Claude extracting, run 2 | zh-12 | 168 | 99/320 | 35/60 (58%) | 5 | 4 | 13 |
| Very long | Claude extracting, run 1 | zh-21 | 329 | 236/960 | 86/120 (72%) | 20 | 12 | 2 |
| Very long | Claude extracting, run 1 | zh-22 | 395 | 281/960 | 81/118 (69%) | 11 | 17 | 9 |
| Very long | Claude extracting, run 2 | zh-21 | 325 | 236/960 | 81/120 (68%) | 24 | 9 | 6 |
| Very long | Claude extracting, run 2 | zh-22 | 367 | 261/960 | 79/118 (67%) | 11 | 12 | 15 |

#### Unanswerable questions: refusal-only versus premise-aware grading

Most unanswerable questions are lures: they change one detail of a real fact ("Is the baking class on Thursday evening?" when it is on Friday). The first grading rule accepted only a refusal; the current rule also accepts an answer that rejects or corrects the premise, and was applied by Claude Sonnet to the same answers.

| Set | Setup | Refusal only | Premise-aware |
|---|---|---|---|
| Long | Whole transcript in the prompt | 28/37 | 35/37 |
| Long | Memory system, legacy prompt, two runs | 58/74 (78%) | 71/74 (96%) |
| Long | Memory system, prompt v2, two runs | 48/74 (65%) | 71/74 (96%) |
| Long | Prompt v2 memories + CA1 check, two runs | 54/74 (73%) | 71/74 (96%) |
| Very long | Whole transcript in the prompt | 39/59 | 50/59 |
| Very long | Memory system, legacy prompt, two runs | 117/118 | 118/118 |

On the short set the two rules differ by at most one question per run.

#### Pre-answer check (CA1)

`recall.verify=true`, answering with the memories already extracted in the prompt v2 runs (two long-set runs, one short-set run). The check ran on 185 of the 390 questions; the others had no concrete detail or no retrieved memory. Its verdicts were mostly right: 17 of the 74 long-set lure questions were judged `contradicted` with the correct differing detail (Saturday vs Sunday, 1,500 vs 2,000), and the answers then corrected the premise. But the answers without the check already did the same, so the score did not move. On answerable questions the check occasionally talked the answerer out of a correct answer (for example judging "which evening does she jog now" as contradicted because older memories named another day), which, together with answering noise, explains the slightly lower long-set score. Extra cost: one short model call (at most eight memories) per checked question.

#### Grader comparison

Every run was graded twice: by Claude Haiku during the run, and afterwards by Claude Sonnet reviewing all answers of a conversation at once. Haiku is stricter (it marks answers with extra correct detail as wrong). Comparisons between setups hold under either grader. This table uses the original refusal-only rule for unanswerable questions in both columns.

| Set | Setup | Haiku grader | Sonnet grader | Agreement |
|---|---|---|---|---|
| Short | Whole transcript in the prompt | 116/144 (81%) | 124/144 (86%) | 92% |
| Short | Memory system, Claude extracting, before time fix, run 1 | 93/144 (65%) | 104/144 (72%) | 92% |
| Short | Memory system, Claude extracting, before time fix, run 2 | 87/144 (60%) | 91/144 (63%) | 96% |
| Short | Memory system, Claude extracting, after time fix, run 1 | 89/144 (62%) | 97/144 (67%) | 92% |
| Short | Memory system, Claude extracting, after time fix, run 2 | 98/144 (68%) | 101/144 (70%) | 92% |
| Short | Memory system, qwen3-8b extracting (local CPU) | 57/144 (40%) | 58/144 (40%) | 98% |
| Long | Whole transcript in the prompt | 88/123 (72%) | 93/123 (76%) | 96% |
| Long | Memory system, Claude extracting, run 1 | 74/123 (60%) | 82/123 (67%) | 93% |
| Long | Memory system, Claude extracting, run 2 | 75/123 (61%) | 79/123 (64%) | 93% |
| Very long | Whole transcript in the prompt | 199/238 (84%) | 199/238 (84%) | 97% |
| Very long | Memory system, Claude extracting, run 1 | 166/238 (70%) | 167/238 (70%) | 97% |
| Very long | Memory system, Claude extracting, run 2 | 156/238 (66%) | 160/238 (67%) | 95% |

Cost of all end-to-end runs above, at API-equivalent prices through the Claude CLI: about $34 for generating the three sets and about $15 for extraction, answering and grading.

---

## Known limitations

- **Mixed scripts in search (mitigated).** Indexing and querying fold Simplified and Traditional characters together (character-by-character, `utils/zhNormalize.js`), so a Traditional query finds Simplified fragments and vice versa. Folding is per character, not per word, so regional vocabulary differences (e.g. 软件 / 軟體) are not bridged. Existing databases rebuild their search index once on the first start after upgrading.
- **Local models need a context of at least 8k tokens.** The Scribe extraction prompt is about 5.4k tokens with `scribe.prompt=legacy` (about 2.3k with `v2`) (Traditional Chinese tokenizes about 10% longer than Simplified). With Ollama's default `num_ctx` of 4096 the prompt is silently truncated and an 8B model stops returning `type`/`quote`, so every entry is dropped. Create a model variant with `PARAMETER num_ctx 8192` (or set `OLLAMA_CONTEXT_LENGTH`).
- **Assistant replies get extracted.** In testing with an 8B local model, half of the extracted fragments were the assistant's own small talk. The small-talk word list is Chinese only, so English small talk is not filtered.
- **Extraction is tuned for Chinese.** The 60-character limit on verbatim quotes is too short for English sentences, and the Scribe reserves up to 16,384 output tokens (`scribe.max_output_tokens`), more than an 8k-context local model has; lower it there and let truncated batches be split.
- **Messages sent in the same second can be skipped.** The extraction cursor is a timestamp and the next run reads messages strictly after it, so a message with exactly the same timestamp as the last processed one is never extracted.
- **Extraction is unstable and drops details.** With the default prompt, two runs of the same conversation can differ by a dozen memories, and small details (who did a chore, the name of a stretching exercise) are often skipped. The default `v2` prompt reduces both but does not remove them. See [Verification details](#verification-details).
- **English conversations are stored in Chinese.** The Scribe prompt is written in Chinese, so English conversations end up as Chinese memories that English questions rarely match. End-to-end evaluation on LoCoMo is paused until this and the quote length are fixed.
- **Entity resolution is broken upstream.** `entityResolver.js` reads a column `related_entity_ids` that no migration creates.
- **The vector channel needs ChromaDB.** Without it, search falls back to full text and entities only.
- **The blind index leaks frequency.** The same two-character token always hashes to the same value within a column, so token frequencies and shared tokens between rows are visible to someone holding the database file.
- **Persona drift checks are subjective and noisy.** The probe questions (`services/hippocampus/cortex/persona/probes.json`) are a proxy for character, and a small local model answers differently from run to run. Mitigations: temperature 0, optional `persona.drift_samples` averaging, and a confirmation re-run before any rollback. A rollback only touches the relationship layer, not the raw stable traits that are also injected into the prompt.
- **Foreign keys are off.** Some child tables lack `ON DELETE` rules, so enabling them would break existing deletes.

---

## Acknowledgments

Many thanks to Clara Shafiq and Draco Malfoy for open-sourcing Memory Constellations. The core ideas of this project come from their work:

- **The extract, organize, and retrieve pipeline**: the division of labor between Scribe, Archivist, and Librarian.
- **The three-field entity model**: facts, current status, and judgment are updated separately.
- **The retrieval design**: full-text, vector, and entity channels fused with RRF, ranked by freshness and emotional intensity.
- **The memory star map**: memories shown as galaxies, constellations, and bridges, each traceable to its source conversation.
- **The lifecycle and correction flow**: memories cool, freeze, and expire, and user corrections accumulate into editing guidelines.
- The authors' emotional state engine, [jiwen](https://github.com/ClaraShafiq/jiwen), is a separate project.

This version would not exist without the foundation they built. The original documentation is available in the [upstream repository](https://github.com/ClaraShafiq/MemoryConstellations#readme).

## Changes from the original

| Area | Change |
|---|---|
| Tests | Added `npm test` with characterization and unit tests for encryption, retrieval, lifecycle, corrections, Chinese search, extraction quality, the SSRF guard, and token budgets |
| Encryption | Fail-closed, v2 format with associated data and key rotation, v1 still readable, no per-call logging |
| Chinese search | Overlapping two-character tokens for indexing and querying, with bm25 ranking; episode titles and tags are now tokenized too |
| Extraction | Verbatim quotes checked in code; cross-day deduplication that adds evidence and never merges facts differing in numbers, weekdays, or nouns |
| Security | SSRF fix for all user-supplied endpoints, with DNS resolution, redirect refusal, and IP pinning |
| Local models | Ollama setup preset, no auth header without a key, longer local timeouts, fallback to the default model config |
| Resources | Deep-cycle memory threshold and memory token budget are configurable |
| Structure | The 311 KB Archivist and 157 KB cognitive-model files were split into focused modules of at most 40 KB each, verified to be a pure move |
| Retrieval ranking | Ranking v2 (entity boost, no full-text penalty, decay orders only), with a LoCoMo and Traditional Chinese retrieval benchmark |
| Time information | Messages reach the extractor in local time with the weekday (they were in UTC), each memory keeps the date of the message its quote came from, and injected memories show that date instead of "0 days ago" |
| Extraction reliability | Truncation-tolerant parsing and halving instead of discarding a batch; failed batches stop the run instead of being skipped (parse failures shrink the batch and finally skip a single unreadable message, connection failures only wait); each batch gets its own preceding messages as context; chat mode decided from the batch itself; output limit and temperature configurable |
| Extraction prompt | Reorganized Scribe prompt, now the default: half the length, one consistent coverage rule, same output format; the original stays available as `scribe.prompt=legacy` and is locked byte-for-byte by a test |
| Pre-answer check | Optional CA1 comparator (`recall.verify`): checks the question's concrete details against the retrieved memories before answering; off by default |
| Evaluation | End-to-end runner with separately configurable extractor, answerer and grader, a long-context baseline, a Claude CLI shim, and premise-aware grading of trick questions |
| Dependencies | `better-sqlite3` upgraded to 12 for prebuilt Node 24 binaries; license field corrected from ISC to MIT |

## License

MIT. See [LICENSE](LICENSE). The original copyright of Clara Shafiq & Draco Malfoy is retained alongside the copyright for this adaptation.
