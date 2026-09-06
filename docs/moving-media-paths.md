# Moving Aurora's media to a new path

You moved your media from one directory to another — a bigger disk, a new
mount, a reorganised home directory. This is how to tell Aurora, without
losing everything it has learned about what you watch.

**The short version: repoint the existing library. Do not delete it and add a
new one at the new path.** Aurora has no UI for repointing yet, so it is done
in SQL, below.

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

**Repointing** changes `libraries.paths` AND rewrites the recorded file paths
to match, leaving the ids alone. None of the tables above notice anything
happened.

Rewriting the file rows is the part people skip, and it is the part that
matters.

> **Never update `libraries.paths` on its own.** The next scan walks the new
> root, finds not one of the library's recorded paths among what it
> discovered, prunes every row, and the empty-item sweep then deletes every
> `media_items` row in that library — cascading away the whole table above.
> Unattended, within one scan interval. There is no guard against this in any
> release; the rows and the library must move together.

## Doing it

Aurora has no UI for this. The procedure is below; read it through before
running any of it, and note that the steps are deliberately **separate** —
there is no single block to paste.

### 0. Stop the server

```bash
sudo systemctl stop aurora
```

Not optional. Moving files fires filesystem-watch events, which schedule a
rescan; a scan whose walk finishes before your changes land and whose prune
runs after them compares the new database paths against a file list gathered
from the old location, matches nothing, and prunes the lot.

### 1. Back up

```bash
sudo -u postgres pg_dump aurora > ~/aurora-before-move.sql
ls -lh ~/aurora-before-move.sql
grep -c 'PostgreSQL database dump complete' ~/aurora-before-move.sql   # must be 1
```

Everything below is irreversible without this, and a redirect leaves a
truncated file behind on failure with nothing to tell you — hence the check
rather than trusting the exit code. (`grep -c`, not `tail -1`: since the
August 2025 security releases `pg_dump` writes a `\unrestrict` line and blank
lines after that marker, so the last line of a perfectly good dump is empty.)

**To restore it**, if any check below fails:

```bash
sudo systemctl stop aurora
sudo -u postgres dropdb aurora
sudo -u postgres createdb -O aurora aurora
sudo -u postgres psql -v ON_ERROR_STOP=1 aurora < ~/aurora-before-move.sql
```

The `dropdb`/`createdb` is not optional. A plain `pg_dump` has no `--clean`, so
replaying it over the live database leaves every existing row in place, fails
several hundred statements — and still exits 0.

### 2. Look at what you have

```bash
sudo -u postgres psql aurora -c 'SELECT id, name, type, paths FROM libraries ORDER BY id;'
```

Write down which ids are the **originals** (the ones with your history) and
which, if any, are **duplicates** you created at the new location. You will
refer to both lists by number below. Everything after this point depends on
getting that right.

### 3. If you created duplicate libraries, salvage anything watched through them

Skip this if you did not create any. Otherwise do it **now** — step 4 deletes
those rows.

`media_files.path` is globally UNIQUE, so a duplicate library holding the new
paths blocks the original from taking them; the duplicates have to go. Anything
watched through them goes too, unless you move it across first, matching on
TMDB id. Substitute your own duplicate ids for `5,6,7,8`:

```sql
-- Dry run: what would move, and onto what.
SELECT wp.id, dup.title, dup.id AS from_item, orig.id AS to_item
  FROM watch_progress wp
  JOIN media_items dup  ON dup.id = wp.media_item_id
  JOIN media_items orig ON orig.tmdb_id = dup.tmdb_id AND orig.type = dup.type
 WHERE dup.library_id  IN (5, 6, 7, 8)
   AND orig.library_id NOT IN (5, 6, 7, 8)
   AND dup.tmdb_id IS NOT NULL
   AND wp.episode_id IS NULL;   -- match the UPDATE below, which skips episodes
```

Since migration 029 the uniqueness key is per profile
(`idx_watch_progress_user_profile_media` on
`(user_id, profile_id, media_item_id) WHERE episode_id IS NULL`), so the
`NOT EXISTS` below must match on the profile too or the statement aborts on the
first account that already has that film:

```sql
UPDATE watch_progress wp
   SET media_item_id = orig.id
  FROM media_items dup
  JOIN media_items orig ON orig.tmdb_id = dup.tmdb_id AND orig.type = dup.type
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

> **If this statement errors, stop.** It is all-or-nothing, so an abort means
> nothing was salvaged — and step 4 then deletes the rows it would have saved.
> The guard below only skips progress the original ALREADY has; if one profile
> watched the same film through TWO duplicate libraries, both rows target the
> same `(user_id, profile_id, media_item_id)` inside one statement and it
> aborts on `idx_watch_progress_user_profile_media`. Re-run it restricted to
> one duplicate library at a time.

If a film sits in two of your libraries (`Movies` and `4K Movies`), `orig`
matches more than one row and Postgres picks one arbitrarily — so progress can
land on the wrong entry, and the conflict guard above will not catch it because
the chosen entry has no progress yet. Add
`AND orig.library_id = <the one you want>`. The signal in the dry run is a
repeated **`wp.id`** (one progress row with more than one candidate
destination); a repeated `to_item` is normal — it just means two people watched
the same film.

For a few hours of viewing this is usually not worth it. Episode-level progress
keys on `episode_id`, not `media_item_id`, so carrying it over needs a join
through `tv_episodes` and `tv_seasons` (the season number lives on
`tv_seasons`, not `tv_episodes`) — rarely worth hand-writing.

### 4. Delete the duplicate libraries

**Check the list from step 2 first.** These ids are from one example install;
on yours, 5–8 may be real libraries with real history.

Look at exactly what you are about to remove, and what it will take with it:

```sql
SELECT l.id, l.name, l.paths,
       (SELECT count(*) FROM media_items mi WHERE mi.library_id = l.id) AS items,
       (SELECT count(*) FROM watch_progress wp
          JOIN media_items mi ON mi.id = wp.media_item_id
         WHERE mi.library_id = l.id) AS progress_rows
  FROM libraries l WHERE l.id IN (5, 6, 7, 8);
```

A duplicate created hours ago has a catalog and almost no progress. If
`progress_rows` is large, these are not the duplicates — stop and re-read
step 2.

```sql
BEGIN;
DELETE FROM libraries WHERE id IN (5, 6, 7, 8);
-- Confirm the survivors are the ones you meant to keep, then:
SELECT id, name, paths FROM libraries ORDER BY id;
COMMIT;   -- or ROLLBACK; if that list is wrong
```

### 5. Move the file rows, scoped to the libraries you are moving

The rewrite must be **scoped by library**, or it silently moves rows belonging
to any other library that happens to store media under the same prefix — and
step 6's verification cannot see it, because that library's rows are now
rewritten too.

`regexp_replace` with a `^` anchor, not `replace`: `replace` substitutes every
occurrence, so a prefix that recurs inside a path (`/media/tv/Show/media/…`)
gets mangled.

Substitute your own library ids and prefixes. The two prefixes must match each
other exactly, including the trailing slash.

Two things that bite:

- **`paths` is an array, and the assignment replaces all of it.** A library
  with several roots must have every one listed in its `ARRAY[...]`, or the
  omitted roots are dropped and their files end up outside their own library —
  invisible to a prefix-based check, which is why step 6 is data-derived.
  `SELECT id, paths FROM libraries` from step 2 is the list to work from.
- **The old prefix is a regular expression** in `regexp_replace`. A root
  containing `[`, `(`, `.`, `+` or `*` will not match literally: `/mnt/Media
  [2024]/` reads as a character class, the statement quietly becomes
  `SET path = path`, and it still reports `UPDATE n`. Escape those characters,
  or check step 6 rather than the row count. (The same characters are fine in
  the `LIKE` guard, though `%` and `_` in a path are wildcards there.)

```sql
BEGIN;

UPDATE media_files mf
   SET path = regexp_replace(mf.path, '^/home/rontavious999/media/', '/srv/storage/media/')
  FROM media_items mi
 WHERE mi.id = mf.media_item_id
   AND mi.library_id IN (1, 2, 3, 4)
   AND mf.path LIKE '/home/rontavious999/media/%';

UPDATE episode_files ef
   SET path = regexp_replace(ef.path, '^/home/rontavious999/media/', '/srv/storage/media/')
  FROM tv_episodes te
  JOIN media_items mi ON mi.id = te.media_item_id
 WHERE te.id = ef.episode_id
   AND mi.library_id IN (1, 2, 3, 4)
   AND ef.path LIKE '/home/rontavious999/media/%';

-- Repoint the libraries themselves. paths is a TEXT[].
UPDATE libraries SET paths = ARRAY['/srv/storage/media/movies']    WHERE id = 1;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/4kmovies']  WHERE id = 2;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/tvshows']   WHERE id = 3;
UPDATE libraries SET paths = ARRAY['/srv/storage/media/4ktvshows'] WHERE id = 4;

COMMIT;
```

### 6. Verify before starting the server

Three checks. All of them must pass; if any does not, **restore the backup**
(see step 1) rather than starting Aurora — a scan against a half-moved catalog
is what this whole procedure exists to avoid.

**6a — no library still points at the old location.** This is the check for the
one mistake the others structurally cannot see: a library you left out of
step 5 entirely is internally consistent (old rows, old root), so nothing about
it looks wrong. Only its *root* gives it away.

```sql
SELECT id, name, paths FROM libraries
 WHERE EXISTS (SELECT 1 FROM unnest(paths) p
                WHERE p LIKE '/home/rontavious999/media/%');
```

Must return no rows. Compare the full `SELECT id, name, paths FROM libraries`
against the list you wrote down in step 2 as well — this query only catches a
library still under the prefix you happened to type.

**6b — no file row has been left outside its own library's roots.** These are
data-derived: each row is compared against its own library's actual `paths`,
so they catch a dropped root of a multi-root library, a prefix mistyped in one
statement but not another, and a partially-applied step 5. The second query is
not optional — movie libraries store rows in `media_files` and show libraries
in `episode_files`, so a check against only the first is blind to every TV
library you just moved, and returns 0 on a shows-only install whatever state it
is in.

```sql
-- Movie rows no longer under any root of their own library.
SELECT count(*)
  FROM media_files mf
  JOIN media_items mi ON mi.id = mf.media_item_id
  JOIN libraries   l  ON l.id  = mi.library_id
 WHERE NOT EXISTS (
         SELECT 1 FROM unnest(l.paths) p
          WHERE left(mf.path, length(rtrim(p, '/')) + 1) = rtrim(p, '/') || '/');

-- The same for episodes. Show libraries have no media_files rows at all.
SELECT count(*)
  FROM episode_files ef
  JOIN tv_episodes te ON te.id = ef.episode_id
  JOIN media_items mi ON mi.id = te.media_item_id
  JOIN libraries   l  ON l.id  = mi.library_id
 WHERE NOT EXISTS (
         SELECT 1 FROM unnest(l.paths) p
          WHERE left(ef.path, length(rtrim(p, '/')) + 1) = rtrim(p, '/') || '/');
```

Both must return 0. (`left(...) =` rather than `LIKE`: the pattern would be
built from the library's own path, where `_` and `%` are wildcards you cannot
escape — and the error is one-directional, so a root like `/mnt/media_2024`
could only ever produce a false *clean*.) To see the offenders, swap `count(*)`
for `mf.path, l.name`.

**6c — every recorded path exists on disk, and the service can read it.**

This is the check that matters most, and it is the one people skip. A row
rewritten to a path with nothing at it is **not** a title that waits for the
file to turn up: the next scan finds it missing, prunes the row, and the
empty-item sweep then deletes the whole `media_items` row and cascades every
table in the list at the top of this page. Permanently. 6a and 6b cannot see
it — the row is under its library's root, it just is not on disk.

```bash
sudo -u postgres psql aurora -tAc \
  "SELECT path FROM media_files
   UNION ALL
   SELECT path FROM episode_files" \
| while IFS= read -r p; do
    [ -e "$p" ] || echo "MISSING: $p"
  done
```

Must print nothing. If it prints anything, the file did not arrive — finish the
copy and re-run this before going any further.

Then confirm the service user can actually READ one, not merely list it. Aurora
runs unprivileged, and home directories are 0700/0750 on modern distros, so a
path you can see in your own shell is often unreachable for it:

```bash
sudo -u postgres psql aurora -tAc \
  "SELECT mf.path FROM media_files mf
     JOIN media_items mi ON mi.id = mf.media_item_id
    WHERE mi.library_id = 1 LIMIT 1" \
| xargs -r -d'\n' -I{} sudo -u aurora head -c1 "{}" > /dev/null \
  && echo "aurora can read it" || echo "aurora CANNOT read it"
```

`head -c1`, not `ls` — `ls` succeeds with only search permission on the parent
and would pass on a file the service cannot open. `-r` matters too: without it
an empty result runs the command with no arguments and reads as success. Repeat
for one library of each type you moved (use the `episode_files` join for a show
library). If it fails: `sudo setfacl -m u:aurora:x` on each parent directory,
then `sudo setfacl -R -m u:aurora:rX` on the media root.

### 7. Start the server

```bash
sudo systemctl start aurora
```

The next scan should find exactly the paths already on record: no new files,
nothing pruned. Open a title and press play.

## What is not preserved

- **Cached transcode segments and subtitle extractions** keyed by the old
  path (`/var/cache/aurora`). They regenerate on demand.
- **Titles whose files did not come with the move — these are DELETED, not
  merely broken.** The rewrite touches every row under the old prefix whether
  or not the file arrived. A row pointing at a path with nothing at it is
  pruned on the next scan, and the empty-item sweep then deletes its
  `media_items` row and cascades everything in the table at the top of this
  page. Finish the copy before running step 5, and run check 6c before starting
  the server.

- **Anything whose FILENAME changed.** The rewrite is a prefix substitution, so
  a file that was also renamed is not covered: its row points at a path that no
  longer exists, and the next scan adds the renamed file as a new title with no
  history. Move without renaming.
- **TV episodes whose files were COPIED rather than moved.** `cp` and `rsync`
  without `-a`/`-t` change each file's mtime, and Aurora's quick file hash is
  size + mtime, so every episode is re-read. If TMDB enrichment stored a show
  title that differs from the folder name (`Marvel's Daredevil` vs
  `Daredevil`), the re-read creates a new show and — because the
  `episode_files` upsert re-parents on path conflict — moves the episode files
  onto it, leaving the original show empty for the sweep to delete along with
  its history. **Use `mv`**, or a copy that preserves mtimes (`cp -a`,
  `rsync -a`). This is pre-existing behaviour, not specific to moving paths: it
  fires for any episode file whose mtime changes.

## Related

- `internal/library/scanner.go` — `pruneDeletedFiles` and the
  `DeleteEmptyMediaItems` sweep, which are what this procedure exists to
  avoid triggering
- `internal/db/queries.go` — `UpsertMediaItem`'s
  `(library_id, type, title, year)` key, which is why a new library gets new
  ids
- `docs/server-testing.md` — verifying against the running instance

## Not yet built

An **Edit** button that does all of this from Admin → Libraries. It was
attempted alongside this document and withdrawn: five independent review
rounds each found a way it destroyed catalog history, the last of them in the
TV path described above. Until it exists, the SQL here is the supported
route.
