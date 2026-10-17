import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReleaseManifest, validateReleaseManifest, retargetImages, assertTemplatesDifferOnlyInImages,
  checkReleaseNotes, writeChecksums, ReleaseManifest,
} from '../lib/release-manifest';
import { ImageSet, COMPONENTS } from '../../customer-app/lib/images';
import { sha256Hex } from '../../customer-app/lib/export';

const SHA = 'a'.repeat(40);
const stagingImages: ImageSet = {
  fixture: false,
  version: '1.2.3',
  images: {
    frontend: { repository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/frontend', tag: '1.2.3', digest: 'sha256:0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9' },
    api: { repository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/api', tag: '1.2.3', digest: 'sha256:1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a' },
    agent: { repository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/agent', tag: '1.2.3', digest: 'sha256:2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b' },
  },
};
const mpRepos = {
  frontend: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/frontend',
  api: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/api',
  agent: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/agent',
};

function manifest(overrides: Partial<Parameters<typeof buildReleaseManifest>[0]> = {}): ReleaseManifest {
  return buildReleaseManifest({
    product: 'private-ai-assistant',
    commitSha: SHA,
    builtAt: new Date('2026-10-17T00:00:00Z'),
    staging: stagingImages,
    marketplaceRepositories: mpRepos,
    releaseTemplate: { path: 'marketplace/release/customer-app.template.json', body: '{"r":1}' },
    testTemplate: { path: 'marketplace/release/customer-app.test.template.json', body: '{"t":1}' },
    upgradeFrom: ['1.2.2'],
    ...overrides,
  });
}

describe('release manifest', () => {
  test('carries version, commit, digests, both repositories and template checksums', () => {
    const m = manifest();
    expect(validateReleaseManifest(m)).toEqual(m);
    expect(m).toMatchObject({ schemaVersion: 1, version: '1.2.3', commitSha: SHA, builtAt: '2026-10-17T00:00:00.000Z', releaseNotesPath: 'release-notes/1.2.3.md' });
    expect(m.images.api).toEqual({ tag: '1.2.3', digest: stagingImages.images.api.digest, stagingRepository: stagingImages.images.api.repository, marketplaceRepository: mpRepos.api });
    expect(m.templates.release.sha256).toBe(sha256Hex('{"r":1}'));
  });

  test('refuses fixture image sets', () => {
    expect(() => manifest({ staging: { ...stagingImages, fixture: true } })).toThrow(/fixture/);
  });

  test.each([
    ['all-zero digest', 'sha256:' + '0'.repeat(64)],
    ['repeated-character placeholder digest', 'sha256:' + '1'.repeat(64)],
  ])('refuses %s', (_n, digest) => {
    const staging = structuredClone(stagingImages);
    staging.images.agent.digest = digest;
    expect(() => manifest({ staging })).toThrow(/placeholder digest/);
  });

  test('refuses image tags that do not equal the release version, and duplicate digests', () => {
    const staging = structuredClone(stagingImages);
    staging.images.frontend.tag = '1.2.2';
    expect(() => manifest({ staging })).toThrow(/tag/);
    const dup = structuredClone(stagingImages);
    dup.images.api.digest = dup.images.frontend.digest;
    expect(() => manifest({ staging: dup })).toThrow(/distinct/);
  });

  test('refuses a short commit SHA and an upgrade path from the same or a newer version', () => {
    expect(() => manifest({ commitSha: 'abc123' })).toThrow(/commitSha/);
    expect(() => manifest({ upgradeFrom: ['1.2.3'] })).toThrow(/upgradeFrom/);
    expect(() => manifest({ upgradeFrom: ['2.0.0'] })).toThrow(/upgradeFrom/);
  });

  test('schema validation rejects latest tags and unknown fields', () => {
    const m = manifest() as any;
    expect(() => validateReleaseManifest({ ...m, extra: 1 })).toThrow(/additional/);
    const bad = structuredClone(m);
    bad.images.api.tag = 'latest';
    expect(() => validateReleaseManifest(bad)).toThrow();
  });

  test('retargets images to Marketplace repositories without touching tags or digests', () => {
    const mp = retargetImages(stagingImages, mpRepos);
    for (const c of COMPONENTS) {
      expect(mp.images[c]).toEqual({ ...stagingImages.images[c], repository: mpRepos[c] });
    }
  });
});

describe('test vs release template', () => {
  const t = (img: string) => ({ Resources: { TaskDefinition: { Type: 'AWS::ECS::TaskDefinition', Properties: { ContainerDefinitions: [{ Name: 'api', Image: img }] } }, X: { Type: 'AWS::SNS::Topic' } } });
  const d = stagingImages.images.api.digest;

  test('accepts templates that differ only in image repository with the same digest', () => {
    expect(() => assertTemplatesDifferOnlyInImages(t(`${stagingImages.images.api.repository}@${d}`), t(`${mpRepos.api}@${d}`))).not.toThrow();
  });

  test('rejects different digests or any other difference', () => {
    expect(() => assertTemplatesDifferOnlyInImages(t(`a.example.com/x@${d}`), t(`b.example.com/x@sha256:${'f'.repeat(63)}e`))).toThrow(/digest/);
    const other = t(`b.example.com/x@${d}`) as any;
    other.Resources.X.Type = 'AWS::SQS::Queue';
    expect(() => assertTemplatesDifferOnlyInImages(t(`a.example.com/x@${d}`), other)).toThrow(/differ/);
  });
});

describe('release notes and checksums', () => {
  test('release notes must exist, name the version and document upgrade and breaking changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notes-'));
    mkdirSync(join(dir, 'release-notes'));
    expect(() => checkReleaseNotes(dir, '1.2.3')).toThrow(/not found/);
    writeFileSync(join(dir, 'release-notes', '1.2.3.md'), '# 1.2.3\n\nstuff\n');
    expect(() => checkReleaseNotes(dir, '1.2.3')).toThrow(/Upgrade/);
    writeFileSync(join(dir, 'release-notes', '1.2.3.md'), '# 1.2.3\n\n## Changes\n- x\n\n## Upgrade\nUpdate the stack.\n\n## Breaking changes\nNone.\n');
    expect(checkReleaseNotes(dir, '1.2.3')).toMatchObject({ upgrade: 'Update the stack.', breakingChanges: 'None.' });
  });

  test('writes sha256sum-compatible checksums', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sums-'));
    writeFileSync(join(dir, 'a.json'), 'A');
    writeFileSync(join(dir, 'b.md'), 'B');
    writeChecksums(dir, ['a.json', 'b.md'], 'SHA256SUMS');
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe(`${sha256Hex('A')}  a.json\n${sha256Hex('B')}  b.md\n`);
  });
});
