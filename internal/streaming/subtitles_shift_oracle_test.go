package streaming

// writeShiftedVTT against the rewrite main shipped (ShiftVTTCues before the
// in-memory path existed), kept here verbatim as an oracle: the rewrite was
// restructured to stream blocks and stop copying every line, and must give
// byte-identical output for every input main accepted.

import (
	"bufio"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"testing"
)

// referenceShiftVTT is main's ShiftVTTCues rewrite, minus the file handling.
func referenceShiftVTT(input string, offsetSec float64) (string, error) {
	var out strings.Builder
	bw := bufio.NewWriter(&out)
	scanner := bufio.NewScanner(strings.NewReader(input))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	startOffset := offsetSec
	emitBlock := func(block []string) {
		if len(block) == 0 {
			return
		}
		for _, l := range block {
			bw.WriteString(l + "\n")
		}
		bw.WriteString("\n")
	}
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
	for bi, block := range blocks {
		if bi == 0 {
			emitBlock(block)
			continue
		}
		first := strings.TrimSpace(block[0])
		if first == "STYLE" || strings.HasPrefix(first, "STYLE ") ||
			first == "NOTE" || strings.HasPrefix(first, "NOTE ") ||
			first == "REGION" || strings.HasPrefix(first, "REGION ") {
			emitBlock(block)
			continue
		}
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
			emitBlock(block)
			continue
		}
		startT := parseVTTTimestamp(timingMatch[1])
		endT := parseVTTTimestamp(timingMatch[2])
		if startT < 0 || endT < 0 {
			emitBlock(block)
			continue
		}
		shiftedStart := startT - startOffset
		shiftedEnd := endT - startOffset
		if shiftedEnd <= 0 {
			continue
		}
		if shiftedStart < 0 {
			shiftedStart = 0
		}
		settings := timingMatch[3]
		if settings != "" && !strings.HasPrefix(settings, " ") && !strings.HasPrefix(settings, "\t") {
			settings = " " + settings
		}
		newTiming := fmt.Sprintf("%s --> %s%s",
			formatVTTTimestamp(shiftedStart),
			formatVTTTimestamp(shiftedEnd),
			settings,
		)
		rebuilt := make([]string, 0, len(block))
		rebuilt = append(rebuilt, block[:timingIdx]...)
		rebuilt = append(rebuilt, newTiming)
		rebuilt = append(rebuilt, block[timingIdx+1:]...)
		emitBlock(rebuilt)
	}
	bw.Flush()
	return out.String(), nil
}

// oracleCorpus is the shapes a VTT can take, including the ones the
// line splitting must get exactly right.
var oracleCorpus = []string{
	"",
	"WEBVTT",
	"WEBVTT\n",
	"\n\n\nWEBVTT\n\n00:00:30.000 --> 00:00:31.000\nleading blanks\n",
	memoryShiftFixture,
	"WEBVTT\r\n\r\n00:00:30.000 --> 00:00:32.000\r\nCRLF cue\r\nsecond line\r\n\r\n1\r\n00:01:00.000 --> 00:01:01.000 align:end\r\nid'd\r\n",
	"WEBVTT\n\n00:00:30.000 --> 00:00:32.000\nno final newline",
	"WEBVTT\n\n00:00:30.000 --> 00:00:32.000\r",
	"WEBVTT\n \t \n00:00:30.000 --> 00:00:32.000\nwhitespace-only separator\n\t\n\n   \n00:00:40.000 --> 00:00:41.000\nafter a run of blanks\n",
	"WEBVTT\n\nREGION\nid:fred\nwidth:40%\n\nSTYLE ::cue{}\n\nNOTE\n00:00:30.000 --> 00:00:31.000\nlooks like a cue inside a NOTE\n",
	"WEBVTT\n\nnot a cue\nat all\n\n00:00:30.000 --> 00:00:31.000\nreal\n",
	"WEBVTT\n\n99:99.999 --> 00:00:01.000\nodd but matching timing\n\n00:30.000 --> 00:31.500\nshort form\n\n100:00:00.000 --> 100:00:01.000\nthree-digit hours\n",
	"WEBVTT\n\n00:00:30.000-->00:00:31.000\ntight arrow\n\n00:00:30.000 -->   00:00:31.000 \t position:10%\nwide arrow, tab settings\n",
	"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nwholly early\n\n00:00:09.999 --> 00:00:10.001\nstraddles\n\n00:00:10.000 --> 00:00:10.000\nends exactly at zero\n",
	"WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:30.000 --> 00:00:31.000\nheader with a second line\n",
	"WEBVTT\n\ncue-id\n\n00:00:30.000 --> 00:00:31.000\nid alone in its block\n",
	"WEBVTT\n\n00:00:30.000 --> 00:00:31.000\n\n\n\n",
	"WEBVTT\n\nmid\rline carriage\n00:00:30.000 --> 00:00:31.000\ntext\r\r\n",
}

func randomVTT(r *rand.Rand) string {
	var sb strings.Builder
	sb.WriteString([]string{"WEBVTT", "WEBVTT - title", "", "\n"}[r.Intn(4)])
	nl := func() string { return []string{"\n", "\r\n", "\n\n", "\n \n", "\r\n\r\n"}[r.Intn(5)] }
	sb.WriteString(nl())
	for i, n := 0, r.Intn(40); i < n; i++ {
		switch r.Intn(10) {
		case 0:
			sb.WriteString("NOTE something" + nl() + "more")
		case 1:
			sb.WriteString("STYLE" + "\n::cue { color: red }")
		case 2:
			sb.WriteString("garbage line --> not a time")
		default:
			if r.Intn(3) == 0 {
				fmt.Fprintf(&sb, "%d\n", i)
			}
			s := r.Float64() * 120
			e := s + r.Float64()*5
			settings := []string{"", " align:start", "line:0", "\tposition:50%"}[r.Intn(4)]
			fmt.Fprintf(&sb, "%s --> %s%s\ntext %d", formatVTTTimestamp(s), formatVTTTimestamp(e), settings, i)
			if r.Intn(2) == 0 {
				sb.WriteString("\nsecond line")
			}
		}
		sb.WriteString(nl())
		if r.Intn(4) == 0 {
			sb.WriteString(nl())
		}
	}
	return sb.String()
}

func TestWriteShiftedVTTMatchesMainsRewrite(t *testing.T) {
	inputs := append([]string{}, oracleCorpus...)
	r := rand.New(rand.NewSource(510))
	for i := 0; i < 400; i++ {
		inputs = append(inputs, randomVTT(r))
	}
	for i, in := range inputs {
		// The two entry points read a file.
		p := writeTempVTT(t, t.TempDir(), "in.vtt", in)
		cacheDir := t.TempDir()
		for _, offset := range []float64{0.001, 9.946009, 10, 30, 61.25, 3600} {
			want, err := referenceShiftVTT(in, offset)
			if err != nil {
				t.Fatalf("input %d: reference: %v", i, err)
			}
			var got strings.Builder
			writeShiftedVTT(in, offset, &got)
			if got.String() != want {
				t.Fatalf("input %d, offset %v: output differs from main's rewrite\ninput:\n%q\n got:\n%q\nwant:\n%q", i, offset, in, got.String(), want)
			}
			if body := shiftFileInMemory(t, p, offset); string(body) != want {
				t.Fatalf("input %d, offset %v: the in-memory shift = %q", i, offset, body)
			}
			cached, err := ShiftVTTCues(p, offset, cacheDir)
			if err != nil {
				t.Fatalf("input %d, offset %v: ShiftVTTCues: %v", i, offset, err)
			}
			if data, _ := os.ReadFile(cached); string(data) != want {
				t.Fatalf("input %d, offset %v: ShiftVTTCues wrote %q", i, offset, data)
			}
		}
	}
}
