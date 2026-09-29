package metadata

// Pins that EnrichMediaItem records a metadata ATTEMPT, and that the call sits
// inside the `err == nil` gate rather than merely somewhere after one.
//
// Why a source-level test at all: the refresh queue's starvation fix depends
// entirely on something writing last_metadata_attempt in production, and nothing
// else in the suite notices if that write disappears — a review confirmed the
// whole gated block can be deleted with every package still green. There is no
// seam to drive EnrichMediaItem through instead: tmdbBaseURL is a package const
// and Enricher.queries is a concrete *db.Queries, so the provider call cannot be
// faked without refactoring the client, which this change has no business doing.
// The repo already uses this shape for wiring that cannot otherwise be reached
// (TestSPAProbeEmitsNoNativeOnlyCapabilities reads streaming.ts; the `const
// marker` check in internal/api/admin_cast_sessions_test.go).
//
// READ THIS BEFORE TRUSTING IT. This check is a cheap structural smoke test and
// it has now been defeated TWICE by reviews: first as a substring comparison
// (a decoy `if err == nil` beside an ungated call), then as an AST check matching
// the identifier by NAME, which passes for a shadowed `err`
// (`if _, err := "noop", error(nil); err == nil`) because it does no binding or
// type resolution. Resolving properly would mean type-checking the package, and
// x/tools is not a dependency.
//
// The real guarantee is behavioural:
// TestEnrichMediaItemStampsTheAttemptOnlyWhenTheProviderAnswered drives the whole
// function against a fake TMDB and a real database, and kills the shadowed-`err`
// mutation this test still survives. This one is kept only because it needs no
// database, so it holds a floor when TEST_DATABASE_URL is unset. Do not treat a
// pass here as evidence the gate is correct.
//
// It parses the AST rather than searching for substrings. The first version
// compared string offsets — "some `if err == nil {` appears before the call" —
// and a review showed that passes when the gate is a *different* statement and
// the stamp is ungated beside it:
//
//	if err == nil { slog.Debug(...) }               // satisfies the offset check
//	if touchErr := e.queries.TouchMetadataAttempt(...); touchErr != nil { ... }
//
// That is precisely the regression the gate exists to prevent (a provider outage
// recorded as a completed attempt, deferring every item it touched by a whole
// refresh interval), so the test has to know containment, not order.
//
// It proves the call site is gated, not that the gate is semantically right: the
// enrich* helpers' contract — (0, nil) for "the provider has no entry", non-nil
// only for "no answer" — is not pinned by any test and is recorded as a
// verification gap in CLAUDE.md.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// findFunc returns the named method's body from the parsed file.
func findFunc(t *testing.T, file *ast.File, recv, name string) *ast.BlockStmt {
	t.Helper()
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != name || fn.Recv == nil || len(fn.Recv.List) == 0 {
			continue
		}
		star, ok := fn.Recv.List[0].Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		if id, ok := star.X.(*ast.Ident); ok && id.Name == recv {
			return fn.Body
		}
	}
	t.Fatalf("method (*%s).%s not found — this test's target needs updating", recv, name)
	return nil
}

// callsTouchMetadataAttempt reports whether the subtree contains a call to
// TouchMetadataAttempt.
func callsTouchMetadataAttempt(n ast.Node) bool {
	found := false
	ast.Inspect(n, func(node ast.Node) bool {
		if found {
			return false
		}
		sel, ok := node.(*ast.SelectorExpr)
		if ok && sel.Sel.Name == "TouchMetadataAttempt" {
			found = true
			return false
		}
		return true
	})
	return found
}

// isErrIsNilCond reports whether an if-condition is exactly `err == nil`.
func isErrIsNilCond(cond ast.Expr) bool {
	bin, ok := cond.(*ast.BinaryExpr)
	if !ok || bin.Op != token.EQL {
		return false
	}
	lhs, ok := bin.X.(*ast.Ident)
	if !ok || lhs.Name != "err" {
		return false
	}
	rhs, ok := bin.Y.(*ast.Ident)
	return ok && rhs.Name == "nil"
}

func TestEnrichMediaItemRecordsTheAttemptGatedOnSuccess(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "enricher.go", nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("parse enricher.go: %v", err)
	}
	body := findFunc(t, file, "Enricher", "EnrichMediaItem")

	if !callsTouchMetadataAttempt(body) {
		t.Fatal("EnrichMediaItem does not call TouchMetadataAttempt — nothing writes last_metadata_attempt in production, so unmatchable items keep metadata progress NULL for ever and hold the head of GetStaleMetadataItems' NULLS FIRST queue, starving every other item in the catalog")
	}

	// Every call must be INSIDE the body of an `if err == nil` (and not in its
	// else branch). Containment, not ordering.
	var gated, ungated int
	ast.Inspect(body, func(node ast.Node) bool {
		ifStmt, ok := node.(*ast.IfStmt)
		if !ok || !isErrIsNilCond(ifStmt.Cond) {
			return true
		}
		// An init statement is how the known shadowing defeat is spelled
		// (`if _, err := ...; err == nil`), so a gate carrying one does not
		// count. This does not make the check sound — see the note above — it
		// just closes the one variant that has actually been demonstrated.
		if ifStmt.Init != nil {
			return true
		}
		if callsTouchMetadataAttempt(ifStmt.Body) {
			gated++
		}
		if ifStmt.Else != nil && callsTouchMetadataAttempt(ifStmt.Else) {
			ungated++
		}
		return true
	})

	// Count every call in the function, then require all of them to be gated.
	total := 0
	ast.Inspect(body, func(node ast.Node) bool {
		if sel, ok := node.(*ast.SelectorExpr); ok && sel.Sel.Name == "TouchMetadataAttempt" {
			total++
		}
		return true
	})
	if gated == 0 {
		t.Error("the TouchMetadataAttempt call is not inside an `if err == nil` block — a provider outage would be recorded as a completed attempt and defer every item it touched by a whole refresh interval")
	}
	if ungated > 0 {
		t.Error("TouchMetadataAttempt is called from the ELSE branch of `if err == nil`, i.e. exactly when the provider could not be reached")
	}
	if total != gated {
		t.Errorf("%d call(s) to TouchMetadataAttempt but only %d inside an `if err == nil` block — an ungated call records a provider outage as a completed attempt", total, gated)
	}
}
