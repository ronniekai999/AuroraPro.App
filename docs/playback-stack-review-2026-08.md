# Playback stack review — August 2026

This is a current-state follow-up to the [June 2026 streaming review](streaming-architecture-review-2026-06.md).
That review is useful history, but its architecture table describes the tree
*before* its recommendations landed. This document evaluates the code at
commit `0895053` and separates improvements that are likely to help real users
from fashionable technology that would add complexity without improving VOD.

## Executive verdict

Aurora's playback architecture is current and well chosen. Keep the Go control
plane, FFmpeg media plane, React player, hls.js browser fallback, and the
direct-play → remux → transcode decision order. Replacing them with DASH,
WebRTC, WebCodecs, or a custom media pipeline would not make ordinary movie
playback faster or better.

The large 2026 gaps have already closed: fragmented MP4 (fMP4) is the default, HEVC remux
is Apple-safe, compatible Dolby audio is preserved, transcoding is paced,
abandoned ABR variants are reaped, hardware decode and VAAPI tonemapping are
probed, HEVC output is capability-gated, and hls.js is current at 1.6.17.
Aurora is no longer behind the mainstream open-source media-server stack on
transport or codec selection.

The best next investment is **measurement**, followed by two bounded media
features: **quality-aware encoding controls** and, only after telemetry proves
the need, **AV1 transcode output on proven hardware encoders**. Do not make an
AV1 software encoder part of interactive playback and do not switch VOD to
low-latency HLS.

## What is running now

| Area | Current implementation | Assessment |
|---|---|---|
| Decision | Browser capabilities plus container, codec, bit depth and audio-track selection choose direct play, remux, or transcode | Strong; retain |
| Direct play | Original file via HTTP range serving with resolved-root containment | Fastest and lossless; always the preferred path |
| Remux | Video copy into HLS; audio copied only where container and client support are safe | Correct balance of startup speed, fidelity and compatibility |
| HLS | Configured-duration EVENT playlists (six seconds by default); transcode variants force aligned keyframes, while remux boundaries follow the source GOP; fMP4 by default with MPEG-TS rollback | Modern VOD transport; no LL-HLS requirement |
| Browser player | Native HLS for the Apple path; hls.js 1.6.17 elsewhere, persisted bandwidth estimate, viewport cap and bounded back buffer | Current upstream release as of 2026-08-12 |
| Transcode | On-demand ABR variants, 4× input pacing, 75-second idle-variant reaping, crash resume and seek rebuild | More resource-conscious than the old full-speed/full-file behavior |
| Acceleration | Runtime-probed NVENC, QSV, VAAPI and AMF encode; proven hardware decode; VAAPI GPU tonemap where supported | Correctly fails back instead of trusting advertised hardware |
| Quality | H.264 High or capability-gated HEVC Main output, no upscale, aligned GOPs, HDR-to-SDR tonemap, surround preservation where supported | Good defaults; lacks an operator-visible quality/latency policy |
| Warmup | Detail-page hover/focus can create and prime a session before Play | Directly attacks the dominant cold-transcode delay |
| Safety | Global/per-user quotas, disk cap, scoped cast tokens and private segment caching | Strong for a self-hosted service |

## Recommended next work

### 1. Add privacy-conscious playback quality-of-experience telemetry (highest value)

Today Aurora has rich diagnostic logging, but no durable answer to the product
questions that should drive codec and buffering work. Record aggregated,
bounded events for:

- decision and reason (`direct_play`, `direct_stream`, `transcode`);
- click-to-first-frame and manifest-to-first-frame time;
- rebuffer count and total rebuffer duration;
- selected/rendition switches, estimated throughput and viewport class;
- terminal category (ended, user exit, media error, network error, server
  transcode error); and
- encoder family, output codec, HDR conversion and whether pre-warm hit.

Use coarse values, short retention and no URL, token, filename, IP, or raw
user-agent. Expose p50/p95 startup, rebuffer ratio, direct-play ratio and error
rate in the admin dashboard. This tells us whether the next bottleneck is disk,
network, FFmpeg startup, a device family, or an overly conservative capability
gate. It also provides an objective before/after check for every recommendation
below.

### 2. Make the speed/quality trade-off explicit

`software_preset` is a useful start, but users cannot express the actual
policy they want. Add a small operator policy such as `balanced`, `fast_start`
and `quality`, resolved server-side into tested encoder-family settings.

- Keep the current settings as `balanced`.
- `fast_start` should prefer faster presets and a shorter initial segment; do
  not shorten every segment without testing seek and ABR behavior.
- `quality` should spend more encode time rather than merely raising ladder
  bitrates. For software H.264, a slower x264 preset improves compression at a
  given quality target; for hardware encoders, use the corresponding quality
  preset/lookahead only when the startup-time budget permits it.
- Show the active encoder, policy and measured first-segment time in admin.

Do not advertise a universal percentage improvement. HEVC/H.264 gains depend
heavily on source, encoder generation, preset and metric, and hardware HEVC can
lose to well-tuned software H.264 on some content.

### 3. Prototype AV1 output behind strict gates, not as a new default

AV1 is the remaining codec-efficiency opportunity. Aurora already probes an
AV1 client capability, and current Intel, NVIDIA and AMD generations can encode
AV1 in hardware. A prototype should require all of: fMP4, a positive client
decode probe, a successfully test-encoded server encoder, no cast/AirPlay path,
and an operator `av1_output: auto` switch. Start with SDR only and preserve the
H.264 fallback.

Do **not** use SVT-AV1 or libaom for just-in-time movie playback by default.
They are excellent offline encoders, but the compression win is not worth
multi-second first-segment latency and high CPU contention on typical
self-hosted hardware. AV1 should first target known-good hardware encoders and
be evaluated using startup/rebuffer telemetry plus objective samples (VMAF or
SSIMULACRA2), not codec reputation.

### 4. Add an optional offline optimization path for frequently watched media

For users who prioritize instant starts and consistent quality, background
creation of one streamable, browser-safe mezzanine is more effective than
making live transcoding increasingly complicated. Run only when the server is
idle, keep the original, use atomic publication, enforce a separate disk
budget, and invalidate on source/config change. Candidate selection should be
explicit or based on repeated transcodes—not automatic conversion of the whole
library.

This is where slow software AV1/HEVC and content-aware encoding belong. It also
lets multi-pass or capped-quality encodes improve compression without putting
first-frame latency at risk.

### 5. Tighten compatibility operations before adding another transport

- Test a small playback matrix in CI with generated samples: H.264/HEVC/AV1,
  8/10-bit, SDR/HDR, AAC/AC-3/E-AC-3, MP4/MKV, fMP4/TS, direct/remux/transcode.
  Assert decisions, master `CODECS`, FFmpeg startup, first segment probing and
  seek-resume continuity.
- Record the FFmpeg major version and probe results in diagnostics. Aurora
  currently accepts the distribution package; FFmpeg 8.1 is current upstream,
  but distro builds differ in enabled filters and hardware drivers. Capability
  probes are more important than requiring the newest version.
- Add hardware-in-the-loop smoke runs for the GPU families the project claims.
  Unit tests can validate arguments, not driver/firmware/filter interaction.

## Technology choices to avoid for now

| Technology | Why not now |
|---|---|
| LL-HLS | Designed for live latency. For VOD it increases manifest/request complexity without reducing decode or encode startup. Hover pre-warm and first-segment work address the real delay. |
| MPEG-DASH as a second output | hls.js plus native HLS already covers the browser targets. A second manifest/segment lifecycle doubles compatibility and test surface with little user gain. |
| WebRTC | Wrong delivery semantics for seekable, cached, multi-hour VOD; complicates auth, NAT and server load. |
| WebCodecs player | Low-level decode does not supply the demuxing, buffering, ABR, captions, DRM hooks, AirPlay or accessibility behavior Aurora already gets from `<video>` and hls.js. |
| Replacing FFmpeg | FFmpeg 8.1 remains the broadest maintained open-source codec/container/hardware integration layer. A custom GStreamer or Rust pipeline would trade mature compatibility for engineering cost, not better pixels. |
| 2-second segments everywhere | Can improve first-frame/seek granularity but increases requests and mux overhead. Test a short *initial* segment or per-policy duration against QoE data first. |

## Suggested delivery order

1. QoE schema, bounded ingestion and admin percentiles.
2. Playback fixture/matrix tests and hardware smoke-test documentation.
3. Quality policy with before/after first-frame and objective-quality results.
4. Hardware-only AV1 experiment, disabled by default until the data is better
   than HEVC for supported clients.
5. Optional idle-time optimized versions if live transcodes remain the main
   source of starts or stalls.

## Upstream references checked on 2026-08-12

- [hls.js v1.6.17 release](https://github.com/video-dev/hls.js/releases/tag/v1.6.17)
  (published 2026-08-05; matches Aurora's dependency).
- [FFmpeg 8.1 release announcement](https://ffmpeg.org/index.html#pr8.1)
  and [FFmpeg HLS muxer documentation](https://ffmpeg.org/ffmpeg-formats.html#hls-2).
- [Apple HLS Authoring Specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
  and [Apple fMP4 HLS example streams](https://developer.apple.com/streaming/examples/).
- [hls.js API/configuration reference](https://github.com/video-dev/hls.js/blob/master/docs/API.md).
- [Jellyfin hardware acceleration documentation](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/)
  for the peer stack's current decode/encode and HDR-tonemap approach.
- [SVT-AV1 project](https://gitlab.com/AOMediaCodec/SVT-AV1) and
  [AOMedia AV1 specification](https://aomedia.org/specifications/av1/).
- [VMAF](https://github.com/Netflix/vmaf) and
  [SSIMULACRA2](https://github.com/cloudinary/ssimulacra2) for reproducible
  quality comparisons.
