import { S3Client } from '@aws-sdk/client-s3';
import { MarketplaceCatalogClient } from '@aws-sdk/client-marketplace-catalog';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { KMSClient } from '@aws-sdk/client-kms';
import { catalogApi, s3Markers, awsCleanAccountOps } from '../lib/aws';

const creds = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'x' };
const name = (cmd: unknown) => (cmd as { constructor: { name: string } }).constructor.name;
const input = (cmd: unknown) => (cmd as { input: any }).input;

afterEach(() => jest.restoreAllMocks());

test('S3 markers: claim uses If-None-Match and reports an existing marker as already claimed', async () => {
  const send = jest.spyOn(S3Client.prototype, 'send')
    .mockImplementationOnce(async () => ({}))
    .mockImplementationOnce(async () => { throw Object.assign(new Error('pre'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }); });
  const m = s3Markers('bucket', 'releases/', 'us-east-1');
  expect(await m.claim('a.json', '{}')).toBe(true);
  expect(await m.claim('a.json', '{}')).toBe(false);
  expect(input(send.mock.calls[0][0])).toMatchObject({ Bucket: 'bucket', Key: 'releases/a.json', IfNoneMatch: '*' });
});

test('S3 markers: other errors propagate', async () => {
  jest.spyOn(S3Client.prototype, 'send').mockImplementation(async () => { throw new Error('AccessDenied'); });
  await expect(s3Markers('b', '', 'us-east-1').claim('k', '{}')).rejects.toThrow(/AccessDenied/);
});

test('catalog: listChangeSets filters by entity and name and follows pagination', async () => {
  const send = jest.spyOn(MarketplaceCatalogClient.prototype, 'send')
    .mockImplementationOnce(async () => ({ ChangeSetSummaryList: [{ ChangeSetId: '1' }], NextToken: 't' }))
    .mockImplementationOnce(async () => ({ ChangeSetSummaryList: [{ ChangeSetId: '2' }] }));
  const r = await catalogApi('us-east-1').listChangeSets('prod-abc', 'release-1.2.3');
  expect(r.map((x) => x.ChangeSetId)).toEqual(['1', '2']);
  expect(input(send.mock.calls[0][0]).FilterList).toEqual([{ Name: 'EntityId', ValueList: ['prod-abc'] }, { Name: 'ChangeSetName', ValueList: ['release-1.2.3'] }]);
  expect(input(send.mock.calls[1][0]).NextToken).toBe('t');
});

test('clean-account ops: upgrades keep previous values and pass CAPABILITY_IAM', async () => {
  const send = jest.spyOn(CloudFormationClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    if (name(cmd) === 'DescribeStacksCommand') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [{ OutputKey: 'A', OutputValue: 'b' }] }] };
    if (name(cmd) === 'ListStackResourcesCommand') return { StackResourceSummaries: [{ LogicalResourceId: 'LoadBalancer', PhysicalResourceId: 'arn:lb' }] };
    return {};
  });
  const ops = awsCleanAccountOps(creds, 'us-east-1', 'run');
  const r = await ops.updateStack({ name: 's', templateUrl: 'https://t', parameters: { VpcId: { usePrevious: true }, CertificateArn: 'arn:new' } });
  expect(r).toEqual({ status: 'UPDATE_COMPLETE', outputs: { A: 'b' }, resources: { LoadBalancer: 'arn:lb' } });
  const update = input(send.mock.calls.find(([c]) => name(c) === 'UpdateStackCommand')![0]);
  expect(update.Parameters).toEqual([{ ParameterKey: 'VpcId', UsePreviousValue: true }, { ParameterKey: 'CertificateArn', ParameterValue: 'arn:new' }]);
  expect(update.Capabilities).toEqual(['CAPABILITY_IAM']);
});

test('clean-account ops: retained-resource cleanup deletes only resources carrying the run tag', async () => {
  jest.spyOn(ResourceGroupsTaggingAPIClient.prototype, 'send').mockImplementation(async () => ({
    ResourceTagMappingList: [
      { ResourceARN: 'arn:aws:logs:us-east-1:4:log-group:/mkt-ct-r1-two/api', Tags: [{ Key: 'run', Value: 'r1' }] },
      { ResourceARN: 'arn:aws:logs:us-east-1:4:log-group:/someone/else', Tags: [{ Key: 'run', Value: 'other' }] },
      { ResourceARN: 'arn:aws:kms:us-east-1:4:key/abc', Tags: [{ Key: 'run', Value: 'r1' }] },
    ],
  }));
  const logs = jest.spyOn(CloudWatchLogsClient.prototype, 'send').mockImplementation(async () => ({}));
  const kms = jest.spyOn(KMSClient.prototype, 'send').mockImplementation(async () => ({}));
  const deleted = await awsCleanAccountOps(creds, 'us-east-1', 'run').deleteRetainedResources('r1');
  expect(deleted).toEqual(['arn:aws:logs:us-east-1:4:log-group:/mkt-ct-r1-two/api', 'arn:aws:kms:us-east-1:4:key/abc']);
  expect(input(logs.mock.calls[0][0])).toEqual({ logGroupName: '/mkt-ct-r1-two/api' });
  expect(input(kms.mock.calls[0][0])).toMatchObject({ KeyId: 'arn:aws:kms:us-east-1:4:key/abc', PendingWindowInDays: 7 });
});
