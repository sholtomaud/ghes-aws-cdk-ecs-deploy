#!/usr/bin/env bash
# Package release metadata from already-pushed images (marketplace/release/images.json). See docs/release-process.md.
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
require_env COMMIT_SHA
[[ -f marketplace/release/images.json ]] || die "marketplace/release/images.json missing: run ci/build-product-images.sh push first"
npm run release:package
(cd marketplace/release && sha256sum -c SHA256SUMS)
