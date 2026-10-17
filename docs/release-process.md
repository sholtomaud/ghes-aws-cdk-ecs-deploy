# Release process (seller)

GitHub Actions (`.github/workflows/ci.yml`) is fast feedback only. It has read-only repository permissions, no AWS
credentials and no Marketplace access. **The seller CodePipeline is the only release path**, and it cannot submit
without a human approval.

## One-time setup

1. Configure the seller environment from `.env.example` in your deployment shell or CI secret store (the values are
   not secrets). `.env` files are never loaded automatically; `make synth-pipeline` uses `.env.example` only for
   offline synthesis.
   - `CODECONNECTIONS_ARN`: an authorised GitHub connection in the seller account.
   - `TEST_ACCOUNT_ID`, `TEST_DEPLOY_ROLE_ARN`: a dedicated test account and one role there (see
     [security.md](security.md#test-account-role)).
   - `MARKETPLACE_*`: the existing ContainerProduct ID, Marketplace ECR repositories, delivery option title, the
     visibility the release policy requires, and the maximum wait.
   - `TEMPLATE_PUBLISH_BUCKET` / `TEMPLATE_PUBLIC_BASE_URL`: a seller bucket serving the versioned templates buyers
     download (public read on `releases/*` only, or the delivery mechanism your listing requires).
   - `RELEASE_TOPIC_ARN`: the announcement topic. `APPROVER_EMAILS`: approval notifications.
2. Align `config/marketplace-delivery-option.json` with your listing. Before the first submission, check the
   `AddDeliveryOptions` request shape against the current AWS Marketplace Catalog API documentation for container
   products, and against `DescribeEntity` output for your product.
3. `make pipeline-deploy` with seller admin credentials (CDK-bootstrapped seller account). Configuration is
   validated first, and errors name the missing variables without printing values.

## Cutting a release

1. Bump `version` in `package.json` (semantic versioning). Add `release-notes/<version>.md` with non-empty
   `## Upgrade` and `## Breaking changes` sections.
2. Set `SUPPORTED_UPGRADE_FROM` (pipeline environment) to the versions customers may upgrade from.
3. Merge to the release branch. The pipeline then runs:

| Stage | Fails closed when | Output |
| --- | --- | --- |
| BuildAndTest | any test, scan (high/critical or incomplete), template check or packaging error; the template is not reproducible | `release-manifest.json`, templates, `SHA256SUMS`, reports |
| CleanAccountTests | wrong account, any install, upgrade or rollback check fails, cleanup fails | `reports/clean-account.json`, `approval-summary.md` |
| ReleaseApproval | the approver rejects (ends the execution) | — |
| MarketplaceSubmission | a digest changes during copy, the template already exists with different content, the version already exists, API error | `submission.json`, redacted request |
| MarketplaceProcessing | `FAILED` / `CANCELLED`, undocumented status, repeated API errors, timeout | `processing.json` (with Marketplace error details) |
| PublicationVerification | version, delivery option or required visibility not proven | `verification.json` |
| AnnounceRelease | SNS error (retry is safe: an S3 marker prevents duplicate announcements) | `announcement.json` |

The approver sees the version, commit, test results, scan summary, CloudFormation change summary against the
previous release, image tags and digests, release notes, product ID and delivery option. A short summary appears in
the approval action, with a link to the full `approval-summary.md`.

## Re-runs and idempotency

- **Submission** looks for an existing change set named `release-<version>`. If it is in progress or succeeded, the
  stage reuses it instead of submitting again. A version that already exists on the product is refused. After a
  failed change set, a retry uses a new deterministic `ClientRequestToken`.
- **Processing timeout:** retry the *MarketplaceProcessing* stage. It resumes polling the same change set from
  `submission.json` and never resubmits.
- **Image publication** skips images already present with the same digest, and fails if a tag exists with a
  different digest.

## Manual verification gate

If `DescribeEntity` does not expose delivery-option visibility, verification ends `INCONCLUSIVE` and the pipeline
stops. A seller operator then confirms the state in the AMMP seller portal and writes an attestation:

```json
// s3://<ARTIFACT_BUCKET>/releases/<version>/manual-verification.json
{ "productId": "prod-…", "version": "1.2.3", "observedVisibility": "Public",
  "verifiedBy": "name@example.com", "evidence": "ticket / screenshot reference", "verifiedAt": "2026-10-17T12:00:00Z" }
```

Then retry *PublicationVerification*. An attestation is accepted only when the API is inconclusive and the
attestation matches the product, version and required visibility. It never overrides a state the API contradicts.
Writing to this key should be limited to release managers.

## Local rehearsal

`make release-rehearsal` runs the packaging path without AWS: it pushes to a local registry, cross-checks digests,
packages the release and verifies checksums. It is not a release.

## Retention

The release artifacts bucket is versioned and retained, with non-current versions expiring after 365 days.
CodeBuild logs are kept for 365 days. Staging ECR repositories are immutable and keep 200 images.
