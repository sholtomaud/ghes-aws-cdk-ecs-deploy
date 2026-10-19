#!/usr/bin/env bash
# Announce a verified release through SNS. Safe to retry: a marker prevents duplicate announcements.
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
require_env RELEASE_TOPIC_ARN ARTIFACT_BUCKET
[[ -f marketplace/release/verification.json ]] || die "verification.json missing: nothing is announced without verification"
node dist/seller-release/bin/announce-release.js
