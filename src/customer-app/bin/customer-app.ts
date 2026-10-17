#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { resolve } from 'node:path';
import { CustomerAppStack } from '../lib/customer-app-stack';
import { loadImageSet } from '../lib/images';

// Offline, deterministic synthesis: no env/account lookups. The image manifest selects the release images;
// the default is the checked-in fixture used for tests and the reproducibility check.
const app = new App({ analyticsReporting: false });
const manifestPath = resolve(String(app.node.tryGetContext('imageManifest') ?? 'config/images.dev.json'));
const images = loadImageSet(manifestPath);

new CustomerAppStack(app, 'PrivateApp', { images, productVersion: images.version });
app.synth();
