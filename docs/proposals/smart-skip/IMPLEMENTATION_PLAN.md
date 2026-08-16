# Smart Skip + Seamless Binge — intro / recap / credits detection

**Implementation plan**
Status: ✅ **IMPLEMENTED** (all three phases, in one cut) · Author: prepared for Ronnie · Date: 2026-06-10

> One of five feature plans drafted together. Siblings:
> [aurora-concierge](../aurora-concierge/), [catch-me-up](../catch-me-up/),
> [movie-night-matchmaker](../movie-night-matchmaker/), [aurora-rewind](../aurora-rewind/).

> **Implemented — what landed (and where):**
> - migration [`043_skip_markers`](../../../migrations/043_skip_markers.up.sql) — `skip_markers` (per-file recap/intro/credits windows, `detector`-versioned, `manual` rows win) + the `skip_marker_analysis` ledger ("analyzed, nothing found" is sticky; a detector bump reprocesses everything).
> - [`internal/skipmarkers/`](../../../internal/skipmarkers/) — the pure-Go detector (decision: **no chromaprint dependency**): FFmpeg→mono-16 kHz PCM, Haitsma–Kalker spectral hash (own radix-2 FFT), cross-correlation of consecutive episodes with the ≥2-confirming-pairs season gate (`analyze.go`), `blackdetect`/`silencedetect` credits onset for episodes **and movies** (`credits.go`), and the sequential niced background worker (`worker.go`, detector `xcorr-v1`). Unit tests cover the FFT, alignment, season validation, recap/intro split, and credits parsing.
> - [`internal/db/queries_skipmarkers.go`](../../../internal/db/queries_skipmarkers.go) — marker CRUD, pending-season/movie fetches, coverage counts.
> - Markers ride the existing stream-info payload ([`GetStreamInfo`](../../../internal/api/phase2_handlers.go)) — no extra playback round-trip. Admin surface in [`skipmarker_handlers.go`](../../../internal/api/skipmarker_handlers.go): `GET /api/admin/skip-markers/status`, `POST …/sweep`, `GET/PUT/DELETE …/{fileID}` (manual correction / suppression / re-detect).
> - Triggers: boot sweep + `Scanner.OnScanComplete` hook + 6 h periodic tick ([`cmd/aurora/main.go`](../../../cmd/aurora/main.go)). Kill switch: server setting `skip_markers_enabled=false`.
> - Frontend ([`VideoPlayer.tsx`](../../../static/redesign/app/src/components/VideoPlayer.tsx)): **Skip Intro / Skip Recap** pill (advisory; party-guest- and cast-aware), credits-triggered **Next Episode** card driving the existing auto-advance path (5 s countdown with the autoplay pref on, explicit button when off), movie **Skip Credits**, and the admin in-player marker editor ("Start = now / End = now / Off / Auto"). Admin dashboard gets a Skip Analysis coverage tile (files analyzed, not markers found).

---

## TL;DR

Detect a series' repeated **intro theme** automatically (by listening for the audio
fingerprint that recurs across episodes), then show a **"Skip Intro"** button and
**auto-advance** through end credits into the next episode. The single most-requested
feature in self-hosted media communities — and the one most homegrown servers never ship.

**Aurora is well-placed:** the FFmpeg/ffprobe pipeline is already core
([`internal/streaming`](../../../internal/streaming), `EpisodeFile.Path` + `DurationMs`,
[`models.go:240`](../../../internal/models/models.go)), episodes are grouped by
season/series, and the **next-episode + autoplay** path already exists
([`GetNextEpisode`, phase2_handlers.go:177](../../../internal/api/phase2_handlers.go),
`StreamEpisodeFile` [`:898`](../../../internal/api/phase2_handlers.go)). We add an
**offline analysis job** that computes skip markers, plus a tiny endpoint + player overlay.

---

## 1. What already exists (so we don't rebuild it)

- **FFmpeg/ffprobe everywhere** — `TranscodeManager`, codec/duration probing, HLS
  segmenting ([`streaming.go`](../../../internal/streaming/streaming.go)). FFmpeg version
  detection (`ffmpegMajorVersion`, [`:1192`](../../../internal/streaming/streaming.go))
  shows we already shell to the toolchain and reason about its capabilities.
- **Episode grouping & files** — seasons/episodes (`GetSeasons`/`GetEpisodes`), file rows
  with `Path` + `DurationMs` (`EpisodeFile`, [`models.go:240`](../../../internal/models/models.go)),
  `GetEpisodeFiles` ([`phase2_handlers.go:235`](../../../internal/api/phase2_handlers.go)).
- **Seamless next-up** — `GetNextEpisode` + the player's episode streaming already chain
  episodes; "auto-advance" hangs off this with a credits marker.
- **Background-job posture** — the library scanner already does filesystem-watch + async
  scan with status endpoints (`libH.Scan` / `ScanStatus`,
  [`router.go:660`](../../../internal/api/router.go)), and the embedding backfill
  ([`embedding.RunBackfill`](../../../internal/embedding)) is a precedent for a throttled,
  resumable, versioned batch job over the library.
- **Cache dir + reaper conventions** — `/var/cache/aurora`, with reaper patterns in
  [`party_share.go:161`](../../../internal/api/party_share.go).

**What does *not* exist:** any per-episode timing markers (intro/recap/credits) or audio
fingerprinting.

---

## 2. The core idea — intros recur, so cross-correlate the audio

Within one series, the **intro theme is (near-)identical audio** across episodes. So we
don't need ML — we need to find the audio segment that two episodes of the same season
**share**. Approach, cheapest-first:

1. **Decode a cheap audio proxy** — FFmpeg-decode each episode's first ~5 minutes to mono
   16 kHz PCM (tiny; we already shell to FFmpeg). Optionally use **chromaprint** (`fpcalc`)
   to get a compact fingerprint stream if it's available on the host; otherwise fall back to
   a downsampled spectral signature computed in Go.
2. **Pairwise align consecutive episodes** — cross-correlate episode N's signature against
   N+1's to find the lag + window where they match strongly. That matching window **is the
   intro** (and, if present, the recap). Confirm across ≥2 pairs in the season to reject
   coincidences.
3. **Credits** — detect the end-credits onset from the tail (black-frame + audio-energy
   drop via FFmpeg `blackdetect`/`silencedetect`, or simply "last X% with credits-like
   characteristics"). v1 can ship a conservative heuristic: credits start ≈ where the next
   episode's intro-length worth of low-motion tail begins.

```
season S, episodes [E1..En] with files
        │  (offline job, throttled like the embedding backfill)
        ▼
for each Ei: ffmpeg → mono 16kHz PCM (first 5 min)  → signature_i
        │
        ▼
align(sig_i, sig_{i+1}) → shared window  ── confirmed across ≥2 pairs ──►  intro [start,end]
        │
        ▼
ffmpeg blackdetect/silencedetect on tail  →  credits_start
        │
        ▼
store markers per episode_file  →  player reads them  →  "Skip Intro" + auto-advance
```

No per-title configuration, no manual tagging, no cloud calls. Deterministic and offline.

---

## 3. Data model — markers per episode file

```sql
-- migrations/0NN_skip_markers.up.sql
CREATE TABLE skip_markers (
  episode_file_id BIGINT NOT NULL REFERENCES episode_files(id) ON DELETE CASCADE,
  kind            TEXT   NOT NULL,         -- 'recap' | 'intro' | 'credits'
  start_ms        BIGINT NOT NULL,
  end_ms          BIGINT NOT NULL,
  confidence      REAL   NOT NULL DEFAULT 0,
  detector        TEXT   NOT NULL,         -- 'xcorr-v1' | 'chromaprint-v1' | 'manual'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (episode_file_id, kind)
);
CREATE INDEX idx_skip_markers_pending ON episode_files(id)
  WHERE NOT EXISTS (SELECT 1 FROM skip_markers sm WHERE sm.episode_file_id = episode_files.id);
```

`detector` version lets us reprocess when the algorithm improves (same pattern as the
embedding `version` column, migration [016](../../../migrations/016_embedding_version_index.up.sql)).
A `manual` row supports admin correction later without a schema change.

---

## 4. Backend

### 4.1 Analysis package (`internal/skipmarkers/`)
- `AnalyzeSeason(ctx, seasonID) ([]Marker, error)` — orchestrates decode → align → detect
  for all episodes in a season (intros only make sense within a season's shared theme).
- `signature(path)` — FFmpeg decode to mono PCM proxy; build the compact signature
  (chromaprint via `fpcalc` if present, else Go spectral fallback). Capability-detect
  `fpcalc` the same way `ffmpegSupportsReadrate` probes FFmpeg
  ([`streaming.go:1180`](../../../internal/streaming/streaming.go)).
- `align(a, b)` — normalized cross-correlation → best lag + matched window + confidence.
- `creditsOnset(path, durationMs)` — `blackdetect`/`silencedetect` parse.
- **Throttling:** runs as a low-priority background worker (nice-d FFmpeg, bounded
  concurrency) so it never competes with live transcodes — mirror the backfill's pacing.

### 4.2 Job wiring
- Trigger after a library scan completes for a TV library (hook into `libH.Scan` completion)
  and on a periodic sweep for unmarked files (the partial index above finds them).
- Resumable + versioned: skip files that already have current-`detector` markers.
- Admin status surface alongside `embedding-status`
  ([`router.go:877`](../../../internal/api/router.go)) → `GET /api/admin/skip-markers/status`.

### 4.3 HTTP (playback)
- Return markers inside the existing stream-info payload (`GetStreamInfo`,
  [`router.go:706`](../../../internal/api/router.go)) **or** a dedicated
  `GET /api/stream/{fileID}/markers` → `[{kind,start_ms,end_ms}]`. Prefer folding into
  stream-info so the player gets markers in the call it already makes.

---

## 5. Frontend (player)

- **Skip Intro / Skip Recap** — when playback enters an `intro`/`recap` window, show a
  bottom-right "Skip Intro" button (auto-hides). Click → seek to `end_ms`.
- **Auto-advance** — when playback crosses `credits.start_ms` on a TV episode with a known
  next episode, show a "Next Episode ▶ (5s)" card that chains into the existing
  `GetNextEpisode` → `StreamEpisodeFile` flow. A user setting toggles auto vs. prompt.
- Player work lives in the redesigned player surface (see the
  [ui-refresh-2026 player mockup](../ui-refresh-2026/player/index.html)).

---

## 6. Edge cases & decisions

| Case | Handling |
|---|---|
| Single-episode season / specials | No pair to align → no intro marker (credits heuristic can still apply). Never guesses from one episode. |
| Cold-open-before-intro shows | The aligned shared window is the *theme*, wherever it sits; cold opens (unique audio) won't match and are correctly excluded. |
| "Previously on" recaps | Falls out naturally — recaps are *also* shared/repeated audio in some shows; tag the earlier shared window as `recap`, the later as `intro`. v1 may merge into one skip; phase 2 splits. |
| False positive | `confidence` gates display; require ≥2 confirming pairs. Markers are advisory (a button), never a forced seek. |
| HLS transcode vs. direct play | Markers are source-time offsets; the player maps them to the active timeline (same as chapter offsets). |
| Movies | Out of scope — TV-only (credits auto-skip for movies is a possible phase 3). |

**Open decision for you:** ship the **Go spectral fallback** (zero new system dependency) as
the baseline detector, and use **chromaprint/`fpcalc`** only when already installed?
Recommend yes — keeps the bare-metal install story dependency-light (the README leans hard
on "no Docker, minimal deps").

---

## 7. Effort & phasing

- **Phase 1:** schema + `skipmarkers` pkg (xcorr intro detection) + background job + markers
  in stream-info + the **Skip Intro** button. This alone is the headline.
- **Phase 2:** credits detection + **auto-advance** next-episode; admin status page.
- **Phase 3:** recap/intro split; admin manual-correction UI (`detector='manual'`);
  movie end-credits skip.

**Why it's worth it:** it's the perennial #1 community request and a credibility feature —
the thing that makes Aurora feel finished next to Plex/Jellyfin. Biggest *engineering*
unknown of the five (the DSP), which is why detection is isolated behind a versioned
`detector` column so it can be improved without touching playback.

---

## 8. Out of scope (v1)

- Crowd-sourced / shared marker database across installs.
- ML-based scene classification.
- Chapters editing UI.
