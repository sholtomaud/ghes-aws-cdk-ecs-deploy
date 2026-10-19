import { ReleaseManifest, ReleaseNotes } from './release-manifest';
import { SecuritySummary } from './security';
import { TemplateChangeSummary } from './template-diff';

export interface JunitTotals { tests: number; failures: number; errors: number }
export interface CleanAccountCase { name: string; passed: boolean; details: string[] }
export interface CleanAccountReport { passed: boolean; cases: CleanAccountCase[] }

export interface ApprovalInput {
  manifest: ReleaseManifest;
  notes: ReleaseNotes;
  productId: string;
  deliveryOptionTitle: string;
  unitTests: JunitTotals;
  cleanAccount: CleanAccountReport;
  security: SecuritySummary;
  templateChanges: TemplateChangeSummary;
  artifactLinks: Record<string, string>;
}

export function parseJunitTotals(xml: string): JunitTotals {
  const m = /<testsuites\b[^>]*>/.exec(xml);
  if (!m) throw new Error('no <testsuites> element in JUnit report');
  const attr = (name: string) => {
    const a = new RegExp(`\\b${name}="(\\d+)"`).exec(m[0]);
    if (!a) throw new Error(`JUnit report has no ${name} attribute`);
    return Number(a[1]);
  };
  return { tests: attr('tests'), failures: attr('failures'), errors: attr('errors') };
}

/** Approval details for the human approver: full markdown (artifact) plus CodePipeline CustomData (max 500 chars). */
export function buildApprovalSummary(i: ApprovalInput): { markdown: string; customData: string } {
  const gateFailures = [
    i.unitTests.failures + i.unitTests.errors > 0 ? 'unit tests failed' : '',
    !i.cleanAccount.passed ? 'clean-account tests failed' : '',
    !i.security.pass ? `security gate failed (${i.security.reasons.join('; ')})` : '',
  ].filter(Boolean);
  if (gateFailures.length > 0) throw new Error(`release is not approvable: ${gateFailures.join(', ')}`);

  const m = i.manifest;
  const t = i.security.totals;
  const markdown = [
    `# Release approval: ${m.product} ${m.version}`,
    '',
    `- Version: ${m.version}`,
    `- Commit: ${m.commitSha}`,
    `- Built: ${m.builtAt}`,
    `- Marketplace product: ${i.productId}`,
    `- Delivery option: ${i.deliveryOptionTitle}`,
    `- Supported upgrade from: ${m.upgradeFrom.join(', ') || 'none (first release)'}`,
    '',
    '## Test results',
    `- Unit/CDK/template tests: ${i.unitTests.tests} tests, ${i.unitTests.failures} failures, ${i.unitTests.errors} errors`,
    ...i.cleanAccount.cases.map((c) => `- Clean account ${c.name}: ${c.passed ? 'PASSED' : 'FAILED'}${c.details.length ? ` (${c.details.join('; ')})` : ''}`),
    '',
    '## Security scan summary',
    `- Critical ${t.critical}, high ${t.high}, medium ${t.medium}, low ${t.low}, informational ${t.informational}`,
    ...i.security.results.map((r) => `- ${r.source}: ${r.complete ? 'complete' : 'INCOMPLETE'}`),
    '',
    '## CloudFormation changes',
    i.templateChanges.markdown,
    '',
    '## Images',
    ...Object.entries(m.images).map(([c, img]) => `- ${c}: ${img.marketplaceRepository}:${img.tag} @ ${img.digest}`),
    `- Release template SHA-256: ${m.templates.release.sha256}`,
    '',
    '## Artifacts',
    ...Object.entries(i.artifactLinks).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Upgrade and breaking changes',
    i.notes.upgrade,
    '',
    `Breaking changes: ${i.notes.breakingChanges}`,
    '',
    '## Release notes',
    i.notes.body.trim(),
    '',
  ].join('\n');

  const customData = [
    `${m.product} ${m.version} @ ${m.commitSha.slice(0, 12)}`,
    `tests ${i.unitTests.tests} ok; clean-account ${i.cleanAccount.cases.length} ok`,
    `scan C${t.critical}/H${t.high}/M${t.medium}`,
    `cfn +${i.templateChanges.resourcesAdded.length} ~${i.templateChanges.resourcesModified.length} -${i.templateChanges.resourcesRemoved.length}${i.templateChanges.breaking ? ' BREAKING' : ''}`,
    `${i.productId} / ${i.deliveryOptionTitle}`,
    'Full details: approval-summary.md (link).',
  ].join(' | ').slice(0, 500);
  return { markdown, customData };
}
