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
tail -1 ~/aurora-before-move.sql   # must read: -- PostgreSQL database dump complete
```

Everything below is irreversible without this, and a redirect leaves a
truncated file behind on failure with nothing to tell you — hence the two
checks rather than one command.

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
   AND dup.tmdb_id IS NOT NULL;
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

```sql
DELETE FROM libraries WHERE id IN (5, 6, 7, 8);
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

Both of these must return 0. If either does not, **restore the backup** rather
than starting Aurora — a scan against a half-moved catalog is what the whole
procedure exists to avoid.

They are deliberately **data-derived**: each row is compared against its own
library's actual `paths`, not against the prefix you typed. A check phrased in
terms of your prefix passes when you mistype it, when you miss a library, and
when you drop a root — and the first two checks this page carried did exactly
that. The second query is not optional: movie libraries store rows in
`media_files` and show libraries store them in `episode_files`, so a check
against only the first is blind to every TV library you just moved, and returns
0 on a shows-only install no matter what state it is in.

```sql
-- Movie rows that no longer live under any root of their own library.
SELECT count(*)
  FROM media_files mf
  JOIN media_items mi ON mi.id = mf.media_item_id
  JOIN libraries   l  ON l.id  = mi.library_id
 WHERE NOT EXISTS (SELECT 1 FROM unnest(l.paths) p
                    WHERE mf.path LIKE rtrim(p, '/') || '/%');

-- The same for episodes. Show libraries have no media_files rows at all.
SELECT count(*)
  FROM episode_files ef
  JOIN tv_episodes te ON te.id = ef.episode_id
  JOIN media_items mi ON mi.id = te.media_item_id
  JOIN libraries   l  ON l.id  = mi.library_id
 WHERE NOT EXISTS (SELECT 1 FROM unnest(l.paths) p
                    WHERE ef.path LIKE rtrim(p, '/') || '/%');
```

A non-zero count lists itself — swap `count(*)` for `mf.path, l.name` (or
`ef.path, l.name`) to see which rows are stranded and under which library.

Then spot-check that a rewritten path is real, as the `aurora` user — the
service runs unprivileged, and home directories are 0700/0750 on modern
distros, so a path you can see in your own shell is often unreadable to it.
Check a library you actually moved, and use whichever table it stores rows in:

```bash
# Substitute a library id you moved. Use episode_files for a show library:
#   SELECT ef.path FROM episode_files ef
#     JOIN tv_episodes te ON te.id=ef.episode_id
#     JOIN media_items mi ON mi.id=te.media_item_id WHERE mi.library_id=3 LIMIT 1
sudo -u postgres psql aurora -tAc \
  "SELECT mf.path FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
    WHERE mi.library_id = 1 LIMIT 1" \
  | xargs -r -d'\n' sudo -u aurora ls -l
```

`-r` matters: without it, an empty result runs `ls -l` on the current directory
and reads as success. If it fails with permission denied:
`sudo setfacl -m u:aurora:x` on each parent directory, then
`sudo setfacl -R -m u:aurora:rX` on the media root.

### 7. Start the server

```bash
sudo systemctl start aurora
```

The next scan should find exactly the paths already on record: no new files,
nothing pruned. Open a title and press play.

## What is not preserved

- **Cached transcode segments and subtitle extractions** keyed by the old
  path (`/var/cache/aurora`). They regenerate on demand.
- **Titles whose files did not come with the move.** The rewrite touches
  every row under the old prefix whether or not the file arrived, so finish the
  copy BEFORE running it. A row rewritten to a path with nothing at it is a
  title that will not play until the file turns up.

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
