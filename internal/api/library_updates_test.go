package api

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
)

type recordedEvent struct {
	eventType string
	data      map[string]interface{}
}

type recordingHub struct {
	mu     sync.Mutex
	events []recordedEvent
}

func (h *recordingHub) Broadcast(eventType string, data interface{}) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m, _ := data.(map[string]interface{})
	h.events = append(h.events, recordedEvent{eventType: eventType, data: m})
}

func (h *recordingHub) take() []recordedEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.events
	h.events = nil
	return out
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }
func running(newFiles int) *models.ScanProgress {
	return &models.ScanProgress{Status: models.ScanRunning, NewFiles: newFiles}
}

func newTestUpdates(t *testing.T, retype bool) (*LibraryUpdates, *recordingHub, *fakeClock) {
	t.Helper()
	hub := &recordingHub{}
	clock := &fakeClock{t: time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)}
	lib := &models.Library{ID: 7, Name: "Movies"}
	var u *LibraryUpdates
	if retype {
		u = newRetypeLibraryUpdates(hub, lib)
	} else {
		u = NewLibraryUpdates(hub, lib)
	}
	u.now = clock.now
	return u, hub, clock
}

func assertOneUpdate(t *testing.T, got []recordedEvent, action string, newItems int) {
	t.Helper()
	if len(got) != 1 {
		t.Fatalf("want one library_update (%s, %d), got %d events: %+v", action, newItems, len(got), got)
	}
	ev := got[0]
	if ev.eventType != ws.EventLibraryUpdate {
		t.Fatalf("event type = %q, want %q", ev.eventType, ws.EventLibraryUpdate)
	}
	if ev.data["action"] != action || ev.data["new_items"] != newItems ||
		ev.data["library_id"] != int64(7) || ev.data["library_name"] != "Movies" {
		t.Fatalf("payload = %+v, want action %q, new_items %d, library 7 \"Movies\"", ev.data, action, newItems)
	}
}

func assertNoUpdate(t *testing.T, got []recordedEvent, why string) {
	t.Helper()
	if len(got) != 0 {
		t.Fatalf("%s: want no event, got %+v", why, got)
	}
}

func TestLibraryUpdatesSendTheFirstNewFileAtOnce(t *testing.T) {
	u, hub, _ := newTestUpdates(t, false)
	u.Observe(running(0))
	assertNoUpdate(t, hub.take(), "a scan that has added nothing")
	u.Observe(running(1))
	assertOneUpdate(t, hub.take(), libraryUpdateItemsAdded, 1)
}

func TestLibraryUpdatesHoldMidScanEventsToTheInterval(t *testing.T) {
	u, hub, clock := newTestUpdates(t, false)
	u.Observe(running(2))
	assertOneUpdate(t, hub.take(), libraryUpdateItemsAdded, 2)

	clock.advance(LibraryUpdateInterval - time.Millisecond)
	u.Observe(running(5))
	assertNoUpdate(t, hub.take(), "more files inside the interval")

	clock.advance(time.Millisecond)
	u.Observe(running(6))
	assertOneUpdate(t, hub.take(), libraryUpdateItemsAdded, 6)
}

func TestLibraryUpdatesSendNothingWhenNoFileWasAddedSinceTheLastEvent(t *testing.T) {
	u, hub, clock := newTestUpdates(t, false)
	u.Observe(running(3))
	hub.take()
	clock.advance(10 * LibraryUpdateInterval)
	u.Observe(running(3))
	assertNoUpdate(t, hub.take(), "unchanged files only")
}

func TestLibraryUpdatesDeliverHeldFilesAtTheNextReportAfterTheInterval(t *testing.T) {
	// A file added inside the interval is not dropped: the next progress report
	// once the interval has passed carries it, even if that report adds none.
	u, hub, clock := newTestUpdates(t, false)
	u.Observe(running(1))
	hub.take()
	u.Observe(running(2))
	assertNoUpdate(t, hub.take(), "inside the interval")
	clock.advance(LibraryUpdateInterval)
	u.Observe(running(2))
	assertOneUpdate(t, hub.take(), libraryUpdateItemsAdded, 2)
}

func TestLibraryUpdatesAnnounceACompletedScanInsideTheInterval(t *testing.T) {
	u, hub, _ := newTestUpdates(t, false)
	u.Observe(running(1))
	hub.take()
	u.Observe(&models.ScanProgress{Status: models.ScanComplete, NewFiles: 4})
	assertOneUpdate(t, hub.take(), libraryUpdateScanCompleted, 4)
}

func TestLibraryUpdatesStayQuietForScansThatAddNothingOrFail(t *testing.T) {
	u, hub, _ := newTestUpdates(t, false)
	u.Observe(&models.ScanProgress{Status: models.ScanComplete, NewFiles: 0})
	assertNoUpdate(t, hub.take(), "a completed scan that added nothing")

	u, hub, _ = newTestUpdates(t, false)
	u.Observe(&models.ScanProgress{Status: models.ScanFailed, NewFiles: 3})
	assertNoUpdate(t, hub.take(), "a failed scan")
}

func TestRetypeLibraryUpdatesAnnounceEveryCompletion(t *testing.T) {
	u, hub, _ := newTestUpdates(t, true)
	u.Observe(&models.ScanProgress{Status: models.ScanComplete, NewFiles: 0})
	assertOneUpdate(t, hub.take(), libraryUpdateRetypeCompleted, 0)
}

func TestLibraryUpdatesClaimIsExclusive(t *testing.T) {
	// The scanner reports progress from its worker goroutines. Two reports
	// inside the claim window at once would both read "nothing sent yet" and
	// both send. Hold the first caller inside the window and see whether a
	// second gets in, rather than racing goroutines, which passes without the
	// lock unless the test runs under -race.
	u, hub, _ := newTestUpdates(t, false)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	u.testHookInClaim = func() {
		entered <- struct{}{}
		<-release
	}
	var done sync.WaitGroup
	done.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer done.Done()
			u.Observe(running(1))
		}()
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		close(release)
		done.Wait()
		t.Fatal("no caller reached the claim window")
	}
	overlapped := false
	select {
	case <-entered:
		overlapped = true
	case <-time.After(250 * time.Millisecond):
	}
	close(release)
	done.Wait()
	if overlapped {
		t.Error("two progress reports were inside the claim window at once; the check and the claim must be one critical section")
	}
	if got := hub.take(); len(got) != 1 {
		t.Fatalf("two concurrent reports of one new file sent %d events, want 1", len(got))
	}
}

// TestEveryScanFeedsLibraryUpdates is the other half of the one-sender
// guard: it fails when a scan entry point stops passing its progress to a
// LibraryUpdates (or a new one never did), which would silently end live
// updates for the scans it starts. Every ScanLibrary call outside the scanner
// package must call Observe within its progress callback.
func TestEveryScanFeedsLibraryUpdates(t *testing.T) {
	root := repoRoot(t)
	calls := 0
	var missing []string
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			if strings.HasPrefix(rel, filepath.Join("internal", "library")+string(filepath.Separator)) {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			lines := strings.Split(string(src), "\n")
			for i, line := range lines {
				if !strings.Contains(line, ".ScanLibrary(") {
					continue
				}
				calls++
				end := i + 6
				if end > len(lines) {
					end = len(lines)
				}
				if !strings.Contains(strings.Join(lines[i:end], "\n"), ".Observe(") {
					missing = append(missing, fmt.Sprintf("%s:%d", rel, i+1))
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}
	if calls < 5 {
		t.Fatalf("found %d ScanLibrary calls, want the 5 scan entry points at least; has the call shape changed?", calls)
	}
	if len(missing) > 0 {
		t.Fatalf("ScanLibrary progress not passed to LibraryUpdates.Observe within the callback: %v", missing)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this test file")
	}
	return filepath.Join(filepath.Dir(self), "..", "..")
}

// TestLibraryUpdateHasOneSender keeps every library_update going through
// LibraryUpdates. The scan sites each used to build the event inline; a new
// one doing that again would skip the throttle and the mid-scan events.
func TestLibraryUpdateHasOneSender(t *testing.T) {
	root := repoRoot(t)
	allowed := map[string]bool{
		filepath.Join("internal", "api", "library_updates.go"): true,
		filepath.Join("internal", "websocket", "events.go"):    true,
	}
	var offenders []string
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			if allowed[rel] {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if strings.Contains(string(src), "EventLibraryUpdate") || strings.Contains(string(src), `"library_update"`) {
				offenders = append(offenders, rel)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}
	if len(offenders) > 0 {
		t.Fatalf("library_update sent outside LibraryUpdates (use NewLibraryUpdates(...).Observe): %v", offenders)
	}
}
