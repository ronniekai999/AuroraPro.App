# Playback, transcoding, and casting review (September 2026)

**Status:** first-priority code repairs implemented; deployment/device validation and the remaining backlog stay open (§11).
**Original review:** commit `390d02e`, 2026-09-29.
**Follow-up:** 2026-09-30; main `bf995002fbd9d2f158714120dbde0295df67e4bf` (verification details in §9).
**Implementation follow-up:** 2026-10-01; dated first-priority candidate evidence in §10.
**Merge follow-up:** 2026-10-02; resolved release changes and current validation limits in §11.
**Scope:**
- **Server:** `internal/streaming`, the stream and cast handlers in `internal/api`, cast tokens in `internal/auth`, and the watch-party sync engine (`internal/watchparty`, `internal/api/party_ws_v3_*`).
- **SPA:** `VideoPlayer.tsx`, `lib/cast*.ts`, `lib/streaming.ts`, `lib/partyPlayer.ts`, `hooks/useParty.tsx`.
- **Native:** the macOS client's playback layer.

When required fixes have landed and optional enhancements have an implement/defer decision, delete this file. It stays in Git history, per [`docs/README.md`](README.md).

## Contents

1. [Summary](#1-summary)
2. [Remediation plan](#2-remediation-plan--release-small-increments)
3. [High-severity findings](#3-high-severity-findings)
4. [Medium and low findings](#4-medium-and-low-findings)
5. [Technology stack](#5-technology-stack)
6. [Known gaps from CLAUDE.md](#6-known-gaps-from-claudemd)
7. [Checked and sound, or refuted](#7-checked-and-sound-or-refuted)
8. [Method and limits](#8-method-and-limits)
9. [Follow-up verification and decisions](#9-follow-up-verification-and-decisions-2026-09-30)
10. [First-priority implementation follow-up](#10-first-priority-implementation-follow-up-2026-10-01)
11. [Conflict resolution and merge follow-up](#11-conflict-resolution-and-merge-follow-up-2026-10-02)

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

After merging duplicates there are **13 high, 35 medium, and 29 low** findings, and nothing critical. The follow-up checked every row: all remain open on the pinned main revision. The revised §2 releases small slices, beginning with deploy-safe scheduled parties, profile attribution, and stable HLS numbering; it does not wait for a 20–25-day batch. There is no authentication bypass and no catalog data loss. The worst data problem is watch progress filed under the wrong profile.

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
10. CASTS-3 and CASTC-7: stop starting encoders nobody watches. Give a cast copy a single quality level (1080p or below) instead of pre-warming every rung, and stop the local player's playlist polling when a cast connects. The general paused-player case (X-3) needs a design change and is in slice 4G.

## 2. Remediation plan — release small increments

The goal is an initial corrective release in **2–4 developer-days**, followed by
small releases as each cluster clears its gates. These are estimates for
implementation and regression tests, **excluding independent review and hardware
availability**. The baseline HDR failure was traced to the fixture during the
first-priority implementation (§10); its repair must accompany those releases.
These estimates are not promised
calendar dates or a claim that the entire backlog takes less work. The original
20–25-day Phase 1 bundled too many unrelated changes before its first release.

Keep WP1–WP19 as traceability IDs, but split them into the PR-sized slices below.
Each slice branches from the latest `main`; contained changes with the same
failure path may share a PR. Dependencies land before dependent slices. Different
subsystems can be developed concurrently in separate branches when people are
available; do not combine their review or deployment gates.

### Release gates for every slice

Follow [`dev-workflow.md`](dev-workflow.md): investigate and cite the root cause;
branch; implement a regression that fails on the old behavior; build and test;
obtain a fresh-context, independent adversarial review of the final diff; resolve
all high/critical findings; record the verdict against the exact reviewed commit;
open the PR; squash-merge a clean change and delete its branch; update the notes.
Architectural or unsafe changes remain isolated and use the workflow's human
review path if their risks cannot be cleared. The review-record tooling is
advisory, as documented in CLAUDE.md.

- `go build ./...` and `go test -count=1 ./...` must pass. Restore the HDR baseline
  first; do not waive its failure or classify it as environmental without evidence.
- Run affected lifecycle and concurrency tests under `-race`. Use an isolated
  PostgreSQL test database for profile writes, shutdown/rehydration, quotas, and
  migrations. A skipped database test is not a passing acceptance check.
- For SPA changes, run `npm test` and `npm run audit` with Playwright Chromium
  installed. Component regressions must mount the actual player with fake media,
  hls.js, and Cast SDK objects; pure-helper tests cannot catch lost DOM listeners.
- Close a device-dependent finding only after the relevant real-device check.
  A code fix can land with an explicit outstanding device-validation item; it
  cannot be labeled device-verified. A GPU lane does not hold up CPU-only fixes.
- After merge, use the authorized admin deploy/test loop or the ordinary updater
  and smoke test. Verify the deployed revision, retain the prior working binary
  and SPA assets, and record results and rollback instructions in the slice's PR.
  This planning change does not deploy anything.

**Closure evidence:** each ID needs a fixing PR/commit, a before/after regression,
the final independent-review verdict, and its applicable deployed/device check.
Track implementation and validation separately. No ID is closed by this plan.

### Phase 0 · Establish a usable baseline

This is a gate, not a multi-week preparation project. Keep it limited to the
currently failing path and the harness required by the first fixes.

- The initial `TestPlaybackMatrix_MasterCodecsMatchSegments/transcode_hdr_tonemapped_to_sdr`
  failure with FFmpeg 7.1.5 was traced to missing BT.2020/PQ signalling in the
  fixture's raw HEVC bitstream (§10). Include the contained fixture repair and
  raw-bitstream regression before claiming the build/test gate is green.
- Rebuild the review's uncommitted probes as regressions **alongside the slice
  that needs them**. Do not wait for a universal player-harness rewrite or a
  complete device lab before starting small fixes.
- Arrange PostgreSQL plus a Chromecast and Safari/iOS test window early.
  Obtain Intel/AMD/NVIDIA hardware only for the hardware lane that needs it.

### Phase 1 · Protect scheduled parties, profiles, and resumed playback

**First release: 2–4 developer-days plus gates.** Three small PRs, with the
scheduled-party change deployed first. Do not wait for all of WP1, WP3, or WP6.

| Slice / branch | IDs and original package | Change and acceptance |
|---|---|---|
| 1A · `fix/party-restart-survival` | PARTY-1 · WP6a | Preserve scheduled, unstarted parties on graceful shutdown; cancel their timers and close connections without ending/deleting their DB rows or emitting `party-ended`. Fix the reconnect revision contract too. A real DB test must call `m1.Shutdown()` before `m2.RehydrateScheduledParties()` and reuse a client's pre-restart revision floor. Active parties keep their existing shutdown policy. |
| 1B · `fix/progress-active-profile` | WEB-1 · WP1a; DEC-8 · WP11a | Send `profile_id` on heartbeat, Mark as Watched, and Clear Progress; validate ownership. When omitted, prefer a real acting profile, retaining default-profile creation for synthetic ID 0 / OAuth sign-ups. Apply the rating ceiling to stream-info and use the same missing/blocked 404 wording. Verify two profiles on one account, a no-profile account, a foreign profile ID, and opt-in shared history. |
| 1C · `fix/hls-resume-numbering` | LIFE-1 · WP3a | When `append_list` can read the prior playlist, omit `-start_number`; preserve each existing filename-to-sequence mapping across two resumes. Retain the unreadable-playlist fallback and serve a media sequence matching its first listed filename. Exercise both TS and fMP4, remux and transcode, crash and reap. |

**Why 1A goes first:** the updater restarts the server. Before PARTY-1 is fixed,
deploying any other repair ends all scheduled parties. Test reconnect and timer
deduplication before using a deploy as the verification of another slice. This
restores persistence; it does not reconstruct parties already ended by a deploy.
Likewise, correcting WEB-1 does not automatically reassign historic progress:
there is no reliable record of which profile originally watched it.

### Phase 2 · Make common local playback and party advance dependable

**Rolling releases: 3–5 developer-days plus gates.** Depend on Phase 1's profile
fix for all new progress writers. The three slices can ship separately.

| Slice / branch | IDs and original package | Change and acceptance |
|---|---|---|
| 2A · `fix/player-rebuild-state` | WEB-2, WEB-3, WEB-4, WEB-6 · WP1b | Keep a logical absolute playhead through same-viewing rebuilds; preserve pause intent for keepalive and direct-play recovery. Bind media, AirPlay, and cast-pause listeners to the current DOM element. Do not abort `createSession`; receive and delete superseded sessions with a generation guard. Mount regressions for two rapid +10 s seeks, a second audio pick, error→Back→new title, a party target replaced while an error is visible, paused recovery, and a delayed create response after close. |
| 2B · `fix/player-progress-completion` | WEB-7, WEB-9, WEB-11 · WP1b | Mark the outgoing solo episode watched and flush progress on pause, seeked, close, target change, and pagehide. Preserve the outgoing target/profile in async writes. Use a trusted whole-file duration; never infer completion from a growing EVENT playlist. Use authenticated `fetch` with `keepalive` for pagehide; its delivery is best-effort. Test paused scrubs, a target switch during a write, absent duration, and episode completion. |
| 2C · `fix/player-party-recovery` | WEB-8, WEB-10 · WP14a; PARTY-2, PARTY-6 · WP6b | Route dead-session 404/410 through bounded recovery and preserve pause. Give native HLS one controlled rebuild for codes 2/3 and remux→transcode fallback for code 4. Gate host recovery on episode identity, pausing/suppressing old-title broadcasts during advance. Use the canonical room position for a guest pause. Test a removed session, slow next-episode resolution, and a guest trying to move the room through pause. |

Safari native-HLS behavior still needs Safari/iOS validation. Split the native
recovery implementation from the hls.js upgrade so a library/configuration change
does not obscure the behavioral regression.

### Phase 3 · Keep casting controllable and reduce wasted encoding

**Rolling releases: 5–8 developer-days plus gates.** Ship sender control and
progress first; device testing determines when cast-delivery changes close.

| Slice / branch | IDs and original package | Change and acceptance |
|---|---|---|
| 3A · `fix/cast-control-lifecycle` | CASTC-2, CASTC-3, CASTC-4, CASTC-5, CASTC-10, CASTC-11, CASTC-12 · WP2a | Gate App close/navigation on `remoteActive`, independently of widget expansion. Render a Stop widget for a resumed cast without a local target. On a failed seek replacement, keep the committed receiver media and show a toast. Disable unsupported audio switching with an explanation until replacement is implemented; route volume/mute to the receiver. Commit expiry only after successful load, handle Chrome-menu sessions, and map `load_media_failed`. Test expand→Escape/Back, reload→Stop, failure/quota paths, target replacement, and stop→start. |
| 3B · `fix/cast-progress-and-local-polling` | WEB-5 / CASTC-1 · WP1c; CASTC-7 · WP2b | Report absolute receiver time using the acknowledged `start_sec`; write FINISHED completion before advance/stop and flush disconnect once. Keep local progress reporting for AirPlay, whose element remains the source. Stop hls.js loading for Chromecast and restart it only if returning locally. Assert no duplicate writer or wrong-title completion and that ordinary unused rungs are reaped. The subtitle-carrier exception remains explicitly open until WP9/WP8. |
| 3C · `fix/cast-anchored-single-rung` | CASTS-1, CASTS-2, CASTS-3 / LIFE-3 (cast part), CASTC-8, CASTS-7 · WP4a | Clone an otherwise safe shared session when the sender is before its anchor or far beyond the available window; never re-anchor a session other viewers use. Retain `SourceVideoCodec` on copies. Give each new cast copy one supported H.264/AAC rung at 1080p or below, rather than merely removing pre-warm. Compute its level from width, height, macroblocks/sec, and applicable bitrate limits. Return the actual segment format; retain TS as fallback and test declared fMP4 on devices. A shared local ABR session must not have its ladder narrowed underneath its browser. |
| 3D · `fix/cast-lease-accounting` | CASTS-4, CASTS-6 · WP4b | HEAD must not acquire/extend a cast lease. Reclaim only the caller's demonstrably idle leased sessions before quota refusal. Test active-TV retention, abandoned native-HLS tabs, all profiles sharing the account quota, and a still-active shared session. |

**Quota correction to the original CASTC-4 guidance:** do not delete the working
cast copy before a replacement load succeeds. Design a bounded, quota-aware
replacement/reservation path, or refuse the operation visibly while keeping
playback and control. An extra unbounded session allowance is not the fix. The
tracker already has pending/committed slots and tests for retaining live media
when a load fails; preserve that contract.

CASTC-8's missing format field is real, but Google's current receiver reference
says it is required for **MPL**, whereas Shaka is now the default. Therefore a
specific Shaka failure cannot be asserted solely from the missing field. Declare
the actual format and test the target firmware; do not enable fMP4 globally on
the strength of the migration announcement.

### Hardware lane · Release independently when hardware checks pass

**WP5 + WP15: 4–7 developer-days plus real hardware/installer checks.** This can
start during Phase 1, but must not block useful CPU-only releases.

- **FF-1:** numeric VAAPI `level_idc` on every CPU-chain and zero-copy H.264/HEVC
  path; QSV HEVC uses the correct scale and Main tier. Validate emitted SPS and
  playlist CODECS together, not just a string-argument test. Keep FF-1 high for
  affected supported deployments even though the owner's box has no GPU.
- **FF-3:** QSV IDR/GOP controls; AMF GOP controls and `forced_idr` only when the
  installed encoder exposes it. Probe feature support rather than relying only
  on an FFmpeg major-version guess. Verify independently decodable segment starts
  at 23.976/29.97/59.94 fps and across a restart.
- **FF-2 / SUB-4:** one labeled bitmap-overlay output, mapped once; overlay at
  the source geometry before scaling, with the CPU/GPU transition handled. Test
  output stream count, positioning on downscaled rungs, and VAAPI initialization.
- **FF-8 + DEC-11:** fix mastering-display metadata in the tonemap probe and
  record the actual selected decode/filter plan in QoE in the same PR.
- **FF-10:** reject unproven 4:2:2/4:4:4 zero-copy paths.
- **FF-9:** correct timestamp comments only. Moving `-avoid_negative_ts` changes
  timing and requires its own combined video/subtitle continuity proof.
- **OPS-1, OPS-2, TECH-01, TECH-12:** grant GPU device access via available
  `render`/`video` groups, install suitable drivers by distro, check access as the
  service user, and select Intel's backend by the pipeline proven at startup.
  Keep RPM Fusion opt-in. Correct the cap comment; warn for old FFmpeg and missing
  encoders. Optional groups must not make CPU-only services fail to start.

### Phase 4 · Release compatibility and efficiency by capability

This replaces the original 30–40-day batch with separate deliverables. The
following estimates are per slice; the phase is **not** one release gate.

| Slice | Scope / IDs | Dependency and acceptance |
|---|---|---|
| 4A · Lifecycle hygiene (1–2 days) | WP3b: LIFE-2, LIFE-4, LIFE-5 | Serialize shutdown against creation; remove only stale owned session folders before the hardware-probe folder is made. Recheck eviction access under the lock. Cancel timed-out FFmpeg and align handler deadlines with readiness. Test creates racing Close, activity during measurement, and timeout cleanup. Startup cleanup must not touch another process's active workspace. |
| 4B · Text-subtitle compatibility (2–3 days) | WP7: SUB-2, SUB-3, SUB-6, SUB-9, SUB-10, SUB-11, DEC-6 / SUB-5 | Use the text allowlist; normalize BOM/charset handling; sanitize ASS drawing/text conversion; match sidecars by separators and language/forced/SDH flags; unique rendition names and one default. Return actual remux status. Test both segment formats and nonzero anchors; TS timestamp mapping must agree with the preserved source clock. |
| 4C · Player library (1–2 days) | WP14b: TECH-04 | Pin hls.js 1.7.3 and its lockfile, migrate to load policies, and bound ABR switching/error penalties. Re-run the established player/cast/party regressions, cold-rung timeout cases, frontend audit, and Safari fallback. Upgrade separately from state-machine repairs. Slower switching mitigates encoder churn; it does not close the up-switch stall. |
| 4D · Decision and protocol cleanup (2–3 days) | WP11b: DEC-2, DEC-3, DEC-7, DEC-9, DEC-10 / CASTS-8; WP6c: PARTY-7, PARTY-8, PARTY-9, PARTY-10, OPS-3 | Split decision and party changes into their own PRs. Honor a requested audio track by remuxing when the native file default differs. Share the actual native-HLS predicate and probe ManagedMediaSource. Fail closed on unproven chroma/depth combinations. Log direct playback once per registry viewing. Age stale seeks; debounce host intents without dropping the final seek; separate time-sync rate limits; clear buffered intents on join and teardown; validate positions/null seek; replace host-close sleepers with cancellable timers. |
| 4E · Source facts, then individual consumers (metadata 2–3 days; consumers 1–3 each) | WP10 / TECH-14: DEC-1, DEC-4, DEC-5 / FF-5, FF-6, DEC-WebM | Add backward-compatible fields for codec tag, level/profile, rotation, interlacing, audio dispositions, and DV metadata. Keep unknown values conservative. Bump the scanner/probe version or use a bounded metadata backfill so unchanged-file hashes cannot skip the new facts. Ship WebM identification/direct play, commentary exclusion, rotation, `hev1`→`hvc1` retagging, and deinterlacing separately. Prefer an explicitly requested commentary track over the automatic-selection filter. Confirm Apple behavior on devices. |
| 4F · Extraction service (4–5 days) | WP9: SUB-1, SUB-7 / FF-4, SUB-8; remainder of CASTC-7 / X-3's carrier case | Separate the extraction gate from probes; single-flight by fingerprinted output path; write temporary output and atomically rename only on success. Work belongs to a bounded server-lifetime job, not the first request. Cancel on shutdown and bound cache/concurrency. Generate subtitle playlists on the video grid, including sparse/empty tracks. Burn text from the cache. Test one client cancelling while another waits, source mutation, ten-minute extraction not blocking playback, and carrier removal/reaping. |
| 4G · Encoder budget (4–6 days) | WP8: X-3, LIFE-3 (global/user encoder part), FF-7 | Design the activity signal **and** wake trigger together. Playlist polling by a paused client must not repeatedly reap/relaunch. Resume on real demand near/beyond the available edge, with generation guards and fairness. Bound running and priming encoders globally/per user; return a usable quota error; test old-FFmpeg pacing. Add a bounded software-encode fallback for encoder-specific failures. Prefer WP9 before removing the carrier exemption. |
| 4H · Party convergence (4–6 days) | WP12: PARTY-3, PARTY-4, PARTY-5 | Retarget from authoritative state keyed by media and episode, with retry, and suppress corrections while identities mismatch. Pause the room at a known EOF before a casting host disconnects; never replay an ended guest element. Reconcile host stalls against projected room time over multiple samples, separating TV scrubs from drift. Test lost media-change, failed lookup, host stall, EOF, and late join. No dependency on VOD or a custom receiver. |
| 4I · Token lifecycle (2–4 days plus design/review) | WP13: CASTC-9 / CASTS-5, DEC-12; AirPlay part of CASTS-4 | Isolate the auth contract change. Session-bound validity must require a live authorized session, token-version revocation, and a hard lifetime bound; do not accept arbitrary expired JWTs. File tokens remain file-scoped and bounded. Mint/refresh for AirPlay handoff, and implement native renewal through the actual AVPlayer/VLC playback path, preserving position/pause. Test uninterrupted >4 h playback, TV-remote resume, logout, deleted session, abandoned tabs, and native 401 recovery. Correct the native auth contract. |
| 4J · Browser bitmap subtitles (PGS pilot 3–5 days; VobSub separately estimated) | WP16 / TECH-09: SUB-PGS | Reuse WP9 for bounded `.sup` extraction and adopt libpgs for **PGS only**. Test seek/rebuild offsets, worker cleanup, canvas alignment, memory, and supported fullscreen/PiP paths. Add a tested burn-in fallback for VobSub and surfaces that cannot carry a canvas overlay; finish FF-2 first. Browser canvas rendering does not deliver subtitles to Chromecast or AirPlay. |
| 4K · Cast efficiency and text tracks (3–5 days plus devices) | WP18a: TECH-05, TECH-06, CASTC-6 | After reliable source profile/level facts (4E), emit CODECS from the actual remuxed bytes and pilot H.264/AAC remux casting within receiver limits. Do not guess a CODECS string. Pilot declared fMP4 per device generation with TS fallback. Add a narrow file/session-scoped, token-authenticated WebVTT receiver route and credential-less CORS only there; pass text tracks and style. Retest #328 before enabling inline subtitle groups. |

Ship 4E's WebM and safe cast-remux work early once their prerequisites are ready:
they avoid full video encodes on the CPU-only production server. They do not need
VOD, GPU tonemapping, or a custom receiver. Keep 4F, 4G, and 4I isolated because
they change resource ownership or authorization contracts.

### Phase 5 · Isolated architecture and optional enhancements

These are pilots with their own acceptance gates, not dependencies for the
corrective releases above. Retain the current CLI/HLS/hls.js/WebKit/AVPlayer +
VLCKit stack while shipping the repairs.

1. **WP17 / TECH-03 — VOD pilot, transcode only first (3–6+ weeks).** Design a
   stable segment identity/timeline and on-demand scheduler, then opt-in behind
   `transcode.playlist_model: event|vod`, with EVENT as default and rollback.
   A 6 s grid plus forced keyframes is viable for transcodes; a stream-copy
   remux cannot be forced to that grid. Remux needs an actual keyframe index or
   a separate proven continuity strategy. Prove duration, nonzero/negative PTS,
   init-segment identity, A/V continuity, two rapid seeks, cross-rung alignment,
   concurrent consumers, cancellation, disk bounds, and missing-segment waits.
   Requests must not thrash encoders or return permanent 404s for future segments.
   Pilot subtitles/remux and cast/party integration afterward. Do not remove SPA
   workarounds or claim known gaps closed until the corresponding device paths
   have passed. VOD duration/ENDLIST alone does not guarantee correct casting.
2. **WP18b / TECH-07 — custom receiver (2–3+ weeks after design).** Defer until
   the DMR pilots establish a concrete remaining need. A receiver error channel
   and direct→HLS fallback merit a separate slice; advanced codec selection,
   receiver-owned progress/token renewal, and party messages are later slices.
   It need not wait for every VOD consumer, but validate the stream contract it
   actually uses. Keep DMR fallback, configurable app ID, central HTTPS hosting,
   registration/uptime ownership, and fork support explicit.
3. **TECH-02 + WP19 / TECH-11 — binary and HDR pilots.** Introduce configurable
   FFmpeg/ffprobe paths consistently across scan, extraction, probes, and encode
   before piloting a pinned build. Jellyfin `v8.1.3-1` now has a published release;
   verify package provenance and installation/rollback rather than changing the
   distro default wholesale. Tier tonemapping by measured capability, and admit
   Dolby Vision profile 5 only to a proven DV-aware path. CPU `tonemapx` can help
   the owner's box if the selected build supplies it. GPU tiers need device tests.
4. **TECH-10 — JASSUB ASS pilot.** Depend on bounded extraction, font delivery,
   worker cleanup, and the minimum CSP adjustment; keep notices and a WebVTT or
   burn-in fallback. Do not roll a new renderer into basic charset repairs.
5. **TECH-16 — libmpv macOS pilot.** Keep AVPlayer + stable VLCKit; evaluate HDR/DV
   benefit, package/license compatibility, signing, lifecycle, and maintenance in
   its own design. Reverify engine capability declarations if adopted.
6. **TECH-17 / TECH-18 — thumbnails and optional CMCD.** Ship thumbnail sprites +
   WebVTT after their CPU/storage cost is bounded. CMCD header mode is optional;
   measure value and receiver/CORS compatibility and preserve private cache
   behavior. Neither delays bug fixes.

**TECH-08, TECH-13, TECH-15:** retain WebKit AirPlay, existing AAC/downmix and
Dolby policy, and FFmpeg subprocess orchestration. Optional multichannel AAC or
Opus experiments need their own capability/device checks. No library replacement
is needed to deliver the first four phases.

### Rollout and rollback

Deploy one cleared slice or a small group of cleared dependent slices. Verify
local playback/seek/resume, a second profile's progress, and scheduled-party
survival on every corrective release; add cast, subtitle, or party scenarios for
the paths changed. Record startup errors, startup time, stalls, active encoder
count, session 429s, and completion writes against the prior version. Worsening
playback, cross-profile writes, lost parties, or orphaned casts triggers rollback.
Experimental delivery/renderer/HDR paths stay opt-in until their matrix passes.

Keep additive metadata migrations readable by the rollback binary, and retain
the old delivery mode during pilots. A binary rollback cannot recover historic
misattributed progress or parties already ended. The ledger in §9 remains open
until its evidence is recorded; delete this planning document only after all
required work lands and optional proposals receive an explicit implement/defer
decision, with durable contracts retained in their normal documentation.

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
| SUB-PGS | M | PGS and VobSub subtitles cannot be shown in the web player at all. The comment at `VideoPlayer.tsx:2582` points to a burn-in path that no client uses. | `VideoPlayer.tsx:2575-2587` | libpgs for PGS; separate VobSub/surface fallback (M) · WP16 |
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
| CASTC-4 | M | A failed seek re-point stops a healthy cast and closes the player silently. A re-point needs 3 concurrent sessions against a per-user cap of 3. | `VideoPlayer.tsx:5298-5337`, `:1956-1966`; `lib/castSession.ts:120-142` | Preserve committed media; bounded replacement or visible refusal (S/M) · WP2 |
| CASTC-5 | M | Changing the audio track while casting never reaches the TV and starts a stray local transcode; volume and mute act on the local element. | `VideoPlayer.tsx:6146-6165` | Re-point or disable; `RemotePlayerController` (S) · WP2 |
| CASTC-6 | M | Soft subtitles never reach the receiver. `castLoadGetter` passes no `textTracks`, and the subtitle route is cookie-only and not in the receiver CORS list. | `VideoPlayer.tsx:1137-1157`, `:1197-1216`; `internal/api/cors.go:28-31` | Token-authenticated VTT route (M) · WP18 |
| CASTC-7 | M | The local HLS session keeps encoding to EOF throughout every cast (see X-3). | `VideoPlayer.tsx:1509-1537` | `stopLoad()` on connect lets today's reaper stop non-carrier rungs (S) · WP2; the subtitle-carrier rung needs WP8/WP9 |
| CASTC-8 | M | When no cast copy is made, the receiver gets fMP4 with no format declared. Current receiver documentation makes the field requirement MPL-specific; a Shaka failure from this alone remains unproven. `TestCloneForCast_TranscodeReusedUnchanged` only uses a TS fixture. | `streaming.go:1127` vs `:1051-1054`; `lib/cast.ts:762-763` | Declare the actual format and device-test; retain TS fallback (S) · WP4 |
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
| PARTY-9 | L | A sync intent buffered in one party is replayed into the next party joined. | `hooks/useParty.tsx:1159-1215` | S · WP6 · fixed on branch `claude/sweet-brown-36veir-playback` (`4f1064e`, tests `ab8dd15`); not yet merged |
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

The original stack research used primary sources on 2026-09-29. The follow-up in §9 rechecked hls.js 1.7.3, the Cast Shaka migration, FFmpeg n9.0, and renderer packages, and confirmed Jellyfin FFmpeg v8.1.3-1 is now published. §2 and §9 qualify the segment-format conclusion, PGS/VobSub scope, and architectural adoption gates.

| ID | Area | Today | Verdict | Effort | Why |
|---|---|---|---|---|---|
| TECH-01, TECH-02 | FFmpeg | Distro package, run as a subprocess (`pkg_install ffmpeg`, no version floor) | **Keep** the CLI and the distro default. **Fix** the installer (WP15). **Pilot** a pinned build (TECH-02). | S–M / M | Ubuntu 22.04 ships 4.4.2 (no input pacing), Debian 12 ships 5.1 (no initial burst), and Fedora's `ffmpeg-free` lacks libx264. jellyfin-ffmpeg 8.1.x (apt repo) or BtbN *release* builds would give one feature set, plus `tonemapx` and CUDA tonemapping. |
| TECH-03 | Segmenting | FFmpeg `hls` muxer with growing EVENT playlists; a seek past the encoded edge rebuilds the session | **Replace, in phases:** server-generated VOD playlists with segments encoded on demand (Jellyfin's model), behind a config flag | L → XL | The structural fix for the up-switch stall, seek rebuilds, receivers treating the stream as live, and resume renumbering. |
| TECH-04 | Web player | hls.js 1.6.17 | **Keep hls.js; upgrade to 1.7.3** and move to load policies (WP14) | S | 1.7 brings `abrSwitchInterval`, a `capLevelToPlayerSize` fix and a live-reload fix. Shaka 5.2 and Video.js 8.24 / v10-RC are not better for this app. |
| TECH-05, TECH-06, TECH-07 | Chromecast | Default Media Receiver; cast copies forced to TS, H.264, and stereo AAC; every remux re-encoded | **Update:** CODECS on remux playlists, a declared segment format, and an fMP4 pilot. **Later:** one central custom receiver (WP18). | M + S; L | Google made Shaka the receiver's default HLS player on 2026-05-18, and MPL "will no longer receive critical updates". The force-TS rule was formed under MPL. |
| TECH-08 | AirPlay | WebKit AirPlay plus native HLS | **Keep** | — | The Remote Playback API has limited availability and can't cast hls.js/MSE playback. |
| TECH-09, TECH-10 | Subtitles | WebVTT; server burn-in (which no client triggers) | **Pilot** libpgs 0.9.0 for PGS (WP16); VobSub needs a separate fallback. **Pilot** JASSUB 2.5.16 for ASS. | M each | PGS is unusable in the browser today. ASS styling and positioning are flattened. |
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
| Midstream and party casting: no real-device coverage or encoded-edge signal; reload-based resume isn't broadcast; shared-session and authoritative-host corrections can't re-anchor; party media changes can leave a receiver on the previous item | Still open. CASTS-1 is a concrete instance on the shared path; PARTY-3 is the guest-player twin of the last point. | WP4 (isolated cast copies with appropriate anchors), WP12, WP17 |
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

**How the original review was done**

The follow-up is documented separately in §9; the reviewer counts and temporary probes below describe the original review.
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

## 9. Follow-up verification and decisions (2026-09-30)

This section records the September 30 pinned revision. See §11 for current
merge evidence and remaining deployment/device validation.

### What is fixed on main

**None of this review's findings has a landed fix.** The remote `main` revision
was verified as `bf995002fbd9d2f158714120dbde0295df67e4bf`. Compared with the
reviewed `390d02e`, its only changes are this document, the docs index, and a
review record. There are no application, test, migration, installer, or dependency
changes between those revisions. The count is correct: **13 high + 35 medium +
29 low = 77 distinct finding rows**, with duplicate reviewer IDs counted once.

This follow-up checked the implementation mechanisms for all 77 rows and the
stack proposals. It does **not** repeat the original review's uncommitted
reproductions, establish production deployment state, or certify real receiver,
GPU, macOS, or PostgreSQL behavior. The reported root causes remain actionable;
device-dependent outcomes stay conditional. Existing passing tests do not close
an ID, and several explicitly preserve the problematic expectations.

### Executed checks

| Check | Result and interpretation |
|---|---|
| Remote main / history | `git fetch origin main` and remote ref lookup agree on `bf995002`; reviewed behavior is unchanged. This proves merge state, not the live server's deployed revision. |
| Go build | `go build ./...` passes with the project's Go 1.26.5 toolchain. |
| Full Go suite | `go test -count=1 ./...` fails in `TestPlaybackMatrix_MasterCodecsMatchSegments/transcode_hdr_tonemapped_to_sdr`, using Debian FFmpeg 7.1.5. The isolated rerun fails too (FFmpeg exit 187, no video output, external-library error / encoder not opened). Root cause is not established; Phase 0 must resolve it. |
| Frontend unit suite | `npm ci` then `npm test`: **52 files / 838 tests pass**, with the existing hls.js 1.6.17 lockfile. These do not exercise all the listed player/cast state-machine defects. |
| Race checks | `go test -race -count=1 ./internal/watchparty ./internal/auth ./internal/api` passes. A targeted streaming race run covering resume, drain, cast, variant, timestamp, decode, level, and subtitle tests also passes. These do not close the missing regressions or skipped DB cases. |
| LIFE-1 reproduction | FFmpeg 7.1.5 EVENT/TS probe: four original files 0–3 are renumbered to sequences 4–7 on resume with `append_list` + `start_number=4`; the next files are 8–9. A second resume renumbers again. Omitting `start_number` preserves sequence 0 and produces contiguous files 4–5, then 6–7. This reproduces the muxer defect and supports the proposed fix; the permanent regression must cover fMP4 and the actual server path too. |
| Missing verification | `TEST_DATABASE_URL` is not configured; DB-gated tests are skipped. No real Chromecast, Safari/iOS, AirPlay, GPU, or macOS playback checks were performed. Frontend audit is a required gate for future SPA code changes, not run for this documentation-only edit. |

The failure of the existing HDR test is an additional **verification blocker**,
not an invented 78th confirmed root cause. Preserve the failing evidence and
investigate before asserting a clean release baseline.

### Agreement and corrections

The main diagnosis is sound: state, timeline, profile, cast-session, and resource
ownership defects deserve early repairs. Keep the basic technology stack. The
severity counts should not be read as a requirement to hold every unrelated fix
until all 77 issues are resolved; each released diff must clear the team's review
gate and its own dependencies, with residual backlog stated explicitly.

These changes to the original recommendations matter:

1. **Preserve a healthy cast on replacement failure.** Releasing its old copy
   before the new receiver load succeeds contradicts this requirement. Existing
   `castSession.test.ts` cases intentionally retain the committed copy when a
   pending mint/load is abandoned. Use bounded quota-aware replacement or a
   visible refusal, not premature deletion.
2. **PGS and VobSub require different solutions.** libpgs 0.9.0 describes itself
   as a PGS renderer and consumes `.sup`; adopting it cannot close VobSub or TV
   subtitles. Budget the fallback and surface-specific validation explicitly.
3. **Shaka changes the format-field conclusion.** Google confirms the default
   HLS migration on May 18, 2026. Its current receiver MediaInformation reference
   says segment-format fields are required for MPL. Missing fields remain a
   sender-contract gap, but a Shaka stall caused by their absence is unproven.
   Retest #328/#355 and firmware, retaining TS fallback until demonstrated safe.
4. **VOD is a direction, not a mechanical fixed-grid conversion.** Forced
   keyframes cannot impose a 6 s grid on stream-copy remuxes. Establish source
   timing, keyframe indexes, init identity, scheduler concurrency, and disk bounds
   before promising the architectural bug family is retired. Ship a transcode-only
   opt-in pilot first.
5. **Token lifetime is an auth-contract change.** Preserve scope, revocation,
   ownership, hard bounds, and receiver independence. A frontend remint alone
   does not update URLs already held by the TV; native renewal must actually
   reach AVPlayer/VLC. Keep this PR isolated.
6. **Prioritize deployments that cannot destroy schedules.** PARTY-1's shutdown
   fix precedes the first corrective deploy. Profile repair precedes any new cast
   or completion writer. Neither repair can infer and reconstruct old damage.
7. **Split metadata capture from consumers.** Add fields/backfill once, then ship
   WebM, audio selection, rotation, Apple retagging, and deinterlacing individually.
   Do not hold CPU savings for Dolby Vision/GPU work or a wholesale rescan.

### Finding-by-finding ledger

All entries below are **open**. `C` means the current code supports the mechanism
and the remedy is accepted with §2's constraints; it is not a new reproduction.
`R` adds a reproduction in this follow-up. `D` means an implementation gap was
checked but its platform-dependent outcome needs validation. `A` requires a
correction to the proposed scope or claimed outcome. Exact code locations remain
in §3/§4 and refer to unchanged application code at the pinned main revision.
Phase assignments are implementation order, not closure evidence.

| ID | Verification / remaining proof | Slice |
|---|---|---|
| LIFE-1 | R — append/start-number defect reproduced across two resumes; server/fMP4 regression still needed. | 1C |
| WEB-1 | C — heartbeat and card calls omit profile; resolver uses default. Keep real-profile creation fallback. | 1B |
| WEB-5 / CASTC-1 | C — sole writer skips the locally paused cast surface; FINISHED does not write completion. | 3B |
| WEB-2 | C — rebuild resets clock/base before relative seek/audio reads; keep logical absolute position. | 2A |
| WEB-3 | C — error removes video; target-only listeners do not rebind when the element returns. | 2A |
| WEB-4 | C — recovery rebuild calls omit the preserved-pause intent. | 2A |
| CASTC-2 | C — App close gate receives minimized-and-remote rather than remote-active. | 3A |
| CASTC-3 | D — connected state with no target renders no Stop control; real SDK resume still needs a device. | 3A |
| CASTS-1 | D — early shared-session return ignores sender anchor; the receiver's exact failure mode is untested. | 3C |
| CASTS-2 | D — cast options clear source codec before decode selection; GPU performance/outcome untested here. | 3C / hardware |
| FF-1 | D — VAAPI receives dotted x.0 despite numeric/named-idc options; QSV HEVC scale/tier also mismatches. Confirm SPS/device decode. | hardware |
| PARTY-1 | C — Shutdown ends every party; rehydration selects active rows and restarts revision at 1. Existing restart test omits Shutdown. | 1A |
| PARTY-2 | C — host recovery checks series identity but not episode identity during media-change. | 2C |
| LIFE-2 | C — constructor does not remove stale session trees; CreateSession lacks a closed-manager guard. | 4A |
| LIFE-3 / CASTS-3 | C — caps count sessions, while cast mint starts every profile. Cast and general encoder caps are distinct closures. | 3C + 4G |
| X-3 | C — playlist fetch refreshes activity and wakes reaped rungs; changing activity alone causes a loop. Carrier case remains separate. | 4G / 4F |
| LIFE-4 | C — eviction skips by a snapshot timestamp even after reacquiring the manager lock. | 4A |
| LIFE-5 | C — readiness timer stores an error without cancelling the process; HDR budget exceeds server write timeout. | 4A |
| FF-3 | D — QSV/AMF lack emitted IDR/GOP controls; segment behavior needs installed-encoder/hardware tests. | hardware |
| FF-6 | C — probe/ladder lacks rotation; test actual output geometry and level after storing it. | 4E |
| DEC-5 / FF-5 | C — field order and deinterlace stage are absent; validate cadence as well as visual combing. | 4E |
| FF-2 / SUB-4 | C — unlabeled overlay output coexists with original video map; CPU scale precedes overlay. Prove one output on GPU paths too. | hardware / before 4J |
| FF-7 | C — retry changes decode fallback while retaining failing hardware encoder selection. | 4G |
| FF-8 | D — HDR sample lacks mastering-display data needed by the intended VAAPI tonemap probe; test a real capable GPU. | hardware |
| FF-9 | C — timestamp option precedes input; comments overclaim output normalization. Keep current timing until jointly proved. | hardware / comments |
| FF-10 | C — zero-copy gate models depth but not subsampling; fail closed on unproven chroma. | hardware |
| CASTS-7 | C — level helper takes height/FPS, not width/macroblock load; high-FPS/portrait declarations need coverage. | 3C |
| DEC-1 | C — dispositions are discarded and compatible non-default audio can be commentary. Respect explicit user selection. | 4E |
| DEC-2 | C — direct-play resolution does not honor the audio picker index; remux selection must be explicit. | 4D |
| DEC-3 | D — capability reports hls.js independently of the actual native path; ManagedMediaSource is not probed. Validate Safari TS. | 4D |
| DEC-4 | D — codec tag is not stored, so `hev1` direct play is not gated; Apple device outcome remains conditional. | 4E |
| DEC-6 / SUB-5 | C — TS promotion changes the session but client retains decision-time remux state. | 4B |
| DEC-WebM | C — first ffprobe format name normalizes WebM to MKV; VPx/AV1 cannot then use their direct path. | 4E |
| DEC-7 | C — Main10 capability covers greater depth/chroma; ordinary H.264 guard also lacks subsampling checks. | 4D |
| DEC-8 | C — stream-info lacks the ceiling check and blocked/missing errors differ. Metadata boundary merits Phase 1. | 1B |
| DEC-9 | C — reason selection classifies unsupported HEVC Main10 as bit depth even without HEVC capability. | 4D |
| DEC-10 / CASTS-8 | C — non-HEAD direct requests log before registry touch, so repeated ranges produce repeated starts. | 4D |
| DEC-11 | C — QoE infers GPU tonemap from available capability instead of the selected path; coupled to FF-8. | hardware |
| DEC-12 | C — contract specifies a Bearer path; native direct playback mints a bounded URL with no renewal path. | 4I |
| SUB-PGS | A — browser bitmap support is absent; libpgs fixes PGS only, with VobSub and remote surfaces still separate. | 4J + 4K |
| SUB-1 | C — extraction writes the shared final path under a request context and shares the probe gate. | 4F |
| SUB-2 | C — creation excludes only known bitmap codecs, not unsupported text/data codecs; allowlist unused there. | 4B |
| SUB-3 | C — SRT scanner/FFmpeg conversions have no BOM/charset normalization. | 4B |
| SUB-6 | C — TS timestamp map uses initial PTS with LOCAL 0 while cues retain the source clock; validate nonzero anchors. | 4B |
| SUB-7 / FF-4 | C — subtitle muxer is cue-driven rather than aligned to the video grid; sparse-track native validation still needed. | 4F |
| SUB-8 | C — embedded text burn-in demuxes the source during filter initialization; cache it outside playback start. | 4F |
| SUB-9 | C — FFmpeg ASS conversion has no drawing/escaping post-pass. | 4B |
| SUB-10 | C — raw prefix matching accepts neighboring episode basenames and last suffix becomes language. | 4B |
| SUB-11 | C — rendition loop independently emits title/default, with no group uniqueness/exclusivity enforcement. | 4B |
| CASTC-4 | A — seek arms the advance-style load effect whose failure stops the cast; preserve committed media and quota safety. | 3A |
| CASTC-5 | C — audio callback rebuilds local media; volume/mute still target the local element. | 3A |
| CASTC-6 | C — sender omits text tracks and browser subtitle route lacks receiver auth/CORS. | 4K |
| CASTC-7 | C — cast effect pauses video without stopping HLS loading; carrier exemption prevents complete savings. | 3B + 4F/4G |
| CASTC-8 | A — shared fMP4 has no declaration; Shaka failure from this alone is not established by current Google docs. | 3C / 4K |
| CASTC-9 / CASTS-5 | D — default token lifetime is 4 h with renewal only on sender operations; uninterrupted/TV playback needs testing. | 4I |
| CASTS-4 | C — native HLS assigns a token URL locally and cast-auth asset requests mark the 30-minute lease. | 3D + 4I |
| CASTC-10 | C — expiry is mutated inside load getter before receiver acknowledgement. | 3A |
| CASTC-11 | C — SDK session-state callbacks refresh only; stopped state is cleared by the app's start path. | 3A |
| CASTC-12 | C — error map uses `load_failed`; asynchronous reload failure is console-only. | 3A |
| CASTS-6 | C — session access marks cast-held without a HEAD guard. | 3D |
| PARTY-3 | C — authoritative state updates alone do not retarget; event resolution can be missed or return without retry. | 4H |
| PARTY-4 | C — casting FINISHED path stops/advances without canonical EOF pause; guest clock remains running. | 4H |
| PARTY-5 | C — local host skips reconciliation; casting host compares successive samples rather than accumulated clock drift. | 4H |
| PARTY-6 | C — allowed guest pause accepts a bounded but arbitrary position; canonical position required for non-hosts. | 2C |
| PARTY-7 | C — a newly bound guest consumes retained explicit-seek state without an age check. | 4D |
| PARTY-8 | C — arrow repeats send seeks and share the sync-intent/time-probe rate budget. | 4D |
| PARTY-9 | C — join/teardown clear clock refs without clearing the buffered sync intent. Fixed on branch `claude/sweet-brown-36veir-playback` (`4f1064e`): `join()` and both `party-ended` teardowns clear the buffer, and nothing is buffered while no party is active; `usePartyIntentBuffer.test.tsx` pins each clear and the guard (`ab8dd15`). Open on `main` until that branch merges. | 4D |
| PARTY-10 | C — creation paths accept unbounded positions, numeric null seek becomes 0, and host-close work lacks cancellation. | 4D |
| WEB-6 | C — create request is abortable while server session creation is detached from that cancellation. | 2A |
| WEB-7 | C — solo advance lacks the outgoing episode's explicit completion write present in party advance. | 2B |
| WEB-8 | D — dead-session errors exhaust network retry before the independent keepalive timer may rebuild; timing untested here. | 2C |
| WEB-9 | C — missing real duration uses current playlist duration plus anchor, allowing false sticky completion. | 2B |
| WEB-10 | C — native error code 4 is terminal and 2/3 do not get hls.js-style fallback/rebuild. | 2C |
| WEB-11 | C — interval cleanup only stops the timer; no pause/seeked/close/pagehide flush. | 2B |
| OPS-1 | D — user creation/unit omit GPU groups/drivers; distro/device permissions and Fedora encoders need real installs. | hardware |
| OPS-2 | C — sample says unlimited while defaults are 8 global / 3 per user. | hardware / docs |
| OPS-3 | C — `v3RequestPlayPayload` has no consumer. Remove alongside protocol cleanup. | 4D |

### Known gaps outside the numbered inventory

These remain open too; a partial mitigation is not complete architectural closure.

| Gap from CLAUDE.md | Decision / acceptance |
|---|---|
| Direct-cast rejection, closing on refusal, and no direct→HLS fallback | 3A separates failed attempt from a healthy cast; 4K pilots bounded fallback for supported DMR failures. Undetectable receiver decode/load errors remain for WP18b's error channel and real-device coverage. |
| Party reload-based resume not broadcast | 4H must cover reload/resume and role changes; a minimal Stop widget alone does not restore party host authority. |
| Shared/authoritative-host cast correction cannot safely re-anchor | 3C/4H must use an isolated cast copy or defer visibly, preserving shared-session anchors and acknowledging each load before broadcasts. |
| Party media change leaves receiver on the previous item | 4H reconciles authoritative episode identity on the receiver as well as the browser; test missed events and failed loads. |
| Cross-rendition produced-edge contract / ABR up-switch stall | Single-rung cast copies contain the receiver case; 4C reduces churn. Browser closure still needs WP17 or an explicitly proved edge/availability design. |

### Enhancement decisions and primary sources

The §5 table covers TECH-01 through TECH-18. All have a disposition in §2:
keep the present CLI/player/native stack; upgrade hls.js; release source facts,
safe remux, and subtitle fixes incrementally; pilot VOD/HDR/new renderers;
defer a custom receiver until remaining need is measured; make CMCD optional.
Enhancements are recommendations, not claims of implementation.

- [hls.js 1.7.3 release](https://github.com/video-dev/hls.js/releases/tag/v1.7.3)
  and [npm metadata](https://registry.npmjs.org/hls.js/1.7.3) support the upgrade.
- [Google Cast release notes](https://developers.google.com/cast/docs/release-notes)
  and [Shaka migration](https://developers.google.com/cast/docs/web_receiver/shaka_migration)
  confirm the May 18 default change and later rollout fixes; firmware regression
  history strengthens the case for a pilot.
- [Receiver MediaInformation](https://developers.google.com/cast/docs/reference/web_receiver/cast.framework.messages.MediaInformation)
  qualifies segment-format requirements as MPL-specific.
  [Sender MediaInfo](https://developers.google.com/cast/docs/reference/web_sender/chrome.cast.media.MediaInfo)
  exposes both format fields.
- [libpgs](https://github.com/Arcus92/libpgs-js) / [package 0.9.0](https://registry.npmjs.org/libpgs/0.9.0)
  confirm PGS scope; [JASSUB 2.5.16](https://registry.npmjs.org/jassub/2.5.16)
  confirms the ASS pilot's package/license metadata.
- [Jellyfin FFmpeg v8.1.3-1](https://github.com/jellyfin/jellyfin-ffmpeg/releases/tag/v8.1.3-1)
  is published, resolving the original review's version uncertainty.
- [FFmpeg n9.0 release tag](https://github.com/FFmpeg/FFmpeg/tree/n9.0)
  exists. Still probe the exact installed encoder/options; release existence
  does not establish host drivers, hardware, or subtitle support.

Keep the original legal/distribution constraints and stable VLCKit policy.
No license, optional renderer, or device support is established merely by a
package version existing. See §2 for the acceptance required before adoption.

## 10. First-priority implementation follow-up (2026-10-01)

This section retains the October 1 candidate/test/review evidence. The later
conflict resolutions and merge status are recorded in §11.

The three implementation lanes cover all 15 unique items in the **Do these first** block: web,
casting, and the remaining lifecycle/party/encoder bugs. Independent read-only
reviewers follow `dev-workflow.md`; review findings return to implementation and
the resulting complete diff is reviewed again. Candidate branches are not
evidence that a fix has landed on `main` or reached the running server.
All four draft code PRs pass their GitHub build/test and review-record checks
on the published revisions. Device and deployment validation remains separate.

### Restored test baseline

The HDR failure recorded in §9 came from the test fixture: its raw HEVC stream
did not carry the BT.2020 primaries and SMPTE 2084 transfer needed by zscale.
The fixture now sets `colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc`
in x265 and checks the extracted raw bitstream with ffprobe. Production
tonemapping is unchanged. The shared fixture repair is included with the
candidate releases.

Verification now uses Go 1.26.5, FFmpeg 7.1.5, Chromium, and isolated PostgreSQL
17/pgvector databases with all 60 migrations applied. `AURORA_REQUIRE_MEDIA_TESTS=1`
and `TEST_DATABASE_URL` make media and database checks run instead of silently
skipping them. Full uncached Go build/tests and frontend test/audit gates have
passed on the candidate branches. Exact content commits and independent verdicts
are recorded separately below.

### First corrective release

[PR #519 — scheduled-party restart survival](https://github.com/ronniekai999/AuroraPro.App/pull/519)
is a draft candidate for PARTY-1. The exact content commit
`58d2c03c2ae19a07da3c022c2cb45a75e53f9f23` received a clean independent
review; its [review record](https://github.com/ronniekai999/AuroraPro.App/blob/b934594abf8b77ad6518f9737386fa5c8bf8ae64/.claude/review-records/58d2c03c2ae19a07da3c022c2cb45a75e53f9f23.json) and GitHub checks pass. Real database tests cover
Shutdown → Rehydrate, retained durable rows, cancelled timers, socket shutdown,
and the existing active-party policy. The frontend reconnect test covers the
new revision floor and stale messages from a replaced socket.

Deploy this slice before subsequent playback releases, whose updater also
restarts the server. A production restart/reconnect smoke test remains required.
No merge or deployment is claimed here.

### Lifecycle, party advancement, and encoder levels

[PR #520](https://github.com/ronniekai999/AuroraPro.App/pull/520) is the next
draft candidate for LIFE-1, PARTY-2, and FF-1. The complete content commit
`cc99798d2966f1cda49f0bf00f6d891180d4fb5a` received a clean independent
review; its [review record](https://github.com/ronniekai999/AuroraPro.App/blob/5f5a3704643d44dc671989a215a6631b5b8e246e/.claude/review-records/cc99798d2966f1cda49f0bf00f6d891180d4fb5a.json) and all GitHub checks pass. Verification includes the full database/media
Go suite, 858 frontend tests, Chromium audit, real TS/fMP4 remux/transcode resume
matrices, native encoder-option parsing, and twelve independent party regressions.
Fast retarget, delayed Play/Pause ordering, and subsequent manual Play are covered.
Actual VAAPI/QSV-produced output still needs hardware validation. Release after
the scheduled-party survival slice; no merge or deployment is claimed.

### Casting controls and bounded copies

[PR #521](https://github.com/ronniekai999/AuroraPro.App/pull/521) is the draft
candidate for CASTC-2, CASTC-3, CASTC-7, CASTS-1, CASTS-2, and CASTS-3. The
complete final content commit `3004844799f02d8456a6fc5b6e51cf7c5e4ca3b4` received
a clean independent review from `/root/review_cast_first`; all 51 independent
public CAF ownership/terminal/recovery probes pass. The [review record](https://github.com/ronniekai999/AuroraPro.App/blob/b45318ba35c59b5bdedba0b40285fac727c07faa/.claude/review-records/3004844799f02d8456a6fc5b6e51cf7c5e4ca3b4.json)
is committed separately from the reviewed code. Go build and the full database/media suite, affected
race checks, thirty source-geometry race iterations, 1,011 frontend tests,
213 focused cases (101 SDK, 32 real-hook player, and 80 mounted player),
TypeScript, and Chromium audit pass.
Independent raw SPS checks confirm profile/compatibility/level bytes agree with the served playlist
across six software presets, including ultrafast.

Remote controls survive expansion and a targetless reconnect. Chromecast stops
local HLS polling while AirPlay retains its local source. Shared anchors and
ladders remain intact; unsafe sessions get a private bounded H.264/AAC rung with
source decode facts and matching geometry/level/CODECS. Unknown source geometry
refuses the Chromecast session token. Receiver identity, owner, anchor, and token
expiry promote only on LOAD acknowledgement; failed replacements retain controls
and committed resources, while unproven clocks stay blocked. Late acknowledgements
cannot advance a newly selected title or profile.

Receiver clocks require one coherent Media object and a positively associated
generation. Generic volume/mute events cannot restore failed-load trust from
cached media. A genuine post-rejection healthy status can restore the committed
generation; a successful retry also needs coherent incoming Media evidence
before its new anchor can convert a clock.
Already-retired Media IDs cannot supply a later same-URI load's clock or
completion even when the legacy SDK recreates their objects. Numeric ID reuse
in another CastSession remains valid. Ordinary ultrafast shared output uses a
private High-profile cast rung; proven shared presets keep sharing and the
local encoder keeps its original settings. Terminal callbacks remain actionable
when CAF filters ended Media out of its
active getter, and explicit Stop releases the listener without relying on a
subsequent generic event. A latest observed rejected Media generation has
terminal-only cleanup proof, never progress or completion authority. New loads
and genuine committed-media recovery retire that proof; retry preparation
blocks old cleanup. When a failed load exposes a different outgoing Media,
the next retry excludes both that generation and the prior acknowledged one.
Successful ACK retires both; rejection preserves prior acknowledged recovery.
Real-hook regressions cover old clock/end frames before and after ACK, genuine
incoming progress/completion, and recovery after a rejected retry.

Release after scheduled-party survival and the web lane's profile-aware cast
progress. Physical receivers and GPU-produced output remain unverified. The
subtitle-carrier reaper exception and general paused-player encoder policy remain
open. The combined player changes require their own review; this branch alone
does not implement the web progress writer. No merge or deployment is claimed.

### Profile attribution and web playback

[PR #522 — profile progress and playback state](https://github.com/ronniekai999/AuroraPro.App/pull/522)
is the web draft candidate for WEB-1 through WEB-5, including the duplicated CASTC-1.
The complete final content commit `e4bba20b129bc97e2043af68800e10dc5a5efd2e`
received a clean independent review from `/root/review_web_first`; all 55
independent public CAF/real-player adversarial probes pass. The [review record](https://github.com/ronniekai999/AuroraPro.App/blob/9e55270133dcea7c443ae29582cbf81ad9ac6135/.claude/review-records/e4bba20b129bc97e2043af68800e10dc5a5efd2e.json)
is committed separately from the reviewed code. Go build, the full PostgreSQL/media suite,
profile/API race checks, 1,083 frontend tests, 254 focused cases (116 mounted
player, 68 real-hook player, and 70 SDK), TypeScript, and Chromium audit pass.
The final real-hook suite reproduces four stale prior-generation clock/end
failures against the previous frozen revision; earlier baseline runs reproduced
the terminal, generation, and targetless-heartbeat defects.

Progress reads and writes use the acting profile with ownership validation.
Logical absolute seeks, paused recovery, and current DOM listeners survive
replacement and error/Back flows. Cast progress and completion stay attached
to the acknowledged outgoing title/profile, including when local navigation
clears the target; unknown resumed ownership declines writes. Clock conversion
requires a valid acknowledged anchor and coherent current Media evidence.
Completion is recorded before advancing, and a changed local title cannot
inherit the outgoing title's terminal event. The shared SDK fixes above are
included in this lane too.

Release after scheduled-party survival and before any new cast progress
writer. Physical Chromecast and Safari/AirPlay remain unverified. No merge or
deployment is claimed.

### Combined verification and release sequence

The complete [combined source tree](https://github.com/ronniekai999/AuroraPro.App/tree/5008cacaffb85a10d7fdafb351eb3f6373717507) at
`5008cacaffb85a10d7fdafb351eb3f6373717507` received a **clean** independent review from
`/root/review_first_integration`, covering the complete 47-file final diff,
surrounding contracts/lifecycles, and manual player unions. Its exact-content
[review record](https://github.com/ronniekai999/AuroraPro.App/blob/6b374122283e073dfaa90ff90355120848c1b16a/.claude/review-records/5008cacaffb85a10d7fdafb351eb3f6373717507.json)
is committed separately from the reviewed code. All
1,219 frontend tests across 59 files, TypeScript, Go build, and Chromium audit
pass. The full uncached PostgreSQL/media Go suite passes with the identical
backend sources; affected API/watch-party/streaming race checks also pass.
This includes the manual unions where party play ownership, web logical clocks,
cast transport, failed-load recovery/terminal cleanup, and outgoing completion
share the player. Applicable full uncached database/media and race results are
retained for backend sources that are byte-identical to the validated revision.
The final frontend suite, audit, and embedded-asset Go build ran after the last
content change.

Independent verification passed 26 public CAF/player cases, 173 SDK cases,
343 player/party cases, and the completed-A/failed-B completion boundary.
Eight new retry-ownership probes fail on the prior revision and pass here;
both genuine recovery inverses pass on each. Actual FFmpeg SPS probes confirm
truthful private ultrafast output and valid superfast/veryfast sharing.
These independent checks supplement the mandatory gates above.

The code PRs overlap in the player, shared sender, and fixture repair. Apply the
shared changes once, resolve conflicts using the final reviewed integration tree,
and rerun the affected gates and independent review after rebasing or merging
changes. An earlier verdict does not cover a changed PR diff.

Ship PR #519 first, then PR #522 and PR #520 as their gates
clear, then PR #521 with the profile-aware progress writer in place. Keep each
release's database/device smoke checks and rollback from §2. A passing combined
candidate does not establish production deployment, physical receiver support,
or closure of the other findings. Main remains the pinned revision above.

## 11. Conflict resolution and merge follow-up (2026-10-02)

Sections 9 and 10 retain the evidence for their dated main/candidate revisions.
The current first-priority implementation is delivered by PRs #519, #520,
#521, and #522. This records code implementation separately from production
and device validation; it does not close the remaining backlog.

[PR #519](https://github.com/ronniekai999/AuroraPro.App/pull/519) supplies scheduled-party restart survival and [PR #522](https://github.com/ronniekai999/AuroraPro.App/pull/522) supplies profile
attribution and common web playback repairs. [PR #520](https://github.com/ronniekai999/AuroraPro.App/pull/520) was resolved against those
landed changes, preserving both logical replacement state and automatic/manual
party playback ownership. Its listeners follow the current video and episode.
The final review caught a quick manual Play then Pause during automatic echo
suppression; explicit Pause now owns one matching browser event without clearing
remote suppression. Regressions cover immediate and queued pause events at
50 ms and the 200 ms control, with automatic echo/seek inverses.

[PR #520](https://github.com/ronniekai999/AuroraPro.App/pull/520) merge: [`5fdb7e6`](https://github.com/ronniekai999/AuroraPro.App/commit/5fdb7e687374888667c34118d847197839fab67b). [PR #521](https://github.com/ronniekai999/AuroraPro.App/pull/521) resolves its remaining player/sender
conflicts against that revision, preserving the reviewed combined cast progress,
terminal cleanup, retry generation ownership, party controls and bounded copies.
The shared helper relocation retains its body and behavior. [PR #521](https://github.com/ronniekai999/AuroraPro.App/pull/521) completes
the first-priority source changes when this release is merged.

Verification of the resolved code includes 1,108 frontend tests for #520 and
1,223 for the combined #521 tree, Chromium audit/layout/PWA, TypeScript and Go
build after frontend assets. Full uncached PostgreSQL/media-required Go tests
and affected races pass. Applicable backend results are retained where Go
sources and module files are byte-identical after frontend-only corrections.
Fresh independent reviews and exact-content records cover the resolved PR diffs.

Physical Chromecast, Safari/AirPlay and GPU decoding/output remain unverified.
CASTC-7 covers stopping sender HLS polling; the subtitle-carrier reaper exception
and general paused-encoder policy remain open. No production updater or admin
deploy/test loop was explicitly triggered by this merge work. Record the actual
deployed revision and restart/cast/profile smoke results separately. Future
fixes continue as the small slices in section 2, with device/hardware work
released according to its applicable gates.
