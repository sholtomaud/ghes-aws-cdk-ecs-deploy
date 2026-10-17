# Private AI assistant: AWS Marketplace product and controlled release pipeline

This repository contains:

- **Customer application stack** (`src/customer-app`): a CDK TypeScript app synthesised into the Marketplace
  CloudFormation template (`marketplace/template/customer-app.template.json`). It deploys one ECS Fargate service
  (frontend, Flask API and LangChain/Bedrock agent containers in one task) behind an **internal** ALB with Amazon
  Cognito sign-in, into the customer's existing VPC and two or three private subnets.
- **Seller release pipeline** (`src/seller-release`): a CDK app for the seller account. AWS CodePipeline runs
  build and tests → clean-account tests → manual approval → Marketplace submission → processing wait →
  publication verification → announcement.
- **Reference application** (`app/`): minimal frontend, API and agent images that implement the container
  contract. Replace them with the product's real components, keeping the same ports, health paths and
  interfaces (see [docs/architecture.md](docs/architecture.md)).

Nothing in this repository has been deployed to AWS or submitted to AWS Marketplace. The local checks prove the
code, templates and images. Cloud stages need real seller configuration and are documented as such.

## Quick start (no AWS credentials needed)

```bash
make install          # npm ci (Node.js 26)
make test             # Jest: CDK assertions, template policy, release logic (228 tests)
make synth            # synthesise both CDK apps offline (pipeline uses .env.example placeholders)
make validate         # validate the exported Marketplace template
make help             # every target
```

In the Node 26 tooling container (the same `Containerfile` for both runtimes):

```bash
make tooling-test-docker                     # Linux / CI
make tooling-test CONTAINER_RUNTIME=apple    # macOS with Apple's container CLI
```

Application images (needs Docker):

```bash
make app-test            # pytest / vitest inside each image's test stage
make app-images          # runtime images
make app-smoke           # run all three like a Fargate task (shared network namespace, fake LLM) and probe them
make release-rehearsal   # push to a throwaway local registry, package a release, verify digests and checksums
```

Behind a TLS-intercepting proxy, pass a CA bundle as a BuildKit secret: `make tooling-image-docker EXTRA_CA=/path/ca.pem`
(`EXTRA_CA=... ci/build-product-images.sh build` for app images). The CA is never written into an image layer.

## Layout

| Path | Purpose |
| --- | --- |
| `Containerfile`, `Makefile`, `package.json` | Node 26 tooling image, command interface, locked dependencies |
| `src/customer-app/` | customer stack, template export and policy validator, tests |
| `src/seller-release/` | pipeline stack, release manifest, Marketplace, clean-account and announcement logic, stage CLIs, tests |
| `src/tooling/test/` | tooling, CI and Apple container contract tests |
| `marketplace/template/` | generated, checked-in template (dev fixture images) + checksum |
| `marketplace/schemas/` | release manifest JSON schema, customer stack upgrade contract |
| `marketplace/release/` | generated per release (gitignored) |
| `config/` | fixture image set, Marketplace delivery option metadata |
| `ci/`, `buildspec/` | stage scripts and CodeBuild buildspecs |
| `app/` | reference frontend / api / agent images |
| `release-notes/` | one file per version (required by packaging) |
| `docs/` | architecture, installation, network contract, release process, security, upgrades, troubleshooting |

## Documentation

- [Architecture](docs/architecture.md), including deviations from the specification
- [Customer installation](docs/customer-installation.md)
- [Network contract](docs/network-contract.md)
- [Release process](docs/release-process.md)
- [Security and IAM](docs/security.md)
- [Upgrades and rollback](docs/upgrades-and-rollback.md)
- [Troubleshooting](docs/troubleshooting.md)
