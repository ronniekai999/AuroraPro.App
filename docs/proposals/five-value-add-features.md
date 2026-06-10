# Five high-value feature proposals (2026-06)

Five features that lean on assets Aurora **already** has — the local-LLM layer
(embeddings, Discover/hero/rerank), per-profile taste centroids, the watch-party stack,
gamification, and the server-side image compositor — to do things mainstream media servers
(Plex/Jellyfin/Emby) can't. Each has its own implementation plan grounded in real
`file:line` references and the codebase's load-bearing constraints.

| # | Feature | One-liner | Leans on | Size | Plan |
|---|---------|-----------|----------|------|------|
| 1 | **Aurora Concierge** | Conversational, agentic discovery — chat that searches your library *and* takes actions | LLM client, semantic search + rerank, watchlist/request/party handlers | L (phased) | [plan](./aurora-concierge/IMPLEMENTATION_PLAN.md) |
| 2 | **Catch Me Up** → **“Previously”** ✅ **SHIPPED** | Spoiler-safe AI recaps when you resume a series after a gap | Episode overviews, per-profile `completed_at`, `ChatJSON` | **S** | [plan](./catch-me-up/IMPLEMENTATION_PLAN.md) |
| 3 | **Movie-Night Matchmaker** | Blend 2+ profiles' taste → picks everyone likes → start a party | Taste centroids, `NearestUnwatched`, party create | **S** | [plan](./movie-night-matchmaker/IMPLEMENTATION_PLAN.md) |
| 4 | **Smart Skip + Seamless Binge** ✅ **IMPLEMENTED** | Auto-detect intro/recap/credits; "Skip Intro" + auto-advance | FFmpeg pipeline, episode grouping, next-episode autoplay | M–L | [plan](./smart-skip/IMPLEMENTATION_PLAN.md) |
| 5 | **Aurora Rewind** | Shareable, AI-narrated "year in film" recap card | Watch history, gamification, embeddings, **party-share PNG renderer** | M | [plan](./aurora-rewind/IMPLEMENTATION_PLAN.md) |

## Why these five together

They cover the whole journey — **discovery** (#1), **re-engagement** (#2), **social/group**
(#3), **playback UX** (#4), and **retention/virality** (#5). Four of the five are
effectively impossible on Plex/Jellyfin because they depend on assets unique to Aurora:
the local LLM, per-user taste vectors, and the server-side image generator.

## Suggested order (highest ROI first)

1. ~~**#2 Catch Me Up**~~ → ✅ **shipped as “Previously”** (live on `aurorapro.app`).
2. **#3 Movie-Night Matchmaker** — tiny code, showcases the taste-vector moat, funnels into watch parties.
3. **#5 Aurora Rewind** — reuses the party-share renderer + gamification; high virality.
4. **#1 Aurora Concierge** — flagship, phased so Phase 1 (read-only) ships before the action surface.
5. ~~**#4 Smart Skip**~~ → ✅ **implemented** (pure-Go `xcorr-v1` detector — the DSP unknown is solved; see the [plan](./smart-skip/IMPLEMENTATION_PLAN.md)'s "what landed" block).

> These are **proposals for decision**, mirroring the format of the existing
> [`docs/proposals/`](.) entries (taste-onboarding, library-redesign, watch-party-chat).
> No application code is touched by these docs.
