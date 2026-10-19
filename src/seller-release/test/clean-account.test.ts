import { runCleanAccountTests, productParameters, CleanAccountOps, CleanAccountPlan, StackResult, RUN_TAG } from '../lib/clean-account';

const plan: CleanAccountPlan = {
  runId: 'r1a2b3',
  testAccount: '444455556666',
  region: 'us-east-1',
  fixtureTemplateUrl: 'https://artifacts.s3.amazonaws.com/releases/1.2.3/clean-account-fixture.template.json',
  candidateTemplateUrl: 'https://artifacts.s3.amazonaws.com/releases/1.2.3/customer-app.test.template.json',
  previousTemplateUrls: { '1.2.2': 'https://artifacts.s3.amazonaws.com/releases/1.2.2/customer-app.test.template.json' },
  certificateArn: 'arn:aws:acm:us-east-1:444455556666:certificate/11111111-2222-3333-4444-555555555555',
  appDomain: 'test.internal.example.com',
  bedrockModelId: 'amazon.nova-micro-v1:0',
};

const fixtureOutputs = {
  VpcId: 'vpc-0123456789abcdef0', VpcCidr: '10.80.0.0/16',
  PrivateSubnetA: 'subnet-0aaaaaaaaaaaaaaaa', PrivateSubnetB: 'subnet-0bbbbbbbbbbbbbbbb', PrivateSubnetC: 'subnet-0cccccccccccccccc',
  ProbeFunctionName: 'probe-fn',
};

class FakeOps implements CleanAccountOps {
  calls: string[] = [];
  stacks = new Map<string, { tags: Record<string, string>; params: Record<string, string> }>();
  account = '444455556666';
  failInstallOf?: string;
  publicIp = false;
  missingAlarm = false;
  selftestBody = '{"status":"ok","bedrock":"ok"}';
  preexisting = new Set(['someone-elses-stack']);

  async callerAccount() { this.calls.push('callerAccount'); return this.account; }
  private result(name: string, status: string): StackResult {
    const isFixture = name.includes('fixture');
    const outputs: Record<string, string> = isFixture ? fixtureOutputs : {
      LoadBalancerDnsName: `internal-${name}.elb.amazonaws.com`, FrontendLogGroupName: `/${name}/frontend`, ApiLogGroupName: `/${name}/api`, AgentLogGroupName: `/${name}/agent`,
    };
    return { status, outputs, resources: isFixture ? {} : { LoadBalancer: `arn:lb/${name}`, TaskSecurityGroup: `sg-${name}` } };
  }
  async deployStack(p: { name: string; templateUrl: string; parameters: Record<string, string>; tags: Record<string, string> }) {
    this.calls.push(`deploy:${p.name}`);
    this.stacks.set(p.name, { tags: p.tags, params: p.parameters });
    return this.result(p.name, this.failInstallOf && p.name.endsWith(this.failInstallOf) ? 'ROLLBACK_COMPLETE' : 'CREATE_COMPLETE');
  }
  async updateStack(p: { name: string; templateUrl: string; parameters: Record<string, string | { usePrevious: true }> }) {
    this.calls.push(`update:${p.name}`);
    const bogus = Object.values(p.parameters).some((v) => typeof v === 'string' && v.includes('00000000-0000-0000-0000-000000000000'));
    return this.result(p.name, bogus ? 'UPDATE_ROLLBACK_COMPLETE' : 'UPDATE_COMPLETE');
  }
  async deleteStack(name: string) { this.calls.push(`delete:${name}`); this.stacks.delete(name); return 'DELETE_COMPLETE'; }
  async stackTags(name: string) { return this.preexisting.has(name) ? { owner: 'someone' } : this.stacks.get(name)?.tags; }
  async loadBalancerScheme() { return 'internal'; }
  async taskNetworkInterfaces() { return [{ id: 'eni-1', publicIp: this.publicIp ? '54.1.2.3' : undefined }]; }
  async missingLogGroups() { return []; }
  async missingAlarms(names: string[]) { return this.missingAlarm ? [names[0]] : []; }
  async probe(_fn: string, url: string) {
    if (url.endsWith('/healthz')) return { status: 200, body: 'ok' };
    if (url.endsWith('/api/selftest')) return { status: 200, body: this.selftestBody };
    return { status: 302, location: 'https://mkt-r1a2b3-two.auth.us-east-1.amazoncognito.com/oauth2/authorize?client_id=x' };
  }
  async deleteRetainedResources(runId: string) { this.calls.push(`retained:${runId}`); return [`userpool tagged ${runId}`]; }
}

const quiet = () => undefined;

describe('product parameters', () => {
  test('two-subnet variant leaves the third subnet empty; three-subnet variant sets it and exercises the endpoint condition', () => {
    const two = productParameters(plan, fixtureOutputs, 'two');
    expect(two).toMatchObject({ VpcId: fixtureOutputs.VpcId, PrivateSubnetA: fixtureOutputs.PrivateSubnetA, PrivateSubnetB: fixtureOutputs.PrivateSubnetB, PrivateSubnetC: '', CreateBedrockEndpoint: 'false' });
    const three = productParameters(plan, fixtureOutputs, 'three');
    expect(three).toMatchObject({ PrivateSubnetC: fixtureOutputs.PrivateSubnetC, CreateBedrockEndpoint: 'true' });
  });

  test('ingress is the fixture VPC CIDR only and names are unique per run', () => {
    const p = productParameters(plan, fixtureOutputs, 'two');
    expect(p.AllowedIngressCidr).toBe('10.80.0.0/16');
    expect(p.AppHostname).toBe('two-r1a2b3.test.internal.example.com');
    expect(p.CognitoDomainPrefix).toMatch(/^[a-z0-9-]{1,63}$/);
    expect(p.CognitoDomainPrefix).toContain('r1a2b3');
    expect(p.EnableSmokeTestPath).toBe('true');
  });
});

describe('clean-account run', () => {
  test('runs every case in order and passes', async () => {
    const ops = new FakeOps();
    const report = await runCleanAccountTests(ops, plan, quiet);
    expect(report.cases.map((c) => c.name)).toEqual([
      'preflight-account', 'fixture-network', 'install-two-subnets', 'install-three-subnets', 'upgrade-from-1.2.2', 'rollback', 'cleanup',
    ]);
    expect(report.passed).toBe(true);
    expect(report.cases.every((c) => c.passed)).toBe(true);
  });

  test('every created stack is tagged with the run ID and cleaned up; the fixture is deleted last', async () => {
    const ops = new FakeOps();
    await runCleanAccountTests(ops, plan, quiet);
    const deploys = ops.calls.filter((c) => c.startsWith('deploy:')).map((c) => c.slice(7));
    const deletes = ops.calls.filter((c) => c.startsWith('delete:')).map((c) => c.slice(7));
    expect(new Set(deletes)).toEqual(new Set(deploys));
    expect(deletes[deletes.length - 1]).toMatch(/fixture/);
    expect(ops.calls).toContain('retained:r1a2b3');
    expect(ops.stacks.size).toBe(0);
  });

  test('stacks are created with the run tag', async () => {
    const ops = new FakeOps();
    const spy = jest.spyOn(ops, 'deployStack');
    await runCleanAccountTests(ops, plan, quiet);
    for (const [arg] of spy.mock.calls) expect(arg.tags[RUN_TAG]).toBe('r1a2b3');
  });

  test('upgrade keeps all previous parameter values', async () => {
    const ops = new FakeOps();
    const spy = jest.spyOn(ops, 'updateStack');
    await runCleanAccountTests(ops, plan, quiet);
    const upgrade = spy.mock.calls.find(([a]) => a.name.includes('upg'))![0];
    expect(upgrade.templateUrl).toBe(plan.candidateTemplateUrl);
    expect(Object.values(upgrade.parameters).every((v) => typeof v === 'object' && v.usePrevious)).toBe(true);
    expect(ops.calls.indexOf(`deploy:${upgrade.name}`)).toBeLessThan(ops.calls.indexOf(`update:${upgrade.name}`));
  });

  test('rollback case expects a failed update to roll back and the service to stay healthy', async () => {
    const ops = new FakeOps();
    const report = await runCleanAccountTests(ops, plan, quiet);
    expect(report.cases.find((c) => c.name === 'rollback')!.details.join(' ')).toMatch(/UPDATE_ROLLBACK_COMPLETE/);
  });

  test('refuses to run outside the dedicated test account and creates nothing', async () => {
    const ops = new FakeOps();
    ops.account = '111122223333';
    const report = await runCleanAccountTests(ops, plan, quiet);
    expect(report.passed).toBe(false);
    expect(report.cases[0]).toMatchObject({ name: 'preflight-account', passed: false });
    expect(ops.calls.filter((c) => c.startsWith('deploy:'))).toEqual([]);
  });

  test.each([
    ['public task IP', (o: FakeOps) => { o.publicIp = true; }, 'install-two-subnets', /public IP/],
    ['missing alarm', (o: FakeOps) => { o.missingAlarm = true; }, 'install-two-subnets', /alarm/],
    ['Bedrock self-test failure', (o: FakeOps) => { o.selftestBody = '{"status":"error"}'; }, 'install-two-subnets', /self-test/],
    ['failed install', (o: FakeOps) => { o.failInstallOf = 'three'; }, 'install-three-subnets', /ROLLBACK_COMPLETE/],
  ])('%s fails the run but still cleans up everything created', async (_n, breakIt, caseName, msg) => {
    const ops = new FakeOps();
    breakIt(ops);
    const report = await runCleanAccountTests(ops, plan, quiet);
    expect(report.passed).toBe(false);
    const c = report.cases.find((x) => x.name === caseName)!;
    expect(c.passed).toBe(false);
    expect(c.details.join(' ')).toMatch(msg);
    expect(ops.stacks.size).toBe(0);
    expect(report.cases[report.cases.length - 1]).toMatchObject({ name: 'cleanup', passed: true });
  });

  test('cleanup never deletes a stack that lacks this run tag', async () => {
    const ops = new FakeOps();
    // Simulate a name collision: the stack exists but belongs to someone else
    const orig = ops.stackTags.bind(ops);
    ops.stackTags = async (name: string) => (name.includes('two') ? { owner: 'someone' } : orig(name));
    const report = await runCleanAccountTests(ops, plan, quiet);
    expect(ops.calls.some((c) => c.startsWith('delete:') && c.includes('two'))).toBe(false);
    expect(report.cases.find((c) => c.name === 'cleanup')!.passed).toBe(false);
  });
});
