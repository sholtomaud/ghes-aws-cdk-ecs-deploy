# Single command interface. Run `make help` for the list of targets.
#
# Container runtimes are never auto-detected or substituted: Docker and Apple `container`
# have their own targets. The generic tooling-* targets use CONTAINER_RUNTIME (default: docker);
# on macOS run e.g. `make tooling-test CONTAINER_RUNTIME=apple`.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

TOOLING_IMAGE ?= marketplace-tooling:local
CONTAINER_RUNTIME ?= docker
# Optional PEM bundle for corporate TLS-intercepting proxies, passed as a build secret (never baked in).
EXTRA_CA ?=
# Placeholder-only seller config used for offline pipeline synthesis. Real deployments read the environment.
EXAMPLE_ENV := .env.example
TEMPLATE := marketplace/template/customer-app.template.json

ifneq ($(filter-out docker apple,$(CONTAINER_RUNTIME)),)
$(error CONTAINER_RUNTIME must be 'docker' or 'apple', got '$(CONTAINER_RUNTIME)')
endif

.PHONY: help install build typecheck test test-coverage synth synth-customer synth-pipeline validate \
	template-check-reproducible app-test app-images app-smoke release-rehearsal release-package \
	tooling-image tooling-test tooling-synth tooling-validate \
	tooling-image-docker tooling-test-docker tooling-synth-docker tooling-validate-docker \
	tooling-image-apple tooling-test-apple tooling-synth-apple tooling-validate-apple \
	pipeline-deploy clean

help: ## Show targets
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-30s %s\n", $$1, $$2}'

install: ## Install locked dependencies (npm ci)
	npm ci

build: ## Compile TypeScript to dist/
	npm run build

typecheck: ## TypeScript type check
	npm run typecheck

test: ## Run Jest unit, CDK assertion and template tests
	npm test

test-coverage: ## Run Jest with coverage thresholds
	npm run test:coverage

synth: synth-customer synth-pipeline ## Synthesise both CDK apps offline (no AWS credentials)

synth-customer: ## Synthesise the customer stack and export the Marketplace template
	npm run cdk:synth:customer

synth-pipeline: ## Synthesise the seller pipeline using placeholder config from .env.example
	set -a; source $(EXAMPLE_ENV); set +a; npm run cdk:synth:pipeline

validate: ## Validate the exported Marketplace template (policy + structure)
	npm run template:validate

template-check-reproducible: synth-customer ## Fail if the checked-in template differs from a fresh synth
	git diff --exit-code -- $(TEMPLATE) $(TEMPLATE).sha256 || { echo "Template is not reproducible or not committed. Run 'make synth-customer' and commit." >&2; exit 1; }

app-test: ## Run application unit tests inside the images' test stages (pytest, vitest; needs Docker)
	ci/build-product-images.sh test

app-images: ## Build the three application images with Docker
	ci/build-product-images.sh build

app-smoke: ## Run the three containers in one shared network namespace (like a Fargate task) and smoke test
	ci/smoke-local.sh

release-rehearsal: ## Local release dry run: push to a throwaway registry, package, verify digests (no AWS)
	ci/local-release-rehearsal.sh

release-package: ## Package release metadata (needs marketplace/release/images.json from a real image push)
	npm run release:package

# --- tooling image: generic (dispatches on CONTAINER_RUNTIME) ---------------------------------
tooling-image: tooling-image-$(CONTAINER_RUNTIME) ## Build the tooling image with CONTAINER_RUNTIME
tooling-test: tooling-test-$(CONTAINER_RUNTIME) ## Typecheck + Jest inside the tooling image
tooling-synth: tooling-synth-$(CONTAINER_RUNTIME) ## Synthesise both apps inside the tooling image
tooling-validate: tooling-validate-$(CONTAINER_RUNTIME) ## Synth + validate the template inside the tooling image

# --- Docker ----------------------------------------------------------------------------------
tooling-image-docker: ## Build the tooling image with Docker BuildKit
	DOCKER_BUILDKIT=1 docker build --file Containerfile --tag $(TOOLING_IMAGE) \
		$(if $(EXTRA_CA),--secret id=extra_ca$(comma)src=$(EXTRA_CA)) .

tooling-test-docker: tooling-image-docker ## Run typecheck and Jest in the tooling image (Docker)
	docker run --rm $(TOOLING_IMAGE) sh -c 'node --version && npm --version && npx --no-install cdk --version && npm run typecheck && npm test'

tooling-synth-docker: tooling-image-docker ## Run both CDK syntheses in the tooling image (Docker)
	docker run --rm $(TOOLING_IMAGE) sh -c 'npm run cdk:synth:customer && set -a && . ./$(EXAMPLE_ENV) && set +a && npm run cdk:synth:pipeline'

tooling-validate-docker: tooling-image-docker ## Synthesise and validate the template in the tooling image (Docker)
	docker run --rm $(TOOLING_IMAGE) sh -c 'npm run cdk:synth:customer && npm run template:validate'

# --- Apple container CLI (macOS) ---------------------------------------------------------------
tooling-image-apple: ## Build the tooling image with Apple's container CLI
	ci/apple-container.sh build $(TOOLING_IMAGE)

tooling-test-apple: tooling-image-apple ## Run typecheck and Jest in the tooling image (Apple container)
	ci/apple-container.sh run $(TOOLING_IMAGE) sh -c 'node --version && npx --no-install cdk --version && npm run typecheck && npm test'

tooling-synth-apple: tooling-image-apple ## Run both CDK syntheses in the tooling image (Apple container)
	ci/apple-container.sh run $(TOOLING_IMAGE) sh -c 'npm run cdk:synth:customer && set -a && . ./$(EXAMPLE_ENV) && set +a && npm run cdk:synth:pipeline'

tooling-validate-apple: tooling-image-apple ## Synthesise and validate the template in the tooling image (Apple container)
	ci/apple-container.sh run $(TOOLING_IMAGE) sh -c 'npm run cdk:synth:customer && npm run template:validate'

# --- Seller-side deployment (explicit; requires real seller configuration in the environment) --
pipeline-deploy: ## Deploy the seller release pipeline (reads config from the environment, never .env)
	npm run build
	npx --no-install cdk deploy --app 'node dist/seller-release/bin/seller-release.js' --require-approval broadening

clean: ## Remove generated build output (known generated directories only)
	rm -rf dist cdk.out coverage reports
	find marketplace/release -mindepth 1 ! -name .gitkeep -delete

comma := ,
