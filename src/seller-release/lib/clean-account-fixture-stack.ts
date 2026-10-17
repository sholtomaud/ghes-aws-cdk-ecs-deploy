import { BootstraplessSynthesizer, CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import {
  CfnEIP, CfnInternetGateway, CfnNatGateway, CfnRoute, CfnRouteTable, CfnSecurityGroup, CfnSubnet,
  CfnSubnetRouteTableAssociation, CfnVPC, CfnVPCGatewayAttachment,
} from 'aws-cdk-lib/aws-ec2';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

const VPC_CIDR = '10.80.0.0/16';

/** Test-only HTTPS probe. TLS verification is off because test hostnames use a private/test certificate. */
const PROBE_CODE = `
const https = require('node:https');
exports.handler = (event) => new Promise((resolve) => {
  const u = new URL(event.url);
  const req = https.request({
    host: u.hostname, path: u.pathname + u.search, method: 'GET', servername: event.host,
    headers: { Host: event.host }, rejectUnauthorized: false, timeout: 15000,
  }, (res) => {
    let body = '';
    res.on('data', (c) => { if (body.length < 4096) body += c; });
    res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  req.end();
});
`;

/**
 * Network fixture for clean-account tests, deployed only in the dedicated test account. It stands in for a
 * customer VPC: three private subnets in distinct AZs with NAT egress, plus an in-VPC probe function.
 * It is not part of the Marketplace product.
 */
export class CleanAccountFixtureStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, { synthesizer: new BootstraplessSynthesizer(), ...props });
    this.templateOptions.description = 'Clean-account test fixture: isolated VPC with three private subnets (test account only)';

    const vpc = new CfnVPC(this, 'Vpc', { cidrBlock: VPC_CIDR, enableDnsHostnames: true, enableDnsSupport: true });
    const az = (i: number) => Fn.select(i, Fn.getAzs());

    const igw = new CfnInternetGateway(this, 'InternetGateway');
    new CfnVPCGatewayAttachment(this, 'GatewayAttachment', { vpcId: vpc.ref, internetGatewayId: igw.ref });
    const publicSubnet = new CfnSubnet(this, 'PublicSubnet', { vpcId: vpc.ref, cidrBlock: '10.80.255.0/24', availabilityZone: az(0), mapPublicIpOnLaunch: false });
    const publicRt = new CfnRouteTable(this, 'PublicRouteTable', { vpcId: vpc.ref });
    const igwRoute = new CfnRoute(this, 'PublicDefaultRoute', { routeTableId: publicRt.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: igw.ref });
    igwRoute.addResourceDependency(this.node.findChild('GatewayAttachment') as CfnVPCGatewayAttachment);
    new CfnSubnetRouteTableAssociation(this, 'PublicSubnetRoutes', { subnetId: publicSubnet.ref, routeTableId: publicRt.ref });
    const eip = new CfnEIP(this, 'NatAddress', { domain: 'vpc' });
    const nat = new CfnNatGateway(this, 'NatGateway', { subnetId: publicSubnet.ref, allocationId: eip.attrAllocationId });

    const privateRt = new CfnRouteTable(this, 'PrivateRouteTable', { vpcId: vpc.ref });
    new CfnRoute(this, 'PrivateDefaultRoute', { routeTableId: privateRt.ref, destinationCidrBlock: '0.0.0.0/0', natGatewayId: nat.ref });
    const subnets = ['A', 'B', 'C'].map((suffix, i) => {
      const s = new CfnSubnet(this, `Private${suffix}`, { vpcId: vpc.ref, cidrBlock: `10.80.${i * 16}.0/20`, availabilityZone: az(i), mapPublicIpOnLaunch: false });
      new CfnSubnetRouteTableAssociation(this, `Private${suffix}Routes`, { subnetId: s.ref, routeTableId: privateRt.ref });
      new CfnOutput(this, `PrivateSubnet${suffix}`, { value: s.ref });
      return s;
    });

    const probeSg = new CfnSecurityGroup(this, 'ProbeSecurityGroup', {
      groupDescription: 'Clean-account probe: HTTPS to the VPC only',
      vpcId: vpc.ref,
      securityGroupEgress: [{ ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: VPC_CIDR }],
    });
    const role = new CfnRole(this, 'ProbeRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
      managedPolicyArns: [Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole')],
    });
    const probe = new CfnFunction(this, 'ProbeFunction', {
      runtime: 'nodejs22.x',
      handler: 'index.handler',
      role: role.attrArn,
      timeout: 30,
      memorySize: 128,
      code: { zipFile: PROBE_CODE.trim() },
      vpcConfig: { subnetIds: subnets.map((s) => s.ref), securityGroupIds: [probeSg.attrGroupId] },
    });

    new CfnOutput(this, 'VpcId', { value: vpc.ref });
    new CfnOutput(this, 'VpcCidr', { value: VPC_CIDR });
    new CfnOutput(this, 'ProbeFunctionName', { value: probe.ref });
  }
}
