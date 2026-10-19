/**
 * Thin AWS SDK adapters for the release interfaces. Business logic lives in the pure modules; these only
 * translate calls. Credentials always come from the standard AWS credential chain of the running process
 * (CodeBuild role) or from an explicit STS AssumeRole for the test account; nothing is read from files.
 */
import {
  CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand, ListStackResourcesCommand, UpdateStackCommand,
  Parameter, Stack,
} from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, DeleteLogGroupCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CognitoIdentityProviderClient, DeleteUserPoolCommand, DescribeUserPoolCommand, UpdateUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DescribeNetworkInterfacesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeLoadBalancersCommand, ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { KMSClient, ScheduleKeyDeletionCommand } from '@aws-sdk/client-kms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DescribeChangeSetCommand, DescribeEntityCommand, ListChangeSetsCommand, MarketplaceCatalogClient, StartChangeSetCommand,
} from '@aws-sdk/client-marketplace-catalog';
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { MarkerStore, Publisher } from './announce';
import { CatalogApi, StartChangeSetRequest } from './marketplace';
import { CleanAccountOps, ParameterValue, StackResult } from './clean-account';

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function catalogApi(region: string): CatalogApi {
  const client = new MarketplaceCatalogClient({ region });
  const Catalog = 'AWSMarketplace';
  return {
    startChangeSet: (req: StartChangeSetRequest) => client.send(new StartChangeSetCommand({
      ...req,
      ChangeSet: req.ChangeSet.map((c) => ({ ...c, DetailsDocument: c.DetailsDocument as never })),
    })),
    async listChangeSets(entityId, changeSetName) {
      const out = [];
      let NextToken: string | undefined;
      do {
        const r = await client.send(new ListChangeSetsCommand({
          Catalog,
          FilterList: [{ Name: 'EntityId', ValueList: [entityId] }, { Name: 'ChangeSetName', ValueList: [changeSetName] }],
          NextToken,
        }));
        out.push(...(r.ChangeSetSummaryList ?? []));
        NextToken = r.NextToken;
      } while (NextToken);
      return out;
    },
    describeChangeSet: (ChangeSetId) => client.send(new DescribeChangeSetCommand({ Catalog, ChangeSetId })),
    describeEntity: (EntityId) => client.send(new DescribeEntityCommand({ Catalog, EntityId })),
  };
}

export function snsPublisher(region: string): Publisher {
  const client = new SNSClient({ region });
  return {
    publish: (TopicArn, Subject, Message, attributes) => client.send(new PublishCommand({
      TopicArn, Subject, Message,
      MessageAttributes: Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, { DataType: 'String', StringValue: v }])),
    })),
  };
}

/** Create-once markers using S3 conditional writes (If-None-Match: *). */
export function s3Markers(bucket: string, prefix: string, region: string): MarkerStore {
  const client = new S3Client({ region });
  const Key = (k: string) => `${prefix}${k}`;
  return {
    async claim(key, body) {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: Key(key), Body: body, IfNoneMatch: '*', ContentType: 'application/json' }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'PreconditionFailed' || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) return false;
        throw err;
      }
    },
    async update(key, body) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: Key(key), Body: body, ContentType: 'application/json' })); },
    async release(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: Key(key) })); },
  };
}

export interface ObjectStore {
  /** Write once; returns false if an object already exists (callers then compare contents). */
  putIfAbsent(key: string, body: string | Buffer, contentType: string): Promise<boolean>;
  /** Overwriting write, for regenerated (non-release) documents such as approval summaries. */
  put(key: string, body: string | Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  url(key: string): string;
}

export function s3Objects(bucket: string, region: string): ObjectStore {
  const client = new S3Client({ region });
  return {
    async putIfAbsent(key, body, contentType) {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfNoneMatch: '*', ContentType: contentType }));
        return true;
      } catch (err) {
        if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) return false;
        throw err;
      }
    },
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return await r.Body?.transformToString();
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return undefined;
        throw err;
      }
    },
    url: (key) => `https://${bucket}.s3.${region}.amazonaws.com/${key}`,
  };
}

export async function assumeRole(roleArn: string, sessionName: string, region: string): Promise<Credentials> {
  const r = await new STSClient({ region }).send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName.slice(0, 64), DurationSeconds: 3600 }));
  const c = r.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error(`AssumeRole ${roleArn} returned no credentials`);
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

const TERMINAL = /(_COMPLETE|_FAILED)$/;

export function awsCleanAccountOps(credentials: Credentials, region: string, runTagKey: string): CleanAccountOps {
  const cfg = { region, credentials };
  const cfn = new CloudFormationClient(cfg);
  const stack = async (StackName: string): Promise<Stack | undefined> => {
    try {
      return (await cfn.send(new DescribeStacksCommand({ StackName }))).Stacks?.[0];
    } catch (err) {
      if (/does not exist/.test(String((err as Error).message))) return undefined;
      throw err;
    }
  };
  const waitTerminal = async (name: string): Promise<string> => {
    for (let i = 0; i < 240; i++) {
      const s = await stack(name);
      const status = s?.StackStatus ?? 'DELETE_COMPLETE';
      if (TERMINAL.test(status) && !status.endsWith('_IN_PROGRESS')) return status;
      await sleep(15000);
    }
    return 'TIMED_OUT';
  };
  const result = async (name: string, status: string): Promise<StackResult> => {
    const s = await stack(name);
    const resources: Record<string, string> = {};
    let NextToken: string | undefined;
    do {
      const r = await cfn.send(new ListStackResourcesCommand({ StackName: name, NextToken }));
      for (const x of r.StackResourceSummaries ?? []) if (x.LogicalResourceId && x.PhysicalResourceId) resources[x.LogicalResourceId] = x.PhysicalResourceId;
      NextToken = r.NextToken;
    } while (NextToken);
    return { status, outputs: Object.fromEntries((s?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue ?? ''])), resources };
  };
  const params = (p: Record<string, ParameterValue>): Parameter[] => Object.entries(p).map(([ParameterKey, v]) =>
    (typeof v === 'string' ? { ParameterKey, ParameterValue: v } : { ParameterKey, UsePreviousValue: true }));

  return {
    async callerAccount() { return (await new STSClient(cfg).send(new GetCallerIdentityCommand({}))).Account ?? ''; },
    async deployStack({ name, templateUrl, parameters, tags }) {
      await cfn.send(new CreateStackCommand({
        StackName: name, TemplateURL: templateUrl, Parameters: params(parameters), Capabilities: ['CAPABILITY_IAM'],
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })), OnFailure: 'ROLLBACK',
      }));
      return result(name, await waitTerminal(name));
    },
    async updateStack({ name, templateUrl, parameters }) {
      await cfn.send(new UpdateStackCommand({ StackName: name, TemplateURL: templateUrl, Parameters: params(parameters), Capabilities: ['CAPABILITY_IAM'] }));
      return result(name, await waitTerminal(name));
    },
    async deleteStack(name) {
      await cfn.send(new DeleteStackCommand({ StackName: name }));
      return waitTerminal(name);
    },
    async stackTags(name) {
      const s = await stack(name);
      return s ? Object.fromEntries((s.Tags ?? []).map((t) => [t.Key!, t.Value ?? ''])) : undefined;
    },
    async loadBalancerScheme(arn) {
      return (await new ElasticLoadBalancingV2Client(cfg).send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [arn] }))).LoadBalancers?.[0]?.Scheme ?? 'unknown';
    },
    async taskNetworkInterfaces(groupId) {
      const r = await new EC2Client(cfg).send(new DescribeNetworkInterfacesCommand({ Filters: [{ Name: 'group-id', Values: [groupId] }] }));
      return (r.NetworkInterfaces ?? []).map((n) => ({ id: n.NetworkInterfaceId ?? '', publicIp: n.Association?.PublicIp }));
    },
    async missingLogGroups(names) {
      const logs = new CloudWatchLogsClient(cfg);
      const missing: string[] = [];
      for (const name of names) {
        const r = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
        if (!(r.logGroups ?? []).some((g) => g.logGroupName === name)) missing.push(name);
      }
      return missing;
    },
    async missingAlarms(names) {
      const r = await new CloudWatchClient(cfg).send(new DescribeAlarmsCommand({ AlarmNames: names }));
      const found = new Set((r.MetricAlarms ?? []).map((a) => a.AlarmName));
      return names.filter((n) => !found.has(n));
    },
    async probe(functionName, url, host) {
      const r = await new LambdaClient(cfg).send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify({ url, host })) }));
      return JSON.parse(Buffer.from(r.Payload ?? []).toString() || '{}') as { status: number; location?: string; body?: string };
    },
    async deleteRetainedResources(runId) {
      const tagging = new ResourceGroupsTaggingAPIClient(cfg);
      const deleted: string[] = [];
      let PaginationToken: string | undefined;
      do {
        const r = await tagging.send(new GetResourcesCommand({
          TagFilters: [{ Key: runTagKey, Values: [runId] }],
          ResourceTypeFilters: ['cognito-idp:userpool', 'logs:log-group', 'kms:key'],
          PaginationToken,
        }));
        for (const m of r.ResourceTagMappingList ?? []) {
          const arn = m.ResourceARN ?? '';
          // Double-check the tag on the returned resource before deleting anything.
          if (!(m.Tags ?? []).some((t) => t.Key === runTagKey && t.Value === runId)) continue;
          if (arn.includes(':userpool/')) {
            const cognito = new CognitoIdentityProviderClient(cfg);
            const UserPoolId = arn.split('/').pop()!;
            const pool = (await cognito.send(new DescribeUserPoolCommand({ UserPoolId }))).UserPool;
            if (pool?.DeletionProtection === 'ACTIVE') await cognito.send(new UpdateUserPoolCommand({ UserPoolId, DeletionProtection: 'INACTIVE', AutoVerifiedAttributes: pool.AutoVerifiedAttributes }));
            await cognito.send(new DeleteUserPoolCommand({ UserPoolId }));
          } else if (arn.includes(':log-group:')) {
            await new CloudWatchLogsClient(cfg).send(new DeleteLogGroupCommand({ logGroupName: arn.split(':log-group:')[1].replace(/:\*$/, '') }));
          } else if (arn.includes(':key/')) {
            await new KMSClient(cfg).send(new ScheduleKeyDeletionCommand({ KeyId: arn, PendingWindowInDays: 7 }));
          } else continue;
          deleted.push(arn);
        }
        PaginationToken = r.PaginationToken || undefined;
      } while (PaginationToken);
      return deleted;
    },
  };
}
