#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { loadSellerConfig, ConfigError } from '../lib/config';
import { SellerReleasePipelineStack } from '../lib/pipeline-stack';

// Configuration comes only from the process environment; .env files are never loaded here.
let config;
try {
  config = loadSellerConfig(process.env);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : String(err));
  process.exit(1);
}
const app = new App({ analyticsReporting: false });
new SellerReleasePipelineStack(app, 'MarketplaceReleasePipeline', {
  config,
  env: { account: config.seller.account, region: config.seller.region },
  description: 'Controlled AWS Marketplace release pipeline (seller account)',
});
app.synth();
