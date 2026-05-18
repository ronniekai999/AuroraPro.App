package library

import "testing"

func TestClassifyVersion(t *testing.T) {
	tests := []struct {
		name       string
		resolution string
		videoCodec string
		want       string
	}{
		// FFprobe format "WIDTHxHEIGHT"
		{name: "4K ffprobe", resolution: "3840x2160", videoCodec: "hevc", want: "4K"},
		{name: "4K DCI", resolution: "4096x2160", videoCodec: "hevc", want: "4K"},
		{name: "1080p ffprobe", resolution: "1920x1080", videoCodec: "h264", want: "1080p"},
		{name: "720p ffprobe", resolution: "1280x720", videoCodec: "h264", want: "720p"},
		{name: "SD ffprobe", resolution: "720x480", videoCodec: "h264", want: "SD"},
		{name: "SD low", resolution: "640x360", videoCodec: "h264", want: "SD"},
		// Parser format
		{name: "4K parser", resolution: "2160p", videoCodec: "", want: "4K"},
		{name: "4k lowercase", resolution: "4k", videoCodec: "", want: "4K"},
		{name: "1080p parser", resolution: "1080p", videoCodec: "", want: "1080p"},
		{name: "720p parser", resolution: "720p", videoCodec: "", want: "720p"},
		{name: "480p parser", resolution: "480p", videoCodec: "", want: "SD"},
		{name: "576p parser", resolution: "576p", videoCodec: "", want: "SD"},
		// Edge cases
		{name: "empty", resolution: "", videoCodec: "", want: ""},
		{name: "4K height only", resolution: "2560x2160", videoCodec: "", want: "4K"},
		{name: "ultrawide 1080p", resolution: "2560x1080", videoCodec: "", want: "1080p"},
		{name: "1080 height", resolution: "1440x1080", videoCodec: "", want: "1080p"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyVersion(tt.resolution, tt.videoCodec)
			if got != tt.want {
				t.Errorf("ClassifyVersion(%q, %q) = %q, want %q", tt.resolution, tt.videoCodec, got, tt.want)
			}
		})
	}
}
