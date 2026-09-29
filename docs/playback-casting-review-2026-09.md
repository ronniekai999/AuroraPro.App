# Playback, transcoding, and casting review (September 2026)

**Status:** plan. Nothing described here is fixed yet.
**Reviewed:** commit `390d02e`, 2026-09-29.
**Scope:**
- **Server:** `internal/streaming`, the stream and cast handlers in `internal/api`, cast tokens in `internal/auth`, and the watch-party sync engine (`internal/watchparty`, `internal/api/party_ws_v3_*`).
- **SPA:** `VideoPlayer.tsx`, `lib/cast*.ts`, `lib/streaming.ts`, `lib/partyPlayer.ts`, `hooks/useParty.tsx`.
- **Native:** the macOS client's playback layer.

When the work packages below have landed, delete this file. It stays in Git history, per [`docs/README.md`](README.md).

## Contents

1. [Summary](#1-summary)
2. [Remediation plan](#2-remediation-plan)
3. [High-severity findings](#3-high-severity-findings)
4. [Medium and low findings](#4-medium-and-low-findings)
5. [Technology stack](#5-technology-stack)
6. [Known gaps from CLAUDE.md](#6-known-gaps-from-claudemd)
7. [Checked and sound, or refuted](#7-checked-and-sound-or-refuted)
8. [Method and limits](#8-method-and-limits)

**Severity**
- **High:** a common playback, cast, or party path fails, hangs, or loses data; or the issue is privacy-relevant.
- **Medium:** a real failure in a narrower but realistic configuration, or a resource leak.
- **Low:** minor or robustness.

**Confidence**
- **Confirmed:** reproduced, and the note says how.
- **High:** traced end to end in the code.
- **Plausible:** the mechanism is confirmed, but the outcome depends on a device or browser behaviour we could not test here.

**Effort**
- **S:** half a day or less.
- **M:** 1–3 days.
- **L:** 1–3 weeks.
- **XL:** more than 3 weeks.

Estimates include tests but not review rounds.

## 1. Summary

After merging duplicates there are **13 high, 35 medium, and 29 low** findings, and nothing critical. There is no authentication bypass and no catalog data loss. The worst data problem is watch progress filed under the wrong profile.

**Where the defects are.** Most high findings are in the SPA's state machines (the player, the cast widget, and party sync) and in cast and session plumbing. The FFmpeg core is not where they cluster. The decision engine behaves as its tests say. The failures sit at its edges:
- **Facts the scanner never records:** rotation, interlacing, the `hev1` tag, commentary flags, and WebM-ness.
- **Paths no test covers the way a client sees them:** the playlist numbering after an encoder relaunch (a test relaunches after a reap but never checks the numbering), casting a shared session, VAAPI levels, and graceful shutdown.

**Documented claims that are false today.** These comments and CLAUDE.md invariants state behaviour the code doesn't have:
- CLAUDE.md says scheduled, unstarted parties "survive … restarts". Every *graceful* restart, including every auto-update deploy, ends them (PARTY-1).
- The idle reaper is documented as stopping "a paused player['s] encoder racing to EOF". hls.js keeps polling a growing playlist while paused, so it never does (X-3).
- `-avoid_negative_ts make_zero` is said to make fMP4's first DTS zero. It is passed before `-i`, which makes it an input option, so it does nothing (FF-9).
- `VideoPlayer.tsx:2582` says bitmap subtitles "can still be burned in via the pre-play setup". No client sends a burn-in request, so titles whose only subtitles are PGS show **no subtitles** in the browser (SUB-PGS).
- `h264Level` says the dotted level form is accepted by VAAPI. For x.0 levels it is not (FF-1).

**Technology stack.** The core choices are right: the FFmpeg command line run as a subprocess, HLS, hls.js, WebKit AirPlay, and AVPlayer plus VLCKit on macOS. The biggest lever is architectural, not a library swap:
- **Playlist model.** A growing EVENT playlist that is rebuilt on seek is behind a family of bugs and known gaps. A server-generated VOD playlist would remove that family.
- **Outdated Chromecast assumption.** The "Chromecast needs TS" rule predates Google making Shaka the Cast receiver's HLS player (2026-05-18).
- **Two cheap, overdue items:**
  - Upgrade hls.js 1.6.17 → 1.7.3, and replace its deprecated loader options.
  - Fix the installer so the `aurora` user can actually reach the GPU.

**For the owner's own server.** The production box has no GPU: an AMD CPU with an ASPEED BMC console chip (`hwaccel.go:308-312`). So the GPU items (FF-1, FF-3, FF-8, CASTS-2, WP19) matter for other installs. What helps this box is doing fewer encodes: casting remuxes without re-encoding, WebM direct play, and PGS rendered in the browser. Cheaper CPU filters help too.

**Do these first.** All are small (S) or a few S items together:
1. LIFE-1: stop renumbering the playlist when an encoder resumes.
2. WEB-1: save progress to the *active* profile. A kids profile's viewing currently lands in the account holder's history, and in their shared watch history if they have opted into sharing.
3. WEB-5: record progress and completion while casting.
4. CASTC-2 and CASTC-3: never lose control of a running cast (Escape after expanding the widget; a page reload).
5. PARTY-1: stop graceful shutdown from ending scheduled parties.
6. WEB-2, WEB-3, and WEB-4: player state bugs (seek base during a rebuild, dead listeners after an error, auto-resume after recovery).
7. CASTS-1 and CASTS-2: casting mid-title from a shared session; hardware decode for cast copies.
8. PARTY-2: "Play for all" starts the room before anyone has loaded the next episode.
9. FF-1: VAAPI writes an invalid H.264/HEVC level.
10. CASTS-3 and CASTC-7: stop starting encoders nobody watches. Give a cast copy a single quality level (1080p or below) instead of pre-warming every rung, and stop the local player's playlist polling when a cast connects. The general paused-player case (X-3) needs a design change and is in Phase 2.

## 2. Remediation plan

Each work package (WP) is sized for one branch and PR under [`dev-workflow.md`](dev-workflow.md). Architectural items (WP17, and WP18's custom receiver) get their own isolated PRs. Every fix lands with a test that fails before the fix. [Method](#8-method-and-limits) describes the reproductions built during this review; rebuild them as permanent tests.

Work-package estimates are in developer-days, because most packages bundle several S items. Totals:
- **Phase 1:** about 20–25 developer-days.
- **Phase 2:** about 30–40.
- **Phase 3:** dominated by WP17 (3–6+ weeks) and the custom receiver (2–3 weeks).

The hardware-encoder fixes (WP5, WP15) need an Intel, AMD, or NVIDIA box to verify. The production server has no GPU.

### Phase 1: confirmed defects with small fixes (about 20–25 developer-days)

**WP1 · Player state and watch progress (SPA, plus one server change). Closes WEB-1, 2, 3, 4, 5, 6, 7, 9, 11. About 3–4 days (nine S items).**
- **Profile:** send `profile_id` on every heartbeat. On the server:
  - When no `profile_id` is sent, use the acting profile if `ResolveActingProfile` returns a real one (ID > 0).
  - Otherwise keep today's `GetDefaultProfile` lookup and its create-on-demand path. `ResolveActingProfile` returns a synthetic ID-0 profile when an account has none (`internal/db/queries_phase4.go:144`), and OAuth sign-ups rely on the create path because `watch_progress.profile_id` is NOT NULL.
  - Fix the context-menu *Mark as Watched* and *clear progress* calls the same way (`App.tsx:2308`, `:2326`).
- **Casting:** while casting, report `recvToAbsSec(remote.currentTime)`. When the receiver reports FINISHED, write completion before advancing or stopping, and flush once when the cast ends.
- **Seek base:** keep a logical absolute playhead across same-viewing rebuilds. Use it for relative seeks, the scrub slider, and audio switches while the new session resolves.
- **Listeners after an error:** the play effect already clears `errorMsg` when a new target arrives (`VideoPlayer.tsx:2481`). That runs too late: the target-keyed listener effect (`:4930`) runs in the same commit, before `<video>` is back in the DOM, and never re-runs. Either:
  - bind the media listeners to the element through a callback ref; or
  - reset `errorMsg` during render when the target identity changes.

  Clearing it only when the player closes (the `!target` branch at `:2431`) fixes the reported error-then-Back path, but not a target replaced while the error screen is showing. For example, a party media change calls `setPlayerTarget` directly, with no null target in between.
- **Pause intent:** preserve it through keepalive and direct-play recovery, the way `rebuildAtTarget` already does.
- **Stranded sessions:** do not pass the abort signal to `createSession`. `lib/prewarm.ts:253-258` already explains why.
- **Completion and flushing:**
  - Mark the outgoing episode watched on a solo advance.
  - Flush progress on `pause`, `seeked`, close, and `pagehide` (`fetch(…, {keepalive: true})`).
  - Skip reports when there is no trusted duration.
- **Regression suite:** `VideoPlayer.tsx:64-67` says the component cannot be mounted in jsdom. It can: the review mounted it with a fake hls.js and a fake Cast SDK. Adopt that harness as the regression suite.

**WP2 · Cast session control (SPA). Closes CASTC-2, 3, 4, 5, 10, 11, 12, and CASTC-7 for non-carrier rungs (the carrier rung needs WP8 or WP9). About 3–4 days.**
- **Close gates:** tell App "casting" (`remoteActive`) for its close gates, not `minimized && remoteActive`. Bind the pause-while-casting effect to the current `<video>` element.
- **Stop control:** when a cast is connected but there is no player target (after a reload), render a minimal widget with Stop. It can take the title from the receiver's media metadata.
- **Failed seek:** if re-pointing the receiver after a seek fails, leave the receiver on its current media and show a toast. Only an end-of-media advance should stop the cast.
- **Audio and volume while casting:** an audio-track change re-points the receiver, or the menu is disabled with a reason. Volume and mute go through `RemotePlayerController`.
- **Local encoder:** call `hls.stopLoad()` when the cast connects and `startLoad()` if playback falls back to local.
  - Once polling stops, today's idle reaper stops the local session's rungs 75–105 s later (it sweeps every 30 s). Rungs still priming are skipped until they are ready, and when no cast copy is made, the rungs the receiver itself pulls from correctly stay alive.
  - Exception: the subtitle-carrier rung is exempt from reaping (`streaming.go:2492`). For titles with embedded text subtitles, one local encoder keeps running until WP9 moves subtitle extraction out of the video encoder, or WP8 changes the reaper.
- **Smaller fixes:**
  - Record the cast token's expiry only once the load succeeds.
  - Load media for sessions started from Chrome's own cast menu.
  - Map `load_media_failed` in the error table (currently `load_failed`), and toast when a reload fails.

**WP3 · HLS session lifecycle (Go). Closes LIFE-1, 2, 4, 5. About 2 days.**
- **Playlist numbering:** drop `-start_number` whenever `+append_list` can parse the existing playlist; FFmpeg then continues numbering by itself (verified contiguous across two resumes). Extend `TestPlaybackMatrix_ReapAndResumeRejoinsTheTimeline` to assert sequence 0 and an unchanged filename-to-sequence mapping across two resumes.
  - **Backstop:** serve `#EXT-X-MEDIA-SEQUENCE` equal to the first listed segment's file number, so a segment's sequence number always equals its file number. Forcing 0 would be wrong in the one case that keeps `-start_number`: an unreadable playlist, where FFmpeg writes a fresh one listing only new segments.
- **Stale folders:** clear the transcode folder at startup, before the hardware-decode probe creates its `.hwprobe-*` subfolder. Make `CreateSession` refuse after `Close`.
- **Disk cap:** re-read `LastAccess` under the lock when choosing what to evict.
- **Readiness timeout:** cancel FFmpeg when it fires, or let a late playlist clear the error. Either extend the write deadline in the HLS handlers or keep the readiness budget under the server's 120 s `WriteTimeout`.

**WP4 · Casting, server side. Closes CASTS-1, 2, 3, 4, 6, 7, CASTC-8, and the cast part of LIFE-3. About 3–4 days.**
- **Mid-title casts:** `CloneForCast` should also create a copy when `atSec` is before the session anchor or more than about 30 s after it. The shared session itself is still never re-anchored. Update the two tests that pin today's shape.
- **Hardware decode:** keep `SourceVideoCodec` on cast copies. Delete `streaming.go:1056-1058` and flip `eac3_passthrough_test.go:307-309`.
- **Pre-warming:** start only the quality level (rung) the receiver begins on, not every rung. That alone may re-open #355 on the receiver's first up-switch. Better: give a cast copy a single rung at 1080p or below. First- to third-generation Chromecasts and the Ultra stop at H.264 level 4.1/4.2, and a single rung leaves no up-switch to go wrong.
- **Segment format:** when no cast copy is made, either make one when the source session is fMP4, or return the segment format and set `hlsSegmentFormat`/`hlsVideoSegmentFormat` in the sender. Google documents an unspecified format as treated as Transport Stream.
- **Leases:** skip `MarkCastHeld` for HEAD requests. Before answering 429, reclaim the caller's own leased sessions that have been idle past the normal timeout.
- **H.264 level:** compute it from macroblocks per frame and per second (H.264 Table A-1), not from rung height.

**WP5 · Encoder arguments (Go). Closes FF-1, 2 (the same defect as SUB-4), 3, 6, 8, 9, 10, and DEC-11. About 3–4 days, plus time on real Intel/AMD/NVIDIA hardware.**
- **Levels:**
  - VAAPI: pass the integer `level_idc`, as the QSV path already does.
  - `hevc_qsv`: pass idc/3 and `-tier main`.
  - Pin it with a test that checks every emitted level against the encoder's named constants.
- **Keyframes:**
  - QSV: `-forced_idr 1` plus `-g`/`-keyint_min` = ceil(segment duration × fps).
  - AMF: `-g`/`-keyint_min`, plus `-forced_idr 1` on FFmpeg 9 or later.
- **Rotation:** read it at probe time and swap width and height for 90°/270° before building the rungs (quality ladder). WP10 stores the field; probing at session creation is a stopgap.
- **Bitmap burn-in:** overlay first and scale second. Label the filter-graph output and map it in place of `0:v:0`, in all three variants.
- **GPU tonemap:** give the `tonemap_vaapi` probe sample mastering-display metadata, or delete the tier. Fix DEC-11's `tonemap_gpu` label in the same change: it can't fire today because the probe never passes, and fixing the probe makes it reachable.
- **Comments:** correct the `-avoid_negative_ts` comments. Do not move the flag after `-i` without changing `X-TIMESTAMP-MAP` in the same commit.
- **Zero-copy tier:** add a chroma-subsampling check.

**WP6 · Watch party (Go and SPA). Closes PARTY-1, 2, 6, 7, 8, 9, 10, and OPS-3. About 3–4 days.**
- **Shutdown:** skip parties with `StartedAt == nil && ScheduledStartAt != nil`. Cancel their timers and close their connections, but don't end them in the database or send `party-ended`.
  - Seed a rehydrated party's `StateRevision` from something monotonic across restarts.
  - Add a database-gated test: create a scheduled party, call `m1.Shutdown()`, then `m2.Rehydrate`, and assert the party is present. After this fix the CLAUDE.md invariant is true again.
- **Host recovery:** gate it on `!isPartyEpisodeMismatch` (already in `lib/partyPlayer.ts` with a table test), or mark it fired and pause locally when the advance is sent. Extract the inline host-recovery condition (`VideoPlayer.tsx:4235-4240`) into `lib/partyPlayer.ts` and give it its own table test.
- **Guest pause:** for non-hosts, ignore `request-pause`'s `at_ms` (use `CurrentAbsMs`) or clamp it to a few seconds.
- **Smaller fixes:**
  - Age out stale seeks.
  - Debounce host seeks, and give time sync its own rate-limit bucket.
  - Clear `pendingSyncIntentRef` on join and on both teardown paths.
  - Bound `initial_position_ms`, and reject a null `to_ms`.
  - Use one per-party `time.AfterFunc` for the host-close grace period.
  - Delete the unused `v3RequestPlayPayload` (OPS-3).

**WP7 · Subtitle quick fixes (Go and SPA). Closes SUB-2, 3, 6, 9, 10, 11, and DEC-6 (the same defect as SUB-5). About 3 days.**
- **Inline HLS subtitles:** admit a track only if `IsTextSubtitle` accepts it (an allowlist), so TTML, teletext, and ARIB tracks can no longer abort the launch.
- **Timestamp map:** emit `X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000` in TS mode. Cues and video share the `-copyts` file clock.
- **Sidecar encodings:** sniff the byte-order mark and handle UTF-16. Fall back to Windows-1252 when the text isn't valid UTF-8, and pass `-sub_charenc` to FFmpeg conversions.
- **ASS → WebVTT:** add a post-pass that drops `\p` vector drawings and escapes `&`, `<`, and `>`.
- **Sidecar matching:** separator-aware and case-insensitive. Parse `forced`, `sdh`, and `cc`, plus ISO 639 language codes.
- **Playlist rules:** make each `NAME` unique and allow at most one `DEFAULT=YES` in the SUBTITLES group.
- **TS-mode promotion:** the SPA reads `remux` from the session response, so the sidecar cue shift matches the session that actually runs.

### Phase 2: robustness, source facts, quality (about 30–40 developer-days)

**WP8 · Encoder budget. Closes X-3, LIFE-3, and FF-7. About 4–6 days (X-3 needs a design pass first).**
- **Paused players (X-3).** Counting only segment fetches as activity is *not enough on its own*:
  - `ServeVariantPlaylist` calls `EnsureVariant` on every playlist poll (`streaming.go:4760`), and its reaped branch relaunches the encoder (`:3427-3437`).
  - A paused hls.js player that keeps polling would therefore get a reap, a relaunch (about 3 s later), and a re-reap 75 s after that. The encoder keeps running at 4× with a burst on each relaunch, and a discontinuity is appended every cycle.
  - Change the resume trigger together with the activity signal: resume on a segment request, or on a poll only when the client's last fetched segment is near the published edge.
  - Decide what happens to the subtitle-carrier exemption (`:2492`). WP9's separate subtitle extraction removes the need for it.
- **Encoder cap:** cap *running encoders* per user and globally in `startVariantImpl`, by reaping or refusing the oldest idle rung.
- **Encoder fallback:** add a software-encode fallback for when FFmpeg's stderr blames the encoder (an NVENC session cap, an oversized frame).

**WP9 · Subtitle extraction service. Closes SUB-1, SUB-7 (the same defect as FF-4), and SUB-8. About 4–5 days.**
- Only one extraction per output path runs at a time (single-flight).
- Write to a temporary file and rename it on success.
- Run on the server's lifetime context, and give extraction its own concurrency gate. `GetStreamInfo` and `CreateSession` must never wait behind a 10-minute extraction.
- Burn-in reads the cached extracted track instead of demuxing the whole container.
- Build inline subtitle playlists server-side on the video segment grid (WP17 makes this simpler). Once subtitles no longer ride inside a video encoder, no rung needs the reaper's subtitle-carrier exemption.

**WP10 · Record the source facts decisions need (migration and rescan). Closes DEC-1, DEC-4, DEC-5 (the same defect as FF-5), FF-6, DEC-WebM, and TECH-14. About 4–6 days.**
- **What ffprobe already returns:** the same ffprobe call already gives `codec_tag_string`, `field_order`, rotation, the `comment`/`visual_impaired`/`hearing_impaired` dispositions, `level`, and the Dolby Vision configuration record. Store them.
- **WebM:** detect it by extension or DocType instead of folding `matroska,webm` into `mkv`.
- **Then:**
  - Keep commentary and audio-description tracks out of automatic selection.
  - Remux `hev1` MP4s (retagging to `hvc1`) for Apple clients.
  - Deinterlace with `bwdif`, `yadif_cuda`, or `deinterlace_vaapi`.
  - Make the quality ladder rotation-aware.
  - Direct-play WebM in browsers.

**WP11 · Decision and capability fixes. Closes DEC-2, 3, 7, 8, 9, 10. About 3–4 days.**
- **Audio on direct play:** pass `audio_track_index` to stream-info. Withhold direct play when the requested track isn't the one the player starts with, and remux to select it.
- **Safari:** emit `hls_js` only when hls.js will actually be used, sharing the `usesNativeHls` predicate. Probe `ManagedMediaSource` when `MediaSource` is absent, as on iPhone.
- **Chroma-aware capabilities:** add an `hevc_rext` probe and use the stored `video_profile`.
- **Streaming info:** check the rating ceiling in `GetStreamInfo`, and use the same 404 wording for blocked and missing files.
- **Telemetry:** fix the reason-code label (DEC-9). The QoE tonemap label (DEC-11) moves to WP5.
- **Activity log:** log `stream_started` once per viewing, not once per range request.

**WP12 · Party sync robustness. Closes PARTY-3, 4, 5. About 6–8 days (each is M).**
- **Episode changes:** re-target the player from state, keyed on (media item, episode), with retry. Pause and skip corrections while the episode doesn't match.
- **End of media:** a casting host sends `requestPause` with the last position before stopping. The server auto-pauses at the known duration. Guests never call `play()` on an element that has ended.
- **Host drift:** reconcile the host with a gentle, rate-only correction, or report stalls so the server re-anchors. For a casting host, compare the TV against the party's projected position over several polls, not poll to poll.

**WP13 · Stream token lifetime. Closes CASTC-9 (the same defect as CASTS-5), CASTS-4, and DEC-12. About 2–3 days.**
- A session-bound cast token stays valid while its session is alive, up to a hard cap such as 24 h after issue.
- File-bound tokens are re-minted before they expire.
- AirPlay mints its token at hand-off, not when the local session starts.
- The macOS client re-mints on a 401.
- `docs/native-client-caps.md` documents the cast-token authentication path.

**WP14 · hls.js upgrade and error handling. Closes TECH-04, WEB-8, WEB-10. About 2–3 days.**
- **Upgrade and config:**
  - Move from 1.6.17 to 1.7.3.
  - Replace the deprecated `*LoadingTimeOut` and `*LoadingMaxRetry` options with `playlistLoadPolicy`/`fragLoadPolicy`, with a long time-to-first-byte for cold rungs.
  - Set `abrSwitchInterval` to 10–20 s (each up-switch can start an encoder), and set `errorPenaltyExpireMs`.
- **Dead sessions:** route a 404 or 410 on a dead session to the keepalive rebuild instead of the retry budget.
- **Safari native-HLS parity:**
  - MediaError code 4 on a remux tries the transcode fallback.
  - Codes 2 and 3 trigger one rebuild at the playhead.

**WP15 · Make hardware encoding reachable from the installer. Closes OPS-1, OPS-2, TECH-01, and TECH-12's backend-selection half (WP5 covers its levels and keyframes). About 1–2 days, plus a test install per distro family.**
- **Sample config:** correct `configs/aurora.yaml`'s `max_sessions: 0 = unlimited` comment (OPS-2).
- **GPU access:** add `aurora` to `render`/`video` (`SupplementaryGroups=` in `aurora.service`) and install the VA-API drivers.
- **FFmpeg version:** warn when FFmpeg is older than 6.1. Ubuntu 22.04's 4.4.2 disables input pacing.
- **Fedora:** handle `ffmpeg-free`, which has no libx264, with RPM Fusion as opt-in.
- **Intel backend:** choose it by which pipeline tier its startup probe proved.

**WP16 · PGS subtitles in the browser. Closes SUB-PGS (TECH-09). About 2–3 days, reusing WP9's extraction.**
- Extract the track with `-c:s copy -f sup` into the subtitle cache, reusing WP9's single-flight.
- Render it with libpgs over the `<video>`, applying the session's start offset.

### Phase 3: architecture and stack upgrades

**WP17 · VOD playlist model (TECH-03). Effort L for transcode rungs; XL including remux, subtitles, and cast/party cleanup.**
- **How it works:**
  - The server generates a full-length VOD playlist up front (`#EXT-X-PLAYLIST-TYPE:VOD` plus `#EXT-X-ENDLIST`, from the database duration) on a fixed 6 s grid with forced keyframes.
  - When a segment is requested, the encoder restarts at it if needed (`-ss N·6 -start_number N -copyts`, `-hls_flags temp_file`).
  - Subtitles are one whole-file WebVTT per track, or sliced by the server on the video grid.
  - This is Jellyfin's `DynamicHlsPlaylistGenerator` / `DynamicHlsController` model.
- **What it retires:**
  - The HLS up-switch stall (a CLAUDE.md known gap).
  - Rebuilding the session to seek past the encoded edge.
  - Receivers treating the stream as live. Google's receiver decides live versus VOD only by `#EXT-X-ENDLIST`. For live it allows seeking only "from the beginning of the newest list until a three target duration from the end".
  - CASTS-1's class of bug, SUB-6/SUB-7, and a lot of SPA workaround code: `startPosition: 0`, the injected `EXT-X-START`, the `liveSyncPosition` patch, and per-rung edge tracking.
- **Rollout:** ship it behind `transcode.playlist_model: vod|event`, with EVENT as the rollback.
- **Risks:** audio/video continuity where the encoder restarts (see #348 and #431); sources that don't start at timestamp 0; disk growth from scattered segments.

**WP18 · Chromecast: stop re-encoding what the device can play (TECH-05, then 06, then 07). Effort M plus S; then L.**
- **CODECS for remuxes:** store the H.264 level (WP10) and emit CODECS on remux playlists. H.264 at 1080p or below and level 4.1 or below can then be cast without a video transcode.
- **fMP4 pilot:** try fMP4 cast copies with `hlsSegmentFormat`/`hlsVideoSegmentFormat = FMP4` declared, on current firmware. Re-test the #328 subtitle-rendition stall under Shaka.
- **Subtitles:** set `textTrackStyle`, and side-load subtitles from a WebVTT route authenticated by cast token (closes CASTC-6).
- **After WP17: one custom Web Receiver,** hosted centrally for every Aurora server.
  - It could choose codecs per device with `canDisplayType`, covering HEVC, VP9, AV1, Dolby Vision, and E-AC-3 passthrough.
  - It could report load and decode errors to the sender over a `urn:x-cast:` channel.
  - It could save progress and renew tokens from the receiver, and carry watch-party sync messages.
- **Receiver costs:** keep the Default Media Receiver as the fallback, and let forks override the app ID. Registration costs $5 and needs HTTPS hosting, and the project then owns the receiver's uptime.

**WP19 · Tonemapping and HDR metadata (TECH-11, needs TECH-14). Effort M.**
- Tier the tonemapper:
  1. `tonemap_vaapi`, with WP5's probe fix.
  2. On NVIDIA: jellyfin-ffmpeg's CUDA tonemap, or libplacebo.
  3. On AMD: libplacebo over Vulkan.
  4. jellyfin-ffmpeg's `tonemapx`, a fast CPU filter.
  5. `zscale`.
- Send Dolby Vision profile 5 only to tiers that understand Dolby Vision.
- On the CPU-only production box only `tonemapx` helps, and that needs TECH-02's build.

**Pilots and later:**
- **TECH-02 (M):** a pinned FFmpeg build (jellyfin-ffmpeg 8.1.x from its apt repo, or a BtbN *release* build) with a configurable binary path.
- **TECH-10 (M):** JASSUB for ASS subtitles. Needs `'wasm-unsafe-eval'` in the CSP and font extraction.
- **TECH-16 (L):** a libmpv engine on macOS for HDR and Dolby Vision titles.
- **TECH-17 (M):** seek-preview thumbnails from keyframe-only sprite sheets, served as WebVTT.
- **TECH-18 (S, optional):** CMCD v2 telemetry in header mode.

## 3. High-severity findings

**H1 · LIFE-1: resuming a stopped encoder renumbers the whole playlist, and hls.js then shifts that rung's timeline by minutes.**
- **Confidence:** confirmed. Reproduced with FFmpeg 6.1.1; the reviewer also ran hls.js 1.6.17's own parser and merge code under vitest.
- **Where:** `internal/streaming/streaming.go:4363-4366` (`+append_list`) and `:4405-4407` (`-start_number resumeSegNum`). Reached from `EnsureVariant`'s reaped branch (`:3427`) and from the crash / hardware-decode fallback (`:3489-3527`).
- **Trigger:** any relaunch after at least one segment is published. Commonly:
  - a rung hls.js left for more than 75 s and returns to (with `capLevelToPlayerSize`, leaving and re-entering fullscreen is enough);
  - crash recovery.
- **Evidence:**
  - A 4-segment EVENT playlist resumed with `-start_number 4` and `+append_list` comes back as `#EXT-X-MEDIA-SEQUENCE:4` (it was 0), over the same files.
  - The next file is `seg_00008.m4s`, after an `#EXT-X-DISCONTINUITY`.
  - hls.js's `adjustSliding` finds no overlapping sequence numbers and slides every fragment forward by the old playlist's end. The playhead now sits before the rung's start, so hls.js loads from the live edge, stalls, and jumps.
  - The player clock and the saved progress are inflated by the same amount.
  - RFC 8216 does not allow an EVENT playlist to renumber its segments.
- **Fix (S):** see WP3. The reviewer confirmed FFmpeg keeps numbering contiguously (6, 7) across two resumes once `-start_number` is dropped.

**H2 · WEB-1: watch progress is always written to the account's default profile.**
- **Confidence:** confirmed. Mounted with `profileId={7}`, the heartbeat body has no `profile_id`; the server path was traced.
- **Where:**
  - `static/redesign/app/src/lib/api.ts:1336-1340` and `:1377-1387`; `VideoPlayer.tsx:5698`.
  - `internal/api/phase2_handlers.go:2636-2665` falls back to `GetDefaultProfile`, never `ResolveActingProfile`. The same file uses `ResolveActingProfile` for rating ceilings at `:823`.
  - The same omission is in `App.tsx:2308` (Mark as Watched) and `:2326` (clear progress).
- **Outcome:**
  - Sub-profiles never get resume points.
  - The default profile's Continue Watching, history, and recommendations fill with other profiles' viewing.
  - Shared watch history and the follow feed read the default profile's completed rows. If the account holder has opted into sharing, a kids profile's viewing is published as theirs.
- **Fix (S):** WP1. Keep the create-on-demand path: `ResolveActingProfile` returns a synthetic ID-0 profile for accounts with no profile.

**H3 · WEB-5 (also filed as CASTC-1): casting never saves progress, and a title cast to its end is never marked watched.**
- **Confidence:** confirmed. The CASTC probe ran 30 minutes of receiver playback and saw no report.
- **Where:**
  - `VideoPlayer.tsx:5673-5705`: the only progress writer, which returns early while the local `<video>` is paused.
  - `:1509-1537`: the local element is held paused for the whole cast.
  - `App.tsx:4836` says a cast auto-advance "now has completed progress"; it doesn't.
- **Fix (S):** WP1.

**H4 · WEB-2: a relative seek or audio switch issued during a seek-rebuild is computed from zero, and a party host broadcasts the result.**
- **Confidence:** confirmed with a harness.
  - Two "skip 10 s" taps rebuild at `[35, 10]` (intended 45).
  - The scrub slider reads 0.
  - A second audio pick restarts at 0:00.
- **Where:** `VideoPlayer.tsx:2484-2495` (the rebuild zeroes `startSecRef` and `currentSec`), `:6818-6820`, `:5538`, `:6159-6163`; `PlayerControls.tsx:116`, `:257`.
- **Party impact:** a party host's `broadcastHostPartySeek` then moves every guest to about 0:10.
- **Fix (S):** WP1.

**H5 · WEB-3: the first title opened after any playback error gets no media-event listeners.**
- **Confidence:** confirmed with a harness, including a control case that behaves correctly.
- **Where:**
  - `VideoPlayer.tsx:6360`: `<video>` renders only when `!errorMsg`.
  - `:2481`: the only place `errorMsg` is reset. It runs inside the play effect *after* a new target commits, and not when the player closes.
  - `:4930-4932`: the listener effect, keyed on `[target]` (`:5071`). It runs in that same commit while `<video>` is still absent, and never re-runs.
  - The AirPlay effect at `:1561-1563` has the same problem.
- **Outcome:** after an error (for example a 429 session cap), then Back, the next title plays but:
  - the time and scrubber are frozen, and the play/pause state is wrong;
  - the saved volume is ignored;
  - there are no skip pills, no next-up card, no auto-advance, and no fullscreen tracking.
- **Fix (S):** WP1. Bind the listeners through a callback ref, or reset the error during render on a target change. Clearing it on the next target is what the code already does, and clearing it only on close misses a target replaced mid-error (a party media change).

**H6 · WEB-4: session recovery starts a paused player playing.**
- **Confidence:** confirmed with a harness, including a control case that behaves correctly.
- **Where:** `VideoPlayer.tsx:3714-3721` calls `rebuild(absSec)` without the pause intent that `rebuildAtTarget` sets (`:5253-5258`). The same applies to direct-play recovery at `:2788-2791`.
- **Trigger:** pause, then lose the session. For example: a laptop asleep longer than the idle timeout, a frozen tab, or a deploy after the drain cap.
- **Outcome:** playback starts with sound, possibly in a background tab. The heartbeat records positions the viewer never saw, and an episode can count down and auto-advance.
- **Fix (S):** WP1.

**H7 · CASTC-2: expanding the cast widget re-arms Escape and Back as "close the player", which orphans the cast.**
- **Confidence:** confirmed with a probe mounting the real `VideoPlayer` against a fake Cast SDK.
- **Where:** `VideoPlayer.tsx:1488` (`minimizedActive = minimized && remoteActive`) is reported to App at `:1672-1675`. App's close gates at `App.tsx:2824-2832`, `:3100`, and `:3349` key on it.
- **Outcome:**
  - The player closes while the TV keeps playing, with no widget and no Stop control.
  - App now allows new playback, which plays locally over the TV, and the transport controls drive the TV.
  - When the old title ends, `onEnded` runs against the new title.
- **Fix (S):** WP2.

**H8 · CASTC-3: reloading the page during a cast wedges the app.**
- **Confidence:** confirmed for the sender side by a probe. Session resumption is the Cast SDK's documented default (`resumeSavedSession`).
- **Where:**
  - `VideoPlayer.tsx:1586-1605`: the cast state sets minimized.
  - `:5874`: renders nothing without a target.
  - `App.tsx:3133` (and `:4589`, `:4976`, `:5225`): refuses playback while "minimized".
  - `App.tsx:2162`: the player target is not restored after a reload.
- **Outcome:** App answers every Play with "Stop casting to play something else", and nothing on screen offers Stop. This lasts until the title ends on the TV or the user stops it from Chrome or the TV remote.
- **Fix (S–M):** WP2.

**H9 · CASTS-1: a mid-title cast of a shared session asks the TV for a position its starting rung hasn't encoded yet.**
- **Confidence:**
  - Server side: confirmed by probe (`start_sec=0`, sender at 2400 s, the pre-warmed 480p launched without `-ss`).
  - Receiver behaviour: plausible, needs a device check.
- **Where:**
  - `streaming.go:1127-1129`: `CloneForCast` returns the original session before `atSec` is ever used.
  - `internal/api/phase2_handlers.go:1500-1515`: the pre-warm starts the other rungs at `cs.StartSec`.
  - `:1559-1560`: `start_sec` is set from `cs.StartSec`.
- **Trigger:** the local session is already cast-safe, meaning an H.264/AAC transcode with no text subtitles (for example an HEVC Blu-ray remux with only PGS subtitles, in a browser without HEVC). The viewer is 40 minutes in and presses Cast.
- **Outcome:**
  - The receiver asks for 2400 s from rungs that have about 30 s encoded; per #355, the receiver tries the lowest rung first.
  - It either buffers indefinitely, or Shaka pulls the start back to the newest available point and the film restarts near the anchor.
  - In a party, the client refuses to re-anchor shared sessions, so a casting guest stays out of sync.
- **Fix (S):** WP4.

**H10 · CASTS-2: cast copies of every remux session decode in software.**
- **Confidence:** confirmed from recorded FFmpeg arguments on a host whose probe reported VAAPI HEVC decode.
- **Where:**
  - `streaming.go:1056-1058` blanks `SourceVideoCodec`.
  - Its only non-diagnostic consumer is `PlanDecode` (`:4181`), and `hwdecode.go:111-114` returns no decoder for an empty codec. The remux bitstream-filter use at `:4219` is unreachable for cast copies.
- **Outcome:** on hosts with GPU decode, 4K HEVC/HDR casts decode on the CPU. Once FF-8 makes the GPU tonemap tier reachable, they would also miss it. That is the #322/#324 cast path, multiplied by the pre-warmed rungs (CASTS-3), and it runs below real time on iGPU-class CPUs.
- **Fix (S):** WP4.

**H11 · FF-1: VAAPI writes `level_idc` 4 instead of 40 into 1080p H.264 streams.**
- **Confidence:** confirmed on the encoder side. Decoder behaviour is high confidence, from Chromium's source.
- **Where:**
  - `internal/streaming/hwaccel.go:546-549`: `h264Level` renders `"4.0"`, which VAAPI receives at `:447`.
  - HEVC: `:700` and `:714-715`.
  - Zero-copy tier: `hwdecode.go:168`, `:188`, `:199`, `:210`.
  - `hwaccel_test.go:242-245` pins the wrong belief.
- **Evidence:**
  - `ffmpeg -h encoder=h264_vaapi` lists the named levels `1`, `1.1` … `4`, `4.1` …, with no `4.0`. The string `"4.0"` is therefore evaluated as the number 4.
  - The reviewer's libavcodec 6.1.1 harness got `h264_vaapi "4.0" → 4` and `hevc_vaapi "3.0" → 3`. libx264 and NVENC do accept the dotted form.
- **Outcome:**
  - The 1080p rung at 30 fps or below, the most-watched one, carries an invalid level while the playlist advertises `avc1.640028`.
  - Chromium's hardware H.264 decoders (Windows D3D11, Linux VAAPI) reject that sequence header. The result is a software fallback, or a decode error on an ABR switch.
  - Hardware receivers are also at risk (device check).
- **Related:** `hevc_qsv` is given the 30× value (90/120/153) where Intel's API expects 10×, and gets High tier while the playlist says Main.
- **Fix (S):** WP5.

**H12 · PARTY-1: every graceful restart ends every scheduled party.**
- **Confidence:** confirmed. The in-memory part was tested; the database step was traced.
- **Where:**
  - `cmd/aurora/main.go:1100` calls `internal/watchparty/manager.go:3362-3380` (`Shutdown` ends all parties).
  - `endPartyInternal` then broadcasts `party-ended`, runs `EndWatchParty` (`is_active=false`, `internal/db/queries_parties.go:284-292`), and soft-deletes non-persistent rooms.
  - At boot, rehydration selects only `is_active = TRUE` (`internal/db/queries_party_invites.go:180-192`).
- **Outcome:**
  - Every deploy (the auto-updater runs `systemctl restart`) kills scheduled parties. Invites and calendar chips then point at dead codes.
  - CLAUDE.md's invariant only holds after a crash.
  - A second defect: rehydrated parties restart at `StateRevision` 1 while reconnecting clients keep their revision floor, so they ignore the snapshot and the scheduled-start tick.
  - The existing restart test builds a fresh manager and never calls `m1.Shutdown()`.
- **Fix (S):** WP6.

**H13 · PARTY-2: "Play for all" starts the room clock before anyone has loaded the next episode.**
- **Confidence:** high (traced).
- **Where:** `VideoPlayer.tsx:4235-4240`. The host's race-recovery check compares only `partyMediaItemId === target.mediaItemId`, which is the series ID; its effect dependencies are at `:4274`.
- **Outcome:**
  - The `media-change` echo sets `isPlaying=false` while the old episode is still playing its credits, so the recovery sends `requestPlay`.
  - Guests' old episode is hard-snapped to about 0:00 and plays.
  - The host boots the new episode at 0 while the room is already ahead, and is never corrected (PARTY-5).
  - This happens whenever "Play for all" is pressed while the old episode is still playing. The recovery requires `!vid.paused`, and an element that has reached `ended` is paused.
- **Fix (S):** WP6.

## 4. Medium and low findings

IDs are the reviewers'. The prefixes are:
- **LIFE:** HLS session lifecycle.
- **FF:** FFmpeg arguments.
- **DEC:** playback decision and direct play.
- **SUB:** subtitles.
- **CASTC:** Cast sender (SPA).
- **CASTS:** casting, server side.
- **PARTY:** watch party.
- **WEB:** the browser player.
- **X / OPS:** cross-cutting and operations.

Where two reviewers found the same defect, the row gives both IDs.

### HLS lifecycle and encoding

| ID | Sev | Finding | Where | Fix · WP |
|---|---|---|---|---|
| LIFE-2 | M | Session folders from an unclean exit are never removed, and the disk cap doesn't count them. A normal restart during playback also lets recovering clients create sessions after cleanup. | `streaming.go:1969-2092`, `:2532-2548`; `cmd/aurora/main.go:1104-1107` | Clear at startup; refuse creates after `Close` (S) · WP3 |
| LIFE-3 / CASTS-3 | M | The caps limit sessions, not encoders. A member can run rungs × 3 encoders. Every cast pre-warms all rungs, including a 2160p H.264 level 5.1 rung only the Chromecast with Google TV and Google TV Streamer can decode. Unready rungs can't be reaped. | `streaming.go:2936-2956`; `phase2_handlers.go:1500-1515` | Single-rung cast copy, no all-rung pre-warm (S) · WP4; running-encoder cap (M) · WP8 |
| X-3 | M | The idle reaper can't stop a paused player's encoder. hls.js reloads a playlist without `ENDLIST` even while paused (`hls.js/src/controller/base-playlist-controller.ts:225`), and every poll refreshes `lastFetch` (`streaming.go:3416`). It only ever reaps rungs the player switched away from, and never the subtitle-carrier rung (`:2492`). A naive "count segment fetches only" fix would loop, because every playlist poll relaunches a reaped rung (`:4760` → `:3427`). | `streaming.go:2459-2513` | Change the resume trigger together with the activity signal (M, design first) · WP8 |
| LIFE-4 | L | Disk-cap eviction decides on a stale `lastAccess` snapshot, so a viewer who just resumed can be evicted. | `streaming.go:2532-2573` | Re-read under the lock (S) · WP3 |
| LIFE-5 | L | A readiness timeout marks the rung failed but leaves FFmpeg running; the rung then 500s until EOF or delete. HDR readiness budgets (130–180 s) exceed the 120 s `WriteTimeout` (`cmd/aurora/main.go:1017`), and the HLS handlers never extend it. | `streaming.go:4607-4612`, `:4773-4793`, `:1908-1924` | Cancel on timeout; extend the deadline or cap the budget (S) · WP3 |
| FF-3 | M | QSV and AMF never split segments at the forced keyframes: no `-forced_idr`, and AMF ignores the forced frame type before FFmpeg 9. Segments follow the encoder's GOP (about 10.4 s at 24 fps) or never close. | `streaming.go:4312-4323` | `forced_idr` plus `-g`/`-keyint_min` (S) · WP5 |
| FF-6 | M | Rotation metadata is ignored. A 640×360 file rotated 90° is output as 640×1138 (a 1.78× upscale) under the wrong playlist resolution and level. A 4K portrait clip becomes 3840×6826, beyond every hardware encoder's limit. | `internal/library/ffprobe.go:143-145`; `profiles.go:178-231` | Rotation-aware ladder (S) · WP5/WP10 |
| DEC-5 / FF-5 | M | Nothing is ever deinterlaced (no `yadif`, `bwdif`, or `deinterlace` anywhere), and `field_order` isn't probed. DVD, broadcast, and 1080i sources are combed; measured 18.4 versus 1.2 "ghost" pixels per row. | `hwaccel.go:410`; `internal/library/ffprobe.go:54-70` | Probe, then insert `bwdif`/`yadif_cuda`/`deinterlace_vaapi` (M) · WP10 |
| FF-2 / SUB-4 | M | Bitmap burn-in emits **two** video streams (the overlay plus a full-resolution re-encode), roughly double the CPU; Chrome's MSE rejects that init segment. Because the video is scaled before the overlay, subtitles vanish on downscaled rungs, and the VAAPI variant fails filter init. Reachable only through the API and cast copies. | `subtitles.go:1033-1043`; `streaming.go:4204-4213`, `:5654-5681` | Overlay then scale; map the labelled output (S) · WP5 |
| FF-7 | L | The crash retry only switches *decode* to software. Encoder-side failures (an NVENC session cap, FF-6's oversized frames) fail again with the same arguments. | `streaming.go:3489-3527` | Software-encode fallback (M) · WP8 |
| FF-8 | L | The GPU tonemap probe can never pass: `tonemap_vaapi` needs mastering-display metadata and the probe sample has none. The VAAPI GPU tonemap tier is therefore dead code. | `hwdecode.go:277-278`, `:349-352` | Fix the probe sample (S) · WP5 |
| FF-9 | L | `-avoid_negative_ts` is placed before `-i`, so it is an input option with no effect. The comments saying the first DTS is 0 are false. Behaviour is internally consistent today. | `streaming.go:4067-4115`, `:5290-5298` | Correct the comments; move the flag only together with `X-TIMESTAMP-MAP` (S) · WP5 |
| FF-10 | L | The zero-copy tier ignores chroma subsampling, so a 4:2:2/4:4:4 source's first launch dies and recovers through the retry. | `hwdecode.go:70-96` | Chroma check (S) · WP5 |
| CASTS-7 | L | The H.264 level is picked by rung height only. For a 1080×1920 portrait source every rung is declared 5.1 (854×1518 needs only 4.0), so older receivers filter out every rung. 1080p at 120 fps is under-declared. | `hwaccel.go:516-542` | Compute from H.264 Table A-1 (S) · WP4 |

### Playback decision and direct play

| ID | Sev | Finding | Where | Fix · WP |
|---|---|---|---|---|
| DEC-1 | M | A commentary or audio-description track is picked when the default track can't be copied. Examples: `[TrueHD default, AC-3 "Commentary"]` on Safari or Edge; `[E-AC-3, AAC "Audio Description"]` on Chrome. The scanner drops those dispositions; golden lines 174-175 pin the behaviour. | `streaming.go:1287-1315`; `internal/library/ffprobe.go:72-75`, `:147-155` | Record dispositions; exclude flagged tracks (S–M) · WP10 |
| DEC-2 | M | The in-player audio picker does nothing on direct-play titles: the same default track reloads while the menu shows the new one. | `VideoPlayer.tsx:6148-6167`, `:2534`, `:2671` | Pass the track to stream-info; remux to select it (S) · WP11 |
| DEC-3 | M | Safari reports `hls_js` but plays HLS natively, so in TS mode HEVC is remuxed into TS that AVPlayer can't play, with no fallback. iPhone never reports `ac3`/`eac3_mse` because it has no `window.MediaSource`. TS mode is the documented rollback, so this only fires with that setting. | `lib/streaming.ts:390`; `VideoPlayer.tsx:2914-2916`; `streaming.go:506` | Emit `hls_js` only when it is used; probe `ManagedMediaSource` (S) · WP11 |
| DEC-4 | M | HEVC MP4s tagged `hev1` (FFmpeg's default tag) are direct-played to Safari and the macOS AVFoundation engine, which require `hvc1`. Plausible: device check needed. | `internal/library/ffprobe.go:54-70`; `streaming.go:440-446` | Store the codec tag; remux and retag (S–M) · WP10 |
| DEC-6 / SUB-5 | M | In TS mode a remux decision is promoted to a transcode, but the SPA keeps `remux=1`. Sidecar cues run up to one GOP late, and a silent H.264 MKV is fully transcoded. | `streaming.go:2741-2768`; `VideoPlayer.tsx:2887`; `phase2_handlers.go:1853`, `:2439-2460` | Read `remux` from the response; model the promotion (S) · WP7 |
| DEC-WebM | M | Every WebM file is fully transcoded, even in browsers that play WebM. ffprobe reports `matroska,webm`, the scanner keeps `matroska` (so `mkv`), and VP8/VP9/AV1 are never remuxed. Verified. | `internal/library/ffprobe.go:106-108`; the VP8/VP9/AV1 branch of `DecidePlaybackFor` | Detect WebM (M) · WP10 |
| DEC-7 | L | The `hevc_main10` capability admits 12-bit, 4:2:2, and 4:4:4 HEVC; H.264 4:2:2/4:4:4 is direct-played everywhere. | `streaming.go:243-246`, `:465-481` | Chroma-aware capabilities (S) · WP11 |
| DEC-8 | L | `GetStreamInfo` has no rating-ceiling check, and `CreateSession`'s 404 wording tells "missing" apart from "blocked", which defeats #462's goal. | `phase2_handlers.go:2057-2282`; `:1607`/`:1621` vs `:1637`/`:838` | Check the ceiling; one message (S) · WP11 |
| DEC-9 | L | The reason code `bit_depth` is used for 10-bit HEVC on clients with no HEVC support at all (telemetry). | `streaming.go:763-764` | S · WP11 |
| DEC-10 / CASTS-8 | L | Every direct-play range request writes a `stream_started` activity row and repeats database lookups, synchronously. | `phase2_handlers.go:995-1017` | Log once per new registry entry (S) · WP11 |
| DEC-11 | L | QoE would report `tonemap_gpu` for sessions that tonemapped on the CPU. It is latent today: the label needs the GPU tonemap probe to pass, which FF-8 shows it never does. Fixing FF-8 makes it live. | `qoefacts.go:98-103` | Record the actual decode plan, in the same change as FF-8 (S) · WP5 |
| DEC-12 | L | The native-client contract says to use a Bearer token, which the server doesn't issue; the macOS client's 4-hour file token is never renewed. | `docs/native-client-caps.md:172-174`; `AuroraClient.swift:211-220` | S · WP13 |

### Subtitles

| ID | Sev | Finding | Where | Fix · WP |
|---|---|---|---|---|
| SUB-PGS | M | PGS and VobSub subtitles cannot be shown in the web player at all. The comment at `VideoPlayer.tsx:2582` points to a burn-in path that no client uses. | `VideoPlayer.tsx:2575-2587` | libpgs (M) · WP16 |
| SUB-1 | M | Concurrent extractions of one track aren't coalesced, and a cancelled request deletes the surviving request's output. Extractions hold gate slots for up to 10 minutes, and `GetStreamInfo`/`CreateSession` wait on the same gate, so playback starts stall server-wide. | `subtitles.go:386-418`; `phase2_handlers.go:44-66`, `:2547-2566` | Single-flight, temp file plus rename, separate gate (M) · WP9 |
| SUB-2 | M | TTML, teletext, and ARIB tracks get `-c:s webvtt`, which aborts the launch. That spends the rung's only restart (or flips the session to software decode) and drops every inline subtitle. The `IsTextSubtitle` allowlist has no production caller. | `phase2_handlers.go:1784-1796`; `subtitles.go:1086` | Use the allowlist (S) · WP7 |
| SUB-3 | M | Non-UTF-8 sidecars break: accented cp1252 `.ass` lines are silently dropped, cp1252 `.srt` shows U+FFFD, and UTF-16 `.srt` produces zero cues. | `subtitles.go:795-901`, `:467` | BOM and charset handling (S) · WP7 |
| SUB-6 | M | In TS mode, with native HLS or AirPlay, `X-TIMESTAMP-MAP` pairs the probed PTS with `LOCAL 0` while cues use the `-copyts` file clock. Subtitles run late by the whole session anchor (measured +29.98 s). | `streaming.go:5290-5349`, `:5411-5412` | Emit `MPEGTS:0` (S) · WP7 |
| SUB-7 / FF-4 | M | Inline subtitle playlists don't follow the video segment grid: the first `EXTINF` is about the anchor length, with runs of `0.000`. The playlist doesn't exist until the second cue, so sparse or forced DEFAULT tracks 404. Affects the macOS AVPlayer engine, AirPlay, and Safari native HLS. | `streaming.go:4426-4470`, `:5072-5104` | Build subtitle playlists server-side (M) · WP9/WP17 |
| SUB-8 | M | Burning in an embedded text track makes libavfilter read the whole file at init, so a NAS remux misses the readiness budget. API-only. | `streaming.go:5710-5711` | Burn from a cached extract (M) · WP9 |
| SUB-9 | L | ASS → WebVTT leaks vector drawings as visible text and leaves `&`, `<`, and `-->` unescaped. | `subtitles.go:396-402`, `:887-892` | S · WP7 |
| SUB-10 | L | Sidecar discovery cross-matches files (`S01E1` ← `S01E10.en.srt`) and reads `.forced`/`.sdh` as the language. | `subtitles.go:937-951` | S · WP7 |
| SUB-11 | L | The SUBTITLES group can have duplicate `NAME`s and several `DEFAULT=YES`, breaking two RFC 8216 MUSTs. | `profiles.go:306-330` | S · WP7 |

### Casting

| ID | Sev | Finding | Where | Fix · WP |
|---|---|---|---|---|
| CASTC-4 | M | A failed seek re-point stops a healthy cast and closes the player silently. A re-point needs 3 concurrent sessions against a per-user cap of 3. | `VideoPlayer.tsx:5298-5337`, `:1956-1966`; `lib/castSession.ts:120-142` | Keep the receiver on failure; release the old copy first (S/M) · WP2 |
| CASTC-5 | M | Changing the audio track while casting never reaches the TV and starts a stray local transcode; volume and mute act on the local element. | `VideoPlayer.tsx:6146-6165` | Re-point or disable; `RemotePlayerController` (S) · WP2 |
| CASTC-6 | M | Soft subtitles never reach the receiver. `castLoadGetter` passes no `textTracks`, and the subtitle route is cookie-only and not in the receiver CORS list. | `VideoPlayer.tsx:1137-1157`, `:1197-1216`; `internal/api/cors.go:28-31` | Token-authenticated VTT route (M) · WP18 |
| CASTC-7 | M | The local HLS session keeps encoding to EOF throughout every cast (see X-3). | `VideoPlayer.tsx:1509-1537` | `stopLoad()` on connect lets today's reaper stop non-carrier rungs (S) · WP2; the subtitle-carrier rung needs WP8/WP9 |
| CASTC-8 | M | When no cast copy is made, the receiver gets fMP4 with no format declared, and Google documents an unspecified format as treated as TS. `TestCloneForCast_TranscodeReusedUnchanged` only uses a TS fixture. | `streaming.go:1127` vs `:1051-1054`; `lib/cast.ts:762-763` | Copy when fMP4, or declare the format (S) · WP4 |
| CASTC-9 / CASTS-5 | M | Cast tokens expire 4 h after mint. `resumeCast` and `seekCastSafely` renew an expired token on a resume or seek, but nothing renews it during uninterrupted playback, and a resume from the TV remote bypasses renewal. The AirPlay token is minted when the local session starts (`VideoPlayer.tsx:2933`), so a hand-off more than 4 h later fails at once. Safari's own local playback is *not* affected: an expired cast token isn't promoted, and the cookie takes over (`router.go:253-260`). | `internal/auth/auth.go:213-217`; `VideoPlayer.tsx:1419-1455` | Session-bound validity or proactive renewal (M) · WP13 |
| CASTS-4 | M | Every Safari/iOS local playback gets the 30-minute cast lease. Abandoned tabs then hold the 3 per-user slots (shared by all profiles), so the next seek, title, or cast gets 429. | `phase2_handlers.go:1302-1326`; `VideoPlayer.tsx:2915-2939` | Reclaim the caller's idle leased sessions before 429 (S–M) · WP4/WP13 |
| CASTC-10 | L | The cast token's expiry is recorded at mint, not when the load succeeds. | `VideoPlayer.tsx:1118`, `:1170` | S · WP2 |
| CASTC-11 | L | A session started from Chrome's cast menu never loads media, and after any earlier stop it is ignored. | `lib/cast.ts:543-546`, `:835` | S · WP2 |
| CASTC-12 | L | The error table maps `load_failed`, but the SDK sends `load_media_failed`; reload-effect failures are silent. | `lib/cast.ts:81`; `VideoPlayer.tsx:1960-1964` | S · WP2 |
| CASTS-6 | L | A HEAD request carrying a cast token refreshes the session and leases it. | `phase2_handlers.go:1325` → `streaming.go:3094-3095` | S · WP4 |

### Watch party

| ID | Sev | Finding | Where | Fix · WP |
|---|---|---|---|---|
| PARTY-3 | M | A missed or failed `media-change` leaves a guest's open player on the previous episode, driven by the new episode's clock. | `hooks/useParty.tsx:500-590`, `:646-673`; `App.tsx:3442-3531` | Retarget from state (M) · WP12 |
| PARTY-4 | M | When a casting host reaches the end of a title, the party clock keeps running. Guests loop `play()` on an ended element, and late joiners resume past EOF. | `VideoPlayer.tsx:1808-1815`, `:4559`; `App.tsx:4792` | Pause on end; server auto-pause (S–M) · WP12 |
| PARTY-5 | M | The host's own playback is never reconciled with the server clock, and a casting host's stalled TV never exceeds the 3 s tolerance. | `VideoPlayer.tsx:3915-3926`, `:4181-4198`; `lib/partyPlayer.ts:903`, `:929-931` | M · WP12 |
| PARTY-6 | M | When pause is allowed (`AllowPause`, on by default for parties the SPA creates), any guest can move the room with `request-pause`'s `at_ms`. Seek is host-only, but the pause position isn't clamped. | `internal/watchparty/sync_v3.go:931-946` | Ignore or clamp `at_ms` (S) · WP6 |
| PARTY-7 | L | A stale seek or `hello` is replayed as a rebuild when a guest's player binds. | `VideoPlayer.tsx:3937-3962` | S · WP6 |
| PARTY-8 | L | Holding an arrow key as host floods `request-seek` and exhausts the shared 120/min budget, including time-sync probes. | `VideoPlayer.tsx:5517-5539` | Debounce; separate bucket (S) · WP6 |
| PARTY-9 | L | A sync intent buffered in one party is replayed into the next party joined. | `hooks/useParty.tsx:1159-1215` | S · WP6 |
| PARTY-10 | L | `initial_position_ms` is unbounded (the room path accepts negatives); `{"to_ms":null}` decodes to 0; host-close goroutines sleep 90 s and can't be interrupted. | `party_handlers.go:273-276`; `room_handlers.go:227-229`; `party_ws_v3_sync.go:224-229` | S · WP6 |

### Browser player

| ID | Sev | Finding | Where | Fix · WP |
|---|---|---|---|---|
| WEB-6 | M | Aborting an in-flight `createSession` strands the server session, because the server ignores the disconnect. A burst of skips can hit the per-user cap (429) for minutes. | `VideoPlayer.tsx:2867`, `:3580`; `phase2_handlers.go:1805` | Don't abort (S) · WP1 |
| WEB-7 | M | The solo next-up advance doesn't mark the episode watched; only the party path does. | `App.tsx:4788-4845` vs `:4939-4952` | S · WP1 |
| WEB-8 | M | A 404 or 410 on a dead session becomes a terminal error before the keepalive rebuild can run. Plausible (timing-dependent). | `VideoPlayer.tsx:3522-3537` | Route to keepalive (S) · WP14 |
| WEB-9 | L | Without a server duration, any mid-file rebuild marks the title complete, and completion is sticky. | `VideoPlayer.tsx:5694-5696` | S · WP1 |
| WEB-10 | L | Safari native-HLS error handling lacks the hls.js path's recovery. | `VideoPlayer.tsx:3038-3054` | S · WP14 |
| WEB-11 | L | No final progress write on pause, close, target change, or tab close; up to 10 s is lost, and a scrub made while paused is never saved. | `VideoPlayer.tsx:5673-5705` | S · WP1 |

### Operations and configuration

| ID | Sev | Finding | Where | Fix · WP |
|---|---|---|---|---|
| OPS-1 | M | The installer never gives the `aurora` user GPU access (no `render`/`video` group, no `SupplementaryGroups=`). On stock Debian/Ubuntu, VAAPI/QSV likely fail their test encode and silently fall back to CPU. Fedora's default `ffmpeg-free` has no libx264. Check a real install with `id aurora` and the "test encode failed" log line. | `scripts/install.sh:893`; `scripts/aurora.service` | WP15 |
| OPS-2 | L | `configs/aurora.yaml:48` says `max_sessions: 0 = unlimited`; the code clamps to 8 sessions (3 per user). | `streaming.go:1794-1802`, `:2299-2313` | Fix the comment (S) · WP15 |
| OPS-3 | L | `v3RequestPlayPayload` is unused (staticcheck). Otherwise `go vet` and staticcheck are clean on the reviewed packages. ESLint reports no errors on the player and cast files, only warnings (unused disable directives, and one intentional exhaustive-deps warning). | `party_ws_v3_sync.go:72` | Delete it (S) · WP6 |

## 5. Technology stack

Versions and statuses come from the stack research's primary-source checks on 2026-09-29. A separate reviewer re-confirmed three of them: hls.js 1.7.3, the Cast receiver's switch to Shaka, and FFmpeg 9.0's release. It could not confirm a jellyfin-ffmpeg 8.1.3 release, so the table says 8.1.x.

| ID | Area | Today | Verdict | Effort | Why |
|---|---|---|---|---|---|
| TECH-01, TECH-02 | FFmpeg | Distro package, run as a subprocess (`pkg_install ffmpeg`, no version floor) | **Keep** the CLI and the distro default. **Fix** the installer (WP15). **Pilot** a pinned build (TECH-02). | S–M / M | Ubuntu 22.04 ships 4.4.2 (no input pacing), Debian 12 ships 5.1 (no initial burst), and Fedora's `ffmpeg-free` lacks libx264. jellyfin-ffmpeg 8.1.x (apt repo) or BtbN *release* builds would give one feature set, plus `tonemapx` and CUDA tonemapping. |
| TECH-03 | Segmenting | FFmpeg `hls` muxer with growing EVENT playlists; a seek past the encoded edge rebuilds the session | **Replace, in phases:** server-generated VOD playlists with segments encoded on demand (Jellyfin's model), behind a config flag | L → XL | The structural fix for the up-switch stall, seek rebuilds, receivers treating the stream as live, and resume renumbering. |
| TECH-04 | Web player | hls.js 1.6.17 | **Keep hls.js; upgrade to 1.7.3** and move to load policies (WP14) | S | 1.7 brings `abrSwitchInterval`, a `capLevelToPlayerSize` fix and a live-reload fix. Shaka 5.2 and Video.js 8.24 / v10-RC are not better for this app. |
| TECH-05, TECH-06, TECH-07 | Chromecast | Default Media Receiver; cast copies forced to TS, H.264, and stereo AAC; every remux re-encoded | **Update:** CODECS on remux playlists, a declared segment format, and an fMP4 pilot. **Later:** one central custom receiver (WP18). | M + S; L | Google made Shaka the receiver's default HLS player on 2026-05-18, and MPL "will no longer receive critical updates". The force-TS rule was formed under MPL. |
| TECH-08 | AirPlay | WebKit AirPlay plus native HLS | **Keep** | — | The Remote Playback API has limited availability and can't cast hls.js/MSE playback. |
| TECH-09, TECH-10 | Subtitles | WebVTT; server burn-in (which no client triggers) | **Adopt** libpgs 0.9.0 for PGS (WP16). **Pilot** JASSUB 2.5.16 for ASS. | M each | PGS is unusable in the browser today. ASS styling and positioning are flattened. |
| TECH-11 | HDR → SDR | CPU `zscale` + `hable` after scaling; GPU `tonemap_vaapi` only on the zero-copy path, and its probe never passes (FF-8) | **Tier it** (WP19) | M | This is the heaviest CPU job; Aurora adds 90 s to the startup budget for it. Dolby Vision profile 5 is unhandled. |
| TECH-12 | Hardware pipelines | Per-backend flags built by hand, with real test encodes at startup | **Keep**, fix levels and keyframes (WP5), and choose Intel's backend by the tier it proved. No Vulkan encode and no AV1 output yet. | S | QSV has no zero-copy path and no GPU tonemap here. Vulkan Video encode is still behind flags or regressed on Mesa. |
| TECH-13 | Audio | FFmpeg's built-in AAC encoder, explicit downmix, AC-3 5.1, E-AC-3 copied into fMP4 | **Keep.** Optional pilot: multichannel AAC or Opus in fMP4. | — | libfdk_aac can't be redistributed with a GPL build, and gains little at 192k stereo. |
| TECH-14 | Probing | `ffprobe -show_format -show_streams` | **Keep, and store what it already returns** (WP10) | S–M | MediaInfo isn't needed. The missing facts (tag, field order, rotation, dispositions, DV record, level) are already in the output. |
| TECH-15 | Go libraries | FFmpeg as a subprocess; hand-written playlist code | **Keep** | — | go-astiav needs cgo and FFmpeg 9, and linking GPL FFmpeg into Aurora's binary is a licence problem. grafov/m3u8 is archived. WP17 removes most of the parsing anyway. |
| TECH-16 | macOS | AVPlayer + VLCKit 3.7.3 | **Keep VLCKit 3.7.x** (4.0 is still alpha). **Pilot** a libmpv engine for HDR/DV. | L | MPVKit describes itself as a learning project; weigh maintenance before adopting. |
| TECH-17 | Seek previews | None | **Add** keyframe-only sprite sheets plus WebVTT thumbnails | M | Scrub previews for direct play and for positions not yet encoded. |
| TECH-18 | QoE telemetry | Custom (`lib/playbackQoE.ts`, delivery facts stamped server-side) | **Keep.** CMCD v2 in header mode is optional. | S | Query-string CMCD would defeat the private segment cache. |

**Licensing and deprecation flags**
- **Deprecated in use:** hls.js `*LoadingTimeOut`/`*LoadingMaxRetry` (`VideoPlayer.tsx:3126-3130`).
- **Outdated assumption:** "the receiver can't do fMP4" was formed under MPL.
- **Never link GPL FFmpeg into the personal-use binary.** That rules out go-astiav, and MPVKit's GPL variant can't be shipped either.
- **jellyfin-ffmpeg:** its `libfdk_aac` build is non-redistributable under upstream's own rules. Install it from Jellyfin's repository; never mirror it.
- **JASSUB:** its WASM bundle needs LGPL and FreeType notices.
- **FFmpeg 9:** hosts upgrading to it need NVIDIA drivers that support NVENC SDK 11.1 or later.

## 6. Known gaps from CLAUDE.md

| Documented gap | Status after this review | Addressed by |
|---|---|---|
| Direct-play casting: receiver rejection isn't reliably detected; failed attempts can close the player; refusal doesn't fall back to HLS; no real-device test | Still open. CASTC-4 is the same "stop on failure" policy on the seek path. | WP2 (policy), WP18 custom receiver (error channel), device checklist (§8) |
| Midstream and party casting: no real-device coverage or encoded-edge signal; reload-based resume isn't broadcast; shared-session and authoritative-host corrections can't re-anchor; party media changes can leave a receiver on the previous item | Still open. CASTS-1 is a concrete instance on the shared path; PARTY-3 is the guest-player twin of the last point. | WP4 (making shared sessions re-anchorable), WP12, WP17 |
| HLS quality up-switch can stall (no cross-rendition encoded-edge contract) | Still open. LIFE-1 makes a return to a reaped rung worse than documented, and reviewers found no containment on the receiver path. | WP3 (LIFE-1), WP14 (`abrSwitchInterval`), WP17 |
| Native-client direct play | No gap listed. DEC-12 (token renewal and the contract's auth section) is new. | WP13 |

## 7. Checked and sound, or refuted

**Sound (sampled; each reviewer's full list is in the session record)**
- **Lock order:** there is no path that takes the manager lock while holding a session's variant lock, and the lifecycle tests are clean under `-race`.
- **Relaunch generation guard:** writes from an old FFmpeg can't touch its replacement, and the readiness channel is closed exactly once on every path.
- **Authorization:**
  - Other users' sessions get a uniform 404.
  - Cast tokens are bound to one session or one file and are rejected on delete, keepalive, and mint.
  - `?token=` is promoted only when it is a cast token on `/api/stream/`, and it is redacted from logs.
  - Credential-less CORS is limited to the receiver routes.
- **`ServeFile`:** range, If-Range, multi-range, suffix ranges, HEAD, and files over 4 GB all go through `http.ServeContent`. Containment resolves symlinks.
- **Decision engine:** the audio copy policy matches the playlist codec strings. The track index means the same thing everywhere. `effectiveDefaultIndex` matches Chromium's MP4 audio selection.
- **Time sync:** the party time-sync offset and round-trip formulas are correct, and seek and pause positions are clamped to 0–24 h.
- **Burn-in and sidecars:** text burn-in timing, the sidecar cue shift, and `extractFirstPTS` are correct.
- **macOS client:**
  - The engine picker disables engines that aren't installed, and startup refuses a missing one, so the capabilities it sends always match the engine that plays.
  - The capability list is compared with `docs/native-client-caps.md` by tests.
  - Its two findings are DEC-4 (`hev1` under AVFoundation) and DEC-12 (the 4-hour token, and the contract's auth section).

**Refuted during verification**
- **Keyframe burst after a seek:** "With `-copyts` and `-ss`, `-force_key_frames expr:gte(t,n_forced*6)` forces a keyframe on every frame until `n_forced` catches up." False.
  - A real FFmpeg 6.1.1 run gives exactly one keyframe per 6 s.
  - For 4.2, 4.3, 4.4, 5.1, 7.1, and 8.0, the source (read, not run) computes `t` relative to the first encoded frame (`forced_kf_ref_pts` / `ref_pts`).
- **Safari and expired tokens:** "Safari's local HLS playback dies when its cast token expires." False. An expired cast token isn't promoted, and the request falls back to the cookie. The Chromecast half of CASTC-9 stands.

## 8. Method and limits

**How the review was done**
- Eight independent, read-only reviewers each took one slice:
  - HLS lifecycle
  - FFmpeg arguments
  - decision and direct play (including macOS)
  - subtitles
  - server-side casting
  - the Cast sender
  - the browser player
  - watch party
- A ninth researched the technology stack.
- Every high finding in §3 was then independently re-checked by reproduction, code trace, or FFmpeg's own option table before being included here.
- Before merge, a separate reviewer checked this document against the code. It confirmed all 13 high findings and about 40 of the other rows. It corrected fix guidance for X-3, WEB-1, and WEB-3, and several smaller statements; those corrections are folded in.

**Reproduction tools**
- **FFmpeg 6.1.1:** Ubuntu 24.04 build, with libx264, libx265, zscale, libplacebo, and libass, run on lavfi and hand-built fixtures (PGS, cp1252/UTF-16 subtitles, interlaced MPEG-2, rotated video, TTML).
- **hls.js 1.6.17 source:** its playlist parser and merge code run under vitest.
- **jsdom harness:** mounts the real `VideoPlayer` with fake hls.js and Cast SDK objects.
- **Go probe tests:** use a stub `ffmpeg` that records its arguments.
- **Static checks:** `go vet`, staticcheck, and ESLint.

**Not possible here**
- GPU encoders (reasoned from FFmpeg source and help output).
- Real Chromecast, Safari/iOS, and AirPlay devices.
- PostgreSQL-gated tests.

**Probe tests.** They were not committed, and they live in this review session only. Rebuild them from the "Evidence" notes above as permanent tests alongside each fix.

**Device checks needed before closing these items**
1. **CASTS-1:** cast a shared, cast-safe transcode session 40 minutes in. Does the receiver buffer forever, or restart near the anchor?
2. **CASTC-8 / WP18:** fMP4 cast with and without `hlsSegmentFormat` declared, per device generation. Re-test the #328 subtitle-rendition stall under Shaka.
3. **FF-1:** play a VAAPI-encoded 1080p rung in Chrome with hardware decode (Windows D3D11 and Linux VAAPI) and on a Chromecast.
4. **DEC-4:** an `hev1`-tagged HEVC MP4 in Safari and in the macOS AVFoundation engine.
5. **DEC-3:** in TS mode (`transcode.segment_format: ts`), an HEVC MKV with AAC audio in Safari on macOS and iOS.
6. **CASTC-3:** reload the page mid-cast and confirm the SDK resumes the session.
7. **OPS-1:** on a fresh Intel or AMD install, check `id aurora` and whether the startup test encode passes.
