#!/usr/bin/env node
import { loadSellerConfig } from '../lib/config';
import { main, requireEnv } from '../lib/cli';
import { packageRelease } from '../lib/package-release';

// Inputs: marketplace/release/images.json written by ci/build-product-images.sh after pushing real images.
main(async () => {
  const cfg = loadSellerConfig(process.env);
  const commitSha = requireEnv('COMMIT_SHA', process.env, /^[0-9a-f]{40}$/);
  const { manifest, files } = packageRelease({
    root: process.cwd(), commitSha, marketplaceRepositories: cfg.marketplace.repositories, upgradeFrom: cfg.supportedUpgradeFrom,
  });
  console.log(`packaged ${manifest.product} ${manifest.version} (${commitSha}): ${files.join(', ')}`);
});
