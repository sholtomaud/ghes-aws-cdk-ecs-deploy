import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireEnv, writeJson, readJson, main } from '../lib/cli';

test('requireEnv names the missing variable', () => {
  expect(() => requireEnv('NOPE_NOT_SET', {})).toThrow(/NOPE_NOT_SET is required/);
  expect(requireEnv('X', { X: ' v ' })).toBe('v');
  expect(() => requireEnv('SHA', { SHA: 'abc' }, /^[0-9a-f]{40}$/)).toThrow(/SHA is invalid/);
});

test('writeJson writes stable JSON and readJson reports missing artifacts clearly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  writeJson(join(dir, 'a', 'b.json'), { z: 1 });
  expect(readFileSync(join(dir, 'a', 'b.json'), 'utf8')).toBe('{\n  "z": 1\n}\n');
  expect(readJson(join(dir, 'a', 'b.json'))).toEqual({ z: 1 });
  expect(() => readJson(join(dir, 'missing.json'))).toThrow(/required artifact missing: .*missing.json/);
});

test('main sets a failing exit code and prints the error message', async () => {
  const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const prev = process.exitCode;
  await main(async () => { throw new Error('boom'); });
  expect(process.exitCode).toBe(1);
  expect(err).toHaveBeenCalledWith('ERROR: boom');
  process.exitCode = prev;
  err.mockRestore();
});
