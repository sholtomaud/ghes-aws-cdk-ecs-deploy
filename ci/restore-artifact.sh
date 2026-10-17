#!/usr/bin/env bash
# Copy the release files handed over by the previous pipeline stage (a CodePipeline secondary input
# artifact) into the working tree, and verify their checksums. Usage: ci/restore-artifact.sh <ArtifactName>
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
name="${1:?artifact name}"
var="CODEBUILD_SRC_DIR_${name}"
src="${!var:-}"
[[ -n "$src" && -d "$src" ]] || die "input artifact $name not found ($var)"
mkdir -p marketplace/release reports
cp -R "$src/marketplace/release/." marketplace/release/
[[ -d "$src/reports" ]] && cp -R "$src/reports/." reports/
(cd marketplace/release && sha256sum -c --quiet SHA256SUMS) || die "release artifact checksums do not verify"
log "restored $name: $(node -p "require('./marketplace/release/release-manifest.json').version") @ $(node -p "require('./marketplace/release/release-manifest.json').commitSha")"
