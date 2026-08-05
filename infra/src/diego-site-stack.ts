import { Annotations, CfnOutput, Duration, RemovalPolicy, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as pipelineActions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { FencedStack } from './constructs/fenced-stack';
import { panelMeta } from './constructs/panel-meta';

/** Panel group / app key. Every principal resource carries it. */
export const SITE_APP_KEY = 'diego-site';
/**
 * Physical-name prefix (F5). Every resource this stack names explicitly starts
 * with it, so nothing can collide with — or be mistaken for — an `eleva-*`
 * resource in the shared account. The pipeline is the one exception: the panel
 * requires the `eleva-<app>-<env>` shape, and `eleva-diego-site-prod` still
 * reads unmistakably.
 */
export const SITE_RESOURCE_PREFIX = 'diego-site-';
/** Pipeline name — keeps the Eleva `eleva-<app>-<env>` convention. */
export const SITE_PIPELINE_NAME = 'eleva-diego-site-prod';
/** SSM namespace: /<app>/<env>/<component>/... */
export const SITE_SSM_PREFIX = '/diego/prod/site';
/** Apex domain the site is published under when DNS is wired up. */
export const DEFAULT_DOMAIN_NAME = 'diegopalominos.dev';

const CONTAINER_PORT = 3000;
const DB_PORT = 5432;
const DB_NAME = 'blog';

/**
 * Characters excluded from the generated database password so that the
 * password can be embedded verbatim in a `postgres://` DATABASE_URL without
 * URL-encoding. Leaves alphanumerics plus `-_.` available.
 */
const DB_PASSWORD_EXCLUDE_CHARS = ' %+~`#$&*()|[]{}:;<>?!\'/@"\\=^,';

export interface DiegoSiteStackProps extends StackProps {
  /** Apex domain; defaults to context `domainName`, then `diegopalominos.dev`. */
  readonly domainName?: string;
  /**
   * Route53 zone id for `domainName`. DNS + TLS only switch on when this is
   * known (prop, context `hostedZoneId`, or context `hostedZoneLookup=true`
   * for an env-bound synth) — that keeps credential-free synth working.
   */
  readonly hostedZoneId?: string;
}

/**
 * diegopalominos.dev — the public site.
 *
 * Shape (scope ids are the panel keys, so they matter):
 *
 * | scope      | contents |
 * | ---------- | -------- |
 * | `site`     | private S3 bucket (OAC) with the built frontend + the CloudFront distribution that is the ONLY public entry |
 * | `blog`     | ECR repo, ECS cluster, ARM64 Fargate task/service, its LogGroup, the internet-facing ALB (CloudFront origin) |
 * | `database` | RDS PostgreSQL 16 `db.t4g.micro` in isolated subnets |
 * | `pipeline` | CodePipeline `eleva-diego-site-prod` |
 *
 * Eleva conventions that must hold for the existing Angular panel to drive
 * this stack unmodified:
 *
 * - power/scheduling only works for `ecs.FargateService` and
 *   `rds.DatabaseInstance` L2s, and a resource's panel key comes from its
 *   PARENT construct id — hence the dedicated `blog` / `database` scopes with
 *   the service's LogGroup kept *inside* the `blog` scope;
 * - `panelMeta` writes `Metadata['Eleva::Panel']` (category/group/label/
 *   hidden/public/deploys) on every principal resource;
 * - pipeline named `eleva-<app>-<env>`, config in SSM under `/diego/prod/site`.
 *
 * Fencing (see `constructs/fenced-stack.ts`): the stack refuses to synthesize
 * outside the expected account (F1), always builds its OWN VPC (F4) and
 * prefixes every physical name with `diego-site-` (F5). The tag-scoped cost
 * budget (F7) is owned by the control stack, which is where the runaway-cost
 * risk lives. `cdk synth` succeeds with NO AWS credentials
 * — the app performs no context lookups unless `hostedZoneLookup` is asked
 * for explicitly.
 */
export class DiegoSiteStack extends FencedStack {
  /** VPC the service and database run in. */
  public readonly vpc: ec2.IVpc;
  /** ECS cluster — handed to the control stack so it can scope IAM to it. */
  public readonly cluster: ecs.Cluster;
  /** The one service the control plane may power on/off. */
  public readonly service: ecs.FargateService;
  /** The one database the control plane may start/stop. */
  public readonly database: rds.DatabaseInstance;
  /** CloudFront's `/api/*` origin. Not the public entrypoint itself. */
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  /** Private bucket holding the built frontend (published by the pipeline). */
  public readonly siteBucket: s3.Bucket;
  /** The only public entry: default -> S3 (SPA), `/api/*` -> ALB. */
  public readonly distribution: cloudfront.Distribution;
  /** Where a visitor should point their browser. */
  public readonly siteUrl: string;
  /** Apex domain when DNS/TLS is active, otherwise undefined. */
  public readonly domainName?: string;

  constructor(scope: Construct, id: string, props: DiegoSiteStackProps = {}) {
    super(scope, id, props);

    const vpc = this.createDedicatedVpc();
    this.vpc = vpc;

    // DNS is opt-in: `domainName` alone is not enough, because resolving the
    // zone would otherwise need credentials at synth time.
    const domainName: string =
      props.domainName ?? this.node.tryGetContext('domainName') ?? DEFAULT_DOMAIN_NAME;
    const zone = this.resolveHostedZone(domainName, props.hostedZoneId);
    const dnsEnabled = zone !== undefined;
    this.domainName = dnsEnabled ? domainName : undefined;

    if (!dnsEnabled) {
      Annotations.of(this).addInfo(
        `DNS/TLS disabled: pass -c hostedZoneId=<Z...> (or -c hostedZoneLookup=true with credentials) to publish ${domainName}. `
        + 'Synthesizing with the CloudFront default domain and a plain HTTP ALB listener.',
      );
    }

    // ── database ────────────────────────────────────────────────────────
    // Scope id 'database' is the panel key for the RDS instance, which the
    // control plane can start/stop (rds.DatabaseInstance L2 — not Aurora).
    const database = new Construct(this, 'database');

    const dbSecurityGroup = new ec2.SecurityGroup(database, 'SecurityGroup', {
      vpc,
      securityGroupName: `${SITE_RESOURCE_PREFIX}db`,
      description: 'diego-site Postgres; ingress only from the blog service',
      allowAllOutbound: false,
    });

    const db = new rds.DatabaseInstance(database, 'Postgres', {
      instanceIdentifier: `${SITE_RESOURCE_PREFIX}db`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret('blog', {
        excludeCharacters: DB_PASSWORD_EXCLUDE_CHARS,
      }),
      databaseName: DB_NAME,
      port: DB_PORT,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      multiAz: false,
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      deletionProtection: true,
    });
    this.database = db;
    const dbSecret = db.secret!; // generated credentials -> always present

    // ── blog (the Fargate service scope) ────────────────────────────────
    // Scope id 'blog' is the panel key for the ECS service; the LogGroup
    // must stay inside this scope for the panel to associate it.
    const blog = new Construct(this, 'blog');

    // Fixed name so the first-boot image push target is known before the
    // stack finishes deploying (see README bootstrap).
    const repository = new ecr.Repository(blog, 'Repository', {
      repositoryName: `${SITE_RESOURCE_PREFIX}blog`,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 20 }],
    });

    const cluster = new ecs.Cluster(blog, 'Cluster', {
      vpc,
      clusterName: `${SITE_RESOURCE_PREFIX}cluster`,
      enableFargateCapacityProviders: true,
    });
    this.cluster = cluster;

    const adminToken = new secretsmanager.Secret(blog, 'AdminToken', {
      secretName: `${SITE_RESOURCE_PREFIX}admin-token`,
      description: 'ADMIN_TOKEN for the diego-site maintainer API',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 48,
      },
    });

    const logGroup = new logs.LogGroup(blog, 'ServiceLogs', {
      logGroupName: `${SITE_RESOURCE_PREFIX}blog`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(blog, 'TaskDefinition', {
      family: `${SITE_RESOURCE_PREFIX}blog`,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // DATABASE_URL is assembled from the RDS-generated credentials secret.
    // unsafeUnwrap() renders `{{resolve:secretsmanager:...}}` dynamic
    // references, so CloudFormation injects the values at deploy time —
    // no secret material lands in the synthesized template.
    const databaseUrl = [
      'postgres://',
      dbSecret.secretValueFromJson('username').unsafeUnwrap(),
      ':',
      dbSecret.secretValueFromJson('password').unsafeUnwrap(),
      '@',
      db.dbInstanceEndpointAddress,
      ':',
      db.dbInstanceEndpointPort,
      '/',
      DB_NAME,
    ].join('');

    const container = taskDefinition.addContainer('blog', {
      containerName: 'blog',
      image: ecs.ContainerImage.fromEcrRepository(repository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'blog' }),
      portMappings: [{ containerPort: CONTAINER_PORT }],
      environment: {
        EVENT_STORE: 'postgres',
        PORT: String(CONTAINER_PORT),
        DATABASE_URL: databaseUrl,
      },
      secrets: {
        ADMIN_TOKEN: ecs.Secret.fromSecretsManager(adminToken),
      },
    });

    const service = new ecs.FargateService(blog, 'Service', {
      cluster,
      taskDefinition,
      serviceName: `${SITE_RESOURCE_PREFIX}api`,
      // Context-driven so the FIRST deploy can come up with 0 tasks: the ECR
      // repository this service pulls from is created by this very stack, so
      // it is empty until the bootstrap image push. `-c desiredCount=0` lets
      // CloudFormation reach steady state immediately; turn the lights on
      // afterwards from the control plane (or redeploy without the flag).
      // Note: a later CloudFormation update resets this to the context value —
      // i.e. deploying turns the lights back on even if a visitor switched
      // them off. The control plane's watchdog turns them off again within
      // 15 minutes.
      desiredCount: Number(this.node.tryGetContext('desiredCount') ?? 1),
      // Public subnets + public IP: no NAT gateway needed to reach
      // ECR / Secrets Manager / CloudWatch Logs.
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // Prefer Spot; FARGATE stays in the strategy as the fallback lane.
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 4 },
        { capacityProvider: 'FARGATE', weight: 1 },
      ],
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(60),
    });
    this.service = service;

    // Circuit breaker deliberately NOT enabled: the ECR repo is empty on
    // first boot and the bootstrap image push (see README) may land minutes
    // after the service is created. Failed pipeline deploys still leave the
    // old task running (minHealthyPercent 100) and time out after 20 min.
    Annotations.of(service).acknowledgeWarning(
      '@aws-cdk/aws-ecs:shouldUseCircuitBreaker',
      'Bootstrap-friendly: ECR is empty until the first image push; rolling deploys keep the old task on failure.',
    );

    // Postgres reachable from the service security group only.
    db.connections.allowFrom(
      service,
      ec2.Port.tcp(DB_PORT),
      'diego-site service to Postgres',
    );

    // The ALB is an *origin*, not the front door. Optionally lock its
    // ingress to the CloudFront managed prefix list (region-specific id, so
    // it stays a context knob rather than a hard-coded value).
    const albSecurityGroup = new ec2.SecurityGroup(blog, 'AlbSecurityGroup', {
      vpc,
      securityGroupName: `${SITE_RESOURCE_PREFIX}alb`,
      // Plain ASCII: CloudFormation validates GroupDescription against
      // ^([a-z,A-Z,0-9,. _\-:/()#,@[\]+=&;{}!$*])*$ — an em dash fails it.
      description: 'diego-site ALB - CloudFront origin only',
      allowAllOutbound: true,
    });
    const cloudfrontPrefixListId: string | undefined =
      this.node.tryGetContext('cloudfrontPrefixListId');
    const albPort = dnsEnabled ? 443 : 80;
    if (cloudfrontPrefixListId) {
      albSecurityGroup.addIngressRule(
        ec2.Peer.prefixList(cloudfrontPrefixListId),
        ec2.Port.tcp(albPort),
        'CloudFront edge only (com.amazonaws.global.cloudfront.origin-facing)',
      );
    } else {
      albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(albPort), 'CloudFront (unrestricted)');
      albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(albPort), 'CloudFront (unrestricted)');
    }

    const alb = new elbv2.ApplicationLoadBalancer(blog, 'Alb', {
      vpc,
      loadBalancerName: `${SITE_RESOURCE_PREFIX}alb`,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSecurityGroup,
    });
    this.loadBalancer = alb;

    const targetGroup = new elbv2.ApplicationTargetGroup(blog, 'TargetGroup', {
      vpc,
      targetGroupName: `${SITE_RESOURCE_PREFIX}api`,
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: '/api/posts',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
      },
    });

    // `origin.<domain>` is the ALB's own name: CloudFront needs a hostname
    // whose certificate it can validate when it talks HTTPS to the origin.
    const originHostName = `origin.${domainName}`;
    if (dnsEnabled && zone) {
      const originCertificate = new acm.Certificate(blog, 'OriginCertificate', {
        domainName: originHostName,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      alb.addListener('Https', {
        port: 443,
        certificates: [originCertificate],
        defaultTargetGroups: [targetGroup],
        // `open: true` (the default) would add its own 0.0.0.0/0 ingress rule
        // and quietly undo `cloudfrontPrefixListId`. Ingress for this SG is
        // decided above, in one place.
        open: false,
      });
      new route53.ARecord(blog, 'OriginAliasRecord', {
        zone,
        recordName: originHostName,
        target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
      });
      new route53.AaaaRecord(blog, 'OriginAliasRecordV6', {
        zone,
        recordName: originHostName,
        target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
      });
    } else {
      // Bootstrap mode: plain HTTP origin until a domain is wired up.
      alb.addListener('Http', {
        port: 80,
        defaultTargetGroups: [targetGroup],
        open: false, // see above: ingress is owned by albSecurityGroup
      });
    }

    // ── site (S3 + CloudFront: the only public entry) ────────────────────
    const site = new Construct(this, 'site');

    const siteBucket = new s3.Bucket(site, 'Bucket', {
      // Deterministic, prefixed name (F5); account+region keep it globally
      // unique. Both are literals once `env` is bound in main.ts.
      bucketName: `${SITE_RESOURCE_PREFIX}web-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      publicReadAccess: false,
      // Holds published build output only, but it is cheap to keep and the
      // pipeline republishes it — RETAIN avoids an auto-delete Lambda.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.siteBucket = siteBucket;

    /*
     * SPA routing lives in a CloudFront Function on the DEFAULT behavior
     * instead of distribution-level custom error responses.
     *
     * CustomErrorResponses are distribution-wide: a `403/404 -> /index.html`
     * mapping would also rewrite the API's honest 404 (unknown post) and 403
     * (bad ADMIN_TOKEN) into a 200 page of HTML, which quietly breaks both
     * the reader and the maintainer console. Behavior-scoped rewriting keeps
     * `/api/*` responses exactly as the service sent them.
     */
    const spaRewrite = new cloudfront.Function(site, 'SpaRewrite', {
      functionName: `${SITE_RESOURCE_PREFIX}spa-rewrite`,
      comment: 'diego-site SPA routing: extension-less paths render /index.html',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline([
        'function handler(event) {',
        '  var request = event.request;',
        '  var uri = request.uri;',
        '  var last = uri.substring(uri.lastIndexOf(\'/\') + 1);',
        '  if (last === \'\') { request.uri = uri + \'index.html\'; return request; }',
        '  if (last.indexOf(\'.\') === -1) { request.uri = \'/index.html\'; }',
        '  return request;',
        '}',
      ].join('\n')),
    });

    const apiOrigin: cloudfront.IOrigin = dnsEnabled
      ? new origins.HttpOrigin(originHostName, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        readTimeout: Duration.seconds(30),
      })
      : new origins.LoadBalancerV2Origin(alb, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        readTimeout: Duration.seconds(30),
      });

    const distribution = new cloudfront.Distribution(site, 'Distribution', {
      comment: 'diego-site — S3 (SPA) + /api/* to the blog ALB',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      defaultBehavior: {
        // OAC (not the legacy OAI): the bucket stays private and only this
        // distribution can read it.
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [{
          function: spaRewrite,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        // No caching, forward everything (cookies/headers/query) except the
        // Host header, which must stay the origin's own name.
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
      ...(dnsEnabled && zone
        ? {
          domainNames: [domainName, `www.${domainName}`],
          certificate: this.resolveEdgeCertificate(site, domainName, zone),
        }
        : {}),
    });
    this.distribution = distribution;

    if (dnsEnabled && zone) {
      const target = route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      );
      new route53.ARecord(site, 'ApexAlias', { zone, recordName: domainName, target });
      new route53.AaaaRecord(site, 'ApexAliasV6', { zone, recordName: domainName, target });
      new route53.ARecord(site, 'WwwAlias', { zone, recordName: `www.${domainName}`, target });
      new route53.AaaaRecord(site, 'WwwAliasV6', { zone, recordName: `www.${domainName}`, target });
    }

    this.siteUrl = dnsEnabled ? `https://${domainName}` : `https://${distribution.distributionDomainName}`;

    // ── pipeline ────────────────────────────────────────────────────────
    const pipelineScope = new Construct(this, 'pipeline');

    const connectionArn: string =
      this.node.tryGetContext('connectionArn') ??
      ssm.StringParameter.valueForStringParameter(
        pipelineScope,
        `${SITE_SSM_PREFIX}/connectionArn`,
      );

    const sourceOutput = new codepipeline.Artifact('Source');
    const imageOutput = new codepipeline.Artifact('Image');
    const frontendOutput = new codepipeline.Artifact('Frontend');

    const sourceAction = new pipelineActions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner: this.node.tryGetContext('githubOwner') ?? 'betterjam',
      repo: this.node.tryGetContext('githubRepo') ?? 'personal-site',
      branch: this.node.tryGetContext('githubBranch') ?? 'main',
      connectionArn,
      output: sourceOutput,
    });

    // ARM build host so `docker build` natively produces the ARM64 image
    // the task definition runs on. The same image family builds the
    // frontend and runs the invalidation, so there is one runtime to reason
    // about (its default Node ships with the AL2023 standard image).
    const buildImage = codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0;

    const dockerBuild = new codebuild.PipelineProject(pipelineScope, 'DockerBuild', {
      description: 'Builds app/ into an ARM64 image and pushes it to ECR',
      environment: {
        buildImage,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // docker-in-docker
      },
      environmentVariables: {
        ECR_REPO_URI: { value: repository.repositoryUri },
        CONTAINER_NAME: { value: container.containerName },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'export GIT_SHA="${CODEBUILD_RESOLVED_SOURCE_VERSION}"',
              'export BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
              'aws ecr get-login-password | docker login --username AWS --password-stdin "${ECR_REPO_URI%%/*}"',
            ],
          },
          build: {
            commands: [
              'docker build'
                + ' --build-arg GIT_SHA="${GIT_SHA}"'
                + ' --build-arg BUILD_TIME="${BUILD_TIME}"'
                + ' -t "${ECR_REPO_URI}:${GIT_SHA}"'
                + ' -t "${ECR_REPO_URI}:latest"'
                + ' app',
            ],
          },
          post_build: {
            commands: [
              'docker push "${ECR_REPO_URI}:${GIT_SHA}"',
              'docker push "${ECR_REPO_URI}:latest"',
              'printf \'[{"name":"%s","imageUri":"%s"}]\' "${CONTAINER_NAME}" "${ECR_REPO_URI}:${GIT_SHA}" > imagedefinitions.json',
            ],
          },
        },
        artifacts: {
          files: ['imagedefinitions.json'],
        },
      }),
    });
    repository.grantPullPush(dockerBuild);

    // vite writes to ../app/public (see frontend/vite.config.ts), which is
    // also what the container image bakes in — S3 serves the same bytes.
    const frontendBuild = new codebuild.PipelineProject(pipelineScope, 'FrontendBuild', {
      description: 'Builds frontend/ with vite into the static site artifact',
      environment: {
        buildImage,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: ['npm ci --no-audit --no-fund --prefix frontend'],
          },
          build: {
            commands: ['npm run build --prefix frontend'],
          },
        },
        artifacts: {
          'base-directory': 'app/public',
          'files': ['**/*'],
        },
      }),
    });

    const invalidate = new codebuild.PipelineProject(pipelineScope, 'Invalidate', {
      description: 'Invalidates the CloudFront cache after a frontend publish',
      environment: {
        buildImage,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        DISTRIBUTION_ID: { value: distribution.distributionId },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'aws cloudfront create-invalidation --distribution-id "${DISTRIBUTION_ID}" --paths "/*"',
            ],
          },
        },
      }),
    });
    invalidate.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: [distribution.distributionArn],
    }));

    const pipeline = new codepipeline.Pipeline(pipelineScope, 'Pipeline', {
      pipelineName: SITE_PIPELINE_NAME,
      pipelineType: codepipeline.PipelineType.V2,
      crossAccountKeys: false,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [
            new pipelineActions.CodeBuildAction({
              actionName: 'DockerBuild',
              project: dockerBuild,
              input: sourceOutput,
              outputs: [imageOutput],
            }),
            new pipelineActions.CodeBuildAction({
              actionName: 'FrontendBuild',
              project: frontendBuild,
              input: sourceOutput,
              outputs: [frontendOutput],
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            new pipelineActions.EcsDeployAction({
              actionName: 'DeployToEcs',
              service,
              input: imageOutput,
              deploymentTimeout: Duration.minutes(20),
              runOrder: 1,
            }),
            new pipelineActions.S3DeployAction({
              actionName: 'PublishFrontend',
              bucket: siteBucket,
              input: frontendOutput,
              extract: true,
              cacheControl: [
                pipelineActions.CacheControl.setPublic(),
                pipelineActions.CacheControl.maxAge(Duration.minutes(5)),
              ],
              runOrder: 1,
            }),
            new pipelineActions.CodeBuildAction({
              actionName: 'InvalidateCdn',
              project: invalidate,
              input: frontendOutput,
              runOrder: 2,
            }),
          ],
        },
      ],
    });

    // ── shared SSM parameters (/diego/prod/site/*) ──────────────────────
    new ssm.StringParameter(this, 'SiteBucketParam', {
      parameterName: `${SITE_SSM_PREFIX}/siteBucket`,
      stringValue: siteBucket.bucketName,
    });
    new ssm.StringParameter(this, 'DistributionIdParam', {
      parameterName: `${SITE_SSM_PREFIX}/distributionId`,
      stringValue: distribution.distributionId,
    });
    new ssm.StringParameter(this, 'AlbDnsNameParam', {
      parameterName: `${SITE_SSM_PREFIX}/albDnsName`,
      stringValue: alb.loadBalancerDnsName,
    });
    new ssm.StringParameter(this, 'EcrRepoUriParam', {
      parameterName: `${SITE_SSM_PREFIX}/ecrRepoUri`,
      stringValue: repository.repositoryUri,
    });
    new ssm.StringParameter(this, 'ServiceNameParam', {
      parameterName: `${SITE_SSM_PREFIX}/serviceName`,
      stringValue: service.serviceName,
    });
    new ssm.StringParameter(this, 'DbInstanceIdParam', {
      parameterName: `${SITE_SSM_PREFIX}/dbInstanceId`,
      stringValue: db.instanceIdentifier,
    });

    /*
     * Cost guard (F7) deliberately does NOT live here.
     *
     * The monthly budget is scoped by the `project=diego-site` tag, which
     * covers BOTH stacks, and `BudgetName` is account-global — two stacks
     * declaring it would fail the second `cdk deploy` with "budget already
     * exists". `DiegoControlStack` owns it (budget + billing alarm + alert
     * topic), together with the watchdog that makes it necessary. This stack
     * supplies the half that makes it work: the `project` tag on every
     * resource (F6, applied at App level in `main.ts`).
     */

    // ── panel metadata (control.diegopalominos.dev) ─────────────────────
    // `category` is set wherever the panel would otherwise drop the type:
    // it only infers ECS/RDS natively, so CDN/storage/network/registry/
    // logs/secret resources say what they are.
    panelMeta(service, { group: SITE_APP_KEY, label: 'Site API service' });
    panelMeta(db, { group: SITE_APP_KEY, label: 'Site PostgreSQL' });
    panelMeta(distribution, {
      category: 'cdn',
      group: SITE_APP_KEY,
      label: 'diegopalominos.dev (CloudFront)',
      public: { protocol: 'HTTPS', port: 443, from: 'Web' },
    });
    panelMeta(siteBucket, {
      category: 'storage',
      group: SITE_APP_KEY,
      label: 'Frontend build (private, OAC)',
    });
    panelMeta(alb, {
      category: 'network',
      group: SITE_APP_KEY,
      label: 'API origin (CloudFront only)',
    });
    panelMeta(repository, {
      category: 'registry',
      group: SITE_APP_KEY,
      label: 'Site container images',
    });
    panelMeta(logGroup, {
      category: 'logs',
      group: SITE_APP_KEY,
      label: 'Site service logs',
    });
    panelMeta(adminToken, {
      category: 'secret',
      group: SITE_APP_KEY,
      label: 'Site admin token',
    });
    panelMeta(pipeline, {
      category: 'pipeline',
      group: SITE_APP_KEY,
      label: `${SITE_PIPELINE_NAME} pipeline`,
      deploys: [SITE_APP_KEY],
    });

    // ── outputs ─────────────────────────────────────────────────────────
    new CfnOutput(this, 'SiteUrl', { value: this.siteUrl });
    new CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new CfnOutput(this, 'EcrRepoUri', { value: repository.repositoryUri });
    new CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new CfnOutput(this, 'DbInstanceId', { value: db.instanceIdentifier });
  }

  /**
   * F4 — DEDICATED NETWORK.
   *
   * This stack ALWAYS creates its own minimal 2-AZ VPC (public + isolated
   * subnets, zero NAT gateways). Importing a VPC is refused outright: the
   * account may host unrelated production workloads, and a public playground that strangers can
   * power on must not share a network with production. That is a stronger
   * rule than the usual "`vpcId` -> `Vpc.fromLookup`" convenience, so passing
   * `vpcId` fails the synth rather than being silently ignored.
   *
   * Bonus: no lookup means no AWS call at synth time, which is what keeps
   * credential-free synth working even though `env` is pinned (F1).
   */
  private createDedicatedVpc(): ec2.IVpc {
    const vpcId: string | undefined = this.node.tryGetContext('vpcId');
    if (vpcId) {
      throw new Error(
        `Network guard: refusing to import VPC '${vpcId}'. `
        + 'The public playground (anyone on the internet can power it on) must not share a network with production Eleva, '
        + 'which lives in the same AWS account. This stack always creates its own minimal VPC — drop the -c vpcId context. '
        + 'If you genuinely need peering to an existing network, do it explicitly with a VPC peering / TGW attachment and a written justification.',
      );
    }
    return new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
  }

  /**
   * `hostedZoneId` (prop or context) -> attribute import, credential-free.
   * Context `hostedZoneLookup=true` -> Route53 lookup (needs env +
   * credentials). Neither -> undefined, i.e. no DNS/TLS this synth.
   */
  private resolveHostedZone(domainName: string, hostedZoneIdProp?: string): route53.IHostedZone | undefined {
    const zoneName = inferZoneName(domainName);
    const hostedZoneId: string | undefined = hostedZoneIdProp ?? this.node.tryGetContext('hostedZoneId');
    if (hostedZoneId) {
      return route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId, zoneName });
    }
    const lookup = this.node.tryGetContext('hostedZoneLookup');
    if (lookup === true || lookup === 'true') {
      return route53.HostedZone.fromLookup(this, 'Zone', { domainName: zoneName });
    }
    return undefined;
  }

  /**
   * The viewer certificate must live in us-east-1 whatever region the stack
   * deploys to.
   *
   * Preferred (and the only path with no custom resource): pass an existing
   * us-east-1 certificate as context `cloudfrontCertificateArn`. Otherwise
   * fall back to `DnsValidatedCertificate` — deprecated, but it keeps the
   * whole site in one stack and one deploy.
   *
   * The modern alternative is now open to us (this app pins `env`, so
   * account+region are concrete at synth time): a second, us-east-1-only
   * stack holding an `acm.Certificate`, wired up with
   * `crossRegionReferences: true`. It costs an extra stack in the deploy
   * order for a certificate that is created once and then never changes,
   * which is why it is not the default here.
   */
  private resolveEdgeCertificate(
    scope: Construct,
    domainName: string,
    zone: route53.IHostedZone,
  ): acm.ICertificate {
    const arn: string | undefined = this.node.tryGetContext('cloudfrontCertificateArn');
    if (arn) {
      return acm.Certificate.fromCertificateArn(scope, 'EdgeCertificate', arn);
    }
    return new acm.DnsValidatedCertificate(scope, 'EdgeCertificate', {
      domainName,
      subjectAlternativeNames: [`www.${domainName}`],
      hostedZone: zone,
      region: 'us-east-1',
    });
  }
}

/**
 * `blog.diegopalominos.dev` -> zone `diegopalominos.dev`; an apex domain
 * (`diegopalominos.dev`) maps to itself.
 */
function inferZoneName(domainName: string): string {
  const labels = domainName.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : domainName;
}
