#!/usr/bin/env bash
# Automated build and tests (CodeBuild stage 1). Fails closed on any error.
#   1. tooling checks: npm ci, typecheck, Jest (CDK assertions, template + release logic), synth, template validation
#   2. dependency scans, application unit tests (image test stages) and image build/push to staging
#   3. image scan results, release packaging (manifest, templates, checksums), security gate
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
require_env COMMIT_SHA STAGING_REPOSITORY_PREFIX SELLER_REGION

log "versions: node $(node --version), npm $(npm --version), docker $(docker --version)"
npm ci
npx --no-install cdk --version
npm run typecheck
npm test
npm run cdk:synth:customer
npm run template:validate
git diff --exit-code -- marketplace/template || die "checked-in template is not reproducible from this commit"

mkdir -p reports/security
npm audit --omit=dev --json > reports/security/npm-audit-tooling.json || true
(cd app/frontend && npm audit --omit=dev --json) > reports/security/npm-audit-frontend.json || true

aws ecr get-login-password --region "$SELLER_REGION" | docker login --username AWS --password-stdin "${STAGING_REPOSITORY_PREFIX%%/*}"
ci/build-product-images.sh push

version="$(product_version)"
for c in "${COMPONENTS[@]}"; do
  repo_name="${STAGING_REPOSITORY_PREFIX#*/}/$c"
  aws ecr wait image-scan-complete --region "$SELLER_REGION" --repository-name "$repo_name" --image-id "imageTag=$version"
  aws ecr describe-image-scan-findings --region "$SELLER_REGION" --repository-name "$repo_name" --image-id "imageTag=$version" \
    --output json > "reports/security/ecr-scan-$c.json"
done
node dist/seller-release/bin/security-summary.js
npm run release:package
(cd marketplace/release && sha256sum -c SHA256SUMS)
