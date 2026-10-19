import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Component, loadImageSet } from '../../customer-app/lib/images';
import { synthCustomerTemplate, synthTemplate } from '../../customer-app/lib/synth';
import { validateTemplate } from '../../customer-app/lib/template-validation';
import { PRODUCT_NAME } from '../../customer-app/lib/customer-app-stack';
import { CleanAccountFixtureStack } from './clean-account-fixture-stack';
import {
  assertTemplatesDifferOnlyInImages, buildReleaseManifest, checkReleaseNotes, ReleaseManifest, retargetImages, writeChecksums,
} from './release-manifest';

export interface PackageInput {
  root: string;
  commitSha: string;
  marketplaceRepositories: Record<Component, string>;
  upgradeFrom: string[];
  now?: Date;
}

const RELEASE_DIR = 'marketplace/release';
const render = (t: unknown) => `${JSON.stringify(t, null, 2)}\n`;

/**
 * Package an immutable release from images that were already built and pushed (marketplace/release/images.json).
 * Both templates are synthesised from the same digests; only the repository names differ.
 */
export function packageRelease(input: PackageInput): { manifest: ReleaseManifest; files: string[] } {
  const dir = join(input.root, RELEASE_DIR);
  mkdirSync(dir, { recursive: true });
  const staging = loadImageSet(join(dir, 'images.json'));
  if (staging.fixture) throw new Error('refusing to package fixture images: images.json must come from a real image push');
  const notes = checkReleaseNotes(input.root, staging.version);
  const marketplace = retargetImages(staging, input.marketplaceRepositories);

  const testTemplate = synthCustomerTemplate(staging);
  const releaseTemplate = synthCustomerTemplate(marketplace);
  for (const [name, t] of [['release', releaseTemplate], ['test', testTemplate]] as const) {
    const v = validateTemplate(t);
    if (v.length > 0) throw new Error(`${name} template violates policy: ${v.map((x) => `[${x.rule}] ${x.message}`).join('; ')}`);
  }
  assertTemplatesDifferOnlyInImages(testTemplate, releaseTemplate);
  const fixtureTemplate = synthTemplate((app) => new CleanAccountFixtureStack(app, 'CleanAccountFixture'));

  const releaseBody = render(releaseTemplate);
  const testBody = render(testTemplate);
  const manifest = buildReleaseManifest({
    product: PRODUCT_NAME,
    commitSha: input.commitSha,
    builtAt: input.now ?? new Date(),
    staging,
    marketplaceRepositories: input.marketplaceRepositories,
    releaseTemplate: { path: `${RELEASE_DIR}/customer-app.template.json`, body: releaseBody },
    testTemplate: { path: `${RELEASE_DIR}/customer-app.test.template.json`, body: testBody },
    upgradeFrom: input.upgradeFrom,
  });

  const files: Record<string, string> = {
    'customer-app.template.json': releaseBody,
    'customer-app.test.template.json': testBody,
    'clean-account-fixture.template.json': render(fixtureTemplate),
    'images.staging.json': render(staging),
    'images.marketplace.json': render(marketplace),
    'release-manifest.json': render(manifest),
  };
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  copyFileSync(join(input.root, notes.path), join(dir, 'release-notes.md'));
  const all = [...Object.keys(files), 'release-notes.md'];
  writeChecksums(dir, all, 'SHA256SUMS');
  return { manifest, files: [...all, 'SHA256SUMS'] };
}
