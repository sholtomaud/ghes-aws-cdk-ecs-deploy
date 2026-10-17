# Troubleshooting

## Customer stack

| Symptom | Likely cause | Check / fix |
| --- | --- | --- |
| Stack creation fails on a Rule | invalid network inputs | The rule message names the problem: missing ingress source, 0.0.0.0/0, duplicate subnets, or subnets outside `VpcId`. |
| ALB creation fails: "subnets must be in different AZs" | A and B share an AZ | Choose subnets in distinct AZs. |
| Service never stabilises; tasks stop with `CannotPullContainerError` | no route to ECR/S3, or no Marketplace subscription | Check the ECR API/Docker endpoints, the S3 gateway endpoint or NAT, and the subscription. Task stop reason: ECS → cluster → tasks → stopped. |
| Tasks stop: `ResourceInitializationError ... secretsmanager` | no route to Secrets Manager | Add a `secretsmanager` endpoint or egress. |
| Tasks start, then the service rolls back (circuit breaker) | a container health check fails | ECS service events. Logs: `/<stack>/agent`, `/<stack>/api`, `/<stack>/frontend`. |
| Browser shows 500 after Cognito sign-in | the ALB cannot reach the Cognito token endpoint | The ALB subnets need egress to `*.amazoncognito.com` and `cognito-idp.<region>.amazonaws.com` (see the [network contract](network-contract.md)). |
| `redirect_mismatch` at Cognito | the URL used differs from `AppHostname` | Browse to exactly `https://<AppHostname>/`; the DNS record must match. |
| Chat returns 502 "temporarily unavailable" | agent cannot call Bedrock | Agent log `invoke_failed` with `error_type`. Check model access for `BedrockModelId`, the `bedrock-runtime` endpoint or egress, and IAM (inference profiles need the profile ID as `BedrockModelId`). |
| Alarm `<stack>-no-healthy-targets` | all tasks unhealthy | ECS service events, then container logs. |
| Alarm `<stack>-target-5xx` | application errors | API and agent logs (structured JSON: `event`, `status`, `error_type`). |
| `<stack>-cpu-high` / `-memory-high` | sustained load | Raise `DesiredCount` with a stack update (existing values for everything else). |

Useful queries (CloudWatch Logs Insights on `/<stack>/api`):

```
fields @timestamp, path, status, duration_ms | filter event = "request" and status >= 500 | sort @timestamp desc
```

## Seller pipeline

| Stage | Symptom | Action |
| --- | --- | --- |
| BuildAndTest | "template is not reproducible" | Run `make synth-customer` locally and commit `marketplace/template/`. |
| BuildAndTest | security gate failed | `reports/security-summary.json` lists the source; update the base image or dependency. |
| BuildAndTest | "refusing to package fixture images" | `images.json` must come from `ci/build-product-images.sh push`. |
| CleanAccountTests | `preflight-account` failed | The assumed role is in the wrong account; check `TEST_DEPLOY_ROLE_ARN`. |
| CleanAccountTests | install or upgrade case failed | `reports/clean-account.json` names the case and assertion. Test stacks are `mkt-ct-<run>-*` in the test account; failed stacks are deleted by cleanup, so CloudFormation events remain viewable under deleted stacks. |
| CleanAccountTests | cleanup "not tagged with this run" | A name collision with a stack the harness did not create: it was left untouched. Investigate by hand. |
| MarketplaceSubmission | "already exists with different content" / "version already exists" | Released versions are immutable: bump the version. |
| MarketplaceProcessing | `FAILED` | `processing.json` → `errors[]` holds Marketplace `ErrorCode` / `ErrorMessage`. Fix the cause and re-run the pipeline for the same version (nothing was released); the new attempt uses a new idempotency token. |
| MarketplaceProcessing | `TIMED_OUT` | Retry the stage (it resumes polling; it never resubmits). |
| PublicationVerification | `INCONCLUSIVE` | Follow the manual verification gate in [release-process.md](release-process.md#manual-verification-gate). |
| AnnounceRelease | SNS failure | Retry the stage. A completed announcement is never sent twice. |

## Local tooling

| Symptom | Fix |
| --- | --- |
| `npm ci` TLS errors in a container | Pass your proxy CA: `make tooling-image-docker EXTRA_CA=/path/ca.pem` (BuildKit secret, not baked in). |
| `make tooling-test CONTAINER_RUNTIME=apple` says the CLI was not found | Install Apple's `container` from its GitHub releases (macOS 26+, Apple silicon), then `container system start`. There is no Docker fallback. |
| Apple `container build` cannot use `EXTRA_CA` | Not supported by the wrapper. Use an environment without TLS interception, or the Docker targets. |
| Engine warning: Node version | The tooling requires Node 26 (`engines`); use the tooling image. |
