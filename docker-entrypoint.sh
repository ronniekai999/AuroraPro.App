#!/bin/sh
set -e

SECRETS_FILE="/app/data/.aurora-secrets"

# Generate a persistent JWT_SECRET on first run if not provided via env
if [ -z "$JWT_SECRET" ]; then
    if [ -f "$SECRETS_FILE" ]; then
        # Load previously generated secret
        . "$SECRETS_FILE"
        export JWT_SECRET
    else
        # First run -- generate and persist
        mkdir -p "$(dirname "$SECRETS_FILE")"
        JWT_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n+/=' | head -c 64)
        echo "JWT_SECRET=$JWT_SECRET" > "$SECRETS_FILE"
        chmod 600 "$SECRETS_FILE"
        export JWT_SECRET
        echo "  [OK] Generated new JWT_SECRET (persisted to $SECRETS_FILE)"
    fi
fi

exec "$@"
