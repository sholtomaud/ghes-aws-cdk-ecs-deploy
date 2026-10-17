# Network contract

The product deploys **into** an existing customer VPC. It never creates or modifies VPCs, subnets, route tables,
gateways, VPN or Direct Connect resources, DNS zones or records, or network ACLs (enforced by template tests and the
template validator). It creates only application security groups, an internal ALB, ECS tasks and, optionally, one
Bedrock Runtime interface endpoint.

## Inputs

| Parameter | Requirement |
| --- | --- |
| `VpcId` | Existing VPC with DNS resolution and DNS hostnames enabled (needed for private endpoint DNS). |
| `PrivateSubnetA`, `PrivateSubnetB` | Two different private subnets in **different Availability Zones**, both in `VpcId` (checked by a CloudFormation rule; the ALB enforces distinct AZs). |
| `PrivateSubnetC` | Optional third subnet in a third AZ, for three-AZ resilience. Leave empty for two subnets. Must differ from A and B (rule). |
| `AllowedIngressCidr` / `AllowedSourceSecurityGroupId` | At least one is required. These are the corporate client range(s) allowed to reach the ALB on 443. `0.0.0.0/0` is rejected; the CIDR prefix must be /8 or longer. |

Each subnet needs free IPs for up to `2 × DesiredCount` task ENIs during rolling deployments, plus the ALB's ENIs
(at least 8 free addresses per subnet is the ALB minimum).

## Reachability and DNS

- Clients reach the ALB over the corporate network (VPN, Direct Connect or Transit Gateway routes to these subnets).
- Create a corporate DNS record (Route 53 private hosted zone or on-premises DNS) for `AppHostname`: a CNAME or alias
  to the `LoadBalancerDnsName` stack output. The internal ALB's DNS name resolves to private IPs.
- The ACM certificate in `CertificateArn` must cover `AppHostname`, and client browsers must trust its issuer.

## Egress required at runtime

The task security group allows only TCP 443 egress. The ALB security group allows 443 egress (to Cognito) and 8080
to the tasks. Tie the endpoints below to the customer's design: provide each one either through a VPC endpoint or
through existing controlled egress (NAT or proxy).

| Caller | Destination | Why | Private option |
| --- | --- | --- | --- |
| ECS (task start, image pull) | ECR API, ECR Docker registry | pull Marketplace images (also on every task replacement) | interface endpoints `ecr.api`, `ecr.dkr` |
| ECS (image layers) | Amazon S3 | ECR layer storage | S3 gateway endpoint (route table owned by the customer) |
| ECS (logs) | CloudWatch Logs | `awslogs` driver | interface endpoint `logs` |
| ECS (task start) | Secrets Manager | inject `FLASK_SECRET_KEY` | interface endpoint `secretsmanager` |
| agent | Bedrock Runtime | model invocation | interface endpoint `bedrock-runtime`: create it with `CreateBedrockEndpoint=true` if the VPC has none |
| **ALB** | Cognito user pool endpoints (`<prefix>.auth.<region>.amazoncognito.com`, `cognito-idp.<region>.amazonaws.com`) | `authenticate-cognito`: the ALB exchanges the authorization code at the token endpoint | **Needs a route from the ALB subnets to these public AWS endpoints, normally the customer's NAT or egress.** Cognito hosted endpoints have no VPC endpoint. |

Not required: STS (task credentials come from the ECS credential endpoint), KMS (Secrets Manager and CloudWatch Logs
call KMS service-side), and general internet access from tasks. No vendor-owned endpoint is contacted.

Only set `CreateBedrockEndpoint=true` if the VPC does not already have a `bedrock-runtime` endpoint with private
DNS; two endpoints with private DNS for the same service conflict. Each endpoint costs per AZ-hour plus data
processed.

## Changing networks

Ordinary upgrades keep the existing parameter values ("use existing value"). Moving to other subnets or another VPC
is a separate, planned change: it replaces the ALB and service (new DNS name) and needs a maintenance window. See
[upgrades-and-rollback.md](upgrades-and-rollback.md).
