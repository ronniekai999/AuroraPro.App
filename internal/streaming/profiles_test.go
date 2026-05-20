package streaming

import (
	"strings"
	"testing"
)

func TestResolveProfiles_1080pSource(t *testing.T) {
	profiles := ResolveProfiles([]string{"1080p", "720p", "480p"}, 1920, 1080)

	names := profileNames(profiles)
	assertProfilePresent(t, names, "1080p")
	assertProfilePresent(t, names, "720p")
	assertProfilePresent(t, names, "480p")
}

func TestResolveProfiles_720pSource(t *testing.T) {
	profiles := ResolveProfiles([]string{"1080p", "720p", "480p"}, 1280, 720)

	names := profileNames(profiles)
	assertProfileAbsent(t, names, "1080p")
	assertProfilePresent(t, names, "720p")
	assertProfilePresent(t, names, "480p")
}

func TestResolveProfiles_480pSource(t *testing.T) {
	profiles := ResolveProfiles([]string{"1080p", "720p", "480p"}, 854, 480)

	names := profileNames(profiles)
	assertProfileAbsent(t, names, "1080p")
	assertProfileAbsent(t, names, "720p")
	assertProfilePresent(t, names, "480p")
}

func TestResolveProfiles_VeryLowResSource(t *testing.T) {
	// Source smaller than all profiles: should fallback to 360p
	profiles := ResolveProfiles([]string{"1080p", "720p", "480p"}, 320, 240)

	if len(profiles) != 1 {
		t.Fatalf("expected 1 profile (360p fallback), got %d: %v", len(profiles), profileNames(profiles))
	}
	if profiles[0].Name != "360p" {
		t.Errorf("fallback profile = %q, want %q", profiles[0].Name, "360p")
	}
}

func TestResolveProfiles_DefaultEnabled(t *testing.T) {
	// nil enabled should use ProfileOrder as default
	profiles := ResolveProfiles(nil, 1920, 1080)

	names := profileNames(profiles)
	if len(names) == 0 {
		t.Fatal("expected profiles when enabled is nil")
	}
	assertProfilePresent(t, names, "1080p")
}

func TestResolveProfiles_EmptyEnabled(t *testing.T) {
	profiles := ResolveProfiles([]string{}, 1920, 1080)

	names := profileNames(profiles)
	if len(names) == 0 {
		t.Fatal("expected profiles when enabled is empty")
	}
}

func TestResolveProfiles_SubsetEnabled(t *testing.T) {
	// Only enable 720p and 480p
	profiles := ResolveProfiles([]string{"720p", "480p"}, 1920, 1080)

	names := profileNames(profiles)
	assertProfileAbsent(t, names, "1080p")
	assertProfilePresent(t, names, "720p")
	assertProfilePresent(t, names, "480p")
}

func TestResolveProfiles_OrderMatches(t *testing.T) {
	// Profiles should be returned in ProfileOrder (highest to lowest)
	profiles := ResolveProfiles(nil, 1920, 1080)

	for i := 1; i < len(profiles); i++ {
		if profiles[i].Width > profiles[i-1].Width {
			t.Errorf("profile %d (%s, %dpx) is wider than profile %d (%s, %dpx) - should be descending",
				i, profiles[i].Name, profiles[i].Width,
				i-1, profiles[i-1].Name, profiles[i-1].Width)
		}
	}
}

func TestResolveProfiles_AspectRatioPreservation(t *testing.T) {
	// Ultra-wide source: 1920x800 (cinema 2.4:1 aspect ratio)
	// 1080p profile should be included (width 1920 <= 1920) but
	// height should be adjusted to 800 (preserving aspect ratio)
	profiles := ResolveProfiles(nil, 1920, 800)

	names := profileNames(profiles)
	assertProfilePresent(t, names, "1080p")

	for _, p := range profiles {
		if p.Name == "1080p" {
			if p.Height != 800 {
				t.Errorf("1080p profile height = %d, want 800 (preserving 2.4:1 aspect ratio)", p.Height)
			}
		}
		if p.Name == "720p" {
			// 1280 * 800 / 1920 = 533.33 → 532 (even)
			if p.Height != 532 {
				t.Errorf("720p profile height = %d, want 532 (preserving 2.4:1 aspect ratio)", p.Height)
			}
		}
	}
}

func TestResolveProfiles_4KSource(t *testing.T) {
	// 4K ultra-wide source: 3840x1600
	profiles := ResolveProfiles(nil, 3840, 1600)

	names := profileNames(profiles)
	assertProfilePresent(t, names, "2160p")
	assertProfilePresent(t, names, "1080p")
	assertProfilePresent(t, names, "720p")

	for _, p := range profiles {
		if p.Name == "2160p" {
			// 3840 * 1600 / 3840 = 1600
			if p.Height != 1600 {
				t.Errorf("2160p profile height = %d, want 1600 (source resolution)", p.Height)
			}
		}
		if p.Name == "1080p" {
			// 1920 * 1600 / 3840 = 800
			if p.Height != 800 {
				t.Errorf("1080p profile height = %d, want 800", p.Height)
			}
		}
	}
}

func TestAdjustProfileHeight(t *testing.T) {
	tests := []struct {
		targetW, sourceW, sourceH int
		want                      int
	}{
		{1920, 1920, 1080, 1080}, // 16:9 → 16:9
		{1280, 1920, 1080, 720},  // 16:9 → 720p
		{1920, 3840, 1600, 800},  // 2.4:1 ultrawide
		{1280, 3840, 1600, 532},  // 2.4:1 → 720p width (532 = even)
		{854, 3840, 1600, 354},   // 2.4:1 → 480p width (354 = even)
		{1920, 1440, 1080, 1440}, // 4:3 source
		{1280, 1440, 1080, 960},  // 4:3 → 720p width
		{640, 0, 0, 360},         // zero source → fallback 16:9
	}
	for _, tt := range tests {
		got := AdjustProfileHeight(tt.targetW, tt.sourceW, tt.sourceH)
		if got != tt.want {
			t.Errorf("AdjustProfileHeight(%d, %d, %d) = %d, want %d",
				tt.targetW, tt.sourceW, tt.sourceH, got, tt.want)
		}
	}
}

func TestResolveProfiles_UnknownProfileName(t *testing.T) {
	// An unknown profile name in enabled list should be silently skipped
	profiles := ResolveProfiles([]string{"1080p", "unknown_profile", "720p"}, 1920, 1080)

	names := profileNames(profiles)
	assertProfilePresent(t, names, "1080p")
	assertProfilePresent(t, names, "720p")
}

func TestAllProfiles_Consistency(t *testing.T) {
	for _, name := range ProfileOrder {
		p, ok := AllProfiles[name]
		if !ok {
			t.Errorf("ProfileOrder contains %q but AllProfiles does not", name)
			continue
		}
		if p.Name != name {
			t.Errorf("AllProfiles[%q].Name = %q, should match key", name, p.Name)
		}
		if p.Width <= 0 || p.Height <= 0 {
			t.Errorf("profile %q has invalid dimensions: %dx%d", name, p.Width, p.Height)
		}
		if p.HLSBandwidth <= 0 {
			t.Errorf("profile %q has invalid HLSBandwidth: %d", name, p.HLSBandwidth)
		}
	}
}

func TestGenerateMasterPlaylist(t *testing.T) {
	profiles := []QualityProfile{
		{Name: "1080p", Width: 1920, Height: 1080, HLSBandwidth: 5500000},
		{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000},
	}

	playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/session123", "")

	if !strings.HasPrefix(playlist, "#EXTM3U") {
		t.Error("playlist should start with #EXTM3U")
	}
	if !strings.Contains(playlist, "BANDWIDTH=5500000") {
		t.Error("playlist should contain 1080p bandwidth")
	}
	if !strings.Contains(playlist, "BANDWIDTH=3200000") {
		t.Error("playlist should contain 720p bandwidth")
	}
	if !strings.Contains(playlist, "RESOLUTION=1920x1080") {
		t.Error("playlist should contain 1080p resolution")
	}
	if !strings.Contains(playlist, "RESOLUTION=1280x720") {
		t.Error("playlist should contain 720p resolution")
	}
	if !strings.Contains(playlist, "/api/stream/hls/session123/1080p/stream.m3u8") {
		t.Error("playlist should contain 1080p variant URL")
	}
	if !strings.Contains(playlist, "/api/stream/hls/session123/720p/stream.m3u8") {
		t.Error("playlist should contain 720p variant URL")
	}

	// Test with query token
	playlistWithToken := GenerateMasterPlaylist(profiles, "/api/stream/hls/session123", "mytoken123")
	if !strings.Contains(playlistWithToken, "/api/stream/hls/session123/1080p/stream.m3u8?token=mytoken123") {
		t.Error("playlist with token should contain token in 1080p variant URL")
	}
	if !strings.Contains(playlistWithToken, "/api/stream/hls/session123/720p/stream.m3u8?token=mytoken123") {
		t.Error("playlist with token should contain token in 720p variant URL")
	}
}

func TestGenerateMasterPlaylist_Empty(t *testing.T) {
	playlist := GenerateMasterPlaylist(nil, "/api/stream/hls/session123", "")

	if !strings.HasPrefix(playlist, "#EXTM3U") {
		t.Error("empty playlist should still start with #EXTM3U")
	}
	// Should just be the header line
	if strings.Contains(playlist, "EXT-X-STREAM-INF") {
		t.Error("empty profiles should produce no stream-inf entries")
	}
}

// --- Test Helpers ---

func profileNames(profiles []QualityProfile) []string {
	names := make([]string, len(profiles))
	for i, p := range profiles {
		names[i] = p.Name
	}
	return names
}

func assertProfilePresent(t *testing.T, names []string, name string) {
	t.Helper()
	for _, n := range names {
		if n == name {
			return
		}
	}
	t.Errorf("expected profile %q in %v", name, names)
}

func assertProfileAbsent(t *testing.T, names []string, name string) {
	t.Helper()
	for _, n := range names {
		if n == name {
			t.Errorf("profile %q should not be in %v", name, names)
			return
		}
	}
}
