package streaming

import "testing"

// TestSessionQoEFacts_DescribesRealSessions is the coverage the original
// telemetry lacked: it asked the BROWSER for these values, the browser could
// not know them, and every row therefore carried defaults — which made
// burn_in_sessions a hardcoded zero.
func TestSessionQoEFacts_DescribesRealSessions(t *testing.T) {
	fakeFFmpegOnPath(t)

	cases := []struct {
		name string
		opts SessionOpts
		want SessionQoEFacts
	}{
		{
			name: "software transcode",
			opts: SessionOpts{SourceVideoCodec: "hevc", AudioTrackIndex: -1},
			want: SessionQoEFacts{
				OutputCodec: "h264", EncoderFamily: "software", SegmentFormat: "fmp4",
				HDRConversion: "none", BurnIn: "none", SubtitleMode: "none",
			},
		},
		{
			// A remux copies the video, so no encoder runs on that path at all.
			name: "remux copies video",
			opts: SessionOpts{Remux: true, RemuxAudioCopy: true, SourceVideoCodec: "h264", AudioTrackIndex: -1},
			want: SessionQoEFacts{
				OutputCodec: "copy", EncoderFamily: "none", SegmentFormat: "fmp4",
				HDRConversion: "none", BurnIn: "none", SubtitleMode: "none",
			},
		},
		{
			name: "text burn-in",
			opts: SessionOpts{
				SourceVideoCodec: "h264", AudioTrackIndex: -1,
				BurnIn: &BurnInOpts{SubIndex: 2, RelIndex: 0},
			},
			want: SessionQoEFacts{
				OutputCodec: "h264", EncoderFamily: "software", SegmentFormat: "fmp4",
				HDRConversion: "none", BurnIn: "text", SubtitleMode: "burned",
			},
		},
		{
			// Bitmap subs take the -filter_complex overlay graph rather than
			// the -vf subtitles filter, which is why the column is three-way.
			name: "bitmap burn-in",
			opts: SessionOpts{
				SourceVideoCodec: "h264", AudioTrackIndex: -1,
				BurnIn: &BurnInOpts{SubIndex: 2, RelIndex: 0, IsBitmap: true},
			},
			want: SessionQoEFacts{
				OutputCodec: "h264", EncoderFamily: "software", SegmentFormat: "fmp4",
				HDRConversion: "none", BurnIn: "bitmap", SubtitleMode: "burned",
			},
		},
		{
			name: "hdr tonemap on the cpu chain",
			opts: SessionOpts{
				SourceVideoCodec: "hevc", AudioTrackIndex: -1,
				SourceHDR: true, HDRTonemap: true,
			},
			want: SessionQoEFacts{
				OutputCodec: "h264", EncoderFamily: "software", SegmentFormat: "fmp4",
				HDRConversion: "tonemap_cpu", BurnIn: "none", SubtitleMode: "none",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tm, err := NewTranscodeManager(t.TempDir(), matrixConfig())
			if err != nil {
				t.Fatalf("new transcode manager: %v", err)
			}
			t.Cleanup(tm.Close)

			s, err := tm.CreateSession(1, "qoe", "/library/movie.mkv", 640, 360, tc.opts)
			if err != nil {
				t.Fatalf("create session: %v", err)
			}
			got, ok := tm.SessionQoEFacts(s.ID)
			if !ok {
				t.Fatal("SessionQoEFacts reported the session as unknown")
			}
			if got != tc.want {
				t.Errorf("facts = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestSessionQoEFacts_UnknownSession reports not-found rather than inventing a
// description — the ingest handler falls back to the zero vocabulary, so an
// unknown reads as "none" instead of as a fabricated encoder family.
func TestSessionQoEFacts_UnknownSession(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), matrixConfig())
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)

	if _, ok := tm.SessionQoEFacts("does-not-exist"); ok {
		t.Error("SessionQoEFacts claimed to describe a session that does not exist")
	}
}

// TestDirectPlayQoEFacts pins the no-session answer: nothing is encoded,
// nothing is segmented.
func TestDirectPlayQoEFacts(t *testing.T) {
	f := DirectPlayQoEFacts()
	for name, got := range map[string]string{
		"output_codec": f.OutputCodec, "encoder_family": f.EncoderFamily,
		"segment_format": f.SegmentFormat, "hdr_conversion": f.HDRConversion,
		"burn_in": f.BurnIn, "subtitle_mode": f.SubtitleMode,
	} {
		if got != "none" {
			t.Errorf("direct play %s = %q, want none", name, got)
		}
	}
}
