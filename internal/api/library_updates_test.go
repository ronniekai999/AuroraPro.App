package api

import (
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

func TestLibraryUpdatesClaimOneEventAcrossConcurrentWorkers(t *testing.T) {
	// The scanner reports progress from its worker goroutines. Run with -race.
	u, hub, _ := newTestUpdates(t, false)
	var wg sync.WaitGroup
	for i := 1; i <= 32; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			u.Observe(running(n))
		}(i)
	}
	wg.Wait()
	if got := hub.take(); len(got) != 1 {
		t.Fatalf("32 concurrent reports inside one interval sent %d events, want 1", len(got))
	}
}

// TestLibraryUpdateHasOneSender keeps every library_update going through
// LibraryUpdates. The scan sites each used to build the event inline; a new
// one doing that again would skip the throttle and the mid-scan events.
func TestLibraryUpdateHasOneSender(t *testing.T) {
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this test file")
	}
	root := filepath.Join(filepath.Dir(self), "..", "..")
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
