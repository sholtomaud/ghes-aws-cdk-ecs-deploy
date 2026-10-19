#!/usr/bin/env node
import { join } from 'node:path';
import { catalogApi, s3Objects } from '../lib/aws';
import { loadSellerConfig } from '../lib/config';
import { main, readJson, requireEnv, writeJson, RELEASE_DIR } from '../lib/cli';
import { ManualAttestation, ProcessingRecord, SubmissionRecord, verifyPublication } from '../lib/marketplace';
import { validateReleaseManifest } from '../lib/release-manifest';

main(async () => {
  const cfg = loadSellerConfig(process.env);
  const manifest = validateReleaseManifest(readJson(join(RELEASE_DIR, 'release-manifest.json')));
  const submission = readJson<SubmissionRecord>(join(RELEASE_DIR, 'submission.json'));
  const processing = readJson<ProcessingRecord>(join(RELEASE_DIR, 'processing.json'));
  // Optional seller-portal attestation (docs/release-process.md), used only when the API is inconclusive.
  const attestationBody = await s3Objects(requireEnv('ARTIFACT_BUCKET'), cfg.seller.region).get(`releases/${manifest.version}/manual-verification.json`);
  const attestation = attestationBody ? (JSON.parse(attestationBody) as ManualAttestation) : undefined;

  const record = await verifyPublication(catalogApi(cfg.marketplace.catalogRegion), submission, processing, {
    version: manifest.version, deliveryOptionTitle: cfg.marketplace.deliveryOptionTitle, requiredVisibility: cfg.marketplace.requiredVisibility,
  }, () => new Date(), attestation);
  writeJson(join(RELEASE_DIR, 'verification.json'), record);
  console.log(`verification ${record.status} via ${record.method}${record.reasons.length ? `: ${record.reasons.join('; ')}` : ''}`);
  if (record.status !== 'VERIFIED') throw new Error(`publication not verified (${record.status}); see docs/release-process.md for the manual verification gate`);
});
