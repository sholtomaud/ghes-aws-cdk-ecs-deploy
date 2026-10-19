/**
 * Policy checks for the customer Marketplace template. These run on the raw synthesised JSON so they
 * also catch problems introduced outside CDK (hand edits, overrides, escape hatches).
 */

export interface Violation {
  rule: string;
  resource?: string;
  message: string;
}

type Json = Record<string, unknown>;
interface Resource { Type: string; Properties?: Json }

const FORBIDDEN_NETWORK_TYPES = new Set([
  'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::InternetGateway', 'AWS::EC2::EgressOnlyInternetGateway',
  'AWS::EC2::NatGateway', 'AWS::EC2::RouteTable', 'AWS::EC2::Route', 'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::EIP', 'AWS::EC2::VPNGateway', 'AWS::EC2::VPNConnection',
  'AWS::EC2::CustomerGateway', 'AWS::EC2::TransitGateway', 'AWS::EC2::TransitGatewayAttachment',
  'AWS::EC2::TransitGatewayVpcAttachment', 'AWS::EC2::VPCPeeringConnection', 'AWS::EC2::NetworkAcl',
  'AWS::EC2::NetworkAclEntry', 'AWS::EC2::VPCCidrBlock', 'AWS::EC2::DHCPOptions', 'AWS::Route53::HostedZone',
  'AWS::Route53::RecordSet', 'AWS::Route53::RecordSetGroup', 'AWS::DirectConnect::Connection',
  'AWS::NetworkFirewall::Firewall',
]);

const FORBIDDEN_MANAGED_POLICIES = /policy\/(AdministratorAccess|PowerUserAccess|IAMFullAccess)$/;
/** Actions that legitimately require Resource "*" because the API offers no resource scoping. */
const STAR_RESOURCE_ACTIONS = new Set(['ecr:GetAuthorizationToken', 'cloudwatch:PutMetricData', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords']);
const CREDENTIAL_ENV = /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|.*(PASSWORD|SECRET|TOKEN|API_KEY).*)$/i;
const PINNED_IMAGE = /^[a-z0-9.-]+(:\d+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const SUBNET_LIST_PATHS: Record<string, string[][]> = {
  'AWS::ElasticLoadBalancingV2::LoadBalancer': [['Subnets']],
  'AWS::ECS::Service': [['NetworkConfiguration', 'AwsvpcConfiguration', 'Subnets']],
  'AWS::EC2::VPCEndpoint': [['SubnetIds']],
};

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const isNoValue = (v: unknown) => isObj(v) && v.Ref === 'AWS::NoValue';

function dig(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

/** True when a list (or any Fn::If branch producing a list) contains AWS::NoValue as an element. */
function listHasNoValueElement(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((e) => isNoValue(e) || (isObj(e) && Array.isArray(e['Fn::If']) && (e['Fn::If'] as unknown[]).slice(1).some(isNoValue)));
  if (isObj(v) && Array.isArray(v['Fn::If'])) return (v['Fn::If'] as unknown[]).slice(1).some(listHasNoValueElement);
  return false;
}

function policyDocuments(r: Resource): Json[] {
  const p = r.Properties ?? {};
  switch (r.Type) {
    case 'AWS::IAM::Policy':
    case 'AWS::IAM::ManagedPolicy':
      return isObj(p.PolicyDocument) ? [p.PolicyDocument] : [];
    case 'AWS::IAM::Role':
    case 'AWS::IAM::User':
    case 'AWS::IAM::Group':
      return asArray(p.Policies as Json[] | undefined).map((x) => x.PolicyDocument).filter(isObj);
    default:
      return [];
  }
}

export function validateTemplate(template: unknown): Violation[] {
  if (!isObj(template) || !isObj(template.Resources)) {
    return [{ rule: 'template-shape', message: 'template must be an object with a Resources section' }];
  }
  const out: Violation[] = [];
  const add = (rule: string, resource: string | undefined, message: string) => out.push({ rule, resource, message });
  const resources = template.Resources as Record<string, Resource>;
  const params = (isObj(template.Parameters) ? template.Parameters : {}) as Record<string, Json>;
  const conditions = isObj(template.Conditions) ? template.Conditions : {};

  // customer network contract
  for (const [name, type] of [['VpcId', 'AWS::EC2::VPC::Id'], ['PrivateSubnetA', 'AWS::EC2::Subnet::Id'], ['PrivateSubnetB', 'AWS::EC2::Subnet::Id'], ['PrivateSubnetC', 'String']]) {
    if (params[name]?.Type !== type) add('network-parameters', undefined, `parameter ${name} must exist with type ${type}`);
  }
  if (params.PrivateSubnetC && params.PrivateSubnetC.Default !== '') add('network-parameters', undefined, 'PrivateSubnetC must default to empty');
  if (!conditions.UseThirdSubnet) add('network-parameters', undefined, 'condition UseThirdSubnet is required');

  const s = JSON.stringify(template);
  if ('BootstrapVersion' in params || /cdk-bootstrap|cdk-hnb659fds|AssetParameters|aws:asset:/.test(s)) {
    add('no-cdk-bootstrap-dependency', undefined, 'template must not depend on CDK bootstrap resources or assets');
  }

  for (const [id, r] of Object.entries(resources)) {
    const p = r.Properties ?? {};
    if (FORBIDDEN_NETWORK_TYPES.has(r.Type) || r.Type === 'AWS::CDK::Metadata') {
      add(r.Type === 'AWS::CDK::Metadata' ? 'no-cdk-bootstrap-dependency' : 'no-shared-network-resources', id, `${r.Type} must not be created by the product`);
    }
    if (r.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer' && p.Scheme !== 'internal') {
      add('internal-load-balancers-only', id, 'load balancer Scheme must be "internal" (the default is internet-facing)');
    }
    if (r.Type === 'AWS::ElasticLoadBalancing::LoadBalancer' && p.Scheme !== 'internal') {
      add('internal-load-balancers-only', id, 'classic load balancer must be internal');
    }
    if (r.Type === 'AWS::ECS::Service' && dig(p, ['NetworkConfiguration', 'AwsvpcConfiguration', 'AssignPublicIp']) !== 'DISABLED') {
      add('no-public-task-ip', id, 'AssignPublicIp must be DISABLED');
    }
    if (r.Type === 'AWS::EC2::LaunchTemplate' || r.Type === 'AWS::EC2::Instance') {
      if (/"AssociatePublicIpAddress":true/.test(JSON.stringify(p))) add('no-public-task-ip', id, 'instances must not get public IPs');
    }

    const ingress = r.Type === 'AWS::EC2::SecurityGroupIngress' ? [p] : r.Type === 'AWS::EC2::SecurityGroup' ? asArray(p.SecurityGroupIngress as Json[] | undefined) : [];
    for (const rule of ingress) {
      if (rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0') add('no-open-ingress', id, 'ingress from 0.0.0.0/0 or ::/0 is not allowed');
    }

    for (const path of SUBNET_LIST_PATHS[r.Type] ?? []) {
      if (listHasNoValueElement(dig(p, path))) add('complete-subnet-lists', id, `${path.join('.')} must be a complete list per condition branch, not contain AWS::NoValue`);
    }

    for (const doc of policyDocuments(r)) {
      for (const st of asArray(doc.Statement as Json[] | undefined)) {
        if (st.Effect !== 'Allow') continue;
        const actions = asArray(st.Action as string | string[] | undefined);
        if (st.NotAction !== undefined || st.NotResource !== undefined) add('no-broad-iam', id, 'NotAction/NotResource grants are not allowed');
        for (const a of actions) if (typeof a === 'string' && (a === '*' || a.endsWith(':*'))) add('no-broad-iam', id, `wildcard action ${a}`);
        const starResource = asArray(st.Resource as unknown).some((x) => x === '*');
        if (starResource && !actions.every((a) => STAR_RESOURCE_ACTIONS.has(a))) add('no-broad-iam', id, `Resource "*" with ${actions.join(', ')}`);
      }
    }
    for (const arn of asArray(p.ManagedPolicyArns as unknown[] | undefined)) {
      if (FORBIDDEN_MANAGED_POLICIES.test(JSON.stringify(arn).replace(/"$/, ''))) add('no-broad-iam', id, 'administrator-level managed policy attached');
    }

    if (r.Type === 'AWS::Logs::LogGroup' && (p.KmsKeyId === undefined || p.RetentionInDays === undefined)) {
      add('encrypted-retained-logs', id, 'log groups need KmsKeyId and RetentionInDays');
    }
    if (r.Type === 'AWS::SecretsManager::Secret' && p.KmsKeyId === undefined) add('encrypted-secrets', id, 'secrets need a KmsKeyId');
    if (r.Type === 'AWS::SecretsManager::Secret' && p.SecretString !== undefined) add('no-embedded-credentials', id, 'SecretString must not be set in the template');
    if (r.Type === 'AWS::IAM::AccessKey' || r.Type === 'AWS::IAM::User') add('no-embedded-credentials', id, `${r.Type} must not be created`);

    if (r.Type === 'AWS::ECS::TaskDefinition') {
      for (const c of asArray(p.ContainerDefinitions as Json[] | undefined)) {
        if (typeof c.Image !== 'string' || !PINNED_IMAGE.test(c.Image)) add('pinned-images', id, `container ${String(c.Name)} image must be pinned by sha256 digest`);
        for (const e of asArray(c.Environment as Json[] | undefined)) {
          if (typeof e.Name === 'string' && CREDENTIAL_ENV.test(e.Name)) add('no-embedded-credentials', id, `container ${String(c.Name)} sets ${e.Name} in plain environment; use Secrets`);
        }
      }
    }
  }
  return out;
}
