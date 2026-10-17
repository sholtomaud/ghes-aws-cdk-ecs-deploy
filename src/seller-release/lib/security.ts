export interface ScanResult {
  source: string;
  complete: boolean;
  description?: string;
  counts: { critical: number; high: number; medium: number; low: number; informational: number };
}

export interface SecuritySummary {
  pass: boolean;
  reasons: string[];
  totals: ScanResult['counts'];
  results: ScanResult[];
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** `npm audit --json` (npm 7+) */
export function summarizeNpmAudit(audit: { metadata?: { vulnerabilities?: Record<string, number> } }, source: string): ScanResult {
  const v = audit.metadata?.vulnerabilities;
  return {
    source: `npm-audit:${source}`,
    complete: v !== undefined,
    counts: { critical: n(v?.critical), high: n(v?.high), medium: n(v?.moderate), low: n(v?.low), informational: n(v?.info) },
  };
}

/** `aws ecr describe-image-scan-findings` output */
export function summarizeEcrScan(
  findings: { imageScanStatus?: { status?: string; description?: string }; imageScanFindings?: { findingSeverityCounts?: Record<string, number> } },
  source: string,
): ScanResult {
  const c = findings.imageScanFindings?.findingSeverityCounts ?? {};
  return {
    source: `ecr-scan:${source}`,
    complete: findings.imageScanStatus?.status === 'COMPLETE',
    description: findings.imageScanStatus?.description,
    counts: { critical: n(c.CRITICAL), high: n(c.HIGH), medium: n(c.MEDIUM), low: n(c.LOW), informational: n(c.INFORMATIONAL) + n(c.UNDEFINED) },
  };
}

/** Fail closed: any incomplete scan, any high/critical finding, or no scans at all fails the release. */
export function evaluateSecurity(results: ScanResult[]): SecuritySummary {
  const totals = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
  const reasons: string[] = [];
  if (results.length === 0) reasons.push('no security scan results were provided');
  for (const r of results) {
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += r.counts[k];
    if (!r.complete) reasons.push(`${r.source} scan is not complete${r.description ? ` (${r.description})` : ''}`);
    if (r.counts.critical + r.counts.high > 0) reasons.push(`${r.source} has ${r.counts.critical} critical and ${r.counts.high} high findings`);
  }
  return { pass: reasons.length === 0, reasons, totals, results };
}
