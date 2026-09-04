package api

import (
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/cors"
)

// receiverAssetPrefixes are the route subtrees whose responses must be
// fetchable cross-origin by Chromecast / AirPlay receivers:
//
//   - "/api/stream/hls/" — master/variant playlists, .ts segments, inline
//     subtitle playlists and segments.
//   - "/api/stream/direct/" — a whole media file served by byte range, which
//     is what a DIRECT-PLAY title casts (issue #503). Before that it was
//     reached only by AirPlay, whose AVPlayer is not a browser sandbox and so
//     never exercised CORS on it; a Chromecast is the first consumer that
//     does, and without this it hits exactly the #181 failure below.
//
// Everything under these is authenticated by an unguessable ?token= in the URL
// (both live in the same RequireStreamAuth group), so they can safely use a
// wildcard, credential-LESS CORS policy. Note this is deliberately narrower
// than "/api/stream/": the sibling cookie-authed endpoints (e.g. POST
// /api/stream/sessions/{id}/cast-token, and the browser's own cookie-authed
// /api/stream/{fileID}/direct) must keep the credentialed allowlist.
var receiverAssetPrefixes = []string{
	"/api/stream/hls/",
	"/api/stream/direct/",
}

// isReceiverAsset reports whether a CLEANED request path is in one of those
// subtrees. See the dispatch below for why the path must already be cleaned.
func isReceiverAsset(cleanedPath string) bool {
	for _, prefix := range receiverAssetPrefixes {
		if strings.HasPrefix(cleanedPath, prefix) {
			return true
		}
	}
	return false
}

// corsMiddleware builds the HTTP CORS policy, dispatched by request path.
//
// Two policies, because a single go-chi/cors handler can't mix them
// (AllowCredentials is one bool, and `*`+credentials is rejected by browsers):
//
//   - Receiver-fetchable stream assets (under receiverAssetPrefixes) get
//     `Access-Control-Allow-Origin: *` WITHOUT credentials. A Cast Default
//     Media Receiver runs in a sandboxed web page on a Google-hosted origin
//     (e.g. https://www.gstatic.com) and fetches fragments via cross-origin
//     XHR; Google's media stack requires CORS for those fragment fetches, so
//     without this the receiver shows the title then drops to idle (issue
//     #181). The wildcard is safe here: these routes carry no cookie-authed
//     data readable cross-origin. A credentialed cross-origin read is
//     unreadable under `*` (the browser blocks it), and a credential-less
//     read without the URL token 401s — so the only way to read the media is
//     to already hold the per-session token, which is by design.
//
//   - Every other route keeps the original credentialed allowlist policy
//     (reflects an allowed Origin, sets Access-Control-Allow-Credentials:true).
//     Unchanged from before, so the cookie-authed JSON API retains the strict
//     same-origin/allowlisted posture from the #154/#168 CORS hardening.
func corsMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	apiCORS := cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Link", "X-Search-Mode"},
		AllowCredentials: true,
		MaxAge:           300,
	})
	// Credential-less wildcard for the token-authed HLS subtree. AllowedHeaders
	// "*" lets byte-range segment preflights through; the exposed headers let a
	// receiver read range/length metadata.
	streamCORS := cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "HEAD", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		ExposedHeaders:   []string{"Content-Length", "Content-Range", "Accept-Ranges"},
		AllowCredentials: false,
		MaxAge:           300,
	})
	return func(next http.Handler) http.Handler {
		apiChain := apiCORS(next)
		streamChain := streamCORS(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Dispatch on the CLEANED path. r.URL.Path is already percent-decoded
			// and is NOT run through CleanPath/RedirectSlashes anywhere in this
			// router (see the note at shouldPromoteToken). Without cleaning, a
			// crafted "/api/stream/hls/../<something>" would pass a raw HasPrefix
			// and hand the credential-less wildcard to whatever route it resolves
			// to. chi 404s such literal-".." paths today, but cleaning first keeps
			// the boundary robust if CleanPath is ever added — the same hardening
			// posture the codebase took for the highlight-reel / token-promotion
			// paths (audit H11).
			if isReceiverAsset(path.Clean(r.URL.Path)) {
				streamChain.ServeHTTP(w, r)
				return
			}
			apiChain.ServeHTTP(w, r)
		})
	}
}
