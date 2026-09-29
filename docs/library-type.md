# A library with the wrong type

A library's type decides how every file under it is read. `movie` sends each
file through the movie path parser, stores it as a movie, and searches it
against TMDB's movie index; `show` does the same against the TV index and builds
seasons and episodes. Get it wrong and the library does not half-work — it
produces a catalog of titles that match nothing and never appear under the type
you expect.

That is issue #510. A "TV Shows" library was created as `movie`. All 80 series
were parsed as films, stored as movies with their files in the wrong table, and
searched against the movie index, where none of them matched. Every scan
reported success.

## Is a library mis-typed?

The admin **Libraries** tab shows each library's match rate and warns when a
library holds at least 10 titles and at most 5% of them have provider metadata.
The same warning is written to the server log once per scan, so you can find it
without opening the UI:

```bash
journalctl -u aurora | grep -E 'almost no metadata matches|broken install-wide'
```

The second pattern is the install-level line, which is worded differently
because it means something different — see below.

Read the warning before acting on it. A near-zero match rate has three common
causes and this check cannot tell them apart:

1. **The library's type is wrong.** The usual cause, and the only one that
   produces exactly zero across a large library.
2. **The paths are wrong**, so the scan is cataloguing something that is not the
   media you think it is.
3. **The metadata provider is unreachable** — an absent or invalid TMDB key, or
   a blocked host. When *every* library with enough titles is starved you get a
   single install-level warning naming the provider instead, because that is
   what the pattern means.

Check the type first, then the paths, then the key.

## Changing the type

> **This deletes catalog rows.** Watch progress, watchlist entries, ratings,
> collection memberships and generated recaps for every title of the old type go
> with them. Files on disk are never touched.

There is no way to change a library's type in place. Everything already
catalogued carries the old type, and its files sit in the table that type
implies; flipping the type alone would leave those rows stranded, unreachable by
any later prune, while the catalog still read as the old type. So the operation
deletes them and rescans from disk under the right parser.

In the admin **Libraries** tab, press **Change to TV** / **Change to Movies** on
the library. You are shown exactly what will be deleted — the item count, and
each kind of attached record with a count — before anything happens. Nothing is
deleted until you confirm.

If the **number of titles** changes between the preview and your confirmation
(a scan finishes, another admin acts), the change is **refused** rather than
applied to a different number of titles than you approved. Re-open the preview
and confirm the new figure.

That interlock covers the title count, not the attached-record counts beside it.
Someone watching an episode or rating a film between the preview and your
confirmation changes how many of those records go without changing the title
count, and the change proceeds. Widening the check to every one of them would
refuse the operation any time anyone was using the server.

The rescan starts automatically. Expect it to take as long as a normal scan of
that library, plus metadata lookups for everything it rediscovers.

### The same-type repair

Both types are offered, including the one the library already claims — the
button reads **Re-apply** rather than **Change to** for that one.

Choosing it is not a no-op. It purges any rows whose type disagrees with the
library's and rescans. That is the state hand-written SQL leaves behind —
`UPDATE libraries SET type` without the matching delete — and re-applying the
type the library already has is how to finish the job.

Do not reach for the *other* button in that state. On a library already marked
`show` but still full of movie rows, "Change to Movies" is a legitimate action
with a legitimate preview (it has nothing to delete, because no rows disagree
with `movie`) — and confirming it puts the library back to `movie`, undoing the
correction.

### What is not preserved

Nothing is carried across. A movie row and the show row that replaces it are
different titles as far as the catalog is concerned: they are keyed differently,
enriched differently, and have different children. Guessing at a mapping between
them is how the withdrawn library-repointing work destroyed history five
separate ways, so this deliberately does not try.

If you need the watch history, export it before changing the type.

## Curl equivalents

Admin session required; see [`server-testing.md`](server-testing.md) for how to
get one.

```bash
# What would change?
curl -s -b cookies.txt \
  "$AURORA_BASE/api/libraries/8/retype/preview?type=show" | jq

# Apply it, echoing back the items_to_delete the preview reported.
curl -s -b cookies.txt -X POST \
  -H 'Content-Type: application/json' \
  -d '{"type":"show","expected_items":80}' \
  "$AURORA_BASE/api/libraries/8/retype" | jq

# The health report on its own.
curl -s -b cookies.txt "$AURORA_BASE/api/admin/library-health" | jq
```

`expected_items` is required and is the interlock: the server compares it with
what it is about to delete and refuses with 409 if they differ.

## Known limits

- **There is no undo.** The deleted rows are gone; only the files on disk and
  whatever the rescan can derive from them come back.
- **More is deleted than titles.** The preview enumerates it — watch progress,
  watchlist entries, ratings, recap threads and their questions and answers,
  detected intro/credits markers, collection memberships, and watch party rooms
  with their invitations and participants — by walking the database's own
  cascade graph rather than a list in the code. Read it before confirming; it is
  the only place those counts appear.
- **The preview lists deletions, not every side effect.** If a library holds
  both types at once, two things on titles you are KEEPING can lose an episode
  reference — a watch party, and a recap conversation turn's episode boundary —
  when that episode belongs to a title being removed. The column is nulled
  rather than the row deleted, and nothing reports it.
- **A live watch party is deleted out from under the running room.** Its
  participants stay connected to a room whose database row is gone; the server
  is not notified. The preview does say how many rooms go, and flags that some
  may be live.
- **The preview runs one count per affected table.** On a very large library it
  is not instant, and if it times out the confirm cannot be made at all, because
  it needs the number the preview returns.
- **The rescan is fire-and-forget.** If it fails after the purge has committed,
  the library is empty until you scan it again. The purge itself is one
  transaction and either lands completely or not at all.
- **The report's thresholds are reasoned, not calibrated.** 10 titles and 5% are
  chosen so a genuinely obscure collection stays quiet while a mis-typed library
  sits at zero; no real install has been measured against them.
