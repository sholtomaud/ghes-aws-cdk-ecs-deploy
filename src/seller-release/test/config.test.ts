import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSellerConfig, ConfigError, parseEnvFile } from '../lib/config';

const example = parseEnvFile(readFileSync(join(__dirname, '..', '..', '..', '.env.example'), 'utf8'));

describe('seller release configuration', () => {
  test('.env.example is complete and valid', () => {
    const cfg = loadSellerConfig(example);
    expect(cfg.marketplace.productId).toBe('prod-exampleexample1');
    expect(cfg.marketplace.repositories.agent).toMatch(/private-app-agent$/);
    expect(cfg.marketplace.requiredVisibility).toBe('Public');
    expect(cfg.marketplace.waitMaxMinutes).toBe(240);
    expect(cfg.supportedUpgradeFrom).toEqual([]);
    expect(cfg.approverEmails).toEqual(['release-approver@example.com']);
  });

  test('names every missing variable without printing values', () => {
    const env = { ...example, GITHUB_OWNER: '', MARKETPLACE_PRODUCT_ID: undefined };
    try {
      loadSellerConfig(env);
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain('GITHUB_OWNER');
      expect(msg).toContain('MARKETPLACE_PRODUCT_ID');
      expect(msg).not.toContain('arn:aws');
    }
  });

  test.each([
    ['SELLER_ACCOUNT_ID', '12345'],
    ['TEST_DEPLOY_ROLE_ARN', 'arn:aws:iam::999999999999:role/other-account'],
    ['TEST_ACCOUNT_ID', '111122223333'],
    ['MARKETPLACE_PRODUCT_ID', 'product-1'],
    ['MARKETPLACE_REQUIRED_VISIBILITY', 'Everyone'],
    ['MARKETPLACE_ECR_REPOSITORIES', 'frontend=a/b,api=a/c'],
    ['MARKETPLACE_ECR_REPOSITORIES', 'frontend=x.dkr.ecr.us-east-1.amazonaws.com/s/f:latest,api=x/a,agent=x/b'],
    ['TEMPLATE_PUBLIC_BASE_URL', 'http://insecure.example.com'],
    ['SUPPORTED_UPGRADE_FROM', '1.0,2.0.0'],
    ['RELEASE_TOPIC_ARN', 'arn:aws:sns:us-east-1:999999999999:other-account-topic'],
    ['MARKETPLACE_WAIT_MAX_MINUTES', '0'],
    ['MARKETPLACE_WAIT_MAX_MINUTES', '481'],
    ['MARKETPLACE_LISTING_URL', 'http://aws.amazon.com/marketplace/pp/x'],
  ])('rejects invalid %s=%s with the variable name', (name, value) => {
    expect(() => loadSellerConfig({ ...example, [name]: value })).toThrow(new RegExp(name));
  });

  test('the test account must differ from the seller account', () => {
    expect(() => loadSellerConfig({ ...example, TEST_ACCOUNT_ID: example.SELLER_ACCOUNT_ID, TEST_DEPLOY_ROLE_ARN: `arn:aws:iam::${example.SELLER_ACCOUNT_ID}:role/x` }))
      .toThrow(/TEST_ACCOUNT_ID/);
  });

  test('parses upgrade versions and env files with comments and quotes', () => {
    const cfg = loadSellerConfig({ ...example, SUPPORTED_UPGRADE_FROM: '1.0.0, 1.1.0' });
    expect(cfg.supportedUpgradeFrom).toEqual(['1.0.0', '1.1.0']);
    expect(parseEnvFile('# c\nA=1\nB="two words"\n\nC=\'x\'\n')).toEqual({ A: '1', B: 'two words', C: 'x' });
  });
});
