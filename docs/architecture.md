# Architecture

## Customer application

```text
Corporate browser (VPN / Direct Connect)
   │  https://<AppHostname>   (corporate DNS → internal ALB DNS name)
   ▼
Internal ALB  (private subnets, HTTPS 443, TLS 1.3 policy, ACM certificate)
   │  default action: authenticate-cognito → forward      /healthz: forward without auth
   ▼
ECS Fargate task (awsvpc, no public IP)  ─ one service, DesiredCount tasks
   ├─ frontend  nginx :8080   static React app; proxies /api/* → 127.0.0.1:5000
   ├─ api       Flask :5000   (loopback only)  POST /api/chat → http://127.0.0.1:8000/invoke
   └─ agent     LangChain :8000 (loopback only) → Amazon Bedrock Runtime (task role)
```

Cognito's hosted sign-in domain is the only public, application-related endpoint. The callback URL is
`https://<AppHostname>/oauth2/idpresponse`, so the browser completes sign-in only from the corporate network.

### Container contract

| Container | Port | Health check | Starts after | Memory reservation |
| --- | --- | --- | --- | --- |
| agent | 8000 (loopback) | `GET /healthz` (no model call) | — | 1024 MiB |
| api | 5000 (loopback) | `GET /api/healthz` | agent HEALTHY | 512 MiB |
| frontend | 8080 | `GET /healthz` | api HEALTHY | 256 MiB |

The task has 1 vCPU and 2 GiB. All containers are essential, log through `awslogs` (non-blocking) to their own
KMS-encrypted log group, and run as non-root. Containers in one task share the `awsvpc` network namespace, so the
API and agent bind `127.0.0.1` and are unreachable from outside the task. The ALB target group checks the frontend's
`/healthz`; container dependencies guarantee the API and agent were healthy first.

**Flask ↔ agent interface:** `POST /invoke {"message": str}` → `{"reply": str}`; `POST /selftest` makes one
fixed-prompt model call (installation tests only); `GET /healthz`. The agent is a real HTTP service, so one task is
sufficient. Separate services would only be needed if the agent had to scale independently (more cost: a second
service, target group and security group rules).

### Template design

- Every resource is an L1 construct created directly under the stack, so logical IDs equal construct IDs. They and
  the parameters form the **upgrade contract** in `marketplace/schemas/customer-stack-contract.json`. A test fails if
  any listed parameter or logical ID disappears or changes type.
- Subnet lists use `Fn::If [UseThirdSubnet, [A, B, C], [A, B]]`: both branches are complete lists, so no
  `AWS::NoValue` list elements. Tests resolve both branches.
- `BootstraplessSynthesizer`: the template has no CDK bootstrap, SSM version parameter or asset dependency.
  Synthesis fails if an asset is introduced.
- Images are pinned `repository@sha256:digest` from an image manifest (`-c imageManifest=…`). The checked-in
  template uses `config/images.dev.json` fixtures. Release packaging refuses fixtures and placeholder digests.
- CloudFormation Rules reject 0.0.0.0/0 ingress, require an ingress source, require distinct subnets, and check that
  A and B belong to `VpcId`. The ALB itself rejects subnets that do not span two Availability Zones.
- `src/customer-app/lib/template-validation.ts` re-checks the raw template: no shared network resources, internal
  load balancers only, no public task IPs, no open ingress, no wildcard IAM, encrypted and retained logs and
  secrets, digest-pinned images, no embedded credentials, no CDK bootstrap dependency, and complete subnet lists.

## Seller release pipeline

```text
Source (GitHub via CodeConnections)
 → BuildAndTest            npm ci, typecheck, Jest, synth, template validation, npm audit, image tests,
                           build + push images to immutable staging ECR, ECR scan gate, release packaging
 → CleanAccountTests       assume the single test-account role; install 2- and 3-subnet stacks, upgrade from each
                           supported version, forced rollback, probes, run-tagged cleanup; approval summary
 → ReleaseApproval         manual approval (SNS), CustomData summary + link to approval-summary.md
 → MarketplaceSubmission   1) PublishImages: copy by digest staging → Marketplace ECR (digest must not change)
                           2) SubmitChangeSet: publish versioned template, StartChangeSet(AddDeliveryOptions)
 → MarketplaceProcessing   DescribeChangeSet with bounded backoff until a documented terminal status / timeout
 → PublicationVerification DescribeEntity proves version, delivery option and required visibility (fail closed)
 → AnnounceRelease         SNS release topic, once (S3 conditional-write marker)
```

Each stage hands a CodePipeline artifact to the next one. `ci/restore-artifact.sh` verifies the checksums
(`SHA256SUMS`) before any stage uses the release files. The pipeline runs in `QUEUED` mode, so a new commit never
supersedes a release in progress.

**Release manifest** (`marketplace/schemas/release-manifest.schema.json`): version, full commit SHA, build time,
per-image tag, digest, staging repository and Marketplace repository, SHA-256 of the release and test templates,
release notes path, and supported upgrade sources.

## Deviations from the specification (and why)

| Area | Deviation | Reason |
| --- | --- | --- |
| Application code | `app/` contains minimal reference images | The repository had no frontend, API or agent. The reference images implement the container contract and are meant to be replaced. |
| Pipeline | A `Source` stage precedes the seven specified stages | CodePipeline needs a source action. The seven stages follow in the exact specified order (tested). |
| Submission stage | Two actions: `PublishImages`, then `SubmitChangeSet` | Image-publishing and Catalog API permissions must be separate roles. Copying by digest means images are not rebuilt after testing. |
| Two templates | Test template (staging repos) and release template (Marketplace repos) | The test account cannot pull unreleased Marketplace images. Packaging proves the templates differ only in image repository names and that the digests are identical. |
| Alarms | Product-owned, KMS-encrypted SNS topic with an optional email parameter | A conditional `AlarmActions` was rejected by CDK validation. A topic also gives customers a notification path out of the box. |
| AZ check | No CloudFormation rule for distinct AZs | `Fn::ValueOf` inside `Fn::Equals` is rejected by cfn-lint. The ALB enforces two distinct AZs at create time. |
| Extra scripts | `ci/install-node.sh`, `ci/restore-artifact.sh`, `ci/publish-marketplace-images.sh`, `ci/smoke-local.sh`, `ci/local-release-rehearsal.sh`, `ci/apple-container.sh`, `buildspec/publish-images.yml` | Needed for Node 26 on CodeBuild, artifact hand-off, digest-preserving publication and local verification. |
| Marketplace request | Built from the documented `AddDeliveryOptions` / `EcrDeliveryOptionDetails` fields; listing-specific text in `config/marketplace-delivery-option.json` | The AWS documentation site was not reachable from the build environment. Confirm the shape against current docs and your product's `DescribeEntity` output before the first submission. |
