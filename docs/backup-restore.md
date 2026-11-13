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
`/etc/aurora/aurora.env`, which the `aurora` user can read.

## What a restore does

A restore replaces everything in the database with what is in the file. In
order:

1. **Upload.** The file is written to a temporary file on the server. This is
   the only part that depends on the browser: closing the tab or losing the
   connection during the upload stops the restore before anything is changed.
2. **Check** (`checking`). `pg_restore` reads the whole archive without
   touching the database. A file it cannot read in full is refused here and the
   database is not changed.
3. **Clear** (`clearing`). Every table, view, sequence, type and function in the
   `public` schema that is not owned by an extension is dropped, in one
   statement. From here until the restore commits, the database has no tables:
   **nobody can sign in, and every page that needs the database fails.**
4. **Restore** (`restoring`). `pg_restore --single-transaction` loads the file.
   If any statement fails, the whole load rolls back, and the database is left
   **empty**.

From the end of the upload, the restore runs on the server to its end, whatever
happens to the browser that started it: a reload, a closed tab, a lost
connection or a laptop going to sleep do not stop it. (Before this, any of those
stopped `pg_restore` part way and left the database empty, with nothing to say
so.) The whole restore after the upload has 60 minutes.

**Everyone is signed out by a restore**, the admin who started it included:
backups hold no sessions. Each browser finds out at its next token refresh,
within about 15 minutes; until then a page can still load, but anything that
checks the session (the Admin page among them) is refused. Sign in again with
an account from the backup.

**Restart Aurora after a restore that succeeds**: `sudo systemctl restart
aurora`. Until then the server runs on a database its migrations have not seen,
and on connections that may hold plans for tables that were dropped. The
restart also brings an older backup's schema up to date.

## Learning how a restore went

The server keeps a record of the latest restore since it last started: whether
it is running and at which step, or how it ended, and whether Aurora needs a
restart.

- **In the browser that started it**, the Admin page's **Backup and restore**
  section shows it, and so does the sign-in page. A reload during a restore, or
  after one, usually lands on the sign-in page (the restore has the database,
  or has ended your session), and that page says whether the restore is still
  running, finished (restart now), or failed (and whether the database is
  empty). That browser keeps a ticket for the restore in its local storage to
  ask with; a private window, or site data that is blocked or cleared, loses
  it.
- **Any admin**, while the database can still vouch for their session, sees a
  restore that is running, or one that needs acting on, on whichever Admin
  section they open, and the full record under Backup and restore.

The two reads behind these:

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/admin/restore/status` | an admin session not acting as a restricted profile | Refused while a restore has the database, and after one that leaves it empty: the session checks read the database. |
| `GET /api/restore/status` | whoever holds the restore's ticket (`X-Aurora-Restore-Ticket`) | No session needed. The ticket is the 32-to-128-character secret the upload carried; the server keeps only its SHA-256. Any other value, and a ticket a newer restore has replaced, gets the same 404. |

Both answer:

| Field | Meaning |
| --- | --- |
| `state` | `none` (no restore since Aurora started), `running`, `succeeded`, `failed` |
| `step` | `checking`, `clearing` or `restoring`: where a running restore is, or where a failed one stopped |
| `database` | `unchanged`, `empty`, `restored`, or `unknown`: the old data is being cleared (while running), or a step stopped part way and may or may not have landed (the timeout, a shutdown, psql losing its connection mid-statement, an internal error) |
| `file`, `started_at`, `finished_at` | the uploaded file's name, and when the restore began and ended |
| `restart_required` | a restore has succeeded since Aurora started; a later restore that is refused does not clear it |
| `message` | the server's account of a finished restore: the same text its request was, or would have been, answered with. The admin read only: it can quote `pg_restore`'s or `psql`'s output, which can include a row of the table that failed, and the ticket read has no session behind it |

A client that sends no ticket still restores; it reads the outcome through the
admin route only. Every failure is also in the server log, with the tool's
output: `journalctl -u aurora | grep -i restore`.

## What still stops a restore

- **Aurora stopping or restarting** while a restore runs ends it (systemd stops
  every process of the service, `pg_restore` included), as does a crash. Past
  the clear step, that leaves the database empty.
- **The auto-updater** restarts Aurora when it deploys a new commit, and does
  not wait for a restore. Do not push to the branch the server follows while a
  restore runs, or pause the timer first:

  ```bash
  sudo systemctl stop aurora-update.timer
  ```

  and start it again once the restore has ended:

  ```bash
  sudo systemctl start aurora-update.timer
  ```

- **The 60-minute limit.** Larger databases should be restored from the shell.

The record is kept in memory only. **After a restart there is no record**, of a
restore that finished or of one the restart cut short: the status reads say
`none` (the ticket read says it does not know the ticket), and the browser that
started it says Aurora has no record of it. To learn what a restart did to a
restore that was running, look at the database itself (below).

## When a restore fails

**Failed at `checking`, or `database` is `unchanged`:** nothing was changed.
Fix the file and try again.

**`database` is `empty`:** the old data was cleared and the new data rolled
back. Nobody can sign in, so the restore cannot be retried from the Admin page.
**Restore from the shell before restarting Aurora.** Started on an empty
database, Aurora's migrations build a fresh schema and the first account anyone
registers becomes its admin, with no invite code; on a server others can reach,
that is a race you do not want to run.

```bash
sudo systemctl stop aurora
```

```bash
sudo -u aurora bash -c 'set -a; . /etc/aurora/aurora.env; pg_restore --single-transaction --no-owner --no-privileges --no-comments --dbname="$DATABASE_URL" /path/to/aurora-backup.dump'
```

```bash
sudo systemctl start aurora
```

The file must be readable by the `aurora` user (copy it to `/tmp` first if it
is in your home directory). If that `pg_restore` fails too, read its error: the file may be from a newer
PostgreSQL major version than the server's, or damaged.

If Aurora has already been restarted on the empty database, register the admin
account at once, sign in, and restore again from the Admin page; the restore
replaces that account with the backup's.

**`database` is `unknown`:** a step was cut short. Check what is there:

```bash
sudo -u aurora bash -c 'set -a; . /etc/aurora/aurora.env; psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = current_schema()"'
```

No tables means the database is empty: restore from the shell as above. If
tables are there, sign in and look at the data; restore again from the Admin
page if it is not what you expect.

**Aurora restarted during a restore** (no record survives): the same check
applies, but after a restart Aurora's migrations will already have created
the tables again. Count the accounts instead:

```bash
sudo -u aurora bash -c 'set -a; . /etc/aurora/aurora.env; psql "$DATABASE_URL" -tAc "SELECT count(*) FROM users"'
```

Zero accounts means the database was emptied and the restore did not land:
the server is now a fresh install, and the advice above for a restart on an
empty database applies. Accounts there means either the old data (the restart
came before the clear step) or the restored data: sign in and look.

## Older `.sql.gz` backups

The Admin page takes only `.dump` files. Restore an old plain-format backup from
the shell:

```bash
gunzip < legacy-backup.sql.gz | psql "$DATABASE_URL"
```
