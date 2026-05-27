// Package feedback implements the in-app "Report a Bug" submission flow.
// Frontend POSTs a form (title, description, optional attachment) to
// /api/feedback. The handler saves the attachment under the existing
// image-cache directory, then creates a GitHub issue via this client
// embedding a public attachment URL in the issue body. The PAT lives
// in env vars (BUG_REPORT_GITHUB_TOKEN), not the DB.
//
// SSRF defense: the HTTP transport refuses link-local / metadata /
// unspecified IPs the same way internal/llm/client.go does, so a
// compromised env var pointing at an internal endpoint can't be used
// to exfiltrate via the GitHub-issue submitter.
package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// Default GitHub API host. Pulled out as a constant so tests can
// override; production never changes it.
const githubAPIHost = "https://api.github.com"

// Client posts issues to a GitHub repository via the official REST API
// using a Personal Access Token. Created once at server startup.
type Client struct {
	token    string
	repo     string // "owner/repo"
	http     *http.Client
	apiHost  string // overridable for tests; "" → githubAPIHost
}

// CreateIssueRequest is the subset of GitHub's issue body fields the
// feedback handler uses. Labels are always populated server-side
// ("bug", "user-report") so the client only fills user-supplied
// content.
type CreateIssueRequest struct {
	Title  string   `json:"title"`
	Body   string   `json:"body"`
	Labels []string `json:"labels,omitempty"`
}

// CreateIssueResponse captures the fields the frontend needs to show
// the user where their report landed. GitHub returns more — these are
// the ones we actually use.
type CreateIssueResponse struct {
	HTMLURL string `json:"html_url"` // user-facing URL
	Number  int    `json:"number"`   // issue number, e.g. 42
}

// New builds a feedback client. Returns nil + error when token or repo
// are empty (the handler checks for this and returns 503).
func New(token, repo string) (*Client, error) {
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("feedback: github token is empty")
	}
	if !isValidRepo(repo) {
		return nil, fmt.Errorf("feedback: github repo %q is not in 'owner/repo' format", repo)
	}
	return &Client{
		token: token,
		repo:  repo,
		// 30s budget is plenty — GitHub typically responds in <1s. Any
		// longer means the user's browser has likely given up too.
		http: newGuardedHTTPClient(30 * time.Second),
	}, nil
}

// CreateIssue posts a new issue and returns the HTML URL + number.
// Errors are wrapped with context so callers can surface meaningful
// toast messages.
func (c *Client) CreateIssue(ctx context.Context, req CreateIssueRequest) (*CreateIssueResponse, error) {
	if c == nil {
		return nil, errors.New("feedback: client not configured")
	}
	host := c.apiHost
	if host == "" {
		host = githubAPIHost
	}
	url := fmt.Sprintf("%s/repos/%s/issues", host, c.repo)
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("feedback: marshal issue body: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("feedback: build request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.token)
	httpReq.Header.Set("Accept", "application/vnd.github+json")
	httpReq.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", "Aurora-Media-Server/bug-report")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("feedback: github request: %w", err)
	}
	defer resp.Body.Close()

	// Read at most 64KB — successful response is small (~2KB), and
	// even a huge error body shouldn't be allowed to OOM us.
	const maxBody = 64 * 1024
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))

	switch {
	case resp.StatusCode == http.StatusCreated:
		var out CreateIssueResponse
		if err := json.Unmarshal(respBody, &out); err != nil {
			return nil, fmt.Errorf("feedback: parse github response: %w", err)
		}
		if out.HTMLURL == "" || out.Number == 0 {
			return nil, fmt.Errorf("feedback: github response missing html_url or number")
		}
		return &out, nil
	case resp.StatusCode == http.StatusUnauthorized:
		// Bad token — operator misconfiguration.
		return nil, errors.New("feedback: github rejected the configured token (check BUG_REPORT_GITHUB_TOKEN)")
	case resp.StatusCode == http.StatusForbidden:
		// Could be rate-limited OR token scope is wrong. GitHub
		// puts a rate-limit hint in the X-RateLimit-Remaining
		// header for the primary limiter, AND uses Retry-After for
		// the secondary "abuse detection" limiter (which fires well
		// before the 5000/hr primary cap). 2026-05-27 (deep-debug
		// #3) — check both signals so the operator gets an accurate
		// diagnostic instead of being sent on a PAT-scope wild goose
		// chase when the real problem is a request flood.
		if resp.Header.Get("X-RateLimit-Remaining") == "0" ||
			resp.Header.Get("Retry-After") != "" {
			return nil, errors.New("feedback: github API rate limit exceeded — try again later")
		}
		return nil, errors.New("feedback: github rejected the request (token may lack issue-write scope)")
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("feedback: github repo %q not found or token lacks access", c.repo)
	case resp.StatusCode == http.StatusUnprocessableEntity:
		// Validation error — return the upstream message body so
		// admins can debug, but it's still a 5xx-class from the
		// user's perspective (they didn't do anything wrong).
		return nil, fmt.Errorf("feedback: github validation failure: %s", string(respBody))
	default:
		return nil, fmt.Errorf("feedback: github returned %d", resp.StatusCode)
	}
}

// isValidRepo does a cheap sanity check on the "owner/repo" string.
// Catches the typo cases without trying to be a full GitHub-name
// validator (GitHub itself returns 404 on invalid combinations).
//
// 2026-05-27 (deep-debug #15) — explicitly reject `.` and `..` as
// owner or repo parts. Without this, a typo'd config like `../x`
// would build the URL `https://api.github.com/repos/../x/issues`
// which resolves (after path normalization) to a different endpoint
// and surfaces as a confusing "repo \"../x\" not found" error.
// GitHub itself disallows these in repo names.
func isValidRepo(s string) bool {
	parts := strings.Split(s, "/")
	if len(parts) != 2 {
		return false
	}
	if parts[0] == "" || parts[1] == "" {
		return false
	}
	for _, p := range parts {
		// Path-traversal sentinels — would corrupt the GitHub URL.
		if p == "." || p == ".." {
			return false
		}
		// GitHub forbids names that start or end with a dot.
		if strings.HasPrefix(p, ".") || strings.HasSuffix(p, ".") {
			return false
		}
		// owner / repo can contain letters, digits, hyphens,
		// underscores, periods. Reject anything else as a typo.
		for _, r := range p {
			if !((r >= 'a' && r <= 'z') ||
				(r >= 'A' && r <= 'Z') ||
				(r >= '0' && r <= '9') ||
				r == '-' || r == '_' || r == '.') {
				return false
			}
		}
	}
	return true
}

// newGuardedHTTPClient mirrors the SSRF-safe transport from
// internal/llm/client.go. Refuses link-local / metadata / unspecified
// addresses so a compromised BUG_REPORT_GITHUB_TOKEN env var pointing
// at an internal endpoint (e.g. an SSRF gadget posing as api.github.com
// via DNS rebinding) can't be turned into an exfiltration channel.
func newGuardedHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &net.Dialer{
		Timeout:   15 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	resolver := net.DefaultResolver
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("feedback: host %q did not resolve", host)
		}
		for _, resolved := range ips {
			if isBlockedIP(resolved.IP) {
				return nil, fmt.Errorf("feedback: host %q resolves to restricted address %s", host, resolved.IP)
			}
		}
		var lastErr error
		for _, resolved := range ips {
			target := net.JoinHostPort(resolved.IP.String(), port)
			conn, err := dialer.DialContext(ctx, network, target)
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		return nil, lastErr
	}
	return &http.Client{Timeout: timeout, Transport: transport}
}

func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	// 2026-05-27 (deep-debug #1) — normalize IPv4-mapped IPv6
	// (`::ffff:10.0.0.1`) to the bare IPv4 form so the private /
	// loopback predicates evaluate correctly. Without this, an
	// attacker controlling DNS could resolve api.github.com to an
	// IPv4-mapped private address and slip past the checks.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	// IsPrivate covers RFC1918 (10/8, 172.16/12, 192.168/16) and
	// the IPv6 ULA range (fc00::/7) — the things a malicious env
	// var or DNS-rebind could redirect us to in order to exfiltrate
	// the bearer-token PAT to an internal endpoint (Redis admin,
	// Jenkins, Consul KV, etc.). Added 2026-05-27 (deep-debug #1).
	return ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified() ||
		ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.Equal(net.IPv4(169, 254, 169, 254))
}
