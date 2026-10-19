import { COMPONENTS, Component, SEMVER } from '../../customer-app/lib/images';

export type Visibility = 'Public' | 'Limited' | 'Restricted';

export interface SellerConfig {
  github: { owner: string; repo: string; branch: string; connectionArn: string };
  seller: { account: string; region: string };
  test: { account: string; region: string; roleArn: string; certificateArn: string; appDomain: string; bedrockModelId: string };
  marketplace: {
    productId: string;
    catalogRegion: string;
    deliveryOptionTitle: string;
    repositories: Record<Component, string>;
    requiredVisibility: Visibility;
    waitMaxMinutes: number;
  };
  templates: { bucket: string; publicBaseUrl: string };
  releaseTopicArn: string;
  approverEmails: string[];
  supportedUpgradeFrom: string[];
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid seller release configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const MARKETPLACE_REPO = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9._/-]+$/;

/** Each rule: variable name, human-readable format (printed instead of the value), validator. */
const RULES: Array<[string, string, (v: string) => boolean]> = [
  ['GITHUB_OWNER', 'GitHub owner name', (v) => /^[A-Za-z0-9-]{1,39}$/.test(v)],
  ['GITHUB_REPO', 'GitHub repository name', (v) => /^[A-Za-z0-9._-]{1,100}$/.test(v)],
  ['GITHUB_BRANCH', 'branch name', (v) => /^[A-Za-z0-9._/-]{1,255}$/.test(v)],
  ['CODECONNECTIONS_ARN', 'arn:aws:codeconnections|codestar-connections:<region>:<account>:connection/<uuid>', (v) =>
    /^arn:aws[a-z-]*:(codeconnections|codestar-connections):[a-z0-9-]+:\d{12}:connection\/[0-9a-f-]{36}$/.test(v)],
  ['SELLER_ACCOUNT_ID', '12-digit account ID', (v) => ACCOUNT.test(v)],
  ['SELLER_REGION', 'AWS region', (v) => REGION.test(v)],
  ['TEST_ACCOUNT_ID', '12-digit account ID, different from SELLER_ACCOUNT_ID', (v) => ACCOUNT.test(v)],
  ['TEST_DEPLOY_ROLE_ARN', 'IAM role ARN in TEST_ACCOUNT_ID', (v) => /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(v)],
  ['TEST_REGION', 'AWS region', (v) => REGION.test(v)],
  ['TEST_CERTIFICATE_ARN', 'ACM certificate ARN in TEST_ACCOUNT_ID', (v) => /^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]{36}$/.test(v)],
  ['TEST_APP_DOMAIN', 'DNS domain for test hostnames', (v) => /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(v)],
  ['TEST_BEDROCK_MODEL_ID', 'Bedrock model or inference profile ID', (v) => /^[a-z0-9-]+(\.[a-z0-9.-]+)+(:\d+)?$/.test(v)],
  ['MARKETPLACE_PRODUCT_ID', 'prod-<id>', (v) => /^prod-[a-z0-9]{8,20}$/.test(v)],
  ['MARKETPLACE_CATALOG_REGION', 'AWS region (the Catalog API is served from us-east-1)', (v) => REGION.test(v)],
  ['MARKETPLACE_DELIVERY_OPTION_TITLE', 'delivery option title, 1-200 characters', (v) => v.length > 0 && v.length <= 200],
  ['MARKETPLACE_ECR_REPOSITORIES', 'frontend=<repo>,api=<repo>,agent=<repo> (Marketplace ECR repositories, no tag)', (v) => parseRepositories(v) !== undefined],
  ['MARKETPLACE_REQUIRED_VISIBILITY', 'Public, Limited or Restricted', (v) => ['Public', 'Limited', 'Restricted'].includes(v)],
  ['MARKETPLACE_WAIT_MAX_MINUTES', 'integer minutes 1-480 (CodeBuild limit)', (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 480],
  ['TEMPLATE_PUBLISH_BUCKET', 'S3 bucket name', (v) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v)],
  ['TEMPLATE_PUBLIC_BASE_URL', 'https:// URL without trailing slash', (v) => /^https:\/\/[^\s]+[^/]$/.test(v)],
  ['RELEASE_TOPIC_ARN', 'SNS topic ARN in SELLER_ACCOUNT_ID', (v) => /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[\w-]+$/.test(v)],
];

const OPTIONAL: Array<[string, string, (v: string) => boolean]> = [
  ['APPROVER_EMAILS', 'comma-separated email addresses', (v) => v.split(',').every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim()))],
  ['SUPPORTED_UPGRADE_FROM', 'comma-separated semantic versions (x.y.z)', (v) => v.split(',').every((s) => SEMVER.test(s.trim()))],
  ['MARKETPLACE_LISTING_URL', 'https:// URL of the public listing', (v) => /^https:\/\/\S+$/.test(v)],
];

function parseRepositories(v: string): Record<Component, string> | undefined {
  const entries = v.split(',').map((kv) => kv.trim().split('='));
  if (entries.some((e) => e.length !== 2)) return undefined;
  const map = Object.fromEntries(entries) as Record<string, string>;
  if (Object.keys(map).length !== COMPONENTS.length) return undefined;
  for (const c of COMPONENTS) if (!map[c] || !MARKETPLACE_REPO.test(map[c])) return undefined;
  return map as Record<Component, string>;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const accountOf = (arn: string) => arn.split(':')[4];

/** Validate and load the seller configuration. Errors name variables and expected formats, never values. */
export function loadSellerConfig(env: Env): SellerConfig {
  const problems: string[] = [];
  const get = (name: string) => (env[name] ?? '').trim();
  for (const [name, format, ok] of RULES) {
    const v = get(name);
    if (!v) problems.push(`${name} is required (${format})`);
    else if (!ok(v)) problems.push(`${name} is invalid (expected ${format})`);
  }
  for (const [name, format, ok] of OPTIONAL) {
    const v = get(name);
    if (v && !ok(v)) problems.push(`${name} is invalid (expected ${format})`);
  }
  if (problems.length === 0) {
    if (get('TEST_ACCOUNT_ID') === get('SELLER_ACCOUNT_ID')) problems.push('TEST_ACCOUNT_ID must be a dedicated account, not SELLER_ACCOUNT_ID');
    if (accountOf(get('TEST_DEPLOY_ROLE_ARN')) !== get('TEST_ACCOUNT_ID')) problems.push('TEST_DEPLOY_ROLE_ARN must be a role in TEST_ACCOUNT_ID');
    if (accountOf(get('TEST_CERTIFICATE_ARN')) !== get('TEST_ACCOUNT_ID')) problems.push('TEST_CERTIFICATE_ARN must be in TEST_ACCOUNT_ID');
    if (accountOf(get('RELEASE_TOPIC_ARN')) !== get('SELLER_ACCOUNT_ID')) problems.push('RELEASE_TOPIC_ARN must be in SELLER_ACCOUNT_ID');
    if (accountOf(get('CODECONNECTIONS_ARN')) !== get('SELLER_ACCOUNT_ID')) problems.push('CODECONNECTIONS_ARN must be in SELLER_ACCOUNT_ID');
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    github: { owner: get('GITHUB_OWNER'), repo: get('GITHUB_REPO'), branch: get('GITHUB_BRANCH'), connectionArn: get('CODECONNECTIONS_ARN') },
    seller: { account: get('SELLER_ACCOUNT_ID'), region: get('SELLER_REGION') },
    test: {
      account: get('TEST_ACCOUNT_ID'),
      region: get('TEST_REGION'),
      roleArn: get('TEST_DEPLOY_ROLE_ARN'),
      certificateArn: get('TEST_CERTIFICATE_ARN'),
      appDomain: get('TEST_APP_DOMAIN'),
      bedrockModelId: get('TEST_BEDROCK_MODEL_ID'),
    },
    marketplace: {
      productId: get('MARKETPLACE_PRODUCT_ID'),
      catalogRegion: get('MARKETPLACE_CATALOG_REGION'),
      deliveryOptionTitle: get('MARKETPLACE_DELIVERY_OPTION_TITLE'),
      repositories: parseRepositories(get('MARKETPLACE_ECR_REPOSITORIES'))!,
      requiredVisibility: get('MARKETPLACE_REQUIRED_VISIBILITY') as Visibility,
      waitMaxMinutes: Number(get('MARKETPLACE_WAIT_MAX_MINUTES')),
    },
    templates: { bucket: get('TEMPLATE_PUBLISH_BUCKET'), publicBaseUrl: get('TEMPLATE_PUBLIC_BASE_URL') },
    releaseTopicArn: get('RELEASE_TOPIC_ARN'),
    approverEmails: list(env.APPROVER_EMAILS),
    supportedUpgradeFrom: list(env.SUPPORTED_UPGRADE_FROM),
  };
}

/** Minimal KEY=VALUE parser for the example file and tests. Never used to load production configuration. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
