package feedback

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Bug-report attachments — screenshots and up to 30s screen recordings — are
// served unauthenticated from unguessable capability URLs embedded in the
// GitHub issue body. The issue's own access control is therefore the only
// thing protecting them, which is safe exactly as long as the repository is
// private.
//
// The server used to warn about this unconditionally on every boot: advice,
// not a check, fired identically whether the repo was public or private.
// Validate() already fetches GET /repos/{owner}/{repo}, whose payload carries
// `private`, so the real answer is available on a call already being made.
//
// The tri-state matters: "could not determine" must never be reported as
// "fine", because the consequence of a false reassurance here is users'
// screen recordings being publicly fetchable.

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	c, err := New("token", "owner/repo")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	c.apiHost = srv.URL
	c.http = srv.Client()
	return c
}

func TestVisibility_PrivateRepo(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"full_name":"owner/repo","private":true}`))
	})

	if got := c.Visibility(); got != RepoVisibilityUnknown {
		t.Fatalf("before validation Visibility = %v, want unknown", got)
	}
	if err := c.Validate(context.Background()); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := c.Visibility(); got != RepoVisibilityPrivate {
		t.Fatalf("Visibility = %v, want private", got)
	}
}

func TestVisibility_PublicRepo(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"full_name":"owner/repo","private":false}`))
	})

	if err := c.Validate(context.Background()); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := c.Visibility(); got != RepoVisibilityPublic {
		t.Fatalf("Visibility = %v, want public — this is the case that must "+
			"produce a loud error rather than a reassuring silence", got)
	}
}

// A payload missing `private` (API change, proxy rewriting the body) must
// stay Unknown. Defaulting to private would be a silent false reassurance;
// defaulting to public would cry wolf on every healthy install.
func TestVisibility_MissingFieldStaysUnknown(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"full_name":"owner/repo"}`))
	})

	if err := c.Validate(context.Background()); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := c.Visibility(); got != RepoVisibilityUnknown {
		t.Fatalf("Visibility = %v, want unknown for a payload without `private`", got)
	}
}

func TestVisibility_UnparseableBodyStaysUnknown(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`not json at all`))
	})

	if err := c.Validate(context.Background()); err != nil {
		t.Fatalf("Validate should still succeed on 200: %v", err)
	}
	if got := c.Visibility(); got != RepoVisibilityUnknown {
		t.Fatalf("Visibility = %v, want unknown", got)
	}
}

// A failed validation must not overwrite a previously-known good answer with
// a guess, nor invent one.
func TestVisibility_FailedValidationLeavesPriorAnswer(t *testing.T) {
	fail := false
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"private":true}`))
	})

	if err := c.Validate(context.Background()); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := c.Visibility(); got != RepoVisibilityPrivate {
		t.Fatalf("setup failed: Visibility = %v", got)
	}

	fail = true
	if err := c.Validate(context.Background()); err == nil {
		t.Fatal("expected a validation error on 401")
	}
	if got := c.Visibility(); got != RepoVisibilityPrivate {
		t.Fatalf("Visibility = %v — a failed check must not clobber the last known answer", got)
	}
}

// Visibility flipping public→private (or back) must be picked up by the
// periodic re-check, not cached from boot forever.
func TestVisibility_UpdatesOnRecheck(t *testing.T) {
	private := false
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if private {
			_, _ = w.Write([]byte(`{"private":true}`))
		} else {
			_, _ = w.Write([]byte(`{"private":false}`))
		}
	})

	_ = c.Validate(context.Background())
	if got := c.Visibility(); got != RepoVisibilityPublic {
		t.Fatalf("Visibility = %v, want public", got)
	}

	private = true // operator fixes it
	_ = c.Validate(context.Background())
	if got := c.Visibility(); got != RepoVisibilityPrivate {
		t.Fatalf("Visibility = %v, want private after re-check", got)
	}
}

func TestVisibility_NilClientIsUnknown(t *testing.T) {
	var c *Client
	if got := c.Visibility(); got != RepoVisibilityUnknown {
		t.Fatalf("nil client Visibility = %v, want unknown", got)
	}
}

func TestRepoVisibility_String(t *testing.T) {
	for v, want := range map[RepoVisibility]string{
		RepoVisibilityUnknown: "unknown",
		RepoVisibilityPrivate: "private",
		RepoVisibilityPublic:  "public",
	} {
		if got := v.String(); got != want {
			t.Fatalf("String() = %q, want %q", got, want)
		}
	}
}
