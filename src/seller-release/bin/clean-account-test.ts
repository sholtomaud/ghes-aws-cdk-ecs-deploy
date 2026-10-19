#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assumeRole, awsCleanAccountOps, s3Objects } from '../lib/aws';
import { runCleanAccountTests, RUN_TAG } from '../lib/clean-account';
import { loadSellerConfig } from '../lib/config';
import { main, readJson, requireEnv, writeJson, RELEASE_DIR, REPORTS_DIR } from '../lib/cli';
import { validateReleaseManifest } from '../lib/release-manifest';
import { sha256Hex } from '../../customer-app/lib/export';

main(async () => {
  const cfg = loadSellerConfig(process.env);
  const bucket = requireEnv('ARTIFACT_BUCKET');
  const runId = requireEnv('RUN_ID', process.env, /^[a-z0-9]{4,12}$/);
  const manifest = validateReleaseManifest(readJson(join(RELEASE_DIR, 'release-manifest.json')));
  const store = s3Objects(bucket, cfg.seller.region);

  // Immutable per-version test inputs, readable by the test-account role through the bucket policy.
  const upload = async (file: string) => {
    const body = readFileSync(join(RELEASE_DIR, file));
    const key = `releases/${manifest.version}/${file}`;
    if (!(await store.putIfAbsent(key, body, 'application/json'))) {
      const existing = await store.get(key);
      if (existing === undefined || sha256Hex(existing) !== sha256Hex(body)) throw new Error(`${key} already exists with different content; versions are immutable`);
    }
    return store.url(key);
  };
  const candidateTemplateUrl = await upload('customer-app.test.template.json');
  const fixtureTemplateUrl = await upload('clean-account-fixture.template.json');
  const previousTemplateUrls: Record<string, string> = {};
  for (const v of manifest.upgradeFrom) {
    const key = `releases/${v}/customer-app.test.template.json`;
    if ((await store.get(key)) === undefined) throw new Error(`supported upgrade source ${v} has no test template at s3://${bucket}/${key}`);
    previousTemplateUrls[v] = store.url(key);
  }

  const credentials = await assumeRole(cfg.test.roleArn, `clean-account-${manifest.version}-${runId}`, cfg.test.region);
  const report = await runCleanAccountTests(awsCleanAccountOps(credentials, cfg.test.region, RUN_TAG), {
    runId, testAccount: cfg.test.account, region: cfg.test.region, fixtureTemplateUrl, candidateTemplateUrl, previousTemplateUrls,
    certificateArn: cfg.test.certificateArn, appDomain: cfg.test.appDomain, bedrockModelId: cfg.test.bedrockModelId,
  });
  writeJson(join(REPORTS_DIR, 'clean-account.json'), { version: manifest.version, commitSha: manifest.commitSha, runId, ...report });
  if (!report.passed) throw new Error('clean-account tests failed; see reports/clean-account.json');
});
