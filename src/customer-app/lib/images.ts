import { readFileSync } from 'node:fs';

export const COMPONENTS = ['frontend', 'api', 'agent'] as const;
export type Component = (typeof COMPONENTS)[number];

export interface ImageRef {
  /** Registry host and repository path, without tag or digest. */
  repository: string;
  /** Immutable release tag (informational; deployments pin the digest). */
  tag: string;
  /** Content digest, `sha256:<64 hex>`. */
  digest: string;
}

export interface ImageSet {
  /** True for offline test fixtures; release tooling refuses fixture sets. */
  fixture: boolean;
  version: string;
  images: Record<Component, ImageRef>;
}

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const REPOSITORY = /^[a-z0-9]+([.-][a-z0-9]+)*(:\d+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseImageRef(v: unknown, path: string): ImageRef {
  if (!isRecord(v)) throw new Error(`${path} must be an object`);
  const { repository, tag, digest } = v;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) throw new Error(`${path}.repository is not a valid repository without tag/digest`);
  if (typeof tag !== 'string' || !TAG.test(tag)) throw new Error(`${path}.tag is invalid`);
  if (tag === 'latest') throw new Error(`${path}.tag must not be "latest"`);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error(`${path}.digest must be sha256:<64 hex>`);
  return { repository, tag, digest };
}

export function parseImageSet(v: unknown): ImageSet {
  if (!isRecord(v)) throw new Error('image set must be an object');
  if (typeof v.version !== 'string' || !SEMVER.test(v.version)) throw new Error('version must be semantic (x.y.z)');
  if (!isRecord(v.images)) throw new Error('images must be an object');
  const imgs = v.images;
  const images = Object.fromEntries(COMPONENTS.map((c) => [c, parseImageRef(imgs[c], `images.${c}`)])) as Record<Component, ImageRef>;
  return { fixture: v.fixture === true, version: v.version, images };
}

export function loadImageSet(path: string): ImageSet {
  return parseImageSet(JSON.parse(readFileSync(path, 'utf8')));
}

/** Digest-pinned image URI usable by ECS. */
export function imageUri(ref: ImageRef): string {
  return `${ref.repository}@${ref.digest}`;
}
