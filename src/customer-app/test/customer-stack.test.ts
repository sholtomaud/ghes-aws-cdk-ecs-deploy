import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Match } from 'aws-cdk-lib/assertions';
import { synthCustomerStack, onlyResource, resourcesOfType, CfnTemplate } from './fixtures';

const { template, json } = synthCustomerStack();

const TWO_SUBNETS = [{ Ref: 'PrivateSubnetA' }, { Ref: 'PrivateSubnetB' }];
const THREE_SUBNETS = [{ Ref: 'PrivateSubnetA' }, { Ref: 'PrivateSubnetB' }, { Ref: 'PrivateSubnetC' }];
const SUBNET_SELECTION = { 'Fn::If': ['UseThirdSubnet', THREE_SUBNETS, TWO_SUBNETS] };

/** Paths of arrays that contain AWS::NoValue as an element (Fn::If branch positions excluded). */
function noValueListElements(value: unknown, path = '$'): string[] {
  const isNoValue = (v: unknown) => JSON.stringify(v) === '{"Ref":"AWS::NoValue"}';
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => (isNoValue(v) ? [`${path}[${i}]`] : noValueListElements(v, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      k === 'Fn::If' && Array.isArray(v) ? v.slice(1).flatMap((b, i) => (isNoValue(b) ? [] : noValueListElements(b, `${path}.Fn::If[${i + 1}]`)))
        : noValueListElements(v, `${path}.${k}`));
  }
  return [];
}

/** Resolve every Fn::If on `condition` in a value, as CloudFormation would for one branch. */
function resolveBranch(value: unknown, condition: string, branch: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveBranch(v, condition, branch));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const fnIf = obj['Fn::If'] as [string, unknown, unknown] | undefined;
    if (fnIf && fnIf[0] === condition) return resolveBranch(branch ? fnIf[1] : fnIf[2], condition, branch);
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveBranch(v, condition, branch)]));
  }
  return value;
}

describe('customer network parameters', () => {
  test('VPC and subnet parameters have deploy-time types and no hard-coded values', () => {
    template.hasParameter('VpcId', { Type: 'AWS::EC2::VPC::Id', Default: Match.absent() });
    template.hasParameter('PrivateSubnetA', { Type: 'AWS::EC2::Subnet::Id', Default: Match.absent() });
    template.hasParameter('PrivateSubnetB', { Type: 'AWS::EC2::Subnet::Id', Default: Match.absent() });
    expect(JSON.stringify(json)).not.toMatch(/"(vpc|subnet)-[0-9a-f]{8,17}"/);
  });

  test('third subnet is optional with subnet-ID validation', () => {
    const p = json.Parameters!.PrivateSubnetC;
    expect(p.Type).toBe('String');
    expect(p.Default).toBe('');
    const re = new RegExp(p.AllowedPattern!);
    expect(re.test('')).toBe(true);
    expect(re.test('subnet-0123456789abcdef0')).toBe(true);
    expect(re.test('subnet-12345678')).toBe(true);
    expect(re.test('sg-0123456789abcdef0')).toBe(false);
    expect(re.test('subnet-XYZ')).toBe(false);
  });

  test('UseThirdSubnet condition is true only when PrivateSubnetC is non-empty', () => {
    expect(json.Conditions!.UseThirdSubnet).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'PrivateSubnetC' }, ''] }] });
  });

  test('ALB, ECS service and optional endpoint select a complete subnet list (never AWS::NoValue elements)', () => {
    const [, alb] = onlyResource(json, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    expect(alb.Properties!.Subnets).toEqual(SUBNET_SELECTION);
    const [, svc] = onlyResource(json, 'AWS::ECS::Service');
    const vpcCfg = (svc.Properties!.NetworkConfiguration as { AwsvpcConfiguration: Record<string, unknown> }).AwsvpcConfiguration;
    expect(vpcCfg.Subnets).toEqual(SUBNET_SELECTION);
    const [, ep] = onlyResource(json, 'AWS::EC2::VPCEndpoint');
    expect(ep.Properties!.SubnetIds).toEqual(SUBNET_SELECTION);
    expect(noValueListElements(json)).toEqual([]);
  });

  test.each([
    ['two-subnet', false, TWO_SUBNETS],
    ['three-subnet', true, THREE_SUBNETS],
  ])('%s branch resolves to the complete list', (_name, useThird, expected) => {
    const resolved = resolveBranch(json.Resources, 'UseThirdSubnet', useThird) as CfnTemplate['Resources'];
    const t: CfnTemplate = { Resources: resolved };
    expect(onlyResource(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer')[1].Properties!.Subnets).toEqual(expected);
    const svc = onlyResource(t, 'AWS::ECS::Service')[1];
    expect((svc.Properties!.NetworkConfiguration as { AwsvpcConfiguration: { Subnets: unknown } }).AwsvpcConfiguration.Subnets).toEqual(expected);
  });

  test('deployment rules enforce unique subnets inside the chosen VPC', () => {
    // AZ distribution is enforced by the ALB itself, which rejects subnets that are not in at least two AZs.
    expect(json.Rules!.SubnetsAreDistinct).toBeDefined();
    expect(json.Rules!.ThirdSubnetIsDistinct).toMatchObject({ RuleCondition: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'PrivateSubnetC' }, ''] }] } });
    expect(json.Rules!.SubnetsInSelectedVpc).toEqual({
      Assertions: [{
        Assert: { 'Fn::EachMemberEquals': [{ 'Fn::ValueOfAll': ['AWS::EC2::Subnet::Id', 'VpcId'] }, { Ref: 'VpcId' }] },
        AssertDescription: expect.any(String),
      }],
    });
  });

  test('numeric parameter defaults are members of their allowed values', () => {
    for (const [name, p] of Object.entries(json.Parameters!)) {
      if (p.AllowedValues && p.Default !== undefined) expect([name, p.AllowedValues]).toEqual([name, expect.arrayContaining([p.Default])]);
    }
  });
});

describe('network privacy', () => {
  test('internal ALB only', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal', Type: 'application' });
  });

  test('ECS tasks never receive a public IP', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED' } },
    });
  });

  test.each([
    'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::InternetGateway', 'AWS::EC2::EgressOnlyInternetGateway',
    'AWS::EC2::NatGateway', 'AWS::EC2::RouteTable', 'AWS::EC2::Route', 'AWS::EC2::VPCGatewayAttachment',
    'AWS::EC2::EIP', 'AWS::EC2::VPNGateway', 'AWS::EC2::TransitGatewayAttachment', 'AWS::Route53::HostedZone',
    'AWS::Route53::RecordSet', 'AWS::EC2::NetworkAcl',
  ])('creates no %s', (type) => {
    template.resourceCountIs(type, 0);
  });

  test('ingress is limited to the customer CIDR or source security group, never the internet', () => {
    const ingress = resourcesOfType(json, 'AWS::EC2::SecurityGroupIngress');
    expect(ingress.length).toBeGreaterThan(0);
    for (const [, r] of ingress) {
      expect(r.Properties!.CidrIp).not.toBe('0.0.0.0/0');
      expect(r.Properties!.CidrIpv6).toBeUndefined();
    }
    for (const [, sg] of resourcesOfType(json, 'AWS::EC2::SecurityGroup')) {
      expect(sg.Properties!.SecurityGroupIngress).toBeUndefined();
    }
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 443, ToPort: 443, CidrIp: { Ref: 'AllowedIngressCidr' },
    });
    template.hasResource('AWS::EC2::SecurityGroupIngress', {
      Condition: 'HasIngressSourceSecurityGroup',
      Properties: { FromPort: 443, SourceSecurityGroupId: { Ref: 'AllowedSourceSecurityGroupId' } },
    });
    // the task only accepts traffic from the ALB
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 8080, ToPort: 8080, GroupId: { 'Fn::GetAtt': ['TaskSecurityGroup', 'GroupId'] },
      SourceSecurityGroupId: { 'Fn::GetAtt': ['AlbSecurityGroup', 'GroupId'] },
    });
  });

  test('a customer-supplied ingress source is mandatory and 0.0.0.0/0 is rejected at deploy time', () => {
    const rules = JSON.stringify(json.Rules);
    expect(json.Rules).toHaveProperty('IngressSourceRequired');
    expect(json.Rules).toHaveProperty('NoInternetIngress');
    expect(rules).toContain('0.0.0.0/0');
  });

  test('HTTPS only with a modern TLS policy and Cognito authentication on the default action', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      SslPolicy: Match.stringLikeRegexp('^ELBSecurityPolicy-TLS13'),
      Certificates: [{ CertificateArn: { Ref: 'CertificateArn' } }],
      DefaultActions: [
        Match.objectLike({
          Type: 'authenticate-cognito',
          Order: 1,
          AuthenticateCognitoConfig: Match.objectLike({
            UserPoolArn: { 'Fn::GetAtt': ['UserPool', 'Arn'] },
            UserPoolClientId: { Ref: 'UserPoolClient' },
            UserPoolDomain: { Ref: 'UserPoolDomain' },
            OnUnauthenticatedRequest: 'authenticate',
            SessionTimeout: { Ref: 'SessionTimeoutSeconds' },
          }),
        }),
        Match.objectLike({ Type: 'forward', Order: 2, TargetGroupArn: { Ref: 'FrontendTargetGroup' } }),
      ],
    });
  });

  test('Cognito callback and logout URLs use the private application hostname', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: [{ 'Fn::Sub': 'https://${AppHostname}/oauth2/idpresponse' }],
      LogoutURLs: [{ 'Fn::Sub': 'https://${AppHostname}/' }],
    });
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  test('only the health path (and an opt-in smoke-test path) bypass authentication', () => {
    const rules = resourcesOfType(json, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    const unauthenticated = rules.map(([id, r]) => ({ id, r, conds: JSON.stringify(r.Properties!.Conditions) }));
    expect(unauthenticated.map((u) => u.id).sort()).toEqual(['HealthCheckRule', 'SmokeTestRule']);
    expect(unauthenticated.find((u) => u.id === 'HealthCheckRule')!.conds).toContain('/healthz');
    expect(unauthenticated.find((u) => u.id === 'SmokeTestRule')!.r.Condition).toBe('SmokeTestPathEnabled');
  });

  test('optional Bedrock runtime interface endpoint is created only when requested', () => {
    template.hasResource('AWS::EC2::VPCEndpoint', {
      Condition: 'BedrockEndpointRequested',
      Properties: Match.objectLike({
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
        ServiceName: { 'Fn::Sub': 'com.amazonaws.${AWS::Region}.bedrock-runtime' },
      }),
    });
    template.hasParameter('CreateBedrockEndpoint', { Default: 'false', AllowedValues: ['true', 'false'] });
  });
});

describe('task definition', () => {
  const [, taskDef] = onlyResource(json, 'AWS::ECS::TaskDefinition');
  const containers = taskDef.Properties!.ContainerDefinitions as Array<Record<string, any>>;
  const byName = Object.fromEntries(containers.map((c) => [c.Name, c]));

  test('three containers in one Fargate task with distinct ports', () => {
    expect(taskDef.Properties).toMatchObject({ RequiresCompatibilities: ['FARGATE'], NetworkMode: 'awsvpc' });
    expect(Object.keys(byName).sort()).toEqual(['agent', 'api', 'frontend']);
    const ports = containers.flatMap((c) => (c.PortMappings ?? []).map((p: { ContainerPort: number }) => p.ContainerPort));
    expect(new Set(ports).size).toBe(ports.length);
    expect(byName.frontend.PortMappings).toEqual([{ ContainerPort: 8080, Protocol: 'tcp' }]);
    expect(byName.api.PortMappings).toEqual([{ ContainerPort: 5000, Protocol: 'tcp' }]);
    expect(byName.agent.PortMappings).toEqual([{ ContainerPort: 8000, Protocol: 'tcp' }]);
  });

  test('every container has awslogs logging, a health check and a memory reservation', () => {
    for (const c of containers) {
      expect(c.LogConfiguration.LogDriver).toBe('awslogs');
      expect(c.LogConfiguration.Options['awslogs-group']).toEqual({ Ref: expect.stringMatching(/LogGroup$/) });
      expect(c.LogConfiguration.Options['awslogs-stream-prefix']).toBe(c.Name);
      expect(c.HealthCheck.Command[0]).toBe('CMD');
      expect(c.HealthCheck.Command.join(' ')).toMatch(/healthz/);
      expect(c.MemoryReservation).toBeGreaterThan(0);
      expect(c.Essential).toBe(true);
    }
    const sum = containers.reduce((a, c) => a + c.MemoryReservation, 0);
    expect(sum).toBeLessThanOrEqual(Number(taskDef.Properties!.Memory));
  });

  test('startup order is agent -> api -> frontend, gated on health', () => {
    expect(byName.agent.DependsOn).toBeUndefined();
    expect(byName.api.DependsOn).toEqual([{ ContainerName: 'agent', Condition: 'HEALTHY' }]);
    expect(byName.frontend.DependsOn).toEqual([{ ContainerName: 'api', Condition: 'HEALTHY' }]);
  });

  test('images are pinned by digest and never use latest', () => {
    for (const c of containers) {
      expect(c.Image).toMatch(/^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/);
      expect(c.Image).not.toMatch(/:latest/);
    }
  });

  test('flask talks to the agent over loopback inside the task; secrets come from Secrets Manager', () => {
    expect(byName.api.Environment).toEqual(expect.arrayContaining([{ Name: 'AGENT_URL', Value: 'http://127.0.0.1:8000' }]));
    expect(byName.api.Secrets).toEqual([{ Name: 'FLASK_SECRET_KEY', ValueFrom: { Ref: 'AppSecret' } }]);
    expect(byName.agent.Environment).toEqual(expect.arrayContaining([{ Name: 'BEDROCK_MODEL_ID', Value: { Ref: 'BedrockModelId' } }]));
  });

  test('no AWS access keys or credentials in the task definition', () => {
    const s = JSON.stringify(taskDef);
    expect(s).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AKIA[0-9A-Z]{16}/);
    template.resourceCountIs('AWS::IAM::AccessKey', 0);
    template.resourceCountIs('AWS::IAM::User', 0);
  });
});

describe('service operations', () => {
  test('deployment circuit breaker with rollback and safe rolling settings', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      },
      DesiredCount: { Ref: 'DesiredCount' },
      EnableExecuteCommand: false,
    });
  });

  test('target group health check on the frontend', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'ip', Port: 8080, Protocol: 'HTTP', HealthCheckPath: '/healthz', VpcId: { Ref: 'VpcId' },
    });
  });

  test('log groups are KMS encrypted, retained and use the retention parameter', () => {
    const groups = resourcesOfType(json, 'AWS::Logs::LogGroup');
    expect(groups.map(([id]) => id).sort()).toEqual(['AgentLogGroup', 'ApiLogGroup', 'FrontendLogGroup']);
    for (const [, g] of groups) {
      expect(g.Properties!.RetentionInDays).toEqual({ Ref: 'LogRetentionDays' });
      expect(g.Properties!.KmsKeyId).toEqual({ 'Fn::GetAtt': ['AppKey', 'Arn'] });
      expect(g.DeletionPolicy).toBe('Retain');
    }
  });

  test('actionable alarms exist and notify the optional topic', () => {
    const alarms = resourcesOfType(json, 'AWS::CloudWatch::Alarm');
    expect(alarms.map(([id]) => id).sort()).toEqual([
      'AlbTarget5xxAlarm', 'NoHealthyTargetsAlarm', 'ServiceCpuHighAlarm', 'ServiceMemoryHighAlarm', 'UnhealthyTargetsAlarm',
    ]);
    for (const [, a] of alarms) {
      expect(a.Properties!.AlarmActions).toEqual([{ Ref: 'AlarmTopic' }]);
      expect(a.Properties!.OKActions).toEqual([{ Ref: 'AlarmTopic' }]);
      expect(a.Properties!.AlarmName).toEqual({ 'Fn::Sub': expect.stringMatching(/^\$\{AWS::StackName\}-/) });
    }
  });

  test('alarm topic is encrypted, only CloudWatch in this account may publish, email subscription is optional', () => {
    template.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: { 'Fn::GetAtt': ['AppKey', 'Arn'] } });
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: { Statement: [Match.objectLike({
        Principal: { Service: 'cloudwatch.amazonaws.com' }, Action: 'sns:Publish',
        Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
      })] },
    });
    template.hasResource('AWS::SNS::Subscription', { Condition: 'HasAlarmEmail', Properties: { Protocol: 'email', Endpoint: { Ref: 'AlarmEmail' } } });
    template.hasParameter('AlarmEmail', { Default: '' });
  });

  test('outputs are non-sensitive', () => {
    const outputs = JSON.stringify(json.Outputs);
    expect(outputs).not.toMatch(/ClientSecret|SecretString|AppSecret/);
    expect(Object.keys(json.Outputs!)).toEqual(expect.arrayContaining(['ApplicationUrl', 'LoadBalancerDnsName', 'UserPoolId']));
  });

  test('secret and log encryption key rotate and are retained', () => {
    template.hasResource('AWS::KMS::Key', { Properties: Match.objectLike({ EnableKeyRotation: true }), DeletionPolicy: 'Retain' });
    template.hasResourceProperties('AWS::SecretsManager::Secret', { KmsKeyId: { 'Fn::GetAtt': ['AppKey', 'Arn'] } });
  });
});

describe('IAM', () => {
  test('task role grants only Bedrock invocation scoped to the selected model', () => {
    const [, policy] = resourcesOfType(json, 'AWS::IAM::Policy').find(([id]) => id === 'TaskRoleBedrockPolicy')!;
    const statements = (policy.Properties!.PolicyDocument as { Statement: Array<Record<string, any>> }).Statement;
    for (const s of statements) {
      expect(s.Effect).toBe('Allow');
      expect([s.Action].flat().every((a: string) => a.startsWith('bedrock:Invoke'))).toBe(true);
      expect(s.Resource).not.toBe('*');
    }
    expect(JSON.stringify(statements)).toContain('foundation-model/${BedrockModelId}');
    expect(JSON.stringify(statements)).toContain('inference-profile/${BedrockModelId}');
  });

  test('no IAM statement allows * actions', () => {
    for (const [, p] of [...resourcesOfType(json, 'AWS::IAM::Policy'), ...resourcesOfType(json, 'AWS::IAM::Role')]) {
      const docs = [p.Properties!.PolicyDocument, ...((p.Properties!.Policies as Array<{ PolicyDocument: unknown }>) ?? []).map((x) => x.PolicyDocument)];
      for (const d of docs.filter(Boolean) as Array<{ Statement: Array<{ Action: string | string[] }> }>) {
        for (const s of d.Statement) for (const a of [s.Action].flat()) expect(a).not.toMatch(/(^\*$|:\*$)/);
      }
    }
  });
});

describe('Marketplace template constraints', () => {
  test('no CDK bootstrap dependency, assets or metadata resources', () => {
    const s = JSON.stringify(json);
    expect(json.Parameters).not.toHaveProperty('BootstrapVersion');
    expect(s).not.toMatch(/cdk-hnb659fds|AWS::CDK::Metadata|aws:asset|AssetParameters/);
    template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('all product resources carry the product tag', () => {
    const tagged = ['AWS::ECS::Cluster', 'AWS::ECS::Service', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::EC2::SecurityGroup'];
    for (const type of tagged) {
      for (const [id, r] of resourcesOfType(json, type)) {
        expect([id, r.Properties!.Tags]).toEqual([id, expect.arrayContaining([expect.objectContaining({ Key: 'marketplace:product' })])]);
      }
    }
  });

  test('upgrade contract: parameters and logical IDs from the stable contract are preserved', () => {
    const contract = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'marketplace', 'schemas', 'customer-stack-contract.json'), 'utf8')) as {
      parameters: Record<string, string>; resources: Record<string, string>;
    };
    for (const [name, type] of Object.entries(contract.parameters)) expect([name, json.Parameters![name]?.Type]).toEqual([name, type]);
    for (const [id, type] of Object.entries(contract.resources)) expect([id, json.Resources[id]?.Type]).toEqual([id, type]);
    expect(Object.keys(contract.resources).length).toBeGreaterThanOrEqual(15);
  });

  test('console parameter groups cover every parameter', () => {
    const iface = json.Metadata!['AWS::CloudFormation::Interface'] as { ParameterGroups: Array<{ Parameters: string[] }> };
    const grouped = iface.ParameterGroups.flatMap((g) => g.Parameters).sort();
    expect(grouped).toEqual(Object.keys(json.Parameters!).sort());
  });
});
