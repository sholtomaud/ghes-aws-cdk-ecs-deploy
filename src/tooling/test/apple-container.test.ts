import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const script = join(root, 'ci', 'apple-container.sh');

function fakeBin(statusExit: number, withDocker = true): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'apple-'));
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'container'), `#!/bin/sh\necho "container $*" >> ${log}\n[ "$1 $2" = "system status" ] && exit ${statusExit}\n[ "$1" = "--version" ] && echo "container CLI version 0.9.0"\nexit 0\n`);
  chmodSync(join(dir, 'container'), 0o755);
  if (withDocker) {
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\necho "docker $*" >> ${log}\nexit 0\n`);
    chmodSync(join(dir, 'docker'), 0o755);
  }
  return { dir, log };
}
const run = (args: string[], path: string, env: Record<string, string> = {}) =>
  spawnSync('bash', [script, ...args], { cwd: root, encoding: 'utf8', env: { PATH: path, HOME: tmpdir(), ...env } });
const calls = (log: string) => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };

describe('Apple container CLI wrapper', () => {
  test('fails with installation guidance when the CLI is missing, and never falls back to Docker', () => {
    const { dir, log } = fakeBin(0);
    const r = run(['build', 'img:local'], `${dir}-missing:/usr/bin:/bin`, { APPLE_CONTAINER_SKIP_OS_CHECK: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Apple's container CLI was not found/);
    expect(r.stderr).toMatch(/github\.com\/apple\/container/);
    expect(calls(log)).not.toMatch(/docker/);
  });

  test('requires the container system service to be running', () => {
    const { dir, log } = fakeBin(1);
    const r = run(['build', 'img:local'], `${dir}:/usr/bin:/bin`, { APPLE_CONTAINER_SKIP_OS_CHECK: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/container system start/);
    expect(calls(log)).not.toMatch(/container build/);
  });

  test('builds the same Containerfile and runs commands in the image', () => {
    const { dir, log } = fakeBin(0);
    expect(run(['build', 'img:local'], `${dir}:/usr/bin:/bin`, { APPLE_CONTAINER_SKIP_OS_CHECK: '1' }).status).toBe(0);
    expect(run(['run', 'img:local', 'npm', 'test'], `${dir}:/usr/bin:/bin`, { APPLE_CONTAINER_SKIP_OS_CHECK: '1' }).status).toBe(0);
    const c = calls(log);
    expect(c).toContain('container build --file Containerfile --tag img:local .');
    expect(c).toContain('container run --rm img:local npm test');
    expect(c).not.toMatch(/^docker/m);
  });

  test('refuses to run on a non-macOS host unless explicitly overridden', () => {
    const { dir } = fakeBin(0);
    const r = run(['build', 'img:local'], `${dir}:/usr/bin:/bin`);
    if (process.platform !== 'darwin') {
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/macOS/);
    }
  });
});
