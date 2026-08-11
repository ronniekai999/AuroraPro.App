package main

import "testing"

func TestValidateBoundaries(t *testing.T) {
	for _, tc := range []struct{ days, limit, group int }{{1, 1, 1}, {90, 9999, 5}} {
		if err := validate(tc.days, tc.limit, tc.group); err != nil {
			t.Fatalf("valid values %+v: %v", tc, err)
		}
	}
	for _, tc := range []struct{ days, limit, group int }{{0, 1, 1}, {91, 1, 1}, {1, 0, 1}, {1, 10000, 1}, {1, 1, 0}} {
		if err := validate(tc.days, tc.limit, tc.group); err == nil {
			t.Fatalf("invalid values accepted: %+v", tc)
		}
	}
}
