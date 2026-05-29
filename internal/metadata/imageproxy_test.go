package metadata

import "testing"

// TestNormalizeResizeWidth verifies the ?w= resize allowlist clamping that
// guards the unauthenticated image proxy against CPU/disk amplification
// (BE-M*). Every output must be either 0 ("no resize") or a member of
// allowedResizeWidths — never an arbitrary client-supplied value.
func TestNormalizeResizeWidth(t *testing.T) {
	cases := []struct {
		name string
		in   int
		want int
	}{
		{"zero -> no resize", 0, 0},
		{"negative -> no resize", -100, 0},
		{"exact smallest", 92, 92},
		{"exact largest", 1280, 1280},
		{"below smallest snaps up to smallest", 1, 92},
		{"between snaps up to next allowed", 200, 300},
		{"just above a tier snaps up", 343, 500},
		{"exact mid tier", 500, 500},
		{"above largest clamps to largest", 4000, 1280},
		{"absurd width clamps to largest", 1 << 20, 1280},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeResizeWidth(tc.in); got != tc.want {
				t.Errorf("normalizeResizeWidth(%d) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

// TestNormalizeResizeWidthAlwaysAllowed is a property check: for any positive
// input the result is always a member of the fixed allowlist, so the number of
// distinct resize operations/cache variants per image is bounded regardless of
// what an attacker supplies.
func TestNormalizeResizeWidthAlwaysAllowed(t *testing.T) {
	allowed := make(map[int]bool, len(allowedResizeWidths))
	for _, w := range allowedResizeWidths {
		allowed[w] = true
	}
	for n := 1; n <= 5000; n++ {
		got := normalizeResizeWidth(n)
		if !allowed[got] {
			t.Fatalf("normalizeResizeWidth(%d) = %d, which is not in allowedResizeWidths %v", n, got, allowedResizeWidths)
		}
	}
}

// TestAllowedResizeWidthsAscending guards the binary assumption in
// normalizeResizeWidth that allowedResizeWidths is sorted ascending; if a
// future edit reorders it, the "smallest >= n" scan would silently break.
func TestAllowedResizeWidthsAscending(t *testing.T) {
	for i := 1; i < len(allowedResizeWidths); i++ {
		if allowedResizeWidths[i] <= allowedResizeWidths[i-1] {
			t.Fatalf("allowedResizeWidths must be strictly ascending; got %v", allowedResizeWidths)
		}
	}
}
