# Moving Aurora's media to a new path

You moved your media from one directory to another — a bigger disk, a new
mount, a reorganised home directory. This is how to tell Aurora, without
losing everything it has learned about what you watch.

**The short version: repoint the existing library. Do not delete it and add a
new one at the new path.** The two look equivalent in the admin UI and are
not.

## Why it matters

Aurora's catalog rows (`media_items`) are scoped to a library and keyed on
`(library_id, type, title, year)`. Almost everything personal hangs off
`media_item_id` with `ON DELETE CASCADE`:

| Table | What you lose |
| --- | --- |
| `watch_progress` | resume positions, Continue Watching, "already seen" |
| `user_ratings` | your ratings |
| `item_feedback` | thumbs up/down that steer recommendations |
| `taste_seeds` | onboarding picks |
| `collection_items` | your collections |
| `media_items.embedding` | the semantic vector, so search and Discover |
| `recently_surfaced_items`, `recommendation_impressions` | the "don't show me this again" memory |

A **new** library gets new `media_items` rows with new ids, and every one of
those references stays pointed at the old ones. The films are all still
there, but the server has never seen you watch any of them — which is why
recommendations go cold and you have to start watching things again to get
AI content back.

**Repointing** changes `libraries.paths` and leaves the ids alone. The rescan
upserts onto the *same* rows, and none of the tables above notice anything
happened.

## Doing it

### In the admin UI (Aurora 2026.09 and later)

1. **Admin → Libraries**, press **Edit** on the library.
2. Replace the path with the new one. Comma-separate multiple roots.
3. **Save.** Aurora re-attaches its file watcher and starts a rescan.

Repeat per library. If you have already created duplicate libraries at the
new paths, delete those **first** — see the ordering note below.

### By hand, on a server that cannot update yet

The Edit button ships in the release that also fixes the frontend build, so
on a box stuck on an older binary, do it in SQL. The scanner reads
`libraries.paths` from the database on every scan, so this needs no code:

```sql
-- What you have now.
SELECT id, name, type, paths FROM libraries ORDER BY id;
```

```sql
-- Repoint. One statement per library; paths is a TEXT[].
UPDATE libraries SET paths = ARRAY['/srv/storage/media/movies'],    updated_at = NOW() WHERE id = 1;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/4kmovies'],  updated_at = NOW() WHERE id = 2;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/tvshows'],   updated_at = NOW() WHERE id = 3;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/4ktvshows'], updated_at = NOW() WHERE id = 4;
```

Then restart so the file watcher attaches to the new directories:

```bash
sudo systemctl restart aurora
```

> **Check the service can read the new location first.** Aurora runs as the
> unprivileged `aurora` user, and home directories are 0700/0750 on modern
> distros — a path you can plainly see in your own shell is often unreadable
> to the service. `sudo -u aurora ls /srv/storage/media/movies` is the test.
> If it fails: `sudo setfacl -m u:aurora:x` on each parent directory, then
> `sudo setfacl -R -m u:aurora:rX` on the media root.

## Ordering: delete the duplicates first

If you already created new libraries at the new paths, **delete those before
repointing the originals.** `media_files.path` and `episode_files.path` are
globally `UNIQUE`, so while the duplicate library owns a row for
`/srv/storage/media/movies/Some Film (2011)/Some Film (2011).mkv`, the
original library cannot take it: the insert hits `ON CONFLICT (path)`, and on
the movie path that conflict clause does not re-parent `media_item_id`. The
file silently stays attached to the duplicate's catalog entry and the
repointed library ends up owning nothing.

```sql
-- The duplicates, if you made any. CHECK THIS LIST before deleting.
SELECT id, name, paths FROM libraries WHERE id IN (5, 6, 7, 8);
```

Deleting them through the admin UI (or `DELETE FROM libraries WHERE id IN
(...)`) is safe *provided* they are the recent duplicates: their
`media_items` are new, so cascading them away costs nothing you had before
the move.

### Keeping what you watched in the meantime

If people watched things through the duplicate libraries before you noticed,
that progress is on the duplicate rows and will go with them. To carry it
back to the originals first, match on TMDB id:

```sql
-- Dry run: what would move, and onto what.
SELECT wp.id, dup.title, dup.id AS from_item, orig.id AS to_item
  FROM watch_progress wp
  JOIN media_items dup  ON dup.id = wp.media_item_id
  JOIN media_items orig ON orig.tmdb_id = dup.tmdb_id
                       AND orig.type    = dup.type
 WHERE dup.library_id  IN (5, 6, 7, 8)
   AND orig.library_id NOT IN (5, 6, 7, 8)
   AND dup.tmdb_id IS NOT NULL;
```

Only re-point rows that do not collide with progress the original already
has. Since migration 029 the key is **per profile** —
`idx_watch_progress_user_profile_media` on
`(user_id, profile_id, media_item_id) WHERE episode_id IS NULL` — so the
`NOT EXISTS` must match on the profile too, or the UPDATE aborts on the first
account whose default profile already has that film:

```sql
UPDATE watch_progress wp
   SET media_item_id = orig.id
  FROM media_items dup
  JOIN media_items orig ON orig.tmdb_id = dup.tmdb_id
                       AND orig.type    = dup.type
 WHERE wp.media_item_id = dup.id
   AND dup.library_id  IN (5, 6, 7, 8)
   AND orig.library_id NOT IN (5, 6, 7, 8)
   AND dup.tmdb_id IS NOT NULL
   AND wp.episode_id IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM watch_progress w2
          WHERE w2.user_id       = wp.user_id
            AND w2.profile_id    = wp.profile_id
            AND w2.media_item_id = orig.id
            AND w2.episode_id IS NULL);
```

If several duplicate libraries share a TMDB id (a film in both "Movies" and
"4K Movies"), `orig` matches more than one row and Postgres picks one
arbitrarily. Add `AND orig.library_id = <the one you want>` when that
matters, or run the dry-run query first and check for duplicate `to_item`
values.

Episode-level progress keys on `episode_id`, not `media_item_id`, so it needs
the equivalent join through `tv_episodes` (season number + episode number).
For a few hours of viewing it is usually not worth it — re-watch position on
one or two episodes against the risk of a hand-written UPDATE.

**Back up first**: `pg_dump aurora > aurora-before-move.sql`. Aurora also has
Admin → Server → Download database snapshot.

## The hazard of leaving old roots in place

If the old directories still exist and are **empty**, Aurora is currently
holding your catalog by one guard: `pruneDeletedFiles` refuses to prune when
a walk discovers zero files (the NFS/SMB "mountpoint present but empty"
case), and the empty-item sweep requires `len(allFiles) > 0`. Both no-op, so
nothing is deleted.

That protection ends the moment **one** video file appears under an old root.
A stray download, an incomplete rsync, a test file — the walk is then
non-empty, every one of that library's file rows is missing from it, and the
prune plus the sweep delete the library's whole catalog and cascade the watch
history with it. Unattended, on the next scan.

So after repointing, either remove the old empty directories, or confirm they
are what the libraries now point *away* from. If a root is genuinely
unreachable (unmounted, deleted), the walk *errors*, which trips a different
guard (`walkFailed`) and also skips the prune — that state is safe, just
noisy in the log.

## What the first rescan does

The scan after a repoint deliberately **skips** the deleted-file prune and
the empty-item sweep for that library, and says so in the log:

```
skipping prune: library paths just changed — the existing file rows describe
the previous location and will be pruned on the next scan
```

That is not a bug. The prune runs *before* the scan attaches the files it
just found, so on the first pass every row still describes the old location:
pruning there would empty each media item moments before the same title was
re-created from the new path, and the sweep would cascade away exactly the
history this whole procedure exists to keep. The stale rows are pruned on the
next scan, once the new files are attached to those same items — normally
within the periodic scan interval.

## What is not preserved

- **Cached transcode segments and subtitle extractions** keyed by the old
  path (`/var/cache/aurora`). They regenerate on demand.
- **Anything the rescan cannot re-match to the same title.** The upsert keys
  on `(library_id, type, title, year)`, which is derived from the filename
  and any `.nfo` beside it. If the move also *renamed* files such that Aurora
  parses a different title or year, that title gets a new row and its history
  stays behind — the same outcome as a new library, for that one title.
  Moving files without renaming them is what makes this safe.
- **Episode-level history when a show's episode numbering is parsed
  differently** after the move, for the same reason.

## Related

- `internal/api/media_handlers.go` — `validateLibraryPaths`, `Update`
- `internal/library/scanner.go` — `NoteRepointed`, `pruneDeletedFiles`,
  and the `DeleteEmptyMediaItems` sweep
- `docs/server-testing.md` — verifying against the running instance
