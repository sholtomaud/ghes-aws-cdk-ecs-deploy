#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { s3Objects } from '../lib/aws';
import { buildApprovalSummary, CleanAccountReport, parseJunitTotals } from '../lib/approval-summary';
import { loadSellerConfig } from '../lib/config';
import { main, readJson, requireEnv, RELEASE_DIR, REPORTS_DIR } from '../lib/cli';
import { checkReleaseNotes, validateReleaseManifest } from '../lib/release-manifest';
import { SecuritySummary } from '../lib/security';
import { summarizeTemplateChanges } from '../lib/template-diff';
import { compareSemver } from '../lib/semver';

main(async () => {
  const cfg = loadSellerConfig(process.env);
  const bucket = requireEnv('ARTIFACT_BUCKET');
  const manifest = validateReleaseManifest(readJson(join(RELEASE_DIR, 'release-manifest.json')));
  const notes = checkReleaseNotes(process.cwd(), manifest.version);
  const templates = s3Objects(cfg.templates.bucket, cfg.seller.region);
  const latestPrevious = [...manifest.upgradeFrom].sort(compareSemver).pop();
  const previousBody = latestPrevious ? await templates.get(`releases/${latestPrevious}/customer-app.template.json`) : undefined;
  if (latestPrevious && previousBody === undefined) throw new Error(`previous release template ${latestPrevious} not found`);

  const artifacts = s3Objects(bucket, cfg.seller.region);
  const prefix = `releases/${manifest.version}`;
  const summary = buildApprovalSummary({
    manifest, notes, productId: cfg.marketplace.productId, deliveryOptionTitle: cfg.marketplace.deliveryOptionTitle,
    unitTests: parseJunitTotals(readFileSync(join(REPORTS_DIR, 'junit.xml'), 'utf8')),
    cleanAccount: readJson<CleanAccountReport>(join(REPORTS_DIR, 'clean-account.json')),
    security: readJson<SecuritySummary>(join(REPORTS_DIR, 'security-summary.json')),
    templateChanges: summarizeTemplateChanges(previousBody ? JSON.parse(previousBody) : undefined, readJson(join(RELEASE_DIR, 'customer-app.template.json'))),
    artifactLinks: {
      releaseManifest: `s3://${bucket}/${prefix}/release-manifest.json`,
      testTemplate: `s3://${bucket}/${prefix}/customer-app.test.template.json`,
      approvalSummary: `s3://${bucket}/${prefix}/approval-summary.md`,
    },
  });
  writeFileSync(join(RELEASE_DIR, 'approval-summary.md'), summary.markdown);
  writeFileSync(join(RELEASE_DIR, 'approval-custom-data.txt'), summary.customData);
  await artifacts.put(`${prefix}/approval-summary.md`, summary.markdown, 'text/markdown');
  await artifacts.put(`${prefix}/release-manifest.json`, readFileSync(join(RELEASE_DIR, 'release-manifest.json')), 'application/json');
  console.log(summary.customData);
});
