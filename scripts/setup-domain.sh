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

pkg_install() {
    if command -v apt-get &>/dev/null; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
    elif command -v dnf &>/dev/null; then
        dnf install -y -q "$@"
    elif command -v yum &>/dev/null; then
        yum install -y -q "$@"
    elif command -v pacman &>/dev/null; then
        pacman -Sy --noconfirm --quiet "$@"
    elif command -v zypper &>/dev/null; then
        zypper --quiet --non-interactive install --no-recommends "$@"
    else
        error "No supported package manager found."
    fi
}

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
    pkg_install certbot
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
if ! certbot plugins 2>/dev/null | grep -q '^\* nginx'; then
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
    info "Will add '$DOMAIN' to its server_name (preserves any other domains)"
else
    info "No existing config — will create a fresh one"
    if [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
        NGINX_CONF_PATH="/etc/nginx/sites-available/aurora.conf"
        NGINX_SITES_STYLE=true
    else
        NGINX_CONF_PATH="/etc/nginx/conf.d/aurora.conf"
    fi
fi

# WebSocket upgrade map (shared by both paths). Idempotent: only
# write if no existing map for $http_upgrade exists anywhere.
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
    # PATH 1: augment existing config.
    #
    # 2026-05-20 audit fixes:
    #  - HIGH: word-boundary `\b${DOMAIN}\b` matches as a subdomain
    #    substring. e.g. existing `server_name foo.example.com;` would
    #    cause `DOMAIN=example.com` to be wrongly detected as already
    #    present. We anchor against whitespace/semicolon instead.
    #  - HIGH: `0,/.../` in sed only edits the FIRST server_name line.
    #    After certbot's first run, the config has BOTH a :80 and a
    #    :443 server block, each with its own server_name. Editing
    #    only one would leave the :443 block stale, so the new domain
    #    serves HTTP but not HTTPS. Edit ALL server_name lines.
    #  - HIGH (2026-05-21): the sole-domain case (`server_name DOMAIN;`)
    #    was not detected by the presence check, because the previous
    #    regex `server_name[[:space:]][^;]*(^|[[:space:]])DOMAIN`
    #    requires whitespace BEFORE DOMAIN that's distinct from the
    #    whitespace after `server_name`. When DOMAIN is the only entry,
    #    there's no such intermediate whitespace — the check returned
    #    false → sed appended DOMAIN → `server_name DOMAIN DOMAIN;`.
    #    Fix: use `[[:space:]]+([^;]*[[:space:]])?DOMAIN` so the "other
    #    domains before DOMAIN" group is properly optional.
    #
    # Match patterns:
    #   `server_name <DOMAIN>;`                         (sole domain)
    #   `server_name foo <DOMAIN> bar;`                 (middle of list)
    #   `server_name foo <DOMAIN>;`                     (end of list)
    # NOT-match:
    #   `server_name foo.<DOMAIN>;`                     (parent domain)
    #   `server_name <DOMAIN>.evil.example;`            (wrong host)
    DOMAIN_ESC="${DOMAIN//./\\.}"
    DOMAIN_RE="server_name[[:space:]]+([^;]*[[:space:]])?${DOMAIN_ESC}([[:space:]]|;)"
    if grep -qE "$DOMAIN_RE" "$EXISTING_CONF"; then
        ok "'$DOMAIN' is already in server_name — no edit needed"
    else
        info "Adding '$DOMAIN' to server_name in $EXISTING_CONF..."
        cp -a "$EXISTING_CONF" "${EXISTING_CONF}.bak.$(date +%s)"
        # Edit EVERY `server_name ...;` line — both the :80 and :443
        # server blocks if certbot has been here before. The capture
        # group preserves indentation + existing domains, we append.
        sed -i -E "s/^([[:space:]]*)server_name[[:space:]]+([^;]+);/\1server_name \2 ${DOMAIN};/g" \
            "$EXISTING_CONF"
        if grep -qE "$DOMAIN_RE" "$EXISTING_CONF"; then
            EDITED=$(grep -cE "$DOMAIN_RE" "$EXISTING_CONF")
            ok "Added '$DOMAIN' to $EDITED server_name line(s)"
        else
            warn "Could not augment server_name automatically — backup at ${EXISTING_CONF}.bak.*"
            warn "Edit $EXISTING_CONF manually: add '$DOMAIN' to the server_name line."
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
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
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
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
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
        rm -f /etc/nginx/sites-enabled/default
    fi
    ok "Created $NGINX_CONF_PATH"
fi

# ── Test + reload nginx (HTTP first, before certbot) ─────────────
step "Step 4/5: Validating + reloading nginx"

if ! nginx -t 2>&1; then
    error "nginx config test failed — see output above. Config left in place for inspection." 3
fi
ok "nginx config valid"

systemctl enable nginx &>/dev/null || true
if systemctl is-active nginx &>/dev/null; then
    systemctl reload nginx
    ok "nginx reloaded"
else
    systemctl start nginx
    ok "nginx started"
fi

# ── Trust the proxy we just installed ────────────────────────────
# nginx proxies from 127.0.0.1, so without this Aurora sees EVERY request as
# coming from loopback: the per-IP auth rate limiter collapses into a single
# bucket shared by the whole internet, and audit logs record 127.0.0.1 instead
# of the client (which is exactly what production logs showed on every
# refresh-replay warning). Trust ONLY loopback — the addresses the upstream
# block above proxies from. Anything wider would let clients forge their IP.
AURORA_ENV_FILE=/etc/aurora/aurora.env
if [ -f "$AURORA_ENV_FILE" ]; then
    if grep -q '^AURORA_TRUSTED_PROXIES=' "$AURORA_ENV_FILE"; then
        ok "AURORA_TRUSTED_PROXIES already set — leaving it alone"
    else
        # Guarantee a trailing newline before appending. If the file's last
        # byte isn't one — an operator edit, an editor that strips it — a bare
        # >> concatenates onto the last line, producing e.g.
        # "LOG_LEVEL=infoAURORA_TRUSTED_PROXIES=...". That corrupts the
        # previous setting, fails to apply this one, AND defeats the grep
        # guard above so a re-run appends again on top of the damage.
        if [ -s "$AURORA_ENV_FILE" ] && [ "$(tail -c1 "$AURORA_ENV_FILE" | wc -l)" -eq 0 ]; then
            printf '\n' >> "$AURORA_ENV_FILE"
        fi
        printf 'AURORA_TRUSTED_PROXIES=127.0.0.1/32,::1/128\n' >> "$AURORA_ENV_FILE"
        ok "Added AURORA_TRUSTED_PROXIES to $AURORA_ENV_FILE"
        if systemctl is-active aurora &>/dev/null; then
            systemctl restart aurora
            ok "Restarted aurora to pick it up"
        else
            warn "aurora is not running — the new setting applies on next start"
        fi
    fi
else
    warn "$AURORA_ENV_FILE not found — set AURORA_TRUSTED_PROXIES=127.0.0.1/32,::1/128 by hand, or the auth rate limiter will treat every client as one IP"
fi

# Quick local probe to confirm HTTP routes through nginx → Aurora
if curl -fsS -m 5 -H "Host: $DOMAIN" http://127.0.0.1/api/health >/dev/null 2>&1; then
    ok "HTTP routing works: nginx → aurora /api/health"
else
    warn "HTTP probe to nginx didn't return 200 — DNS may not be propagated yet, OR aurora isn't running. Continuing to certbot anyway."
fi

# ── Run certbot ──────────────────────────────────────────────────
step "Step 5/5: Let's Encrypt cert via certbot --nginx"

# Cert provisioning — three distinct cases:
#   A. Cert already covers $DOMAIN              → skip certbot entirely
#      (re-running certbot --expand on an already-covered domain has
#      been observed to perturb the nginx config; safest is a no-op)
#   B. Cert exists but doesn't cover $DOMAIN    → expand it
#   C. No cert exists                            → issue a new one
DOMAIN_ESC="${DOMAIN_ESC:-${DOMAIN//./\\.}}"
if certbot certificates 2>/dev/null | grep -qE "Domains:.*(^|[[:space:]])${DOMAIN_ESC}([[:space:]]|$)"; then
    # Case A: cert already covers this domain. Nothing to do.
    ok "Cert for $DOMAIN is already current — skipping certbot"
    info "  Renewal handled by certbot.timer (verify with: systemctl status certbot.timer)"
else
    # Cases B + C are handled by the same command. `--expand` adds the
    # domain to an existing cert if one exists; otherwise certbot
    # issues a new cert covering $DOMAIN.
    info "Requesting/expanding cert for $DOMAIN..."
    if certbot --nginx -d "$DOMAIN" --expand --non-interactive --agree-tos -m "$EMAIL" --redirect 2>&1; then
        ok "Cert issued; nginx rewritten to redirect HTTP → HTTPS"
        # Ensure the renewal timer is running so the cert auto-renews.
        systemctl enable certbot.timer &>/dev/null \
            || systemctl enable certbot-renew.timer &>/dev/null \
            || true
        systemctl start certbot.timer &>/dev/null \
            || systemctl start certbot-renew.timer &>/dev/null \
            || true
    else
        error "Certbot failed. Aurora is still reachable on HTTP. Most common causes:
  - DNS A record for $DOMAIN doesn't point to this server yet (wait + retry)
  - Port 80 isn't open from the public internet (firewall/cloud SG)
  - Rate-limited by Let's Encrypt (5 attempts/hour per domain)
Retry once those are fixed: sudo certbot --nginx -d $DOMAIN" 3
    fi
fi

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
echo "    Cert renewal is handled by certbot.timer (systemd)."
echo "    Verify with:"
echo "      systemctl status certbot.timer"
echo "      certbot certificates"
echo ""
echo "    Test the live URL:"
echo "      curl -I https://$DOMAIN/"
echo "      (expect HTTP/2 302 → /v2/)"
echo ""
