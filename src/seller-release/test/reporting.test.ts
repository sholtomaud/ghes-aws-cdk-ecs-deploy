import { announceRelease, buildAnnouncement, MarkerStore, Publisher } from '../lib/announce';
import { summarizeTemplateChanges } from '../lib/template-diff';
import { summarizeNpmAudit, summarizeEcrScan, evaluateSecurity, SecuritySummary } from '../lib/security';
import { buildApprovalSummary, parseJunitTotals } from '../lib/approval-summary';
import { ReleaseManifest } from '../lib/release-manifest';
import { SubmissionRecord, VerificationRecord } from '../lib/marketplace';

const manifest = {
  schemaVersion: 1, product: 'private-ai-assistant', version: '1.2.3', commitSha: 'c'.repeat(40), builtAt: '2026-10-17T00:00:00.000Z',
  images: {
    frontend: { tag: '1.2.3', digest: `sha256:${'a1'.repeat(32)}`, stagingRepository: 's/f', marketplaceRepository: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/frontend' },
    api: { tag: '1.2.3', digest: `sha256:${'b2'.repeat(32)}`, stagingRepository: 's/a', marketplaceRepository: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/api' },
    agent: { tag: '1.2.3', digest: `sha256:${'c3'.repeat(32)}`, stagingRepository: 's/g', marketplaceRepository: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/agent' },
  },
  templates: { release: { path: 'marketplace/release/customer-app.template.json', sha256: 'd'.repeat(64) }, test: { path: 'marketplace/release/t.json', sha256: 'e'.repeat(64) } },
  releaseNotesPath: 'release-notes/1.2.3.md',
  upgradeFrom: ['1.2.1', '1.2.2'],
} as ReleaseManifest;
const submission = { productId: 'prod-abcdefgh1234', changeSetId: 'cs-1', version: '1.2.3', templateUrl: 'https://b/releases/1.2.3/t.json', deliveryOptionTitle: 'CFN' } as SubmissionRecord;
const verified: VerificationRecord = {
  status: 'VERIFIED', method: 'catalog-api', productId: 'prod-abcdefgh1234', version: '1.2.3', changeSetId: 'cs-1',
  requiredVisibility: 'Public', observedVisibility: 'Public', verifiedAt: '2026-10-17T02:00:00.000Z', reasons: [], evidence: {},
};
const notes = { path: 'release-notes/1.2.3.md', body: '# 1.2.3\n...', upgrade: 'Update the stack with the new template.', breakingChanges: 'None.' };

class FakeSns implements Publisher {
  published: Array<{ subject: string; message: string }> = [];
  fail = false;
  async publish(_topic: string, subject: string, message: string) {
    if (this.fail) throw new Error('SNS down');
    this.published.push({ subject, message });
    return { MessageId: `m-${this.published.length}` };
  }
}
class FakeMarkers implements MarkerStore {
  items = new Map<string, string>();
  async claim(key: string, body: string) { if (this.items.has(key)) return false; this.items.set(key, body); return true; }
  async update(key: string, body: string) { this.items.set(key, body); }
  async release(key: string) { this.items.delete(key); }
}

describe('announcement', () => {
  const input = (over: Partial<Parameters<typeof announceRelease>[0]> = {}) => ({
    publisher: new FakeSns(), markers: new FakeMarkers(), topicArn: 'arn:aws:sns:us-east-1:111122223333:t',
    manifest, submission, verification: verified, notes, ...over,
  });

  test('message carries version, notes, publication state, upgrade path, breaking changes and identifiers', () => {
    const { subject, message } = buildAnnouncement(input({ listingUrl: 'https://aws.amazon.com/marketplace/pp/prodview-x' }));
    expect(subject).toBe('Released private-ai-assistant 1.2.3');
    for (const s of ['1.2.3', 'Public', '2026-10-17T02:00:00.000Z', '1.2.1, 1.2.2', 'Update the stack', 'None.', 'c'.repeat(40), 'cs-1', 'd'.repeat(64), 'prodview-x', submission.templateUrl]) {
      expect(message).toContain(s);
    }
  });

  test('publishes exactly once even when retried', async () => {
    const i = input();
    expect(await announceRelease(i)).toMatchObject({ status: 'ANNOUNCED', messageId: 'm-1' });
    expect(await announceRelease(i)).toMatchObject({ status: 'ALREADY_ANNOUNCED' });
    expect((i.publisher as FakeSns).published).toHaveLength(1);
    expect(JSON.parse((i.markers as FakeMarkers).items.get('announcements/1.2.3.json')!)).toMatchObject({ messageId: 'm-1', version: '1.2.3' });
  });

  test('a failed publish releases the claim so a retry can announce', async () => {
    const i = input();
    (i.publisher as FakeSns).fail = true;
    await expect(announceRelease(i)).rejects.toThrow(/SNS down/);
    (i.publisher as FakeSns).fail = false;
    expect((await announceRelease(i)).status).toBe('ANNOUNCED');
  });

  test.each([
    ['unverified', { verification: { ...verified, status: 'INCONCLUSIVE' as const } }],
    ['failed verification', { verification: { ...verified, status: 'FAILED' as const } }],
    ['version mismatch', { verification: { ...verified, version: '1.2.4' } }],
    ['change set mismatch', { verification: { ...verified, changeSetId: 'cs-other' } }],
    ['submission for another version', { submission: { ...submission, version: '1.2.2' } }],
  ])('never announces when %s', async (_n, over) => {
    const i = input(over);
    await expect(announceRelease(i)).rejects.toThrow(/refusing to announce/);
    expect((i.publisher as FakeSns).published).toHaveLength(0);
  });
});

describe('CloudFormation change summary', () => {
  const prev = { Parameters: { A: { Type: 'String' }, Old: { Type: 'String' } }, Resources: { Keep: { Type: 'AWS::SNS::Topic', Properties: { X: 1 } }, Gone: { Type: 'AWS::SQS::Queue' }, Swap: { Type: 'AWS::S3::Bucket' }, Same: { Type: 'AWS::SNS::Topic' } } };
  const next = { Parameters: { A: { Type: 'String' }, New: { Type: 'Number' } }, Resources: { Keep: { Type: 'AWS::SNS::Topic', Properties: { X: 2 } }, Added: { Type: 'AWS::SQS::Queue' }, Swap: { Type: 'AWS::DynamoDB::Table' }, Same: { Type: 'AWS::SNS::Topic' } } };

  test('lists added, removed, modified and type-changed items and flags breaking changes', () => {
    const s = summarizeTemplateChanges(prev, next);
    expect(s).toMatchObject({
      baseline: 'previous-release',
      parametersAdded: ['New'], parametersRemoved: ['Old'],
      resourcesAdded: ['Added'], resourcesRemoved: ['Gone'], resourcesModified: ['Keep'], resourcesTypeChanged: ['Swap'],
    });
    expect(s.breaking).toBe(true);
    expect(s.markdown).toMatch(/Removed resources: Gone/);
  });

  test('first release has no baseline', () => {
    const s = summarizeTemplateChanges(undefined, next);
    expect(s.baseline).toBe('none');
    expect(s.breaking).toBe(false);
    expect(s.resourcesAdded).toHaveLength(4);
  });
});

describe('security gating', () => {
  test('summarises npm audit and ECR scan results and fails closed on high/critical or incomplete scans', () => {
    const npm = summarizeNpmAudit({ metadata: { vulnerabilities: { info: 0, low: 2, moderate: 1, high: 0, critical: 0, total: 3 } } }, 'tooling');
    const ecr = summarizeEcrScan({ imageScanStatus: { status: 'COMPLETE' }, imageScanFindings: { findingSeverityCounts: { MEDIUM: 3, LOW: 1 } } }, 'api');
    const ok: SecuritySummary = evaluateSecurity([npm, ecr]);
    expect(ok.pass).toBe(true);
    expect(ok.totals).toMatchObject({ critical: 0, high: 0, medium: 4, low: 3 });

    expect(evaluateSecurity([summarizeEcrScan({ imageScanStatus: { status: 'COMPLETE' }, imageScanFindings: { findingSeverityCounts: { HIGH: 1 } } }, 'agent')]).pass).toBe(false);
    const failedScan = evaluateSecurity([summarizeEcrScan({ imageScanStatus: { status: 'FAILED', description: 'unsupported' } }, 'frontend')]);
    expect(failedScan.pass).toBe(false);
    expect(failedScan.reasons.join()).toMatch(/frontend.*not complete/);
    expect(evaluateSecurity([]).pass).toBe(false);
  });
});

describe('approval summary', () => {
  test('parses JUnit totals', () => {
    expect(parseJunitTotals('<?xml version="1.0"?><testsuites name="jest" tests="120" failures="0" errors="0" time="3.2">')).toEqual({ tests: 120, failures: 0, errors: 0 });
    expect(() => parseJunitTotals('<nope/>')).toThrow();
  });

  test('includes every approval detail, with CustomData within the CodePipeline 500-character limit', () => {
    const security = evaluateSecurity([summarizeNpmAudit({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }, 'tooling')]);
    const s = buildApprovalSummary({
      manifest, notes, productId: 'prod-abcdefgh1234', deliveryOptionTitle: 'CloudFormation on Amazon ECS',
      unitTests: { tests: 120, failures: 0, errors: 0 },
      cleanAccount: { passed: true, cases: [{ name: 'install-two-subnets', passed: true, details: [] }] },
      security, templateChanges: summarizeTemplateChanges(undefined, { Resources: {} }),
      artifactLinks: { releaseManifest: 's3://bucket/releases/1.2.3/release-manifest.json' },
    });
    for (const str of ['1.2.3', 'c'.repeat(40), '120 tests', 'install-two-subnets', 'Security', 'CloudFormation changes', manifest.images.agent.digest,
      'prod-abcdefgh1234', 'CloudFormation on Amazon ECS', 'Update the stack', 's3://bucket/releases/1.2.3/release-manifest.json']) {
      expect(s.markdown).toContain(str);
    }
    expect(s.customData.length).toBeLessThanOrEqual(500);
    expect(s.customData).toContain('1.2.3');
    expect(s.customData).toContain('c'.repeat(12));
  });

  test('refuses to summarise a release whose gates failed', () => {
    const security = evaluateSecurity([]);
    expect(() => buildApprovalSummary({
      manifest, notes, productId: 'p', deliveryOptionTitle: 'd', unitTests: { tests: 1, failures: 0, errors: 0 },
      cleanAccount: { passed: true, cases: [] }, security, templateChanges: summarizeTemplateChanges(undefined, { Resources: {} }), artifactLinks: {},
    })).toThrow(/security/);
  });
});
