# Upgrades and rollback

## Customer upgrades

Publishing a new version in AWS Marketplace does **not** change existing stacks. Customers upgrade when they choose:

1. Read the version's release notes, including its **Upgrade** and **Breaking changes** sections.
2. CloudFormation → your stack → **Update** → Replace existing template → the new version's template URL.
3. Keep **Use existing value** for every parameter. Only parameters added in the new version need input; they have
   safe defaults.
4. Create a **change set** first and review it. An ordinary upgrade modifies the task definition (new image
   digests), the service and tags. **Stop** if the change set shows `Replacement: True` for the load balancer,
   user pool, KMS key, log groups or security groups, and contact support.
5. Execute the change set. ECS rolls tasks with `minimumHealthyPercent 100` / `maximumPercent 200`, so capacity is
   preserved during the rollout.

**Stateful resources:** the Cognito user pool (users), KMS key and log groups are retained and keep their logical IDs
across releases (enforced by `marketplace/schemas/customer-stack-contract.json`). The application stores no other
data. If a future version adds stateful resources, its release notes must describe backup and migration steps.

## Automatic rollback

- **ECS deployment circuit breaker** (`rollback: true`): if new tasks fail to reach a healthy state, ECS returns the
  service to the last working deployment.
- **CloudFormation**: a failed update returns the stack to `UPDATE_ROLLBACK_COMPLETE` with the previous configuration.
  The clean-account tests exercise this path on every release.

Inspect a failed update in CloudFormation → stack → **Events** (the first `*_FAILED` event is the cause), and in
ECS → service → **Deployments** and **Events**.

## Manual rollback to a previous version

Update the stack again with the **previous** version's template, keeping existing parameter values. Released
versions and their images are immutable, so this restores exactly the previous deployment. If the stack is stuck in
`UPDATE_ROLLBACK_FAILED`, use **Continue update rollback** (skip only resources you have verified by hand).

## Network migrations

Changing `VpcId` or the subnets replaces the ALB, target group and service, which gives the application a new ALB
DNS name. Treat it as a planned change:
1. Schedule a window and lower the DNS TTL in advance.
2. Update the stack with the new network parameters (same template version).
3. Update the corporate DNS record to the new `LoadBalancerDnsName`.

## Seller-side rules

- Never change a released version's images or template. Fix forward with a new version.
- Each release lists `SUPPORTED_UPGRADE_FROM`, and the clean-account stage tests an upgrade from each of those
  versions before approval.
