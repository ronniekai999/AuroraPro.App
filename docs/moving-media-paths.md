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

The Edit button ships in the release that also fixes the frontend build, so on
a box stuck on an older binary you have to do it in SQL.

**Rewrite the file rows, not just the library paths.** Updating
`libraries.paths` alone and letting the rescan rediscover everything is the
obvious move and it is wrong on an older binary: the relocation guard that
makes that safe is part of the same release. Without it, the next scan walks
the new root, finds not one of the library's recorded paths among what it
discovered, prunes every row, and the empty-item sweep then deletes every
`media_items` row in that library — cascading away exactly the history in the
table above, unattended, up to a scan interval later. Rewriting the paths in
place sidesteps the question: the rows and the walk agree, so nothing is
stale, nothing is pruned, and playback works immediately rather than after a
second scan.

Open a shell on the database. The `postgres` superuser connects over the local
socket without a password:

```bash
sudo -u postgres psql aurora
```

(Aurora's own credentials are in `/etc/aurora/aurora.env` as `DATABASE_URL` if
you would rather use those: `psql "$(sudo grep -oP '(?<=^DATABASE_URL=).*' /etc/aurora/aurora.env)"`.)

**Back up first — this is not reversible.**

```bash
sudo -u postgres pg_dump aurora > ~/aurora-before-move.sql
```

Then, in one transaction so a mistake rolls back:

```sql
BEGIN;

-- 1. Look. Confirm which ids are the originals and which are duplicates.
SELECT id, name, type, paths FROM libraries ORDER BY id;

-- 2. Remove the duplicate libraries created at the new paths, if any.
--    Must come first: media_files.path is globally UNIQUE, so while a
--    duplicate owns a row for the new path, the original cannot take it.
DELETE FROM libraries WHERE id IN (5, 6, 7, 8);

-- 3. Move the file rows to where the files actually are.
UPDATE media_files
   SET path = replace(path, '/home/rontavious999/media/', '/srv/storage/media/')
 WHERE path LIKE '/home/rontavious999/media/%';
UPDATE episode_files
   SET path = replace(path, '/home/rontavious999/media/', '/srv/storage/media/')
 WHERE path LIKE '/home/rontavious999/media/%';

-- 4. Repoint the libraries themselves. paths is a TEXT[].
UPDATE libraries SET paths = ARRAY['/srv/storage/media/movies'],    updated_at = NOW() WHERE id = 1;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/4kmovies'],  updated_at = NOW() WHERE id = 2;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/tvshows'],   updated_at = NOW() WHERE id = 3;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/4ktvshows'], updated_at = NOW() WHERE id = 4;

-- 5. Check before committing: this must return 0.
SELECT count(*) FROM media_files   WHERE path LIKE '/home/rontavious999/media/%';
SELECT count(*) FROM episode_files WHERE path LIKE '/home/rontavious999/media/%';

COMMIT;
```

Then restart so the file watcher attaches to the new directories:

```bash
sudo systemctl restart aurora
```

Substitute your own prefixes in steps 3 and 4, and keep them identical between
the two — a `replace()` whose search string does not match simply changes
nothing, which looks like success and leaves every row pointing at the old
location.

> **Check the service can read the new location first.** Aurora runs as the
> unprivileged `aurora` user, and home directories are 0700/0750 on modern
> distros — a path you can plainly see in your own shell is often unreadable
> to the service. `sudo -u aurora ls /srv/storage/media/movies` is the test.
> If it fails: `sudo setfacl -m u:aurora:x` on each parent directory, then
> `sudo setfacl -R -m u:aurora:rX` on the media root.

On a box running this release or later, none of the above is needed — the
relocation guard makes a plain `libraries.paths` update safe too, because the
scanner detects the move from the data (see "What the first rescan does").
The path rewrite is still the better option when you have it, since it leaves
no dead rows at all.

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

Ignoring this ordering is not a cosmetic mistake. With the duplicate still
holding the new paths, the repointed library's first scan attaches nothing
(its inserts hit `ON CONFLICT (path)` and the movie-side clause does not
re-parent `media_item_id`), so its items are left with only their old rows.
On the **next** scan those are pruned as genuinely absent, the items are
empty, and the sweep cascades the whole history away — the total loss this
page exists to prevent, one scan later than it would have happened without
the guard. The TV side is different but no better: `episode_files`' conflict
clause *does* re-parent, so two libraries on one path take files from each
other and each sweeps the other's shows on alternating scans.

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

**Back up first**: `sudo -u postgres pg_dump aurora > ~/aurora-before-move.sql`.
Aurora also has Admin → Backup → Download database snapshot.

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

The scan after a repoint **defers** the deleted-file prune and the empty-item
sweep to the end of the same scan, instead of running them at the start, and
says so in the log:

```
deferring prune: every recorded file lies outside this library's current
paths — pruning after the new files are attached
```

That is not a bug. The prune normally runs *before* the scan attaches the
files it found, so on the first pass after a move every row still describes
the old location: pruning there would empty each media item moments before
the same title was re-created from the new path, and the sweep would cascade
away exactly the history this procedure exists to keep. Deferring gets the
same stale rows deleted once the new ones are attached — in one scan, so no
title is left holding only a dead path.

Aurora reaches that conclusion two ways, and the first needs nobody to tell
it anything: if **every** file row for a library lies outside all of its
current paths, the library moved rather than lost its files. That is what
makes a `psql` edit, a restored database, or a server restart mid-move as
safe as pressing Edit. The second is a marker the Edit button sets, which
additionally covers a *partial* move — one root of several changed — where
rows still under an unchanged root stop the first check from firing.

If the deferred prune cannot run (the scan is cancelled by a restart, or
nothing was found under the new paths) the stale rows and the marker are both
kept, and the next scan tries again. Nothing is deleted on a guess.

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
