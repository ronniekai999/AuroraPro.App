#!/usr/bin/env bash
#
# Pure installer/uninstaller state helpers. Keep this file free of side effects
# so the safety decisions can be exercised without root privileges.

aurora_trim_horizontal_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:blank:]]*}"}"
    value="${value%"${value##*[![:blank:]]}"}"
    printf '%s\n' "$value"
}

aurora_database_url_is_local_database() {
    local url="$1" expected_db="$2" rest authority database hostport query
    local userinfo username parameter
    case "$url" in
        postgres://*|postgresql://*) ;;
        *) return 1 ;;
    esac

    rest="${url#*://}"
    authority="${rest%%/*}"
    [ "$authority" != "$rest" ] || return 1
    rest="${rest#*/}"
    database="${rest%%\?*}"
    case "$database" in
        */*) return 1 ;;
    esac
    [ "$database" = "$expected_db" ] || return 1

    query=""
    case "$rest" in
        *\?*) query="${rest#*\?}" ;;
    esac
    if [ -n "$query" ]; then
        local old_ifs="$IFS"
        IFS='&'
        for parameter in $query; do
            case "$parameter" in
                host=*|hostaddr=*|port=*|user=*|dbname=*|service=*)
                    IFS="$old_ifs"
                    return 1
                    ;;
            esac
        done
        IFS="$old_ifs"
    fi

    # Installer-owned URLs always name the aurora role explicitly. Passwords
    # may contain percent-encoded @, but never a literal one.
    case "$authority" in
        *@*) ;;
        *) return 1 ;;
    esac
    userinfo="${authority%@*}"
    username="${userinfo%%:*}"
    [ "$username" = "$expected_db" ] || return 1

    hostport="${authority##*@}"
    case "$hostport" in
        ""|localhost|localhost:5432|127.0.0.1|127.0.0.1:5432|\
        '[::1]'|'[::1]:5432')
            return 0
            ;;
    esac
    return 1
}

# Compare a durable PostgreSQL ownership marker with the running cluster.
#
# Marker format:
#   1 database name
#   2 role name
#   3 data_directory
#   4 port
#   5 immutable system_identifier from pg_control_system()
#   6 database OID
#   7 role OID
#
# Return 2 for deliberate four/five-line legacy formats whose available
# cluster fields still match. Callers must require explicit adoption before
# replacing those markers. Return 3 when a seven-line marker matches the
# cluster and every still-present object, but one or both recorded objects are
# absent; an installer may recreate the missing object and atomically refresh
# its OID. A present object with a different OID always returns 1.
aurora_db_ownership_marker_status() {
    local marker="$1" expected_db="$2" expected_role="$3"
    local current_data="$4" current_port="$5" current_system_identifier="$6"
    local current_db_oid="$7" current_role_oid="$8"
    local marker_db marker_role marker_data marker_port
    local marker_system_identifier marker_db_oid marker_role_oid line_count

    [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
    [ -n "$current_data" ] \
        && [ -n "$current_port" ] \
        && [ -n "$current_system_identifier" ] \
        || return 1
    case "$current_system_identifier" in
        *[!0-9]*) return 1 ;;
    esac

    line_count="$(awk 'END { print NR }' "$marker" 2>/dev/null)" || return 1
    case "$line_count" in
        4|5|7) ;;
        *) return 1 ;;
    esac

    marker_db="$(sed -n '1p' "$marker" 2>/dev/null)" || return 1
    marker_role="$(sed -n '2p' "$marker" 2>/dev/null)" || return 1
    marker_data="$(sed -n '3p' "$marker" 2>/dev/null)" || return 1
    marker_port="$(sed -n '4p' "$marker" 2>/dev/null)" || return 1
    [ "$marker_db" = "$expected_db" ] \
        && [ "$marker_role" = "$expected_role" ] \
        && [ "$marker_data" = "$current_data" ] \
        && [ "$marker_port" = "$current_port" ] \
        || return 1

    [ "$line_count" != "4" ] || return 2
    marker_system_identifier="$(sed -n '5p' "$marker" 2>/dev/null)" \
        || return 1
    case "$marker_system_identifier" in
        ""|*[!0-9]*) return 1 ;;
    esac
    [ "$marker_system_identifier" = "$current_system_identifier" ] \
        || return 1
    [ "$line_count" = "7" ] || return 2

    marker_db_oid="$(sed -n '6p' "$marker" 2>/dev/null)" || return 1
    marker_role_oid="$(sed -n '7p' "$marker" 2>/dev/null)" || return 1
    case "$marker_db_oid" in
        ""|*[!0-9]*) return 1 ;;
    esac
    case "$marker_role_oid" in
        ""|*[!0-9]*) return 1 ;;
    esac
    case "$current_db_oid" in
        "") ;;
        *[!0-9]*) return 1 ;;
        *) [ "$current_db_oid" = "$marker_db_oid" ] || return 1 ;;
    esac
    case "$current_role_oid" in
        "") ;;
        *[!0-9]*) return 1 ;;
        *) [ "$current_role_oid" = "$marker_role_oid" ] || return 1 ;;
    esac
    if [ -z "$current_db_oid" ] || [ -z "$current_role_oid" ]; then
        return 3
    fi
    return 0
}

aurora_media_root_rejection_reason() {
    local path="$1"
    case "$path" in
        "")
            printf '%s\n' "path is empty"
            return 0
            ;;
        *$'\n'*|*$'\r'*)
            printf '%s\n' "path contains a newline"
            return 0
            ;;
        /*) ;;
        *)
            printf '%s\n' "path is not absolute"
            return 0
            ;;
    esac

    # Never recurse across a whole operating-system tree. These paths are far
    # broader than a media library, and setfacl/chmod here could expose secrets
    # or alter executable/system state. Narrow children such as /srv/media,
    # /mnt/nas, /home/alice/videos, and /var/media remain valid.
    case "$path" in
        /var/media|/var/media/*) ;;
        /var/*)
            printf '%s\n' "path is outside the dedicated /var/media tree"
            return 0
            ;;
    esac
    case "$path" in
        /|/bin|/boot|/dev|/etc|/home|/lib|/lib32|/lib64|/media|/mnt|/opt|\
        /proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
            printf '%s\n' "path is a broad system root"
            return 0
            ;;
        /bin/*|/boot/*|/dev/*|/etc/*|/lib/*|/lib32/*|/lib64/*|/proc/*|\
        /root/*|/run/*|/sbin/*|/sys/*|/usr/*|\
        /opt/aurora|/opt/aurora/*|/tmp/aurora-transcode|\
        /tmp/aurora-transcode/*)
            printf '%s\n' "path overlaps protected system or Aurora state"
            return 0
            ;;
    esac
    case "$path" in
        /home/*)
            local home_relative home_child
            home_relative="${path#/home/}"
            if [[ "$home_relative" != */* ]]; then
                printf '%s\n' "path is an entire user home"
                return 0
            fi
            home_child="${home_relative#*/}"
            case "$home_child" in
                .*)
                    printf '%s\n' "path overlaps a sensitive hidden home directory"
                    return 0
                    ;;
            esac
            ;;
    esac
    return 1
}

aurora_proxy_config_is_managed() {
    local file="$1"
    [ -f "$file" ] || return 1
    grep -Fq '# Aurora — managed by setup-domain.sh' "$file" \
        || grep -Fq '# Aurora — managed by install.sh' "$file"
}

aurora_proxy_domain_is_valid() {
    printf '%s\n' "$1" \
        | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$'
}

aurora_read_proxy_domain_state() {
    local active_marker="$1" removed_marker="$2" cert_owner_marker="$3"
    local file line candidate
    for file in "$active_marker:1" "$removed_marker:1" "$cert_owner_marker:2"; do
        line="${file##*:}"
        file="${file%:*}"
        [ -f "$file" ] || continue
        candidate="$(sed -n "${line}p" "$file" 2>/dev/null | tr -d '\r' || true)"
        if aurora_proxy_domain_is_valid "$candidate"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

aurora_certificate_delete_is_safe() {
    local owned_name="$1" owned_domain="$2" cert_name="$3"
    local cert_domains="$4" proxy_domain="$5"
    [ -n "$owned_name" ] \
        && [ "$owned_name" = "$cert_name" ] \
        && [ "$owned_domain" = "$proxy_domain" ] \
        && [ "$cert_domains" = "$proxy_domain" ]
}
