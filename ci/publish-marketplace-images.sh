#!/usr/bin/env bash
# Copy the tested images, by digest, from the staging repositories to the AWS Marketplace repositories.
# Images are never rebuilt: the copy must preserve the digest, and the script fails if it does not.
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
require_cmd docker
require_env SELLER_REGION MARKETPLACE_CATALOG_REGION
manifest=marketplace/release/release-manifest.json
[[ -f "$manifest" ]] || die "$manifest missing"
aws ecr get-login-password --region "$SELLER_REGION" | docker login --username AWS --password-stdin "$(node -p "require('./$manifest').images.api.stagingRepository.split('/')[0]")"
mp_registry="$(node -p "require('./$manifest').images.api.marketplaceRepository.split('/')[0]")"
aws ecr get-login-password --region "$MARKETPLACE_CATALOG_REGION" | docker login --username AWS --password-stdin "$mp_registry"

for c in "${COMPONENTS[@]}"; do
  read -r src_repo dst_repo tag digest < <(node -p "const i=require('./$manifest').images['$c']; [i.stagingRepository,i.marketplaceRepository,i.tag,i.digest].join(' ')")
  existing="$(docker buildx imagetools inspect "$dst_repo:$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"' || true)"
  if [[ -n "$existing" ]]; then
    [[ "$existing" == "$digest" ]] || die "$dst_repo:$tag already exists with digest $existing (expected $digest); released tags are immutable"
    log "$c already published at $dst_repo:$tag ($digest)"
    continue
  fi
  log "copying $src_repo@$digest -> $dst_repo:$tag"
  docker buildx imagetools create --tag "$dst_repo:$tag" "$src_repo@$digest"
  copied="$(docker buildx imagetools inspect "$dst_repo:$tag" --format '{{json .Manifest.Digest}}' | tr -d '"')"
  [[ "$copied" == "$digest" ]] || die "digest changed during copy for $c: $copied != $digest"
done
log "all images published with unchanged digests"
