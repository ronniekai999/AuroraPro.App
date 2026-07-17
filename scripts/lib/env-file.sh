#!/usr/bin/env bash
#
# Small, non-evaluating helpers for Aurora's KEY=value environment file.
# These functions never source or eval the file: values are treated as data,
# which lets the installer preserve operator-defined and future settings safely.

aurora_fsync_file_and_parent() {
    local path="$1"
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$path" <<'PY'
import os
import sys

path = os.path.abspath(sys.argv[1])
fd = os.open(path, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)

parent = os.path.dirname(path) or "."
dirfd = os.open(parent, os.O_RDONLY)
try:
    os.fsync(dirfd)
finally:
    os.close(dirfd)
PY
}

aurora_fsync_directory() {
    local directory="$1"
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$directory" <<'PY'
import os
import sys

directory = os.path.abspath(sys.argv[1])
fd = os.open(directory, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

aurora_env_valid_key() {
    [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

aurora_env_has() {
    local file="$1" key="$2"
    aurora_env_valid_key "$key" || return 2
    [ -f "$file" ] || return 1
    ENV_KEY="$key" awk '
        BEGIN { prefix = ENVIRON["ENV_KEY"] "=" }
        index($0, prefix) == 1 { found = 1; exit }
        END { exit(found ? 0 : 1) }
    ' "$file"
}

aurora_env_get() {
    local file="$1" key="$2"
    aurora_env_valid_key "$key" || return 2
    [ -f "$file" ] || return 1
    ENV_KEY="$key" awk '
        BEGIN { prefix = ENVIRON["ENV_KEY"] "=" }
        index($0, prefix) == 1 {
            print substr($0, length(prefix) + 1)
            found = 1
            exit
        }
        END { if (!found) exit 1 }
    ' "$file"
}

aurora_env_get_unquoted() {
    local value
    value="$(aurora_env_get "$1" "$2")" || return
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    printf '%s\n' "$value"
}

aurora_env_upsert() {
    local file="$1" key="$2" value="$3" tmp
    aurora_env_valid_key "$key" || {
        printf 'invalid environment key: %s\n' "$key" >&2
        return 2
    }
    case "$value" in
        *$'\n'*|*$'\r'*)
            printf 'environment value for %s contains a newline\n' "$key" >&2
            return 2
            ;;
    esac

    if [ ! -f "$file" ]; then
        if ! (umask 077; : > "$file"); then
            return 1
        fi
    fi

    tmp="${file}.edit.$$"
    if ! (
        umask 077
        ENV_KEY="$key" ENV_VALUE="$value" awk '
            BEGIN {
                prefix = ENVIRON["ENV_KEY"] "="
                value = ENVIRON["ENV_VALUE"]
            }
            index($0, prefix) == 1 {
                if (!found) {
                    print prefix value
                    found = 1
                }
                next
            }
            { print }
            END {
                if (!found) print prefix value
            }
        ' "$file" > "$tmp"
    ); then
        rm -f "$tmp"
        return 1
    fi
    if ! mv -f "$tmp" "$file"; then
        rm -f "$tmp"
        return 1
    fi
    aurora_fsync_file_and_parent "$file"
}

aurora_env_ensure() {
    local file="$1" key="$2" default_value="$3"
    aurora_env_has "$file" "$key" && return 0
    aurora_env_upsert "$file" "$key" "$default_value"
}
