import { compareSemver } from '../lib/semver';

test.each([
  ['1.0.0', '1.0.0', 0],
  ['1.0.0', '1.0.1', -1],
  ['1.10.0', '1.9.9', 1],
  ['2.0.0', '10.0.0', -1],
  ['1.0.0-rc.1', '1.0.0', -1],
  ['1.0.0', '1.0.0-rc.1', 1],
])('compareSemver(%s, %s) = %d', (a, b, r) => {
  expect(Math.sign(compareSemver(a, b))).toBe(r);
});

test('rejects non-semver input', () => {
  expect(() => compareSemver('1.0', '1.0.0')).toThrow(/semver/);
});
