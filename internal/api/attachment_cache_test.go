package api

import (
	"strings"
	"testing"
)

// deep-debug H3 — video recordings must not be shared-CDN cacheable; images
// keep the shared policy so GitHub's Camo proxy can render them.
func TestAttachmentCacheControlFor(t *testing.T) {
	hex32 := strings.Repeat("a", 32)

	for _, ext := range []string{".webm", ".mp4"} {
		name := hex32 + ext
		if got := attachmentCacheControlFor(name); got != "private, no-store" {
			t.Errorf("video %q: Cache-Control = %q, want %q", name, got, "private, no-store")
		}
	}

	for _, ext := range []string{".png", ".jpg", ".jpeg", ".webp"} {
		name := hex32 + ext
		if got := attachmentCacheControlFor(name); got != attachmentCacheControl {
			t.Errorf("image %q: Cache-Control = %q, want %q", name, got, attachmentCacheControl)
		}
	}
}
