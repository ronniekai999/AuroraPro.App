package api

import (
	"fmt"
	"image"

	qrcode "github.com/skip2/go-qrcode"
)

// renderJoinQR encodes the companion-join URL as a borderless alpha mask
// sized to `size` pixels square. The caller paints a colour through it —
// the card wants white modules on the transparent join-bar panel, which
// is what the render spec asks for.
//
// Medium recovery matches party_qr.go: the payload is a short join URL so
// the symbol stays low-version and scannable from a phone screenshot.
// DisableBorder drops go-qrcode's quiet zone; the join bar's own padding
// supplies more margin than the 4-module minimum.
//
// The URL handed in here has already had its authority validated by
// isSafeRequestHost — the Host header is attacker-controlled and the same
// header-injection defence that guards /qr.png applies verbatim.
func renderJoinQR(joinURL string, size int) (*image.Alpha, error) {
	if size <= 0 {
		return nil, fmt.Errorf("qr size must be positive")
	}
	q, err := qrcode.New(joinURL, qrcode.Medium)
	if err != nil {
		return nil, fmt.Errorf("encode join qr: %w", err)
	}
	q.DisableBorder = true
	bmp := q.Bitmap()
	n := len(bmp)
	if n == 0 {
		return nil, fmt.Errorf("qr bitmap empty")
	}

	// Nearest-neighbour module sampling. The module grid rarely divides
	// the target size evenly; sampling per-pixel keeps every module a
	// crisp rectangle instead of smearing edges the way a resample would,
	// which is what a camera needs.
	mask := image.NewAlpha(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		my := y * n / size
		row := bmp[my]
		out := mask.Pix[y*mask.Stride:]
		for x := 0; x < size; x++ {
			mx := x * n / size
			if mx < len(row) && row[mx] {
				out[x] = 0xFF
			}
		}
	}
	return mask, nil
}
