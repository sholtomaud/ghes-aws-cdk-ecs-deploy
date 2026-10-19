import { parseImageSet, imageUri, COMPONENTS } from '../lib/images';

const good = {
  version: '1.2.3',
  images: Object.fromEntries(COMPONENTS.map((c, i) => [c, {
    repository: `709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/${c}`,
    tag: '1.2.3',
    digest: `sha256:${String(i + 4).repeat(64)}`,
  }])),
};

describe('image set', () => {
  test('parses a complete image set and builds digest-pinned URIs', () => {
    const set = parseImageSet(good);
    expect(set.fixture).toBe(false);
    expect(imageUri(set.images.api)).toBe(`709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/api@sha256:${'5'.repeat(64)}`);
  });

  test('requires all three components', () => {
    const { agent: _agent, ...rest } = good.images;
    expect(() => parseImageSet({ ...good, images: rest })).toThrow(/images\.agent/);
  });

  test.each([
    [{ tag: 'latest' }, /latest/],
    [{ digest: 'sha256:abc' }, /digest/],
    [{ digest: 'md5:' + 'a'.repeat(64) }, /digest/],
    [{ repository: 'Not A Repo' }, /repository/],
    [{ repository: 'repo:with-tag' }, /repository/],
  ])('rejects invalid image %j', (patch, err) => {
    const bad = structuredClone(good);
    Object.assign(bad.images.frontend, patch);
    expect(() => parseImageSet(bad)).toThrow(err);
  });

  test('rejects a non-semver version', () => {
    expect(() => parseImageSet({ ...good, version: 'main' })).toThrow(/version/);
  });

  test('marks fixture sets', () => {
    expect(parseImageSet({ ...good, fixture: true }).fixture).toBe(true);
  });
});
