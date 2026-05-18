package streaming

import (
	"os"
	"path/filepath"
	"testing"
)

// buildTSPacket constructs a single 188-byte MPEG-TS packet.
//
// Parameters:
//   - pid:        13-bit PID (Program ID)
//   - pusi:       Payload Unit Start Indicator (true = new PES packet begins here)
//   - afOnly:     true = adaptation field only (no payload)
//   - afLen:      adaptation field length (0 = no adaptation field; >0 = has AF)
//   - pesPayload: raw bytes placed after TS header (and AF). If pusi=true,
//                 this should be a valid PES header with optional PTS.
//
// Returns a 188-byte TS packet.
func buildTSPacket(pid uint16, pusi bool, afOnly bool, afLen int, pesPayload []byte) []byte {
	pkt := make([]byte, 188)

	// Byte 0: Sync byte
	pkt[0] = 0x47

	// Byte 1: Transport Error (0), PUSI, Transport Priority (0), PID high 5 bits
	pkt[1] = byte((pid >> 8) & 0x1F)
	if pusi {
		pkt[1] |= 0x40
	}

	// Byte 2: PID low 8 bits
	pkt[2] = byte(pid & 0xFF)

	// Byte 3: Scrambling(0), Adaptation Field Control, Continuity Counter(0)
	payloadStart := 4
	if afOnly {
		// 10 = adaptation field only, no payload
		pkt[3] = 0x20
		pkt[4] = byte(188 - 5) // fill remaining with AF
		return pkt
	}
	if afLen > 0 {
		// 11 = adaptation field + payload
		pkt[3] = 0x30
		pkt[4] = byte(afLen)
		payloadStart = 5 + afLen
		// Fill AF data with zeros (after the length byte, which is pkt[4])
	} else {
		// 01 = payload only
		pkt[3] = 0x10
	}

	// Copy PES payload into the packet at payloadStart
	if payloadStart < 188 && len(pesPayload) > 0 {
		n := copy(pkt[payloadStart:], pesPayload)
		_ = n
	}

	return pkt
}

// buildPESHeaderWithPTS constructs a PES header with a 33-bit PTS value.
//
// PES format (first 14+ bytes):
//   [00 00 01] [StreamID] [PES_length(2)] [flags(2)] [PES_header_data_length]
//   [PTS(5 bytes)]
//
// The PTS is encoded as:
//   Byte 0: [0010 xxx1] where xxx = PTS[32..30] (for PTS-only; 0011 for PTS+DTS)
//   Byte 1-2: [PTS[29..22] | PTS[21..15]<<1 | marker]
//   Byte 3-4: [PTS[14..7] | PTS[6..0]<<1 | marker]
func buildPESHeaderWithPTS(streamID byte, pts int64) []byte {
	pes := make([]byte, 14)

	// Start code: 00 00 01
	pes[0] = 0x00
	pes[1] = 0x00
	pes[2] = 0x01

	// Stream ID
	pes[3] = streamID

	// PES packet length: 0 (unbounded, common for video)
	pes[4] = 0x00
	pes[5] = 0x00

	// Byte 6: Marker bits + flags
	// [10] = MPEG-2 marker, scrambling=00, priority=0, alignment=0, copyright=0, original=0
	pes[6] = 0x80

	// Byte 7: PTS/DTS flags + other flags
	// [10] = PTS only (bits 7-6), no ESCR, no ES rate, no DSM, no copy info, no CRC, no extension
	pes[7] = 0x80

	// Byte 8: PES header data length (5 bytes for PTS)
	pes[8] = 5

	// Bytes 9-13: PTS (5 bytes with marker bits)
	// Byte 9: [0010 xxx1] where xxx = PTS[32..30]
	pes[9] = byte(0x21 | ((int(pts>>30) & 0x07) << 1))

	// Bytes 10-11: PTS[29..15] with marker bit
	// Byte 10: PTS[29..22]
	// Byte 11: PTS[21..15] << 1 | marker(1)
	mid := (pts >> 15) & 0x7FFF
	pes[10] = byte(mid >> 7)
	pes[11] = byte((mid&0x7F)<<1) | 0x01

	// Bytes 12-13: PTS[14..0] with marker bit
	// Byte 12: PTS[14..7]
	// Byte 13: PTS[6..0] << 1 | marker(1)
	low := pts & 0x7FFF
	pes[12] = byte(low >> 7)
	pes[13] = byte((low&0x7F)<<1) | 0x01

	return pes
}

// writeTSFile writes a sequence of TS packets to a temp file and returns the path.
func writeTSFile(t *testing.T, dir string, packets ...[]byte) string {
	t.Helper()
	path := filepath.Join(dir, "seg_00000.ts")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, pkt := range packets {
		if _, err := f.Write(pkt); err != nil {
			f.Close()
			t.Fatal(err)
		}
	}
	f.Close()
	return path
}

// verifyPTSEncoding is a helper that round-trips a PTS value through our
// PES encoder and the extractFirstPTS parser, asserting they match.
func verifyPTSEncoding(t *testing.T, dir string, pts int64, label string) {
	t.Helper()

	// Build a TS packet with a video PES header containing the PTS
	pes := buildPESHeaderWithPTS(0xE0, pts) // 0xE0 = video stream
	pkt := buildTSPacket(0x100, true, false, 0, pes)
	tsPath := writeTSFile(t, dir, pkt)

	got := extractFirstPTS(tsPath)
	if got != pts {
		t.Errorf("%s: extractFirstPTS returned %d, want %d (diff=%.3f seconds)",
			label, got, pts, float64(got-pts)/90000.0)
	}
}

func TestExtractFirstPTS_ZeroPTS(t *testing.T) {
	dir := t.TempDir()
	verifyPTSEncoding(t, dir, 0, "PTS=0")
}

func TestExtractFirstPTS_SmallPTS(t *testing.T) {
	dir := t.TempDir()
	// 90000 = 1 second
	verifyPTSEncoding(t, dir, 90000, "PTS=90000 (1s)")
}

func TestExtractFirstPTS_TypicalOffset(t *testing.T) {
	dir := t.TempDir()
	// 900000 = 10 seconds (standard MPEG-TS initial offset)
	verifyPTSEncoding(t, dir, 900000, "PTS=900000 (10s)")
}

func TestExtractFirstPTS_LargePTS(t *testing.T) {
	dir := t.TempDir()
	// 2^32 - 1 = a large 33-bit value (near max; max is 2^33-1)
	verifyPTSEncoding(t, dir, 0xFFFFFFFF, "PTS=0xFFFFFFFF")
}

func TestExtractFirstPTS_MaxPTS(t *testing.T) {
	dir := t.TempDir()
	// 2^33 - 1 = maximum possible 33-bit PTS value
	verifyPTSEncoding(t, dir, (1<<33)-1, "PTS=max_33bit")
}

func TestExtractFirstPTS_CommonValues(t *testing.T) {
	// Test specific PTS values commonly seen in real MPEG-TS files
	tests := []struct {
		name string
		pts  int64
	}{
		{"PTS=8100 (~0.09s B-frame offset)", 8100},
		{"PTS=126000 (1.4s typical first GOP)", 126000},
		{"PTS=900000 (10s standard offset)", 900000},
		{"PTS=1800000 (20s)", 1800000},
		{"PTS=450000 (5s Jellyfin default)", 450000},
		// Edge cases at bit boundaries
		{"PTS=0x7FFF (15 bits max)", 0x7FFF},
		{"PTS=0x8000 (16th bit)", 0x8000},
		{"PTS=0x3FFFFFFF (30 bits max)", 0x3FFFFFFF},
		{"PTS=0x40000000 (31st bit)", 0x40000000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			verifyPTSEncoding(t, dir, tt.pts, tt.name)
		})
	}
}

func TestExtractFirstPTS_VideoStreamID(t *testing.T) {
	dir := t.TempDir()
	// 0xE0 = first video stream
	pes := buildPESHeaderWithPTS(0xE0, 54000)
	pkt := buildTSPacket(0x100, true, false, 0, pes)
	path := writeTSFile(t, dir, pkt)

	got := extractFirstPTS(path)
	if got != 54000 {
		t.Errorf("video stream 0xE0: got PTS %d, want 54000", got)
	}
}

func TestExtractFirstPTS_AudioStreamID(t *testing.T) {
	dir := t.TempDir()
	// 0xC0 = first audio stream
	pes := buildPESHeaderWithPTS(0xC0, 72000)
	pkt := buildTSPacket(0x100, true, false, 0, pes)
	path := writeTSFile(t, dir, pkt)

	got := extractFirstPTS(path)
	if got != 72000 {
		t.Errorf("audio stream 0xC0: got PTS %d, want 72000", got)
	}
}

func TestExtractFirstPTS_PrivateStream(t *testing.T) {
	dir := t.TempDir()
	// 0xBD = private stream 1 (AC-3 audio, subtitle, etc.)
	pes := buildPESHeaderWithPTS(0xBD, 81000)
	pkt := buildTSPacket(0x100, true, false, 0, pes)
	path := writeTSFile(t, dir, pkt)

	got := extractFirstPTS(path)
	if got != 81000 {
		t.Errorf("private stream 0xBD: got PTS %d, want 81000", got)
	}
}

func TestExtractFirstPTS_SkipsPATandCAT(t *testing.T) {
	dir := t.TempDir()

	// PAT packet (PID=0) with PUSI — should be skipped
	patPES := buildPESHeaderWithPTS(0xE0, 99999) // would be wrong if returned
	pat := buildTSPacket(0, true, false, 0, patPES)

	// CAT packet (PID=1) with PUSI — should be skipped
	cat := buildTSPacket(1, true, false, 0, patPES)

	// Null packet (PID=0x1FFF) — should be skipped
	null := buildTSPacket(0x1FFF, true, false, 0, patPES)

	// Real video PES on PID 0x100
	pes := buildPESHeaderWithPTS(0xE0, 54000)
	video := buildTSPacket(0x100, true, false, 0, pes)

	path := writeTSFile(t, dir, pat, cat, null, video)
	got := extractFirstPTS(path)
	if got != 54000 {
		t.Errorf("should skip PAT/CAT/null, got PTS %d, want 54000", got)
	}
}

func TestExtractFirstPTS_SkipsNonPUSI(t *testing.T) {
	dir := t.TempDir()

	// Non-PUSI continuation packet (no PES header start)
	continuation := buildTSPacket(0x100, false, false, 0, []byte{0, 0, 0, 0})

	// Real video PES with PUSI on next packet
	pes := buildPESHeaderWithPTS(0xE0, 45000)
	video := buildTSPacket(0x100, true, false, 0, pes)

	path := writeTSFile(t, dir, continuation, video)
	got := extractFirstPTS(path)
	if got != 45000 {
		t.Errorf("should skip non-PUSI packet, got PTS %d, want 45000", got)
	}
}

func TestExtractFirstPTS_AdaptationFieldPlusPayload(t *testing.T) {
	dir := t.TempDir()

	// Packet with adaptation field (afLen=8) + payload
	// This tests the AFC=3 (AF+payload) branch
	pes := buildPESHeaderWithPTS(0xE0, 63000)
	pkt := buildTSPacket(0x100, true, false, 8, pes)

	path := writeTSFile(t, dir, pkt)
	got := extractFirstPTS(path)
	if got != 63000 {
		t.Errorf("AF+payload: got PTS %d, want 63000", got)
	}
}

func TestExtractFirstPTS_AdaptationFieldOnly(t *testing.T) {
	dir := t.TempDir()

	// AF-only packet (no payload) — should be skipped
	afOnly := buildTSPacket(0x100, true, true, 0, nil)

	// Real video PES in next packet
	pes := buildPESHeaderWithPTS(0xE0, 72000)
	video := buildTSPacket(0x100, true, false, 0, pes)

	path := writeTSFile(t, dir, afOnly, video)
	got := extractFirstPTS(path)
	if got != 72000 {
		t.Errorf("should skip AF-only packet, got PTS %d, want 72000", got)
	}
}

func TestExtractFirstPTS_SkipsNonAVStreamID(t *testing.T) {
	dir := t.TempDir()

	// PES with stream ID 0xBE (padding stream) — not AV, should skip
	pes := buildPESHeaderWithPTS(0xBE, 11111)
	paddingPkt := buildTSPacket(0x100, true, false, 0, pes)

	// Real video PES
	realPES := buildPESHeaderWithPTS(0xE0, 22222)
	videoPkt := buildTSPacket(0x101, true, false, 0, realPES)

	path := writeTSFile(t, dir, paddingPkt, videoPkt)
	got := extractFirstPTS(path)
	if got != 22222 {
		t.Errorf("should skip non-AV stream IDs, got PTS %d, want 22222", got)
	}
}

func TestExtractFirstPTS_NoPTSFlag(t *testing.T) {
	dir := t.TempDir()

	// PES header with PTS/DTS flags = 00 (no PTS) — should be skipped
	pes := make([]byte, 14)
	pes[0], pes[1], pes[2] = 0, 0, 1 // start code
	pes[3] = 0xE0                      // video stream
	pes[6] = 0x80                      // MPEG-2 marker
	pes[7] = 0x00                      // PTS/DTS flags = 00 (no timestamps)
	pes[8] = 0                         // header data length = 0
	noPTSPkt := buildTSPacket(0x100, true, false, 0, pes)

	// Real PES with PTS
	realPES := buildPESHeaderWithPTS(0xE0, 36000)
	videoPkt := buildTSPacket(0x100, true, false, 0, realPES)

	path := writeTSFile(t, dir, noPTSPkt, videoPkt)
	got := extractFirstPTS(path)
	if got != 36000 {
		t.Errorf("should skip PES without PTS flag, got PTS %d, want 36000", got)
	}
}

func TestExtractFirstPTS_NonexistentFile(t *testing.T) {
	got := extractFirstPTS("/nonexistent/path/seg_00000.ts")
	if got != 0 {
		t.Errorf("nonexistent file should return 0, got %d", got)
	}
}

func TestExtractFirstPTS_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "seg_00000.ts")
	if err := os.WriteFile(path, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}
	got := extractFirstPTS(path)
	if got != 0 {
		t.Errorf("empty file should return 0, got %d", got)
	}
}

func TestExtractFirstPTS_TooSmallFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "seg_00000.ts")
	// Less than 188 bytes (one TS packet)
	if err := os.WriteFile(path, make([]byte, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	got := extractFirstPTS(path)
	if got != 0 {
		t.Errorf("too-small file should return 0, got %d", got)
	}
}

func TestExtractFirstPTS_GarbageData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "seg_00000.ts")
	// 188 bytes of garbage (no 0x47 sync byte)
	garbage := make([]byte, 188)
	for i := range garbage {
		garbage[i] = 0xFF
	}
	if err := os.WriteFile(path, garbage, 0o644); err != nil {
		t.Fatal(err)
	}
	got := extractFirstPTS(path)
	if got != 0 {
		t.Errorf("garbage data should return 0, got %d", got)
	}
}

func TestExtractFirstPTS_Resync(t *testing.T) {
	dir := t.TempDir()

	// 10 bytes of garbage THEN a valid TS packet
	// This tests the resync logic: 0x47 not at expected boundary
	garbage := make([]byte, 10)
	for i := range garbage {
		garbage[i] = 0xAA
	}

	pes := buildPESHeaderWithPTS(0xE0, 27000)
	pkt := buildTSPacket(0x100, true, false, 0, pes)

	data := append(garbage, pkt...)
	// Pad to ensure we have enough data
	for len(data) < 400 {
		data = append(data, 0x00)
	}

	path := filepath.Join(dir, "seg_00000.ts")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	got := extractFirstPTS(path)
	if got != 27000 {
		t.Errorf("resync should find PTS after garbage, got %d, want 27000", got)
	}
}

func TestExtractFirstPTS_NoPESFound(t *testing.T) {
	dir := t.TempDir()

	// Valid TS packets but none with PUSI + valid PES
	// Only PAT and null packets
	pat := buildTSPacket(0, true, false, 0, make([]byte, 20))
	null := buildTSPacket(0x1FFF, true, false, 0, make([]byte, 20))

	path := writeTSFile(t, dir, pat, null)
	got := extractFirstPTS(path)
	if got != 0 {
		t.Errorf("no PES found should return 0, got %d", got)
	}
}

func TestExtractFirstPTS_FirstPESReturned(t *testing.T) {
	dir := t.TempDir()

	// Two PES packets with different PTS — should return the FIRST one
	pes1 := buildPESHeaderWithPTS(0xE0, 45000)
	pkt1 := buildTSPacket(0x100, true, false, 0, pes1)

	pes2 := buildPESHeaderWithPTS(0xE0, 90000)
	pkt2 := buildTSPacket(0x100, true, false, 0, pes2)

	path := writeTSFile(t, dir, pkt1, pkt2)
	got := extractFirstPTS(path)
	if got != 45000 {
		t.Errorf("should return first PTS, got %d, want 45000", got)
	}
}

func TestExtractFirstPTS_PTSWithDTS(t *testing.T) {
	dir := t.TempDir()

	// PES header with PTS+DTS flags (0xC0 in byte 7 bits 7-6)
	// When both PTS and DTS are present, PTS byte 9 starts with [0011 xxx1]
	// instead of [0010 xxx1]. The extractFirstPTS function checks ptsDtsFlags >= 2,
	// so this should still extract the PTS correctly.
	pts := int64(81000)

	pes := make([]byte, 19) // PES header with PTS+DTS
	pes[0], pes[1], pes[2] = 0, 0, 1
	pes[3] = 0xE0 // video
	pes[4] = 0x00
	pes[5] = 0x00
	pes[6] = 0x80                                                 // MPEG-2
	pes[7] = 0xC0                                                 // PTS+DTS present (bits 7-6 = 11)
	pes[8] = 10                                                   // header data length (5 PTS + 5 DTS)
	pes[9] = byte(0x31 | ((int(pts>>30) & 0x07) << 1))           // PTS byte 0 with 0011 prefix
	mid := (pts >> 15) & 0x7FFF                                   // PTS[29..15]
	pes[10] = byte(mid >> 7)                                      // PTS byte 1
	pes[11] = byte((mid&0x7F)<<1) | 0x01                         // PTS byte 2
	low := pts & 0x7FFF                                           // PTS[14..0]
	pes[12] = byte(low >> 7)                                      // PTS byte 3
	pes[13] = byte((low&0x7F)<<1) | 0x01                         // PTS byte 4
	pes[14] = byte(0x11 | ((int(pts>>30) & 0x07) << 1))          // DTS byte 0 (0001 prefix)
	pes[15], pes[16], pes[17], pes[18] = 0x00, 0x01, 0x00, 0x01 // DTS filler

	pkt := buildTSPacket(0x100, true, false, 0, pes)
	path := writeTSFile(t, dir, pkt)

	got := extractFirstPTS(path)
	if got != pts {
		t.Errorf("PTS+DTS: got %d, want %d", got, pts)
	}
}

func TestExtractFirstPTS_LargeAdaptationField(t *testing.T) {
	dir := t.TempDir()

	// Large adaptation field that leaves barely enough room for PES header.
	// TS packet is 188 bytes. Header = 4 bytes. AF length byte = 1.
	// AF data = afLen. Payload starts at 5 + afLen.
	// PES header needs at least 14 bytes. So payload = 188 - 5 - afLen >= 14
	// => afLen <= 169. Use afLen = 160, leaving 23 bytes for payload.
	pes := buildPESHeaderWithPTS(0xE0, 36000)
	pkt := buildTSPacket(0x100, true, false, 160, pes)

	path := writeTSFile(t, dir, pkt)
	got := extractFirstPTS(path)
	if got != 36000 {
		t.Errorf("large AF: got %d, want 36000", got)
	}
}

func TestExtractFirstPTS_AFTooLargeForPES(t *testing.T) {
	dir := t.TempDir()

	// AF so large that payload < 14 bytes (not enough for PES header)
	// afLen = 170: payload starts at 175, only 13 bytes left — insufficient
	pes := buildPESHeaderWithPTS(0xE0, 99999) // would be wrong if returned
	pktBad := buildTSPacket(0x100, true, false, 170, pes)

	// Next packet has a proper PES
	realPES := buildPESHeaderWithPTS(0xE0, 18000)
	pktGood := buildTSPacket(0x100, true, false, 0, realPES)

	path := writeTSFile(t, dir, pktBad, pktGood)
	got := extractFirstPTS(path)
	if got != 18000 {
		t.Errorf("should skip packet with too-large AF, got %d, want 18000", got)
	}
}

func TestExtractFirstPTS_MalformedPESStartCode(t *testing.T) {
	dir := t.TempDir()

	// Packet with PUSI set but invalid PES start code (not 00 00 01)
	badPES := make([]byte, 20)
	badPES[0] = 0xFF // Wrong start code
	badPES[1] = 0xFF
	badPES[2] = 0xFF
	pktBad := buildTSPacket(0x100, true, false, 0, badPES)

	// Good packet follows
	realPES := buildPESHeaderWithPTS(0xE0, 54000)
	pktGood := buildTSPacket(0x100, true, false, 0, realPES)

	path := writeTSFile(t, dir, pktBad, pktGood)
	got := extractFirstPTS(path)
	if got != 54000 {
		t.Errorf("should skip malformed PES, got %d, want 54000", got)
	}
}

// TestExtractFirstPTS_RoundTrip exhaustively tests many PTS values to ensure
// the encoder and parser are inverses of each other.
func TestExtractFirstPTS_RoundTrip(t *testing.T) {
	dir := t.TempDir()

	// Test a range of PTS values spanning all 33 bits
	values := []int64{
		0, 1, 2,
		0x7F, 0x80, 0xFF,
		0x7FFF, 0x8000, 0xFFFF,
		0x7FFFFF, 0x800000, 0xFFFFFF,
		0x7FFFFFFF, 0x80000000, 0xFFFFFFFF,
		0x100000000, 0x1FFFFFFFF, // 33-bit values
		90000,    // 1 second
		900000,   // 10 seconds
		8100000,  // 90 seconds
		81000000, // 15 minutes
	}

	for _, pts := range values {
		subdir := filepath.Join(dir, "pts_"+string(rune(pts%26+'a')))
		if err := os.MkdirAll(subdir, 0o755); err != nil {
			t.Fatal(err)
		}
		verifyPTSEncoding(t, subdir, pts, "")
	}
}
