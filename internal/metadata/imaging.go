package metadata

import (
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"

	blurhash "github.com/buckket/go-blurhash"
	"golang.org/x/image/draw"
	// Register common decoders
	_ "golang.org/x/image/webp"
)

// ResizeImage reads an image from srcPath, scales it to the given width
// (maintaining aspect ratio), and writes the result to dstPath as JPEG.
// If the source image is already narrower than targetWidth, it is copied as-is.
func ResizeImage(srcPath, dstPath string, targetWidth int) error {
	src, err := decodeImageFile(srcPath)
	if err != nil {
		return fmt.Errorf("decode source: %w", err)
	}

	bounds := src.Bounds()
	srcW := bounds.Dx()
	srcH := bounds.Dy()

	// Don't upscale
	if srcW <= targetWidth {
		return copyFile(srcPath, dstPath)
	}

	// Compute target dimensions preserving aspect ratio
	ratio := float64(targetWidth) / float64(srcW)
	targetHeight := int(float64(srcH) * ratio)
	if targetHeight < 1 {
		targetHeight = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)

	// Atomic publish: encode to a temp file in the SAME directory, then rename
	// it into place. Writing straight to dstPath lets a concurrent reader
	// (serveFromDisk -> http.ServeFile) observe a half-written/truncated JPEG.
	// os.Rename within a directory is atomic, so readers see either the old
	// state (absent) or the fully-encoded file — never a partial one.
	// (2026-05-29 audit — BE-M*: truncated/corrupt cache file race.)
	dir := filepath.Dir(dstPath)
	tmp, err := os.CreateTemp(dir, ".resize-*.tmp")
	if err != nil {
		return fmt.Errorf("create output: %w", err)
	}
	tmpPath := tmp.Name()

	if err := jpeg.Encode(tmp, dst, &jpeg.Options{Quality: 85}); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("encode jpeg: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close output: %w", err)
	}
	if err := os.Rename(tmpPath, dstPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("publish output: %w", err)
	}
	return nil
}

// GenerateBlurhash reads an image and computes a blurhash string.
// The image is downscaled to a small size first for performance.
// Returns an empty string on any error (non-critical feature).
func GenerateBlurhash(imagePath string) string {
	src, err := decodeImageFile(imagePath)
	if err != nil {
		return ""
	}

	// Downscale to ~32px wide for fast hashing
	bounds := src.Bounds()
	w := 32
	h := int(float64(bounds.Dy()) * (float64(w) / float64(bounds.Dx())))
	if h < 1 {
		h = 1
	}

	thumb := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.ApproxBiLinear.Scale(thumb, thumb.Bounds(), src, bounds, draw.Over, nil)

	// 4x3 components is a good balance of detail vs string length
	hash, err := blurhash.Encode(4, 3, thumb)
	if err != nil {
		return ""
	}
	return hash
}

// --- helpers ---

func decodeImageFile(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".png":
		return png.Decode(f)
	case ".jpg", ".jpeg":
		return jpeg.Decode(f)
	default:
		// Try generic decoder (handles webp via registered decoder)
		img, _, err := image.Decode(f)
		return img, err
	}
}

// copyFile copies src to dst atomically (temp file in dst's dir + rename).
// Used by ResizeImage's "don't upscale" branch to publish the source into the
// resized-cache path; the atomic rename keeps concurrent readers from seeing a
// partially-copied file (same race fixed in ResizeImage's encode path).
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	dir := filepath.Dir(dst)
	out, err := os.CreateTemp(dir, ".resize-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := out.Name()

	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}
