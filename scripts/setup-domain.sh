#!/usr/bin/env bash
# Aurora — one-shot domain + HTTPS setup.
#
# Maps https://<your-domain> to the local Aurora server on :8484
# and provisions a Let's Encrypt cert via certbot --nginx.
#
# Tries TWO paths in order:
#   1. If an aurora.conf already exists (from install.sh's AURORA_DOMAIN
#      flow), add the new domain to its server_name and request a cert
#      that covers it.
#   2. Otherwise, create a fresh aurora.conf from scratch, mirroring
#      the layout install.sh produces.
#
# Idempotent: safe to re-run. If the domain is already configured,
# the script just ensures the cert is current.
#
# Usage:
#   sudo DOMAIN=aurorapro.app EMAIL=you@example.com ./scripts/setup-domain.sh
#
# Or pass interactively:
#   sudo ./scripts/setup-domain.sh
#   → prompts for domain + email if env vars are unset
#
# Prereqs: DNS A record for <domain> must already point to this server's
# public IP, and ports 80 + 443 must be open. Certbot validates via the
# HTTP-01 challenge by serving a token at /.well-known/acme-challenge/.

set -euo pipefail

INSTALLER_STATE_DIR="/usr/local/lib/aurora-installer"
PROXY_CERT_DURABLE_MARKER="$INSTALLER_STATE_DIR/proxy-cert-ownership"
DEPLOY_LOCK_DIR="/run/aurora"
DEPLOY_LOCK_FILE="$DEPLOY_LOCK_DIR/deploy.lock"

# Non-evaluating env merge helpers shared with the main installer.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lib/env-file.sh" ]; then
    # shellcheck source=lib/env-file.sh
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/lib/env-file.sh"
fi
if [ -f "$SCRIPT_DIR/lib/install-state.sh" ]; then
    # shellcheck source=lib/install-state.sh
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/lib/install-state.sh"
fi

# ── Helpers ──────────────────────────────────────────────────────
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit "${2:-1}"; }
step()  { printf '\n\033[1;35m▸ %s\033[0m\n\n' "$1"; }

# ── Preflight ────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    error "Run as root (sudo)."
fi

case "$(uname -s)" in
    Linux) ;;
    *) error "Linux only — this script provisions nginx + certbot." 4 ;;
esac
[ ! -L /etc/aurora ] \
    || error "/etc/aurora is a symlink; refusing proxy/config mutation." 4
[ ! -L "$INSTALLER_STATE_DIR" ] \
    || error "$INSTALLER_STATE_DIR is a symlink; refusing ownership-state mutation." 4

# ── Resolve domain + email ───────────────────────────────────────
DOMAIN="${DOMAIN:-${AURORA_DOMAIN:-}}"
EMAIL="${EMAIL:-${AURORA_CERTBOT_EMAIL:-}}"

if [ -z "$DOMAIN" ]; then
    printf '\033[1;36m[?]\033[0m Domain (e.g. aurorapro.app): '
    read -r DOMAIN
fi
if [ -z "$EMAIL" ]; then
    printf '\033[1;36m[?]\033[0m Email for Let'\''s Encrypt registration: '
    read -r EMAIL
fi

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    error "DOMAIN and EMAIL are both required."
fi
case "$DOMAIN" in
    *$'\n'*|*$'\r'*) error "DOMAIN contains an invalid newline." ;;
esac
case "$EMAIL" in
    *$'\n'*|*$'\r'*) error "EMAIL contains an invalid newline." ;;
esac

# Strict domain sanity: per-label check. Rejects empty labels
# (`example..com`), labels ending in hyphen (`x-.com`), and trailing
# dots (`example.com.`). Each label is 1-63 alnum chars with optional
# interior hyphens; final TLD must be ≥2 letters.
if ! echo "$DOMAIN" | grep -qE '^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'; then
    error "Domain '$DOMAIN' looks malformed."
fi
# Basic email sanity.
if ! echo "$EMAIL" | grep -qE '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
    error "Email '$EMAIL' looks malformed."
fi

echo ""
echo "  ════════════════════════════════════════════════════════════"
echo "   Aurora — Domain + HTTPS setup"
echo "  ════════════════════════════════════════════════════════════"
echo "  Domain:         $DOMAIN"
echo "  Cert contact:   $EMAIL"
echo "  Backend:        http://127.0.0.1:8484"
echo "  ════════════════════════════════════════════════════════════"
echo ""

# ── Install nginx + certbot if missing ───────────────────────────
step "Step 1/5: nginx + certbot prerequisites"

APT_UPDATED=false
PACMAN_UPDATED=false
pkg_install() {
    if command -v apt-get &>/dev/null; then
        if ! $APT_UPDATED; then
            apt-get update -qq
            APT_UPDATED=true
        fi
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
    elif command -v dnf &>/dev/null; then
        dnf install -y -q "$@"
    elif command -v yum &>/dev/null; then
        yum install -y -q "$@"
    elif command -v pacman &>/dev/null; then
        if ! $PACMAN_UPDATED; then
            pacman -Syu --noconfirm
            PACMAN_UPDATED=true
        fi
        local -a pacman_packages=()
        local package
        for package in "$@"; do
            case "$package" in
                python3) pacman_packages+=(python) ;;
                *) pacman_packages+=("$package") ;;
            esac
        done
        pacman -S --needed --noconfirm "${pacman_packages[@]}"
    elif command -v zypper &>/dev/null; then
        zypper --quiet --non-interactive install --no-recommends "$@"
    else
        error "No supported package manager found."
    fi
}

# Serialize standalone proxy changes with installs, updates, and redeploys.
# The full installer already owns this lock and exports the marker before
# invoking us, so that integrated path must not reacquire its inherited lock.
DEPLOY_LOCK_FD=""
prepare_deploy_lock_file() {
    local owner group mode
    if [ -L "$DEPLOY_LOCK_DIR" ]; then
        error "$DEPLOY_LOCK_DIR is a symlink; refusing unsafe lock acquisition."
    fi
    if [ -e "$DEPLOY_LOCK_DIR" ]; then
        [ -d "$DEPLOY_LOCK_DIR" ] \
            || error "$DEPLOY_LOCK_DIR exists but is not a directory."
        owner="$(stat -c '%u' -- "$DEPLOY_LOCK_DIR")"
        group="$(stat -c '%g' -- "$DEPLOY_LOCK_DIR")"
        mode="$(stat -c '%a' -- "$DEPLOY_LOCK_DIR")"
        [ "$owner" = "0" ] && [ "$group" = "0" ] \
            || error "$DEPLOY_LOCK_DIR must be owned by root:root."
        (( (8#$mode & 0022) == 0 )) \
            || error "$DEPLOY_LOCK_DIR must not be group/other writable."
        chmod 0755 "$DEPLOY_LOCK_DIR"
    else
        install -d -m 0755 -o root -g root "$DEPLOY_LOCK_DIR"
    fi

    [ ! -L "$DEPLOY_LOCK_FILE" ] \
        || error "$DEPLOY_LOCK_FILE is a symlink; refusing unsafe lock acquisition."
    if [ -e "$DEPLOY_LOCK_FILE" ]; then
        [ -f "$DEPLOY_LOCK_FILE" ] \
            || error "$DEPLOY_LOCK_FILE exists but is not a regular file."
        owner="$(stat -c '%u' -- "$DEPLOY_LOCK_FILE")"
        group="$(stat -c '%g' -- "$DEPLOY_LOCK_FILE")"
        mode="$(stat -c '%a' -- "$DEPLOY_LOCK_FILE")"
        [ "$owner" = "0" ] && [ "$group" = "0" ] \
            || error "$DEPLOY_LOCK_FILE must be owned by root:root."
        (( (8#$mode & 0022) == 0 )) \
            || error "$DEPLOY_LOCK_FILE must not be group/other writable."
        chmod 0644 "$DEPLOY_LOCK_FILE"
    else
        install -m 0644 -o root -g root /dev/null "$DEPLOY_LOCK_FILE"
    fi
}

if [ "${AURORA_DEPLOY_LOCK_HELD:-0}" != "1" ]; then
    if ! command -v flock >/dev/null 2>&1; then
        info "Installing util-linux for safe deploy coordination..."
        pkg_install util-linux
    fi
    command -v flock >/dev/null 2>&1 \
        || error "flock is required. Install util-linux, then re-run this script."
    prepare_deploy_lock_file
    exec {DEPLOY_LOCK_FD}<>"$DEPLOY_LOCK_FILE"
    flock -n "$DEPLOY_LOCK_FD" \
        || error "Aurora is currently installing, updating, redeploying, or changing proxy settings. Wait for it to finish."
    export AURORA_DEPLOY_LOCK_HELD=1
fi

if ! command -v curl &>/dev/null; then
    info "Installing curl..."
    pkg_install curl
fi
if ! command -v python3 &>/dev/null; then
    info "Installing python3 for strict Aurora health validation..."
    pkg_install python3
fi

if ! command -v nginx &>/dev/null; then
    info "Installing nginx..."
    pkg_install nginx
fi
ok "nginx: $(nginx -v 2>&1 | awk -F/ '{print $2}')"

# Install certbot + nginx plugin. Important: these are SEPARATE
# packages — `apt install certbot` does NOT pull in the nginx plugin
# automatically. The original version of this script gated the WHOLE
# install block on `command -v certbot`, so if certbot was already
# installed (via a prior install.sh run or distro defaults), the nginx
# plugin install was skipped and `certbot --nginx` would fail with
# "The requested nginx plugin does not appear to be installed."
# Now: install certbot if missing, AND ALWAYS ensure the nginx plugin.
# `pkg_install` is idempotent (apt/dnf/etc treat "already installed"
# as a no-op success), so this is cheap to always run.
if ! command -v certbot &>/dev/null; then
    info "Installing certbot..."
    if command -v zypper >/dev/null 2>&1; then
        pkg_install python3-certbot
    else
        pkg_install certbot
    fi
fi

info "Ensuring certbot nginx plugin is installed..."
if   command -v apt-get &>/dev/null;  then pkg_install python3-certbot-nginx
elif command -v dnf     &>/dev/null;  then pkg_install python3-certbot-nginx
elif command -v yum     &>/dev/null;  then pkg_install python3-certbot-nginx
elif command -v pacman  &>/dev/null;  then pkg_install certbot-nginx
elif command -v zypper  &>/dev/null;  then pkg_install python3-certbot-nginx
fi

# Sanity check: even after the install, verify the plugin is loadable
# by certbot. If `certbot plugins` doesn't list `nginx`, fail fast
# with an actionable message rather than letting the user discover
# this via the Step 5 cert-issuance failure.
if ! certbot plugins 2>/dev/null | grep -qE '^[[:space:]]*\* nginx'; then
    error "certbot nginx plugin is installed but not visible to certbot. Try:
  sudo apt-get install --reinstall python3-certbot-nginx
  certbot plugins  # should list '* nginx'
Then re-run this script." 1
fi
ok "certbot + nginx plugin ready"

# ── Detect existing aurora nginx config ──────────────────────────
step "Step 2/5: Detecting existing aurora nginx config"

# install.sh writes to one of these paths depending on distro layout.
EXISTING_CONF=""
NGINX_SITES_STYLE=false
if [ -f /etc/nginx/sites-available/aurora.conf ]; then
    EXISTING_CONF="/etc/nginx/sites-available/aurora.conf"
    NGINX_SITES_STYLE=true
elif [ -f /etc/nginx/conf.d/aurora.conf ]; then
    EXISTING_CONF="/etc/nginx/conf.d/aurora.conf"
fi

if [ -n "$EXISTING_CONF" ]; then
    ok "Found existing config: $EXISTING_CONF"
    EXISTING_CONF_MANAGED=false
    if declare -F aurora_proxy_config_is_managed >/dev/null 2>&1 \
        && aurora_proxy_config_is_managed "$EXISTING_CONF"; then
        EXISTING_CONF_MANAGED=true
    fi
    if $EXISTING_CONF_MANAGED; then
        # Aurora owns one hostname per managed vhost. Earlier revisions could
        # append domains and then save only the newest one in CORS/marker state,
        # leaving certificate, nginx, and application policy inconsistent.
        while IFS= read -r configured_domain; do
            [ -z "$configured_domain" ] && continue
            if [ "$configured_domain" != "$DOMAIN" ]; then
                error "Aurora's managed nginx vhost already owns '$configured_domain'.
Use that hostname, or remove the managed vhost with aurora-uninstall before configuring '$DOMAIN'." 2
            fi
        done < <(
            awk '
                /^[[:space:]]*server_name[[:space:]]+/ {
                    for (i = 2; i <= NF; i++) {
                        token = $i
                        terminal = (token ~ /;/)
                        sub(/;.*/, "", token)
                        if (token != "" && token != "_") print token
                        if (terminal) break
                    }
                }
            ' "$EXISTING_CONF" | sort -u
        )
        info "Aurora-managed vhosts use one hostname; validating '$DOMAIN'"
    else
        error "$EXISTING_CONF is operator-managed; refusing to edit or claim it.
Move/rename that file and rerun to let Aurora create aurora.conf, or configure
your proxy manually using docs/reverse-proxy/." 2
    fi
    NGINX_CONF_PATH="$EXISTING_CONF"
else
    info "No existing config — will create a fresh one"
    if [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
        NGINX_CONF_PATH="/etc/nginx/sites-available/aurora.conf"
        NGINX_SITES_STYLE=true
    else
        NGINX_CONF_PATH="/etc/nginx/conf.d/aurora.conf"
    fi
fi

# Refuse a hostname already claimed by any other active nginx vhost. Parsing
# `nginx -T` follows the server's real include graph (including custom include
# paths) and matches complete server_name tokens, not substrings.
NGINX_DUMP="$(mktemp)"
if ! nginx -T > "$NGINX_DUMP" 2>&1; then
    rm -f "$NGINX_DUMP"
    error "Existing nginx configuration is invalid; fix 'sudo nginx -t' before Aurora HTTPS setup." 2
fi
ALLOWED_ENABLED_CONF=""
if [ -L /etc/nginx/sites-enabled/aurora.conf ] \
    && [ "$(readlink -f /etc/nginx/sites-enabled/aurora.conf)" = "$(readlink -f "$NGINX_CONF_PATH" 2>/dev/null || true)" ]; then
    ALLOWED_ENABLED_CONF="/etc/nginx/sites-enabled/aurora.conf"
fi
DUPLICATE_DOMAIN_CONF="$(
    awk -v domain="$DOMAIN" -v managed="$NGINX_CONF_PATH" \
        -v enabled="$ALLOWED_ENABLED_CONF" '
        /^# configuration file .*:$/ {
            current = $0
            sub(/^# configuration file /, "", current)
            sub(/:$/, "", current)
            next
        }
        /^[[:space:]]*server_name[[:space:]]+/ {
            for (i = 2; i <= NF; i++) {
                token = $i
                terminal = (token ~ /;/)
                sub(/;.*/, "", token)
                if (token == domain && current != managed && current != enabled) {
                    print current
                    exit
                }
                if (terminal) break
            }
        }
    ' "$NGINX_DUMP"
)"
rm -f "$NGINX_DUMP"
[ -z "$DUPLICATE_DOMAIN_CONF" ] \
    || error "Domain '$DOMAIN' is already claimed by active nginx vhost $DUPLICATE_DOMAIN_CONF; refusing duplicate routing/certificate mutation." 2

# Snapshot every Aurora-managed file before nginx/certbot can rewrite it.
# Certificate issuance itself is intentionally not rolled back, but a failed
# run restores the prior vhost, map, site link, and application env so users
# are never left with a half-configured proxy or Secure-cookie mismatch.
ROLLBACK_DIR="$(umask 077; mktemp -d)"
PROXY_SETUP_COMMITTED=false
NGINX_STARTED_BY_SCRIPT=false
ENV_MUTATED=false
CONF_EXISTED=false
MAP_EXISTED=false
SITE_LINK_EXISTED=false
ENV_EXISTED=false
ACTIVE_MARKER_EXISTED=false
REMOVED_MARKER_EXISTED=false
CERT_OWNER_MARKER_EXISTED=false
DURABLE_REMOVAL_MARKER_EXISTED=false
DURABLE_CERT_MARKER_EXISTED=false

if [ -f "$NGINX_CONF_PATH" ]; then
    cp -a "$NGINX_CONF_PATH" "$ROLLBACK_DIR/aurora.conf"
    CONF_EXISTED=true
fi
if [ -e /etc/nginx/conf.d/aurora-map.conf ] || [ -L /etc/nginx/conf.d/aurora-map.conf ]; then
    cp -a /etc/nginx/conf.d/aurora-map.conf "$ROLLBACK_DIR/aurora-map.conf"
    MAP_EXISTED=true
fi
if [ -e /etc/nginx/sites-enabled/aurora.conf ] || [ -L /etc/nginx/sites-enabled/aurora.conf ]; then
    cp -a /etc/nginx/sites-enabled/aurora.conf "$ROLLBACK_DIR/sites-enabled-aurora.conf"
    SITE_LINK_EXISTED=true
fi
if [ -f /etc/aurora/aurora.env ]; then
    cp -a /etc/aurora/aurora.env "$ROLLBACK_DIR/aurora.env"
    ENV_EXISTED=true
fi
if [ -f /etc/aurora/.proxy-setup ]; then
    cp -a /etc/aurora/.proxy-setup "$ROLLBACK_DIR/proxy-setup"
    ACTIVE_MARKER_EXISTED=true
fi
if [ -f /etc/aurora/.proxy-removed ]; then
    cp -a /etc/aurora/.proxy-removed "$ROLLBACK_DIR/proxy-removed"
    REMOVED_MARKER_EXISTED=true
fi
if [ -f /etc/aurora/.proxy-cert-owned ]; then
    cp -a /etc/aurora/.proxy-cert-owned "$ROLLBACK_DIR/proxy-cert-owned"
    CERT_OWNER_MARKER_EXISTED=true
fi
if [ -f /usr/local/lib/aurora-installer/proxy-removal-provenance ]; then
    cp -a /usr/local/lib/aurora-installer/proxy-removal-provenance \
        "$ROLLBACK_DIR/proxy-removal-provenance"
    DURABLE_REMOVAL_MARKER_EXISTED=true
fi
if [ -f "$PROXY_CERT_DURABLE_MARKER" ]; then
    cp -a "$PROXY_CERT_DURABLE_MARKER" "$ROLLBACK_DIR/proxy-cert-ownership"
    DURABLE_CERT_MARKER_EXISTED=true
fi

rollback_proxy_setup() {
    local status=$?
    trap - EXIT
    if $PROXY_SETUP_COMMITTED; then
        rm -rf "$ROLLBACK_DIR"
        exit "$status"
    fi

    set +e
    warn "HTTPS setup did not complete; restoring the prior managed proxy state."
    if $CONF_EXISTED; then
        rm -f "$NGINX_CONF_PATH"
        cp -a "$ROLLBACK_DIR/aurora.conf" "$NGINX_CONF_PATH"
    else
        rm -f "$NGINX_CONF_PATH"
    fi
    if $MAP_EXISTED; then
        rm -f /etc/nginx/conf.d/aurora-map.conf
        cp -a "$ROLLBACK_DIR/aurora-map.conf" /etc/nginx/conf.d/aurora-map.conf
    else
        rm -f /etc/nginx/conf.d/aurora-map.conf
    fi
    if $SITE_LINK_EXISTED; then
        rm -f /etc/nginx/sites-enabled/aurora.conf
        cp -a "$ROLLBACK_DIR/sites-enabled-aurora.conf" \
            /etc/nginx/sites-enabled/aurora.conf
    else
        rm -f /etc/nginx/sites-enabled/aurora.conf
    fi
    if $ENV_MUTATED && $ENV_EXISTED; then
        rm -f /etc/aurora/aurora.env
        cp -a "$ROLLBACK_DIR/aurora.env" /etc/aurora/aurora.env
        systemctl restart aurora >/dev/null 2>&1 || true
    fi
    rm -f /etc/aurora/.proxy-setup /etc/aurora/.proxy-removed \
        /etc/aurora/.proxy-cert-owned
    $ACTIVE_MARKER_EXISTED \
        && cp -a "$ROLLBACK_DIR/proxy-setup" /etc/aurora/.proxy-setup
    $REMOVED_MARKER_EXISTED \
        && cp -a "$ROLLBACK_DIR/proxy-removed" /etc/aurora/.proxy-removed
    $CERT_OWNER_MARKER_EXISTED \
        && cp -a "$ROLLBACK_DIR/proxy-cert-owned" /etc/aurora/.proxy-cert-owned
    rm -f /usr/local/lib/aurora-installer/proxy-removal-provenance
    $DURABLE_REMOVAL_MARKER_EXISTED \
        && cp -a "$ROLLBACK_DIR/proxy-removal-provenance" \
            /usr/local/lib/aurora-installer/proxy-removal-provenance
    rm -f "$PROXY_CERT_DURABLE_MARKER"
    $DURABLE_CERT_MARKER_EXISTED \
        && cp -a "$ROLLBACK_DIR/proxy-cert-ownership" \
            "$PROXY_CERT_DURABLE_MARKER"
    if $NGINX_STARTED_BY_SCRIPT; then
        systemctl stop nginx >/dev/null 2>&1 || true
    elif command -v nginx >/dev/null 2>&1 \
        && nginx -t >/dev/null 2>&1 \
        && systemctl is-active nginx >/dev/null 2>&1; then
            systemctl reload nginx >/dev/null 2>&1 || true
    fi
    rm -rf "$ROLLBACK_DIR"
    exit "$status"
}
trap rollback_proxy_setup EXIT

# WebSocket upgrade map (shared by both paths). Idempotent: only
# write if no existing map for $http_upgrade exists anywhere.
# shellcheck disable=SC2016 # match literal nginx variable names
if ! grep -rq 'map.*\$http_upgrade.*\$connection_upgrade' \
        /etc/nginx/conf.d/ \
        /etc/nginx/sites-available/ \
        /etc/nginx/sites-enabled/ \
        2>/dev/null; then
    info "Writing WebSocket upgrade map..."
    cat > /etc/nginx/conf.d/aurora-map.conf <<'MAP'
# Aurora — WebSocket upgrade map for /ws
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP
fi

# ── Write or augment aurora.conf ────────────────────────────────
step "Step 3/5: nginx site config"

if [ -n "$EXISTING_CONF" ]; then
    # Managed vhosts are single-host. Usually the hostname is already present;
    # the edit path exists only as an upgrade bridge for an incomplete legacy
    # managed file that has no server_name value yet.
    DOMAIN_ESC="${DOMAIN//./\\.}"
    DOMAIN_RE="server_name[[:space:]]+([^;]*[[:space:]])?${DOMAIN_ESC}([[:space:]]|;)"
    if grep -qE "$DOMAIN_RE" "$EXISTING_CONF"; then
        ok "'$DOMAIN' is already in server_name — no edit needed"
    else
        info "Repairing the missing '$DOMAIN' server_name in $EXISTING_CONF..."
        sed -i -E "s/^([[:space:]]*)server_name[[:space:]]+([^;]+);/\1server_name \2 ${DOMAIN};/g" \
            "$EXISTING_CONF"
        if grep -qE "$DOMAIN_RE" "$EXISTING_CONF"; then
            EDITED=$(grep -cE "$DOMAIN_RE" "$EXISTING_CONF")
            ok "Added '$DOMAIN' to $EDITED server_name line(s)"
        else
            warn "Could not repair server_name automatically."
            error "Aborting before certbot to avoid a partial state." 2
        fi
    fi
    NGINX_CONF_PATH="$EXISTING_CONF"
else
    # PATH 2: fresh config. Mirror install.sh's template.
    info "Writing fresh $NGINX_CONF_PATH..."
    cat > "$NGINX_CONF_PATH" <<CONF
# Aurora — managed by setup-domain.sh
upstream aurora_backend {
    server 127.0.0.1:8484;
    keepalive 32;
}
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 0;
    location / {
        proxy_pass http://aurora_backend;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        # 24h timeouts for long-lived HLS streams + WebSocket
        # party sessions. Aurora itself caps these server-side.
        proxy_read_timeout  86400s;
        proxy_send_timeout  86400s;
    }
    location /api/stream/ {
        proxy_pass http://aurora_backend;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # Streaming-specific tuning: no buffering so segments
        # flush to client immediately, lower timeout window.
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_http_version 1.1;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }
}
CONF
    if $NGINX_SITES_STYLE; then
        ln -sf "$NGINX_CONF_PATH" /etc/nginx/sites-enabled/aurora.conf
    fi
    ok "Created $NGINX_CONF_PATH"
fi

# ── Test + reload nginx (HTTP first, before certbot) ─────────────
step "Step 4/5: Validating + reloading nginx"

if ! nginx -t 2>&1; then
    error "nginx config test failed — see output above. The prior managed config will be restored." 3
fi
ok "nginx config valid"

systemctl enable nginx >/dev/null 2>&1 \
    || error "Could not enable nginx at boot; HTTPS setup cannot be considered persistent." 3
if systemctl is-active nginx &>/dev/null; then
    systemctl reload nginx
    ok "nginx reloaded"
else
    systemctl start nginx
    NGINX_STARTED_BY_SCRIPT=true
    ok "nginx started"
fi

# Quick route-only probe: certificate/vhost setup needs to know nginx reaches
# Aurora. Strict application readiness is checked after the Aurora restart.
if curl -fsS -m 5 -H "Host: $DOMAIN" http://127.0.0.1/api/health >/dev/null 2>&1; then
    ok "HTTP route reaches Aurora: /api/health returned 200 through nginx"
else
    warn "HTTP probe to nginx didn't return 200 — DNS may not be propagated yet, OR aurora isn't running. Continuing to certbot anyway."
fi

# ── Run certbot ──────────────────────────────────────────────────
step "Step 5/5: Let's Encrypt cert via certbot --nginx"

# A retained certificate is not proof that the new nginx vhost serves TLS:
# safe uninstall deliberately keeps certificates while removing nginx config.
# A working same-domain vhost needs no certbot rewrite. If the lineage exists
# but HTTPS is not active (for example after nginx config was removed), reinstall
# that retained certificate. Otherwise issue normally.
DOMAIN_ESC="${DOMAIN_ESC:-${DOMAIN//./\\.}}"
find_certificate_record() {
    certbot certificates 2>/dev/null | awk -v domain="$DOMAIN" '
        $1 == "Certificate" && $2 == "Name:" { name = $3 }
        $1 == "Domains:" {
            domains = ""
            for (i = 2; i <= NF; i++) {
                domains = domains (domains == "" ? "" : " ") $i
                if ($i == domain) {
                    matched = 1
                }
            }
            if (matched) {
                print name "|" domains
                exit
            }
        }
    ' || true
}

CERT_RECORD="$(find_certificate_record)"
CERT_NAME="${CERT_RECORD%%|*}"
CERT_DOMAINS="${CERT_RECORD#*|}"
if [ "$CERT_RECORD" = "$CERT_NAME" ]; then
    CERT_DOMAINS=""
fi
CERT_CREATED_BY_AURORA=false
CERT_OWNERSHIP_CONTINUES=false
CERT_OWNERSHIP_SOURCE=""
if [ -f /etc/aurora/.proxy-cert-owned ]; then
    CERT_OWNERSHIP_SOURCE="/etc/aurora/.proxy-cert-owned"
elif [ -f "$PROXY_CERT_DURABLE_MARKER" ]; then
    CERT_OWNERSHIP_SOURCE="$PROXY_CERT_DURABLE_MARKER"
fi
if [ -n "$CERT_OWNERSHIP_SOURCE" ]; then
    OWNED_CERT_NAME="$(sed -n '1p' "$CERT_OWNERSHIP_SOURCE" 2>/dev/null || true)"
    OWNED_CERT_DOMAIN="$(sed -n '2p' "$CERT_OWNERSHIP_SOURCE" 2>/dev/null || true)"
    if [ -n "$CERT_NAME" ] \
        && [ "$OWNED_CERT_NAME" = "$CERT_NAME" ] \
        && [ "$OWNED_CERT_DOMAIN" = "$DOMAIN" ]; then
        CERT_OWNERSHIP_CONTINUES=true
    fi
fi

https_route_probe() {
    curl -fsS -m 10 --resolve "$DOMAIN:443:127.0.0.1" \
        "https://$DOMAIN/api/health" >/dev/null 2>&1
}

strict_https_health_probe() {
    curl -fsS -m 10 --resolve "$DOMAIN:443:127.0.0.1" \
        "https://$DOMAIN/api/health" 2>/dev/null |
        python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)

healthy = (
    isinstance(payload, dict)
    and payload.get("status") == "ok"
    and payload.get("db_connected") is True
)
raise SystemExit(0 if healthy else 1)
' >/dev/null 2>&1
}

if [ -n "$CERT_NAME" ] && https_route_probe; then
    ok "Existing certificate is active and the HTTPS route returns HTTP 200"
elif [ -n "$CERT_NAME" ]; then
    info "Reinstalling existing certificate '$CERT_NAME' into nginx..."
    if certbot --nginx --cert-name "$CERT_NAME" --reinstall \
        --non-interactive --redirect 2>&1; then
        ok "Existing certificate installed; nginx redirects HTTP → HTTPS"
    else
        error "Certbot could not reinstall '$CERT_NAME' into nginx. Aurora remains on HTTP; inspect nginx and run:
  sudo certbot --nginx --cert-name $CERT_NAME --reinstall --redirect" 3
    fi
else
    info "Requesting certificate for $DOMAIN..."
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect 2>&1; then
        CERT_CREATED_BY_AURORA=true
        CERT_RECORD="$(find_certificate_record)"
        CERT_NAME="${CERT_RECORD%%|*}"
        CERT_DOMAINS="${CERT_RECORD#*|}"
        if [ "$CERT_RECORD" = "$CERT_NAME" ]; then
            CERT_DOMAINS=""
        fi
        ok "Cert issued; nginx rewritten to redirect HTTP → HTTPS"
    else
        error "Certbot failed. Aurora is still reachable on HTTP. Most common causes:
  - DNS A record for $DOMAIN doesn't point to this server yet (wait + retry)
  - Port 80 isn't open from the public internet (firewall/cloud SG)
  - Rate-limited by Let's Encrypt (5 attempts/hour per domain)
Retry once those are fixed: sudo certbot --nginx -d $DOMAIN" 3
    fi
fi

# Require a real active renewal mechanism before claiming durable HTTPS.
RENEWAL_ACTIVE=false
RENEWAL_UNIT=""
for renewal_unit in certbot.timer certbot-renew.timer; do
    if systemctl cat "$renewal_unit" >/dev/null 2>&1 \
        && systemctl enable "$renewal_unit" >/dev/null 2>&1 \
        && systemctl start "$renewal_unit" >/dev/null 2>&1 \
        && systemctl is-active "$renewal_unit" >/dev/null 2>&1; then
        RENEWAL_ACTIVE=true
        RENEWAL_UNIT="$renewal_unit"
        break
    fi
done
$RENEWAL_ACTIVE \
    || error "No certbot renewal timer could be enabled and started. Install/enable certbot.timer (or certbot-renew.timer), then rerun HTTPS setup." 3

# Do not enable Secure cookies until TLS is actually serving this vhost. This
# is intentionally route-only; strict application health is the post-restart
# success gate below.
if ! https_route_probe; then
    error "Certificate handling completed, but the local HTTPS routing probe failed. Secure-cookie settings were not enabled. Check:
  sudo nginx -t
  curl -I --resolve '$DOMAIN:443:127.0.0.1' https://$DOMAIN/" 3
fi
ok "HTTPS route reaches Aurora: /api/health returned HTTP 200 through nginx"

# Keep runtime security/config state aligned with the integrated installer
# path, including when the certificate was already current. TLS terminates at
# nginx, so Aurora itself sees HTTP and needs the explicit Secure-cookie hint.
if declare -F aurora_env_upsert >/dev/null 2>&1 && [ -f /etc/aurora/aurora.env ]; then
    ENV_FILE="/etc/aurora/aurora.env"
    ENV_BACKUP="/etc/aurora/aurora.env.bak"
    cp -p "$ENV_FILE" "$ENV_BACKUP"
    ENV_MUTATED=true
    aurora_env_upsert /etc/aurora/aurora.env AURORA_ALLOWED_ORIGINS "https://$DOMAIN"
    aurora_env_upsert /etc/aurora/aurora.env AURORA_SECURE_COOKIES "true"
    aurora_env_upsert /etc/aurora/aurora.env AURORA_TRUSTED_PROXIES \
        "127.0.0.1/32,::1/128"
    chmod 0640 "$ENV_FILE"
    if getent group aurora >/dev/null 2>&1; then
        chown root:aurora "$ENV_FILE"
    else
        chown root:root "$ENV_FILE"
    fi
    if ! systemctl restart aurora >/dev/null 2>&1; then
        cp -p "$ENV_BACKUP" "$ENV_FILE"
        systemctl restart aurora >/dev/null 2>&1 || true
        error "Aurora failed to restart with Secure-cookie settings. Restored $ENV_FILE from $ENV_BACKUP." 3
    fi
    HTTPS_HEALTHY=false
    for _ in $(seq 1 15); do
        if strict_https_health_probe; then
            HTTPS_HEALTHY=true
            break
        fi
        sleep 1
    done
    if ! $HTTPS_HEALTHY; then
        cp -p "$ENV_BACKUP" "$ENV_FILE"
        systemctl restart aurora >/dev/null 2>&1 || true
        error "Aurora did not report status=ok with db_connected=true over HTTPS after enabling Secure cookies. Restored $ENV_FILE from $ENV_BACKUP." 3
    fi
    ok "Aurora CORS + Secure-cookie settings updated; strict health passed"
else
    error "Could not safely merge /etc/aurora/aurora.env. HTTPS is serving, but Aurora's CORS, Secure-cookie, and trusted-proxy settings were not applied; fix the env file and re-run." 3
fi
install -d -m 0750 /etc/aurora
printf '%s\n' "$DOMAIN" > /etc/aurora/.proxy-setup
chmod 0640 /etc/aurora/.proxy-setup
rm -f /etc/aurora/.proxy-removed
rm -f /usr/local/lib/aurora-installer/proxy-removal-provenance
if { $CERT_CREATED_BY_AURORA || $CERT_OWNERSHIP_CONTINUES; } \
    && [ -n "$CERT_NAME" ] && [ "$CERT_DOMAINS" = "$DOMAIN" ]; then
    install -d -m 0700 -o root -g root "$INSTALLER_STATE_DIR"
    printf '%s\n%s\n' "$CERT_NAME" "$DOMAIN" > /etc/aurora/.proxy-cert-owned
    chmod 0600 /etc/aurora/.proxy-cert-owned
    printf '%s\n%s\n' "$CERT_NAME" "$DOMAIN" > "$PROXY_CERT_DURABLE_MARKER"
    chmod 0600 "$PROXY_CERT_DURABLE_MARKER"
    chown root:root "$PROXY_CERT_DURABLE_MARKER"
else
    rm -f /etc/aurora/.proxy-cert-owned "$PROXY_CERT_DURABLE_MARKER"
fi
PROXY_SETUP_COMMITTED=true

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo "  ════════════════════════════════════════════════════════════"
echo "    Setup complete"
echo "  ════════════════════════════════════════════════════════════"
echo ""
echo "    Aurora is now reachable at:"
echo "      https://$DOMAIN/"
echo ""
echo "    Aurora's server-side route redirects /  → /v2/  → SPA"
echo "    so https://$DOMAIN/ lands users on the React app's"
echo "    home page automatically."
echo ""
echo "    Cert renewal is handled by $RENEWAL_UNIT (systemd)."
echo "    Verify with:"
echo "      systemctl status $RENEWAL_UNIT"
echo "      certbot certificates"
echo ""
echo "    Test the live URL:"
echo "      curl -I https://$DOMAIN/"
echo "      (expect HTTP/2 302 → /v2/)"
echo ""
