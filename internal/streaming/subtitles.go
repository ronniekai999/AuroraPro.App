package streaming

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aurora-media/aurora/internal/models"
)

// ProbeSubtitles uses ffprobe to discover subtitle tracks in a media file.
func ProbeSubtitles(ctx context.Context, filePath string) ([]models.SubtitleTrack, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "quiet",
		"-print_format", "json",
		"-show_streams",
		"-select_streams", "s", // subtitle streams only
		filePath,
	)

	// Bounded: capturing output lets Wait outlive the process, and the context
	// cannot close a descriptor a child inherited (runBounded, execwait.go).
	// This runs during library scans and session setup — an unbounded wait
	// pins that caller, not just this probe.
	out, err := boundedOutput(cmd)
	if err != nil {
		// No subtitle streams is not an error
		return nil, nil
	}

	var probe struct {
		Streams []struct {
			Index       int               `json:"index"`
			CodecName   string            `json:"codec_name"`
			CodecType   string            `json:"codec_type"`
			Tags        map[string]string `json:"tags"`
			Disposition struct {
				Default int `json:"default"`
				Forced  int `json:"forced"`
			} `json:"disposition"`
		} `json:"streams"`
	}

	if err := json.Unmarshal(out, &probe); err != nil {
		return nil, fmt.Errorf("parse ffprobe subtitle output: %w", err)
	}

	var tracks []models.SubtitleTrack
	for _, s := range probe.Streams {
		if s.CodecType != "subtitle" {
			continue
		}
		track := models.SubtitleTrack{
			Index:    s.Index,
			Language: s.Tags["language"],
			Title:    s.Tags["title"],
			Codec:    s.CodecName,
			Forced:   s.Disposition.Forced == 1,
			Default:  s.Disposition.Default == 1,
		}
		tracks = append(tracks, track)
	}

	return tracks, nil
}

// ProbeSeekKeyframe returns the video keyframe timestamp (seconds) that
// ffmpeg's input seek (`-ss <target>` before `-i`) will land on for the
// given file — i.e. the largest keyframe PTS that is <= target.
//
// Why this matters (Issue #141): input seek can only start a stream at a
// keyframe, so it rounds the requested resume position DOWN to the
// nearest preceding keyframe. With -copyts/-start_at_zero that keyframe
// becomes the HLS stream's t=0. The subtitle cue-shift must use this
// keyframe time, not the requested target, or every cue lands up to one
// GOP early ("subtitles ahead of audio").
//
// On any probe failure (no video stream, ffprobe missing, parse error)
// it returns the target unchanged: callers then shift by the requested
// position, which is the pre-#141 behavior — slightly off, but never
// worse than before, and never blocks subtitle serving. Failures are
// swallowed deliberately (no error return) because there is no caller
// action that differs from the fallback.
//
// Known limitation (open-GOP H.264): `-skip_frame nokey` reports ALL
// I-frames, but ffmpeg's input seek lands on the seekable IDR. If a
// non-IDR I-frame sits between the IDR and target, this returns the
// closer non-IDR frame, shifting cues by up to the IDR↔I gap (sub-GOP,
// ~1-2s) in the SAFE direction (cues slightly late, not early). Most
// remux-tier content is closed-GOP/all-IDR so this rarely bites; the
// error is still smaller than the pre-#141 full-GOP error.
//
// Known limitation (demuxers without AVFMT_SEEK_TO_PTS: Matroska, MPEG-TS,
// AVI): with B-frames FFmpeg seeks 130 ms before the target, so a target ON
// a key frame lands on the previous one and this is a whole GOP late (cues a
// GOP early). It is a prediction; the subtitle endpoint uses it only when
// the client sends no measured start (media_start=, media_start.go).
func ProbeSeekKeyframe(ctx context.Context, filePath string, target float64) float64 {
	if target <= 0 {
		return target
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	// Read a window ending just past the target. A 16s window
	// comfortably exceeds any sane GOP (typically 2-10s).
	// -skip_frame nokey makes the decoder emit ONLY keyframes, so the
	// output is the set of keyframes in [keyframe<=from, ~target]. We
	// then take the max keyframe <= target.
	from := target - 16
	if from < 0 {
		from = 0
	}
	// `start%end` interval form. Read slightly past the target so a
	// keyframe sitting right at the boundary is included in the scan;
	// the strict filter below (kfMatchEpsilon) decides which ones
	// actually count.
	interval := fmt.Sprintf("%.3f%%%.3f", from, target+0.5)

	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-skip_frame", "nokey",
		"-read_intervals", interval,
		"-show_entries", "frame=pts_time,best_effort_timestamp_time",
		"-print_format", "json",
		filePath,
	)
	out, err := boundedOutput(cmd) // see runBounded (execwait.go)
	if err != nil {
		return target // probe failed → fall back to requested target
	}

	var probe struct {
		Frames []struct {
			PTSTime    string `json:"pts_time"`
			BestEffort string `json:"best_effort_timestamp_time"`
		} `json:"frames"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return target
	}

	// ffmpeg's input seek lands on the largest keyframe with PTS <=
	// target. The epsilon ONLY absorbs float-print jitter for a
	// keyframe that is nominally AT the target (e.g. prints as
	// 9.999983 or 10.000017) — it must NOT be wide enough to admit
	// the next GOP's keyframe, or we'd shift cues the wrong way and
	// push subtitles slightly BEHIND the audio. 2ms is comfortably
	// below any real GOP gap.
	const kfMatchEpsilon = 0.002
	best := -1.0
	for _, f := range probe.Frames {
		// Prefer pts_time; fall back to best_effort when pts_time is
		// "N/A" (some containers).
		ts := f.PTSTime
		if ts == "" || ts == "N/A" {
			ts = f.BestEffort
		}
		v, perr := strconv.ParseFloat(ts, 64)
		if perr != nil {
			continue
		}
		if v <= target+kfMatchEpsilon && v > best {
			best = v
		}
	}
	if best < 0 {
		// No keyframe found in the window — shouldn't happen (the
		// window starts before target), but fall back safely.
		return target
	}
	return best
}

// mediaFingerprint digests a media file's identity as (size, mtime) — the
// same pair internal/library/scanner.go hashes into media_files.file_hash
// (and episode_files.file_hash). Same digest INPUT, different truncation
// (6 bytes here, 16 there), so the two hex strings never compare equal:
// this is not a drop-in for the stored column, and substituting one would
// silently re-key the whole cache. Returns ok=false when the file cannot
// be stat'd.
//
// The stored file_hash is deliberately NOT reused even though it is the
// same construction: it is only as fresh as the last library scan, so a
// file replaced between scans would still fingerprint as unchanged —
// precisely the staleness this is meant to catch. Stat'ing at request
// time costs one syscall against an ffmpeg run that reads a whole
// container.
func mediaFingerprint(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return "", false
	}
	h := sha256.Sum256([]byte(fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())))
	return fmt.Sprintf("%x", h[:6]), true
}

// extractedVTTPath computes the cache path for one extracted subtitle track.
//
// The key is (media path, stream index, media fingerprint). The path hash
// avoids collisions between media files sharing a basename in different
// directories; the fingerprint is the INVALIDATION mechanism.
//
// Why a fingerprint in the KEY rather than an mtime comparison through
// cacheIsFresh, like the three sibling caches:
//
//   - An mtime comparison only catches a source that got NEWER. Media is
//     routinely replaced by tools that preserve or restore timestamps —
//     `rsync -a`, `cp -p`, a restore from backup — leaving the cached VTT
//     newer than its "new" source, so the comparison reports fresh and the
//     wrong subtitles are served indefinitely. That is the bug, unfixed.
//   - Extraction is orders of magnitude more expensive than the sibling
//     conversions: it reads through the entire container (minutes for an
//     8+ GB MKV, hence the 10-minute timeout below). A one-way comparison
//     degrades badly when a mount reports drifting mtimes — the cached file
//     is written now, the source ticks past it, and the NEXT request
//     re-extracts, forever. A key is immune only to the FLAPPING variant of
//     that: a fingerprint alternating between two values lands back on an
//     entry already on disk. Against a monotonically drifting mtime a key
//     is no better — every request re-extracts either way, and this policy
//     is in fact worse on disk, because each run writes a NEW file instead
//     of overwriting one.
//   - A different file at the same path can shift stream indices, so the
//     cached track may not even be the same language. Re-keying retires the
//     whole (path, index) family at once.
//
// Costs, accepted deliberately:
//
//   - A mount whose mtimes genuinely drift forward (never repeating) will
//     re-extract per distinct fingerprint. Same for a file still being
//     written at the served path (an in-progress copy or download): every
//     request sees a new size and re-extracts, where the old code extracted
//     once. Serving subtitles for the wrong cut of a film is the worse
//     failure; the ffprobe gate in the API handler bounds the concurrency
//     of the storm but not its total cost.
//   - Superseded entries are orphaned rather than overwritten, and it is
//     not just one file per track: ShiftVTTCues keys on (vttPath, offset),
//     so re-keying also orphans every shifted derivative built from the old
//     track — one per distinct resume position ever requested for it. Those
//     were previously reused indefinitely. Bytes are small; the count is
//     per (track × distinct start). They are collected by the
//     subtitle-cache sweep in cmd/aurora/main.go, which runs at startup and
//     then daily — it was moved ahead of its ticker precisely because this
//     change made it load-bearing: with the purge inside `case <-ticker.C`
//     it needed 24 uninterrupted hours to fire even once, which a box that
//     auto-deploys on a 5-minute timer rarely gets. Entries still linger
//     until they are 30 days old, so this bounds growth rather than
//     preventing it.
//   - Replacing a file with one of identical size AND mtime (`touch -r`
//     plus a same-size replacement) is invisible to this, exactly as it is
//     to the scanner's own file_hash. Content hashing is the only fix and
//     costs a full read of every file.
//   - The fingerprint is computed BEFORE a run that can take 10 minutes,
//     so media replaced mid-extraction stores its result under a stale key
//     where nothing will look for it, and the next request re-extracts.
//     Which content lands there depends on how the replacement was done:
//     replace-by-rename (rsync, mv, temp-file downloaders) leaves ffmpeg's
//     open FD on the OLD inode once it has opened, so the old track is
//     stored under its own matching fingerprint. A key/content mismatch
//     needs either an in-place truncate-and-rewrite, or a rename landing
//     in the window between the fingerprint (taken here) and ffmpeg's exec
//     further down ExtractSubtitleVTT. Either way it is wasted work —
//     serving wrong content from such an entry would additionally require
//     a later revert to a byte-identical (size, mtime), so this is not a
//     correctness hole.
//   - On upgrade, every existing entry uses the old (fingerprint-less) key
//     and is ignored; each track re-extracts once, and the old file is left
//     for whenever the reaper does run.
//
// Invalidation is per-request rather than driven by the library scanner:
// the scanner only learns a file changed when it next runs, so a file
// replaced between scans would keep serving stale cues until then, and the
// scanner would have to be taught the subtitle cache layout to fix it.
//
// When the media file cannot be stat'd we fall back to the legacy
// fingerprint-less key, rather than keying on a fabricated fingerprint.
// This is the one path that keeps the old bug, and it does so in BOTH
// directions — read it before assuming a stat failure is harmless:
//
//   - It can HIT. Pre-fingerprint builds wrote exactly this filename, so
//     any entry cached before the upgrade is still sitting at this key.
//     If the media was replaced and a request arrives during a stat
//     failure (a transient NFS ESTALE, a mount flap, an EACCES window),
//     that pre-upgrade track is served — the original staleness, for that
//     entry. Only its stem differs from what older builds wrote, and only
//     when the basename MINUS its extension exceeds cacheStemMax.
//   - It can WRITE. In the narrower case where stat fails but ffmpeg's
//     own open succeeds, the extraction lands here, and that entry then
//     has no invalidation at all until a reaper sweep removes it.
//
// Both need a stat failure to reach at all, and the fallback is still
// strictly better than the unconditional staleness it replaces, so it is
// left as-is. Namespacing this key would close the READ half only — a
// stat failure could no longer be answered by a pre-upgrade entry, but an
// entry written by an EARLIER stat failure would still be hit, since
// nothing invalidates it either. That is a deliberate follow-up, not an
// oversight.
func extractedVTTPath(filePath string, streamIndex int, cacheDir string) string {
	h := sha256.Sum256([]byte(filePath))
	baseName := cacheStem(strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath)))
	if fp, ok := mediaFingerprint(filePath); ok {
		return filepath.Join(cacheDir, fmt.Sprintf("%s_%x_sub%d_%s.vtt", baseName, h[:6], streamIndex, fp))
	}
	return filepath.Join(cacheDir, fmt.Sprintf("%s_%x_sub%d.vtt", baseName, h[:6], streamIndex))
}

// cacheStemMax bounds the human-readable half of a cache filename.
//
// The stem is cosmetic — the path hash carries the uniqueness — but it is
// not free: ShiftVTTCues derives ITS filename from this one, adding a net
// ~29 bytes, and the fingerprint component added another 13. A long
// release name could push the shifted file past NAME_MAX (255 bytes on
// ext4/XFS), where os.Create fails with ENAMETOOLONG and subtitles break
// for exactly the files with the longest names. 120 bytes leaves ample
// room for both suffixes while keeping the file recognizable in an `ls`.
//
// The bound is applied at every point that CREATES a name: the extracted
// path here, ConvertSRTtoVTT and ConvertSubtitleToVTT (whose own output
// names can overrun for a long enough sidecar), and ShiftVTTCues, which
// derives its name from whichever of those it was handed.
//
// ShiftVTTCues is the important one and was the last to get it. It is the
// os.Create that actually failed, and the only one an external .vtt sidecar
// reaches at all — such a sidecar is served straight from the media
// directory and never passes through a cache-naming function, so bounding
// the producers alone left it exposed. A ~230-character sidecar name made
// the shift fail with ENAMETOOLONG, the handler logged "subtitle cue-shift
// failed; serving unshifted", and cues were served offset by the resume
// position: issue #131's bug, back for the longest filenames only.
const cacheStemMax = 120

// cacheStem truncates a filename stem to cacheStemMax bytes without splitting
// a UTF-8 rune (a split rune would render as a replacement character in an
// operator's `ls`, and could differ across filesystems' normalization).
func cacheStem(stem string) string {
	if len(stem) <= cacheStemMax {
		return stem
	}
	cut := cacheStemMax
	for cut > 0 && !utf8.RuneStart(stem[cut]) {
		cut--
	}
	return stem[:cut]
}

// ExtractSubtitleVTT extracts a subtitle track and converts it to WebVTT format.
// Returns the path to the generated .vtt file.
//
// The result is cached under a key that includes the media file's
// (size, mtime) fingerprint, so replacing the media in place — a re-encode,
// an upgraded rip, a corrected file at the same path — retires the cached
// track instead of serving it forever. See extractedVTTPath for the policy
// and its trade-offs.
//
// This is the server half of the fix; the client half is ServeSubtitle's
// `Cache-Control: no-cache`. Both are needed. The SPA's track URL is keyed
// on (fileId, index, type, start, remux) with nothing media-derived, and
// nothing else churns it (withToken has been a no-op since the
// httpOnly-cookie migration), so under the previous day-long max-age a
// browser went on serving the old track for up to 24h and never asked the
// server — making this invalidation invisible to exactly the viewer it was
// meant to help.
func ExtractSubtitleVTT(ctx context.Context, filePath string, streamIndex int, cacheDir string) (string, error) {
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", fmt.Errorf("create subtitle cache dir: %w", err)
	}

	vttPath := extractedVTTPath(filePath, streamIndex, cacheDir)

	// Return cached version if it exists and has content.
	// A previous extraction may have been killed mid-write (timeout, signal),
	// leaving a 0-byte or truncated file that would serve an empty subtitle.
	//
	// No mtime comparison here: the fingerprint is already in the key, so a
	// changed source resolves to a DIFFERENT path rather than to a stale
	// entry at this one.
	if info, err := os.Stat(vttPath); err == nil && info.Size() > 0 {
		return vttPath, nil
	}

	// 10 minutes: large MKV files (8+ GB) require reading through the entire
	// container to collect interleaved subtitle packets. On spinning disks or
	// network mounts this can take several minutes for 4K files.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-i", filePath,
		"-map", fmt.Sprintf("0:%d", streamIndex),
		"-c:s", "webvtt",
		"-y",
		vttPath,
	)

	// Bounded, and ErrWaitDelay is not a failure here (runBounded,
	// execwait.go): the process we started exited 0, so deleting the .vtt and
	// erroring would throw away an extraction that cost up to ten minutes of
	// reading through the container.
	//
	// "Exited 0" is what os/exec can tell us, and it is not quite "the file is
	// complete": the premise of the whole bound is that some OTHER process
	// inherited the descriptors, so an ffmpeg wrapper that returns 0 while
	// backgrounding the real work would leave a partial .vtt that the size
	// check above then caches. The old behaviour in that same scenario was an
	// unbounded hang the 10-minute context could not break (it kills the
	// process, which has already exited), so this is the better failure — but
	// it is a failure mode, not a guarantee.
	if output, err := boundedCombinedOutput(cmd); err != nil {
		os.Remove(vttPath) // Clean up partial file
		return "", fmt.Errorf("extract subtitle: %w: %s", err, string(output))
	}

	return vttPath, nil
}

// ServeSubtitle serves a VTT subtitle file with proper headers.
//
// `no-cache` means "store it, but revalidate before reuse" — NOT "don't
// cache". The body is still served from the browser's cache on a 304, so
// the cost of this over the previous `max-age=86400` is one conditional
// request per track load: http.ServeFile emits Last-Modified and answers
// If-Modified-Since with a 304 and an empty body.
//
// It has to revalidate, because the track URL is not content-addressed.
// The SPA keys it on (fileId, index, type, start, remux) and nothing else
// churns it (withToken has been a no-op since the httpOnly-cookie
// migration), so under a day-long max-age a browser kept serving the old
// subtitles for up to 24h after the media was replaced in place — which
// made ExtractSubtitleVTT's server-side invalidation invisible to exactly
// the viewers it was meant to help.
//
// The revalidation is not per-seek: each distinct resume position is
// already a distinct URL, so this is roughly one extra headers-only
// round trip per track per page load.
//
// One cost this cannot avoid: a client that cached a track under the old
// max-age=86400 will not ask again until that entry expires, so for up to
// 24h after this deploys the staleness it fixes persists for exactly the
// viewers it targets. Nothing server-side reaches them; the entry has to
// age out (or they hard-reload). One-time, at rollout only.
//
// `private` because /api/stream/ is on the query-token promotion allowlist
// and the SPA still builds this URL through withToken(): a shared cache
// must never store a response whose URL may carry a ?token=. Same reasoning
// as the segment endpoint in streaming.go.
//
// The ETag exists because Last-Modified alone is not a sufficient validator
// HERE, and the fingerprint key is exactly why: the served file can move
// BACKWARDS in time. Replace media A with B (new track, newer mtime), then
// restore A preserving its size and mtime — the `rsync -a` case this whole
// change exists for — and the key resolves back to A's older track. A
// browser holding B would send If-Modified-Since with B's newer stamp,
// http.ServeFile would answer 304, and the viewer would keep B's subtitles
// over A's video. Deriving the validator from (name, size, mtime) instead
// makes any change of key a change of validator regardless of ordering.
// If-None-Match takes precedence over If-Modified-Since, so this wins.
func ServeSubtitle(w http.ResponseWriter, r *http.Request, vttPath string) {
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-cache")
	if info, err := os.Stat(vttPath); err == nil {
		// The name carries the media fingerprint (extracted tracks) or the
		// source path plus offset (shifted ones); size and mtime cover an
		// external sidecar edited in place, whose name never changes.
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d",
			filepath.Base(vttPath), info.Size(), info.ModTime().UnixNano())))
		w.Header().Set("ETag", fmt.Sprintf("%q", fmt.Sprintf("%x", sum[:8])))
	}
	// CORS headers are set by the router-level CORS middleware based on AllowedOrigins.
	// Do NOT set Access-Control-Allow-Origin here — it would bypass the CORS policy.
	http.ServeFile(w, r, vttPath)
}

// vttTimestampRE matches WebVTT cue timestamps. Format spec:
//
//	HH:MM:SS.fff    (e.g. 01:23:45.678)
//	MM:SS.fff       (e.g. 23:45.678)
//
// Captures: 1=full timestamp, 2=hh (optional), 3=mm, 4=ss, 5=fff.
var vttTimestampRE = regexp.MustCompile(`(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\.(\d{3})`)

// vttCueLineRE matches the timing line of a VTT cue:
//
//	<start> --> <end> [cue settings…]
//
// We rewrite both timestamps and preserve everything after the second
// timestamp (cue position/align settings, if any).
var vttCueLineRE = regexp.MustCompile(`^((?:\d{1,3}:)?\d{1,2}:\d{2}\.\d{3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}\.\d{3})(.*)$`)

// parseVTTTimestamp converts a VTT timestamp string to seconds (float).
// Returns -1 on parse failure.
func parseVTTTimestamp(ts string) float64 {
	m := vttTimestampRE.FindStringSubmatch(ts)
	if m == nil {
		return -1
	}
	var hh, mm, ss, fff int
	if m[1] != "" {
		hh, _ = strconv.Atoi(m[1])
	}
	mm, _ = strconv.Atoi(m[2])
	ss, _ = strconv.Atoi(m[3])
	fff, _ = strconv.Atoi(m[4])
	return float64(hh*3600+mm*60+ss) + float64(fff)/1000.0
}

// formatVTTTimestamp renders seconds (float) as a VTT timestamp.
// Always emits HH:MM:SS.fff for consistency.
func formatVTTTimestamp(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	hh := int(sec / 3600)
	rem := sec - float64(hh*3600)
	mm := int(rem / 60)
	rem -= float64(mm * 60)
	ss := int(rem)
	fff := int((rem - float64(ss)) * 1000.0)
	return fmt.Sprintf("%02d:%02d:%02d.%03d", hh, mm, ss, fff)
}

// cacheIsFresh reports whether a derived file (a shifted or converted
// VTT) can be reused for the given source. The three source-derived
// caches below — ShiftVTTCues, ConvertSRTtoVTT and ConvertSubtitleToVTT
// — ask exactly this question, so they ask it through here rather than
// repeating the comparison and drifting apart.
//
// ExtractSubtitleVTT still does NOT come through here, but no longer
// because it lacks a policy: it now invalidates against the media file
// through a (size, mtime) fingerprint in its cache KEY rather than an
// mtime comparison at this one. An mtime comparison would be the wrong
// rule there — it cannot see a replacement that preserves or restores an
// older timestamp, and re-reading an 8+ GB container is far too
// expensive to retry on every request when the comparison goes one way.
// See extractedVTTPath for the policy and its costs.
//
// The mtime comparison is deliberately NON-STRICT. A cache is written
// after its source is read, so a valid entry has mtime >= the source's
// and the source can only be newer if it changed afterwards, which
// shows up as strictly newer. (That holds while both stamps come from
// one clock. Media on a network mount whose server clock runs ahead
// breaks it and defeats the cache. Pre-existing, and this change does
// nothing for it either way: for any non-zero skew the two rules agree,
// since they differ only at exact equality.)
//
// Requiring the output to be strictly NEWER instead made a same-tick
// write look stale, which is what made TestShiftVTTCuesCachesResult
// fail intermittently in CI. A tie means current, not stale.
//
// Scope of that bug, stated precisely because it is easy to overstate:
// an entry written inside its source's mtime tick is rebuilt on the
// NEXT request, and that rebuild's os.Create usually lands in a later
// tick and breaks the tie for good. So the cost was roughly one extra
// rebuild per entry — repeated only while requests keep arriving inside
// a single tick — not one per request.
//
// The residual case this gives up is a source rewritten within the same
// mtime tick as the conversion that read it. Nothing detects it
// afterwards — these caches are keyed on path alone, with no content
// check — so it clears only via main.go's daily sweep of the subtitle
// cache dir, i.e. up to ~31 days of serving a stale conversion.
//
// The window is one mtime tick wide on ANY filesystem, not just coarse
// ones: ext4 stamps inodes from the kernel's coarse clock, measured
// here at ~4ms, and back-to-back writes tie the large majority of the
// time (that is exactly why the CI flake was reachable at all). It is
// wider still on FAT/exFAT and some SMB mounts, where a tick is 1-2s.
// Hitting it also needs a fetcher rewriting the sidecar inside that
// window. Narrow, and accepted knowingly.
//
// A zero-length output is never fresh — that is a truncated write from
// an interrupted conversion, not a cache entry.
func cacheIsFresh(outInfo, srcInfo os.FileInfo) bool {
	return outInfo.Size() > 0 && !outInfo.ModTime().Before(srcInfo.ModTime())
}

// ShiftVTTCues reads vttPath and writes a NEW VTT file with every cue
// timestamp shifted by -offsetSec seconds. Cues that become fully
// negative (end < 0 after the shift) are dropped — they're already
// "in the past" relative to the resume point. Cues that straddle zero
// (start < 0 < end) are clamped: start := 0, end stays.
//
// The output is cached at <cacheDir>/<hash>_shift<offset>.vtt. If
// offsetSec <= 0, returns vttPath unchanged (no shift needed).
//
// This exists because the HLS transcode uses -ss to seek the input,
// so the player's currentTime=0 corresponds to file-time=offsetSec.
// Sidecar VTT cues use ORIGINAL file timestamps, so without the shift
// every cue would fire at the wrong moment (or never, if past EOF).
// Reported as Aurora Issue #131 (subtitles invisible after resume).
//
// 2026-05-28 (Issue #141) — offsetSec is now a float64 and MUST be the
// actual keyframe time the player's t=0 maps to, NOT the requested
// resume position. `-ss <startSec>` placed before `-i` is an INPUT
// seek: ffmpeg lands on the nearest keyframe ≤ startSec, and
// -copyts/-start_at_zero make THAT keyframe the HLS t=0. Shifting by
// the raw startSec (which can be up to one GOP after the keyframe)
// placed every cue ~2-3s too early — "subtitles ahead of audio".
// Callers pass where the player's media time 0 is in the file, not the
// requested startSec: for a remux, the measured start when the client sent
// one, else ProbeSeekKeyframe(startSec) (internal/api subtitleCueShift).
func ShiftVTTCues(vttPath string, offsetSec float64, cacheDir string) (string, error) {
	if offsetSec <= 0 {
		return vttPath, nil
	}
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", fmt.Errorf("create vtt-shift cache dir: %w", err)
	}
	src, err := os.Open(vttPath)
	if err != nil {
		return "", fmt.Errorf("open vtt source: %w", err)
	}
	defer src.Close()
	srcInfo, err := src.Stat()
	if err != nil {
		return "", fmt.Errorf("stat vtt source: %w", err)
	}

	// Cache key: hash of (vttPath, offset rounded to ms). Keep the
	// source filename stem so the cached file is debuggable on disk.
	// Round to milliseconds for the key so float jitter from the
	// keyframe probe doesn't fragment the cache.
	offsetMs := int64(offsetSec*1000 + 0.5)
	h := sha256.Sum256([]byte(fmt.Sprintf("%s|%d", vttPath, offsetMs)))
	// Bounded here as well as at the producers: this is the os.Create that
	// actually fails, and it is the ONLY one reachable for an external .vtt
	// sidecar, which is read straight from the media directory and never
	// passes through a cache-naming function. The stem is cosmetic —
	// uniqueness rides the (vttPath, offsetMs) hash — so truncating it costs
	// nothing and covers any future producer automatically.
	stem := cacheStem(strings.TrimSuffix(filepath.Base(vttPath), filepath.Ext(vttPath)))
	outPath := filepath.Join(cacheDir, fmt.Sprintf("%s_shift%dms_%x.vtt", stem, offsetMs, h[:6]))

	// Cache hit: existing shifted file non-empty and not older than the source.
	if outInfo, err := os.Stat(outPath); err == nil && cacheIsFresh(outInfo, srcInfo) {
		return outPath, nil
	}

	dst, err := os.Create(outPath)
	if err != nil {
		return "", fmt.Errorf("create shifted vtt: %w", err)
	}
	defer dst.Close()

	bw := bufio.NewWriter(dst)
	defer bw.Flush()

	scanner := bufio.NewScanner(src)
	// Bump the scanner buffer for long cue lines. Default 64K is fine
	// for normal subs but some ASS-converted VTTs have multi-line
	// settings strings.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	// Read the whole VTT into memory and process in BLOCK mode. Block
	// mode is necessary because:
	//   - STYLE / NOTE / REGION blocks can span many lines and must be
	//     preserved verbatim (any content inside may be CSS-like and
	//     may even contain text that *looks* like a timing line).
	//   - Cue blocks have an optional first-line id; the timing line
	//     is the second non-blank line.
	//
	// VTT spec: blocks are separated by one or more blank lines. The
	// FIRST block must be the WEBVTT header. Subsequent blocks are
	// classified by their first non-blank line:
	//   - starts with "STYLE"  → STYLE block (verbatim)
	//   - starts with "NOTE"   → NOTE block  (verbatim)
	//   - starts with "REGION" → REGION block (verbatim)
	//   - contains "-->" on first or second line → cue block
	//   - anything else → unknown, pass through verbatim
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		os.Remove(outPath)
		return "", fmt.Errorf("read vtt: %w", err)
	}

	startOffset := offsetSec

	// emitBlock writes a slice of lines + a trailing blank-line
	// separator (the block boundary). Empty blocks are skipped.
	emitBlock := func(block []string) {
		if len(block) == 0 {
			return
		}
		for _, l := range block {
			bw.WriteString(l + "\n")
		}
		bw.WriteString("\n")
	}

	// Group input into blocks (slices of lines) separated by blank
	// lines. Multiple consecutive blanks collapse into one separator.
	var blocks [][]string
	var cur []string
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			if len(cur) > 0 {
				blocks = append(blocks, cur)
				cur = nil
			}
			continue
		}
		cur = append(cur, l)
	}
	if len(cur) > 0 {
		blocks = append(blocks, cur)
	}

	// Process each block.
	for bi, block := range blocks {
		// The first block is the WEBVTT header. Emit verbatim.
		if bi == 0 {
			emitBlock(block)
			continue
		}
		first := strings.TrimSpace(block[0])
		// STYLE / NOTE / REGION blocks: verbatim passthrough.
		if first == "STYLE" || strings.HasPrefix(first, "STYLE ") ||
			first == "NOTE" || strings.HasPrefix(first, "NOTE ") ||
			first == "REGION" || strings.HasPrefix(first, "REGION ") {
			emitBlock(block)
			continue
		}
		// Identify the timing line: first line in the block that
		// matches vttCueLineRE. If line 0 is the timing line, there's
		// no cue id. If line 1 is the timing line, line 0 is the id.
		// If no timing line matches, this isn't a cue — pass through.
		timingIdx := -1
		var timingMatch []string
		for li, l := range block {
			if m := vttCueLineRE.FindStringSubmatch(l); m != nil {
				timingIdx = li
				timingMatch = m
				break
			}
		}
		if timingIdx < 0 {
			// Not a recognizable cue block — pass through verbatim
			// (defensive against unusual VTT extensions).
			emitBlock(block)
			continue
		}
		startT := parseVTTTimestamp(timingMatch[1])
		endT := parseVTTTimestamp(timingMatch[2])
		if startT < 0 || endT < 0 {
			// Timing parse failed — pass through verbatim.
			emitBlock(block)
			continue
		}
		shiftedStart := startT - startOffset
		shiftedEnd := endT - startOffset
		if shiftedEnd <= 0 {
			// Entire cue is in the past — drop the whole block (id +
			// timing + text).
			continue
		}
		if shiftedStart < 0 {
			shiftedStart = 0
		}
		// Settings tail (cue position/alignment) — keep as-is.
		settings := timingMatch[3]
		// Ensure exactly one space between end-timestamp and settings
		// when settings is non-empty and doesn't already start with
		// whitespace. Source files always have it, but be defensive
		// (Deep-debug S3).
		if settings != "" && !strings.HasPrefix(settings, " ") && !strings.HasPrefix(settings, "\t") {
			settings = " " + settings
		}
		newTiming := fmt.Sprintf("%s --> %s%s",
			formatVTTTimestamp(shiftedStart),
			formatVTTTimestamp(shiftedEnd),
			settings,
		)
		// Rebuild the block: cue-id lines (if any) + new timing +
		// rest of the cue text body.
		rebuilt := make([]string, 0, len(block))
		rebuilt = append(rebuilt, block[:timingIdx]...)
		rebuilt = append(rebuilt, newTiming)
		rebuilt = append(rebuilt, block[timingIdx+1:]...)
		emitBlock(rebuilt)
	}
	return outPath, nil
}

// ConvertSRTtoVTT converts an external .srt file to .vtt format.
// Output is written to cacheDir to avoid issues with read-only media mounts.
func ConvertSRTtoVTT(srtPath, cacheDir string) (string, error) {
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", fmt.Errorf("create subtitle cache dir: %w", err)
	}

	// Use a hash of the full path to avoid collisions between SRT files
	// with the same name in different directories
	h := sha256.Sum256([]byte(srtPath))
	baseName := cacheStem(strings.TrimSuffix(filepath.Base(srtPath), ".srt"))
	vttPath := filepath.Join(cacheDir, fmt.Sprintf("%s_%x.vtt", baseName, h[:6]))

	// Return cached version if it exists, is non-empty, and is not older
	// than the SRT. The non-empty half matters here: a conversion killed
	// mid-write leaves a 0-byte file that would otherwise be served
	// forever as an empty subtitle track.
	srtInfo, err := os.Stat(srtPath)
	if err != nil {
		return "", err
	}
	if vttInfo, err := os.Stat(vttPath); err == nil && cacheIsFresh(vttInfo, srtInfo) {
		return vttPath, nil
	}

	// Read SRT
	srtFile, err := os.Open(srtPath)
	if err != nil {
		return "", err
	}
	defer srtFile.Close()

	// Write VTT
	vttFile, err := os.Create(vttPath)
	if err != nil {
		return "", err
	}
	defer vttFile.Close()

	w := bufio.NewWriter(vttFile)
	w.WriteString("WEBVTT\n\n")

	// SRT timestamp pattern: 00:00:00,000 --> 00:00:00,000
	// VTT uses periods instead of commas in timestamps
	srtTimestamp := regexp.MustCompile(`^(\d{2}:\d{2}:\d{2}),(\d{3})\s*(-->)\s*(\d{2}:\d{2}:\d{2}),(\d{3})`)

	scanner := bufio.NewScanner(srtFile)
	for scanner.Scan() {
		line := scanner.Text()
		// Only convert commas to periods in timestamp lines
		if srtTimestamp.MatchString(line) {
			line = srtTimestamp.ReplaceAllString(line, "${1}.${2} ${3} ${4}.${5}")
		}
		w.WriteString(line + "\n")
	}

	if err := scanner.Err(); err != nil {
		os.Remove(vttPath)
		return "", err
	}

	if err := w.Flush(); err != nil {
		os.Remove(vttPath)
		return "", err
	}

	return vttPath, nil
}

// ConvertSubtitleToVTT converts any subtitle file (ASS, SSA, SUB, etc.) to WebVTT
// using ffmpeg. This handles formats that ConvertSRTtoVTT (pure Go) cannot.
// Output is written to cacheDir to avoid issues with read-only media mounts.
func ConvertSubtitleToVTT(ctx context.Context, subPath string, cacheDir string) (string, error) {
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", fmt.Errorf("create subtitle cache dir: %w", err)
	}

	h := sha256.Sum256([]byte(subPath))
	baseName := cacheStem(strings.TrimSuffix(filepath.Base(subPath), filepath.Ext(subPath)))
	vttPath := filepath.Join(cacheDir, fmt.Sprintf("%s_%x.vtt", baseName, h[:6]))

	// Return cached version if it exists, is non-empty, and is not older
	// than the source
	srcInfo, err := os.Stat(subPath)
	if err != nil {
		return "", err
	}
	if vttInfo, err := os.Stat(vttPath); err == nil && cacheIsFresh(vttInfo, srcInfo) {
		return vttPath, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-i", subPath,
		"-c:s", "webvtt",
		"-y",
		vttPath,
	)

	// Bounded, ErrWaitDelay not a failure — see ExtractSubtitleVTT above.
	if output, err := boundedCombinedOutput(cmd); err != nil {
		os.Remove(vttPath) // Clean up partial file
		return "", fmt.Errorf("convert subtitle: %w: %s", err, string(output))
	}

	return vttPath, nil
}

// FindExternalSubtitles discovers .srt, .vtt, .ass files next to a media file.
func FindExternalSubtitles(mediaPath string) []models.SubtitleTrack {
	dir := filepath.Dir(mediaPath)
	base := strings.TrimSuffix(filepath.Base(mediaPath), filepath.Ext(mediaPath))

	var tracks []models.SubtitleTrack
	subtitleExts := []string{".srt", ".vtt", ".ass", ".ssa"}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	idx := 1000 // Start external sub indices high to avoid collision with embedded
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))

		isSubtitle := false
		for _, se := range subtitleExts {
			if ext == se {
				isSubtitle = true
				break
			}
		}
		if !isSubtitle {
			continue
		}

		// Must match the media file base name
		// e.g., "Movie.2024.eng.srt" matches "Movie.2024.mkv"
		if !strings.HasPrefix(name, base) {
			continue
		}

		// Extract language hint from filename
		// e.g., "Movie.2024.eng.srt" → "eng"
		remainder := strings.TrimPrefix(name, base)
		remainder = strings.TrimSuffix(remainder, ext)
		remainder = strings.Trim(remainder, ".")

		lang := "und" // unknown
		if remainder != "" {
			parts := strings.Split(remainder, ".")
			lang = parts[len(parts)-1]
		}

		track := models.SubtitleTrack{
			Index:    idx,
			Language: lang,
			Title:    filepath.Join(dir, name), // Full path for internal use by ServeSubtitle handler
			Codec:    strings.TrimPrefix(ext, "."),
		}
		tracks = append(tracks, track)
		idx++
	}

	return tracks
}

// ============================================================
// Phase 3: Subtitle Burn-In
// ============================================================

// SubtitleRelativeIndex translates an ABSOLUTE ffprobe stream index into the
// SUBTITLE-RELATIVE index that FFmpeg's `subtitles` filter expects in its
// stream_index option.
//
// Audit MED — the `subtitles` filter's stream_index is counted ONLY over the
// file's subtitle streams (0 = first subtitle stream, 1 = second, …), NOT over
// all streams. Passing the absolute index (e.g. stream 2 in a video+audio+sub
// file) makes the filter try to read the 3rd subtitle stream, which usually
// doesn't exist — burn-in then fails or silently picks the wrong track.
//
// tracks must be the file's subtitle tracks as returned by ProbeSubtitles
// (ordered by appearance in the container). The position of the track whose
// .Index == absoluteIndex is the relative index. If no track matches (probe
// empty, stale index, or probe failure), we return absoluteIndex unchanged —
// the pre-fix behavior, which is never worse than before and avoids breaking
// burn-in entirely on a probe hiccup.
func SubtitleRelativeIndex(tracks []models.SubtitleTrack, absoluteIndex int) int {
	for rel, t := range tracks {
		if t.Index == absoluteIndex {
			return rel
		}
	}
	return absoluteIndex
}

// BurnInArgs returns FFmpeg filter arguments to burn subtitles into the video stream.
// For embedded subs, streamIndex is the ABSOLUTE ffprobe stream index within the
// container; it is translated to the subtitle-relative index the `subtitles`
// filter requires (audit MED). For external subs, externalPath is the path to
// the .srt/.ass/.ssa file.
// These args are designed to be appended to the -vf filter chain.
//
// Note: burn-in happens when the client can't render subtitles natively (e.g.,
// PGS bitmap subs on a web player, or ASS subs with complex styling).
func BurnInArgs(mediaPath string, streamIndex int, externalPath string) []string {
	if externalPath != "" {
		// External subtitle file — use the subtitles filter directly
		// Escape special characters for FFmpeg filter syntax
		escaped := escapeFFmpegPath(externalPath)
		return []string{"-vf", fmt.Sprintf("subtitles=%s", escaped)}
	}

	// Embedded subtitle — reference the input file and stream index. The
	// `subtitles` filter's stream_index is subtitle-relative, so probe the
	// file's subtitle streams and map the absolute index across. On any probe
	// failure ProbeSubtitles returns no tracks and SubtitleRelativeIndex falls
	// back to the absolute index (pre-fix behavior).
	relIndex := streamIndex
	if tracks, _ := ProbeSubtitles(context.Background(), mediaPath); len(tracks) > 0 {
		relIndex = SubtitleRelativeIndex(tracks, streamIndex)
	}
	escaped := escapeFFmpegPath(mediaPath)
	return []string{"-vf", fmt.Sprintf("subtitles=%s:stream_index=%d", escaped, relIndex)}
}

// BurnInBitmapArgs returns FFmpeg filter arguments to burn bitmap-based subtitles
// (PGS, DVB, VOBSUB) into the video stream. These require overlay instead of the
// text-based subtitles filter.
// streamIndex is the ABSOLUTE stream index (from ffprobe), not subtitle-relative.
func BurnInBitmapArgs(streamIndex int, scaleFilter string) []string {
	// Build filter_complex that preserves any existing scale filter.
	// Without this, multi-profile transcodes would output at source resolution
	// instead of the profile's target resolution.
	if scaleFilter != "" {
		return []string{
			"-filter_complex",
			fmt.Sprintf("[0:v]%s[scaled];[scaled][0:%d]overlay", scaleFilter, streamIndex),
		}
	}
	// No scale (e.g., remux or source-resolution profile)
	return []string{
		"-filter_complex",
		fmt.Sprintf("[0:v][0:%d]overlay", streamIndex),
	}
}

// IsBitmapSubtitle returns true if the codec is a bitmap-based subtitle format.
//
// Issue #135 — extended the list defensively. FFmpeg's codec_name for the
// same source can vary by version; we want to catch every variant so the
// frontend bitmap filter doesn't leak through and the ServeSubtitle 400
// guard fires the moment a bitmap track is requested. If a new codec
// variant slips through, the new subtitle-served slog.Info will reveal it.
func IsBitmapSubtitle(codec string) bool {
	switch strings.ToLower(codec) {
	// PGS (Blu-ray): hdmv_pgs_subtitle (modern), pgssub (older), pgs (alias)
	case "hdmv_pgs_subtitle", "pgssub", "pgs", "pgs_subtitle":
		return true
	// VobSub (DVD)
	case "dvd_subtitle", "dvdsub", "vobsub":
		return true
	// DVB (broadcast)
	case "dvb_subtitle", "dvbsub":
		return true
	// xsub (DivX bitmap subs)
	case "xsub":
		return true
	// hdmv_text_subtitle is text-based per name but FFmpeg's webvtt
	// converter rejects it as "unsupported source codec" — treat as
	// bitmap to keep it out of the picker until we add a real converter.
	case "hdmv_text_subtitle":
		return true
	}
	return false
}

// IsTextSubtitle returns true if the codec is a text-based subtitle format
// that we know FFmpeg can convert to WebVTT cleanly. Used as a SECONDARY
// check by the frontend so an unrecognized codec name (neither in the
// bitmap list nor here) is shown to the user with a "may not work"
// indicator instead of silently failing.
//
// Issue #135 — added because Elf's "eng" subrip should obviously work but
// didn't, and we want the picker to tell the user "this should work" vs
// "this is unknown territory" so future bug reports include the codec
// name in the user's complaint.
func IsTextSubtitle(codec string) bool {
	switch strings.ToLower(codec) {
	case "subrip", "srt",
		"ass", "ssa",
		"webvtt", "vtt",
		"mov_text",
		"text", "subviewer", "subviewer1",
		"eia_608", "eia_708",
		"microdvd":
		return true
	}
	return false
}

// escapeFilterOptionValue escapes a string for FFmpeg's INNER (option-level)
// filtergraph parsing pass. When a filter's argument string is split into
// options, av_get_token treats backslash as an escape, single quotes as a
// quoting region, ':' as the option separator, and '=' as the key/value
// separator — all four must be escaped for the value to survive intact.
// '[', ']', ';' and ',' are not special at this level; the extra backslash
// they get here is harmless (a backslash before a non-special character
// yields the character) and keeps this list aligned with the historical
// behavior.
func escapeFilterOptionValue(path string) string {
	// Order matters: escape backslash first so the backslashes we add for the
	// other characters (and for the quote below) aren't themselves re-escaped.
	path = strings.ReplaceAll(path, "\\", "\\\\")
	path = strings.ReplaceAll(path, ":", "\\:")
	path = strings.ReplaceAll(path, "'", "\\'") // option-level quote: escape, don't toggle regions
	path = strings.ReplaceAll(path, "[", "\\[")
	path = strings.ReplaceAll(path, "]", "\\]")
	path = strings.ReplaceAll(path, ";", "\\;")
	path = strings.ReplaceAll(path, "=", "\\=")
	path = strings.ReplaceAll(path, ",", "\\,")
	return path
}

// escapeFilterGraphLevel escapes a string for FFmpeg's OUTER (graph-level)
// filtergraph parsing pass, which runs BEFORE option parsing and strips one
// layer of escapes itself: backslash escapes, single-quote regions, ','
// (next filter in a chain), ';' (next chain) and '[' / ']' (link labels).
// ':' and '=' are NOT special at this level and stay as-is.
func escapeFilterGraphLevel(s string) string {
	// Backslash first, same reasoning as escapeFilterOptionValue.
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "'", "\\'")
	s = strings.ReplaceAll(s, ",", "\\,")
	s = strings.ReplaceAll(s, ";", "\\;")
	s = strings.ReplaceAll(s, "[", "\\[")
	s = strings.ReplaceAll(s, "]", "\\]")
	return s
}

// escapeFFmpegPath escapes a file path for embedding in an FFmpeg filtergraph
// literal (e.g. the argument to subtitles=...:stream_index=N).
//
// FFmpeg parses a filtergraph string TWICE — first the graph-level pass
// (filters, chains, link labels, quoting), then the option-level pass on each
// filter's argument string (option separation, key=value, quoting) — and EACH
// pass interprets and strips one layer of backslash/quote escaping. A literal
// path therefore needs two levels of escaping, option level first. See "Notes
// on filtergraph escaping" in the ffmpeg-filters documentation.
//
// Single-level escaping is the classic mistake and was a real bug here
// (verified against FFmpeg 7.0): subtitles=/m/Ocean\'s.srt reaches the option
// parser as /m/Ocean's.srt, whose bare quote opens an option-level quoting
// region that swallows the rest of the argument string — the filter then
// tries to open "/m/Oceans.srt:stream_index=0" (apostrophe deleted, options
// eaten) and every burn-in on an apostrophe or colon path failed to start.
func escapeFFmpegPath(path string) string {
	return escapeFilterGraphLevel(escapeFilterOptionValue(path))
}
