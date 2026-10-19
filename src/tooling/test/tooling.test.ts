import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

describe('tooling contract', () => {
  test('runs on Node.js 26', () => {
    expect(Number(process.versions.node.split('.')[0])).toBe(26);
    expect(JSON.parse(read('package.json')).engines.node).toBe('>=26 <27');
  });

  test('Containerfile pins a Debian-based Node 26 image and runs as non-root', () => {
    const cf = read('Containerfile');
    const froms = cf.split('\n').filter((l) => l.startsWith('FROM '));
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) expect(from).toMatch(/^FROM node:26\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}( AS \w+)?$/);
    expect(cf).toMatch(/npm ci/);
    expect(cf).toMatch(/^USER node$/m);
    expect(cf).not.toMatch(/npm (install|i) -g/);
    expect(cf).not.toMatch(/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/);
  });

  test('dependencies are pinned to exact versions and locked', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const deps of [pkg.dependencies, pkg.devDependencies]) {
      for (const [name, version] of Object.entries<string>(deps)) {
        expect(`${name}@${version}`).toMatch(/@\d+\.\d+\.\d+$/);
      }
    }
    expect(existsSync(join(root, 'package-lock.json'))).toBe(true);
    expect(JSON.parse(read('package-lock.json')).packages['node_modules/aws-cdk']).toBeDefined();
  });

  test('package exposes the required npm scripts', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    for (const s of ['typecheck', 'test', 'test:coverage', 'cdk:synth:customer', 'cdk:synth:pipeline', 'template:validate', 'release:package', 'ci']) {
      expect(scripts[s]).toBeDefined();
    }
    expect(JSON.stringify(scripts)).not.toMatch(/npx (?!--no-install)/);
  });

  test('Makefile offers the documented targets with separate Docker and Apple runtimes', () => {
    const mk = read('Makefile');
    for (const t of ['install', 'test', 'synth', 'validate', 'tooling-image', 'tooling-test', 'tooling-synth', 'clean',
      'tooling-image-docker', 'tooling-image-apple', 'tooling-test-docker', 'tooling-test-apple']) {
      expect(mk).toMatch(new RegExp(`^${t}:`, 'm'));
    }
    // clean only touches known generated directories
    const clean = mk.split(/^clean:.*$/m)[1].split(/^\S/m)[0];
    expect(clean).toMatch(/rm -rf/);
    expect(clean).not.toMatch(/rm -rf\s+(\/|\.|\*|~)(\s|$)/);
  });

  test('CI does not carry Marketplace publication credentials or actions', () => {
    const wf = read('.github/workflows/ci.yml');
    expect(wf).not.toMatch(/marketplace-submit|StartChangeSet|aws-actions\/configure-aws-credentials|secrets\./);
    for (const uses of wf.match(/uses: .*/g) ?? []) expect(uses).toMatch(/@[0-9a-f]{40}/);
  });
});
