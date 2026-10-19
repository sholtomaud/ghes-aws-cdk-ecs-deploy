import { createHash } from 'node:crypto';
import { COMPONENTS } from '../../customer-app/lib/images';
import { Visibility } from './config';
import { ReleaseManifest } from './release-manifest';

/**
 * AWS Marketplace Catalog API workflow for a new ContainerProduct version.
 *
 * The request uses the documented AddDeliveryOptions change type with EcrDeliveryOptionDetails. Field-level
 * metadata that depends on the seller's listing lives in config/marketplace-delivery-option.json; confirm it
 * against the current Catalog API documentation and your product's DescribeEntity output before first use.
 */

export const ENTITY_TYPE = 'ContainerProduct@1.0';
export const NONTERMINAL_STATUSES = ['PREPARING', 'APPLYING'] as const;
export const SUCCESS_STATUS = 'SUCCEEDED';
export const FAILURE_STATUSES = ['FAILED', 'CANCELLED'] as const;

export interface ChangeSetSummary { ChangeSetId?: string; ChangeSetArn?: string; ChangeSetName?: string; Status?: string }
export interface ChangeSetDescription {
  Status?: string;
  FailureCode?: string;
  FailureDescription?: string;
  ChangeSet?: Array<{ ChangeType?: string; ErrorDetailList?: Array<{ ErrorCode?: string; ErrorMessage?: string }> }>;
}

/** The subset of the Catalog API used here; implemented by an SDK adapter and by test fakes. */
export interface CatalogApi {
  startChangeSet(request: StartChangeSetRequest): Promise<{ ChangeSetId?: string; ChangeSetArn?: string }>;
  listChangeSets(entityId: string, changeSetName: string): Promise<ChangeSetSummary[]>;
  describeChangeSet(changeSetId: string): Promise<ChangeSetDescription>;
  describeEntity(entityId: string): Promise<{ Details?: string }>;
}

export interface StartChangeSetRequest {
  Catalog: 'AWSMarketplace';
  ChangeSetName: string;
  ClientRequestToken: string;
  ChangeSet: Array<{ ChangeType: string; Entity: { Type: string; Identifier: string }; DetailsDocument: unknown }>;
}

export interface DeliveryOptionConfig {
  compatibleServices: string[];
  deploymentResourceName: string;
  description: string;
  usageInstructions: string;
}

export interface SubmissionTarget {
  productId: string;
  deliveryOptionTitle: string;
  templateUrl: string;
}

export interface SubmissionRecord {
  productId: string;
  changeSetId: string;
  changeSetArn: string;
  changeSetName: string;
  version: string;
  commitSha: string;
  deliveryOptionTitle: string;
  templateUrl: string;
  templateSha256: string;
  images: Array<{ component: string; image: string; digest: string }>;
  submittedAt: string;
  reusedExisting: boolean;
}

export type Outcome = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
export interface ProcessingRecord {
  productId: string;
  changeSetId: string;
  version: string;
  outcome: Outcome;
  status: string;
  polls: number;
  startedAt: string;
  finishedAt: string;
  failureCode?: string;
  failureDescription?: string;
  errors: Array<{ changeType?: string; errorCode?: string; errorMessage?: string }>;
}

export type VerificationStatus = 'VERIFIED' | 'FAILED' | 'INCONCLUSIVE';
export interface VerificationRecord {
  status: VerificationStatus;
  method: 'catalog-api' | 'manual-attestation';
  productId: string;
  version: string;
  changeSetId: string;
  requiredVisibility: Visibility;
  observedVisibility?: string;
  verifiedAt: string;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export interface ManualAttestation {
  productId: string;
  version: string;
  observedVisibility: string;
  verifiedBy: string;
  evidence: string;
  verifiedAt: string;
}

const SENSITIVE_KEY = /token|secret|password|authorization|credential|session/i;

/** Deep-copy with sensitive-looking fields replaced, for preserved request/response artifacts. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v)]));
  }
  return value;
}

export function changeSetName(version: string): string {
  return `release-${version}`.replace(/[^\w.+=:@-]/g, '-');
}

/** Deterministic idempotency token: retrying the same attempt returns the same change set. */
export function clientRequestToken(m: ReleaseManifest, attempt: number): string {
  return createHash('sha256').update(`${m.product}|${m.version}|${m.commitSha}|${attempt}`).digest('hex').slice(0, 36);
}

export function buildAddDeliveryOptionsRequest(
  m: ReleaseManifest, target: SubmissionTarget, option: DeliveryOptionConfig, releaseNotes: string, attempt = 0,
): StartChangeSetRequest {
  if (!target.templateUrl.startsWith('https://')) throw new Error('templateUrl must be an https URL');
  const fill = (s: string) => s.replaceAll('{{version}}', m.version).replaceAll('{{templateUrl}}', target.templateUrl);
  return {
    Catalog: 'AWSMarketplace',
    ChangeSetName: changeSetName(m.version),
    ClientRequestToken: clientRequestToken(m, attempt),
    ChangeSet: [{
      ChangeType: 'AddDeliveryOptions',
      Entity: { Type: ENTITY_TYPE, Identifier: target.productId },
      DetailsDocument: {
        Version: { VersionTitle: m.version, ReleaseNotes: releaseNotes },
        DeliveryOptions: [{
          DeliveryOptionTitle: target.deliveryOptionTitle,
          Details: {
            EcrDeliveryOptionDetails: {
              ContainerImages: COMPONENTS.map((c) => `${m.images[c].marketplaceRepository}:${m.images[c].tag}`),
              DeploymentResources: [{ Name: option.deploymentResourceName, Url: target.templateUrl }],
              CompatibleServices: option.compatibleServices,
              Description: fill(option.description),
              UsageInstructions: fill(option.usageInstructions),
            },
          },
        }],
      },
    }],
  };
}

interface EntityVersion { Id?: string; VersionTitle?: string; DeliveryOptions?: Array<Record<string, unknown>> }

async function entityVersions(api: CatalogApi, productId: string): Promise<{ details: Record<string, unknown>; versions: EntityVersion[] }> {
  const { Details } = await api.describeEntity(productId);
  const details = JSON.parse(Details ?? '{}') as Record<string, unknown>;
  return { details, versions: Array.isArray(details.Versions) ? (details.Versions as EntityVersion[]) : [] };
}

/**
 * Submit the release, never twice: an in-flight or succeeded change set for this version is reused, and a
 * version that already exists on the product is refused (released versions are immutable).
 */
export async function submitRelease(
  api: CatalogApi, m: ReleaseManifest, target: SubmissionTarget, option: DeliveryOptionConfig, releaseNotes: string,
  now: () => Date = () => new Date(),
): Promise<SubmissionRecord> {
  const name = changeSetName(m.version);
  const existing = (await api.listChangeSets(target.productId, name)).filter((c) => c.ChangeSetName === name);
  const record = (id: string, arn: string, reusedExisting: boolean): SubmissionRecord => ({
    productId: target.productId,
    changeSetId: id,
    changeSetArn: arn,
    changeSetName: name,
    version: m.version,
    commitSha: m.commitSha,
    deliveryOptionTitle: target.deliveryOptionTitle,
    templateUrl: target.templateUrl,
    templateSha256: m.templates.release.sha256,
    images: COMPONENTS.map((c) => ({ component: c, image: `${m.images[c].marketplaceRepository}:${m.images[c].tag}`, digest: m.images[c].digest })),
    submittedAt: now().toISOString(),
    reusedExisting,
  });

  const active = existing.find((c) => [...NONTERMINAL_STATUSES, SUCCESS_STATUS].includes(c.Status as never));
  if (active?.ChangeSetId) return record(active.ChangeSetId, active.ChangeSetArn ?? '', true);

  const { versions } = await entityVersions(api, target.productId);
  if (versions.some((v) => v.VersionTitle === m.version)) {
    throw new Error(`version ${m.version} already exists on ${target.productId}; released versions are immutable, create a new version`);
  }

  const attempt = existing.filter((c) => (FAILURE_STATUSES as readonly string[]).includes(c.Status ?? '')).length;
  const res = await api.startChangeSet(buildAddDeliveryOptionsRequest(m, target, option, releaseNotes, attempt));
  if (!res.ChangeSetId) throw new Error('StartChangeSet returned no ChangeSetId');
  return record(res.ChangeSetId, res.ChangeSetArn ?? '', false);
}

export interface WaitOptions { maxWaitMinutes: number; initialDelaySeconds?: number; maxDelaySeconds?: number; maxConsecutiveErrors?: number }
export interface Clock { now(): Date; sleep(ms: number): Promise<void> }

export const realClock: Clock = { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Poll DescribeChangeSet with bounded exponential backoff until a documented terminal status or timeout. */
export async function waitForChangeSet(api: CatalogApi, submission: SubmissionRecord, opts: WaitOptions, clock: Clock = realClock): Promise<ProcessingRecord> {
  const start = clock.now().getTime();
  const deadline = start + opts.maxWaitMinutes * 60_000;
  const maxDelay = (opts.maxDelaySeconds ?? 300) * 1000;
  const maxErrors = opts.maxConsecutiveErrors ?? 5;
  let delay = (opts.initialDelaySeconds ?? 30) * 1000;
  let polls = 0;
  let errorsInARow = 0;
  let status = 'UNKNOWN';
  const done = (outcome: Outcome, extra: Partial<ProcessingRecord> = {}): ProcessingRecord => ({
    productId: submission.productId,
    changeSetId: submission.changeSetId,
    version: submission.version,
    outcome,
    status,
    polls,
    startedAt: new Date(start).toISOString(),
    finishedAt: clock.now().toISOString(),
    errors: [],
    ...extra,
  });

  for (;;) {
    polls++;
    try {
      const d = await api.describeChangeSet(submission.changeSetId);
      errorsInARow = 0;
      status = d.Status ?? 'UNKNOWN';
      if (status === SUCCESS_STATUS) return done('SUCCEEDED');
      if ((FAILURE_STATUSES as readonly string[]).includes(status)) {
        return done('FAILED', {
          failureCode: d.FailureCode,
          failureDescription: d.FailureDescription,
          errors: (d.ChangeSet ?? []).flatMap((c) => (c.ErrorDetailList ?? []).map((e) => ({ changeType: c.ChangeType, errorCode: e.ErrorCode, errorMessage: e.ErrorMessage }))),
        });
      }
      if (!(NONTERMINAL_STATUSES as readonly string[]).includes(status)) {
        return done('FAILED', { failureDescription: `undocumented status ${status}; failing closed` });
      }
    } catch (err) {
      errorsInARow++;
      if (errorsInARow >= maxErrors || /AccessDenied|ResourceNotFound|Validation/i.test(String((err as Error).message))) {
        return done('FAILED', { failureDescription: `DescribeChangeSet error: ${(err as Error).message}` });
      }
    }
    const remaining = deadline - clock.now().getTime();
    if (remaining <= 0) return done('TIMED_OUT', { failureDescription: `no terminal status after ${opts.maxWaitMinutes} minutes` });
    await clock.sleep(Math.min(delay, remaining));
    delay = Math.min(Math.round(delay * 1.5), maxDelay);
  }
}

export interface VerificationExpectation { version: string; deliveryOptionTitle: string; requiredVisibility: Visibility }

/**
 * Prove the intended release state from DescribeEntity. A succeeded change set alone is not proof.
 * When the API does not expose visibility, the result is INCONCLUSIVE unless a matching seller-portal
 * attestation is supplied; an attestation can never override a state the API contradicts.
 */
export async function verifyPublication(
  api: CatalogApi, submission: SubmissionRecord, processing: ProcessingRecord, expect: VerificationExpectation,
  now: () => Date = () => new Date(), attestation?: ManualAttestation,
): Promise<VerificationRecord> {
  const base = {
    productId: submission.productId, version: expect.version, changeSetId: submission.changeSetId,
    requiredVisibility: expect.requiredVisibility, verifiedAt: now().toISOString(),
  };
  const result = (status: VerificationStatus, reasons: string[], evidence: Record<string, unknown> = {}, extra: Partial<VerificationRecord> = {}): VerificationRecord =>
    ({ ...base, status, method: 'catalog-api', reasons, evidence, ...extra });

  if (processing.outcome !== 'SUCCEEDED' || processing.changeSetId !== submission.changeSetId) {
    return result('FAILED', [`change set ${submission.changeSetId} did not succeed (outcome ${processing.outcome})`]);
  }
  if (submission.version !== expect.version) return result('FAILED', ['submission version does not match the release manifest']);

  const { details, versions } = await entityVersions(api, submission.productId);
  const version = versions.find((v) => v.VersionTitle === expect.version);
  if (!version) return result('FAILED', [`version ${expect.version} not found on ${submission.productId}`], { versionTitles: versions.map((v) => v.VersionTitle) });
  const option = (version.DeliveryOptions ?? []).find((o) => (o.Title ?? o.DeliveryOptionTitle) === expect.deliveryOptionTitle);
  const evidence: Record<string, unknown> = {
    versionId: version.Id,
    deliveryOptionId: option?.Id,
    deliveryOptionTitles: (version.DeliveryOptions ?? []).map((o) => o.Title ?? o.DeliveryOptionTitle),
    productVisibility: (details.Description as Record<string, unknown> | undefined)?.Visibility,
  };
  if (!option) return result('FAILED', [`delivery option "${expect.deliveryOptionTitle}" not found in version ${expect.version}`], evidence);

  const observed = typeof option.Visibility === 'string' ? option.Visibility : undefined;
  if (observed !== undefined) {
    if (observed === expect.requiredVisibility) return result('VERIFIED', [], evidence, { observedVisibility: observed });
    return result('FAILED', [`delivery option visibility is ${observed}, release policy requires ${expect.requiredVisibility}`], evidence, { observedVisibility: observed });
  }

  const reason = 'the Catalog API response does not expose delivery option visibility; seller-portal verification is required';
  if (attestation
    && attestation.productId === submission.productId
    && attestation.version === expect.version
    && attestation.observedVisibility === expect.requiredVisibility
    && attestation.verifiedBy && attestation.evidence) {
    return result('VERIFIED', [reason], { ...evidence, attestation }, { method: 'manual-attestation', observedVisibility: attestation.observedVisibility });
  }
  return result('INCONCLUSIVE', [reason], evidence);
}
