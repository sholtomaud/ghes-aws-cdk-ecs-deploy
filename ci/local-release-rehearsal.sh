#!/usr/bin/env bash
# Local, offline rehearsal of the release packaging path with real image digests:
#   build + push the three images to a throwaway local registry, cross-check the recorded digests against the
#   registry API, package the release inside the tooling image, and verify checksums and digest traceability.
# Uses placeholder seller config from .env.example. Nothing is sent to AWS; this is not a release.
# Requires Docker and the tooling image (make tooling-image-docker).
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
require_cmd docker
require_cmd curl
require_cmd jq

REGISTRY_IMAGE="registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
port="${REHEARSAL_REGISTRY_PORT:-5001}"
tooling="${TOOLING_IMAGE:-marketplace-tooling:local}"
name="release-rehearsal-registry-$$"
docker image inspect "$tooling" >/dev/null 2>&1 || die "tooling image $tooling not found: run 'make tooling-image-docker'"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" -p "127.0.0.1:$port:5000" "$REGISTRY_IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$port/v2/" >/dev/null && break; sleep 1; done

export STAGING_REPOSITORY_PREFIX="localhost:$port/marketplace-staging"
COMMIT_SHA="$(git rev-parse HEAD)"
export COMMIT_SHA
ci/build-product-images.sh push

accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
for c in "${COMPONENTS[@]}"; do
  tag="$(jq -r ".images.$c.tag" marketplace/release/images.json)"
  recorded="$(jq -r ".images.$c.digest" marketplace/release/images.json)"
  served="$(curl -fsSI -H "Accept: $accept" "http://127.0.0.1:$port/v2/marketplace-staging/$c/manifests/$tag" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')"
  [[ "$served" == "$recorded" ]] || die "$c: registry serves $served but images.json recorded $recorded"
  log "ok: $c digest $recorded matches the registry"
done

chmod a+rwx marketplace/release
docker run --rm --env-file <(grep -v '^#' .env.example | sed 's/"//g' | grep '=') -e COMMIT_SHA="$COMMIT_SHA" \
  -v "$PWD/marketplace/release:/workspace/marketplace/release" -v "$PWD/release-notes:/workspace/release-notes:ro" \
  "$tooling" npm run release:package
(cd marketplace/release && sha256sum -c SHA256SUMS)
for c in "${COMPONENTS[@]}"; do
  digest="$(jq -r ".images.$c.digest" marketplace/release/release-manifest.json)"
  grep -q "$(jq -r ".images.$c.marketplaceRepository" marketplace/release/release-manifest.json)@$digest" marketplace/release/customer-app.template.json \
    || die "release template does not pin $c to $digest"
  grep -q "$STAGING_REPOSITORY_PREFIX/$c@$digest" marketplace/release/customer-app.test.template.json || die "test template does not pin $c to $digest"
done
log "release rehearsal passed: $(jq -r '.version + " @ " + .commitSha' marketplace/release/release-manifest.json)"
log "artifacts in marketplace/release/ (not committed; regenerate any time)"
