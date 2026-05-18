# Install Script Full Audit (2026-02-21)

## Fixes Applied

### FIX-1 (HIGH): Heredoc shell expansion corrupts user-entered values
- Lines 609-648 (old): `<<ENVFILE` (unquoted) caused `$`, backtick, and `\` in user-entered
  DB passwords, API keys, and TVDB PINs to be interpreted by bash during write
- Fix: Replaced all heredocs for dynamic values with `printf '%s\n' "$var"` which treats
  values as literal strings. Static sections use `<<'ENVFILE'` (quoted, no expansion).

### FIX-2 (MEDIUM): No macOS/non-Linux detection
- Lines 170-176 (old): Script only checked for root, not OS
- Fix: Added `uname -s` check rejecting macOS/Darwin and non-Linux, plus `systemctl` existence check

### FIX-3 (MEDIUM): aurora.service not validated before copy
- Line 579 (old): `cp` would fail with a confusing error if file missing
- Fix: Added existence check with clear error message

### FIX-4 (LOW): Redundant `2>&1` after `&>/dev/null`
- 5 instances cleaned up

### FIX-5 (LOW): EXISTING_JWT quote stripping
- Line 587 (old): If user manually added quotes to env file, JWT would be corrupted on re-run
- Fix: Strip surrounding single/double quotes after extraction

### FIX-6 (LOW): systemd service After= dependency uses wrong PG service name
- aurora.service hardcodes `postgresql.service` but distros use e.g. `postgresql-16.service`
- Fix: Install script now patches the After= line based on detected PG_SERVICE

### FIX-7 (LOW): setfacl arg quoting
- Fixed `u:${AURORA_USER}:rX` -> `"u:${AURORA_USER}:rX"`

## Remaining Issues (not fixed, informational)

### INFO-1 (LOW): SQL interpolation in psql commands
- Lines 416, 424: `PASSWORD '${DB_PASSWORD}'` uses string interpolation
- Currently safe because auto-generated passwords are alphanumeric only (rand_string)
- User-entered passwords (line 420) do NOT flow through psql commands
- Would become a bug if code is refactored to allow user passwords in CREATE/ALTER

### INFO-2 (LOW): version_gte word splitting
- Line 74: `local -a v1=($1)` has unquoted expansion (needed for IFS splitting)
- Shellcheck would warn, but this is intentional for the IFS=. splitting pattern

### INFO-3 (LOW): Unused loop variable
- Lines 362, 728: `for i in $(seq 1 10)` / `for i in $(seq 1 5)` - `$i` unused
- Cosmetic only, use `_` instead of `i` for clarity

### INFO-4 (LOW): Health check grep pattern
- Line 734: `grep -qi "ok\|healthy\|status"` - "status" matches too broadly
- Could match error responses containing "status". Low risk since it's just a display check.

### INFO-5 (LOW): chmod -R o+rX fallback for media dir
- Line 531: Opens world-read on the entire media directory tree as fallback
- This is a security trade-off documented in comments. Could leak media file listing.
