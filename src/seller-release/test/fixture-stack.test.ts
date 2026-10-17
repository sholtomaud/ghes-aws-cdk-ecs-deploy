import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CleanAccountFixtureStack } from '../lib/clean-account-fixture-stack';

const template = Template.fromStack(new CleanAccountFixtureStack(new App(), 'Fixture'));
const json = template.toJSON();

describe('clean-account fixture network (test account only)', () => {
  test('isolated VPC with three private subnets in distinct AZs and DNS enabled for private endpoints', () => {
    template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.80.0.0/16', EnableDnsHostnames: true, EnableDnsSupport: true });
    const subnets = Object.entries<any>(json.Resources).filter(([id, r]) => r.Type === 'AWS::EC2::Subnet' && id.startsWith('Private'));
    expect(subnets).toHaveLength(3);
    expect(subnets.map(([, r]) => r.Properties.AvailabilityZone['Fn::Select'][0]).sort()).toEqual([0, 1, 2]);
    for (const [, r] of subnets) expect(r.Properties.MapPublicIpOnLaunch).toBe(false);
  });

  test('private subnets egress through a single NAT gateway (representative customer egress)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.hasResourceProperties('AWS::EC2::Route', { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: Match.anyValue() });
  });

  test('probe function runs inside the VPC with inline code (no assets) and minimal egress', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: Match.stringLikeRegexp('^nodejs2[2-9]'),
      Code: { ZipFile: Match.stringLikeRegexp('https') },
      VpcConfig: Match.objectLike({ SubnetIds: Match.arrayWith([{ Ref: 'PrivateA' }]) }),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('probe'),
      SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.80.0.0/16' }],
    });
    expect(JSON.stringify(json)).not.toMatch(/AssetParameters|cdk-hnb659fds|BootstrapVersion/);
  });

  test('outputs everything the harness needs', () => {
    expect(Object.keys(json.Outputs).sort()).toEqual(['PrivateSubnetA', 'PrivateSubnetB', 'PrivateSubnetC', 'ProbeFunctionName', 'VpcCidr', 'VpcId']);
  });
});
