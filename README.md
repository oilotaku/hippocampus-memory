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
| All Chinese text in code, prompts, and UI in Traditional Chinese (Simplified input still matches) | Done |
| Three-layer persona (core / relationship / situational) with versioned, reviewable, rollback-able relationship proposals | Working |
| Stable traits (confidence ≥ 0.7) and the relationship layer injected into the chat prompt under their own small token budget | Working |
| Entity `judgment` updated incrementally against the previous version (small edits with cited sources only) | Working |
| Daily persona drift check against anchor answers, with automatic rollback of the relationship layer | Working (embedding channel needs ChromaDB; falls back to bigram Jaccard) |
| Retrieval timing gate: skip memory lookup for greetings and commands, adaptive result count, context-triggered surfacing, upcoming-event reminders, capped hard triggers | Working (on by default; `recall.gate=false` restores the old behaviour) |
| `injected_count` (put in the prompt) split from `cited_count` (actually used) | Working; `cited_count` is fed by the `recall_memory` tool, and by `recallGate.markCitedFromReply()` for hosts that can pass the assistant's reply |

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
| `recall.hard_trigger_max` | 3 | Most hard-trigger memories injected per message; tags now match on two-character tokens instead of raw substrings |
| `recall.cite_min_overlap / cite_min_shared` | 0.3 / 3 | How much of a fragment's two-character tokens must appear in a reply for `markCitedFromReply()` to count it as cited |

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

---

## Known limitations

- **Mixed scripts in search (mitigated).** Indexing and querying fold Simplified and Traditional characters together (character-by-character, `utils/zhNormalize.js`), so a Traditional query finds Simplified fragments and vice versa. Folding is per character, not per word, so regional vocabulary differences (e.g. 软件 / 軟體) are not bridged. Existing databases rebuild their search index once on the first start after upgrading.
- **Local models need a context of at least 8k tokens.** The Scribe extraction prompt is about 5.4k tokens (Traditional Chinese tokenizes about 10% longer than Simplified). With Ollama's default `num_ctx` of 4096 the prompt is silently truncated and an 8B model stops returning `type`/`quote`, so every entry is dropped. Create a model variant with `PARAMETER num_ctx 8192` (or set `OLLAMA_CONTEXT_LENGTH`).
- **Assistant replies get extracted.** In testing with an 8B local model, half of the extracted fragments were the assistant's own small talk.
- **Entity resolution is broken upstream.** `entityResolver.js` reads a column `related_entity_ids` that no migration creates.
- **The vector channel needs ChromaDB.** Without it, search falls back to full text and entities only.
- **The blind index leaks frequency.** The same two-character token always hashes to the same value within a column, so token frequencies and shared tokens between rows are visible to someone holding the database file.
- **Persona drift checks are subjective and noisy.** The probe questions (`services/persona/probes.json`) are a proxy for character, and a small local model answers differently from run to run. Mitigations: temperature 0, optional `persona.drift_samples` averaging, and a confirmation re-run before any rollback. A rollback only touches the relationship layer, not the raw stable traits that are also injected into the prompt.
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
| Dependencies | `better-sqlite3` upgraded to 12 for prebuilt Node 24 binaries; license field corrected from ISC to MIT |

## License

MIT. See [LICENSE](LICENSE). The original copyright of Clara Shafiq & Draco Malfoy is retained alongside the copyright for this adaptation.
