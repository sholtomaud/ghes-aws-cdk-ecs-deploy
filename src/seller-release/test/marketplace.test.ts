import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAddDeliveryOptionsRequest, submitRelease, waitForChangeSet, verifyPublication, redact, clientRequestToken,
  CatalogApi, ChangeSetDescription, DeliveryOptionConfig, SubmissionRecord, ProcessingRecord,
} from '../lib/marketplace';
import { ReleaseManifest } from '../lib/release-manifest';

const root = join(__dirname, '..', '..', '..');
const deliveryOption: DeliveryOptionConfig = JSON.parse(readFileSync(join(root, 'config', 'marketplace-delivery-option.json'), 'utf8'));

const manifest: ReleaseManifest = {
  schemaVersion: 1,
  product: 'private-ai-assistant',
  version: '1.2.3',
  commitSha: 'c'.repeat(40),
  builtAt: '2026-10-17T00:00:00.000Z',
  images: {
    frontend: { tag: '1.2.3', digest: `sha256:${'a1'.repeat(32)}`, stagingRepository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/frontend', marketplaceRepository: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/frontend' },
    api: { tag: '1.2.3', digest: `sha256:${'b2'.repeat(32)}`, stagingRepository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/api', marketplaceRepository: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/api' },
    agent: { tag: '1.2.3', digest: `sha256:${'c3'.repeat(32)}`, stagingRepository: '111122223333.dkr.ecr.us-east-1.amazonaws.com/staging/agent', marketplaceRepository: '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/agent' },
  },
  templates: { release: { path: 'marketplace/release/customer-app.template.json', sha256: 'd'.repeat(64) }, test: { path: 'marketplace/release/customer-app.test.template.json', sha256: 'e'.repeat(64) } },
  releaseNotesPath: 'release-notes/1.2.3.md',
  upgradeFrom: ['1.2.2'],
};
const target = { productId: 'prod-abcdefgh1234', deliveryOptionTitle: 'CloudFormation on Amazon ECS', templateUrl: 'https://bucket.s3.amazonaws.com/releases/1.2.3/customer-app.template.json' };
const notes = '# 1.2.3\n\n## Upgrade\nUpdate the stack.\n\n## Breaking changes\nNone.\n';

class FakeCatalog implements CatalogApi {
  started: unknown[] = [];
  changeSets: Array<{ ChangeSetId: string; ChangeSetArn: string; ChangeSetName: string; Status: string }> = [];
  entityDetails: unknown = { Versions: [] };
  statuses: Array<ChangeSetDescription | Error> = [];
  async startChangeSet(req: unknown) {
    this.started.push(req);
    return { ChangeSetId: 'cs-new', ChangeSetArn: 'arn:aws:aws-marketplace:us-east-1:111122223333:AWSMarketplace/ChangeSet/cs-new' };
  }
  async listChangeSets() { return this.changeSets; }
  async describeEntity() { return { Details: JSON.stringify(this.entityDetails) }; }
  async describeChangeSet() {
    const next = this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0];
    if (next instanceof Error) throw next;
    return next;
  }
}

describe('AddDeliveryOptions request', () => {
  const req = buildAddDeliveryOptionsRequest(manifest, target, deliveryOption, notes);

  test('targets the existing ContainerProduct entity with one AddDeliveryOptions change', () => {
    expect(req.Catalog).toBe('AWSMarketplace');
    expect(req.ChangeSetName).toBe('release-1.2.3');
    expect(req.ChangeSet).toHaveLength(1);
    expect(req.ChangeSet[0]).toMatchObject({ ChangeType: 'AddDeliveryOptions', Entity: { Type: 'ContainerProduct@1.0', Identifier: 'prod-abcdefgh1234' } });
  });

  test('includes every image (by immutable release tag in the Marketplace repositories), template URL and notes', () => {
    const doc = req.ChangeSet[0].DetailsDocument as any;
    expect(doc.Version).toEqual({ VersionTitle: '1.2.3', ReleaseNotes: notes });
    const details = doc.DeliveryOptions[0].Details.EcrDeliveryOptionDetails;
    expect(doc.DeliveryOptions[0].DeliveryOptionTitle).toBe(target.deliveryOptionTitle);
    expect(details.ContainerImages).toEqual([
      '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/frontend:1.2.3',
      '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/api:1.2.3',
      '709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/agent:1.2.3',
    ]);
    expect(details.DeploymentResources).toEqual([{ Name: deliveryOption.deploymentResourceName, Url: target.templateUrl }]);
    expect(details.CompatibleServices).toEqual(['ECS']);
    expect(details.UsageInstructions).toContain(target.templateUrl);
    expect(details.UsageInstructions).not.toMatch(/\{\{/);
    expect(JSON.stringify(req)).not.toMatch(/:latest/);
  });

  test('client request token is deterministic per version, commit and attempt, and valid for the API', () => {
    expect(req.ClientRequestToken).toBe(clientRequestToken(manifest, 0));
    expect(clientRequestToken(manifest, 0)).not.toBe(clientRequestToken(manifest, 1));
    expect(req.ClientRequestToken).toMatch(/^[\w-]{1,36}$/);
  });

  test('refuses a non-https template URL', () => {
    expect(() => buildAddDeliveryOptionsRequest(manifest, { ...target, templateUrl: 'http://x/y' }, deliveryOption, notes)).toThrow(/https/);
  });
});

describe('submission', () => {
  const now = () => new Date('2026-10-17T01:00:00Z');

  test('submits once and records a machine-readable submission', async () => {
    const api = new FakeCatalog();
    const rec = await submitRelease(api, manifest, target, deliveryOption, notes, now);
    expect(api.started).toHaveLength(1);
    expect(rec).toMatchObject<Partial<SubmissionRecord>>({
      productId: target.productId, changeSetId: 'cs-new', version: '1.2.3', commitSha: manifest.commitSha,
      submittedAt: '2026-10-17T01:00:00.000Z', reusedExisting: false, templateSha256: 'd'.repeat(64),
    });
    expect(rec.changeSetArn).toMatch(/ChangeSet\/cs-new$/);
    expect(rec.images.map((i) => i.digest)).toEqual([manifest.images.frontend.digest, manifest.images.api.digest, manifest.images.agent.digest]);
  });

  test.each(['PREPARING', 'APPLYING', 'SUCCEEDED'])('reuses an existing %s change set instead of submitting a duplicate', async (status) => {
    const api = new FakeCatalog();
    api.changeSets = [{ ChangeSetId: 'cs-old', ChangeSetArn: 'arn:old', ChangeSetName: 'release-1.2.3', Status: status }];
    const rec = await submitRelease(api, manifest, target, deliveryOption, notes, now);
    expect(api.started).toHaveLength(0);
    expect(rec).toMatchObject({ changeSetId: 'cs-old', reusedExisting: true });
  });

  test('a previously failed change set allows a new attempt with a new idempotency token', async () => {
    const api = new FakeCatalog();
    api.changeSets = [{ ChangeSetId: 'cs-f', ChangeSetArn: 'arn:f', ChangeSetName: 'release-1.2.3', Status: 'FAILED' }];
    await submitRelease(api, manifest, target, deliveryOption, notes, now);
    expect((api.started[0] as { ClientRequestToken: string }).ClientRequestToken).toBe(clientRequestToken(manifest, 1));
  });

  test('refuses to touch a version that already exists on the product', async () => {
    const api = new FakeCatalog();
    api.entityDetails = { Versions: [{ VersionTitle: '1.2.3', DeliveryOptions: [] }] };
    await expect(submitRelease(api, manifest, target, deliveryOption, notes, now)).rejects.toThrow(/already exists/);
    expect(api.started).toHaveLength(0);
  });

  test('redacts sensitive fields from preserved request/response logs', () => {
    expect(redact({ a: 1, ClientRequestToken: 't', nested: { Authorization: 'x', SecretString: 'y', ok: [{ password: 'p' }] } }))
      .toEqual({ a: 1, ClientRequestToken: '[REDACTED]', nested: { Authorization: '[REDACTED]', SecretString: '[REDACTED]', ok: [{ password: '[REDACTED]' }] } });
  });
});

describe('waiting for Marketplace processing', () => {
  const submission = { productId: target.productId, changeSetId: 'cs-1', changeSetArn: 'arn', version: '1.2.3' } as SubmissionRecord;

  function clock() {
    let t = Date.parse('2026-10-17T00:00:00Z');
    const sleeps: number[] = [];
    return { now: () => new Date(t), sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
  }

  test('polls nonterminal statuses with bounded backoff until SUCCEEDED', async () => {
    const api = new FakeCatalog();
    api.statuses = [...Array(8).fill({ Status: 'PREPARING' }), { Status: 'APPLYING' }, { Status: 'SUCCEEDED' }];
    const c = clock();
    const r = await waitForChangeSet(api, submission, { maxWaitMinutes: 240, initialDelaySeconds: 30, maxDelaySeconds: 300 }, c);
    expect(r.outcome).toBe('SUCCEEDED');
    expect(r.polls).toBe(10);
    expect(c.sleeps[0]).toBe(30000);
    expect(Math.max(...c.sleeps)).toBeLessThanOrEqual(300000);
    expect(c.sleeps.every((s, i) => i === 0 || s >= c.sleeps[i - 1])).toBe(true);
  });

  test.each(['FAILED', 'CANCELLED'])('fails immediately on %s with Marketplace error details', async (status) => {
    const api = new FakeCatalog();
    api.statuses = [{
      Status: status, FailureCode: 'CLIENT_ERROR', FailureDescription: 'Validation failed',
      ChangeSet: [{ ChangeType: 'AddDeliveryOptions', ErrorDetailList: [{ ErrorCode: 'INVALID_INPUT', ErrorMessage: 'Image not found' }] }],
    }];
    const r = await waitForChangeSet(api, submission, { maxWaitMinutes: 240 }, clock());
    expect(r).toMatchObject<Partial<ProcessingRecord>>({
      outcome: 'FAILED', status, failureCode: 'CLIENT_ERROR', failureDescription: 'Validation failed',
      errors: [{ changeType: 'AddDeliveryOptions', errorCode: 'INVALID_INPUT', errorMessage: 'Image not found' }],
    });
  });

  test('fails closed on an undocumented status', async () => {
    const api = new FakeCatalog();
    api.statuses = [{ Status: 'SOMETHING_NEW' }];
    const r = await waitForChangeSet(api, submission, { maxWaitMinutes: 240 }, clock());
    expect(r.outcome).toBe('FAILED');
    expect(r.failureDescription).toMatch(/undocumented status SOMETHING_NEW/);
  });

  test('times out after the configured maximum', async () => {
    const api = new FakeCatalog();
    api.statuses = [{ Status: 'APPLYING' }];
    const c = clock();
    const r = await waitForChangeSet(api, submission, { maxWaitMinutes: 60, initialDelaySeconds: 30, maxDelaySeconds: 300 }, c);
    expect(r.outcome).toBe('TIMED_OUT');
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test('tolerates transient API errors but fails after repeated ones', async () => {
    const api = new FakeCatalog();
    api.statuses = [new Error('ThrottlingException'), { Status: 'SUCCEEDED' }];
    expect((await waitForChangeSet(api, submission, { maxWaitMinutes: 60 }, clock())).outcome).toBe('SUCCEEDED');
    const api2 = new FakeCatalog();
    api2.statuses = [new Error('AccessDenied')];
    const r = await waitForChangeSet(api2, submission, { maxWaitMinutes: 600 }, clock());
    expect(r.outcome).toBe('FAILED');
    expect(r.failureDescription).toMatch(/AccessDenied/);
  });
});

describe('publication verification', () => {
  const processing = { changeSetId: 'cs-1', outcome: 'SUCCEEDED', status: 'SUCCEEDED' } as ProcessingRecord;
  const submission = { productId: target.productId, changeSetId: 'cs-1', version: '1.2.3' } as SubmissionRecord;
  const expectation = { version: '1.2.3', deliveryOptionTitle: target.deliveryOptionTitle, requiredVisibility: 'Public' as const };
  const now = () => new Date('2026-10-17T02:00:00Z');
  const entity = (visibility: string | undefined, title = target.deliveryOptionTitle) => ({
    Versions: [
      { VersionTitle: '1.2.2', DeliveryOptions: [{ Title: title, Visibility: 'Public' }] },
      { VersionTitle: '1.2.3', Id: 'ver-1', DeliveryOptions: [{ Id: 'do-1', Title: title, ...(visibility ? { Visibility: visibility } : {}) }] },
    ],
  });

  test('verifies version, delivery option and visibility, recording evidence', async () => {
    const api = new FakeCatalog();
    api.entityDetails = entity('Public');
    const v = await verifyPublication(api, submission, processing, expectation, now);
    expect(v).toMatchObject({ status: 'VERIFIED', method: 'catalog-api', productId: target.productId, version: '1.2.3', observedVisibility: 'Public', verifiedAt: '2026-10-17T02:00:00.000Z' });
    expect(v.evidence).toMatchObject({ versionId: 'ver-1', deliveryOptionId: 'do-1' });
  });

  test('fails when processing did not succeed (never verifies a failed change set)', async () => {
    const api = new FakeCatalog();
    api.entityDetails = entity('Public');
    const v = await verifyPublication(api, submission, { ...processing, outcome: 'TIMED_OUT' }, expectation, now);
    expect(v.status).toBe('FAILED');
  });

  test.each([
    ['visibility below policy', entity('Limited'), 'FAILED'],
    ['missing delivery option', entity('Public', 'Other title'), 'FAILED'],
    ['missing version', { Versions: [] }, 'FAILED'],
    ['visibility not exposed', entity(undefined), 'INCONCLUSIVE'],
  ])('%s -> %s', async (_n, details, status) => {
    const api = new FakeCatalog();
    api.entityDetails = details;
    expect((await verifyPublication(api, submission, processing, expectation, now)).status).toBe(status);
  });

  test('an inconclusive API result can be completed by a matching seller-portal attestation, never a contradicting one', async () => {
    const api = new FakeCatalog();
    api.entityDetails = entity(undefined);
    const attestation = { version: '1.2.3', productId: target.productId, observedVisibility: 'Public', verifiedBy: 'jane@example.com', evidence: 'portal screenshot TICKET-1', verifiedAt: '2026-10-17T01:59:00Z' };
    const v = await verifyPublication(api, submission, processing, expectation, now, attestation);
    expect(v).toMatchObject({ status: 'VERIFIED', method: 'manual-attestation', observedVisibility: 'Public' });
    expect((await verifyPublication(api, submission, processing, expectation, now, { ...attestation, version: '1.2.2' })).status).toBe('INCONCLUSIVE');
    api.entityDetails = entity('Limited');
    expect((await verifyPublication(api, submission, processing, expectation, now, attestation)).status).toBe('FAILED');
  });
});
