# syntax=docker/dockerfile:1.7
#
# Development and CDK tooling image (NOT a production application image).
# Builds identically with Docker BuildKit (GitHub Actions) and Apple's `container` CLI (macOS).
# Contains no credentials. Unit tests, type checks, synthesis and template validation run offline.

FROM node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913 AS deps

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /workspace
RUN chown node:node /workspace
USER node

COPY --chown=node:node package.json package-lock.json ./
# An optional corporate/proxy CA can be supplied as a BuildKit secret (`--secret id=extra_ca,src=ca.pem`).
# It is used only for this step and never written to an image layer.
RUN --mount=type=secret,id=extra_ca,required=false,uid=1000 \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci && npm cache clean --force

FROM node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913 AS tooling

LABEL org.opencontainers.image.title="marketplace-tooling" \
      org.opencontainers.image.description="Node.js 26 tooling for CDK synth, Jest, type checks and release scripts"

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CDK_DISABLE_VERSION_CHECK=true \
    CDK_DISABLE_CLI_TELEMETRY=true \
    CI=true

WORKDIR /workspace
RUN chown node:node /workspace
USER node

COPY --from=deps --chown=node:node /workspace/node_modules ./node_modules
COPY --chown=node:node . .

CMD ["npm", "test"]
