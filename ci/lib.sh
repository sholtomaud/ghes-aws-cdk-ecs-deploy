#!/usr/bin/env bash
# Shared helpers for ci/*.sh. Sourced, not executed.
set -euo pipefail

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
require_env() { local v; for v in "$@"; do [[ -n "${!v:-}" ]] || die "$v is required"; done; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed${2:+ ($2)}"; }
product_version() { node -p "require('./package.json').version"; }
# shellcheck disable=SC2034  # used by the scripts that source this file
COMPONENTS=(frontend api agent)
