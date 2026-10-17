import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SellerReleasePipelineStack, STAGE_ORDER } from '../lib/pipeline-stack';
import { loadSellerConfig, parseEnvFile } from '../lib/config';

const cfg = loadSellerConfig(parseEnvFile(readFileSync(join(__dirname, '..', '..', '..', '.env.example'), 'utf8')));
const stack = new SellerReleasePipelineStack(new App(), 'SellerRelease', { config: cfg, env: { account: cfg.seller.account, region: cfg.seller.region } });
const template = Template.fromStack(stack);
const json = template.toJSON() as { Resources: Record<string, { Type: string; Properties: any }> };

const pipeline = Object.values(json.Resources).find((r) => r.Type === 'AWS::CodePipeline::Pipeline')!.Properties;
const stages: Array<{ Name: string; Actions: any[] }> = pipeline.Stages;
const stage = (name: string) => stages.find((s) => s.Name === name)!;

/** Map CodeBuild action -> its project's role policy statements. */
function projectLogicalId(action: any): string {
  return action.Configuration.ProjectName.Ref;
}
function roleStatements(projectId: string): any[] {
  const roleRef = json.Resources[projectId].Properties.ServiceRole['Fn::GetAtt'][0];
  return Object.values(json.Resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((x: any) => x.Ref === roleRef))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
}
const actionsOf = (statements: any[]) => statements.flatMap((s) => [s.Action].flat());
const projectFor = (stageName: string, actionName?: string) => {
  const s = stage(stageName);
  const a = actionName ? s.Actions.find((x) => x.Name === actionName) : s.Actions[0];
  return projectLogicalId(a);
};

describe('stage order and gating', () => {
  test('stages appear in exactly the specified order after the source stage', () => {
    expect(stages.map((s) => s.Name)).toEqual(['Source', ...STAGE_ORDER]);
    expect(STAGE_ORDER).toEqual(['BuildAndTest', 'CleanAccountTests', 'ReleaseApproval', 'MarketplaceSubmission', 'MarketplaceProcessing', 'PublicationVerification', 'AnnounceRelease']);
  });

  test('source is the configured GitHub branch through CodeConnections', () => {
    expect(stage('Source').Actions[0]).toMatchObject({
      ActionTypeId: { Category: 'Source', Provider: 'CodeStarSourceConnection' },
      Configuration: { ConnectionArn: cfg.github.connectionArn, FullRepositoryId: `${cfg.github.owner}/${cfg.github.repo}`, BranchName: cfg.github.branch },
    });
  });

  test('a single manual approval sits between clean-account tests and submission and notifies approvers', () => {
    const approvals = stages.flatMap((s) => s.Actions.filter((a) => a.ActionTypeId.Category === 'Approval').map((a) => ({ stage: s.Name, a })));
    expect(approvals).toHaveLength(1);
    expect(approvals[0].stage).toBe('ReleaseApproval');
    const names = stages.map((s) => s.Name);
    expect(names.indexOf('CleanAccountTests')).toBe(names.indexOf('ReleaseApproval') - 1);
    expect(names.indexOf('MarketplaceSubmission')).toBe(names.indexOf('ReleaseApproval') + 1);
    const cfgA = approvals[0].a.Configuration;
    expect(cfgA.NotificationArn).toEqual({ Ref: expect.stringMatching(/ApprovalTopic/) });
    expect(cfgA.CustomData).toContain('#{CleanAccountTests.APPROVAL_CUSTOM_DATA}');
    expect(JSON.stringify(cfgA.ExternalEntityLink)).toContain('#{BuildAndTest.VERSION}');
  });

  test('submission consumes only the artifact produced by the clean-account stage (cannot run on untested output)', () => {
    const tested = stage('CleanAccountTests').Actions[0].OutputArtifacts.map((o: any) => o.Name);
    for (const a of stage('MarketplaceSubmission').Actions) {
      expect(a.InputArtifacts.map((i: any) => i.Name)).toEqual(['SourceOutput', ...tested]);
    }
    const [publish, submit] = stage('MarketplaceSubmission').Actions;
    expect([publish.Name, publish.RunOrder, submit.Name, submit.RunOrder]).toEqual(['PublishImages', 1, 'SubmitChangeSet', 2]);
  });

  test('wait, verify and announce are separate single-action stages chained by artifacts', () => {
    const chain = ['MarketplaceSubmission', 'MarketplaceProcessing', 'PublicationVerification', 'AnnounceRelease'];
    for (const name of chain.slice(1)) expect(stage(name).Actions).toHaveLength(1);
    const out = (name: string) => stage(name).Actions.flatMap((a) => (a.OutputArtifacts ?? []).map((o: any) => o.Name));
    expect(stage('MarketplaceProcessing').Actions[0].InputArtifacts.map((i: any) => i.Name)).toEqual(['SourceOutput', ...out('MarketplaceSubmission')]);
    expect(stage('PublicationVerification').Actions[0].InputArtifacts.map((i: any) => i.Name)).toEqual(['SourceOutput', ...out('MarketplaceProcessing')]);
    expect(stage('AnnounceRelease').Actions[0].InputArtifacts.map((i: any) => i.Name)).toEqual(['SourceOutput', 'VerificationOutput']);
    expect(out('PublicationVerification')).toEqual(['VerificationOutput']);
  });

  test('queued executions: a new commit never supersedes a release mid-Marketplace processing', () => {
    expect(pipeline).toMatchObject({ PipelineType: 'V2', ExecutionMode: 'QUEUED' });
  });

  test('release CodeBuild projects can only be started by the pipeline (no webhooks)', () => {
    for (const r of Object.values(json.Resources).filter((x) => x.Type === 'AWS::CodeBuild::Project')) {
      expect(r.Properties.Source.Type).toBe('CODEPIPELINE');
      expect(r.Properties.Triggers).toBeUndefined();
    }
  });

  test('every CodeBuild stage uses its checked-in buildspec', () => {
    const files = Object.values(json.Resources).filter((x) => x.Type === 'AWS::CodeBuild::Project').map((r) => r.Properties.Source.BuildSpec).sort();
    expect(files).toEqual(['buildspec/announce-release.yml', 'buildspec/build-and-test.yml', 'buildspec/marketplace-submit.yml', 'buildspec/marketplace-verify.yml',
      'buildspec/marketplace-wait.yml', 'buildspec/publish-images.yml', 'buildspec/test-clean-account.yml']);
  });

  test('the wait stage timeout covers the configured maximum Marketplace wait', () => {
    const wait = json.Resources[projectFor('MarketplaceProcessing')].Properties;
    expect(wait.TimeoutInMinutes).toBeGreaterThanOrEqual(cfg.marketplace.waitMaxMinutes);
    expect(wait.TimeoutInMinutes).toBeLessThanOrEqual(480);
  });
});

describe('IAM separation', () => {
  const roles = {
    build: projectFor('BuildAndTest'),
    clean: projectFor('CleanAccountTests'),
    publish: projectFor('MarketplaceSubmission', 'PublishImages'),
    submit: projectFor('MarketplaceSubmission', 'SubmitChangeSet'),
    wait: projectFor('MarketplaceProcessing'),
    verify: projectFor('PublicationVerification'),
    announce: projectFor('AnnounceRelease'),
  };

  test('each stage runs with its own role', () => {
    const roleIds = Object.values(roles).map((p) => json.Resources[p].Properties.ServiceRole['Fn::GetAtt'][0]);
    expect(new Set(roleIds).size).toBe(roleIds.length);
  });

  test('Marketplace Catalog actions are limited per stage and absent elsewhere', () => {
    const mp = (k: keyof typeof roles) => actionsOf(roleStatements(roles[k])).filter((a: string) => a.startsWith('aws-marketplace:')).sort();
    expect(mp('submit')).toEqual(['aws-marketplace:DescribeEntity', 'aws-marketplace:ListChangeSets', 'aws-marketplace:StartChangeSet']);
    expect(mp('wait')).toEqual(['aws-marketplace:DescribeChangeSet']);
    expect(mp('verify')).toEqual(['aws-marketplace:DescribeEntity']);
    for (const k of ['build', 'clean', 'publish', 'announce'] as const) expect(mp(k)).toEqual([]);
  });

  test('StartChangeSet is scoped to the configured product entity', () => {
    const st = roleStatements(roles.submit).find((s) => [s.Action].flat().includes('aws-marketplace:StartChangeSet'));
    expect(JSON.stringify(st.Resource)).toContain(`ContainerProduct/${cfg.marketplace.productId}`);
  });

  test('image publishing to Marketplace ECR is only in the publish role, separate from Catalog permissions', () => {
    const pushActions = ['ecr:PutImage', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload'];
    const pushesToMarketplace = (k: keyof typeof roles) => roleStatements(roles[k]).some((s) =>
      [s.Action].flat().some((a: string) => pushActions.includes(a)) && JSON.stringify(s.Resource).includes('709825985650'));
    expect(pushesToMarketplace('publish')).toBe(true);
    for (const k of ['build', 'clean', 'submit', 'wait', 'verify', 'announce'] as const) expect(pushesToMarketplace(k)).toBe(false);
  });

  test('sts:AssumeRole only in the clean-account role, scoped to the single test role', () => {
    for (const [k, p] of Object.entries(roles)) {
      const st = roleStatements(p).filter((s) => [s.Action].flat().includes('sts:AssumeRole'));
      if (k === 'clean') expect(st.map((s) => s.Resource)).toEqual([cfg.test.roleArn]);
      else expect(st).toEqual([]);
    }
  });

  test('sns:Publish to the release topic only in the announce role', () => {
    for (const [k, p] of Object.entries(roles)) {
      const st = roleStatements(p).filter((s) => [s.Action].flat().includes('sns:Publish'));
      if (k === 'announce') expect(st.map((s) => s.Resource)).toEqual([cfg.releaseTopicArn]);
      else expect(st).toEqual([]);
    }
  });

  test('no wildcard actions; Resource "*" only for APIs without resource scoping', () => {
    const allowedStar = new Set(['ecr:GetAuthorizationToken', 'aws-marketplace:ListChangeSets', 'aws-marketplace:DescribeChangeSet']);
    for (const p of Object.values(roles)) {
      for (const s of roleStatements(p)) {
        for (const a of [s.Action].flat()) expect(a).not.toMatch(/(^\*$|:\*$)/);
        if (s.Resource === '*') expect([s.Action].flat().every((a: string) => allowedStar.has(a))).toBe(true);
      }
    }
  });
});

describe('artifacts, images and logging', () => {
  test('release artifact bucket is versioned, private, TLS-only, retained and readable by the test role for templates', () => {
    template.hasResource('AWS::S3::Bucket', {
      Properties: Match.objectLike({
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        BucketEncryption: Match.anyValue(),
      }),
      DeletionPolicy: 'Retain',
    });
    const policy = JSON.stringify(Object.values(json.Resources).find((r) => r.Type === 'AWS::S3::BucketPolicy')!.Properties.PolicyDocument);
    expect(policy).toContain('aws:SecureTransport');
    expect(policy).toContain(cfg.test.roleArn);
  });

  test('staging repositories are immutable, scanned on push and pullable (read-only) by the dedicated test account', () => {
    const repos = Object.values(json.Resources).filter((r) => r.Type === 'AWS::ECR::Repository');
    expect(repos).toHaveLength(3);
    for (const r of repos) {
      expect(r.Properties).toMatchObject({ ImageTagMutability: 'IMMUTABLE', ImageScanningConfiguration: { ScanOnPush: true } });
      const policy = r.Properties.RepositoryPolicyText;
      expect(JSON.stringify(policy)).toContain(`:${cfg.test.account}:root`);
      expect(policy.Statement.flatMap((st: any) => [st.Action].flat()).sort()).toEqual(['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer']);
    }
  });

  test('CodeBuild logs are retained under an explicit policy', () => {
    for (const r of Object.values(json.Resources).filter((x) => x.Type === 'AWS::Logs::LogGroup')) {
      expect(r.Properties.RetentionInDays).toBe(365);
    }
    for (const r of Object.values(json.Resources).filter((x) => x.Type === 'AWS::CodeBuild::Project')) {
      expect(r.Properties.LogsConfig.CloudWatchLogs.Status).toBe('ENABLED');
    }
  });

  test('build environment receives only non-secret configuration as plaintext, and nothing uses latest', () => {
    const s = JSON.stringify(json);
    expect(s).not.toMatch(/:latest"/);
    expect(s).not.toMatch(/AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/);
    for (const r of Object.values(json.Resources).filter((x) => x.Type === 'AWS::CodeBuild::Project')) {
      for (const v of r.Properties.Environment.EnvironmentVariables ?? []) expect(v.Type).toBe('PLAINTEXT');
    }
    const build = json.Resources[projectFor('BuildAndTest')].Properties.Environment;
    expect(build.PrivilegedMode).toBe(true);
    expect(build.EnvironmentVariables.map((v: any) => v.Name)).toEqual(expect.arrayContaining(['MARKETPLACE_PRODUCT_ID', 'STAGING_REPOSITORY_PREFIX', 'ARTIFACT_BUCKET']));
  });

  test('approver emails subscribe to the approval topic', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'release-approver@example.com' });
  });

  test('stack refuses to synthesise into an account or region other than the configured seller account', () => {
    expect(() => new SellerReleasePipelineStack(new App(), 'Wrong', { config: cfg, env: { account: '999999999999', region: cfg.seller.region } })).toThrow(/SELLER_ACCOUNT_ID/);
    expect(() => new SellerReleasePipelineStack(new App(), 'Wrong2', { config: cfg, env: { account: cfg.seller.account, region: 'eu-west-1' } })).toThrow(/SELLER_REGION/);
  });
});
