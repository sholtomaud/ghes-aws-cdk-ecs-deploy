import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { COMPONENTS } from '../../customer-app/lib/images';
import { SellerConfig } from './config';

/** Controlled release stages, in the required order (after the Source stage). */
export const STAGE_ORDER = [
  'BuildAndTest',
  'CleanAccountTests',
  'ReleaseApproval',
  'MarketplaceSubmission',
  'MarketplaceProcessing',
  'PublicationVerification',
  'AnnounceRelease',
] as const;

export interface SellerReleasePipelineStackProps extends StackProps {
  config: SellerConfig;
}

const LOG_RETENTION = logs.RetentionDays.ONE_YEAR;
const STAGING_PREFIX = 'marketplace-staging';

/**
 * Seller-account release pipeline: the only path to a Marketplace submission. GitHub Actions runs fast CI
 * but holds no Marketplace permissions.
 */
export class SellerReleasePipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: SellerReleasePipelineStackProps) {
    const { config } = props;
    if (props.env?.account !== config.seller.account) throw new Error(`stack account must equal SELLER_ACCOUNT_ID (${config.seller.account})`);
    if (props.env?.region !== config.seller.region) throw new Error(`stack region must equal SELLER_REGION (${config.seller.region})`);
    super(scope, id, props);

    // ------------------------------------------------------------- release artifacts
    const artifactBucket = new s3.Bucket(this, 'ReleaseArtifacts', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ id: 'expire-noncurrent', noncurrentVersionExpiration: Duration.days(365), abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });
    // The test-account deploy role reads per-version test templates (CloudFormation TemplateURL).
    artifactBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CleanAccountTemplatesRead',
      principals: [new iam.ArnPrincipal(config.test.roleArn)],
      actions: ['s3:GetObject'],
      resources: [artifactBucket.arnForObjects('releases/*')],
    }));

    const stagingRepos = COMPONENTS.map((c) => {
      const repo = new ecr.Repository(this, `Staging${c[0].toUpperCase()}${c.slice(1)}Repository`, {
        repositoryName: `${STAGING_PREFIX}/${c}`,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        imageScanOnPush: true,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [{ description: 'keep recent release candidates', maxImageCount: 200 }],
      });
      repo.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'CleanAccountPull',
        principals: [new iam.AccountPrincipal(config.test.account)],
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
      }));
      return repo;
    });

    const approvalTopic = new sns.Topic(this, 'ApprovalTopic', { displayName: 'Marketplace release approval', enforceSSL: true });
    for (const email of config.approverEmails) approvalTopic.addSubscription(new subs.EmailSubscription(email));

    // ------------------------------------------------------------- CodeBuild projects (one role each)
    const env: Record<string, string> = {
      GITHUB_OWNER: config.github.owner,
      GITHUB_REPO: config.github.repo,
      GITHUB_BRANCH: config.github.branch,
      CODECONNECTIONS_ARN: config.github.connectionArn,
      SELLER_ACCOUNT_ID: config.seller.account,
      SELLER_REGION: config.seller.region,
      TEST_ACCOUNT_ID: config.test.account,
      TEST_REGION: config.test.region,
      TEST_DEPLOY_ROLE_ARN: config.test.roleArn,
      TEST_CERTIFICATE_ARN: config.test.certificateArn,
      TEST_APP_DOMAIN: config.test.appDomain,
      TEST_BEDROCK_MODEL_ID: config.test.bedrockModelId,
      MARKETPLACE_PRODUCT_ID: config.marketplace.productId,
      MARKETPLACE_CATALOG_REGION: config.marketplace.catalogRegion,
      MARKETPLACE_DELIVERY_OPTION_TITLE: config.marketplace.deliveryOptionTitle,
      MARKETPLACE_ECR_REPOSITORIES: COMPONENTS.map((c) => `${c}=${config.marketplace.repositories[c]}`).join(','),
      MARKETPLACE_REQUIRED_VISIBILITY: config.marketplace.requiredVisibility,
      MARKETPLACE_WAIT_MAX_MINUTES: String(config.marketplace.waitMaxMinutes),
      TEMPLATE_PUBLISH_BUCKET: config.templates.bucket,
      TEMPLATE_PUBLIC_BASE_URL: config.templates.publicBaseUrl,
      RELEASE_TOPIC_ARN: config.releaseTopicArn,
      APPROVER_EMAILS: config.approverEmails.join(','),
      SUPPORTED_UPGRADE_FROM: config.supportedUpgradeFrom.join(','),
      ARTIFACT_BUCKET: artifactBucket.bucketName,
      STAGING_REPOSITORY_PREFIX: `${config.seller.account}.dkr.ecr.${config.seller.region}.amazonaws.com/${STAGING_PREFIX}`,
    };

    const project = (id: string, buildspec: string, opts: { privileged?: boolean; timeoutMinutes?: number } = {}) => {
      const logGroup = new logs.LogGroup(this, `${id}Logs`, { retention: LOG_RETENTION, removalPolicy: RemovalPolicy.RETAIN });
      const role = new iam.Role(this, `${id}Role`, { assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'), description: `${id} release stage` });
      return new codebuild.PipelineProject(this, id, {
        role,
        buildSpec: codebuild.BuildSpec.fromSourceFilename(buildspec),
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.MEDIUM,
          privileged: opts.privileged ?? false,
          environmentVariables: Object.fromEntries(Object.entries(env).map(([k, value]) => [k, { value, type: codebuild.BuildEnvironmentVariableType.PLAINTEXT }])),
        },
        timeout: Duration.minutes(opts.timeoutMinutes ?? 60),
        logging: { cloudWatch: { logGroup } },
      });
    };

    const build = project('BuildAndTestProject', 'buildspec/build-and-test.yml', { privileged: true, timeoutMinutes: 90 });
    build.addToRolePolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    build.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage',
        'ecr:BatchGetImage', 'ecr:DescribeImages', 'ecr:DescribeImageScanFindings'],
      resources: stagingRepos.map((r) => r.repositoryArn),
    }));

    const clean = project('CleanAccountTestProject', 'buildspec/test-clean-account.yml', { timeoutMinutes: 240 });
    clean.addToRolePolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [config.test.roleArn] }));
    clean.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [artifactBucket.arnForObjects('releases/*')] }));
    clean.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`arn:${this.partition}:s3:::${config.templates.bucket}/releases/*`] }));

    const publish = project('PublishImagesProject', 'buildspec/publish-images.yml', { privileged: true, timeoutMinutes: 60 });
    publish.addToRolePolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    publish.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability', 'ecr:DescribeImages'],
      resources: stagingRepos.map((r) => r.repositoryArn),
    }));
    publish.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage',
        'ecr:BatchGetImage', 'ecr:DescribeImages'],
      resources: COMPONENTS.map((c) => marketplaceRepositoryArn(this.partition, config.marketplace.repositories[c])),
    }));

    const productArn = `arn:${this.partition}:aws-marketplace:${config.marketplace.catalogRegion}:${config.seller.account}:AWSMarketplace/ContainerProduct/${config.marketplace.productId}`;
    const submit = project('MarketplaceSubmitProject', 'buildspec/marketplace-submit.yml');
    submit.addToRolePolicy(new iam.PolicyStatement({ actions: ['aws-marketplace:StartChangeSet', 'aws-marketplace:DescribeEntity'], resources: [productArn] }));
    submit.addToRolePolicy(new iam.PolicyStatement({ actions: ['aws-marketplace:ListChangeSets'], resources: ['*'] }));
    submit.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'], resources: [`arn:${this.partition}:s3:::${config.templates.bucket}/releases/*`],
    }));

    const wait = project('MarketplaceWaitProject', 'buildspec/marketplace-wait.yml', { timeoutMinutes: Math.min(480, config.marketplace.waitMaxMinutes + 15) });
    wait.addToRolePolicy(new iam.PolicyStatement({ actions: ['aws-marketplace:DescribeChangeSet'], resources: ['*'] }));

    const verify = project('MarketplaceVerifyProject', 'buildspec/marketplace-verify.yml');
    verify.addToRolePolicy(new iam.PolicyStatement({ actions: ['aws-marketplace:DescribeEntity'], resources: [productArn] }));
    verify.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [artifactBucket.arnForObjects('releases/*/manual-verification.json')] }));

    const announce = project('AnnounceReleaseProject', 'buildspec/announce-release.yml');
    announce.addToRolePolicy(new iam.PolicyStatement({ actions: ['sns:Publish'], resources: [config.releaseTopicArn] }));
    announce.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [artifactBucket.arnForObjects('releases/announcements/*')],
    }));

    // ------------------------------------------------------------- pipeline
    const source = new codepipeline.Artifact('SourceOutput');
    const built = new codepipeline.Artifact('BuildOutput');
    const tested = new codepipeline.Artifact('TestedOutput');
    const submitted = new codepipeline.Artifact('SubmissionOutput');
    const processed = new codepipeline.Artifact('ProcessingOutput');
    const verified = new codepipeline.Artifact('VerificationOutput');

    const buildAction = (actionName: string, p: codebuild.IProject, input: codepipeline.Artifact | undefined, output: codepipeline.Artifact | undefined, namespace: string, runOrder?: number) =>
      new actions.CodeBuildAction({
        actionName, project: p, input: source, extraInputs: input ? [input] : undefined, outputs: output ? [output] : undefined,
        variablesNamespace: namespace, runOrder,
      });

    const pipeline = new codepipeline.Pipeline(this, 'ReleasePipeline', {
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.QUEUED,
      artifactBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
    });
    pipeline.addStage({
      stageName: 'Source',
      actions: [new actions.CodeStarConnectionsSourceAction({
        actionName: 'GitHub', connectionArn: config.github.connectionArn, owner: config.github.owner, repo: config.github.repo,
        branch: config.github.branch, output: source, codeBuildCloneOutput: false, triggerOnPush: true,
      })],
    });
    pipeline.addStage({ stageName: 'BuildAndTest', actions: [buildAction('BuildAndTest', build, undefined, built, 'BuildAndTest')] });
    pipeline.addStage({ stageName: 'CleanAccountTests', actions: [buildAction('CleanAccountTests', clean, built, tested, 'CleanAccountTests')] });
    pipeline.addStage({
      stageName: 'ReleaseApproval',
      actions: [new actions.ManualApprovalAction({
        actionName: 'ApproveRelease',
        notificationTopic: approvalTopic,
        additionalInformation: '#{CleanAccountTests.APPROVAL_CUSTOM_DATA}',
        externalEntityLink: `https://${config.seller.region}.console.aws.amazon.com/s3/object/${artifactBucket.bucketName}?prefix=releases/#{BuildAndTest.VERSION}/approval-summary.md`,
      })],
    });
    pipeline.addStage({
      stageName: 'MarketplaceSubmission',
      actions: [
        buildAction('PublishImages', publish, tested, undefined, 'PublishImages', 1),
        buildAction('SubmitChangeSet', submit, tested, submitted, 'SubmitChangeSet', 2),
      ],
    });
    pipeline.addStage({ stageName: 'MarketplaceProcessing', actions: [buildAction('WaitForProcessing', wait, submitted, processed, 'MarketplaceProcessing')] });
    pipeline.addStage({ stageName: 'PublicationVerification', actions: [buildAction('VerifyPublication', verify, processed, verified, 'PublicationVerification')] });
    pipeline.addStage({ stageName: 'AnnounceRelease', actions: [buildAction('Announce', announce, verified, undefined, 'AnnounceRelease')] });
  }
}

/** arn for a Marketplace ECR repository URI such as 709825985650.dkr.ecr.us-east-1.amazonaws.com/seller/app */
export function marketplaceRepositoryArn(partition: string, uri: string): string {
  const [host, ...path] = uri.split('/');
  const [account, , , region] = host.split('.');
  return `arn:${partition}:ecr:${region}:${account}:repository/${path.join('/')}`;
}
