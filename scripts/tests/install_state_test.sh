#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/install-state.sh
# shellcheck disable=SC1091
. "$PROJECT_ROOT/scripts/lib/install-state.sh"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_safe_media() {
    local path="$1"
    if reason="$(aurora_media_root_rejection_reason "$path")"; then
        fail "expected safe media path '$path', rejected: $reason"
    fi
}

assert_unsafe_media() {
    local path="$1"
    aurora_media_root_rejection_reason "$path" >/dev/null \
        || fail "expected unsafe media path '$path' to be rejected"
}

[ "$(aurora_trim_horizontal_whitespace $' \t/home/alice/My Media\t ')" \
    = "/home/alice/My Media" ] || fail "horizontal whitespace trim"
[ "$(aurora_trim_horizontal_whitespace ' /srv/[movies]* ')" \
    = "/srv/[movies]*" ] || fail "trim must not expand globs or mangle quotes"

aurora_database_url_is_local_database \
    "postgres://aurora:secret@localhost:5432/aurora?sslmode=disable" aurora \
    || fail "localhost database URL should be local"
aurora_database_url_is_local_database \
    "postgresql://aurora:secret@[::1]:5432/aurora" aurora \
    || fail "IPv6 loopback database URL should be local"
aurora_database_url_is_local_database "postgres://aurora:secret@/aurora" aurora \
    || fail "Unix-socket database URL should be local"
if aurora_database_url_is_local_database \
    "postgres://aurora:secret@db.example.com:5432/aurora" aurora; then
    fail "external database URL was treated as local"
fi
for non_owned_dsn in \
    "postgres://other:secret@localhost:5432/aurora" \
    "postgres://aurora:secret@localhost:5433/aurora" \
    "postgres://aurora:secret@localhost:5432/aurora?host=/tmp" \
    "postgres://aurora:secret@localhost:5432/aurora?service=other" \
    "postgres://aurora:secret@localhost:5432/aurora/extra" \
    "postgres:///aurora"; do
    if aurora_database_url_is_local_database "$non_owned_dsn" aurora; then
        fail "non-default/non-owned database URL was treated as installer-owned: $non_owned_dsn"
    fi
done

cat > "$TMP_ROOT/db-owned" <<'EOF'
aurora
aurora
/var/lib/postgresql/17/main
5432
7612345678901234567
16384
16385
EOF
aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-owned" aurora aurora \
    /var/lib/postgresql/17/main 5432 7612345678901234567 16384 16385 \
    || fail "matching PostgreSQL cluster/database/role identities should prove ownership"
if aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-owned" aurora aurora \
    /var/lib/postgresql/17/main 5432 7699999999999999999 16384 16385; then
    fail "replacement PostgreSQL cluster was accepted at the same path and port"
fi
if aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-owned" aurora aurora \
    /var/lib/postgresql/17/main 5432 7612345678901234567 26384 16385; then
    fail "replacement same-named PostgreSQL database was accepted on the owned cluster"
fi
if aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-owned" aurora aurora \
    /var/lib/postgresql/17/main 5432 7612345678901234567 16384 26385; then
    fail "replacement same-named PostgreSQL role was accepted on the owned cluster"
fi
missing_object_status=0
aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-owned" aurora aurora \
    /var/lib/postgresql/17/main 5432 7612345678901234567 "" 16385 \
    || missing_object_status=$?
[ "$missing_object_status" = "3" ] \
    || fail "absent recorded database was not distinguished from an OID collision"
if aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-owned" aurora aurora \
    /var/lib/postgresql/17/main 5432 7612345678901234567 query-failed 16385; then
    fail "malformed/failed current OID probe was treated as an absent object"
fi
head -n 5 "$TMP_ROOT/db-owned" > "$TMP_ROOT/db-legacy-five"
legacy_status=0
aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-legacy-five" aurora aurora \
    /var/lib/postgresql/17/main 5432 7612345678901234567 16384 16385 \
    || legacy_status=$?
[ "$legacy_status" = "2" ] \
    || fail "matching five-line PostgreSQL marker should require explicit legacy adoption"
head -n 4 "$TMP_ROOT/db-owned" > "$TMP_ROOT/db-legacy"
legacy_status=0
aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-legacy" aurora aurora \
    /var/lib/postgresql/17/main 5432 7612345678901234567 16384 16385 \
    || legacy_status=$?
[ "$legacy_status" = "2" ] \
    || fail "matching four-line PostgreSQL marker should require explicit legacy adoption"
printf '%s\n' unexpected >> "$TMP_ROOT/db-owned"
if aurora_db_ownership_marker_status \
    "$TMP_ROOT/db-owned" aurora aurora \
    /var/lib/postgresql/17/main 5432 7612345678901234567 16384 16385; then
    fail "malformed PostgreSQL ownership marker was accepted"
fi

for unsafe in \
    / /home /home/alice /etc /var /usr /root/secret /var/lib/aurora/source \
    /var/lib/plex /var/log/archive /var/backups/media /var/spool/jobs \
    /var/cache/posters /var/tmp/media /home/alice/.ssh/media \
    /home/alice/.config/aurora /home/alice/.private/movies \
    /opt/aurora /tmp/aurora-transcode relative/path; do
    assert_unsafe_media "$unsafe"
done
assert_safe_media /srv/media
assert_safe_media "/home/alice/My Media"
assert_safe_media /mnt/nas/media
assert_safe_media /var/media

cat > "$TMP_ROOT/managed.conf" <<'EOF'
# Aurora — managed by setup-domain.sh
server {}
EOF
cat > "$TMP_ROOT/legacy.conf" <<'EOF'
# Aurora — managed by install.sh
server {}
EOF
cat > "$TMP_ROOT/operator.conf" <<'EOF'
# operator-owned reverse proxy
server {}
EOF
aurora_proxy_config_is_managed "$TMP_ROOT/managed.conf" \
    || fail "new managed proxy header not detected"
aurora_proxy_config_is_managed "$TMP_ROOT/legacy.conf" \
    || fail "legacy managed proxy header not detected"
if aurora_proxy_config_is_managed "$TMP_ROOT/operator.conf"; then
    fail "operator proxy config was claimed as Aurora-managed"
fi

printf '%s\n' 'media.example.com' > "$TMP_ROOT/proxy-removed"
printf '%s\n%s\n' 'media.example.com' 'media.example.com' \
    > "$TMP_ROOT/proxy-cert-owned"
[ "$(
    aurora_read_proxy_domain_state \
        "$TMP_ROOT/missing-active" "$TMP_ROOT/proxy-removed" \
        "$TMP_ROOT/proxy-cert-owned"
)" = "media.example.com" ] || fail "safe-uninstall proxy tombstone was not discovered"
printf '%s\n' 'bad domain value' > "$TMP_ROOT/proxy-setup"
[ "$(
    aurora_read_proxy_domain_state \
        "$TMP_ROOT/proxy-setup" "$TMP_ROOT/proxy-removed" \
        "$TMP_ROOT/proxy-cert-owned"
)" = "media.example.com" ] || fail "malformed active marker did not fall back safely"

aurora_certificate_delete_is_safe \
    media.example.com media.example.com media.example.com \
    media.example.com media.example.com \
    || fail "exclusive Aurora-owned certificate should be deletable"
if aurora_certificate_delete_is_safe \
    media.example.com media.example.com media.example.com \
    "media.example.com other.example.com" media.example.com; then
    fail "multi-domain certificate was considered safe to delete"
fi
if aurora_certificate_delete_is_safe \
    "" media.example.com media.example.com media.example.com media.example.com; then
    fail "unowned certificate was considered safe to delete"
fi

export AURORA_UNINSTALL_LIBRARY_ONLY=1
# shellcheck source=../uninstall.sh
# shellcheck disable=SC1091
. "$PROJECT_ROOT/scripts/uninstall.sh"
unset AURORA_UNINSTALL_LIBRARY_ONLY

cat > "$TMP_ROOT/db-drop-owned" <<'EOF'
aurora
aurora
/var/lib/postgresql/17/main
5432
7612345678901234567
16384
16385
EOF
MOCK_PSQL_EXIT=0
# shellcheck disable=SC2329 # invoked by sourced guarded-DDL helpers
sudo() {
    printf '%s\n' "$*" > "$TMP_ROOT/mock-psql.args"
    cat > "$TMP_ROOT/mock-psql.sql"
    return "$MOCK_PSQL_EXIT"
}
aurora_psql_drop_owned_database \
    "$TMP_ROOT/db-drop-owned" aurora aurora \
    || fail "guarded database drop did not invoke the mocked psql lifecycle"
grep -Fq -- '--set=expected_system_identifier=7612345678901234567' \
    "$TMP_ROOT/mock-psql.args" \
    || fail "database drop did not bind the marker's PostgreSQL system identifier"
grep -Fq -- '--set=expected_db_oid=16384' "$TMP_ROOT/mock-psql.args" \
    || fail "database drop did not bind the recorded database OID"
grep -Fq -- '--set=expected_role_oid=16385' "$TMP_ROOT/mock-psql.args" \
    || fail "database drop did not bind the recorded role OID"
[ "$(grep -Fc 'd.oid::text' "$TMP_ROOT/mock-psql.sql")" -eq 2 ] \
    && [ "$(grep -Fc 'r.oid::text' "$TMP_ROOT/mock-psql.sql")" -eq 2 ] \
    || fail "database/owner OIDs were not rechecked immediately before drop"
grep -Fq 'DROP DATABASE :"expected_db";' "$TMP_ROOT/mock-psql.sql" \
    || fail "database DDL is no longer coupled to its psql ownership guards"
if grep -Eq '(^|[[:space:]])(sleep|dropdb)([[:space:]]|$)' \
    "$TMP_ROOT/mock-psql.sql"; then
    fail "database teardown regressed to a separate sleep/dropdb boundary"
fi

aurora_psql_drop_owned_role \
    "$TMP_ROOT/db-drop-owned" aurora \
    || fail "guarded role drop did not invoke the mocked psql lifecycle"
grep -Fq 'pg_control_system()' "$TMP_ROOT/mock-psql.sql" \
    || fail "role drop no longer revalidates the PostgreSQL cluster"
grep -Fq "oid::text = :'expected_role_oid'" "$TMP_ROOT/mock-psql.sql" \
    || fail "role drop no longer proves same-object continuity"
grep -Fq 'DROP ROLE :"expected_role";' "$TMP_ROOT/mock-psql.sql" \
    || fail "role DDL is no longer coupled to its psql ownership guard"
MOCK_PSQL_EXIT=1
if aurora_psql_drop_owned_role \
    "$TMP_ROOT/db-drop-owned" aurora; then
    fail "guarded role drop ignored a psql validation/DDL failure"
fi
unset -f sudo

cat > "$TMP_ROOT/nginx-external-cert.dump" <<'EOF'
# configuration file /etc/nginx/nginx.conf:
events {}
# configuration file /etc/nginx/conf.d/operator-media.conf:
server {
    server_name other.example.com;
    ssl_certificate /etc/letsencrypt/live/media.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/media.example.com/privkey.pem;
}
EOF
consumer="$(
    aurora_nginx_dump_certificate_consumer \
        "$TMP_ROOT/nginx-external-cert.dump" \
        media.example.com media.example.com
)" || fail "operator certificate-path consumer was not detected"
case "$consumer" in
    /etc/nginx/conf.d/operator-media.conf:*) ;;
    *) fail "certificate consumer did not identify its active nginx config" ;;
esac

cat > "$TMP_ROOT/nginx-external-domain.dump" <<'EOF'
# configuration file /etc/nginx/conf.d/replacement.conf:
server {
    server_name
        media.example.com
        alias.example.com;
    ssl_certificate /etc/ssl/operator/fullchain.pem;
}
EOF
aurora_nginx_dump_certificate_consumer \
    "$TMP_ROOT/nginx-external-domain.dump" \
    media.example.com media.example.com >/dev/null \
    || fail "multiline operator server_name consumer was not detected"

cat > "$TMP_ROOT/nginx-unrelated.dump" <<'EOF'
# configuration file /etc/nginx/conf.d/unrelated.conf:
server {
    server_name notmedia.example.com;
    ssl_certificate /etc/letsencrypt/live/unrelated.example.com/fullchain.pem;
}
EOF
if aurora_nginx_dump_certificate_consumer \
    "$TMP_ROOT/nginx-unrelated.dump" \
    media.example.com media.example.com >/dev/null; then
    fail "unrelated active nginx config blocked certificate deletion"
fi
# shellcheck disable=SC2016 # matching a literal command substitution in source
grep -Fq 'PROXY_ROLLBACK_DIR="$(umask 077; mktemp -d)"' \
    "$PROJECT_ROOT/scripts/uninstall.sh" \
    || fail "nginx teardown no longer snapshots managed proxy files"
grep -Fq 'record_proxy_failure' "$PROJECT_ROOT/scripts/uninstall.sh" \
    || fail "nginx teardown no longer records transactional failure"
# shellcheck disable=SC2016 # matching a literal variable reference in source
grep -Fq 'DB_RECOVERY_MARKER="$INSTALLER_LIB_DIR/db-recovery-pending"' \
    "$PROJECT_ROOT/scripts/uninstall.sh" \
    || fail "uninstaller no longer blocks teardown during PostgreSQL recovery"
grep -Fq 'systemctl reload nginx >/dev/null 2>&1' \
    "$PROJECT_ROOT/scripts/uninstall.sh" \
    || fail "nginx teardown no longer gates active-proxy reload"

grep -Fq 'CROSS JOIN LATERAL unnest(paths)' "$PROJECT_ROOT/scripts/install.sh" \
    || fail "installer no longer replays libraries.paths from retained PostgreSQL"
# shellcheck disable=SC2016 # matching literal installer variables in source
grep -Fq 'begin_db_recovery "$ROLE_EXISTS" "$EXISTING_DB_URL"' \
    "$PROJECT_ROOT/scripts/install.sh" \
    || fail "database creation no longer starts with durable recovery intent"
grep -Fq 'COMMENT ON ROLE :"expected_role" IS :' \
    "$PROJECT_ROOT/scripts/install.sh" \
    || fail "recreated roles no longer carry nonce-bound recovery provenance"
grep -Fq 'COMMENT ON DATABASE :"temp_database" IS :' \
    "$PROJECT_ROOT/scripts/install.sh" \
    || fail "recreated databases no longer carry nonce-bound recovery provenance"
grep -Fq 'psql_with_stdin_password "$RECOVERY_PASSWORD"' \
    "$PROJECT_ROOT/scripts/install.sh" \
    || fail "recovery password is no longer delivered to psql over protected stdin"
if grep -Eq -- '--set=(recovery_)?password=|PASSWORD.*\\$DB_PASSWORD' \
    "$PROJECT_ROOT/scripts/install.sh"; then
    fail "PostgreSQL password regressed into a process argument"
fi
recovery_body="$(
    sed -n '/^resume_db_recovery() {$/,/^}$/p' \
        "$PROJECT_ROOT/scripts/install.sh"
)"
recovery_env_line="$(
    # shellcheck disable=SC2016 # matching literal installer variables in source
    grep -nF 'aurora_env_upsert "$CONFIG_DIR/aurora.env" DATABASE_URL "$RECOVERY_DB_URL"' \
        <<< "$recovery_body" | cut -d: -f1
)"
recovery_marker_line="$(
    # shellcheck disable=SC2016 # matching literal installer variables in source
    grep -nF 'write_db_ownership_marker \' \
        <<< "$recovery_body" | cut -d: -f1
)"
recovery_done_line="$(
    # shellcheck disable=SC2016 # matching literal installer variables in source
    grep -nF 'rm -f "$DB_RECOVERY_MARKER"' <<< "$recovery_body" \
        | cut -d: -f1
)"
[ -n "$recovery_env_line" ] \
    && [ -n "$recovery_marker_line" ] \
    && [ -n "$recovery_done_line" ] \
    && [ "$recovery_env_line" -lt "$recovery_marker_line" ] \
    && [ "$recovery_marker_line" -lt "$recovery_done_line" ] \
    || fail "database recovery no longer keeps pending state through credential/OID convergence"
# shellcheck disable=SC2016 # matching a literal variable reference in source
grep -Fq 'MANAGED_MEDIA_PATHS_FILE="$INSTALLER_LIB_DIR/managed-media-paths"' \
    "$PROJECT_ROOT/scripts/install.sh" \
    || fail "installer no longer records durable media ACL recovery roots"
# shellcheck disable=SC2016 # matching a literal variable reference in source
grep -Fq 'MANAGED_MEDIA_PATHS_FILE="$INSTALLER_LIB_DIR/managed-media-paths"' \
    "$PROJECT_ROOT/scripts/uninstall.sh" \
    || fail "uninstaller no longer consumes durable media ACL recovery roots"
for lifecycle_script in \
    "$PROJECT_ROOT/scripts/install.sh" \
    "$PROJECT_ROOT/scripts/setup-domain.sh" \
    "$PROJECT_ROOT/scripts/uninstall.sh"; do
    grep -Fq 'DEPLOY_LOCK_DIR="/run/aurora"' "$lifecycle_script" \
        || fail "${lifecycle_script##*/} no longer uses the protected runtime lock directory"
    if grep -Fq '/var/lock/aurora-deploy.lock' "$lifecycle_script"; then
        fail "${lifecycle_script##*/} regressed to the sticky /var/lock deploy lock"
    fi
done
# shellcheck disable=SC2016 # matching a literal variable reference in source
grep -Fq 'chown -R root:root "$UPDATER_SOURCE_DIR"' \
    "$PROJECT_ROOT/scripts/install.sh" \
    || fail "managed private source is no longer hardened to root ownership"
# shellcheck disable=SC2016 # matching a literal variable reference in source
grep -Fq 'chmod -R go-rwx "$UPDATER_SOURCE_DIR"' \
    "$PROJECT_ROOT/scripts/install.sh" \
    || fail "managed private source is no longer root-only"
# shellcheck disable=SC2016 # matching literal nginx variables in source
grep -Fq 'proxy_set_header X-Forwarded-For   \$remote_addr;' \
    "$PROJECT_ROOT/scripts/setup-domain.sh" \
    || fail "managed nginx must overwrite client-supplied X-Forwarded-For"
# shellcheck disable=SC2016 # matching literal nginx variables in source
if grep -Fq 'proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;' \
    "$PROJECT_ROOT/scripts/setup-domain.sh"; then
    fail "managed nginx still appends client-supplied X-Forwarded-For"
fi

echo "install-state tests passed"
