#!/usr/bin/env node
import { join } from 'node:path';
import { catalogApi } from '../lib/aws';
import { loadSellerConfig } from '../lib/config';
import { main, readJson, writeJson, RELEASE_DIR } from '../lib/cli';
import { SubmissionRecord, waitForChangeSet } from '../lib/marketplace';

main(async () => {
  const cfg = loadSellerConfig(process.env);
  const submission = readJson<SubmissionRecord>(join(RELEASE_DIR, 'submission.json'));
  const record = await waitForChangeSet(catalogApi(cfg.marketplace.catalogRegion), submission, { maxWaitMinutes: cfg.marketplace.waitMaxMinutes });
  writeJson(join(RELEASE_DIR, 'processing.json'), record);
  console.log(`change set ${record.changeSetId}: ${record.outcome} (${record.status}) after ${record.polls} polls`);
  for (const e of record.errors) console.error(`  ${e.changeType ?? '-'} ${e.errorCode ?? ''}: ${e.errorMessage ?? ''}`);
  if (record.outcome !== 'SUCCEEDED') throw new Error(`Marketplace processing ${record.outcome}: ${record.failureDescription ?? record.status}`);
});
