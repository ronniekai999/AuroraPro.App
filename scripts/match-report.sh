#!/usr/bin/env bash
set -euo pipefail

# Generate a privacy-bounded JSON report for Match calibration analysis.
# DATABASE_URL is never printed. Redirect stdout to a protected file when the
# report will be shared: scripts/match-report.sh > match-report.json

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${AURORA_ENV_FILE:-/etc/aurora/aurora.env}

if [[ -z ${DATABASE_URL:-} ]]; then
  if [[ ! -r "$ENV_FILE" ]]; then
    echo "match-report: DATABASE_URL is unset and $ENV_FILE is not readable" >&2
    exit 1
  fi
  DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -n 1)
  # aurora.env normally stores an unquoted URL, but accept conventional matching
  # single/double quotes without evaluating any shell content from the file.
  if [[ $DATABASE_URL == \"*\" && $DATABASE_URL == *\" ]]; then
    DATABASE_URL=${DATABASE_URL:1:${#DATABASE_URL}-2}
  elif [[ $DATABASE_URL == \'*\' && $DATABASE_URL == *\' ]]; then
    DATABASE_URL=${DATABASE_URL:1:${#DATABASE_URL}-2}
  fi
  if [[ -z $DATABASE_URL ]]; then
    echo "match-report: no DATABASE_URL found in $ENV_FILE" >&2
    exit 1
  fi
  export DATABASE_URL
fi

cd "$ROOT"
exec go run ./cmd/match-report "$@"
