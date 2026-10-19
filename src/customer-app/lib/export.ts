import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { validateTemplate } from './template-validation';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Copy a synthesised template to its Marketplace location as stable, pretty-printed JSON and write a
 * `sha256sum`-compatible checksum next to it. Fails if the template violates the policy rules.
 */
export function exportTemplate(source: string, destination: string): { sha256: string; bytes: number } {
  const template: unknown = JSON.parse(readFileSync(source, 'utf8'));
  const violations = validateTemplate(template);
  if (violations.length > 0) {
    throw new Error(`template policy violations:\n${violations.map((v) => `  [${v.rule}] ${v.resource ?? '-'}: ${v.message}`).join('\n')}`);
  }
  const body = `${JSON.stringify(template, null, 2)}\n`;
  const sha256 = sha256Hex(body);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, body);
  writeFileSync(`${destination}.sha256`, `${sha256}  ${basename(destination)}\n`);
  return { sha256, bytes: Buffer.byteLength(body) };
}
