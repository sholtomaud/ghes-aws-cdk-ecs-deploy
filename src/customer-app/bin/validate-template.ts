#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { validateTemplate } from '../lib/template-validation';
import { sha256Hex } from '../lib/export';

const path = process.argv[2] ?? 'marketplace/template/customer-app.template.json';
let body: string;
try {
  body = readFileSync(path, 'utf8');
} catch {
  console.error(`template not found: ${path} (run 'make synth-customer' first)`);
  process.exit(1);
}
const expected = readFileSync(`${path}.sha256`, 'utf8').split(/\s+/)[0];
if (sha256Hex(body) !== expected) {
  console.error(`checksum mismatch for ${path}: the template was modified after export`);
  process.exit(1);
}
const violations = validateTemplate(JSON.parse(body));
for (const v of violations) console.error(`[${v.rule}] ${v.resource ?? '-'}: ${v.message}`);
if (violations.length > 0) process.exit(1);
console.log(`${path}: ${Object.keys(JSON.parse(body).Resources).length} resources, all template policy checks passed`);
