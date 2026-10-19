import { CleanAccountCase, CleanAccountReport } from './approval-summary';

/**
 * Clean-account deployment tests, run in the dedicated test account through a narrowly scoped role.
 * Every stack is tagged with the run ID; cleanup deletes only what this run created and verifies the tag
 * before each deletion, so pre-existing resources in the test account are never touched.
 */

export const RUN_TAG = 'marketplace:clean-account-run';
export const ALARM_SUFFIXES = ['target-5xx', 'unhealthy-targets', 'no-healthy-targets', 'cpu-high', 'memory-high'];

export interface StackResult {
  status: string;
  outputs: Record<string, string>;
  /** logical ID -> physical ID */
  resources: Record<string, string>;
}

export type ParameterValue = string | { usePrevious: true };

export interface CleanAccountOps {
  callerAccount(): Promise<string>;
  /** Create a stack and wait for a terminal status. Must not throw for a failed stack; report the status. */
  deployStack(p: { name: string; templateUrl: string; parameters: Record<string, string>; tags: Record<string, string> }): Promise<StackResult>;
  updateStack(p: { name: string; templateUrl: string; parameters: Record<string, ParameterValue> }): Promise<StackResult>;
  deleteStack(name: string): Promise<string>;
  stackTags(name: string): Promise<Record<string, string> | undefined>;
  loadBalancerScheme(loadBalancerArn: string): Promise<string>;
  taskNetworkInterfaces(taskSecurityGroupId: string): Promise<Array<{ id: string; publicIp?: string }>>;
  missingLogGroups(names: string[]): Promise<string[]>;
  missingAlarms(names: string[]): Promise<string[]>;
  /** HTTPS GET from inside the fixture VPC (probe Lambda). */
  probe(functionName: string, url: string, hostHeader: string): Promise<{ status: number; location?: string; body?: string }>;
  /** Delete resources retained by stack deletion (user pools, log groups, KMS keys) carrying RUN_TAG=runId. */
  deleteRetainedResources(runId: string): Promise<string[]>;
}

export interface CleanAccountPlan {
  runId: string;
  testAccount: string;
  region: string;
  fixtureTemplateUrl: string;
  candidateTemplateUrl: string;
  /** version -> test template URL of each supported previous release */
  previousTemplateUrls: Record<string, string>;
  certificateArn: string;
  appDomain: string;
  bedrockModelId: string;
}

export function productParameters(plan: CleanAccountPlan, fixture: Record<string, string>, variant: string): Record<string, string> {
  const three = variant === 'three';
  return {
    VpcId: fixture.VpcId,
    PrivateSubnetA: fixture.PrivateSubnetA,
    PrivateSubnetB: fixture.PrivateSubnetB,
    PrivateSubnetC: three ? fixture.PrivateSubnetC : '',
    AllowedIngressCidr: fixture.VpcCidr,
    AllowedSourceSecurityGroupId: '',
    CreateBedrockEndpoint: three ? 'true' : 'false',
    AppHostname: `${variant}-${plan.runId}.${plan.appDomain}`,
    CertificateArn: plan.certificateArn,
    CognitoDomainPrefix: `mkt-ct-${plan.runId}-${variant}`.toLowerCase().slice(0, 63),
    BedrockModelId: plan.bedrockModelId,
    DesiredCount: '1',
    LogRetentionDays: '1',
    EnableSmokeTestPath: 'true',
  };
}

class CaseFailure extends Error {}
const check = (ok: boolean, message: string) => { if (!ok) throw new CaseFailure(message); };

export async function runCleanAccountTests(ops: CleanAccountOps, plan: CleanAccountPlan, log: (msg: string) => void = console.log): Promise<CleanAccountReport> {
  const cases: CleanAccountCase[] = [];
  const created: string[] = [];
  const tags = { [RUN_TAG]: plan.runId, 'marketplace:purpose': 'clean-account-test' };
  const stackName = (suffix: string) => `mkt-ct-${plan.runId}-${suffix}`;
  let fixture: Record<string, string> = {};
  let failed = false;

  async function runCase(name: string, fn: (details: string[]) => Promise<void>): Promise<void> {
    if (failed) return;
    const details: string[] = [];
    log(`▶ ${name}`);
    try {
      await fn(details);
      cases.push({ name, passed: true, details });
      log(`✔ ${name}`);
    } catch (err) {
      details.push((err as Error).message);
      cases.push({ name, passed: false, details });
      failed = true;
      log(`✘ ${name}: ${(err as Error).message}`);
    }
  }

  async function deploy(suffix: string, templateUrl: string, parameters: Record<string, string>): Promise<{ name: string; result: StackResult }> {
    const name = stackName(suffix);
    created.push(name);
    return { name, result: await ops.deployStack({ name, templateUrl, parameters, tags }) };
  }

  async function verifyInstall(name: string, result: StackResult, hostname: string, okStatus: string, details: string[]): Promise<void> {
    check(result.status === okStatus, `${name} finished ${result.status}, expected ${okStatus}`);
    const scheme = await ops.loadBalancerScheme(result.resources.LoadBalancer);
    check(scheme === 'internal', `load balancer scheme is ${scheme}`);
    const enis = await ops.taskNetworkInterfaces(result.resources.TaskSecurityGroup);
    check(enis.length > 0, 'no running task network interfaces found');
    const withIp = enis.filter((e) => e.publicIp);
    check(withIp.length === 0, `tasks have a public IP: ${withIp.map((e) => e.id).join(', ')}`);
    const missingLogs = await ops.missingLogGroups(['Frontend', 'Api', 'Agent'].map((c) => result.outputs[`${c}LogGroupName`]));
    check(missingLogs.length === 0, `missing log groups: ${missingLogs.join(', ')}`);
    const missingAlarms = await ops.missingAlarms(ALARM_SUFFIXES.map((s) => `${name}-${s}`));
    check(missingAlarms.length === 0, `missing alarms: ${missingAlarms.join(', ')}`);
    await verifyReachable(result, hostname, details);
    details.push(`${result.status}, internal ALB, ${enis.length} task ENI(s) without public IP, logs and alarms present`);
  }

  async function verifyReachable(result: StackResult, hostname: string, details: string[]): Promise<void> {
    const base = `https://${result.outputs.LoadBalancerDnsName}`;
    const health = await ops.probe(fixture.ProbeFunctionName, `${base}/healthz`, hostname);
    check(health.status === 200, `/healthz returned ${health.status}`);
    const root = await ops.probe(fixture.ProbeFunctionName, `${base}/`, hostname);
    check(root.status === 302 && /amazoncognito\.com\//.test(root.location ?? ''), `unauthenticated request was not redirected to Cognito (status ${root.status})`);
    const self = await ops.probe(fixture.ProbeFunctionName, `${base}/api/selftest`, hostname);
    let bedrock = '';
    try { bedrock = String((JSON.parse(self.body ?? '{}') as { bedrock?: string }).bedrock ?? ''); } catch { /* reported below */ }
    check(self.status === 200 && bedrock === 'ok', `Bedrock self-test failed (status ${self.status})`);
    details.push('reachable from the VPC; sign-in redirects to Cognito; Bedrock self-test ok');
  }

  await runCase('preflight-account', async (details) => {
    const account = await ops.callerAccount();
    check(account === plan.testAccount, `credentials are for account ${account}, not the dedicated test account ${plan.testAccount}`);
    details.push(`running in test account ${account} (${plan.region})`);
  });

  await runCase('fixture-network', async (details) => {
    const { name, result } = await deploy('fixture', plan.fixtureTemplateUrl, {});
    check(result.status === 'CREATE_COMPLETE', `${name} finished ${result.status}`);
    fixture = result.outputs;
    for (const k of ['VpcId', 'VpcCidr', 'PrivateSubnetA', 'PrivateSubnetB', 'PrivateSubnetC', 'ProbeFunctionName']) check(Boolean(fixture[k]), `fixture output ${k} missing`);
    details.push(`isolated VPC ${fixture.VpcId} with three private subnets`);
  });

  let twoStack: { name: string; result: StackResult; hostname: string } | undefined;
  for (const variant of ['two', 'three'] as const) {
    await runCase(`install-${variant}-subnets`, async (details) => {
      const params = productParameters(plan, fixture, variant);
      const { name, result } = await deploy(variant, plan.candidateTemplateUrl, params);
      await verifyInstall(name, result, params.AppHostname, 'CREATE_COMPLETE', details);
      if (variant === 'two') twoStack = { name, result, hostname: params.AppHostname };
    });
  }

  for (const [version, url] of Object.entries(plan.previousTemplateUrls)) {
    await runCase(`upgrade-from-${version}`, async (details) => {
      const variant = `upg-${version.replace(/\./g, '-')}`;
      const params = productParameters(plan, fixture, variant);
      const { name, result } = await deploy(variant, url, params);
      check(result.status === 'CREATE_COMPLETE', `installing ${version} finished ${result.status}`);
      const keep = Object.fromEntries(Object.keys(params).map((k) => [k, { usePrevious: true as const }]));
      const upgraded = await ops.updateStack({ name, templateUrl: plan.candidateTemplateUrl, parameters: keep });
      await verifyInstall(name, upgraded, params.AppHostname, 'UPDATE_COMPLETE', details);
      details.push(`upgraded ${version} -> candidate with all previous parameter values`);
    });
  }

  await runCase('rollback', async (details) => {
    check(twoStack !== undefined, 'two-subnet stack unavailable');
    const { name, result, hostname } = twoStack!;
    // A certificate that cannot exist forces the listener update to fail and CloudFormation to roll back.
    const bogusCert = plan.certificateArn.replace(/certificate\/.*/, 'certificate/00000000-0000-0000-0000-000000000000');
    const params = productParameters(plan, fixture, 'two');
    const parameters: Record<string, ParameterValue> = Object.fromEntries(Object.keys(params).map((k) => [k, { usePrevious: true as const }]));
    parameters.CertificateArn = bogusCert;
    const r = await ops.updateStack({ name, templateUrl: plan.candidateTemplateUrl, parameters });
    check(r.status === 'UPDATE_ROLLBACK_COMPLETE', `failed update ended ${r.status}, expected UPDATE_ROLLBACK_COMPLETE`);
    details.push(`failed update rolled back: ${r.status}`);
    await verifyReachable(result, hostname, details);
  });

  // Cleanup always runs, even after failures.
  const cleanupDetails: string[] = [];
  let cleanupOk = true;
  const fixtureName = stackName('fixture');
  const order = [...created.filter((n) => n !== fixtureName).reverse(), ...created.filter((n) => n === fixtureName)];
  for (const name of order) {
    if (name === fixtureName) {
      try {
        cleanupDetails.push(...(await ops.deleteRetainedResources(plan.runId)).map((r) => `deleted retained ${r}`));
      } catch (err) {
        cleanupOk = false;
        cleanupDetails.push(`retained resource cleanup failed: ${(err as Error).message}`);
      }
    }
    try {
      const t = await ops.stackTags(name);
      if (t === undefined) { cleanupDetails.push(`${name} not found (nothing to delete)`); continue; }
      if (t[RUN_TAG] !== plan.runId) { cleanupOk = false; cleanupDetails.push(`${name} is not tagged with this run; refusing to delete`); continue; }
      const status = await ops.deleteStack(name);
      if (status !== 'DELETE_COMPLETE') { cleanupOk = false; cleanupDetails.push(`${name} delete ended ${status}`); } else cleanupDetails.push(`deleted ${name}`);
    } catch (err) {
      cleanupOk = false;
      cleanupDetails.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (!created.includes(fixtureName) && created.length > 0) {
    cleanupDetails.push(...(await ops.deleteRetainedResources(plan.runId)).map((r) => `deleted retained ${r}`));
  }
  cases.push({ name: 'cleanup', passed: cleanupOk, details: cleanupDetails });
  return { passed: !failed && cleanupOk, cases };
}
