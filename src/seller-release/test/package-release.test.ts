import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageRelease } from '../lib/package-release';
import { validateReleaseManifest } from '../lib/release-manifest';

const repoRoot = join(__dirname, '..', '..', '..');
const mpRepos = {
  frontend: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/frontend',
  api: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/api',
  agent: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/agent',
};
const images = {
  version: '1.2.3',
  images: {
    frontend: { repository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/frontend', tag: '1.2.3', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
    api: { repository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/api', tag: '1.2.3', digest: 'sha256:60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752' },
    agent: { repository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/agent', tag: '1.2.3', digest: 'sha256:fd61a03af4f77d870fc21e05e7e80678095c92d808cfb3b5c279ee04c74aca13' },
  },
};

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
  mkdirSync(join(dir, 'release-notes'));
  mkdirSync(join(dir, 'marketplace', 'release'), { recursive: true });
  writeFileSync(join(dir, 'release-notes', '1.2.3.md'), '# 1.2.3\n\n## Changes\n- First.\n\n## Upgrade\nUpdate the stack.\n\n## Breaking changes\nNone.\n');
  writeFileSync(join(dir, 'marketplace', 'release', 'images.json'), JSON.stringify(images));
  return dir;
}

describe('release packaging', () => {
  const dir = workspace();
  const result = packageRelease({ root: dir, commitSha: 'b'.repeat(40), marketplaceRepositories: mpRepos, upgradeFrom: ['1.2.2'], now: new Date('2026-10-17T00:00:00Z') });
  const out = (f: string) => join(dir, 'marketplace', 'release', f);

  test('writes the manifest, both templates, the fixture template, release notes and checksums', () => {
    for (const f of ['release-manifest.json', 'customer-app.template.json', 'customer-app.test.template.json', 'clean-account-fixture.template.json',
      'images.staging.json', 'images.marketplace.json', 'release-notes.md', 'SHA256SUMS']) {
      expect([f, existsSync(out(f))]).toEqual([f, true]);
    }
    const manifest = validateReleaseManifest(JSON.parse(readFileSync(out('release-manifest.json'), 'utf8')));
    expect(manifest).toEqual(result.manifest);
    expect(manifest.version).toBe('1.2.3');
  });

  test('released template references Marketplace repositories; test template references staging; digests identical', () => {
    const rel = readFileSync(out('customer-app.template.json'), 'utf8');
    const tst = readFileSync(out('customer-app.test.template.json'), 'utf8');
    expect(rel).toContain(`${mpRepos.api}@${images.images.api.digest}`);
    expect(rel).not.toContain('staging/');
    expect(tst).toContain(`${images.images.api.repository}@${images.images.api.digest}`);
  });

  test('checksums verify with sha256sum', () => {
    const r = execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: join(dir, 'marketplace', 'release') }).toString();
    expect(r).toMatch(/release-manifest.json: OK/);
    expect(r).toMatch(/customer-app.template.json: OK/);
  });

  test('refuses the checked-in fixture images', () => {
    const d = workspace();
    cpSync(join(repoRoot, 'config', 'images.dev.json'), join(d, 'marketplace', 'release', 'images.json'));
    expect(() => packageRelease({ root: d, commitSha: 'b'.repeat(40), marketplaceRepositories: mpRepos, upgradeFrom: [] })).toThrow(/fixture|placeholder/);
  });

  test('refuses to package without release notes', () => {
    const d = workspace();
    writeFileSync(join(d, 'release-notes', '1.2.3.md'), 'nothing');
    expect(() => packageRelease({ root: d, commitSha: 'b'.repeat(40), marketplaceRepositories: mpRepos, upgradeFrom: [] })).toThrow(/release-notes/);
  });
});
