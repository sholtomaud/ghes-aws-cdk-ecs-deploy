import Ajv from 'ajv';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPONENTS, Component, ImageSet } from '../../customer-app/lib/images';
import { sha256Hex } from '../../customer-app/lib/export';
import { compareSemver } from './semver';

export interface ManifestImage {
  tag: string;
  digest: string;
  /** Seller staging repository used by the clean-account tests. */
  stagingRepository: string;
  /** AWS Marketplace repository referenced by the released template (same digest). */
  marketplaceRepository: string;
}

export interface ManifestTemplate {
  path: string;
  sha256: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: string;
  version: string;
  commitSha: string;
  builtAt: string;
  images: Record<Component, ManifestImage>;
  templates: { release: ManifestTemplate; test: ManifestTemplate };
  releaseNotesPath: string;
  upgradeFrom: string[];
}

const SCHEMA_PATH = join(__dirname, '..', '..', '..', 'marketplace', 'schemas', 'release-manifest.schema.json');
let compiled: ReturnType<Ajv['compile']> | undefined;

function schemaValidator(): ReturnType<Ajv['compile']> {
  compiled ??= new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
  return compiled;
}

/** Placeholder digests: every hex digit identical (e.g. all zeros, or the 1111... test fixtures). */
export function isPlaceholderDigest(digest: string): boolean {
  return /^sha256:([a-f0-9])\1{63}$/.test(digest);
}

/** Schema plus semantic validation. Returns the manifest typed, or throws with every problem listed. */
export function validateReleaseManifest(value: unknown): ReleaseManifest {
  const validate = schemaValidator();
  if (!validate(value)) {
    const errs = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}${e.params && 'additionalProperty' in e.params ? ` (additional property ${String(e.params.additionalProperty)})` : ''}`);
    throw new Error(`release manifest failed schema validation:\n  ${errs.join('\n  ')}`);
  }
  const m = value as ReleaseManifest;
  const problems: string[] = [];
  const digests = new Set<string>();
  for (const c of COMPONENTS) {
    const img = m.images[c];
    if (isPlaceholderDigest(img.digest)) problems.push(`images.${c} has a placeholder digest`);
    if (img.tag !== m.version) problems.push(`images.${c}.tag (${img.tag}) must equal the release version`);
    digests.add(img.digest);
  }
  if (digests.size !== COMPONENTS.length) problems.push('each component image must have a distinct digest');
  if (m.releaseNotesPath !== `release-notes/${m.version}.md`) problems.push('releaseNotesPath must be release-notes/<version>.md');
  for (const from of m.upgradeFrom) {
    if (compareSemver(from, m.version) >= 0) problems.push(`upgradeFrom ${from} must be older than ${m.version}`);
  }
  if (problems.length > 0) throw new Error(`invalid release manifest:\n  ${problems.join('\n  ')}`);
  return m;
}

export interface BuildManifestInput {
  product: string;
  commitSha: string;
  builtAt: Date;
  staging: ImageSet;
  marketplaceRepositories: Record<Component, string>;
  releaseTemplate: { path: string; body: string };
  testTemplate: { path: string; body: string };
  upgradeFrom: string[];
}

export function buildReleaseManifest(input: BuildManifestInput): ReleaseManifest {
  if (input.staging.fixture) throw new Error('refusing to release a fixture image set; build and push real images first');
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) throw new Error('commitSha must be the full 40-character commit SHA');
  for (const c of COMPONENTS) {
    if (isPlaceholderDigest(input.staging.images[c].digest)) throw new Error(`images.${c} has a placeholder digest`);
  }
  const images = Object.fromEntries(COMPONENTS.map((c) => {
    const s = input.staging.images[c];
    return [c, { tag: s.tag, digest: s.digest, stagingRepository: s.repository, marketplaceRepository: input.marketplaceRepositories[c] }];
  })) as Record<Component, ManifestImage>;
  return validateReleaseManifest({
    schemaVersion: 1,
    product: input.product,
    version: input.staging.version,
    commitSha: input.commitSha,
    builtAt: input.builtAt.toISOString(),
    images,
    templates: {
      release: { path: input.releaseTemplate.path, sha256: sha256Hex(input.releaseTemplate.body) },
      test: { path: input.testTemplate.path, sha256: sha256Hex(input.testTemplate.body) },
    },
    releaseNotesPath: `release-notes/${input.staging.version}.md`,
    upgradeFrom: input.upgradeFrom,
  });
}

/** Same images (tags and digests) addressed through other repositories. */
export function retargetImages(set: ImageSet, repositories: Record<Component, string>): ImageSet {
  return {
    ...set,
    images: Object.fromEntries(COMPONENTS.map((c) => [c, { ...set.images[c], repository: repositories[c] }])) as Record<Component, ImageSet['images'][Component]>,
  };
}

/**
 * Proves the tested template and the released template describe the same deployment: identical except
 * for container image repositories, with identical digests.
 */
export function assertTemplatesDifferOnlyInImages(testTemplate: unknown, releaseTemplate: unknown): void {
  const images: Array<[string, string]> = [];
  const strip = (v: unknown, other: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => strip(x, Array.isArray(other) ? other[i] : undefined));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => {
        const o = other && typeof other === 'object' ? (other as Record<string, unknown>)[k] : undefined;
        if (k === 'Image' && typeof x === 'string' && typeof o === 'string') {
          images.push([x, o]);
          return [k, '<image>'];
        }
        return [k, strip(x, o)];
      }));
    }
    return v;
  };
  const a = JSON.stringify(strip(testTemplate, releaseTemplate));
  const b = JSON.stringify(strip(releaseTemplate, testTemplate));
  for (const [x, y] of images) {
    if (x.split('@')[1] !== y.split('@')[1]) throw new Error(`image digest mismatch between test and release templates: ${x} vs ${y}`);
  }
  if (a !== b) throw new Error('test and release templates differ in more than image repositories');
}

export interface ReleaseNotes {
  path: string;
  body: string;
  upgrade: string;
  breakingChanges: string;
}

function section(body: string, heading: string): string | undefined {
  const m = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(body);
  return m?.[1].trim() || undefined;
}

export function checkReleaseNotes(root: string, version: string): ReleaseNotes {
  const rel = `release-notes/${version}.md`;
  const path = join(root, rel);
  if (!existsSync(path)) throw new Error(`${rel} not found: every release needs release notes`);
  const body = readFileSync(path, 'utf8');
  if (!body.includes(version)) throw new Error(`${rel} must mention version ${version}`);
  const upgrade = section(body, 'Upgrade');
  if (!upgrade) throw new Error(`${rel} needs a non-empty "## Upgrade" section`);
  const breakingChanges = section(body, 'Breaking changes');
  if (!breakingChanges) throw new Error(`${rel} needs a non-empty "## Breaking changes" section (write "None." if there are none)`);
  return { path: rel, body, upgrade, breakingChanges };
}

/** Write a `sha256sum -c` compatible checksum file for files relative to dir. */
export function writeChecksums(dir: string, files: string[], output: string): void {
  writeFileSync(join(dir, output), files.map((f) => `${sha256Hex(readFileSync(join(dir, f)))}  ${f}\n`).join(''));
}
