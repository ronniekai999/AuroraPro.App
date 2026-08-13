package streaming

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The Mac client's capability set, pinned against the server it talks to.
//
// clients/macos is Swift and cannot be compiled — let alone run — on the Linux
// hosts that build and test this repo. That makes the client's caps string the
// single highest-risk piece of the native client: it is pure data, the server
// trusts it completely (it has no way to verify a claim), and an over-claim
// means the server hands over a file the player cannot open, with no transcode
// fallback.
//
// So it is checked HERE, in the language CI can actually run, by reading the
// Swift source as text. Same technique as
// TestSPAProbeEmitsNoNativeOnlyCapabilities reading streaming.ts and
// TestReasonCodeVocabularyMatchesSchema reading migration 056: the contract is
// verified against its real source rather than a restatement of it.

const macCapsSwiftPath = "../../clients/macos/Sources/AuroraKit/ClientCaps.swift"

// blankSourceComments replaces every // line comment and /* block comment */
// with spaces, preserving byte offsets so the caller's regexes still line up.
//
// Not optional politeness: the FIRST run of this test reported the Mac client
// claiming "h265" when it does not — the string appeared in a comment
// explaining why it is deliberately omitted, and a bare `"([^"]*)"` scrape
// cannot tell code from prose. The identical mistake had already been made
// once in this package against streaming.ts (see scanJSStringLiterals), which
// is twice, which is a pattern: never scrape source without removing comments
// first.
func blankSourceComments(src string) string {
	out := []byte(src)
	inLine, inBlock, inStr := false, false, false
	var quote byte
	for i := 0; i < len(out); i++ {
		c := out[i]
		switch {
		case inLine:
			if c == '\n' {
				inLine = false
			} else {
				out[i] = ' '
			}
		case inBlock:
			if c == '*' && i+1 < len(out) && out[i+1] == '/' {
				out[i], out[i+1] = ' ', ' '
				inBlock, i = false, i+1
			} else if c != '\n' {
				out[i] = ' '
			}
		case inStr:
			if c == '\\' {
				i++
			} else if c == quote {
				inStr = false
			}
		case c == '/' && i+1 < len(out) && out[i+1] == '/':
			out[i], out[i+1] = ' ', ' '
			inLine, i = true, i+1
		case c == '/' && i+1 < len(out) && out[i+1] == '*':
			out[i], out[i+1] = ' ', ' '
			inBlock, i = true, i+1
		case c == '"':
			inStr, quote = true, c
		}
	}
	return string(out)
}

// swiftCapabilitySet extracts the keys from a
// `public static let <name> = ClientCapabilities(keys: [ … ])` literal.
func swiftCapabilitySet(t *testing.T, source, name string) map[string]bool {
	t.Helper()
	source = blankSourceComments(source)
	re := regexp.MustCompile(`(?s)public static let ` + regexp.QuoteMeta(name) +
		`\s*=\s*ClientCapabilities\(keys:\s*\[(.*?)\]\)`)
	m := re.FindStringSubmatch(source)
	if m == nil {
		t.Fatalf("no ClientCapabilities literal named %q in %s", name, macCapsSwiftPath)
	}
	keys := map[string]bool{}
	for _, lit := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(m[1], -1) {
		keys[lit[1]] = true
	}
	if len(keys) == 0 {
		t.Fatalf("extracted no keys from the %q literal — the extraction is broken", name)
	}
	return keys
}

func readMacCapsSource(t *testing.T) string {
	t.Helper()
	source, err := os.ReadFile(macCapsSwiftPath)
	if err != nil {
		t.Skipf("Mac client not present (%v) — skipping; this test guards clients/macos when it exists", err)
	}
	return string(source)
}

// The libVLC set IS the documented native contract — not a subset, not a
// superset. Drift in either direction is a bug: a key the doc advertises but
// the client omits means files transcode for no reason, and a key the client
// sends but the doc doesn't describe is an unreviewed capability claim.
func TestMacClientCapsMatchDocumentedContract(t *testing.T) {
	documented := documentedNativeCaps(t)
	swift := swiftCapabilitySet(t, readMacCapsSource(t), "libVLC")

	for key := range documented {
		if !swift[key] {
			t.Errorf("docs/native-client-caps.md advertises %q but the Mac client never sends it "+
				"— those files will transcode on a player that could have direct-played them", key)
		}
	}
	for key := range swift {
		if !documented[key] {
			t.Errorf("the Mac client claims %q, which the contract does not describe "+
				"— add it to docs/native-client-caps.md or stop sending it", key)
		}
	}
}

// Whatever the Mac client claims, the server must actually understand. A key
// that ParseClientCaps drops on the floor is a silent no-op: the client
// believes it asked for direct play and quietly gets a transcode forever.
func TestMacClientCapsAreAllUnderstoodByTheServer(t *testing.T) {
	source := readMacCapsSource(t)
	for _, setName := range []string{"libVLC", "appleNative"} {
		t.Run(setName, func(t *testing.T) {
			keys := swiftCapabilitySet(t, source, setName)
			joined := make([]string, 0, len(keys))
			for key := range keys {
				joined = append(joined, key)
			}
			caps := ParseClientCaps(strings.Join(joined, ","))

			for key := range keys {
				switch {
				case strings.HasSuffix(key, "_container"):
					if !caps.Containers[key] {
						t.Errorf("%q is not parsed as a container", key)
					}
				case key == "hls_native":
					if !caps.HLSNative {
						t.Errorf("%q is not parsed", key)
					}
				case key == "hls_js":
					t.Errorf("the Mac client must never send %q — it is a browser flag that "+
						"restricts HLS audio to what hls.js can demux", key)
				case key == "h264_hi10":
					if !caps.H264Hi10 {
						t.Errorf("%q is not parsed", key)
					}
				case key == "hevc_main10":
					if !caps.HEVCMain10 {
						t.Errorf("%q is not parsed", key)
					}
				case key == "eac3_mse":
					if !caps.EAC3MSE {
						t.Errorf("%q is not parsed", key)
					}
				default:
					if !caps.VideoCodecs[key] && !caps.AudioCodecs[key] {
						t.Errorf("%q is parsed into neither VideoCodecs nor AudioCodecs "+
							"— the server ignores it and the client silently gets a transcode", key)
					}
				}
			}
		})
	}
}

// The Apple/AVFoundation engine must claim STRICTLY LESS than libVLC, and in
// particular none of the native-only capabilities: AVFoundation cannot open
// Matroska, DTS, TrueHD, PCM or Hi10P, so claiming any of them earns a
// direct-play decision it would render as a black window with no fallback.
// This is the client-side mirror of the browser-safety guard.
func TestMacAppleEngineClaimsNothingItCannotDecode(t *testing.T) {
	source := readMacCapsSource(t)
	apple := swiftCapabilitySet(t, source, "appleNative")
	vlc := swiftCapabilitySet(t, source, "libVLC")

	for key := range apple {
		switch {
		case isDirectPlayOnlyAudio(key):
			t.Errorf("the Apple engine claims native-only audio %q — AVFoundation cannot decode it", key)
		case directPlayOnlyVideoCodecs[key]:
			t.Errorf("the Apple engine claims native-only video %q — AVFoundation cannot decode it", key)
		case key == "h264_hi10":
			t.Errorf("the Apple engine claims %q — AVFoundation rejects High 10 exactly as browsers do", key)
		case strings.HasSuffix(key, "_container") && key != "mp4_container":
			t.Errorf("the Apple engine claims %q — AVFoundation opens MP4/MOV only", key)
		}
		if !vlc[key] {
			t.Errorf("the Apple engine claims %q which libVLC does not — libVLC should be a superset", key)
		}
	}
}

// documentedNativeCaps parses the "complete native caps string" block out of
// the client contract. Shared shape with
// TestNativeAppCapsMatchesDocumentedContract; kept separate so a failure names
// which side drifted.
func documentedNativeCaps(t *testing.T) map[string]bool {
	t.Helper()
	const docPath = "../../docs/native-client-caps.md"
	source, err := os.ReadFile(docPath)
	if err != nil {
		t.Fatalf("read %s: %v", docPath, err)
	}
	re := regexp.MustCompile("(?s)### A complete native caps string\\s*\n+```\n(.*?)```")
	m := re.FindStringSubmatch(string(source))
	if m == nil {
		t.Fatal("no complete-caps code block found in " + docPath)
	}
	keys := map[string]bool{}
	for _, key := range strings.Split(strings.ReplaceAll(m[1], "\n", ""), ",") {
		if key = strings.TrimSpace(key); key != "" {
			keys[key] = true
		}
	}
	if len(keys) < 20 {
		t.Fatalf("parsed only %d keys from the contract — extraction is broken", len(keys))
	}
	return keys
}
