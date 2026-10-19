#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogApi, s3Objects } from '../lib/aws';
import { loadSellerConfig } from '../lib/config';
import { main, readJson, writeJson, RELEASE_DIR } from '../lib/cli';
import { buildAddDeliveryOptionsRequest, DeliveryOptionConfig, redact, submitRelease } from '../lib/marketplace';
import { checkReleaseNotes, validateReleaseManifest } from '../lib/release-manifest';
import { sha256Hex } from '../../customer-app/lib/export';

main(async () => {
  const cfg = loadSellerConfig(process.env);
  const manifest = validateReleaseManifest(readJson(join(RELEASE_DIR, 'release-manifest.json')));
  const notes = checkReleaseNotes(process.cwd(), manifest.version);
  const option = readJson<DeliveryOptionConfig>('config/marketplace-delivery-option.json');

  // Publish the immutable, versioned template buyers will download. Never overwrite a different body.
  const body = readFileSync(join(RELEASE_DIR, 'customer-app.template.json'));
  if (sha256Hex(body) !== manifest.templates.release.sha256) throw new Error('release template does not match the manifest checksum');
  const key = `releases/${manifest.version}/customer-app.template.json`;
  const templates = s3Objects(cfg.templates.bucket, cfg.seller.region);
  if (!(await templates.putIfAbsent(key, body, 'application/json'))) {
    const existing = await templates.get(key);
    if (existing === undefined || sha256Hex(existing) !== manifest.templates.release.sha256) {
      throw new Error(`${key} already published with different content; create a new version`);
    }
  }
  const target = { productId: cfg.marketplace.productId, deliveryOptionTitle: cfg.marketplace.deliveryOptionTitle, templateUrl: `${cfg.templates.publicBaseUrl}/${key}` };
  writeJson(join(RELEASE_DIR, 'submission-request.redacted.json'), redact(buildAddDeliveryOptionsRequest(manifest, target, option, notes.body)));

  const record = await submitRelease(catalogApi(cfg.marketplace.catalogRegion), manifest, target, option, notes.body);
  writeJson(join(RELEASE_DIR, 'submission.json'), record);
  console.log(`${record.reusedExisting ? 'reusing existing' : 'started'} change set ${record.changeSetId} for ${record.version}`);
});
