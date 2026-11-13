# Backing up and restoring the database

Aurora's database (accounts, profiles, libraries, watch history, lists and
settings) can be downloaded as a backup and restored from the Admin page, under
**Backup and restore**. This page covers what a restore does, how to learn how
one went, and how to recover when one fails.

Media files and `/etc/aurora/aurora.env` are not in a backup; copy those
yourself.

## Taking a backup

**Download backup** streams a PostgreSQL custom-format dump (`.dump`). It holds
every table's schema and every table's rows except two: sessions
(`refresh_tokens`) and scanner progress (`scan_progress`). A backup and a
restore cannot run at once; the second one asked for is refused with a 409.

From the server's shell instead:

```bash
sudo -u aurora bash -c 'set -a; . /etc/aurora/aurora.env; pg_dump --format=custom --compress=6 --no-owner --no-acl --no-publications --no-subscriptions --quote-all-identifiers --exclude-table-data=refresh_tokens --exclude-table-data=scan_progress "$DATABASE_URL"' > aurora-backup.dump
```

These are the flags the Admin page's download uses. `DATABASE_URL` is in
`/etc/aurora/aurora.env`, which the `aurora` user can read. The commands on
this page pass it, password included, on the command line, where other users
of the machine can see it with `ps` while the command runs (Aurora itself
hands the password over in `PGPASSWORD` instead). On a machine others log in
to, put the password in the `aurora` user's `~/.pgpass` and leave it out of
the URL you pass.

## What a restore does

A restore replaces everything in the database with what is in the file. In
order:

1. **Upload.** Before the file is read, the server checks that its
   `pg_restore` and `psql` are new enough to restore safely (they must have
   `--restrict-key`: PostgreSQL 17.6, 16.10, 15.14, 14.19, 13.22 or later). A
   missing or older program is refused at once, saying which, and nothing is
   uploaded. The file is then written to a temporary file on the server. This
   is the only part that depends on the browser: closing the tab or losing the
   connection during the upload stops the restore before anything is changed.
2. **Check** (`checking`). Without touching the database, `pg_restore` lists
   the archive's contents and then reads the whole archive. Refused here, with
   the database unchanged: a file it cannot read in full; a backup holding
   entries that cannot run inside one transaction (large objects, which
   `pg_restore` commits on their own, and database-level entries such as
   subscriptions or tablespaces), which has to be restored from the shell; and
   a file with no tables, which is no backup of Aurora.
3. **Restore** (`restoring`). Signing in and changes to sign-in details are
   paused first (below), and the restore waits up to 10 seconds for any
   already under way; if one is still running then, the restore does not
   start and nothing is changed. Then one `psql` session runs one transaction:
   it drops every table, view, sequence, type and function in the `public`
   schema that is not owned by an extension, and then runs what `pg_restore`
   writes for the file. Just before the end it ends the other connections
   that are waiting for it (below). Aurora sends the `COMMIT` itself, and only
   after `pg_restore` has finished without an error, everything it wrote has
   reached `psql`, and the restore has not been stopped. **Until then nothing
   is changed**: any failure, a stop or restart of Aurora, a crash, a lost
   connection or the time limit rolls the whole transaction back, and the
   database is left as it was.

That promise holds for a backup Aurora made. A file crafted to hold its own
`COMMIT` or `ROLLBACK` can end the transaction part way, and its outcome can
then be misreported (a failure called rolled back after a partial commit, or a
partial load called restored); one that leaves a `COPY` open swallows Aurora's
`COMMIT` (rolled back, reported as unknown). Only an admin can upload a file,
and an admin can empty the database anyway; restore only backups you trust.

While the restore's transaction runs, it holds a lock on every table it has
dropped, so everything else that reads the database waits for it: **pages hang
until the restore ends** (those with a time limit fail after a minute; the
Admin page's restore status read has none and waits until the end). A request
still waiting when the restore commits is ended (below); one waiting when it
rolls back goes on with the old data.

- **Signing in is paused.** From just before the transaction begins until the
  restore ends, the routes that create or change a session or a sign-in
  detail answer at once with `503` and the reason `restore_running`, which
  the web app says plainly: signing in, creating an account, renewing a
  session, signing in or linking through a provider, the device pairing's
  poll and approval, changing the password, unlinking a provider, setting a
  profile PIN and changing a role. A device being paired keeps polling. A
  pairing approved before a restore that succeeds is dropped: the device
  starts again with a new code. Without this, a sign-in that waited on the
  restore went on after it with the OLD database's user id, and after a
  restore from another install's backup that id can be someone else's.
- **Waiting writes are ended.** Anything else that waited on the restore (a
  progress save, a list change, a page's read) would go on after the `COMMIT`
  against the restored data, with the ids it had read before. Just before the
  `COMMIT`, while it still holds the locks, the restore ends every other
  connection of this database that is waiting on it
  (`pg_terminate_backend`): that request fails (the web app says it could not
  load or save just now; a retry works), and Aurora opens a new connection. A
  connection Aurora's database user may not end (a superuser's `psql`) is
  left and logged as a warning; the restore commits anyway. A request that
  starts waiting in the moment between that and the `COMMIT` (well under a
  second) still goes on against the restored data.
- **Scans and metadata work.** A library scan, enrichment or other background
  job that is running when the restore commits carries on with the ids it
  read before, into the restored data, until Aurora restarts. Start a restore
  when no library scan is running (the scan bar shows one) and restart Aurora
  as soon as it succeeds; after a restore from another install's backup, scan
  the libraries again after that restart.
- **Free disk space.** The old data's files are kept until the transaction
  commits, so the database needs room for both copies (and their write-ahead
  log) while the restore runs. Nothing checks that first. A restore that runs
  out of space fails and rolls back; if PostgreSQL itself cannot write its log
  it stops and restarts (every connection drops, Aurora's included), and the
  files the restore had written may stay on disk until removed by hand.
- **Waiting for other work.** The drops wait up to 30 seconds for any other
  transaction using a table to finish. Past that the restore fails, rolled
  back, saying so (`lock timeout`); try again when the server is quieter. A
  write that meets the drops half way can deadlock with them, and PostgreSQL
  then aborts one of the two: that request, or the restore (rolled back; run
  it again).

From the end of the upload, the restore runs on the server to its end, whatever
happens to the browser that started it: a reload, a closed tab, a lost
connection or a laptop going to sleep do not stop it. (Before this, any of those
stopped `pg_restore` part way and left the database empty, with nothing to say
so.) The whole restore after the upload has 60 minutes.

**Everyone is signed out by a restore that succeeds**, the admin who started it
included: backups hold no sessions, and no sign-in can add one while it runs. Each browser finds out at its next token
refresh, within about 15 minutes; until then a page can still load, but
anything that checks the session (the Admin page among them) is refused. Sign
in again with an account from the backup. A restore that fails signs nobody
out.

**Restart Aurora after a restore that succeeds**: `sudo systemctl restart
aurora`. Until then the server runs on a database its migrations have not seen,
and on connections that may hold plans for tables that were dropped. The
restart also brings an older backup's schema up to date.

## Learning how a restore went

The server keeps a record of the latest restore since it last started: whether
it is running and at which step, or how it ended, and whether Aurora needs a
restart.

- **In the browser that started it**, the Admin page's **Backup and restore**
  section shows it, and so does the sign-in page. A reload during a restore can
  hang until it ends or land on the sign-in page, and one after a restore that
  succeeded lands there (the restore has ended your session); that page says
  whether the restore is still running, finished (restart now), or failed.
  That browser keeps a ticket for the restore in its local storage to ask
  with; a private window, or site data that is blocked or cleared, loses it.
- **Any admin**, while the database can still vouch for their session, sees a
  restore that is running, or one that needs acting on, when they open the
  Admin page (it is read then, and again every few seconds while a restore
  runs), and the full record under Backup and restore.

The two reads behind these:

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/admin/restore/status` | an admin session not acting as a restricted profile | The session checks read the database, so while a restore's transaction runs this read waits for it, with no time limit, until the restore ends; after one that succeeds it is refused until you sign in again. |
| `GET /api/restore/status` | whoever holds the restore's ticket (`X-Aurora-Restore-Ticket`) | No session needed, and no database. The ticket is the 32-to-128-character secret the upload carried; the server keeps only its SHA-256. Any other value, and a ticket a newer restore has replaced, gets the same 404. |

Both answer:

| Field | Meaning |
| --- | --- |
| `state` | `none` (no restore since Aurora started), `running`, `succeeded`, `failed` |
| `step` | `checking` or `restoring`: where a running restore is, or where a failed one stopped |
| `database` | `unchanged`, `restored`, or `unknown`. Until the restore commits, and after any failure, it is `unchanged`: the transaction rolled back. `unknown` only when Aurora could not learn whether its `COMMIT` took effect (`psql` ended after Aurora sent it and before it said how that ended, or said nothing), or on an internal error after the check: for a backup Aurora made, the database then holds either what it held before or the whole backup, never a mix |
| `file`, `started_at`, `finished_at` | the uploaded file's name, and when the restore began and ended |
| `restart_required` | a restore has succeeded since Aurora started; a later restore that is refused does not clear it |
| `message` | the server's account of a finished restore: the same text its request was, or would have been, answered with. The admin read only: it can quote `pg_restore`'s or `psql`'s output, which can include a row of the table that failed, and the ticket read has no session behind it |

A client that sends no ticket still restores; it reads the outcome through the
admin route only. Every failure is also in the server log, with the tool's
output: `journalctl -u aurora | grep -i restore`.

## What still stops a restore

Each of these rolls the restore back: the database is left as it was, and the
restore has to be run again.

- **Aurora stopping or restarting** while a restore runs (systemd stops every
  process of the service, `psql` and `pg_restore` included), and a crash.
- **The auto-updater** waits for a running restore before it restarts Aurora,
  as it waits for viewers (the server counts the restore in the snapshot the
  updater reads), but for five minutes at most; then it restarts anyway. For a
  restore that can take longer, do not push to the branch the server follows
  while it runs, or pause the timer first:

  ```bash
  sudo systemctl stop aurora-update.timer
  ```

  and start it again once the restore has ended:

  ```bash
  sudo systemctl start aurora-update.timer
  ```

  `install.sh` and `redeploy.sh` wait the same way, unless run with
  `AURORA_SKIP_DRAIN=1` or `--no-drain` (and `redeploy.sh --no-restart` does
  not restart at all).
- **The 60-minute limit.** Larger databases should be restored from the shell
  (below).

The record is kept in memory only. **After a restart there is no record**, of a
restore that finished or of one the restart cut short: the status reads say
`none` (the ticket read says it does not know the ticket), and the browser that
started it says Aurora has no record of it. A restore a restart cut short was
rolled back, unless the restart came just as it was committing; look at the
data to tell (below).

## When a restore fails

**`database` is `unchanged`** (every failure but one): nothing was changed.
Read the message: fix the file, free disk space, or try again when the server
is quieter, as it says.

**`database` is `unknown`:** the restore was cut off as it committed, so the
database holds either what it held before or the whole backup. Sign in (with an
account from the backup, if the old ones are refused) and look at the data; if
it is the backup's, restart Aurora. Restore again from the Admin page if it is
not what you want.

**Aurora restarted during a restore** (no record survives): the same applies.
Unless the restart came just as the restore was committing, the old data is
there.

## Known limits

- An upload refused at once (programs too old, another restore running) can
  reach the browser as a dropped connection rather than the refusal, while
  the browser is still sending a large file.
- Aurora reads PostgreSQL's English `ERROR:` lines to tell a failed `COMMIT`
  from an unknown one; a server whose messages are in another language reports
  a failed `COMMIT` as `unknown` (check the data, as above).
- Access tokens are not tied to a database: one issued before a restore
  stays usable for its lifetime (15 minutes by default), and most routes check
  only the user id and token version it names. After a restore from another
  install's backup that id can be someone else's, so a browser signed in
  before it may act as that account until its token runs out (the routes that
  read the session, the Admin page among them, refuse it). Restarting Aurora
  does not end such tokens.

## Restoring from the shell

For a backup too large for the Admin page's 60 minutes, or one with large
objects, restore it into a new database with Aurora stopped, and then swap the
names. The old database is kept until you drop it. With the installer's
defaults (database and user `aurora`):

```bash
sudo systemctl stop aurora
sudo -u postgres createdb -O aurora aurora_restored
sudo -u postgres psql -d aurora_restored -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;'
```

```bash
sudo -u aurora bash -c 'set -a; . /etc/aurora/aurora.env; pg_restore --single-transaction --no-owner --no-privileges --no-comments --dbname="${DATABASE_URL%/*}/aurora_restored" /path/to/aurora-backup.dump'
```

(`${DATABASE_URL%/*}/aurora_restored` is `DATABASE_URL` with its database name
replaced; if your URL ends in options such as `?sslmode=disable`, write the URL
out instead.) The file must be readable by the `aurora` user (copy it to `/tmp`
first if it is in your home directory). If that `pg_restore` fails, nothing is
in the new database: drop it (`sudo -u postgres dropdb aurora_restored`), read
the error (the file may be from a newer PostgreSQL major version than the
server's, or damaged), and start Aurora again on the old one. Once it succeeds:

```bash
sudo -u postgres psql -c 'ALTER DATABASE aurora RENAME TO aurora_before_restore' -c 'ALTER DATABASE aurora_restored RENAME TO aurora'
sudo systemctl start aurora
```

When the restored data is what you want, `sudo -u postgres dropdb
aurora_before_restore` frees its space.

## Older `.sql.gz` backups

The Admin page takes only `.dump` files. Restore an old plain-format backup from
the shell:

```bash
gunzip < legacy-backup.sql.gz | psql "$DATABASE_URL"
```
