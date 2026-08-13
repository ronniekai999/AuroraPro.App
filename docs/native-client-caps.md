# Native client capabilities — the direct-play contract

How a **native** Aurora client (a Mac/iOS/Android app wrapping libVLC, mpv, or
ExoPlayer) tells the server it can play a file as-is, so the server serves the
original bytes instead of spawning FFmpeg.

Browsers are limited by what MediaSource and the `<video>` element accept —
no MKV, no DTS, no TrueHD, no Hi10P. A native player has none of those limits,
and most of a real library is MKV. This document is the contract that lets a
native client say so.

## The short version

Send a `caps` string on `GET /api/stream/info/{fileID}` that names the
containers and codecs your player actually decodes. When the decision comes
back `direct_play`, `GET /api/stream/{fileID}/direct?type=media|episode` and
hand the response to your player. That endpoint serves the original file with
range requests — no transcode session, no keepalive, no cleanup.

```
GET /api/stream/info/42?type=media&caps=h264,h264_hi10,hevc,hevc_main10,...
→ { "decision": "direct_play", ... }

GET /api/stream/42/direct?type=media        ← range requests, original bytes
```

Anything that comes back `direct_stream` or `transcode` follows the existing
HLS session flow (`POST /api/stream/sessions`), exactly as the SPA does.

## The caps string

Comma-separated, lowercase. Unknown keys are ignored, so it is always safe to
send a key an older server does not know — you get a more conservative
decision, never an error.

### Containers — `<name>_container`

| Key | Reaches |
|---|---|
| `mp4_container` | `.mp4`, `.m4v`, `.mov` |
| `webm_container` | `.webm` muxed as WebM proper |
| `mkv_container` | `.mkv` — **and most `.webm`**, see the note below |
| `avi_container` | `.avi` |
| `ts_container` | `.ts`, `.m2ts`, `.mts` |

A container you do not name is never direct-played. This is the whole safety
model: Aurora's SPA emits only `mp4_container` and `webm_container`, so no
browser can be handed a container it cannot demux.

> **`.webm` files land under `mkv_container`.** FFprobe reports `matroska,webm`
> for both Matroska and WebM, and the scanner keeps the first element
> (`internal/library/ffprobe.go`), so a `.webm` file is stored with container
> `mkv`. A native client claiming both keys is unaffected. A browser-like
> client claiming only `webm_container` never direct-plays its own WebM files —
> a pre-existing wart, not something this contract introduces.

### Video codecs

`h264`, `hevc` / `h265`, `vp8`, `vp9`, `av1` — plus the legacy set no browser
decodes: `mpeg4` (XviD/DivX), `msmpeg4v3`, `mpeg2video`, `vc1`.

Two **profile** keys are separate from the codec keys, because a codec name
does not tell the server what profile your decoder stops at:

| Key | Claim |
|---|---|
| `hevc_main10` | 10-bit HEVC. Without it, any >8-bit HEVC transcodes — and effectively all 4K/HDR HEVC is 10-bit, so omitting this key transcodes your entire 4K library. |
| `h264_hi10` | H.264 High 10 (Hi10P). Common in anime. Browsers universally reject it via MSE; native decoders do not. |

### Audio codecs

`aac`, `mp3`, `ac3`, `eac3`, `flac`, `opus`, `vorbis` — plus the native-only
set: `dts` (covers DTS-HD; ffprobe reports `dts` for every variant), `truehd`,
`mlp`, `alac`, `mp2`, and any `pcm_*` variant (`pcm_s16le`, `pcm_s24le`,
`pcm_bluray`, …; the whole `pcm_` family is accepted by prefix).

Send the exact ffprobe codec name — the server matches it against the file's
probed track codecs literally.

### Delivery

Send `hls_native` if your player consumes HLS (libVLC, mpv, and AVPlayer all
do). This matters for the *fallback* path: when a file cannot be direct-played
the server still has to deliver it, and `hls_native` says you can take an HLS
master playlist.

Do **not** send `hls_js` — it is a browser flag that restricts the server to
what hls.js's demuxer can extract.

### A complete native caps string

```
h264,h264_hi10,hevc,hevc_main10,vp8,vp9,av1,mpeg4,msmpeg4v3,mpeg2video,vc1,
aac,mp3,ac3,eac3,flac,opus,vorbis,dts,truehd,mlp,alac,mp2,pcm_s16le,pcm_s24le,pcm_bluray,
mp4_container,webm_container,mkv_container,avi_container,ts_container,
hls_native
```

Claim only what your build actually decodes. A false claim is not a security
problem — it only breaks playback for the client that lied — but it does mean
a black screen instead of a working transcode.

## What still transcodes, and why

Even with everything claimed, three cases do not direct-play:

- **Hi10P on the remux path.** A Hi10P source is either direct-played whole or
  transcoded to 8-bit; it is never repackaged into HLS segments. H.264 High 10
  inside fMP4/TS is unproven on every consumer Aurora ships.
- **Legacy video codecs on the remux path.** MPEG-4 Part 2, MPEG-2 and VC-1
  have no standard fMP4 mapping and hls.js cannot demux them from MPEG-TS, so
  they are direct play or full transcode, nothing in between.
- **Native-only audio on any HLS path.** DTS, TrueHD, PCM, ALAC and MP2 are
  never copied into HLS segments. If a file has to go through HLS for some
  *other* reason, its DTS track is re-encoded — and if a copyable AAC track
  sits beside it, that track is selected instead.

These are properties of the HLS delivery path, not of your player. Direct play
is unaffected: it serves the original file, so every track and every profile
arrives untouched.

## Server-side notes

- `direct_play` decisions carry `audio_track_index` for the track the server
  *would* have picked. On direct play it is advisory — you receive the whole
  file and choose your own track.
- `/api/stream/{fileID}/direct` enforces the same parental rating ceiling and
  media-root path containment as every other stream route. Use a normal
  `Authorization: Bearer` token.
- Direct-play streams appear in Admin → Active Streams via a touch-and-expire
  registry (`internal/streaming/directplay.go`), heartbeated for the life of
  the request. No keepalive call is needed from the client.
- Subtitles are not extracted or burned in on the direct-play path. Read the
  embedded tracks yourself, or fetch sidecars from the subtitle endpoints.

## Where this lives

| Concern | Code |
|---|---|
| Caps parsing | `ParseClientCaps`, `internal/streaming/streaming.go` |
| Container → cap key | `containerCapKey`, same file |
| Direct-play-only sets | `directPlayOnlyVideoCodecs`, `isDirectPlayOnlyAudio` |
| HLS audio projection | `hlsDeliverableAudio` |
| Decision engine | `DecidePlayback` |
| File serving | `ServeFile` + `serveDirectFile`, `internal/api/phase2_handlers.go` |
| Tests | `internal/streaming/nativeclient_test.go` |
