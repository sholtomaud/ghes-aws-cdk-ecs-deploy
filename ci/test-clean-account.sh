#!/usr/bin/env bash
# Clean-account deployment tests (CodeBuild stage 2), then the approval summary for the human approver.
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
require_env ARTIFACT_BUCKET TEST_DEPLOY_ROLE_ARN
export RUN_ID="${RUN_ID:-$(printf '%s' "${CODEBUILD_BUILD_ID:-local-$(date +%s)}" | sha256sum | cut -c1-8)}"
node dist/seller-release/bin/clean-account-test.js
node dist/seller-release/bin/approval-summary.js
