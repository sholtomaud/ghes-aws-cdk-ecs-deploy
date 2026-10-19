#!/usr/bin/env bash
# Marketplace verify stage. Requires explicit seller configuration and permissions; never run from GitHub Actions.
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
require_env MARKETPLACE_PRODUCT_ID MARKETPLACE_CATALOG_REGION ARTIFACT_BUCKET
node dist/seller-release/bin/marketplace-verify.js
