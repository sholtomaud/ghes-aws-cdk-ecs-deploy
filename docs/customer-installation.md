# Customer installation

You need no Node.js, CDK or vendor account. You deploy one CloudFormation template into your own account.

## Prerequisites

1. An AWS Marketplace subscription to the product (this gives your account access to its images).
2. Amazon Bedrock model access enabled in the target Region for the model you choose (`BedrockModelId`, a model ID or
   inference profile ID).
3. A VPC and two or three private subnets that meet the [network contract](network-contract.md), including egress
   from the ALB subnets to Cognito.
4. An ACM certificate for the private hostname (for example `assistant.corp.example.com`).
5. A globally unique Cognito domain prefix (for example `corp-assistant-prod`).

## Install

1. In AWS Marketplace, choose the product version and the CloudFormation delivery option, and open the template URL
   (or download it).
2. CloudFormation → Create stack → With new resources → upload or enter the template URL.
3. Fill in the parameters (they are grouped in the console). Leave `EnableSmokeTestPath=false` in production.
4. Acknowledge IAM resource creation (`CAPABILITY_IAM`; the stack creates roles without custom names).
5. When the stack is `CREATE_COMPLETE`:
   - create the corporate DNS record `AppHostname` → output `LoadBalancerDnsName`;
   - create users in the Cognito user pool (output `UserPoolId`; sign-up is admin-only), or federate your corporate
     IdP into the user pool (SAML or OIDC) and add it to the app client;
   - optionally subscribe operations tooling to the alarm topic (output `AlarmTopicArn`).
6. Browse to `https://<AppHostname>/` from the corporate network and sign in.

## What gets created

ECS cluster and service (Fargate), task definition, internal ALB, listener and target group, three security groups,
Cognito user pool, domain and app client, KMS key, Secrets Manager secret, three log groups, five alarms with an SNS
topic, IAM task and execution roles, and optionally a Bedrock Runtime endpoint.

**Retained on stack deletion** (customer data): the KMS key, log groups and user pool (which also has deletion
protection). Delete them manually if you no longer need them.

## Costs (main drivers)

Fargate vCPU and memory (1 vCPU / 2 GiB per task × `DesiredCount`), the ALB (hours and LCUs), Bedrock tokens,
CloudWatch Logs ingestion and storage, the KMS key ($1/month plus requests), Secrets Manager (one secret), Cognito
monthly active users, the optional Bedrock interface endpoint (per AZ-hour plus data) and Container Insights if
enabled. VPC endpoints and NAT used by the stack belong to your network and are billed there.

## Support boundary

The vendor has **no access** to your account and runs no control plane in it. Logs and metrics stay in your account.
Upgrades are always customer-initiated stack updates.
