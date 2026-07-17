#!/usr/bin/env bash
#
# Aurora Media Server — bootstrap installer
#
# This is the small, stable entrypoint intended for:
#
#   curl -fsSLo /root/aurora-install.sh https://aurorapro.app/install.sh \
#     && bash /root/aurora-install.sh
#
# It validates the host, installs Git when necessary, checks out the requested
# Aurora branch into the root-owned managed source directory, and then hands
# off to scripts/install.sh for the full idempotent system installation.
#
# The application repository is currently private. Set AURORA_GIT_TOKEN to a
# fine-grained GitHub token with Contents: Read-only access, or run
# interactively and the bootstrap will request it from /dev/tty without echo.

set -Eeuo pipefail
umask 022

BOOTSTRAP_VERSION="1"
DEFAULT_REPO_URL="https://github.com/ronniekai999/AuroraPro.App.git"
DEFAULT_BRANCH="main"
SOURCE_DIR="/var/lib/aurora/source"
LOG_DIR="/var/log/aurora-installer"
LOG_FILE="$LOG_DIR/install.log"
INSTALLED_ENV_FILE="/etc/aurora/aurora.env"
AURORA_GIT_CREDENTIAL_FILE="/root/.config/aurora/git-credentials"
RUNTIME_LOCK_DIR="/run/aurora"
INSTALL_LOCK_FILE="$RUNTIME_LOCK_DIR/install.lock"
DEPLOY_LOCK_FILE="$RUNTIME_LOCK_DIR/deploy.lock"

read_installed_setting() {
    local key="$1" value
    [ -r "$INSTALLED_ENV_FILE" ] || return 1
    value="$(
        awk -v key="$key" '
            index($0, key "=") == 1 {
                print substr($0, length(key) + 2)
                found = 1
                exit
            }
            END { if (!found) exit 1 }
        ' "$INSTALLED_ENV_FILE"
    )" || return 1
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    printf '%s\n' "$value"
}

INSTALLED_REPO_URL="$(read_installed_setting AURORA_EXPECTED_REMOTE 2>/dev/null || true)"
INSTALLED_BRANCH="$(read_installed_setting AURORA_UPDATE_BRANCH 2>/dev/null || true)"
REPO_URL="${AURORA_REPO_URL:-${AURORA_EXPECTED_REMOTE:-${INSTALLED_REPO_URL:-$DEFAULT_REPO_URL}}}"
INSTALL_BRANCH="${AURORA_INSTALL_BRANCH:-${AURORA_UPDATE_BRANCH:-${INSTALLED_BRANCH:-$DEFAULT_BRANCH}}}"
ENABLE_LOG=true
AUTH_DIR=""
STAGE_DIR=""
LOCK_FD=""
DEPLOY_LOCK_FD=""
GIT_CREDENTIAL_HELPER=""

if [ -t 1 ]; then
    COLOR_BLUE=$'\033[1;34m'
    COLOR_GREEN=$'\033[1;32m'
    COLOR_YELLOW=$'\033[1;33m'
    COLOR_RED=$'\033[1;31m'
    COLOR_CYAN=$'\033[1;36m'
    COLOR_RESET=$'\033[0m'
else
    COLOR_BLUE=""
    COLOR_GREEN=""
    COLOR_YELLOW=""
    COLOR_RED=""
    COLOR_CYAN=""
    COLOR_RESET=""
fi

info() { printf '%s[INFO]%s  %s\n' "$COLOR_BLUE" "$COLOR_RESET" "$*"; }
ok() { printf '%s[ OK ]%s  %s\n' "$COLOR_GREEN" "$COLOR_RESET" "$*"; }
warn() { printf '%s[WARN]%s  %s\n' "$COLOR_YELLOW" "$COLOR_RESET" "$*" >&2; }
die() {
    printf '%s[ERROR]%s %s\n' "$COLOR_RED" "$COLOR_RESET" "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Aurora Media Server bootstrap installer

Usage:
  install.sh [options]

Options:
  --branch NAME      Install and track a branch (default: installed branch or main)
  --repo URL         Override the Git repository (for an Aurora fork)
  --no-log           Do not tee installer output to /var/log/aurora-installer/install.log
  -h, --help         Show this help

Environment:
  AURORA_GIT_TOKEN       GitHub token for the private repository
  AURORA_INSTALL_BRANCH  Branch to install and track
  AURORA_REPO_URL        Git repository URL

All other AURORA_* variables are passed through to scripts/install.sh.
EOF
}

cleanup() {
    if [ -n "$AUTH_DIR" ]; then
        rm -rf "$AUTH_DIR"
    fi
    if [ -n "$STAGE_DIR" ] && [ -e "$STAGE_DIR" ]; then
        rm -rf "$STAGE_DIR"
    fi
}

on_error() {
    local line="$1"
    warn "Bootstrap stopped unexpectedly near line $line."
    if $ENABLE_LOG; then
        warn "Review $LOG_FILE for the complete output."
    fi
}

trap cleanup EXIT
trap 'on_error "$LINENO"' ERR

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --branch)
                [ "$#" -ge 2 ] || die "--branch requires a value"
                INSTALL_BRANCH="$2"
                shift 2
                ;;
            --repo)
                [ "$#" -ge 2 ] || die "--repo requires a value"
                REPO_URL="$2"
                shift 2
                ;;
            --no-log)
                ENABLE_LOG=false
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                die "Unknown option: $1 (try --help)"
                ;;
        esac
    done
}

normalize_arch() {
    case "$1" in
        x86_64|amd64) printf 'amd64\n' ;;
        aarch64|arm64) printf 'arm64\n' ;;
        *) return 1 ;;
    esac
}

normalize_repo_url() {
    local value="${1%/}"
    value="${value%.git}"
    case "$value" in
        git@github.com:*) value="https://github.com/${value#git@github.com:}" ;;
        ssh://git@github.com/*) value="https://github.com/${value#ssh://git@github.com/}" ;;
    esac
    printf '%s\n' "$value"
}

validate_repo_url() {
    local authority
    case "$REPO_URL" in
        *$'\n'*|*$'\r'*) die "Repository URL contains an invalid newline" ;;
        https://*)
            authority="${REPO_URL#https://}"
            authority="${authority%%/*}"
            case "$authority" in
                *@*)
                    die "Repository URL must not embed credentials. Use AURORA_GIT_TOKEN or an SSH deploy key."
                    ;;
            esac
            ;;
    esac
    if [[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?/?$ ]] \
        || [[ "$REPO_URL" =~ ^git@github\.com:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?/?$ ]] \
        || [[ "$REPO_URL" =~ ^ssh://git@github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?/?$ ]]; then
        if [ -n "${AURORA_GIT_TOKEN:-}" ] \
            && [[ "$REPO_URL" != https://github.com/* ]]; then
            die "AURORA_GIT_TOKEN is only valid with a GitHub HTTPS repository. Unset it when using an SSH deploy key."
        fi
        return 0
    fi
    die "Repository must be a canonical GitHub HTTPS or SSH repository URL"
}

validate_branch() {
    git check-ref-format --branch "$INSTALL_BRANCH" >/dev/null 2>&1 \
        || die "Invalid branch name: $INSTALL_BRANCH"
}

detect_package_manager() {
    if command -v apt-get >/dev/null 2>&1; then
        printf 'apt\n'
    elif command -v dnf >/dev/null 2>&1; then
        printf 'dnf\n'
    elif command -v yum >/dev/null 2>&1; then
        printf 'yum\n'
    elif command -v pacman >/dev/null 2>&1; then
        printf 'pacman\n'
    elif command -v zypper >/dev/null 2>&1; then
        printf 'zypper\n'
    else
        return 1
    fi
}

install_bootstrap_dependencies() {
    local package_manager
    package_manager="$(detect_package_manager)" \
        || die "No supported package manager found (apt, dnf, yum, pacman, zypper)"

    info "Installing bootstrap dependencies with $package_manager..."
    case "$package_manager" in
        apt)
            DEBIAN_FRONTEND=noninteractive apt-get update -qq
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates util-linux
            ;;
        dnf) dnf install -y -q git ca-certificates util-linux ;;
        yum) yum install -y -q git ca-certificates util-linux ;;
        # Arch does not support partial upgrades: refresh package metadata only
        # as part of a full system upgrade.
        pacman) pacman -Syu --noconfirm --needed git ca-certificates util-linux >/dev/null ;;
        zypper) zypper --quiet --non-interactive install --no-recommends git ca-certificates util-linux >/dev/null ;;
    esac
}

preflight() {
    [ "$(id -u)" -eq 0 ] \
        || die "Run the installer from a root login shell: sudo -i"

    [ "$(uname -s)" = "Linux" ] \
        || die "Aurora's installer supports Linux only"

    command -v systemctl >/dev/null 2>&1 \
        || die "systemd is required"

    local arch
    arch="$(normalize_arch "$(uname -m)")" \
        || die "Unsupported architecture: $(uname -m). Aurora supports amd64 and arm64."

    [ -r /etc/os-release ] \
        || die "/etc/os-release is missing; cannot identify this Linux distribution"

    # shellcheck disable=SC1091
    . /etc/os-release
    local distro="${PRETTY_NAME:-${NAME:-unknown Linux}}"

    case "${ID:-}" in
        debian|ubuntu|fedora|rhel|rocky|almalinux|centos|arch|opensuse-leap|opensuse-tumbleweed|sles) ;;
        *)
            warn "$distro is not in Aurora's recognized distribution families."
            detect_package_manager >/dev/null \
                || die "No supported package manager is available on $distro"
            ;;
    esac

    ok "Host: $distro ($arch)"
    ok "systemd is available"

    if ! command -v git >/dev/null 2>&1 \
        || ! command -v flock >/dev/null 2>&1; then
        install_bootstrap_dependencies
    fi
    command -v git >/dev/null 2>&1 || die "Git installation failed"
    command -v flock >/dev/null 2>&1 || die "flock installation failed"

    validate_repo_url
    validate_branch
}

start_logging() {
    $ENABLE_LOG || return 0
    command -v tee >/dev/null 2>&1 || {
        warn "tee is unavailable; continuing without a persistent install log"
        ENABLE_LOG=false
        return 0
    }

    [ ! -L "$LOG_DIR" ] || die "$LOG_DIR is a symlink; refusing to write a root log through it"
    install -d -m 0700 -o root -g root "$LOG_DIR"
    [ ! -L "$LOG_FILE" ] || die "$LOG_FILE is a symlink; refusing to follow it"
    touch "$LOG_FILE"
    chown root:root "$LOG_FILE"
    chmod 0600 "$LOG_FILE"
    exec > >(tee -a "$LOG_FILE") 2>&1
    info "Installer log: $LOG_FILE"
}

acquire_lock() {
    [ ! -L "$RUNTIME_LOCK_DIR" ] \
        || die "$RUNTIME_LOCK_DIR is a symlink"
    if [ -e "$RUNTIME_LOCK_DIR" ] && [ ! -d "$RUNTIME_LOCK_DIR" ]; then
        die "$RUNTIME_LOCK_DIR is not a directory"
    fi
    install -d -m 0755 -o root -g root "$RUNTIME_LOCK_DIR"
    [ "$(stat -c %u "$RUNTIME_LOCK_DIR")" = "0" ] \
        || die "$RUNTIME_LOCK_DIR is not root-owned"

    for lock_path in "$INSTALL_LOCK_FILE" "$DEPLOY_LOCK_FILE"; do
        [ ! -L "$lock_path" ] || die "$lock_path is a symlink"
        if [ -e "$lock_path" ] && [ ! -f "$lock_path" ]; then
            die "$lock_path is not a regular file"
        fi
    done

    # /run/aurora is root-owned and non-writable to other users, so no local
    # process can replace either path between validation and these opens.
    exec {LOCK_FD}>"$INSTALL_LOCK_FILE"
    chown root:root "$INSTALL_LOCK_FILE"
    chmod 0644 "$INSTALL_LOCK_FILE"
    flock -n "$LOCK_FD" \
        || die "Another Aurora installer or repair is already running"

    exec {DEPLOY_LOCK_FD}>"$DEPLOY_LOCK_FILE"
    chown root:root "$DEPLOY_LOCK_FILE"
    chmod 0644 "$DEPLOY_LOCK_FILE"
    flock -n "$DEPLOY_LOCK_FD" \
        || die "Aurora is currently updating or redeploying; wait for it to finish"
    export AURORA_DEPLOY_LOCK_HELD=1
}

configure_git_auth() {
    [ -n "${AURORA_GIT_TOKEN:-}" ] || return 0
    case "$AURORA_GIT_TOKEN" in
        *$'\n'*|*$'\r'*) die "AURORA_GIT_TOKEN contains an invalid newline" ;;
    esac

    GIT_CREDENTIAL_HELPER=""
    if [ -n "$AUTH_DIR" ]; then
        rm -rf "$AUTH_DIR"
    fi
    AUTH_DIR="$(mktemp -d)"
    cat > "$AUTH_DIR/askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
    *Username*) printf '%s\n' "x-access-token" ;;
    *Password*) printf '%s\n' "${AURORA_GIT_TOKEN:?}" ;;
    *) exit 1 ;;
esac
ASKPASS
    chmod 0700 "$AUTH_DIR/askpass"
    export GIT_ASKPASS="$AUTH_DIR/askpass"
    export GIT_TERMINAL_PROMPT=0
}

configure_stored_git_auth() {
    if [ -r "$AURORA_GIT_CREDENTIAL_FILE" ]; then
        GIT_CREDENTIAL_HELPER="store --file=$AURORA_GIT_CREDENTIAL_FILE"
    fi
}

git_with_auth() {
    if [ -n "$GIT_CREDENTIAL_HELPER" ]; then
        git -c credential.helper= \
            -c "credential.helper=$GIT_CREDENTIAL_HELPER" "$@"
    else
        git -c credential.helper= "$@"
    fi
}

prompt_for_github_token() {
    [ -r /dev/tty ] \
        || die "The repository is private. Set AURORA_GIT_TOKEN to a fine-grained token with Contents: Read-only access."

    printf '\n%s[?]%s GitHub token (Contents: Read-only; input hidden): ' \
        "$COLOR_CYAN" "$COLOR_RESET" >/dev/tty
    IFS= read -r -s AURORA_GIT_TOKEN </dev/tty
    printf '\n' >/dev/tty
    [ -n "$AURORA_GIT_TOKEN" ] || die "A GitHub token is required for the private repository"
    export AURORA_GIT_TOKEN
    configure_git_auth
}

check_remote_access() {
    local refs
    export GIT_TERMINAL_PROMPT=0

    if [ -n "${AURORA_GIT_TOKEN:-}" ]; then
        configure_git_auth
    else
        configure_stored_git_auth
    fi

    if ! refs="$(git_with_auth ls-remote --heads "$REPO_URL" "refs/heads/$INSTALL_BRANCH" 2>/dev/null)"; then
        if [ -z "${AURORA_GIT_TOKEN:-}" ] && [[ "$REPO_URL" == https://github.com/* ]]; then
            info "GitHub authentication is required for the Aurora source repository."
            prompt_for_github_token
            refs="$(git_with_auth ls-remote --heads "$REPO_URL" "refs/heads/$INSTALL_BRANCH" 2>/dev/null)" \
                || die "GitHub could not authenticate or access $REPO_URL"
        else
            die "Could not access $REPO_URL. Check the repository URL, SSH key, or GitHub token."
        fi
    fi

    [ -n "$refs" ] \
        || die "Branch '$INSTALL_BRANCH' does not exist in $REPO_URL"
    ok "Repository access verified"
}

validate_managed_source_security() {
    [ "$(id -u)" -eq 0 ] || return 0

    [ ! -L "$SOURCE_DIR/.git" ] \
        || die "$SOURCE_DIR/.git is a symlink; refusing to run root Git operations"

    local unsafe
    unsafe="$(find "$SOURCE_DIR" -xdev \
        \( -type f -o -type d \) \
        \( ! -user root -o -perm /022 \) \
        -print -quit 2>/dev/null)" \
        || die "Could not verify ownership and permissions under $SOURCE_DIR"
    [ -z "$unsafe" ] \
        || die "Managed source contains a non-root-owned or writable path: $unsafe"
}

sync_managed_source() {
    local parent current_origin current_authority expected_origin worktree_status
    parent="$(dirname "$SOURCE_DIR")"
    mkdir -p "$parent"
    chmod 0755 "$parent"

    if [ -L "$SOURCE_DIR" ]; then
        die "$SOURCE_DIR is a symlink; refusing to use it as a root build source"
    fi

    if [ -d "$SOURCE_DIR/.git" ]; then
        validate_managed_source_security
        current_origin="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
        case "$current_origin" in
            https://*)
                current_authority="${current_origin#https://}"
                current_authority="${current_authority%%/*}"
                case "$current_authority" in
                    *@*)
                        die "$SOURCE_DIR has a credential-bearing HTTPS origin. Sanitize remote.origin.url before repair."
                        ;;
                esac
                ;;
        esac
        expected_origin="$(normalize_repo_url "$REPO_URL")"
        if [ "$(normalize_repo_url "$current_origin")" != "$expected_origin" ]; then
            die "$SOURCE_DIR points to a different origin. Move it aside before changing repositories."
        fi
        if [ "$current_origin" != "$REPO_URL" ]; then
            git -C "$SOURCE_DIR" remote set-url origin "$REPO_URL"
        fi

        worktree_status="$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=normal)" \
            || die "Could not inspect the managed source working tree"
        if [ -n "$worktree_status" ]; then
            die "$SOURCE_DIR has local changes or untracked files. Commit or remove them before installing."
        fi

        info "Refreshing managed Aurora source..."
        git_with_auth -C "$SOURCE_DIR" fetch --quiet --prune origin \
            "+refs/heads/$INSTALL_BRANCH:refs/remotes/origin/$INSTALL_BRANCH"
        git -C "$SOURCE_DIR" checkout --quiet -B "$INSTALL_BRANCH" "origin/$INSTALL_BRANCH"
    else
        if [ -e "$SOURCE_DIR" ]; then
            die "$SOURCE_DIR already exists but is not an Aurora Git checkout"
        fi

        STAGE_DIR="${SOURCE_DIR}.bootstrap.$$"
        rm -rf "$STAGE_DIR"
        info "Cloning Aurora into the managed source directory..."
        (
            # Do not expose a private checkout to unrelated local accounts even
            # during the brief staging window before final ownership hardening.
            umask 027
            git_with_auth clone --quiet --depth 1 --single-branch \
                --branch "$INSTALL_BRANCH" "$REPO_URL" "$STAGE_DIR"
        )
        mv "$STAGE_DIR" "$SOURCE_DIR"
        STAGE_DIR=""
    fi

    if [ "$(id -u)" -eq 0 ]; then
        chown -R root:root "$SOURCE_DIR"
        chmod -R go-rwx "$SOURCE_DIR"
    fi

    [ -f "$SOURCE_DIR/scripts/install.sh" ] \
        || die "Managed checkout is incomplete: scripts/install.sh is missing"
    ok "Managed source: $SOURCE_DIR ($(git -C "$SOURCE_DIR" rev-parse --short HEAD))"
}

run_full_installer() {
    export AURORA_UPDATE_BRANCH="$INSTALL_BRANCH"
    info "Handing off to Aurora's full system installer..."
    bash "$SOURCE_DIR/scripts/install.sh"
}

main() {
    parse_args "$@"

    printf '\n'
    printf '  ============================================================\n'
    printf '   Aurora Media Server — Bootstrap Installer v%s\n' "$BOOTSTRAP_VERSION"
    printf '  ============================================================\n'
    printf '\n'

    preflight
    start_logging
    acquire_lock

    check_remote_access
    sync_managed_source

    run_full_installer
}

if [ "${AURORA_BOOTSTRAP_LIBRARY_ONLY:-0}" != "1" ]; then
    main "$@"
fi
