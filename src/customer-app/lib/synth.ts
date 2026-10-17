import { App, Stack } from 'aws-cdk-lib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomerAppStack } from './customer-app-stack';
import { ImageSet } from './images';

/** Synthesise a stack in-process (offline) and return its CloudFormation template. */
export function synthTemplate(build: (app: App) => Stack): Record<string, unknown> {
  const outdir = mkdtempSync(join(tmpdir(), 'synth-'));
  try {
    const app = new App({ outdir, analyticsReporting: false });
    const stack = build(app);
    return app.synth().getStackByName(stack.stackName).template as Record<string, unknown>;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

export function synthCustomerTemplate(images: ImageSet): Record<string, unknown> {
  return synthTemplate((app) => new CustomerAppStack(app, 'PrivateApp', { images, productVersion: images.version }));
}
