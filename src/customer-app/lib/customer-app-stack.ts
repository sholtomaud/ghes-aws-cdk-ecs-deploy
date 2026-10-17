import {
  Aws,
  BootstraplessSynthesizer,
  CfnCondition,
  CfnDeletionPolicy,
  CfnOutput,
  CfnParameter,
  CfnRule,
  Fn,
  Stack,
  StackProps,
  Tags,
  Token,
} from 'aws-cdk-lib';
import { CfnAlarm } from 'aws-cdk-lib/aws-cloudwatch';
import { CfnUserPool, CfnUserPoolClient, CfnUserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { CfnSecurityGroup, CfnSecurityGroupEgress, CfnSecurityGroupIngress, CfnVPCEndpoint } from 'aws-cdk-lib/aws-ec2';
import { CfnCluster, CfnService, CfnTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { CfnListener, CfnListenerRule, CfnLoadBalancer, CfnTargetGroup } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnPolicy, CfnRole } from 'aws-cdk-lib/aws-iam';
import { CfnKey } from 'aws-cdk-lib/aws-kms';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { CfnSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnSubscription, CfnTopic, CfnTopicPolicy } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { Component, ImageSet, imageUri } from './images';

export const PRODUCT_NAME = 'private-ai-assistant';

/** Ports inside the shared awsvpc network namespace of the task. */
export const PORTS = { frontend: 8080, api: 5000, agent: 8000 } as const;

const LOG_RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

export interface CustomerAppStackProps extends StackProps {
  images: ImageSet;
  productVersion: string;
}

/**
 * Customer-account application stack, delivered as a Marketplace CloudFormation template.
 *
 * Every resource is an L1 construct created directly under the stack, so its logical ID equals its
 * construct ID. Those IDs are an upgrade contract (marketplace/schemas/customer-stack-contract.json):
 * renaming one makes CloudFormation replace the resource on customer upgrades.
 */
export class CustomerAppStack extends Stack {
  constructor(scope: Construct, id: string, props: CustomerAppStackProps) {
    // Marketplace templates must not depend on a CDK bootstrap bucket, SSM version parameter or assets.
    // The bootstrapless synthesizer fails synthesis if any asset is introduced.
    super(scope, id, { synthesizer: new BootstraplessSynthesizer(), ...props });

    this.templateOptions.description =
      `${PRODUCT_NAME} ${props.productVersion}: private application on ECS Fargate behind an internal ALB with Cognito sign-in. ` +
      'Deploys into an existing customer VPC; creates no VPC, subnet, route, gateway or DNS resources.';

    // ---------------------------------------------------------------- parameters
    const vpcId = new CfnParameter(this, 'VpcId', {
      type: 'AWS::EC2::VPC::Id',
      description: 'Existing customer VPC. The stack never modifies it.',
    });
    const subnetA = new CfnParameter(this, 'PrivateSubnetA', {
      type: 'AWS::EC2::Subnet::Id',
      description: 'First private subnet (routable from the corporate network).',
    });
    const subnetB = new CfnParameter(this, 'PrivateSubnetB', {
      type: 'AWS::EC2::Subnet::Id',
      description: 'Second private subnet, in a different Availability Zone from PrivateSubnetA.',
    });
    const subnetC = new CfnParameter(this, 'PrivateSubnetC', {
      type: 'String',
      default: '',
      allowedPattern: '^$|^subnet-([0-9a-f]{8}|[0-9a-f]{17})$',
      constraintDescription: 'must be empty or a subnet ID (subnet-xxxxxxxx or subnet-xxxxxxxxxxxxxxxxx)',
      description: 'Optional third private subnet in a third Availability Zone. Leave empty for two subnets.',
    });
    const ingressCidr = new CfnParameter(this, 'AllowedIngressCidr', {
      type: 'String',
      default: '',
      allowedPattern: '^$|^((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)/([89]|[12]\\d|3[0-2])$',
      constraintDescription: 'must be empty or an IPv4 CIDR with a prefix of /8 to /32',
      description: 'Corporate client CIDR allowed to reach the internal ALB on 443. Set this and/or AllowedSourceSecurityGroupId.',
    });
    const ingressSg = new CfnParameter(this, 'AllowedSourceSecurityGroupId', {
      type: 'String',
      default: '',
      allowedPattern: '^$|^sg-([0-9a-f]{8}|[0-9a-f]{17})$',
      description: 'Optional customer-approved security group allowed to reach the internal ALB on 443.',
    });
    const appHostname = new CfnParameter(this, 'AppHostname', {
      type: 'String',
      allowedPattern: '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$',
      constraintDescription: 'must be a lower-case DNS name, e.g. assistant.corp.example.com',
      description: 'Private hostname users browse to. You create the corporate DNS record pointing at the ALB.',
    });
    const certificateArn = new CfnParameter(this, 'CertificateArn', {
      type: 'String',
      allowedPattern: '^arn:aws[a-z-]*:acm:[a-z0-9-]+:\\d{12}:certificate/[0-9a-f-]{36}$',
      description: 'ACM certificate ARN (imported private-CA or public) covering AppHostname.',
    });
    const cognitoDomainPrefix = new CfnParameter(this, 'CognitoDomainPrefix', {
      type: 'String',
      allowedPattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$',
      description: 'Globally unique prefix for the Cognito hosted sign-in domain (public endpoint).',
    });
    const mfa = new CfnParameter(this, 'MfaConfiguration', {
      type: 'String',
      default: 'OPTIONAL',
      allowedValues: ['OFF', 'OPTIONAL', 'ON'],
      description: 'Cognito multi-factor authentication (TOTP).',
    });
    const sessionTimeout = new CfnParameter(this, 'SessionTimeoutSeconds', {
      type: 'Number',
      default: 28800,
      minValue: 900,
      maxValue: 604800,
      description: 'ALB authentication session lifetime.',
    });
    const modelId = new CfnParameter(this, 'BedrockModelId', {
      type: 'String',
      allowedPattern: '^[a-z0-9-]+(\\.[a-z0-9-]+)+(:\\d+)?$|^[a-z0-9-]+\\.[a-z0-9.-]+-v\\d+(:\\d+)?$',
      description: 'Bedrock model ID or inference profile ID the agent invokes (model access must be enabled in this account).',
    });
    const createEndpoint = new CfnParameter(this, 'CreateBedrockEndpoint', {
      type: 'String',
      default: 'false',
      allowedValues: ['true', 'false'],
      description: 'Create a Bedrock Runtime interface endpoint with private DNS. Leave false if your VPC already provides one.',
    });
    const desiredCount = new CfnParameter(this, 'DesiredCount', {
      type: 'Number', default: 2, minValue: 1, maxValue: 10, description: 'Number of running tasks.',
    });
    const logRetention = new CfnParameter(this, 'LogRetentionDays', {
      type: 'Number', default: '30', allowedValues: LOG_RETENTION_DAYS.map(String), description: 'CloudWatch Logs retention.',
    });
    const containerInsights = new CfnParameter(this, 'ContainerInsights', {
      type: 'String', default: 'disabled', allowedValues: ['enabled', 'disabled'], description: 'ECS Container Insights (additional cost).',
    });
    const alarmEmail = new CfnParameter(this, 'AlarmEmail', {
      type: 'String',
      default: '',
      allowedPattern: '^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      description: 'Optional email subscribed to the alarm topic (confirm the subscription email). Other subscribers can be added to the topic later.',
    });
    const smokeTestPath = new CfnParameter(this, 'EnableSmokeTestPath', {
      type: 'String',
      default: 'false',
      allowedValues: ['true', 'false'],
      description: 'Expose an unauthenticated, rate-limited /api/selftest (one minimal Bedrock call). For installation tests only.',
    });

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          { Label: { default: 'Network (existing customer VPC)' }, Parameters: ['VpcId', 'PrivateSubnetA', 'PrivateSubnetB', 'PrivateSubnetC', 'AllowedIngressCidr', 'AllowedSourceSecurityGroupId', 'CreateBedrockEndpoint'] },
          { Label: { default: 'Access' }, Parameters: ['AppHostname', 'CertificateArn', 'CognitoDomainPrefix', 'MfaConfiguration', 'SessionTimeoutSeconds'] },
          { Label: { default: 'Application' }, Parameters: ['BedrockModelId', 'DesiredCount'] },
          { Label: { default: 'Operations' }, Parameters: ['LogRetentionDays', 'ContainerInsights', 'AlarmEmail', 'EnableSmokeTestPath'] },
        ],
      },
      ProductVersion: props.productVersion,
    };

    // ---------------------------------------------------------------- conditions & rules
    new CfnCondition(this, 'UseThirdSubnet', { expression: Fn.conditionNot(Fn.conditionEquals(subnetC.valueAsString, '')) });
    new CfnCondition(this, 'HasIngressCidr', { expression: Fn.conditionNot(Fn.conditionEquals(ingressCidr.valueAsString, '')) });
    new CfnCondition(this, 'HasIngressSourceSecurityGroup', { expression: Fn.conditionNot(Fn.conditionEquals(ingressSg.valueAsString, '')) });
    new CfnCondition(this, 'BedrockEndpointRequested', { expression: Fn.conditionEquals(createEndpoint.valueAsString, 'true') });
    new CfnCondition(this, 'HasAlarmEmail', { expression: Fn.conditionNot(Fn.conditionEquals(alarmEmail.valueAsString, '')) });
    new CfnCondition(this, 'SmokeTestPathEnabled', { expression: Fn.conditionEquals(smokeTestPath.valueAsString, 'true') });
    new CfnCondition(this, 'MfaDisabled', { expression: Fn.conditionEquals(mfa.valueAsString, 'OFF') });

    new CfnRule(this, 'IngressSourceRequired', {
      assertions: [{
        assert: Fn.conditionOr(
          Fn.conditionNot(Fn.conditionEquals(ingressCidr.valueAsString, '')),
          Fn.conditionNot(Fn.conditionEquals(ingressSg.valueAsString, '')),
        ),
        assertDescription: 'Set AllowedIngressCidr and/or AllowedSourceSecurityGroupId; the application is never opened to all sources.',
      }],
    });
    new CfnRule(this, 'NoInternetIngress', {
      assertions: [{
        assert: Fn.conditionNot(Fn.conditionEquals(ingressCidr.valueAsString, '0.0.0.0/0')),
        assertDescription: 'AllowedIngressCidr must not be 0.0.0.0/0.',
      }],
    });
    new CfnRule(this, 'SubnetsAreDistinct', {
      assertions: [{
        assert: Fn.conditionNot(Fn.conditionEquals(subnetA.valueAsString, subnetB.valueAsString)),
        assertDescription: 'PrivateSubnetA and PrivateSubnetB must be different subnets.',
      }],
    });
    new CfnRule(this, 'ThirdSubnetIsDistinct', {
      ruleCondition: Fn.conditionNot(Fn.conditionEquals(subnetC.valueAsString, '')),
      assertions: [{
        assert: Fn.conditionAnd(
          Fn.conditionNot(Fn.conditionEquals(subnetC.valueAsString, subnetA.valueAsString)),
          Fn.conditionNot(Fn.conditionEquals(subnetC.valueAsString, subnetB.valueAsString)),
        ),
        assertDescription: 'PrivateSubnetC must differ from PrivateSubnetA and PrivateSubnetB.',
      }],
    });
    // Checks every AWS::EC2::Subnet::Id parameter (A and B; C is an optional String and cannot be typed).
    // AZ distribution is enforced by the ALB, which rejects subnets that do not span two AZs.
    new CfnRule(this, 'SubnetsInSelectedVpc', {
      assertions: [{
        assert: Fn.conditionEachMemberEquals(Fn.valueOfAll('AWS::EC2::Subnet::Id', 'VpcId'), vpcId.valueAsString),
        assertDescription: 'PrivateSubnetA and PrivateSubnetB must belong to VpcId.',
      }],
    });

    const subnets = subnetSelection('UseThirdSubnet', [subnetA.valueAsString, subnetB.valueAsString], subnetC.valueAsString);

    // ---------------------------------------------------------------- encryption & secrets
    const key = new CfnKey(this, 'AppKey', {
      description: `${PRODUCT_NAME} logs and application secret`,
      enableKeyRotation: true,
      pendingWindowInDays: 30,
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AccountAdministration',
            Effect: 'Allow',
            Principal: { AWS: Fn.sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root') },
            Action: 'kms:*',
            Resource: '*',
          },
          {
            Sid: 'CloudWatchLogsForThisAccount',
            Effect: 'Allow',
            Principal: { Service: Fn.sub('logs.${AWS::Region}.amazonaws.com') },
            Action: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
            Resource: '*',
            Condition: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': Fn.sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:*') } },
          },
          {
            Sid: 'CloudWatchAlarmsToEncryptedTopic',
            Effect: 'Allow',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
            Resource: '*',
            Condition: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
          },
        ],
      },
    });
    retain(key);

    const secret = new CfnSecret(this, 'AppSecret', {
      description: `${PRODUCT_NAME} Flask signing key (generated in your account; never leaves it)`,
      kmsKeyId: key.attrArn,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    const logGroups: Record<Component, CfnLogGroup> = {
      frontend: this.logGroup('FrontendLogGroup', 'frontend', key, logRetention),
      api: this.logGroup('ApiLogGroup', 'api', key, logRetention),
      agent: this.logGroup('AgentLogGroup', 'agent', key, logRetention),
    };

    // ---------------------------------------------------------------- authentication (Cognito)
    const userPool = new CfnUserPool(this, 'UserPool', {
      userPoolName: Fn.sub('${AWS::StackName}-users'),
      adminCreateUserConfig: { allowAdminCreateUserOnly: true },
      usernameAttributes: ['email'],
      autoVerifiedAttributes: ['email'],
      mfaConfiguration: mfa.valueAsString,
      enabledMfas: Token.asList(Fn.conditionIf('MfaDisabled', Aws.NO_VALUE, ['SOFTWARE_TOKEN_MFA'])),
      deletionProtection: 'ACTIVE',
      accountRecoverySetting: { recoveryMechanisms: [{ name: 'verified_email', priority: 1 }] },
      policies: {
        passwordPolicy: {
          minimumLength: 14, requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSymbols: true,
          temporaryPasswordValidityDays: 3,
        },
      },
    });
    retain(userPool);

    const userPoolDomain = new CfnUserPoolDomain(this, 'UserPoolDomain', {
      domain: cognitoDomainPrefix.valueAsString,
      userPoolId: userPool.ref,
    });

    const userPoolClient = new CfnUserPoolClient(this, 'UserPoolClient', {
      userPoolId: userPool.ref,
      clientName: Fn.sub('${AWS::StackName}-alb'),
      generateSecret: true,
      allowedOAuthFlows: ['code'],
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      callbackUrLs: [Fn.sub('https://${AppHostname}/oauth2/idpresponse')],
      logoutUrLs: [Fn.sub('https://${AppHostname}/')],
      supportedIdentityProviders: ['COGNITO'],
      preventUserExistenceErrors: 'ENABLED',
      explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
    });

    // ---------------------------------------------------------------- security groups
    const albSg = new CfnSecurityGroup(this, 'AlbSecurityGroup', {
      groupDescription: 'Internal ALB: HTTPS from approved corporate sources only',
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [{
        ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0',
        description: 'ALB to Cognito token and user-info endpoints (public AWS endpoints)',
      }],
    });
    const taskSg = new CfnSecurityGroup(this, 'TaskSecurityGroup', {
      groupDescription: 'ECS tasks: traffic from the internal ALB only',
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [{
        ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0',
        description: 'HTTPS to AWS APIs (ECR, S3, CloudWatch Logs, Secrets Manager, Bedrock) via endpoints or customer egress',
      }],
    });
    const endpointSg = new CfnSecurityGroup(this, 'BedrockEndpointSecurityGroup', {
      groupDescription: 'Bedrock Runtime interface endpoint: HTTPS from application tasks',
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '127.0.0.1/32', description: 'No egress required' }],
    });
    endpointSg.cfnOptions.condition = this.condition('BedrockEndpointRequested');

    const cidrIngress = new CfnSecurityGroupIngress(this, 'AlbIngressFromCidr', {
      groupId: albSg.attrGroupId, ipProtocol: 'tcp', fromPort: 443, toPort: 443,
      cidrIp: ingressCidr.valueAsString, description: 'Corporate clients (CIDR)',
    });
    cidrIngress.cfnOptions.condition = this.condition('HasIngressCidr');
    const sgIngress = new CfnSecurityGroupIngress(this, 'AlbIngressFromSourceSecurityGroup', {
      groupId: albSg.attrGroupId, ipProtocol: 'tcp', fromPort: 443, toPort: 443,
      sourceSecurityGroupId: ingressSg.valueAsString, description: 'Corporate clients (security group)',
    });
    sgIngress.cfnOptions.condition = this.condition('HasIngressSourceSecurityGroup');
    new CfnSecurityGroupEgress(this, 'AlbEgressToTasks', {
      groupId: albSg.attrGroupId, ipProtocol: 'tcp', fromPort: PORTS.frontend, toPort: PORTS.frontend,
      destinationSecurityGroupId: taskSg.attrGroupId, description: 'ALB to frontend container',
    });
    new CfnSecurityGroupIngress(this, 'TaskIngressFromAlb', {
      groupId: taskSg.attrGroupId, ipProtocol: 'tcp', fromPort: PORTS.frontend, toPort: PORTS.frontend,
      sourceSecurityGroupId: albSg.attrGroupId, description: 'Internal ALB to frontend container',
    });
    const endpointIngress = new CfnSecurityGroupIngress(this, 'BedrockEndpointIngressFromTasks', {
      groupId: endpointSg.attrGroupId, ipProtocol: 'tcp', fromPort: 443, toPort: 443,
      sourceSecurityGroupId: taskSg.attrGroupId, description: 'Application tasks to Bedrock Runtime',
    });
    endpointIngress.cfnOptions.condition = this.condition('BedrockEndpointRequested');

    const bedrockEndpoint = new CfnVPCEndpoint(this, 'BedrockRuntimeEndpoint', {
      vpcId: vpcId.valueAsString,
      vpcEndpointType: 'Interface',
      serviceName: Fn.sub('com.amazonaws.${AWS::Region}.bedrock-runtime'),
      subnetIds: subnets,
      securityGroupIds: [endpointSg.attrGroupId],
      privateDnsEnabled: true,
    });
    bedrockEndpoint.cfnOptions.condition = this.condition('BedrockEndpointRequested');

    // ---------------------------------------------------------------- load balancer
    const alb = new CfnLoadBalancer(this, 'LoadBalancer', {
      type: 'application',
      scheme: 'internal',
      ipAddressType: 'ipv4',
      subnets,
      securityGroups: [albSg.attrGroupId],
      loadBalancerAttributes: [
        { key: 'routing.http.drop_invalid_header_fields.enabled', value: 'true' },
        { key: 'routing.http.desync_mitigation_mode', value: 'strictest' },
        { key: 'idle_timeout.timeout_seconds', value: '120' },
      ],
    });

    const targetGroup = new CfnTargetGroup(this, 'FrontendTargetGroup', {
      vpcId: vpcId.valueAsString,
      targetType: 'ip',
      protocol: 'HTTP',
      port: PORTS.frontend,
      healthCheckEnabled: true,
      healthCheckPath: '/healthz',
      healthCheckIntervalSeconds: 15,
      healthCheckTimeoutSeconds: 5,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      matcher: { httpCode: '200' },
      targetGroupAttributes: [{ key: 'deregistration_delay.timeout_seconds', value: '30' }],
    });

    const listener = new CfnListener(this, 'HttpsListener', {
      loadBalancerArn: alb.ref,
      port: 443,
      protocol: 'HTTPS',
      sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      certificates: [{ certificateArn: certificateArn.valueAsString }],
      defaultActions: [
        {
          type: 'authenticate-cognito',
          order: 1,
          authenticateCognitoConfig: {
            userPoolArn: userPool.attrArn,
            userPoolClientId: userPoolClient.ref,
            userPoolDomain: userPoolDomain.ref,
            onUnauthenticatedRequest: 'authenticate',
            scope: 'openid email profile',
            sessionCookieName: 'AWSELBAuthSessionCookie',
            sessionTimeout: sessionTimeout.valueAsString,
          },
        },
        { type: 'forward', order: 2, targetGroupArn: targetGroup.ref },
      ],
    });

    new CfnListenerRule(this, 'HealthCheckRule', {
      listenerArn: listener.ref,
      priority: 1,
      conditions: [{ field: 'path-pattern', pathPatternConfig: { values: ['/healthz'] } }],
      actions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
    });
    const smokeRule = new CfnListenerRule(this, 'SmokeTestRule', {
      listenerArn: listener.ref,
      priority: 2,
      conditions: [{ field: 'path-pattern', pathPatternConfig: { values: ['/api/selftest'] } }],
      actions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
    });
    smokeRule.cfnOptions.condition = this.condition('SmokeTestPathEnabled');

    // ---------------------------------------------------------------- IAM (customer-account runtime roles)
    const ecsTrust = {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: { ArnLike: { 'aws:SourceArn': Fn.sub('arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:*') } },
      }],
    };
    const executionRole = new CfnRole(this, 'TaskExecutionRole', {
      description: 'Pulls images, writes logs and reads the application secret',
      assumeRolePolicyDocument: ecsTrust,
      managedPolicyArns: [Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy')],
    });
    new CfnPolicy(this, 'TaskExecutionSecretsPolicy', {
      policyName: 'read-application-secret',
      roles: [executionRole.ref],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secret.ref },
          {
            Effect: 'Allow', Action: 'kms:Decrypt', Resource: key.attrArn,
            Condition: { StringEquals: { 'kms:ViaService': Fn.sub('secretsmanager.${AWS::Region}.amazonaws.com') } },
          },
        ],
      },
    });

    const taskRole = new CfnRole(this, 'TaskRole', {
      description: 'Application runtime role: Bedrock model invocation only',
      assumeRolePolicyDocument: ecsTrust,
    });
    const profileArn = 'arn:${AWS::Partition}:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/${BedrockModelId}';
    new CfnPolicy(this, 'TaskRoleBedrockPolicy', {
      policyName: 'invoke-selected-bedrock-model',
      roles: [taskRole.ref],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'InvokeSelectedModelOrProfile',
            Effect: 'Allow',
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            Resource: [
              Fn.sub('arn:${AWS::Partition}:bedrock:${AWS::Region}::foundation-model/${BedrockModelId}'),
              Fn.sub(profileArn),
            ],
          },
          {
            Sid: 'FoundationModelsReachedThroughSelectedProfile',
            Effect: 'Allow',
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            Resource: Fn.sub('arn:${AWS::Partition}:bedrock:*::foundation-model/*'),
            Condition: { StringEquals: { 'bedrock:InferenceProfileArn': Fn.sub(profileArn) } },
          },
        ],
      },
    });

    // ---------------------------------------------------------------- ECS
    const cluster = new CfnCluster(this, 'Cluster', {
      clusterSettings: [{ name: 'containerInsights', value: containerInsights.valueAsString }],
    });

    const logConfig = (c: Component) => ({
      logDriver: 'awslogs',
      options: {
        'awslogs-group': logGroups[c].ref,
        'awslogs-region': Aws.REGION,
        'awslogs-stream-prefix': c,
        mode: 'non-blocking',
        'max-buffer-size': '4m',
      },
    });
    const pyHealth = (url: string) => ['CMD', 'python', '-c', `import urllib.request; urllib.request.urlopen('${url}', timeout=3)`];
    const healthTiming = { interval: 15, timeout: 5, retries: 3, startPeriod: 20 };
    const common = { essential: true, linuxParameters: { initProcessEnabled: true } };

    const taskDefinition = new CfnTaskDefinition(this, 'TaskDefinition', {
      family: Fn.sub('${AWS::StackName}-app'),
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      cpu: '1024',
      memory: '2048',
      runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
      executionRoleArn: executionRole.attrArn,
      taskRoleArn: taskRole.attrArn,
      containerDefinitions: [
        {
          ...common,
          name: 'agent',
          image: imageUri(props.images.images.agent),
          portMappings: [{ containerPort: PORTS.agent, protocol: 'tcp' }],
          memoryReservation: 1024,
          environment: [
            { name: 'PORT', value: String(PORTS.agent) },
            { name: 'LLM_PROVIDER', value: 'bedrock' },
            { name: 'BEDROCK_MODEL_ID', value: modelId.valueAsString },
            { name: 'AWS_REGION', value: Aws.REGION },
            { name: 'LOG_LEVEL', value: 'INFO' },
          ],
          healthCheck: { command: pyHealth(`http://127.0.0.1:${PORTS.agent}/healthz`), ...healthTiming },
          logConfiguration: logConfig('agent'),
        },
        {
          ...common,
          name: 'api',
          image: imageUri(props.images.images.api),
          portMappings: [{ containerPort: PORTS.api, protocol: 'tcp' }],
          memoryReservation: 512,
          dependsOn: [{ containerName: 'agent', condition: 'HEALTHY' }],
          environment: [
            { name: 'PORT', value: String(PORTS.api) },
            { name: 'AGENT_URL', value: `http://127.0.0.1:${PORTS.agent}` },
            { name: 'APP_HOSTNAME', value: appHostname.valueAsString },
            { name: 'COGNITO_DOMAIN', value: Fn.sub('${UserPoolDomain}.auth.${AWS::Region}.amazoncognito.com') },
            { name: 'COGNITO_CLIENT_ID', value: userPoolClient.ref },
            { name: 'SMOKE_TEST_ENABLED', value: smokeTestPath.valueAsString },
            { name: 'LOG_LEVEL', value: 'INFO' },
          ],
          secrets: [{ name: 'FLASK_SECRET_KEY', valueFrom: secret.ref }],
          healthCheck: { command: pyHealth(`http://127.0.0.1:${PORTS.api}/api/healthz`), ...healthTiming },
          logConfiguration: logConfig('api'),
        },
        {
          ...common,
          name: 'frontend',
          image: imageUri(props.images.images.frontend),
          portMappings: [{ containerPort: PORTS.frontend, protocol: 'tcp' }],
          memoryReservation: 256,
          dependsOn: [{ containerName: 'api', condition: 'HEALTHY' }],
          healthCheck: {
            command: ['CMD', 'wget', '-q', '-O', '/dev/null', `http://127.0.0.1:${PORTS.frontend}/healthz`],
            ...healthTiming,
          },
          logConfiguration: logConfig('frontend'),
        },
      ],
    });

    const service = new CfnService(this, 'Service', {
      cluster: cluster.ref,
      taskDefinition: taskDefinition.ref,
      launchType: 'FARGATE',
      platformVersion: 'LATEST',
      desiredCount: desiredCount.valueAsNumber,
      enableExecuteCommand: false,
      propagateTags: 'SERVICE',
      healthCheckGracePeriodSeconds: 120,
      deploymentController: { type: 'ECS' },
      deploymentConfiguration: {
        minimumHealthyPercent: 100,
        maximumPercent: 200,
        deploymentCircuitBreaker: { enable: true, rollback: true },
      },
      networkConfiguration: {
        awsvpcConfiguration: { assignPublicIp: 'DISABLED', subnets, securityGroups: [taskSg.attrGroupId] },
      },
      loadBalancers: [{ containerName: 'frontend', containerPort: PORTS.frontend, targetGroupArn: targetGroup.ref }],
    });
    service.addResourceDependency(listener);

    // ---------------------------------------------------------------- alarms
    const alarmTopic = new CfnTopic(this, 'AlarmTopic', {
      displayName: Fn.sub('${AWS::StackName} alarms'),
      kmsMasterKeyId: key.attrArn,
    });
    new CfnTopicPolicy(this, 'AlarmTopicPolicy', {
      topics: [alarmTopic.ref],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'CloudWatchAlarmsInThisAccount',
          Effect: 'Allow',
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Action: 'sns:Publish',
          Resource: alarmTopic.ref,
          Condition: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
        }],
      },
    });
    const emailSubscription = new CfnSubscription(this, 'AlarmEmailSubscription', {
      topicArn: alarmTopic.ref, protocol: 'email', endpoint: alarmEmail.valueAsString,
    });
    emailSubscription.cfnOptions.condition = this.condition('HasAlarmEmail');
    const alarmActions = [alarmTopic.ref];

    const alarm = (id: string, suffix: string, description: string, p: Partial<ConstructorParameters<typeof CfnAlarm>[2]>) => {
      const a = new CfnAlarm(this, id, {
        alarmName: Fn.sub(`\${AWS::StackName}-${suffix}`),
        alarmDescription: description,
        alarmActions,
        okActions: alarmActions,
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: 3,
        period: 60,
        statistic: 'Maximum',
        threshold: 0,
        treatMissingData: 'notBreaching',
        ...p,
      } as ConstructorParameters<typeof CfnAlarm>[2]);
      return a;
    };

    const albDim = { name: 'LoadBalancer', value: alb.attrLoadBalancerFullName };
    const tgDim = { name: 'TargetGroup', value: targetGroup.attrTargetGroupFullName };
    const svcDims = [{ name: 'ClusterName', value: cluster.ref }, { name: 'ServiceName', value: service.attrName }];

    alarm('AlbTarget5xxAlarm', 'target-5xx', 'Application returned more than 10 HTTP 5xx responses in 5 minutes. Check api/agent logs.', {
      namespace: 'AWS/ApplicationELB', metricName: 'HTTPCode_Target_5XX_Count', dimensions: [albDim],
      statistic: 'Sum', period: 300, evaluationPeriods: 1, threshold: 10,
    });
    alarm('UnhealthyTargetsAlarm', 'unhealthy-targets', 'At least one task failed ALB health checks for 3 minutes.', {
      namespace: 'AWS/ApplicationELB', metricName: 'UnHealthyHostCount', dimensions: [albDim, tgDim],
    });
    alarm('NoHealthyTargetsAlarm', 'no-healthy-targets', 'No healthy tasks behind the ALB: the application is down.', {
      namespace: 'AWS/ApplicationELB', metricName: 'HealthyHostCount', dimensions: [albDim, tgDim],
      comparisonOperator: 'LessThanThreshold', statistic: 'Minimum', threshold: 1, evaluationPeriods: 2, treatMissingData: 'breaching',
    });
    alarm('ServiceCpuHighAlarm', 'cpu-high', 'Service CPU above 85% for 15 minutes; consider raising DesiredCount.', {
      namespace: 'AWS/ECS', metricName: 'CPUUtilization', dimensions: svcDims, statistic: 'Average', period: 300, threshold: 85,
    });
    alarm('ServiceMemoryHighAlarm', 'memory-high', 'Service memory above 85% for 15 minutes.', {
      namespace: 'AWS/ECS', metricName: 'MemoryUtilization', dimensions: svcDims, statistic: 'Average', period: 300, threshold: 85,
    });

    // ---------------------------------------------------------------- outputs (non-sensitive only)
    new CfnOutput(this, 'ApplicationUrl', { value: Fn.sub('https://${AppHostname}/'), description: 'Private URL (corporate network only)' });
    new CfnOutput(this, 'LoadBalancerDnsName', { value: alb.attrDnsName, description: 'Point the corporate DNS record for AppHostname here' });
    new CfnOutput(this, 'LoadBalancerHostedZoneId', { value: alb.attrCanonicalHostedZoneId });
    new CfnOutput(this, 'UserPoolId', { value: userPool.ref, description: 'Create users here (admin-only sign-up)' });
    new CfnOutput(this, 'CognitoHostedDomain', { value: Fn.sub('${UserPoolDomain}.auth.${AWS::Region}.amazoncognito.com') });
    new CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.ref, description: 'Subscribe your operations tooling here' });
    new CfnOutput(this, 'ClusterName', { value: cluster.ref });
    new CfnOutput(this, 'ServiceName', { value: service.attrName });
    for (const [c, g] of Object.entries(logGroups)) new CfnOutput(this, `${cap(c)}LogGroupName`, { value: g.ref });

    Tags.of(this).add('marketplace:product', PRODUCT_NAME);
    Tags.of(this).add('marketplace:product-version', props.productVersion);
  }

  private condition(id: string): CfnCondition {
    return this.node.findChild(id) as CfnCondition;
  }

  private logGroup(id: string, component: Component, key: CfnKey, retention: CfnParameter): CfnLogGroup {
    const g = new CfnLogGroup(this, id, {
      logGroupName: Fn.sub(`/\${AWS::StackName}/${component}`),
      retentionInDays: retention.valueAsNumber,
      kmsKeyId: key.attrArn,
    });
    retain(g);
    return g;
  }
}

/**
 * A complete two- or three-element subnet list chosen by a CloudFormation condition.
 * The cast is isolated here: CDK types subnet lists as string[], while the rendered value is an Fn::If
 * whose branches are both complete lists (no AWS::NoValue elements). Covered by template tests.
 */
export function subnetSelection(condition: string, required: [string, string], optional: string): string[] {
  return Token.asList(Fn.conditionIf(condition, [...required, optional], required));
}

function retain(r: { cfnOptions: { deletionPolicy?: CfnDeletionPolicy; updateReplacePolicy?: CfnDeletionPolicy } }): void {
  r.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
  r.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
