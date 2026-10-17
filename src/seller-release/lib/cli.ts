import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function requireEnv(name: string, env: Record<string, string | undefined> = process.env, pattern?: RegExp): string {
  const v = (env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is required`);
  if (pattern && !pattern.test(v)) throw new Error(`${name} is invalid (expected ${pattern.source})`);
  return v;
}

export function readJson<T = unknown>(path: string): T {
  if (!existsSync(path)) throw new Error(`required artifact missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Run a CLI body; any error fails the process (fail closed) after its artifacts were written. */
export async function main(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

export const RELEASE_DIR = 'marketplace/release';
export const REPORTS_DIR = 'reports';
