# Fix 34 (2026-02-24) - TV Show Scanner Race Condition (FK Violations)

## Symptom
During library scans of TV show libraries with 100+ files, concurrent scanner goroutines
produce foreign key violations:
```
ERROR: insert or update on table "tv_seasons" violates foreign key constraint
"tv_seasons_media_item_id_fkey" (SQLSTATE 23503)
```

## Root Cause Chain
1. Goroutine A processes S03E01.mkv: `UpsertMediaItem("Stranger Things", year=nil)` -> INSERT new row, id=178
2. Goroutine A triggers inline enrichment: `UpdateMediaMetadata(178, year=2016, tmdb_id=66732)` -> updates row 178 so year changes from NULL to 2016
3. Goroutine B processes S03E08.mkv: `UpsertMediaItem("Stranger Things", year=nil)` -> ON CONFLICT key is `(lib, show, "Stranger Things", COALESCE(NULL,0)=0)`. But row 178 now has `COALESCE(2016,0)=2016`. NO CONFLICT -> creates new row id=194
4. Goroutine B: `UpsertSeason(194, 3)` -> succeeds (194 still exists)
5. Goroutine B triggers enrichment: same TMDB match -> `UpdateMediaMetadata(194, year=2016)` -> `uq_media_items_lib_type_title_year` collision with row 178 -> `DuplicateMetadataError`
6. `handleDuplicateMetadata` calls `MergeMediaItems(178, 194)` -> reassigns child records -> DELETE row 194
7. Meanwhile, Goroutine C also resolved to id=194 (same race as step 3) and tries `UpsertSeason(194, 3)` AFTER 194 was deleted -> FK VIOLATION

The fundamental issue: **enrichment mutates the ON CONFLICT key (year column) of the media_items row**, breaking the uniqueness guarantee that `UpsertMediaItem` provides to concurrent callers.

## Fix: Per-Show Title Locking
Added `showLocks sync.Map` to Scanner struct. For TV shows, `processFile()` acquires a per-show mutex keyed by `"libraryID:lowertitle"` BEFORE calling `UpsertMediaItem`, and holds it through the entire pipeline: upsert + season + episode + enrichment. This ensures only one goroutine at a time runs the full pipeline for a given show.

The lock is NOT needed for movies because:
- Movies typically have one file per media_item (no concurrent goroutines for the same item)
- Movie enrichment is less likely to change the year in a way that creates ON CONFLICT misses (year is usually parsed correctly from folder name)

Also extracted enrichment into `enrichNewItem()` helper for cleaner code structure. Enrichment now happens INSIDE the TV branch (under the show lock) rather than at the end of processFile outside both branches.

Lock cleanup: After `wg.Wait()`, all locks for the current library are deleted from the sync.Map to prevent unbounded growth.

## Performance Impact
- Shows with many episodes (e.g., 100+ files for "Stranger Things") are now serialized per-show
- Different shows still run in parallel (the lock is per-title, not global)
- For a library with 20 shows averaging 50 episodes each: ~20 parallel show pipelines, each processing 50 files sequentially
- The enrichment callback (TMDB API call) only runs once per show (dedup via enrichedItems), so subsequent episodes under the same show lock are fast (hash check + season/episode upsert only)
- Net impact: negligible for most libraries; worst case is a library with a single show having 1000+ episodes, which would become fully sequential

## Files Changed
- `internal/library/scanner.go`: Added `showLocks sync.Map`, `showLock()` method, per-show locking in `processFile()`, extracted `enrichNewItem()`, lock cleanup after scan

## Fix 34b (2026-02-24) - Lock Alone Is Insufficient

### Discovery
Even with the per-show lock correctly deployed, every episode STILL creates a duplicate media_item row, enriches it, and merges it. This is because:

1. Goroutine A (S01E01): Acquires lock, UpsertMediaItem(year=NULL) -> ID 156. Enriches: sets year=2021. enrichedItems[156]=true.
2. Goroutine B (S01E02): Acquires lock (serialized). UpsertMediaItem(year=NULL) -> unique key (lib,'show','Squid Game',0). Row 156 now has year=2021, key (lib,'show','Squid Game',2021). **NO CONFLICT -> creates ID 170**. enrichedItems[170] is new -> enriches AGAIN. Merges 170 into 156.
3. Repeat for every episode.

The lock prevents FK violations (each goroutine completes its full cycle before the next), but the `enrichedItems` dedup uses `item.ID` which is DIFFERENT for each new row. So every episode creates a new row, enriches, and merges.

### Root Cause
The ON CONFLICT key `(library_id, type, title, COALESCE(year, 0))` changes after enrichment sets the year. Subsequent UpsertMediaItem calls with year=NULL don't conflict with the enriched row.

### Fix: FindMediaItemByTitle
Added `FindMediaItemByTitle(libraryID, type, title)` query to `internal/db/queries.go`. This finds an existing media_item by (library_id, type, title) regardless of year.

In `processFile()`, after acquiring the TV show lock, the scanner calls `FindMediaItemByTitle` first. If an existing row is found:
- Reuses its ID (skips UpsertMediaItem entirely)
- Sets `needsEnrichment = false` (separate from `isNew` which tracks episode file newness)
- Eliminates the create-enrich-merge cycle for every episode

If no existing row found (first episode of a new show), falls through to `UpsertMediaItem` as before.

### Files Changed
- `internal/db/queries.go`: Added `FindMediaItemByTitle()` query
- `internal/library/scanner.go`: Added `needsEnrichment` variable, `FindMediaItemByTitle` check inside TV show lock body, gated enrichment on `needsEnrichment` instead of `isNew`

### Performance Impact
- First episode of a new show: 1 FindMediaItemByTitle (no result) + 1 UpsertMediaItem + 1 enrichment = same as before
- Subsequent episodes: 1 FindMediaItemByTitle (returns existing) + skip UpsertMediaItem + skip enrichment = much faster
- Eliminates N-1 redundant TMDB API calls, N-1 duplicate rows, N-1 merge transactions per N-episode show

## Key Patterns
40. **Enrichment mutating ON CONFLICT keys creates race conditions**: When a concurrent upsert uses `INSERT ... ON CONFLICT (col1, col2) DO UPDATE ... RETURNING id`, the ON CONFLICT guarantee only holds if the key columns don't change between calls. If enrichment mutates a key column (e.g., year), subsequent callers with the original (pre-enrichment) values see no conflict and create duplicates. Fix: serialize all operations on the same logical entity with a per-entity lock, or use a key that enrichment never mutates.
41. **Per-entity lock + year-less lookup is the correct pattern**: The lock prevents concurrent access, but serialized access still creates duplicates when ON CONFLICT keys change. The fix is to first query by immutable fields (title, library, type) regardless of mutable fields (year), and reuse the existing row if found. This is a two-layer defense: lock prevents races, year-less lookup prevents duplicates within serialized access.
