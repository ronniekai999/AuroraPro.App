package api

import (
	"testing"

	"github.com/aurora-media/aurora/internal/arr"
	"github.com/aurora-media/aurora/internal/models"
)

func TestParseMovieArrIDs(t *testing.T) {
	tests := []struct {
		input  string
		wantID int
		wantOk bool
	}{
		{"radarr:42", 42, true},
		{"radarr:1", 1, true},
		{"radarr4k:55", 55, true},    // 4K prefix
		{"radarr4k:1", 1, true},      // 4K prefix minimal
		{"42", 42, true},             // legacy format
		{"radarr:0", 0, false},       // zero ID
		{"radarr4k:0", 0, false},     // zero 4K ID
		{"radarr:-1", 0, false},      // negative
		{"", 0, false},               // empty
		{"sonarr:7:81189", 0, false}, // wrong prefix
		{"radarr:", 0, false},        // no ID after prefix
		{"radarr4k:", 0, false},      // no ID after 4K prefix
		{"abc", 0, false},            // non-numeric
	}
	for _, tt := range tests {
		id, ok := parseMovieArrIDs(tt.input)
		if id != tt.wantID || ok != tt.wantOk {
			t.Errorf("parseMovieArrIDs(%q) = (%d, %v), want (%d, %v)", tt.input, id, ok, tt.wantID, tt.wantOk)
		}
	}
}

func TestParseTVArrIDs(t *testing.T) {
	tests := []struct {
		input        string
		wantSonarrID int
		wantTvdbID   int
		wantHas      bool
	}{
		{"sonarr:7:81189", 7, 81189, true},
		{"sonarr:100:999", 100, 999, true},
		{"sonarr4k:8:82493", 8, 82493, true}, // 4K prefix
		{"sonarr4k:100:999", 100, 999, true}, // 4K prefix
		{"81189", 0, 81189, false},           // legacy: no sonarr ID
		{"sonarr:0:81189", 0, 0, false},      // zero sonarr ID
		{"sonarr4k:0:82493", 0, 0, false},    // zero 4K sonarr ID
		{"sonarr:7:0", 0, 0, false},          // zero tvdb ID
		{"sonarr4k:7:0", 0, 0, false},        // zero 4K tvdb ID
		{"sonarr:", 0, 0, false},             // malformed
		{"sonarr4k:", 0, 0, false},           // malformed 4K
		{"sonarr:abc:def", 0, 0, false},      // non-numeric
		{"", 0, 0, false},                    // empty
		{"radarr:42", 0, 0, false},           // wrong prefix
	}
	for _, tt := range tests {
		sid, tid, has := parseTVArrIDs(tt.input)
		if sid != tt.wantSonarrID || tid != tt.wantTvdbID || has != tt.wantHas {
			t.Errorf("parseTVArrIDs(%q) = (%d, %d, %v), want (%d, %d, %v)",
				tt.input, sid, tid, has, tt.wantSonarrID, tt.wantTvdbID, tt.wantHas)
		}
	}
}

func TestMapQueueStage(t *testing.T) {
	tests := []struct {
		name string
		qi   arr.QueueItem
		want string
	}{
		{"downloading", arr.QueueItem{Status: "downloading"}, "downloading"},
		{"queued", arr.QueueItem{Status: "queued"}, "queued"},
		{"delay", arr.QueueItem{Status: "delay"}, "queued"},
		{"completed no state", arr.QueueItem{Status: "completed"}, "downloaded"},
		{"import pending", arr.QueueItem{Status: "completed", TrackedDownloadState: "importPending"}, "downloaded"},
		{"importing", arr.QueueItem{Status: "completed", TrackedDownloadState: "importing"}, "importing"},
		{"failed pending", arr.QueueItem{Status: "warning", TrackedDownloadState: "failedPending"}, "failed_import"},
		{"failed status", arr.QueueItem{Status: "failed"}, "failed_import"},
		{"warning status", arr.QueueItem{Status: "warning"}, "failed_import"},
		{"unknown status", arr.QueueItem{Status: "unknown"}, "queued"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mapQueueStage(&tt.qi)
			if got != tt.want {
				t.Errorf("mapQueueStage() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSplitArrJobIDs(t *testing.T) {
	tests := []struct {
		input string
		want  int // expected number of parts
	}{
		{"", 0},
		{"radarr:42", 1},
		{"radarr:42|radarr4k:55", 2},
		{"sonarr:5:82493|sonarr4k:8:82493", 2},
	}
	for _, tt := range tests {
		got := splitArrJobIDs(tt.input)
		if len(got) != tt.want {
			t.Errorf("splitArrJobIDs(%q) = %d parts, want %d", tt.input, len(got), tt.want)
		}
	}
}

func TestIsDualQuality(t *testing.T) {
	tests := []struct {
		name   string
		jobIDs string
		want   bool
	}{
		{"single radarr", "radarr:42", false},
		{"single sonarr", "sonarr:5:82493", false},
		{"dual radarr", "radarr:42|radarr4k:55", true},
		{"dual sonarr", "sonarr:5:82493|sonarr4k:8:82493", true},
		{"empty", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := &models.Request{ArrJobIDs: tt.jobIDs}
			if got := isDualQuality(req); got != tt.want {
				t.Errorf("isDualQuality(%q) = %v, want %v", tt.jobIDs, got, tt.want)
			}
		})
	}
}

func TestStagePriority(t *testing.T) {
	// Verify ordering: importing < downloaded < downloading < queued < sent < failed_import
	stages := []string{"importing", "downloaded", "downloading", "queued", "sent", "failed_import"}
	for i := 0; i < len(stages)-1; i++ {
		if stagePriority(stages[i]) >= stagePriority(stages[i+1]) {
			t.Errorf("stagePriority(%q)=%d should be < stagePriority(%q)=%d",
				stages[i], stagePriority(stages[i]), stages[i+1], stagePriority(stages[i+1]))
		}
	}
}
