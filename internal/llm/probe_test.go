package llm

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHasModelTag(t *testing.T) {
	tags := []string{"qwen3:4b-instruct", "qwen3-embedding:0.6b", "embeddinggemma:latest"}
	cases := []struct {
		want string
		ok   bool
	}{
		{"qwen3:4b-instruct", true},     // exact tagged match
		{"qwen3-embedding:0.6b", true},  // exact tagged match
		{"embeddinggemma", true},        // untagged want matches its :latest form
		{"embeddinggemma:latest", true}, // explicit :latest
		{"qwen3-embedding", false},      // untagged want does NOT match a non-latest tag
		{"qwen3:8b", false},             // absent
		{"", false},                     // empty never matches
		{"  qwen3:4b-instruct  ", true}, // trimmed
		{"gpt-oss", false},              // absent entirely
	}
	for _, c := range cases {
		if got := HasModelTag(tags, c.want); got != c.ok {
			t.Errorf("HasModelTag(%q) = %v, want %v", c.want, got, c.ok)
		}
	}
}

func TestListModels(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tags" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		_, _ = io.WriteString(w, `{"models":[{"name":"qwen3:4b-instruct"},{"name":"qwen3-embedding:0.6b"}]}`)
	}))
	defer srv.Close()

	c := NewClient(Config{BaseURL: srv.URL, APIKey: "sk-secret"})

	// sendAuth=false (embed/local rule): the key must NOT ride along.
	names, err := c.ListModels(context.Background(), srv.URL, false)
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	if len(names) != 2 || names[0] != "qwen3:4b-instruct" {
		t.Errorf("names = %v", names)
	}
	if gotAuth != "" {
		t.Errorf("sendAuth=false leaked Authorization header %q", gotAuth)
	}

	// sendAuth=true (chat rule): bearer present.
	if _, err := c.ListModels(context.Background(), srv.URL, true); err != nil {
		t.Fatalf("ListModels(auth): %v", err)
	}
	if gotAuth != "Bearer sk-secret" {
		t.Errorf("sendAuth=true should send bearer, got %q", gotAuth)
	}
}

func TestListModels_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "upstream down")
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL})
	_, err := c.ListModels(context.Background(), srv.URL, false)
	if err == nil {
		t.Fatal("want error on 502")
	}
}
