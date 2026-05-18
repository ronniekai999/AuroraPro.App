# Fifteenth Audit: Reverse Proxy Setup (2026-02-22)

## Scope
Audit of reverse proxy (nginx + Let's Encrypt) additions to `scripts/install.sh` and `scripts/uninstall.sh`.

## Findings and Fixes

### FIX-1 (MEDIUM): PROXY_DOMAIN not sanitized against nginx config injection
- **File**: `scripts/install.sh`, line 797
- **Bug**: User-entered domain was only checked for empty/spaces. Characters like `;{}` could inject arbitrary nginx directives into `server_name` and other template positions.
- **Fix**: Added regex validation `^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$` + 253 char length limit
- **Also fixed**: Matching validation in uninstall.sh marker file reader (defense in depth)

### FIX-2 (MEDIUM): Package install commands kill script under `set -e`
- **File**: `scripts/install.sh`, lines 828-832, 856-862
- **Bug**: `apt-get install`, `dnf install`, etc. for nginx/certbot were NOT guarded with `|| true`. Under `set -e`, a failed package install (e.g., network timeout, broken repo) kills the entire script instead of falling through to the "installation failed" check.
- **Fix**: Added `|| true` to all package install commands in the proxy section

### FIX-3 (MEDIUM): nginx start/reload kills script under `set -e`
- **File**: `scripts/install.sh`, lines 990-993
- **Bug**: `systemctl reload nginx` and `systemctl start nginx` were bare commands (no `|| true`, not in `if`). If nginx fails to start/reload, `set -e` kills the entire script.
- **Fix**: Wrapped both in `if` conditions with proper error messages, sets `PROXY_ABORT=true` on failure

### FIX-4 (LOW-MEDIUM): `systemctl list-unit-files` always returns exit 0
- **File**: `scripts/install.sh`, lines 1012, 1016
- **Bug**: `systemctl list-unit-files certbot.timer` returns exit 0 even if the timer doesn't exist (it just returns an empty list). So the first branch always succeeds, making the `elif` (certbot-renew.timer) and `else` branches dead code.
- **Fix**: Piped to `grep -q 'certbot.timer'` / `grep -q 'certbot-renew.timer'`

### FIX-5 (LOW): grep uses domain as regex in AURORA_ALLOWED_ORIGINS check
- **File**: `scripts/install.sh`, line 1041
- **Bug**: `grep -q "$PROXY_DOMAIN"` treats dots in domain as regex wildcards (match any char). `media.example.com` would false-positive match `mediaxexamplexcom`.
- **Fix**: Changed to `grep -qF` for fixed-string matching

### FIX-6 (LOW): sed metacharacter vulnerability in AURORA_ALLOWED_ORIGINS update
- **File**: `scripts/install.sh`, line 1046
- **Bug**: `sed -i "s|...|AURORA_ALLOWED_ORIGINS=${NEW_ORIGINS}|"` -- if `NEW_ORIGINS` contains `&`, sed interprets it as "insert matched text" in replacement. While unlikely with validated domains, the existing origins from the env file could contain arbitrary values.
- **Fix**: Replaced sed with grep-filter + printf-append + mv approach. Also restores permissions after rewrite.

### FIX-7 (LOW): Email validation too weak
- **File**: `scripts/install.sh`, line 808
- **Bug**: `grep -q '@'` accepts bare `@` or `user@` as valid email
- **Fix**: Changed to `grep -qE '^[^@]+@[^@]+\.[^@]+$'`

### FIX-8 (LOW): Marker file inconsistencies
- **File**: `scripts/install.sh`, lines 1055-1058
- **Bug 1**: `echo "$PROXY_DOMAIN"` could interpret escape sequences; changed to `printf '%s\n'`
- **Bug 2**: No `chown` on marker file (inconsistent with aurora.env pattern); added `chown root:$AURORA_GROUP`
- **Bug 3**: Condition `$PROXY_SETUP_OK || ! $PROXY_ABORT` was logically redundant; simplified to `! $PROXY_ABORT`

## Verified OK
- Heredoc escaping: MAPEOF uses `<<'MAPEOF'` (single-quoted, no expansion) for nginx variables. CONFEOF uses `<<CONFEOF` (unquoted) with `\$` for nginx variables and `${PROXY_DOMAIN}` for shell expansion. Correct.
- PROXY_ABORT gating: All subsequent sections check `! $PROXY_ABORT` before proceeding. Correct.
- certbot `--redirect` works correctly with `--nginx` plugin
- certbot failure handled gracefully (inside `if` condition, not affected by `set -e`)
- Uninstall step numbering: 7 steps, all consistently numbered 1/7 through 7/7
- Uninstall nginx config removal: covers both sites-available and conf.d locations
- Uninstall certbot delete: properly guarded with `|| true` and fallback instructions
- `grep -rq` for existing map block: pattern is specific enough to avoid false positives
- `--non-interactive` flag on certbot prevents blocking on prompts
- No race condition concern: install.sh requires interactive terminal, unlikely concurrent runs
