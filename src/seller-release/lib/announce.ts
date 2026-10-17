import { ReleaseNotes, ReleaseManifest } from './release-manifest';
import { SubmissionRecord, VerificationRecord } from './marketplace';

export interface Publisher {
  publish(topicArn: string, subject: string, message: string, attributes: Record<string, string>): Promise<{ MessageId?: string }>;
}

/** Durable, create-once markers (S3 conditional writes in production). */
export interface MarkerStore {
  /** Create the marker if absent. Returns false when it already exists. */
  claim(key: string, body: string): Promise<boolean>;
  update(key: string, body: string): Promise<void>;
  release(key: string): Promise<void>;
}

export interface AnnounceInput {
  publisher: Publisher;
  markers: MarkerStore;
  topicArn: string;
  manifest: ReleaseManifest;
  submission: SubmissionRecord;
  verification: VerificationRecord;
  notes: ReleaseNotes;
  listingUrl?: string;
}

function assertVerified(i: AnnounceInput): void {
  const problems: string[] = [];
  if (i.verification.status !== 'VERIFIED') problems.push(`verification status is ${i.verification.status}`);
  if (i.verification.version !== i.manifest.version) problems.push('verification is for a different version');
  if (i.submission.version !== i.manifest.version) problems.push('submission is for a different version');
  if (i.verification.changeSetId !== i.submission.changeSetId) problems.push('verification is for a different change set');
  if (i.verification.productId !== i.submission.productId) problems.push('verification is for a different product');
  if (problems.length > 0) throw new Error(`refusing to announce: ${problems.join('; ')}`);
}

export function buildAnnouncement(i: AnnounceInput): { subject: string; message: string } {
  const m = i.manifest;
  const where = i.listingUrl
    ? `AWS Marketplace listing: ${i.listingUrl}`
    : `In AWS Marketplace, open your subscription to product ${i.submission.productId} and choose version ${m.version}.`;
  const message = [
    `${m.product} ${m.version} is available in AWS Marketplace.`,
    '',
    `Publication state: ${i.verification.observedVisibility ?? i.verification.requiredVisibility} (verified ${i.verification.verifiedAt} via ${i.verification.method})`,
    where,
    `CloudFormation template: ${i.submission.templateUrl}`,
    '',
    'How to upgrade',
    `Supported upgrade from: ${m.upgradeFrom.length > 0 ? m.upgradeFrom.join(', ') : 'fresh installs only'}`,
    'Upgrades are customer-initiated CloudFormation stack updates: create a change set with the new template, keep your existing parameter values, review it, then execute it.',
    i.notes.upgrade,
    '',
    'Breaking changes',
    i.notes.breakingChanges,
    '',
    'Release notes',
    i.notes.body.trim(),
    '',
    'Identifiers',
    `Commit: ${m.commitSha}`,
    `Template SHA-256: ${m.templates.release.sha256}`,
    `Marketplace change set: ${i.submission.changeSetId}`,
    ...Object.entries(m.images).map(([c, img]) => `Image ${c}: ${img.marketplaceRepository}:${img.tag} (${img.digest})`),
  ].join('\n');
  return { subject: `Released ${m.product} ${m.version}`.slice(0, 100), message };
}

/** Publish the release announcement once. Safe to retry: a marker records a successful announcement. */
export async function announceRelease(i: AnnounceInput): Promise<{ status: 'ANNOUNCED' | 'ALREADY_ANNOUNCED'; messageId?: string }> {
  assertVerified(i);
  const key = `announcements/${i.manifest.version}.json`;
  const claimed = await i.markers.claim(key, JSON.stringify({ version: i.manifest.version, state: 'publishing' }));
  if (!claimed) return { status: 'ALREADY_ANNOUNCED' };
  const { subject, message } = buildAnnouncement(i);
  let messageId: string | undefined;
  try {
    ({ MessageId: messageId } = await i.publisher.publish(i.topicArn, subject, message, { version: i.manifest.version, product: i.manifest.product }));
  } catch (err) {
    await i.markers.release(key);
    throw err;
  }
  await i.markers.update(key, JSON.stringify({ version: i.manifest.version, state: 'published', messageId, changeSetId: i.submission.changeSetId }));
  return { status: 'ANNOUNCED', messageId };
}
