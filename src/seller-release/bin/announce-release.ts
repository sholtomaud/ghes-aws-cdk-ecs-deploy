#!/usr/bin/env node
import { join } from 'node:path';
import { s3Markers, snsPublisher } from '../lib/aws';
import { announceRelease } from '../lib/announce';
import { loadSellerConfig } from '../lib/config';
import { main, readJson, requireEnv, writeJson, RELEASE_DIR } from '../lib/cli';
import { SubmissionRecord, VerificationRecord } from '../lib/marketplace';
import { checkReleaseNotes, validateReleaseManifest } from '../lib/release-manifest';

main(async () => {
  const cfg = loadSellerConfig(process.env);
  const manifest = validateReleaseManifest(readJson(join(RELEASE_DIR, 'release-manifest.json')));
  const result = await announceRelease({
    publisher: snsPublisher(cfg.seller.region),
    markers: s3Markers(requireEnv('ARTIFACT_BUCKET'), 'releases/', cfg.seller.region),
    topicArn: cfg.releaseTopicArn,
    manifest,
    submission: readJson<SubmissionRecord>(join(RELEASE_DIR, 'submission.json')),
    verification: readJson<VerificationRecord>(join(RELEASE_DIR, 'verification.json')),
    notes: checkReleaseNotes(process.cwd(), manifest.version),
    listingUrl: process.env.MARKETPLACE_LISTING_URL || undefined,
  });
  writeJson(join(RELEASE_DIR, 'announcement.json'), { version: manifest.version, ...result, at: new Date().toISOString() });
  console.log(`announcement: ${result.status}${result.messageId ? ` (${result.messageId})` : ''}`);
});
