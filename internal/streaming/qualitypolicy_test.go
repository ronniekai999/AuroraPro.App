package streaming

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/config"
)

// backends is every encoder family the policy must answer for. Keeping this in
// one place means a newly-added family shows up as a failure in each test below
// rather than silently inheriting the software path.
var policyBackends = []HWAccelType{
	HWAccelNVENC, HWAccelQSV, HWAccelVAAPI, HWAccelAMF, HWAccelNone,
}

// argValue returns the value following flag in an FFmpeg argv, and whether the
// flag was present at all.
func argValue(args []string, flag string) (string, bool) {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

// TestQualityPolicy_BalancedIsByteIdenticalToHistoricalArgs is the compatibility
// invariant the whole knob rests on: an install that upgrades without setting
// transcode.quality_policy must ask FFmpeg for exactly what it asked for before
// the policy existed.
//
// The expected values are the literals that were hardcoded in hwaccel.go and
// hwdecode.go prior to this change — deliberately written out rather than
// derived from the policy, so a future edit to the policy tables cannot quietly
// redefine what "unchanged" means.
func TestQualityPolicy_BalancedIsByteIdenticalToHistoricalArgs(t *testing.T) {
	type expectation struct {
		flag string // the quality flag to inspect
		want string // its historical value
		// absent marks families that historically carried NO quality flag.
		absent bool
	}
	historical := map[HWAccelType]expectation{
		HWAccelNVENC: {flag: "-preset", want: "p4"},
		HWAccelQSV:   {flag: "-preset", want: "faster"},
		HWAccelAMF:   {flag: "-quality", want: "speed"},
		// VAAPI had no quality knob at all. Balanced must keep emitting none:
		// -compression_level semantics are driver-defined and this project has
		// no VAAPI hardware in the loop to validate a chosen value against.
		HWAccelVAAPI: {flag: "-compression_level:v", absent: true},
		HWAccelNone:  {flag: "-preset", want: "veryfast"},
	}

	for _, backend := range policyBackends {
		want := historical[backend]
		t.Run(string(backend), func(t *testing.T) {
			// Explicitly balanced AND the zero value must both hold — the zero
			// value is what every probe and test literal in the tree carries.
			for _, info := range []HWAccelInfo{
				{Type: backend, Policy: PolicyBalanced},
				{Type: backend},
			} {
				for name, args := range map[string][]string{
					"h264":         info.VideoEncoderArgs(1280, 720, 24),
					"hevc":         info.HEVCEncoderArgs(1280, 720, 24),
					"h264_fullgpu": info.FullGPUEncoderArgs(1280, 720, false, 24),
					"hevc_fullgpu": info.FullGPUHEVCEncoderArgs(1280, 720, false, 24),
				} {
					if args == nil {
						continue // family has no Tier-2 path
					}
					got, present := argValue(args, want.flag)
					if want.absent {
						if present {
							t.Errorf("%s policy=%q: %s carries %s=%q; balanced must emit no quality flag",
								backend, info.Policy, name, want.flag, got)
						}
						continue
					}
					if !present {
						t.Errorf("%s policy=%q: %s is missing %s entirely", backend, info.Policy, name, want.flag)
						continue
					}
					if got != want.want {
						t.Errorf("%s policy=%q: %s has %s=%q, want the historical %q",
							backend, info.Policy, name, want.flag, got, want.want)
					}
				}
			}
		})
	}
}

// TestQualityPolicy_EveryBackendHonorsTheKnob is the point of the change: before
// it, software_preset reached two of ten encoder paths and the rest were
// hardcoded. Each non-default policy must move the arguments on every family.
func TestQualityPolicy_EveryBackendHonorsTheKnob(t *testing.T) {
	flagFor := map[HWAccelType]string{
		HWAccelNVENC: "-preset",
		HWAccelQSV:   "-preset",
		HWAccelAMF:   "-quality",
		HWAccelVAAPI: "-compression_level:v",
		HWAccelNone:  "-preset",
	}

	for _, backend := range policyBackends {
		flag := flagFor[backend]
		t.Run(string(backend), func(t *testing.T) {
			balanced := HWAccelInfo{Type: backend, Policy: PolicyBalanced}
			base, _ := argValue(balanced.VideoEncoderArgs(1280, 720, 24), flag)

			var moved int
			for _, p := range []QualityPolicy{PolicyFastStart, PolicyQuality} {
				info := HWAccelInfo{Type: backend, Policy: p}
				got, present := argValue(info.VideoEncoderArgs(1280, 720, 24), flag)
				if !present {
					t.Errorf("policy %q on %s emits no %s at all", p, backend, flag)
					continue
				}
				if got != base {
					moved++
				}
			}
			// AMF is the one family where fast_start legitimately coincides
			// with balanced (its scale is speed|balanced|quality and balanced
			// already resolves to "speed" for compatibility), so require that
			// AT LEAST ONE non-default policy moves rather than both.
			if moved == 0 {
				t.Errorf("%s: neither fast_start nor quality changed %s from the balanced value %q — "+
					"this family is not honoring the policy", backend, flag, base)
			}
		})
	}
}

// TestQualityPolicy_SoftwarePresetOverridesPolicy pins the precedence rule:
// transcode.software_preset predates the policy and is the more specific knob,
// so an operator who set it keeps getting exactly it.
func TestQualityPolicy_SoftwarePresetOverridesPolicy(t *testing.T) {
	for _, p := range []QualityPolicy{PolicyFastStart, PolicyBalanced, PolicyQuality} {
		info := HWAccelInfo{Type: HWAccelNone, Policy: p, SWPreset: "medium"}
		for name, args := range map[string][]string{
			"h264": info.VideoEncoderArgs(1280, 720, 24),
			"hevc": info.HEVCEncoderArgs(1280, 720, 24),
		} {
			if got, _ := argValue(args, "-preset"); got != "medium" {
				t.Errorf("policy %q with software_preset=medium: %s got -preset %q, want medium",
					p, name, got)
			}
		}
	}
}

// TestQualityPolicy_SoftwarePresetsStayRealtimeCapable guards the one way this
// knob could break playback rather than merely tune it. NewTranscodeManager
// validates software_preset against the realtime-capable x264 presets; a policy
// that selected something slower would sail past that validation (it never
// touches SWPreset) and hand FFmpeg an encoder that cannot keep up with
// on-demand transcoding.
func TestQualityPolicy_SoftwarePresetsStayRealtimeCapable(t *testing.T) {
	// The allowlist from NewTranscodeManager, minus the empty default.
	realtime := map[string]bool{
		"ultrafast": true, "superfast": true, "veryfast": true,
		"faster": true, "fast": true, "medium": true,
	}
	for _, p := range []QualityPolicy{PolicyFastStart, PolicyBalanced, PolicyQuality} {
		got := p.softwarePresetFor("")
		if !realtime[got] {
			t.Errorf("policy %q selects x264 preset %q, which is outside the realtime-capable "+
				"set NewTranscodeManager accepts", p, got)
		}
	}
}

func TestParseQualityPolicy(t *testing.T) {
	cases := []struct {
		in     string
		want   QualityPolicy
		wantOK bool
	}{
		{"", PolicyBalanced, true},
		{"balanced", PolicyBalanced, true},
		{"BALANCED", PolicyBalanced, true},
		{"  quality  ", PolicyQuality, true},
		{"fast_start", PolicyFastStart, true},
		{"faststart", PolicyFastStart, true},
		// Unknown values must resolve to balanced AND report not-ok, so the
		// caller can warn. Silently accepting a typo is how a misspelled
		// preset reaches FFmpeg and kills every transcode at encoder init.
		{"turbo", PolicyBalanced, false},
		{"p7", PolicyBalanced, false},
	}
	for _, tc := range cases {
		got, ok := ParseQualityPolicy(tc.in)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("ParseQualityPolicy(%q) = (%q, %t), want (%q, %t)",
				tc.in, got, ok, tc.want, tc.wantOK)
		}
	}
}

// TestQualityPolicy_DescribeNamesTheResolvedKnob checks the admin string carries
// the actual resolved value, not just the policy name — an operator reading
// "quality" learns nothing about what their particular GPU was asked for.
func TestQualityPolicy_DescribeNamesTheResolvedKnob(t *testing.T) {
	cases := []struct {
		backend  HWAccelType
		policy   QualityPolicy
		contains string
	}{
		{HWAccelNVENC, PolicyQuality, "p6"},
		{HWAccelQSV, PolicyFastStart, "veryfast"},
		{HWAccelAMF, PolicyQuality, "quality"},
		{HWAccelVAAPI, PolicyQuality, "compression_level 1"},
		{HWAccelVAAPI, PolicyBalanced, "driver default"},
		{HWAccelNone, PolicyQuality, "fast"},
	}
	for _, tc := range cases {
		got := tc.policy.Describe(tc.backend, "")
		if !strings.Contains(got, tc.contains) {
			t.Errorf("Describe(%s, %s) = %q, want it to mention %q",
				tc.backend, tc.policy, got, tc.contains)
		}
		if !strings.Contains(got, string(tc.policy)) {
			t.Errorf("Describe(%s, %s) = %q, want it to name the policy itself",
				tc.backend, tc.policy, got)
		}
	}
}

// TestQualityPolicy_ReachesSoftwareEncoderThroughRealConfigDefaults is the test
// whose absence let a shipped no-op through.
//
// Every other software-path test in this file hand-builds an HWAccelInfo with
// SWPreset empty, which is not the state a booted server is ever in: config.Load
// used to default transcode.software_preset to a concrete "veryfast", and an
// explicit preset overrides the policy by design. The two behaviours composed
// into "quality_policy does nothing on any GPU-less install" — the most common
// configuration this project targets — while the unit tests stayed green.
//
// This goes through NewTranscodeManager with the DEFAULTS the config package
// actually produces, so the knob is exercised the way an operator experiences it.
func TestQualityPolicy_ReachesSoftwareEncoderThroughRealConfigDefaults(t *testing.T) {
	fakeFFmpegOnPath(t)

	defaults := config.Default().Transcode
	if defaults.SoftwarePreset != "" {
		t.Fatalf("config default software_preset = %q; a concrete default here makes "+
			"quality_policy inert on every software install", defaults.SoftwarePreset)
	}

	cases := map[string]string{
		"balanced":   "veryfast", // must equal the pre-policy default
		"fast_start": "superfast",
		"quality":    "fast",
	}
	for policy, wantPreset := range cases {
		t.Run(policy, func(t *testing.T) {
			cfg := defaults
			cfg.HWAccel = "none"
			cfg.HWDecode = "off"
			cfg.QualityPolicy = policy

			tm, err := NewTranscodeManager(t.TempDir(), cfg)
			if err != nil {
				t.Fatalf("new transcode manager: %v", err)
			}
			t.Cleanup(tm.Close)

			args := tm.hwAccel.VideoEncoderArgs(1280, 720, 24)
			got, ok := argValue(args, "-preset")
			if !ok {
				t.Fatalf("no -preset in software encoder args: %v", args)
			}
			if got != wantPreset {
				t.Errorf("quality_policy=%q resolved to -preset %q, want %q", policy, got, wantPreset)
			}
		})
	}
}

// TestQualityPolicy_ExplicitSoftwarePresetStillWinsThroughConfig pins the
// precedence rule end-to-end: an operator who set software_preset keeps it,
// whatever the policy says.
func TestQualityPolicy_ExplicitSoftwarePresetStillWinsThroughConfig(t *testing.T) {
	fakeFFmpegOnPath(t)

	cfg := config.Default().Transcode
	cfg.HWAccel = "none"
	cfg.HWDecode = "off"
	cfg.SoftwarePreset = "medium"
	cfg.QualityPolicy = "fast_start"

	tm, err := NewTranscodeManager(t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)

	if got, _ := argValue(tm.hwAccel.VideoEncoderArgs(1280, 720, 24), "-preset"); got != "medium" {
		t.Errorf("explicit software_preset=medium with policy fast_start gave -preset %q, want medium", got)
	}
}
