#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main, readJson, writeJson, REPORTS_DIR } from '../lib/cli';
import { evaluateSecurity, summarizeEcrScan, summarizeNpmAudit, ScanResult } from '../lib/security';

// Reads reports/security/npm-audit-<name>.json and reports/security/ecr-scan-<component>.json.
main(async () => {
  const dir = join(REPORTS_DIR, 'security');
  const results: ScanResult[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^(npm-audit|ecr-scan)-(.+)\.json$/.exec(f);
    if (!m) continue;
    results.push(m[1] === 'npm-audit' ? summarizeNpmAudit(readJson(join(dir, f)), m[2]) : summarizeEcrScan(readJson(join(dir, f)), m[2]));
  }
  const summary = evaluateSecurity(results);
  writeJson(join(REPORTS_DIR, 'security-summary.json'), summary);
  console.log(`security: critical ${summary.totals.critical}, high ${summary.totals.high}, medium ${summary.totals.medium}, low ${summary.totals.low}`);
  if (!summary.pass) throw new Error(`security gate failed:\n  ${summary.reasons.join('\n  ')}`);
});
