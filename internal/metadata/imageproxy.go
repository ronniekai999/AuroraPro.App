package metadata

import (
	"crypto/sha256"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// allowedImageHosts is a domain allowlist for external image proxying.
// Only these hosts are permitted to prevent SSRF via the image proxy.
var allowedImageHosts = map[string]bool{
	"image.tmdb.org":          true,
	"artworks.thetvdb.com":    true,
	"www.thetvdb.com":         true,
	"thetvdb.com":             true,
}

// ImageProxy serves TMDB images through Aurora and caches them locally.
type ImageProxy struct {
	cacheDir   string
	httpClient *http.Client

	// In-flight dedup: prevents multiple concurrent fetches of the same image
	mu       sync.Mutex
	inflight map[string]chan struct{}
}

// NewImageProxy creates an image proxy with a local cache directory.
func NewImageProxy(cacheDir string) (*ImageProxy, error) {
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return nil, fmt.Errorf("create image cache dir: %w", err)
	}
	return &ImageProxy{
		cacheDir: cacheDir,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			// SSRF prevention: validate that redirects don't escape the
			// allowedImageHosts domain list.  Without this, an allowed host
			// could 302 to an internal IP (e.g. 169.254.169.254).
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 10 {
					return fmt.Errorf("too many redirects")
				}
				host := strings.ToLower(req.URL.Hostname())
				if !allowedImageHosts[host] {
					return fmt.Errorf("redirect to disallowed host: %s", host)
				}
				return nil
			},
		},
		inflight: make(map[string]chan struct{}),
	}, nil
}

// ServeImage handles an image proxy request.
// Expected URL pattern: /api/images/{size}/{path}
//
// Two modes:
//   - TMDB relative path (e.g. "abc123.jpg") — proxied via https://image.tmdb.org/t/p/{size}/{path}
//   - Full external URL (e.g. "https://artworks.thetvdb.com/...") — proxied directly
//     (size parameter is ignored since external URLs are already full-resolution).
//     Only allowed hosts in allowedImageHosts are permitted (SSRF prevention).
//
// Supports optional ?w=<width> query param for on-demand server-side resize.
func (ip *ImageProxy) ServeImage(w http.ResponseWriter, r *http.Request, size, imgPath string) {
	// Validate size
	validSizes := map[string]bool{
		"w92": true, "w154": true, "w185": true, "w342": true, "w500": true, "w780": true,
		"w1280": true, "w300": true, "original": true,
	}
	if !validSizes[size] {
		http.Error(w, "invalid size", http.StatusBadRequest)
		return
	}

	// Determine if this is an external URL or a TMDB relative path
	if isExternalURL(imgPath) {
		ip.serveExternalImage(w, r, imgPath)
		return
	}

	// TMDB relative path — validate against path traversal
	if strings.Contains(imgPath, "..") || strings.Contains(imgPath, "/") || strings.Contains(imgPath, "\\") {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	// Check local cache first
	localPath := ip.localPath(size, imgPath)
	if _, err := os.Stat(localPath); os.IsNotExist(err) {
		// Fetch from TMDB, deduplicating concurrent requests
		if err := ip.fetchAndCache(size, imgPath); err != nil {
			slog.Warn("image proxy fetch failed", "size", size, "path", imgPath, "error", err)
			http.Error(w, "image not available", http.StatusBadGateway)
			return
		}
	}

	ip.serveWithResize(w, r, localPath)
}

// serveExternalImage handles proxying of full external URLs (e.g. TVDB artwork).
func (ip *ImageProxy) serveExternalImage(w http.ResponseWriter, r *http.Request, rawURL string) {
	// SSRF prevention: only allow known image hosts
	if err := validateExternalHost(rawURL); err != nil {
		slog.Warn("image proxy blocked disallowed host", "url", rawURL, "error", err)
		http.Error(w, "image host not allowed", http.StatusForbidden)
		return
	}

	// Use the full URL as the cache key (size is irrelevant for external URLs)
	localPath := ip.localPath("external", rawURL)
	if _, err := os.Stat(localPath); os.IsNotExist(err) {
		if err := ip.fetchAndCacheURL(rawURL); err != nil {
			slog.Warn("external image proxy fetch failed", "url", rawURL, "error", err)
			http.Error(w, "image not available", http.StatusBadGateway)
			return
		}
	}

	ip.serveWithResize(w, r, localPath)
}

// serveWithResize serves a cached image, applying optional ?w= resize.
func (ip *ImageProxy) serveWithResize(w http.ResponseWriter, r *http.Request, localPath string) {
	// On-demand resize: ?w=<width>
	if wStr := r.URL.Query().Get("w"); wStr != "" {
		targetWidth := 0
		if n, err := strconv.Atoi(wStr); err == nil && n > 0 && n <= 3840 {
			targetWidth = n
		}
		if targetWidth > 0 {
			resizedPath := ip.resizedPath(localPath, targetWidth)
			if _, err := os.Stat(resizedPath); os.IsNotExist(err) {
				if err := ResizeImage(localPath, resizedPath, targetWidth); err != nil {
					slog.Debug("resize failed, serving original", "error", err)
					ip.serveFromDisk(w, r, localPath)
					return
				}
			}
			ip.serveFromDisk(w, r, resizedPath)
			return
		}
	}

	ip.serveFromDisk(w, r, localPath)
}

// isExternalURL returns true if the path looks like a full http(s) URL.
func isExternalURL(path string) bool {
	return strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://")
}

// resizedPath returns a cache path for a resized variant.
func (ip *ImageProxy) resizedPath(originalPath string, width int) string {
	ext := filepath.Ext(originalPath)
	base := strings.TrimSuffix(originalPath, ext)
	return fmt.Sprintf("%s_%dw.jpg", base, width)
}

// GetBlurhash returns the blurhash for a cached image.
// If the image isn't cached or can't be processed, returns "".
// Handles both TMDB relative paths and full external URLs.
func (ip *ImageProxy) GetBlurhash(size, remotePath string) string {
	if isExternalURL(remotePath) {
		if err := validateExternalHost(remotePath); err != nil {
			return ""
		}
		localPath := ip.localPath("external", remotePath)
		if _, err := os.Stat(localPath); os.IsNotExist(err) {
			if err := ip.fetchAndCacheURL(remotePath); err != nil {
				return ""
			}
		}
		return GenerateBlurhash(localPath)
	}

	localPath := ip.localPath(size, remotePath)
	if _, err := os.Stat(localPath); os.IsNotExist(err) {
		// Try to fetch it first
		if err := ip.fetchAndCache(size, remotePath); err != nil {
			return ""
		}
	}
	return GenerateBlurhash(localPath)
}

func (ip *ImageProxy) localPath(size, tmdbPath string) string {
	// Hash the path to create a flat cache directory
	h := sha256.Sum256([]byte(size + "/" + tmdbPath))
	ext := filepath.Ext(tmdbPath)
	// filepath.Ext doesn't understand query strings — "file.jpg?v=2" yields
	// ".jpg?v=2".  Strip anything after the first '?' to get a clean extension.
	if i := strings.IndexByte(ext, '?'); i >= 0 {
		ext = ext[:i]
	}
	if ext == "" {
		ext = ".jpg"
	}
	return filepath.Join(ip.cacheDir, fmt.Sprintf("%x%s", h[:12], ext))
}

func (ip *ImageProxy) fetchAndCache(size, tmdbPath string) error {
	key := size + "/" + tmdbPath

	// Dedup concurrent requests for the same image
	ip.mu.Lock()
	if ch, ok := ip.inflight[key]; ok {
		ip.mu.Unlock()
		<-ch // Wait for the in-flight fetch to complete
		// The primary fetch may have failed — verify the file actually exists
		// before claiming success. Without this check, waiters return nil and
		// the caller tries serveFromDisk on a non-existent file (bare 404).
		localPath := ip.localPath(size, tmdbPath)
		if _, err := os.Stat(localPath); err != nil {
			return fmt.Errorf("image fetch by another request failed for %s/%s", size, tmdbPath)
		}
		return nil
	}
	ch := make(chan struct{})
	ip.inflight[key] = ch
	ip.mu.Unlock()

	defer func() {
		ip.mu.Lock()
		delete(ip.inflight, key)
		ip.mu.Unlock()
		close(ch)
	}()

	remoteURL := fmt.Sprintf("%s/%s/%s", tmdbImageURL, size, tmdbPath)
	return ip.downloadToCache(remoteURL, ip.localPath(size, tmdbPath))
}

// fetchAndCacheURL fetches a full external URL and caches the response locally.
// Used for TVDB and other external image sources that provide complete URLs.
func (ip *ImageProxy) fetchAndCacheURL(rawURL string) error {
	key := "url:" + rawURL

	// Dedup concurrent requests for the same image
	ip.mu.Lock()
	if ch, ok := ip.inflight[key]; ok {
		ip.mu.Unlock()
		<-ch
		localPath := ip.localPath("external", rawURL)
		if _, err := os.Stat(localPath); err != nil {
			return fmt.Errorf("image fetch by another request failed for %s", rawURL)
		}
		return nil
	}
	ch := make(chan struct{})
	ip.inflight[key] = ch
	ip.mu.Unlock()

	defer func() {
		ip.mu.Lock()
		delete(ip.inflight, key)
		ip.mu.Unlock()
		close(ch)
	}()

	return ip.downloadToCache(rawURL, ip.localPath("external", rawURL))
}

// downloadToCache fetches remoteURL and writes the response body to localPath atomically.
func (ip *ImageProxy) downloadToCache(remoteURL, localPath string) error {
	resp, err := ip.httpClient.Get(remoteURL)
	if err != nil {
		return fmt.Errorf("fetch %s: %w", remoteURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upstream returned %d for %s", resp.StatusCode, remoteURL)
	}

	dir := filepath.Dir(localPath)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}

	// Write to temp file then rename (atomic)
	tmp, err := os.CreateTemp(dir, "img-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	// Cap download to 50MB. Use the "read one extra byte" pattern so we can
	// detect when the upstream actually exceeded the cap (in which case the
	// JPEG/PNG bytes are TRUNCATED and the file is corrupt). io.LimitReader
	// alone returns no error on cap-hit — it silently EOFs, and we used to
	// promote the truncated file into the cache, where it would serve as a
	// permanently-broken image until manually purged.
	const cap = 50 << 20
	limited := io.LimitReader(resp.Body, cap+1)
	written, err := io.Copy(tmp, limited)
	tmp.Close()
	if err != nil {
		os.Remove(tmpPath)
		return err
	}
	if written > cap {
		os.Remove(tmpPath)
		return fmt.Errorf("image %s exceeds %d-byte cap; not cached", remoteURL, cap)
	}

	if err := os.Rename(tmpPath, localPath); err != nil {
		os.Remove(tmpPath)
		return err
	}

	return nil
}

func (ip *ImageProxy) serveFromDisk(w http.ResponseWriter, r *http.Request, localPath string) {
	ext := strings.ToLower(filepath.Ext(localPath))
	switch ext {
	case ".jpg", ".jpeg":
		w.Header().Set("Content-Type", "image/jpeg")
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".webp":
		w.Header().Set("Content-Type", "image/webp")
	default:
		w.Header().Set("Content-Type", "image/jpeg")
	}

	w.Header().Set("Cache-Control", "public, max-age=604800") // 7 days
	http.ServeFile(w, r, localPath)
}

// validateExternalHost checks that a full URL points to an allowed image host.
// Returns an error if the URL is malformed, uses a non-http(s) scheme, or
// targets a host not in allowedImageHosts.
func validateExternalHost(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("invalid image URL scheme")
	}
	host := strings.ToLower(parsed.Hostname())
	if !allowedImageHosts[host] {
		return fmt.Errorf("image host not allowed: %s", host)
	}
	return nil
}

// FetchAndCache eagerly fetches a remote image and caches it locally.
// Returns nil on success, non-nil on failure. Suitable for fire-and-forget eager caching.
// Handles both TMDB relative paths (e.g. "/abc123.jpg") and full external URLs
// (e.g. "https://artworks.thetvdb.com/banners/posters/266072-1.jpg").
func (ip *ImageProxy) FetchAndCache(size, remotePath string) error {
	if remotePath == "" {
		return nil
	}
	// Full external URL — validate domain, then fetch directly (size is irrelevant)
	if isExternalURL(remotePath) {
		if err := validateExternalHost(remotePath); err != nil {
			return err
		}
		return ip.fetchAndCacheURL(remotePath)
	}
	// Strip leading slash if present (TMDB paths like "/abc123.jpg")
	path := strings.TrimPrefix(remotePath, "/")
	return ip.fetchAndCache(size, path)
}

// CacheSize returns the total size of the image cache in bytes.
func (ip *ImageProxy) CacheSize() (int64, int, error) {
	var totalSize int64
	var count int

	err := filepath.Walk(ip.cacheDir, func(_ string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		totalSize += info.Size()
		count++
		return nil
	})

	return totalSize, count, err
}

// PurgeCache removes all cached images.
func (ip *ImageProxy) PurgeCache() error {
	entries, err := os.ReadDir(ip.cacheDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		os.Remove(filepath.Join(ip.cacheDir, e.Name()))
	}
	return nil
}
