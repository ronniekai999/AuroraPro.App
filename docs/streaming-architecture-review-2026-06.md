# Streaming Architecture Review — June 2026

> **Implementation status (same PR):** all 10 action items below were
> implemented after this review was written.
>
> - **B1** QSV `-profile:v` fix — hwaccel.go
> - **B2** HEVC remux gated on fMP4-or-HLS.js delivery — DecidePlayback
> - **B3** static fallback: remux only H.264, mp3 force-recoded — decideStatic
> - **B4** variant state reads under `variantMu`; Ready-channel snapshots
> - **B5** stale profile doc comment corrected
> - **P1** idle-variant reaper (resumable, 75 s) + `-readrate 4.0` pacing
>   (FFmpeg ≥ 5, version-probed)
> - **P2** hls.js: persisted bandwidth estimate (8 Mbps first-run seed),
>   `capLevelToPlayerSize`, `backBufferLength: 90`
> - **Q1** VAAPI HDR: CPU hable tonemap before `hwupload`, GPU scale/encode
> - **S1** per-user session quota (default 3, `max_sessions_per_user`) → 429;
>   **S2** query-param auth on `/api/stream/*` accepts cast-scoped tokens
>   only; **S3** uniform 404 on session access/keepalive/delete/cast-token;
>   **S4** `Cache-Control: private` on segments
> - **M1** fMP4/CMAF segments are the default (`transcode.segment_format:
>   fmp4`); `ts` remains as the rollback knob. HEVC remux gets `-tag:v hvc1`;
>   Annex B bitstream filters apply only in TS mode; `#EXT-X-MAP` URIs are
>   token-rewritten for cast receivers. ~~The TS-era audio passthrough policy
>   (AAC/AC-3 only) is retained in fMP4 mode for safety; widening it
>   (E-AC-3 passthrough) is a follow-up.~~ **Done in the follow-up PR:** in
>   fMP4 mode, E-AC-3 is copied on the remux path and AC-3/E-AC-3 ride along
>   on the transcode path (gated on the MSE-strict `eac3_mse` client cap;
>   CODECS advertises ec-3/ac-3 truthfully via `PlaybackDecision.AudioCodec`;
>   the cast stereo-clone guard now also covers COPIED Dolby audio — a
>   pre-existing gap). TS mode is unchanged.
>
> A 7-angle adversarial review of the implementation produced one further
> round of fixes: quota errors on the legacy auto endpoints now return 429
> (not 500); `transcode_max_sessions_per_user` is admin-hot-reloadable like
> the global cap (setter + settings UI); the cast-scope query-token gate
> fails closed when the auth service is absent; the reap-resume and
> crash-restart paths share one resume helper so their math cannot diverge;
> and the bounded (≤2-frame) fMP4 subtitle-cue skew from `make_zero` is
> documented at the flag site. Known accepted risk: a user at their session
> cap who casts an AC-3 stream falls back to casting the original session
> (possible silent audio on non-AC-3 receivers) — pre-existing fallback,
> logged server-side.

Scope: the full playback stack — direct play, direct stream (remux), and HLS
transcoding — across `internal/streaming/`, the API layer
(`internal/api/phase2_handlers.go`, `router.go`, `cors.go`, auth middleware),
and the player (`static/redesign/app/src/components/VideoPlayer.tsx`,
`lib/streaming.ts`). Evaluated for speed, quality, bugs, and security against
the current state of the art (Apple HLS Authoring Specification, hls.js 1.6,
FFmpeg current practice, and how Jellyfin/Plex/Emby solve the same problems).

**Verdict: the architecture is the right one.** The three-tier
direct-play → remux → transcode design with a client-capability decision
engine is exactly how the leading media servers work, and several parts of
this implementation (the caps engine's HLS.js-vs-native audio split, the
Hi10P guard, subtitle PTS alignment, crash auto-restart with playlist append,
path containment) are *more* careful than the open-source peers. Test
coverage of the decision engine is strong (~3,500 lines of tests; `go test
-race` and `go vet` clean).

The gaps are: **one likely-fatal bug on Intel QSV hosts**, **one
Apple-spec violation on the HEVC remux path for native-HLS clients**, a
**generational gap (MPEG-TS-only, no fMP4/CMAF)**, and **efficiency issues**
(no transcode pacing, multi-variant ABR cold-start burn, no per-user session
quota). Nothing found undermines the overall design — these are fixable
within the existing structure.

---

## 1. Architecture as built

```
Player probes caps (MediaSource.isTypeSupported / canPlayType)   streaming.ts:177
        │  caps=h264,hevc,aac,ac3,…,hls_js,hls_native
        ▼
GET /api/stream/info/{id}?caps=…  →  DecidePlayback()            streaming.go:183
        │
        ├── direct_play    → /api/stream/{id}/direct — http.ServeContent,
        │                    range requests, symlink-containment check
        ├── direct_stream  → HLS session, -c:v copy (+BSF annexb), audio
        │                    copy if ts-safe (aac/ac3) else AAC re-encode
        └── transcode      → HLS session, H.264 High + AAC/AC-3 ladder
                             (2160p/1080p/720p/480p), HW accel
                             NVENC>QSV>VAAPI>AMF>libx264, HDR→SDR tonemap,
                             subtitle burn-in or inline WebVTT extraction
```

- HLS: MPEG-TS segments, 6 s, EVENT playlists, `hls_list_size 0` (full
  seek-back), `independent_segments`, forced IDR at segment boundaries,
  `-muxdelay 0 -muxpreload 0` for PTS≈0, CODECS strings kept in sync with the
  encoder (`hlsCodecString` ↔ `h264Profile`/`h264Level`).
- Sessions: 128-bit random IDs, on-demand variant start, idle GC (5 min),
  20 GiB disk cap with LRU eviction of idle sessions, crash auto-restart
  (`+append_list` + `-start_number`, resume at highest complete segment).
- Seeks: forward-past-buffer rebuilds the session at the target offset
  (`onSeekRebuild`, the Plex/Jellyfin pattern); resume uses `-ss` input seek
  with keyframe-snap echo-back; subtitle cue shift uses the *probed* keyframe
  (`ProbeSeekKeyframe`), not the requested offset.
- Auth: httpOnly cookies primary (hls.js `withCredentials`), query-token
  promotion restricted to streaming/image/WS routes, session-scoped cast
  tokens, token redacted from Aurora's own logs.

This matches or exceeds peer architecture. Specific praise that should not
get lost in the findings below:

- The HLS.js-restricted audio caps split (`DecidePlayback`,
  streaming.go:264-288) — distinguishing "browser can decode X via MSE" from
  "hls.js can demux X out of MPEG-TS" — is a subtle failure mode that
  Jellyfin historically got wrong (silent audio). Handled correctly here,
  including the strict MSE-only gate for AC-3 on the frontend
  (streaming.ts:216-223).
- H.264 10-bit (Hi10P) detection via pix_fmt (streaming.go:216-221) — a
  classic "ffprobe says h264, browser says no" trap. Handled.
- Subtitle timing: X-TIMESTAMP-MAP injection with actual first-PES-PTS
  probing (streaming.go:2805+), `-write_empty_segments`, per-track playlists,
  keyframe-aware cue shifting. This is Emby-grade and beyond what Jellyfin
  does for inline text subs.
- Containment: `EvalSymlinks`-resolved root checks on *both* the media
  library roots (direct play) and the transcode output tree (playlists,
  segments, subtitle segments). Segment names traversal-checked *and*
  regex-locked. This defeats symlink-smuggling, not just `..` traversal.

---

## 2. Findings

Severity reflects user impact × likelihood. File:line references are to the
current tree.

### Bugs

**B1 — HIGH (QSV hosts): bare `-profile` likely fails every QSV transcode
that re-encodes audio.**
`hwaccel.go:220-221` builds `-c:v h264_qsv -preset faster -profile high
-level …`. Per FFmpeg option semantics, an option with an empty stream
specifier applies to **all** output streams — including the audio stream.
When the session re-encodes audio (the default: `-c:a aac` or `-c:a ac3`,
streaming.go:1818-1827), the AAC encoder is asked to set `profile=high`,
which is not a valid AAC profile constant (`aac_low`, `aac_main`, …), and
FFmpeg fails at encoder init — before producing any segment. The NVENC and
AMF paths correctly use `-profile:v`; only QSV uses the bare form.
*Fix:* one token — `-profile` → `-profile:v` (hwaccel.go:221). Worth a
2-minute verification on a QSV host; if QSV transcodes have "worked", it is
because audio passthrough sessions (`-c:a copy`) don't open an AAC encoder.

**B2 — MED: HEVC remux into MPEG-TS is served to native-HLS clients, which
Apple's spec forbids.**
`DecidePlayback` allows HEVC remux (`-c:v copy` + `hevc_mp4toannexb` into
`.ts`) whenever the client reports the `hevc` cap (streaming.go:222-239).
That is correct for hls.js ≥ 1.6 clients (HEVC-in-TS demux shipped in
v1.6.0; Aurora ships 1.6.16). But for clients with `hls_native` and **no**
`hls_js` (iOS Safari < 17.1, where there is no MSE/ManagedMediaSource), the
`.ts` segments go to Apple's native player — and the HLS Authoring
Specification requires HEVC to be in **fMP4** segments; HEVC-in-TS is not
supported by AVPlayer. The frontend makes this reachable: the `hevc` cap is
set via the `canPlayType` fallback (streaming.ts:193-198), which old iOS
answers "probably" to. And because there is no hls.js instance on that path,
the MEDIA_ERROR → transcode fallback never fires — playback just fails.
*Fix (small):* in `DecidePlayback`, only allow HEVC `remuxVideoOK` when
`clientCaps.HLSJS` is true. *Fix (right):* fMP4 segments (see M1).

**B3 — MED-LOW: static fallback (nil caps) remuxes VP8/VP9 into MPEG-TS,
which cannot work.**
`decideStatic` (streaming.go:483-491) returns `direct_stream` for any codec
in `DirectPlayCodecs` — which includes vp8/vp9 — when the container isn't
native (e.g. VP9 in MKV). FFmpeg's mpegts muxer has no VP9 stream type (it
muxes it as a private data stream) and hls.js's TS demuxer only handles
H.264/HEVC, so the result is unplayable. The caps-aware path guards exactly
this (streaming.go:233-239); the static path doesn't. Same path also copies
mp3 into `.ts`, which the caps-aware path deliberately refuses
(`tsPassthroughSafe`, streaming.go:300-302). Only no-caps clients (legacy/
API consumers) hit this. *Fix:* in `decideStatic`, restrict remux to
h264/avc and force-recode mp3 — mirroring the caps-aware policy.

**B4 — LOW: lock-discipline races on `QualityVariant` state.**
`v.Err` is written without `variantMu` on the `cmd.Start` failure path
(streaming.go:2161), and read without the lock in `ServeVariantPlaylist`
(:2336), `ServeHLSSegment` (:2431), and via `ffmpegDone` in
`ServeSubtitlePlaylist` (:2552) — while the `cmd.Wait` goroutine writes
`v.Err`/`v.exited`/`v.StderrTail` under the lock at any later time
(mid-stream crash). The happens-before edge via `close(v.Ready)` covers the
*pre-ready* writes only. Practical impact is near-zero on amd64, but it is a
real data race the unit suite can't see (no live FFmpeg in tests); an
integration test under `-race` would flag it. *Fix:* snapshot
`(err, exited)` under `variantMu` in the serve paths.

**B5 — LOW (doc rot):** `VideoEncoderArgs`'s comment says "Baseline for
1080p and below" (hwaccel.go:182-185) but `h264Profile` returns `"high"`
unconditionally (and `hlsCodecString` correctly advertises High). Update the
comment before it misleads a future change.

### Performance / efficiency

**P1 — HIGH (cost, not correctness): no transcode pacing + multi-variant
ABR means 2-3× the necessary encode work.**
Every started variant encodes the **entire file at maximum speed**
(no `-readrate`, no throttling), regardless of where the playhead is. And
because the master playlist advertises the full ladder while hls.js starts
auto (P2), a typical full-transcode session starts the lowest tier, then
up-switches within seconds and starts a second FFmpeg — both of which then
encode the whole movie to EOF. Costs: peak CPU contention between concurrent
users (the cap is 8 *sessions*, but a session can hold 3-4 FFmpeg
processes), and disk (each touched tier persists its full movie; the 20 GiB
cap only evicts *idle* sessions). Jellyfin solves this with a transcoding
throttler (pause FFmpeg when far enough ahead) + segment cleaner — both of
which have a long bug tail (stalls when the pause/resume logic misfires), so
Aurora's "encode everything, keep everything" approach is *simpler and more
robust*, just expensive.
*Recommended fixes, in order of value:*
1. **Variant reaper**: track per-variant last-fetch time and cancel a
   variant's FFmpeg when no segment/playlist of that tier has been fetched
   for ~60-90 s (the session stays; `EnsureVariant`'s existing restart
   machinery already knows how to resume from the highest complete segment
   if the tier is requested again).
2. **Pacing**: `-readrate 4.0` (or similar) on full-transcode variants
   bounds runaway encode-ahead without Jellyfin's fragile SIGSTOP dance;
   keep remux unpaced (it's nearly free and finishing fast is *good* — the
   code already exploits completed playlists in `EnsureVariant`).
3. Or sidestep entirely: serve a **single-variant master** per session
   (Jellyfin/Plex model) and treat quality changes like seeks — the
   session-rebuild path already exists in the player.

**P2 — MED: every transcode starts at the lowest rung (typically 480p),
even on a LAN.**
The player constructs hls.js with defaults (VideoPlayer.tsx:1247-1283).
hls.js's default `abrEwmaDefaultEstimate` is **500 kbps**, below the
lowest declared tier (480p @ 2.2 Mbps), so `firstAutoLevel` is the bottom
of the ladder; quality ramps only after bandwidth samples arrive, and the
up-switch triggers the cold-variant start (P1). For a self-hosted,
LAN-dominant server this is the wrong prior.
*Fix (frontend, small):* set `abrEwmaDefaultEstimate` to ~8-16 Mbps or
persist the last measured estimate in localStorage and feed it back; add
`capLevelToPlayerSize: true` (don't fetch 2160p into a 720p window) and
`backBufferLength: 90` (default is Infinity — on long movies the already-
played media stays in the SourceBuffer until browser-quota eviction).

**P3 — LOW: serve-path readiness waits hold request slots.**
Playlist/segment handlers block up to `readinessTimeout` (40-180 s) and the
subtitle playlist retry loop up to 60 s. Fine at self-hosted scale (Go
handles blocked handlers cheaply); just keep it in mind before fronting with
a proxy that has aggressive `proxy_read_timeout`. The docs in
`docs/reverse-proxy/` should state the required timeout.

### Quality

**Q1 — MED: VAAPI hosts get washed-out HDR.**
`injectTonemapFilter` skips tonemapping on the VAAPI pipeline (CPU filters
can't touch hw surfaces; streaming.go:3043-3048) and just logs a warning —
so 10-bit HEVC HDR → H.264 SDR transcodes on VAAPI come out desaturated.
NVENC/QSV/AMF/software paths are fine (their decode side is CPU). *Fix:*
use `tonemap_vaapi` (hardware tonemap, widely available on the same gens
that encode H.264) or force the software pipeline for `HDRTonemap` sessions
on VAAPI.

**Q2 — Good as designed (note only):** stereo AAC @ 192k/48 kHz default
with AC-3 5.1 passthrough/re-encode for MSE-AC-3-capable clients is the
pragmatic ceiling for MPEG-TS + hls.js (multichannel AAC trips hls.js's
ADTS path; E-AC-3 can't be demuxed from TS). fMP4 (M1) is what unlocks
better surround. The encode ladder itself (CRF 18-24 software / VBR+maxrate
hardware, High profile, per-resolution levels, aspect-correct heights,
no-upscale) is sound and matches the declared CODECS strings — a detail
peers frequently get wrong.

### Security

The posture is strong — notably better than the self-hosted average:
symlink-resolved containment on both library and transcode roots,
regex-locked output filenames, crypto/rand 128-bit session IDs, argv-style
exec (no shell), `escapeFFmpegPath` for filter args, an ffprobe concurrency
gate (anti-fork-bomb), CORS split (wildcard only on HLS assets, credentials
only on the API allowlist), token redaction in logs, FFmpeg stderr never
sent to clients, admin-gated diagnostics, and a hard transcode-session
ceiling even when configured "unlimited". Remaining items:

**S1 — MED: no per-user transcode quota or session-create rate limit.**
The global cap (default 8) means one user — or one leaked token — can pin
all transcode slots and DoS everyone else's playback
(`CreateSession`, streaming.go:1263-1274). *Fix:* per-user cap (2-3) checked
in the same critical section, returning 429.

**S2 — LOW: regular access tokens are accepted via `?token=` query param
on all `/api/stream/*` routes** (router.go token promotion). The SPA now
authenticates with httpOnly cookies (even native-HLS Safari sends cookies on
same-origin video subresource requests), and Chromecast uses session-scoped
cast tokens — so the only thing the broad promotion buys is a 15-minute
replay window if a URL leaks into an upstream proxy log. *Fix:* accept only
`cast`-scoped tokens via query param on stream routes; document proxy log
hygiene in `docs/reverse-proxy/` regardless.

**S3 — LOW: session enumeration split (404 vs 403)** for regular tokens in
`requireSessionAccess` (phase2_handlers.go:1021-1032). Already uniform for
cast tokens; consider uniform everywhere. Low value given unguessable IDs.

**S4 — LOW: HLS segments are served with `Cache-Control: max-age=3600`**
(streaming.go:2464) — add `private` so a misconfigured shared cache never
stores them. Subtitle segments same (:2873, :2900).

**S5 — INFO (accepted risk, keep visible):** `ServeFile` skips containment
entirely when `allowedRoots` is empty (streaming.go:606-610) — deliberate
fail-open so a libraries-table blip can't break playback. Defensible, but
it converts a DB outage into a containment bypass for in-library symlink
attacks. Consider fail-closed with a short retry instead.

---

## 3. Are we doing streaming "the right way"? (state-of-the-art comparison)

| Practice (2026) | Industry | Aurora | Assessment |
|---|---|---|---|
| Tiered direct-play → remux → transcode | Plex/Jellyfin/Emby | ✅ same, with client-probed caps | Right way; caps engine is precise |
| HLS for browser delivery, 6 s segments | Apple's recommendation | ✅ 6 s, IDR-aligned, EVENT | Right way |
| Segment container | **CMAF/fMP4** is the modern target; TS is legacy-compatible | ⚠️ MPEG-TS only | Works, but is the one generational gap (M1) |
| HEVC delivery | fMP4 required by Apple; HEVC-in-TS OK for hls.js ≥ 1.6 only | ⚠️ TS always | B2 bug on old-iOS native; fMP4 fixes properly |
| hls.js current | 1.6.x | ✅ 1.6.16 | Current |
| iOS | ManagedMediaSource (17.1+) via hls.js | ✅ automatic (`Hls.isSupported()`) | Right way |
| Hardware accel | NVENC/QSV/VAAPI/AMF with probe | ✅ probe + test-encode + fallback | Right way (modulo B1) |
| HDR→SDR tonemap | hable/bt2390, hw tonemap where possible | ✅ zscale+hable (sw); ❌ VAAPI skip | Q1 |
| Transcode pacing | Throttle/cleanup (Jellyfin), buffer-ahead (Plex) | ❌ none | P1 — biggest efficiency gap |
| Seek beyond buffer | Session rebuild at offset | ✅ `onSeekRebuild` | Right way |
| Token auth for segments | Cookies/short-lived scoped tokens | ✅ cookies + scoped cast tokens | Better than Jellyfin's long-lived `api_key`-in-URL |
| LL-HLS | Live only | ➖ N/A for VOD | Correctly not used |
| DASH | Optional alongside HLS | ➖ absent | Fine — hls.js covers all browsers |

**M1 — the one strategic recommendation: migrate HLS output to fMP4/CMAF**
(`-hls_segment_type fmp4`). It is what current Apple specs are written
around and what modern pipelines emit. Concretely it would: make HEVC remux
legal for *all* Apple clients (deleting B2 and the HLS.js-only HEVC gate),
remove the TS→fMP4 transmux hls.js currently performs on every segment
(client CPU/battery), unlock E-AC-3/multichannel audio paths that TS+hls.js
can't carry (Q2), and position the stack for optional DRM/LL-HLS later. The
change is contained: `startVariantImpl` muxer flags + init-segment serving,
`.ts`→`.m4s` handling in the token rewriter and segment handler, codec
strings, and the WebVTT X-TIMESTAMP-MAP logic (simpler with fMP4, since
there's no TS PTS offset to probe). Keep TS as a config fallback during
rollout. Until then, B2's one-line gate is the stopgap.

---

## 4. Prioritized action list

| # | Action | Size | Files |
|---|--------|------|-------|
| 1 | B1: `-profile` → `-profile:v` in QSV args (verify on a QSV host) | 1 line | hwaccel.go:221 |
| 2 | B2 stopgap: HEVC remux only when `HLSJS` cap present | ~3 lines | streaming.go:228 |
| 3 | S1: per-user session quota (2-3) + 429 | small | streaming.go CreateSession |
| 4 | B3: static fallback — remux only h264; recode mp3 | small | streaming.go decideStatic |
| 5 | P2: hls.js `abrEwmaDefaultEstimate`/persisted estimate, `capLevelToPlayerSize`, `backBufferLength: 90` | small | VideoPlayer.tsx |
| 6 | P1: variant reaper (cancel unfetched tiers) then `-readrate` pacing | medium | streaming.go |
| 7 | Q1: `tonemap_vaapi` or software fallback for HDR on VAAPI | medium | streaming.go, hwaccel.go |
| 8 | S2/S3/S4: cast-scope-only query tokens, uniform 403, `private` cache headers | small | router.go, handlers, streaming.go |
| 9 | B4: lock-snapshot variant state in serve paths; add `-race` integration test | small | streaming.go |
| 10 | M1: fMP4/CMAF segment migration (supersedes #2) | large | streaming pkg + player |

## Sources

- Apple HLS authoring requirements — HEVC must be in fMP4:
  [hlsbook.net/hls-fragmented-mp4](https://hlsbook.net/hls-fragmented-mp4/),
  [streamingmedia.com — HEVC in HLS](https://www.streamingmedia.com/Articles/ReadArticle.aspx?ArticleID=122637&pageNum=2),
  [radiantmediaplayer.com — Apple HLS best practices (end 2024)](https://www.radiantmediaplayer.com/blog/an-update-to-apple-hls-best-practices-end-2024.html)
- hls.js defaults (`abrEwmaDefaultEstimate` 500000, `backBufferLength`
  Infinity, `capLevelToPlayerSize` false):
  [hls.js API.md](https://github.com/video-dev/hls.js/blob/master/docs/API.md)
- HEVC-in-TS demux added in hls.js 1.6:
  [video-dev/hls.js#4943](https://github.com/video-dev/hls.js/issues/4943)
- FFmpeg stream-specifier semantics (empty specifier matches all streams):
  [ffmpeg.org/ffmpeg.html](https://ffmpeg.org/ffmpeg.html)
- Jellyfin transcoding throttler/segment cleaner and its failure modes:
  [jellyfin#8082](https://github.com/jellyfin/jellyfin/issues/8082),
  [jellyfin#11465](https://github.com/jellyfin/jellyfin/issues/11465),
  [jellyfin#16608](https://github.com/jellyfin/jellyfin/issues/16608)
