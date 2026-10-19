import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportTemplate, sha256Hex } from '../lib/export';
import { synthCustomerStack } from './fixtures';

describe('Marketplace template export', () => {
  const { json } = synthCustomerStack();

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'export-'));
    mkdirSync(join(dir, 'cdk.out'));
    writeFileSync(join(dir, 'cdk.out', 'PrivateApp.template.json'), JSON.stringify(json));
    return dir;
  }

  test('writes stable, pretty JSON with a matching sha256 file', () => {
    const dir = setup();
    const out = join(dir, 'out', 'customer-app.template.json');
    const r1 = exportTemplate(join(dir, 'cdk.out', 'PrivateApp.template.json'), out);
    const first = readFileSync(out, 'utf8');
    const r2 = exportTemplate(join(dir, 'cdk.out', 'PrivateApp.template.json'), out);
    expect(readFileSync(out, 'utf8')).toBe(first);
    expect(r1.sha256).toBe(r2.sha256);
    expect(first.endsWith('\n')).toBe(true);
    expect(readFileSync(`${out}.sha256`, 'utf8')).toBe(`${sha256Hex(first)}  customer-app.template.json\n`);
  });

  test('refuses to export a template that violates policy', () => {
    const dir = setup();
    const bad = structuredClone(json) as any;
    bad.Resources.LoadBalancer.Properties.Scheme = 'internet-facing';
    writeFileSync(join(dir, 'cdk.out', 'PrivateApp.template.json'), JSON.stringify(bad));
    expect(() => exportTemplate(join(dir, 'cdk.out', 'PrivateApp.template.json'), join(dir, 'x.json'))).toThrow(/internal-load-balancers-only/);
  });

  test('stays within the CloudFormation template body size limit for S3-hosted templates', () => {
    expect(JSON.stringify(json, null, 2).length).toBeLessThan(1_000_000);
  });
});
