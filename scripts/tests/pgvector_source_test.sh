#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$PROJECT_ROOT/scripts/install.sh"

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

read_constant() {
    local name="$1"
    sed -n "s/^${name}=\"\\([^\"]*\\)\"$/\\1/p" "$INSTALLER"
}

version="$(read_constant PGVECTOR_VERSION)"
expected="$(read_constant PGVECTOR_SHA256)"

[ -n "$version" ] || fail "PGVECTOR_VERSION is missing"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "PGVECTOR_VERSION is not a release version"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] \
    || fail "PGVECTOR_SHA256 is not a lowercase SHA256"

grep -Fq "apt_package_available \"\$apt_pgvector_package\"" "$INSTALLER" \
    || fail "apt package preference is missing"
grep -Fq "install_pgvector_from_source \"\$pg_major\"" "$INSTALLER" \
    || fail "apt source fallback is missing"
grep -Fq "PG_CONFIG=\"\$pg_config\"" "$INSTALLER" \
    || fail "source build is not pinned to the running PostgreSQL major"

if [ "${AURORA_TEST_NETWORK:-0}" = "1" ]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    archive="$tmp/pgvector.tar.gz"
    listing="$tmp/archive-files.txt"
    url="https://github.com/pgvector/pgvector/archive/refs/tags/v${version}.tar.gz"

    curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$archive"
    actual="$(sha256sum "$archive" | awk '{print $1}')"
    [ "$actual" = "$expected" ] \
        || fail "pgvector v${version} archive checksum changed: $actual"
    tar -tzf "$archive" > "$listing"
    grep -Fqx "pgvector-${version}/Makefile" "$listing" \
        || fail "pgvector archive is missing Makefile"
    grep -Fqx "pgvector-${version}/vector.control" "$listing" \
        || fail "pgvector archive is missing vector.control"
fi

printf 'pgvector source fallback checks passed (v%s)\n' "$version"
