# Specification: AWS Marketplace Private Application and Controlled Release Stack

**Status:** Implementation specification  
**Target:** An implementation-capable LLM or engineer completing the repository  
**Language:** TypeScript for AWS CDK; Node.js 26 for development and tooling  
**Primary deployment model:** AWS Marketplace container product deployed into a customer's AWS account and existing corporate VPC  
**Release control:** GitHub Actions for fast CI; AWS CodePipeline for controlled Marketplace releases  
**Local container tooling:** Docker in GitHub Actions; Apple Container CLI on macOS

## 1. Objective

Implement a production-minded, low-operations AWS Marketplace product and its controlled release pipeline. The implementation must be complete, testable, auditable, and documented. Do not leave placeholder scripts, pseudo-code, or TODOs in the final repository for core workflow stages.

The product currently consists of:
- A React/Vite frontend.
- A Flask API.
- A LangChain agent that calls Amazon Bedrock.

Preserve the three application components as container images unless the repository inspection establishes that the existing interfaces make this impossible without a deliberate, documented change. The default deployment is one ECS Fargate task definition containing the three containers, so the customer operates one ECS service rather than a Kubernetes platform. Use separate ECS services only if the existing agent interface or scaling/lifecycle requirements make a single task unsuitable; document the reason and resulting cost/operational impact.

The application must have **no public application endpoint**. The application is reachable only through the customer's corporate network/VPN/Direct Connect. Amazon Cognito is the only public-facing application-related endpoint. The internal load balancer must not be internet-facing.

The customer has no dedicated DevOps team. Avoid EKS, Kubernetes, GitOps, self-managed observability stacks, vendor-operated customer-account control planes, and unnecessary third-party runtime dependencies.

## 2. Required deliverables

The completed repository must include:

1. CDK TypeScript app for the customer application stack.
2. CDK TypeScript app for the seller-side controlled-release pipeline.
3. A Marketplace-ready, synthesised CloudFormation deployment template and a reproducible process to generate it.
4. A `Containerfile` for the Node.js 26 development/tooling environment.
5. A single documented command interface via `Makefile`.
6. Unit tests using Jest for CDK and pure application/release logic.
7. Tests for the synthesised CloudFormation template, including network privacy and optional subnet behaviour.
8. GitHub Actions workflow using Docker to build and run the tooling image and run checks.
9. macOS workflow using Apple's `container` CLI to build and run the same tooling `Containerfile`.
10. Seller release pipeline with the stages specified in section 8.
11. Versioned, immutable release metadata and audit artefacts.
12. Clean-account install, smoke, and upgrade test harness.
13. Marketplace Catalog API submission, processing wait, publication verification, and announcement scripts.
14. Security, deployment, upgrade, rollback, and troubleshooting documentation.
15. Example configuration files with non-secret placeholders only.

Do not claim the product has been published or deployed by running local tests. Cloud Marketplace operations must require explicit seller account configuration and permissions.

## 3. Repository layout

Use this as the target layout. Adapt only where the existing repository requires it, and document any deviations.

```text
.
├── Containerfile
├── Makefile
├── package.json
├── package-lock.json
├── tsconfig.json
├── jest.config.ts
├── cdk.json
├── .dockerignore
├── .gitignore
├── README.md
├── docs/
│   ├── architecture.md
│   ├── customer-installation.md
│   ├── network-contract.md
│   ├── release-process.md
│   ├── security.md
│   ├── upgrades-and-rollback.md
│   └── troubleshooting.md
├── src/
│   ├── customer-app/
│   │   ├── bin/
│   │   ├── lib/
│   │   └── test/
│   └── seller-release/
│       ├── bin/
│       ├── lib/
│       └── test/
├── marketplace/
│   ├── template/                 # generated, deterministic CloudFormation JSON/YAML
│   ├── schemas/                  # checked-in request/schema examples where appropriate
│   └── release/                  # generated release metadata, not credentials
├── ci/
│   ├── build-and-test.sh
│   ├── build-product-images.sh
│   ├── package-release.sh
│   ├── test-clean-account.sh
│   ├── marketplace-submit.sh
│   ├── marketplace-wait.sh
│   ├── marketplace-verify.sh
│   └── announce-release.sh
├── buildspec/
│   ├── build-and-test.yml
│   ├── test-clean-account.yml
│   ├── marketplace-submit.yml
│   ├── marketplace-wait.yml
│   ├── marketplace-verify.yml
│   └── announce-release.yml
└── .github/
    └── workflows/
        └── ci.yml
```

The application source and container build contexts may live in separate existing directories. Do not invent replacement application code when the existing repository already supplies the frontend, Flask API, and agent.

## 4. Node.js 26 tooling container

The `Containerfile` is a **development and CDK tooling image**, not the production image for the Flask/agent/frontend containers.

Requirements:
- Pin the base image to a Node.js 26 image tag; use a Debian-based official Node image unless there is a concrete compatibility reason not to.
- Install the AWS CDK CLI and Jest/toolchain through `package.json` and `package-lock.json`, not floating global installs.
- Prefer project-local executables (`npx --no-install cdk`, `npx --no-install jest`) so versions are locked.
- Include only tools required to run CDK synth, Jest, TypeScript compilation, template checks, and release scripts.
- Do not bake AWS credentials, Marketplace credentials, source-control tokens, or secrets into the image.
- Make the image runnable as a non-root user where practical.
- Do not require Docker-in-Docker for CDK unit tests or synthesis.
- Do not assume Docker CLI is available inside this tooling container.
- Record the Node.js version and tool versions in CI logs.

Example starting point; complete and test it in the repository:

```dockerfile
FROM node:26-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npm", "test"]
```

The implementation may add a non-root user, health checks, labels, and a separate dependency-cache stage. Keep builds reproducible and do not install tools with unpinned `npm install -g latest`.

### Container runtime parity

Both supported developer/CI routes must build the same `Containerfile`:

**GitHub Actions:** use Docker BuildKit/buildx to build the tooling image, then run it for checks. GitHub Actions may also use Docker to build and smoke-test the three application images.

**macOS:** use Apple's Container CLI, not Docker Desktop, for the tooling image. Document and test commands matching the installed Apple Container CLI version, for example:

```bash
container build --file Containerfile --tag marketplace-tooling:local .
container run --rm marketplace-tooling:local npm test
container run --rm marketplace-tooling:local npx --no-install cdk synth
```

Apple's CLI uses `container build` and `container run`; command options can vary by released version. Check the supported command reference and make the README accurate for the tested macOS/CLI version. Do not silently fall back to Docker on macOS. If the CLI is unavailable, fail with a helpful installation message.

The tooling image must not need AWS credentials for unit tests, lint/type checks, or synthesis. AWS integration tests must be opt-in and use the host's supported AWS credential chain or an explicitly mounted/configured profile; never copy credentials into the image.

## 5. Package scripts and Makefile

Use a locked `package-lock.json`. Include clear npm scripts for at least:
- `typecheck`
- `test`
- `test:coverage`
- `cdk:synth:customer`
- `cdk:synth:pipeline`
- `template:validate`
- `release:package`
- `ci`

The `Makefile` is the main user interface. It must provide targets equivalent to:
- `make install`
- `make test`
- `make synth`
- `make validate`
- `make tooling-image`
- `make tooling-test`
- `make tooling-synth`
- `make clean`

Add separate targets for Docker and Apple Container CLI rather than trying to detect and silently substitute runtimes. For example, `make tooling-image-docker` and `make tooling-image-apple`. Ensure generated files are cleaned only from known generated directories.

Use Jest for unit tests as requested. CDK tests should use `aws-cdk-lib/assertions` and assert meaningful properties, not snapshot-only tests. Use deterministic fixture values and avoid depending on the developer's AWS account or live AWS lookups during synthesis.

## 6. Customer application architecture

### 6.1 Runtime

Use:
- Amazon ECS with AWS Fargate.
- An internal Application Load Balancer (ALB).
- ECS tasks in customer-selected private subnets.
- Amazon ECR / AWS Marketplace-delivered container images as required by the seller's approved Marketplace delivery model.
- Amazon CloudWatch Logs using the ECS `awslogs` log driver.
- AWS Secrets Manager or Systems Manager Parameter Store for sensitive/runtime configuration, as appropriate.
- Amazon Cognito for authentication.
- Amazon Bedrock for model inference.
- A Bedrock interface VPC endpoint where supported and required by the customer's private networking policy.
- CloudWatch alarms for essential health/failure signals without requiring a separate monitoring stack.

The application must not create a public ALB, public IPs for tasks, an internet gateway, NAT gateway, or shared corporate networking resources. The stack must not create or modify the customer's VPC, subnets, route tables, VPN, Direct Connect, corporate DNS, or shared firewall infrastructure.

### 6.2 Request path

The default request path is:

```text
Corporate browser on VPN / Direct Connect
      |
      v
Private DNS / corporate routing
      |
      v
Internal ALB (private subnets)
      |
      v
React/Vite frontend container
      |
      +---- /api/* ----> Flask API container
                            |
                            v
                      LangChain agent container
                            |
                            v
                       Amazon Bedrock
```

Cognito's hosted endpoints are public. The application callback/redirect URL must point to the internal application hostname and is usable only by clients with corporate network access. Ensure the Cognito/ALB authentication flow and callback URL design works with the private hostname and the intended browser path. Do not make the application hostname public merely to make the login flow easier.

The internal ALB should perform authentication using Cognito or a deliberately documented equivalent. If ALB `authenticate-cognito` is used, define the user pool, client, domain, callback URLs, listener rules, session settings, and logout behaviour. Never put client secrets or credentials into source control or image layers.

For the three-container task, define:
- Frontend container port and health check.
- Flask API port and health check.
- Agent container port and health check.
- Explicit container dependencies and startup behaviour.
- Resource reservations/limits appropriate to Fargate.
- Logging configuration for all containers.
- A clear internal interface between Flask and the agent.
- ALB target group routing and health check behaviour.

Containers in one ECS task using `awsvpc` share the task network namespace; avoid port collisions. If the current agent is not exposed as an HTTP service, adapt the integration without pretending that an arbitrary container can be called over HTTP. If the three components cannot safely share one task, use two ECS services (frontend/API and agent) and document the added resources and scaling behaviour.

### 6.3 Customer-owned VPC and subnets

The CloudFormation template must accept customer network inputs at deployment time. CDK synthesis must not look up or hard-code a real customer VPC/subnet.

Required parameters:
- `VpcId`: type `AWS::EC2::VPC::Id`.
- `PrivateSubnetA`: type `AWS::EC2::Subnet::Id`.
- `PrivateSubnetB`: type `AWS::EC2::Subnet::Id`.
- `PrivateSubnetC`: optional string defaulting to empty, with a subnet-ID pattern validation.

The customer must be able to select **two or three subnets**. Implement the optional third subnet robustly. Do not append `AWS::NoValue` as an array element and assume that CloudFormation will remove it. Use a CloudFormation condition (`UseThirdSubnet`) and `Fn::If` to choose between a complete two-element subnet list and a complete three-element subnet list in the relevant L1 resource properties. Add template tests that inspect both conditional branches.

Because CDK L2 VPC imports often require synthesis-time subnet/AZ knowledge, use L1 CloudFormation resources for subnet-list properties that must accept unresolved CloudFormation parameters, or another demonstrably correct pattern. Do not call `Vpc.fromLookup()`, `ec2.Vpc.fromLookup()`, or synth-time SDK lookups for the customer VPC. Do not claim that importing a VPC by attributes validates its subnets.

Validate and document:
- Two or three unique subnet IDs.
- Required Availability Zone distribution and resilience.
- Subnets are private and reachable from the customer's corporate network.
- Route and DNS dependencies.
- Application task egress to required AWS APIs.
- Access to the image repository during install/replacement deployments.
- Endpoint and DNS requirements.

The stack may create application-specific security groups and the internal ALB, but inbound rules must be restricted to the explicitly configured corporate CIDRs or an existing customer-approved security group. Avoid broad `0.0.0.0/0` ingress. If corporate source CIDRs are unknown, require a customer-provided allowed CIDR or approved source security group parameter rather than opening access.

Ordinary application upgrades must preserve the existing parameter values. Network migrations must be a separate, explicit change process.

### 6.4 Network egress and endpoints

Document a least-egress model. Where the application must reach AWS APIs privately, specify appropriate interface/gateway endpoints and their security group/DNS requirements. At minimum assess ECR API, ECR Docker, S3 image-layer access, CloudWatch Logs, Secrets Manager/SSM if used, and Bedrock Runtime. Do not assert every endpoint is always mandatory; tie the list to the actual runtime calls and the customer's network design.

Do not require general internet egress from application tasks unless a documented product dependency needs it. VPC endpoints have cost and must be clearly identified as either customer-provided dependencies or resources created by the product within an explicitly approved scope. The product must not modify shared networking.

### 6.5 Logging and operations

- Every application container writes useful structured logs to stdout/stderr.
- ECS forwards logs to CloudWatch Logs in the customer's account.
- Log groups have explicit retention and deletion policies appropriate for customer data.
- No vendor-owned logging or telemetry endpoint is required.
- Include health checks, deployment circuit breaker/rollback settings where supported, and a small set of actionable CloudWatch alarms.
- Never log prompts, secrets, authorization tokens, or sensitive customer content by default.
- Document log groups, alarm names, required IAM permissions, cost drivers, and troubleshooting steps.

## 7. Marketplace deployment template and customer upgrades

The customer deployment template is synthesised from CDK TypeScript using `cdk synth`. Publish the synthesised CloudFormation template as a versioned Marketplace deployment artifact only after validating that the exact delivery option schema supports the intended CloudFormation deployment resource for the seller's container product. Marketplace delivery option formats vary by product/delivery model; confirm against the current seller documentation and actual product metadata instead of assuming every container listing accepts an arbitrary template URL.

Requirements:
- The customer does not need Node.js, CDK CLI, CDK bootstrap, or a vendor account to install the published template.
- The customer deploys into their own AWS account.
- The template must not depend on a CDK bootstrap bucket or asset published only in the seller's account unless the Marketplace delivery model explicitly supports and secures that dependency.
- Container images must be published through the correct AWS Marketplace repositories/delivery workflow and referenced by immutable release tags/digests as supported.
- Include all images required for each version, even when an image did not change, where Marketplace requires this.
- Do not use `latest` for production release references.
- Do not store credentials in parameters, template outputs, user data, or image layers.
- Customer upgrades are customer-initiated CloudFormation stack updates using a new version's template. Marketplace publication alone does not update existing customer stacks.
- Preserve stable CloudFormation logical IDs and parameters between releases to minimise replacement risk.
- Test upgrades from every supported previous version, not only clean installs.
- Include release notes, change-set review instructions, backup/migration requirements for stateful resources, and rollback guidance.

Do not create a vendor-managed cross-account controller that silently updates customer stacks. That is out of scope for v1.

## 8. Controlled seller release pipeline

Create the seller-side pipeline with the following stages in this exact order:

```text
Automated build and tests
          |
          v
Clean-account deployment tests
          |
          v
Release approval
          |
          v
Marketplace submission
          |
          v
Wait for Marketplace processing
          |
          v
Verify publication status
          |
          v
Announce release
```

Use AWS CodePipeline and CodeBuild, provisioned by CDK TypeScript. GitHub Actions remains the fast PR/branch CI layer; the AWS pipeline is the authoritative controlled release path. Do not make a GitHub Actions job able to bypass the manual approval and submit a Marketplace release directly.

### 8.1 Automated build and tests

- Fetch source from a configured GitHub repository using an AWS CodeConnections connection.
- Install locked dependencies with `npm ci`.
- Run formatting/lint checks if configured, TypeScript type checking, Jest tests, CDK assertions, template validation, and application tests.
- Build and test the three application images.
- Run dependency and image security scans.
- Generate the customer CloudFormation template using CDK.
- Package release artifacts and metadata.
- Generate immutable version/tag/digest metadata and release notes.
- Fail closed on any test, scan, packaging, or template validation failure.

### 8.2 Clean-account deployment tests

Use a dedicated test AWS account. The pipeline assumes a narrowly scoped cross-account test role; the role trusts only the intended seller pipeline principal and has permissions only for the test resources.

Test:
- Fresh install into an isolated VPC/subnet setup representative of the supported network contract.
- Two-subnet configuration.
- Three-subnet configuration.
- Internal ALB is not internet-facing and ECS tasks have no public IP.
- Authentication and internal reachability where practical.
- Application health and Bedrock connectivity using a safe test path.
- Logs and alarms are created.
- Upgrade from the prior supported release.
- Rollback behaviour.
- Cleanup of ephemeral test resources.

Do not grant broad administrator access just to make the test work. Clean up only resources created by the test harness; do not delete pre-existing test account resources.

### 8.3 Release approval

Add a CodePipeline manual approval action after all tests succeed. Notify approvers through SNS or another documented notification path. The approval details must include:
- Version and commit SHA.
- Test results and artifact links.
- Security scan summary.
- CloudFormation change summary.
- Image tags and digests.
- Release notes.
- Marketplace product ID and intended delivery option.

Only a human approval can proceed to Marketplace submission. Rejection must terminate the release.

### 8.4 Marketplace submission

The submission stage uses the AWS Marketplace Catalog API, generally `StartChangeSet` with `AddDeliveryOptions` for a new container product version. It must use the correct `ContainerProduct@1.0` entity identifier, version metadata, delivery option details, Marketplace ECR image references, and deployment resource expected by the existing seller listing.

Before implementation, inspect current AWS Marketplace documentation and the seller's actual product metadata to confirm the correct request shape. Do not invent a universal `DetailsDocument` or deployment resource name. Keep product ID, delivery option metadata, region, and repository configuration in non-secret deployment configuration. Keep IAM permissions least-privileged where the API supports resource scoping.

Persist a machine-readable `submission.json` containing at least:
- Product ID.
- Change-set ID and ARN.
- Release version.
- Commit SHA.
- Image references/digests.
- Submission timestamp.

Never submit a new release by changing an existing publicly released version's immutable image/template contents. Create a new version when required by Marketplace policy.

### 8.5 Wait for Marketplace processing

Poll `DescribeChangeSet` (or the currently documented equivalent) using the returned change-set ID. The wait script must:
- Use a configurable maximum wait time.
- Poll with bounded backoff and avoid busy loops.
- Continue only for documented nonterminal statuses.
- Succeed only for a documented successful terminal status.
- Fail immediately on failed/cancelled/error terminal status.
- Include Marketplace failure details in logs and a machine-readable artifact.
- Fail on timeout.
- Preserve `submission.json` and produce `processing.json`.

Marketplace processing can take minutes to hours. Do not rely on a fixed sleep as the sole readiness check.

### 8.6 Verify publication status

A successful change-set status is not automatically equivalent to the version being publicly visible or available to all intended buyers. Implement a separate verification step that uses the currently documented Catalog API/product metadata or an explicitly supported seller-side verification mechanism to confirm the intended release state.

The verification script must:
- Confirm the intended version and delivery option exist.
- Confirm the publication/availability state required by the release policy.
- Fail closed if it cannot prove the intended state.
- Write `verification.json` with the observed state, time, product ID, version, and evidence fields.
- Not claim public availability if the API does not expose or prove it. In that case, define an explicit seller-portal/manual verification gate and document it rather than fabricating a check.

### 8.7 Announce release

Only run after verification succeeds. Publish through SNS to the configured release announcement topic. Include:
- Version and release notes.
- Publication state and verification time.
- Marketplace product link or documented customer instructions.
- Supported upgrade path and known breaking changes.
- Release artifact/commit identifiers.

The announcement stage must consume the verified artifact, not infer the version from a mutable branch name. A failed or timed-out Marketplace stage must never announce a successful release.

## 9. Release artifact contract

Use one versioned release manifest shared across stages. Define and validate a JSON schema or equivalent runtime validation. Example fields:

```json
{
  "schemaVersion": 1,
  "version": "1.2.3",
  "commitSha": "full-commit-sha",
  "builtAt": "RFC3339 timestamp",
  "images": {
    "frontend": {
      "tag": "1.2.3",
      "digest": "sha256:..."
    },
    "api": {
      "tag": "1.2.3",
      "digest": "sha256:..."
    },
    "agent": {
      "tag": "1.2.3",
      "digest": "sha256:..."
    }
  },
  "templateSha256": "sha256...",
  "releaseNotesPath": "release-notes/1.2.3.md"
}
```

Use actual built digests; never put placeholder digest values in a real release. Generate checksums for the synthesised template and release metadata. Keep artefacts between CodePipeline stages using CodePipeline artifacts, not an unversioned shared directory. Do not rebuild or mutate application images after they have passed the clean-account tests.

## 10. GitHub Actions workflow

The workflow must:
- Run on pull requests and pushes to the main branch.
- Use Docker BuildKit/buildx to build the tooling `Containerfile`.
- Run type checks, Jest, CDK synthesis, CloudFormation template checks, and available application tests inside the tooling image.
- Build the three application container images and run smoke tests where the repo supports it.
- Use least-privilege workflow permissions.
- Avoid AWS Marketplace publication credentials and do not publish releases from ordinary PRs.
- Pin third-party actions to immutable commit SHAs where practical.
- Cache dependencies without making correctness depend on cache contents.
- Upload test results and synthesised template as CI artefacts when appropriate.
- Never run untrusted fork code with secrets.
- Fail if generated template changes are not reproducible or required generated files are missing.

Use a separate, explicit release process for seller pipeline deployment and Marketplace submission.

## 11. Apple Container CLI macOS workflow

Document local commands using Apple's Container CLI and the same `Containerfile`. Include checks for:
- `container` command availability.
- Apple Container service/VM readiness if required by the installed CLI.
- Building the tooling image.
- Running tests and synthesis.
- Running template validation.
- Building/smoke-testing app images if the local architecture and CLI support it.

Do not require Docker Desktop on macOS. Do not state that Apple Container CLI is identical to Docker in every feature. Document known differences and keep application image build logic OCI-compatible. If a required local command is not supported by the installed Apple Container CLI version, fail with a clear message and use GitHub Actions Docker as the authoritative image build/test environment.

## 12. Security and IAM

- Separate customer-account runtime roles from seller pipeline roles and test-account roles.
- Use task roles for application AWS API calls; never embed access keys in containers.
- Give the agent only the required Bedrock model invocation permissions and scope resources where AWS supports it.
- Keep image-publishing permissions separate from Marketplace Catalog API permissions.
- Scope `sts:AssumeRole` to the single test-account role.
- Limit Marketplace Catalog API actions to the documented minimum required.
- Scope SNS publish permission to the release topic.
- Use Secrets Manager/SSM for sensitive configuration.
- Do not emit secrets into build logs or artifacts.
- Retain CodeBuild logs and release artefacts under a documented retention policy.
- Add account/region assertions and explicit configuration validation.
- No automatic public exposure or default wide-open security groups.
- No persistent vendor access into customer accounts.

## 13. CDK implementation rules

- Use TypeScript and `aws-cdk-lib` with pinned dependencies.
- Do not depend on ambient AWS credentials for synth/unit tests.
- Do not use `Vpc.fromLookup()` for customer-owned VPCs.
- Use deterministic logical IDs and avoid changing construct IDs without a migration reason.
- Separate customer deployment and seller pipeline stacks/apps.
- Synthesis must be offline and repeatable.
- Prefer L2 constructs when they support deployment-time parameters correctly; use L1 `Cfn*` resources where required for CloudFormation parameter/condition semantics.
- Set explicit retention/removal policies for persistent logs and critical resources.
- Add tags to product-owned resources.
- Use explicit health checks, deployment circuit breaker/rollback, log retention, and encryption where applicable.
- Generate CloudFormation outputs only for non-sensitive information.
- Avoid `any` in application logic; where CDK typing forces a narrow cast for intrinsic conditions, isolate it and test the resulting template.
- Use CloudFormation conditions and `Fn::If` to select a complete two-subnet list versus a complete three-subnet list. Do not depend on `AWS::NoValue` being removed from an array element.
- Validate the synthesised template for public ingress, public IPs, unwanted network resources, broad IAM permissions, unencrypted logs/secrets, and unpinned images.

## 14. Required tests

At minimum implement automated tests that prove:

### Customer stack
- VPC and subnet parameters exist and are not hard-coded.
- Third subnet is optional.
- `UseThirdSubnet` condition chooses the complete correct subnet list.
- Internal ALB scheme is `internal`.
- ECS task `AssignPublicIp` is `DISABLED`.
- No `AWS::EC2::VPC`, internet gateway, NAT gateway, or route table resources are created.
- Security group ingress is restricted.
- All containers have log configuration and health checks.
- ECS deployment rollback/circuit breaker is configured where supported.
- Required Bedrock access is scoped and no AWS access keys are baked into the task definition.
- Customer upgrades preserve logical IDs and parameters.

### Release pipeline
- Stage ordering exactly matches section 8.
- Manual approval is between clean-account tests and Marketplace submission.
- Marketplace submission cannot run before approval.
- Wait/verify/announce stages are separate.
- SNS announcement cannot occur unless verification succeeds.
- IAM roles are distinct and narrowly scoped.
- Failed test, failed change set, and timeout prevent announcement.
- Artifacts carry version, commit, change-set ID, image digests, and verification status.
- No stage uses `latest` for release image references.

### Tooling and CI
- Node.js major version is 26.
- `npm ci` succeeds from the lockfile.
- Jest, type checking, CDK synth and template validation run in the tooling image.
- The same Containerfile builds using Docker in GitHub Actions and Apple Container CLI on macOS.
- Tests and synth do not require AWS credentials.
- CI does not publish to Marketplace.

## 15. Operational behaviour and failure handling

- Build/test failure: stop pipeline and preserve test logs.
- Clean-account deployment failure: stop before approval; clean up test-created resources safely.
- Approval rejected: stop with no Marketplace submission.
- Submission API error: fail and preserve request/response with sensitive fields redacted.
- Marketplace change set failed/cancelled: fail and capture structured Marketplace errors.
- Processing timeout: fail without announcement; allow a controlled rerun/resume path that does not submit a duplicate version accidentally.
- Verification inconclusive: fail closed and require investigation/manual verification.
- Announcement failure: mark pipeline failed and make announcement safely retryable without duplicating confusing notifications.
- Partial customer stack update: use CloudFormation rollback and ECS deployment rollback; document how customers inspect stack events and recover.

Implement idempotency safeguards. Before submitting, detect an already-submitted release/change set where possible. Do not automatically retry non-idempotent operations without checking current state.

## 16. Configuration

Provide `.env.example` or equivalent with safe placeholders for:
- GitHub owner/repository/branch.
- CodeConnections connection ARN.
- Seller account/region.
- Test account ID and test deployment role ARN.
- Marketplace product ID and delivery option configuration.
- Marketplace Catalog API region.
- Release SNS topic ARN.
- Supported product version metadata.

Do not load `.env` into production deployment by default. Validate all required configuration before synthesising/deploying the seller pipeline. Fail with a useful error that names the missing variable without printing secrets.

Customer network parameters belong in the customer CloudFormation template, not in seller pipeline environment variables.

## 17. Acceptance criteria

The implementation is complete only when all of the following are true:

1. A clean checkout can run `npm ci`, `make test`, `make synth`, and `make validate` without AWS credentials.
2. Docker can build and run the tooling Containerfile in GitHub Actions.
3. Apple Container CLI can build and run the same Containerfile on a supported macOS version, with documented prerequisites.
4. CDK synthesis generates a Marketplace deployment template with customer-supplied VPC and two-or-three subnet parameters.
5. The template contains no public application load balancer, public task IPs, or product-created customer VPC.
6. Unit tests prove the two- and three-subnet conditional branches.
7. The release pipeline stages appear in the exact order specified.
8. The manual approval is enforced.
9. Marketplace submission, processing wait, publication verification, and announcement are separate, fail-closed stages.
10. The clean-account test can install and upgrade the product using a dedicated test account and narrowly scoped role.
11. Release images and template are immutable and traceable to a commit.
12. No release is announced until the intended publication state is verified.
13. Customer updates do not automatically modify their VPC, subnets, routes, VPN, or shared corporate network.
14. Documentation clearly explains install, upgrade, rollback, networking prerequisites, IAM, costs, logs, and support boundaries.
15. No core implementation step is left as pseudo-code, a placeholder script, or an unimplemented TODO.

## 18. Authoritative references to consult during implementation

Verify current details against official documentation. Do not blindly copy old API examples where product metadata or the Marketplace delivery model differs.

- AWS Marketplace container product Catalog API workflow: https://docs.aws.amazon.com/marketplace/latest/developerguide/work-with-container-products.html
- AWS Marketplace container product getting started: https://docs.aws.amazon.com/marketplace/latest/userguide/container-product-getting-started.html
- AWS CloudFormation stack updates: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-direct.html
- AWS CDK VPC constructs: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.Vpc.html
- AWS CDK assertions: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.assertions-readme.html
- Apple Container CLI command reference: https://github.com/apple/container/blob/main/docs/command-reference.md
- GitHub Actions documentation: https://docs.github.com/actions

## 19. Instructions to the implementing LLM

First inspect the existing repository and preserve existing application code and contracts. Then implement in small, test-driven increments.

1. Report the current repository structure and identify existing frontend/API/agent build contexts.
2. Propose the final file plan and note any conflicts with this spec.
3. Implement the tooling Containerfile, lockfile, package scripts, and Makefile first.
4. Implement the customer stack and CDK tests, especially private ingress and conditional subnet selection.
5. Implement the seller pipeline and its stage-order/IAM tests.
6. Implement CI scripts and GitHub Actions.
7. Implement the Marketplace request construction and status verification against current official API documentation and the actual configured product schema.
8. Implement clean-account tests and upgrade/rollback tests.
9. Complete docs and run all local checks.
10. Provide a concise final report with files changed, commands run, test results, any cloud-only checks not run, and all configuration still required.

Do not claim that a cloud deployment, Marketplace submission, or public publication was tested unless it actually was. If account-specific Marketplace information is unavailable, isolate it behind validated configuration and make the integration test explicit rather than fabricating values.
