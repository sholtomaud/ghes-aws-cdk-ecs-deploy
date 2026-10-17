import { validateTemplate } from '../lib/template-validation';
import { synthCustomerStack } from './fixtures';

const { json } = synthCustomerStack();
const clone = () => structuredClone(json) as any;
const ruleIds = (t: unknown) => validateTemplate(t).map((v) => v.rule);

describe('template policy validation', () => {
  test('the synthesised customer template passes every rule', () => {
    expect(validateTemplate(json)).toEqual([]);
  });

  test.each(['AWS::EC2::VPC', 'AWS::EC2::InternetGateway', 'AWS::EC2::NatGateway', 'AWS::EC2::RouteTable', 'AWS::EC2::Subnet'])(
    'rejects forbidden network resource %s', (type) => {
      const t = clone();
      t.Resources.Extra = { Type: type, Properties: {} };
      expect(ruleIds(t)).toContain('no-shared-network-resources');
    });

  test('rejects internet-facing load balancers (explicit or default scheme)', () => {
    const t = clone();
    t.Resources.LoadBalancer.Properties.Scheme = 'internet-facing';
    expect(ruleIds(t)).toContain('internal-load-balancers-only');
    delete t.Resources.LoadBalancer.Properties.Scheme;
    expect(ruleIds(t)).toContain('internal-load-balancers-only');
  });

  test('rejects public task IPs', () => {
    const t = clone();
    t.Resources.Service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp = 'ENABLED';
    expect(ruleIds(t)).toContain('no-public-task-ip');
  });

  test.each([
    [{ CidrIp: '0.0.0.0/0' }],
    [{ CidrIpv6: '::/0' }],
  ])('rejects open ingress %j (standalone and inline)', (open) => {
    const t = clone();
    t.Resources.Open = { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, ...open } };
    expect(ruleIds(t)).toContain('no-open-ingress');
    const u = clone();
    u.Resources.AlbSecurityGroup.Properties.SecurityGroupIngress = [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, ...open }];
    expect(ruleIds(u)).toContain('no-open-ingress');
  });

  test.each([
    [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    [{ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b' }],
    [{ Effect: 'Allow', Action: 'iam:PassRole', Resource: '*' }],
  ])('rejects broad IAM statement %j', (statement) => {
    const t = clone();
    t.Resources.TaskRoleBedrockPolicy.Properties.PolicyDocument.Statement.push(statement);
    expect(ruleIds(t)).toContain('no-broad-iam');
  });

  test('rejects administrator managed policies', () => {
    const t = clone();
    t.Resources.TaskRole.Properties.ManagedPolicyArns = ['arn:aws:iam::aws:policy/AdministratorAccess'];
    expect(ruleIds(t)).toContain('no-broad-iam');
  });

  test('rejects unencrypted or unbounded log groups and unencrypted secrets', () => {
    const t = clone();
    delete t.Resources.ApiLogGroup.Properties.KmsKeyId;
    delete t.Resources.AgentLogGroup.Properties.RetentionInDays;
    delete t.Resources.AppSecret.Properties.KmsKeyId;
    const v = validateTemplate(t);
    expect(v.filter((x) => x.rule === 'encrypted-retained-logs').map((x) => x.resource).sort()).toEqual(['AgentLogGroup', 'ApiLogGroup']);
    expect(v.map((x) => x.rule)).toContain('encrypted-secrets');
  });

  test.each([
    ['repo.example.com/app:latest'],
    ['repo.example.com/app:1.2.3'],
    ['repo.example.com/app'],
  ])('rejects unpinned image %s', (image) => {
    const t = clone();
    t.Resources.TaskDefinition.Properties.ContainerDefinitions[0].Image = image;
    expect(ruleIds(t)).toContain('pinned-images');
  });

  test('rejects credentials in container environment and IAM access keys', () => {
    const t = clone();
    t.Resources.TaskDefinition.Properties.ContainerDefinitions[0].Environment.push({ Name: 'AWS_SECRET_ACCESS_KEY', Value: 'x' });
    t.Resources.Key = { Type: 'AWS::IAM::AccessKey', Properties: {} };
    expect(ruleIds(t).filter((r) => r === 'no-embedded-credentials')).toHaveLength(2);
  });

  test('rejects CDK bootstrap and asset dependencies', () => {
    const t = clone();
    t.Parameters.BootstrapVersion = { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/cdk-bootstrap/hnb659fds/version' };
    expect(ruleIds(t)).toContain('no-cdk-bootstrap-dependency');
  });

  test('rejects AWS::NoValue used as a list element', () => {
    const t = clone();
    t.Resources.LoadBalancer.Properties.Subnets = [{ Ref: 'PrivateSubnetA' }, { Ref: 'PrivateSubnetB' }, { 'Fn::If': ['UseThirdSubnet', { Ref: 'PrivateSubnetC' }, { Ref: 'AWS::NoValue' }] }];
    t.Resources.Service.Properties.NetworkConfiguration.AwsvpcConfiguration.Subnets = [{ Ref: 'PrivateSubnetA' }, { Ref: 'AWS::NoValue' }];
    expect(ruleIds(t).filter((r) => r === 'complete-subnet-lists')).toHaveLength(2);
  });

  test('requires the customer network parameter contract', () => {
    const t = clone();
    t.Parameters.VpcId.Type = 'String';
    delete t.Parameters.PrivateSubnetC;
    delete t.Conditions.UseThirdSubnet;
    expect(ruleIds(t).filter((r) => r === 'network-parameters')).toHaveLength(3);
  });

  test('rejects non-objects and templates without resources', () => {
    expect(ruleIds(null)).toEqual(['template-shape']);
    expect(ruleIds({ Parameters: {} })).toEqual(['template-shape']);
  });
});
