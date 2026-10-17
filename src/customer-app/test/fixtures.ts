import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CustomerAppStack } from '../lib/customer-app-stack';
import { loadImageSet } from '../lib/images';
import { join } from 'node:path';

export const devImages = loadImageSet(join(__dirname, '..', '..', '..', 'config', 'images.dev.json'));

export function synthCustomerStack(): { stack: CustomerAppStack; template: Template; json: CfnTemplate } {
  const app = new App({ analyticsReporting: false });
  const stack = new CustomerAppStack(app, 'PrivateApp', { images: devImages, productVersion: devImages.version });
  const template = Template.fromStack(stack);
  return { stack, template, json: template.toJSON() as CfnTemplate };
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
}

export interface CfnTemplate {
  Parameters?: Record<string, { Type: string; Default?: unknown; AllowedPattern?: string; AllowedValues?: unknown[] }>;
  Conditions?: Record<string, unknown>;
  Rules?: Record<string, unknown>;
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, { Value: unknown }>;
  Metadata?: Record<string, unknown>;
}

export function resourcesOfType(t: CfnTemplate, type: string): Array<[string, CfnResource]> {
  return Object.entries(t.Resources).filter(([, r]) => r.Type === type);
}

export function onlyResource(t: CfnTemplate, type: string): [string, CfnResource] {
  const found = resourcesOfType(t, type);
  if (found.length !== 1) throw new Error(`expected exactly one ${type}, found ${found.length}`);
  return found[0];
}
