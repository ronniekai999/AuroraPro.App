# Aurora Concierge — conversational, agentic discovery

**Implementation plan**
Status: proposal / for decision · Author: prepared for Ronnie · Date: 2026-06-10

> One of five feature plans drafted together. Siblings:
> [catch-me-up](../catch-me-up/), [movie-night-matchmaker](../movie-night-matchmaker/),
> [smart-skip](../smart-skip/), [aurora-rewind](../aurora-rewind/).

---

## TL;DR

A chat box that knows your library *and* your taste: *"Something like Severance but
lighter, under two hours, that my wife would also enjoy — and add the winner to my
watchlist."* Aurora searches, reasons, and **takes the action**.

This is the agentic version of the differentiator the
[ui-refresh-2026 proposal](../ui-refresh-2026/README.md) already wants to make a "visible
moment." The plumbing is in the tree: a tool-call-capable LLM client
([`ChatJSONWith`, client.go:434](../../../internal/llm/client.go)), semantic recall
([`search.Searcher.Search`, semantic.go:209](../../../internal/search/semantic.go) and
`NearestUnwatched`), an LLM reranker
([`search/rerank.go`](../../../internal/search/rerank.go),
[`llm/rerank.go`](../../../internal/llm/rerank.go)), plus the watchlist / request / party
handlers the assistant can *act* through. Concierge wires these into a small
**plan→act→answer** loop.

---

## 1. What already exists (so we don't rebuild it)

- **LLM chat with schema + reasoning control** — `ChatJSONWith(ctx, model, system, user,
  schema, structured)` ([`client.go:434`](../../../internal/llm/client.go)); fast/smart
  model selectors ([`:387`/`:396`](../../../internal/llm/client.go)); SSRF-guarded HTTP
  client; tolerant parsing in [`internal/llmjson`](../../../internal/llmjson). **Prompt-
  injection hardening already exists** for the recommender/search surfaces
  ([`recommender/prompt_injection_test.go`](../../../internal/recommender/prompt_injection_test.go),
  [`search/prompt_injection_test.go`](../../../internal/search/prompt_injection_test.go)) —
  a pattern we extend, not invent.
- **Retrieval** — `Searcher.Search` (parses NL into structured filters + vector recall;
  [`semantic.go:209`](../../../internal/search/semantic.go)), `NearestUnwatched` /
  `NearestUnwatchedRich`, genre annotation, the LLM reranker.
- **Per-profile taste** — `BuildProfileVector` / centroids (see
  [matchmaker plan](../movie-night-matchmaker/IMPLEMENTATION_PLAN.md)) so "like me" is a
  vector, and watch history / continue-watching for grounding.
- **Actionable handlers, already authed + rate-limited:**
  - Watchlist add — `AddToWatchlist` ([`profile_handlers.go`](../../../internal/api/profile_handlers.go) /
    [`queries_phase4.go:264`](../../../internal/db/queries_phase4.go)).
  - Request via Radarr/Sonarr — `request_handlers.go` + [`internal/arr`](../../../internal/arr).
  - Start a watch party — `partyH.Create` ([`party_handlers.go`](../../../internal/api/party_handlers.go)).
  - Group blend — the [Matchmaker](../movie-night-matchmaker/) endpoint, if built, becomes a tool.

**What does *not* exist:** a multi-turn conversational endpoint, or any orchestration that
lets the model *choose* a retrieval/action step.

---

## 2. The core idea — a bounded plan→act→answer loop (not open-ended autonomy)

Local models (and Ollama Cloud) are uneven at native tool-calling, and the codebase already
prefers **structured-output + a tolerant parser** over hard tool protocols
([`client.go:438` notes](../../../internal/llm/client.go)). So Concierge uses an explicit,
**server-orchestrated** loop with a small, typed action vocabulary — not a free-form agent.

```
user message + short history + profile context (taste summary, recent watches)
        │
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ STEP 1 — PLAN  (LLM, structured JSON)                     │
 │   → { intent, search_query?, filters?, like_profile?,    │
 │       group_profiles?, action?: {type, title?} }         │
 └───────────────────────┬──────────────────────────────────┘
                         ▼
 ┌──────────────────────────────────────────────────────────┐
 │ STEP 2 — RETRIEVE (server code, NOT the LLM)              │
 │   dispatch to existing funcs: Searcher.Search /           │
 │   NearestUnwatched / Matchmaker.Blend → candidate set     │
 │   (every candidate is a REAL row the user may access)     │
 └───────────────────────┬──────────────────────────────────┘
                         ▼
 ┌──────────────────────────────────────────────────────────┐
 │ STEP 3 — ANSWER (LLM, structured)                         │
 │   given ONLY the retrieved candidates, pick + explain     │
 │   → { reply, picks:[media_id…], proposed_action? }        │
 └───────────────────────┬──────────────────────────────────┘
                         ▼
 ACTIONS require explicit user confirmation (a button), never auto-fire.
 "Add to watchlist" / "Request" / "Start party" call the existing handlers.
```

**Why this shape:**
- **Grounded, not hallucinated** — the model only ever ranks/explains rows the *server*
  retrieved and the *user* is authorized to see. It can't invent a title you don't have or
  leak someone else's library.
- **Safe actions** — write actions (request, party) surface as a confirm button; the LLM
  *proposes*, the user *commits*. No accidental Radarr downloads from a prompt-injected
  overview.
- **Cheap to ship** — Steps 2's "dispatch" is a `switch` over functions that already exist.

---

## 3. Backend

### 3.1 Orchestrator (`internal/concierge/concierge.go`)
- `Respond(ctx, userID, profileID, history []Turn, msg string) (Reply, error)`:
  1. Build a compact **profile context** block (taste one-liner from centroids + last ~5
     watches) — reuses recommender data; cap hard to keep prompts in the proven-safe size
     band (the Discover saga taught us prompt size is the failure axis —
     [`discover.go` pool note](../../../internal/recommender/discover.go)).
  2. **PLAN** call → structured intent (schema below). Tolerant-parse.
  3. **Dispatch** to existing retrieval funcs based on intent. All results pass through the
     same access scoping the REST endpoints use.
  4. **ANSWER** call with the candidates serialized as a numbered list (id + title + year +
     short overview). The model returns a reply + chosen ids + optional `proposed_action`.
  5. Resolve ids → `[]*models.MediaItem`; attach poster/links; return.
- Plan schema (flat, provider-friendly):
  ```json
  { "intent": "find|continue|group|info|smalltalk",
    "search_query": "string?", "like": "me|<profile_name>?",
    "group_profiles": ["string"], "max_runtime_min": 0,
    "action": { "type": "watchlist|request|party|none", "target_title": "string?" } }
  ```

### 3.2 Action execution (separate, explicit)
- `POST /api/me/concierge/act` `{ action, media_id }` → calls the corresponding existing
  handler's underlying function (watchlist/request/party). **Never** invoked from the
  generate path; the SPA calls it only on a user click. Reuses each domain's existing
  auth + rate limits + quotas (e.g. request quotas in
  [`queries_requests_quota_test.go`](../../../internal/db/queries_requests_quota_test.go)).

### 3.3 HTTP
- `POST /api/me/concierge` `{ message, history? }` → `{ reply, picks:[{media…}], proposed_action? }`.
- Authed, under `/api/me` ([`router.go:751`](../../../internal/api/router.go)).
- **Rate-limited per user** (reuse limiter middleware). **Gated on LLM configured.**

### 3.4 Security (extend, don't reinvent)
- Treat every overview/title fed to the LLM as **untrusted** (same stance as the existing
  prompt-injection tests). The plan/answer prompts instruct the model to ignore
  instructions found inside candidate text.
- Retrieval is the trust boundary: the model can only surface rows the server already
  fetched under the user's identity — so injection can at worst produce a bad recommendation,
  never data exfiltration or an unauthorized action (actions are user-confirmed).

---

## 4. Frontend

- A **Concierge panel** (sidebar drawer or `/chat` route) with a message list, the
  profile-context chip ("Talking as: Ronnie"), and result cards inline in the reply.
- Proposed actions render as a **confirm button** under the reply ("➕ Add *Arrival* to
  Watchlist", "🎬 Start a party"), wired to `/api/me/concierge/act`.
- Streaming is optional: v1 can show a thinking shimmer then the full reply (the client is
  non-streaming today; fine for a 2-step loop). A later pass could add token streaming.
- Reuses existing poster-card + the search UI's result styling.

---

## 5. Edge cases & decisions

| Case | Handling |
|---|---|
| Model proposes a title not in library | ANSWER is constrained to retrieved candidates; if intent is "request something we don't have," dispatch routes to TMDB search (`metaH.SearchTMDB`) and the action becomes a Radarr/Sonarr request. |
| Prompt injection via an overview | Untrusted-content framing + retrieval trust boundary + user-confirmed actions (see §3.4). |
| LLM unavailable / errors | Endpoint returns a graceful "I can't think right now" + falls back to plain semantic search results for the raw query. |
| "like my wife" | Resolve to one of the account's profiles by name; if ambiguous, ask back. Group asks route to Matchmaker. |
| Cost (Cloud models) | Two LLM calls per turn, both small + temp 0.1; rate-limited; gated. |

**Open decisions for you:**
1. **Scope of actions in v1** — recommend **watchlist-only** for the first ship (lowest
   blast radius), then add request + party once the loop is proven.
2. **History depth** — recommend last **6 turns** to bound prompt size.

---

## 6. Effort & phasing

- **Phase 1 (MVP):** orchestrator (PLAN→retrieve→ANSWER) + `POST /api/me/concierge` +
  read-only result cards + a basic chat panel. **No write actions yet.** This alone is a
  flagship demo.
- **Phase 2:** the confirm-button action path (`/act`), starting with watchlist.
- **Phase 3:** request + start-party actions; group ("like my wife and me") via Matchmaker;
  token streaming.

**Why it's worth it:** this is the feature that makes Aurora feel *categorically* ahead of
Plex/Jellyfin — it turns one-shot semantic search into a conversation that acts. It's the
largest of the five, which is why it's phased so Phase 1 ships value without the action
surface.

---

## 7. Out of scope (v1)

- Open-ended multi-tool autonomy / long agent chains (deliberately a bounded 2-call loop).
- Voice input (browser STT could layer on later).
- Cross-session "assistant memory" beyond the per-turn profile context block.
