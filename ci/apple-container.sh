#!/usr/bin/env bash
# Apple `container` CLI wrapper for the tooling image on macOS. Never substitutes Docker.
#   ci/apple-container.sh build <tag>            build ./Containerfile
#   ci/apple-container.sh run <tag> <cmd...>     run a command in the image (--rm)
# Tested against the command reference at https://github.com/apple/container/blob/main/docs/command-reference.md
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [[ "$(uname -s)" != "Darwin" && -z "${APPLE_CONTAINER_SKIP_OS_CHECK:-}" ]]; then
  die "Apple's container CLI runs only on macOS (Apple silicon). On Linux use the Docker targets, e.g. 'make tooling-test-docker'."
fi
if ! command -v container >/dev/null 2>&1; then
  die "Apple's container CLI was not found. Install the signed package from https://github.com/apple/container/releases (macOS 26+ on Apple silicon), then run 'container system start'. This target does not fall back to Docker."
fi
printf 'apple container: %s\n' "$(container --version 2>/dev/null || echo unknown)" >&2
if ! container system status >/dev/null 2>&1; then
  die "the container system service is not running. Start it with 'container system start' and retry."
fi

cmd="${1:-}"; shift || true
case "$cmd" in
  build)
    tag="${1:?usage: $0 build <tag>}"
    container build --file Containerfile --tag "$tag" .
    ;;
  run)
    tag="${1:?usage: $0 run <tag> <command...>}"; shift
    [[ $# -gt 0 ]] || die "usage: $0 run <tag> <command...>"
    container run --rm "$tag" "$@"
    ;;
  *) die "usage: $0 build <tag> | run <tag> <command...>" ;;
esac
