#!/usr/bin/env bash
# Build the three application images with Docker (BuildKit). Modes:
#   test   build each image's `test` stage (runs its unit tests inside the build)
#   build  build runtime images locally as <LOCAL_PREFIX>/<component>:<version>
#   push   build, push to STAGING_REPOSITORY_PREFIX with the immutable version tag, and record the pushed
#          digests in marketplace/release/images.json (input to release packaging)
# Optional: EXTRA_CA=<pem> for TLS-intercepting proxies (BuildKit secret, never baked into layers).
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1

mode="${1:-build}"
require_cmd docker "the authoritative image build runs on Docker (GitHub Actions / CodeBuild)"
version="$(product_version)"
platform="${IMAGE_PLATFORM:-linux/amd64}"
local_prefix="${LOCAL_PREFIX:-private-ai-assistant}"
secret_args=()
[[ -n "${EXTRA_CA:-}" ]] && secret_args=(--secret "id=extra_ca,src=${EXTRA_CA}")

build() { # component target tag
  DOCKER_BUILDKIT=1 docker build --load --platform "$platform" --file "app/$1/Containerfile" --target "$2" \
    --label "org.opencontainers.image.version=$version" \
    --label "org.opencontainers.image.revision=${COMMIT_SHA:-unknown}" \
    "${secret_args[@]}" --tag "$3" "app/$1"
}

case "$mode" in
  test)
    for c in "${COMPONENTS[@]}"; do log "testing $c"; build "$c" test "$local_prefix/$c:test"; done
    ;;
  build)
    for c in "${COMPONENTS[@]}"; do log "building $c $version"; build "$c" runtime "$local_prefix/$c:$version"; done
    ;;
  push)
    require_env STAGING_REPOSITORY_PREFIX
    [[ "$version" != *latest* ]] || die "refusing to publish a 'latest' version"
    mkdir -p marketplace/release
    entries=()
    for c in "${COMPONENTS[@]}"; do
      repo="$STAGING_REPOSITORY_PREFIX/$c"
      log "building and pushing $repo:$version"
      build "$c" test "$local_prefix/$c:test"
      build "$c" runtime "$repo:$version"
      docker push "$repo:$version" >&2
      digest="$(docker image inspect "$repo:$version" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep "^$repo@" | head -1 | cut -d@ -f2)"
      [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die "could not determine pushed digest for $repo:$version"
      entries+=("\"$c\": {\"repository\": \"$repo\", \"tag\": \"$version\", \"digest\": \"$digest\"}")
    done
    joined="$(IFS=,; echo "${entries[*]}")"
    printf '{\n  "version": "%s",\n  "images": {\n    %s\n  }\n}\n' "$version" "${joined//,\"/,$'\n'    \"}" > marketplace/release/images.json
    log "wrote marketplace/release/images.json"
    ;;
  *) die "usage: $0 test|build|push" ;;
esac
