import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, CfnOutput, Duration, RemovalPolicy, StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct, IConstruct } from 'constructs';
import {
  EXPECTED_ACCOUNT as FENCE_EXPECTED_ACCOUNT,
  FencedStack,
  resolveProtectedStackPrefixes,
} from './constructs/fenced-stack';
import { panelMeta } from './constructs/panel-meta';
import { applyProjectTags, COST_TAG_KEY, COST_TAG_VALUE } from './constructs/project-tags';
import { Diagram, Manifest, ManifestResource } from './control/types';

/** Panel group for the control plane's own resources. */
export const CONTROL_APP_KEY = 'diego-control';
/** Panel group of the resources the playground drives (the site stack). */
export const SITE_APP_KEY = 'diego-site';
/** SSM namespace the panel's own pipeline reads: /<app>/<env>/<component>. */
export const CONTROL_SSM_PREFIX = '/diego/prod/control';
/** Log group for the control Lambda — same path shape as the SSM namespace. */
export const CONTROL_LOG_GROUP = '/diego/prod/control';
/** Physical-name prefix for everything in this stack (F5). */
export const CONTROL_PREFIX = 'diego-control-';
/** Apex domain; the panel lives on `control.<domain>`. */
export const DEFAULT_DOMAIN_NAME = 'diegopalominos.dev';
/**
 * The account this playground is fenced to (F1). It may also host unrelated
 * production workloads, which is exactly why every guardrail in this file
 * exists. Never hardcoded: set it with `-c expectedAccount=<id>` or
 * `CDK_EXPECTED_ACCOUNT` — deliberately, never by accident.
 */
export const EXPECTED_ACCOUNT = FENCE_EXPECTED_ACCOUNT;
/** Visitor-created schedules are capped at this many (G5). */
export const MAX_RULES = 10;
/** Auto-off after this long (G4), override with `-c maxOnMinutes=<n>`. */
export const DEFAULT_MAX_ON_MINUTES = 180;
/** Monthly budget in USD (F7), override with `-c budgetUsd=<n>`. */
export const DEFAULT_BUDGET_USD = 40;
/** Every visitor schedule is stored under this name prefix (G5/F5). */
export const RULE_PREFIX = CONTROL_PREFIX;
/** The Angular panel's dev server, allowed alongside the real origin (G6). */
export const PANEL_DEV_ORIGIN = 'http://localhost:4200';
/** Steady-state request rate / burst for the whole API (G3). */
export const API_RATE_LIMIT = 5;
export const API_BURST_LIMIT = 20;
/** Reserved concurrency: a bored visitor cannot fan out AWS calls (G3). */
export const API_RESERVED_CONCURRENCY = 5;

/**
 * Cost-allocation tag the monthly budget filters on (F6/F7). Defined once in
 * `constructs/project-tags.ts` and re-exported here so the budget and the tags
 * can never drift apart.
 */
export const PROJECT_TAG = COST_TAG_VALUE;

/** Routes the control API exposes. Anything else 404s or 501s honestly. */
const ROUTES: Array<{ method: apigwv2.HttpMethod; path: string }> = [
  { method: apigwv2.HttpMethod.GET, path: '/manifest' },
  { method: apigwv2.HttpMethod.GET, path: '/status' },
  { method: apigwv2.HttpMethod.POST, path: '/power' },
  { method: apigwv2.HttpMethod.GET, path: '/rules' },
  { method: apigwv2.HttpMethod.POST, path: '/rules' },
  { method: apigwv2.HttpMethod.POST, path: '/rules/delete' },
  { method: apigwv2.HttpMethod.POST, path: '/rules/toggle' },
  { method: apigwv2.HttpMethod.GET, path: '/diagram' },
  { method: apigwv2.HttpMethod.GET, path: '/diag' },
  { method: apigwv2.HttpMethod.GET, path: '/activity' },
];

/** Per-route throttles for the mutating routes (G3). */
const MUTATING_ROUTE_KEYS = ['POST /power', 'POST /rules', 'POST /rules/delete', 'POST /rules/toggle'];

/**
 * Props for the control stack.
 *
 * Structurally compatible with `src/control-stack-contract.ts`, the seam
 * `src/main.ts` builds from the site stack: the resource handles arrive as
 * objects (never strings) so the Lambda's IAM policy can be pinned to
 * `service.serviceArn` / `database.instanceArn` / `cluster.clusterArn` (G1).
 * The aliases exist so either spelling works while the two stacks are authored
 * in parallel.
 */
export interface DiegoControlStackProps extends StackProps {
  /** The one service the playground may scale between 0 and 1. */
  readonly service: ecs.FargateService;
  /** Cluster hosting it — scopes ecs:ListTasks / ecs:DescribeTasks. */
  readonly cluster: ecs.ICluster;
  /** The one database the playground may start/stop. */
  readonly dbInstance?: rds.IDatabaseInstance;
  /** Alias of `dbInstance` (the app wires the site stack's `database`). */
  readonly database?: rds.IDatabaseInstance;
  /** Apex domain; the panel is published at `control.<domainName>`. */
  readonly domainName?: string;
  /** Alias of `domainName` (the app passes the site's resolved domain). */
  readonly siteDomainName?: string;
  /** Full host for the panel, e.g. `control.diegopalominos.dev`. */
  readonly controlDomainName?: string;
  /** Where the site itself is reachable — shown by the panel as "the lights". */
  readonly siteUrl?: string;
  /** Route53 zone id for the panel host; without it DNS/TLS stays off. */
  readonly hostedZoneId?: string;
}

/**
 * control.diegopalominos.dev — the public playground.
 *
 * Visitors flip the site's infrastructure on and off from a browser, with no
 * login: "it's like turning lights on or off". Everything that makes that
 * safe is in here.
 *
 * | scope       | contents |
 * | ----------- | -------- |
 * | `control`   | the control Lambda, its LogGroup, its role + permissions boundary, the throttled HTTP API |
 * | `schedules` | the dedicated EventBridge Scheduler group + the invoke role for visitor rules |
 * | `activity`  | the DynamoDB "who flipped the lights" feed (30-day TTL) |
 * | `ops`       | the 15-minute auto-off watchdog and the nightly lights-out rule |
 * | `panel`     | S3 + CloudFront + Route53 hosting for the Angular panel build |
 * | `guard`     | budget, billing alarm and the boundary policy that fences this stack in a shared account |
 *
 * Guardrails, all asserted in `test/diego-control-stack.test.ts`:
 * G1 least-privilege IAM (no `Resource: '*'` on the power actions) ·
 * G2 desiredCount clamped to 0|1, no destructive endpoint exists ·
 * G3 route throttling + reserved concurrency · G4 auto-off watchdog ·
 * G5 capped, prefixed schedules in their own group · G6 CORS allow-list ·
 * G7 activity feed with hashed actors.
 *
 * Same-account fencing (F1-F7) matters even more: this account may also host
 * unrelated production workloads. The account guard, the permissions boundary,
 * the explicit denies, the dedicated network rule, the `diego-` name prefixes,
 * the cost tags and the budget are what make sharing the account defensible.
 */
export class DiegoControlStack extends FencedStack {
  /** The always-on control API the panel talks to. */
  public readonly api: apigwv2.HttpApi;
  /** The Lambda implementing manifest/status/power/rules/diagram/diag/activity. */
  public readonly controlFunction: lambdaNodejs.NodejsFunction;
  /** Private bucket holding the Angular panel build (published by its own pipeline). */
  public readonly panelBucket: s3.Bucket;
  /** The only public entry to the panel. */
  public readonly panelDistribution: cloudfront.Distribution;
  /** The public "who flipped the lights" feed. */
  public readonly activityTable: dynamodb.Table;
  /** Where a visitor should point their browser. */
  public readonly panelUrl: string;
  /** Base URL of the control API (also published to SSM for the panel build). */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: DiegoControlStackProps) {
    super(scope, id, props);

    // ── fencing, before a single resource exists ────────────────────────
    // F1 (the account guard) runs in `FencedStack`'s constructor, i.e. above
    // this line: a stack that resolved to an unexpected account never gets
    // this far. F4 is this stack's own rule.
    assertDedicatedNetwork(this);

    // F6: cost allocation / filtering / future SCP work. Applied at the App
    // level by `main.ts` too; repeated here so the stack carries the tags even
    // when it is instantiated on its own (tests, or a one-stack synth).
    applyProjectTags(this);

    const service = props.service;
    const cluster = props.cluster;
    const database = props.dbInstance ?? props.database;
    if (!database) {
      throw new Error('DiegoControlStack needs the site database: pass `dbInstance` (or `database`) from the site stack.');
    }

    const domainName: string = props.domainName ?? props.siteDomainName
      ?? this.node.tryGetContext('domainName') ?? DEFAULT_DOMAIN_NAME;
    const controlHost: string = props.controlDomainName
      ?? this.node.tryGetContext('controlDomainName') ?? `control.${domainName}`;
    const siteUrl: string = props.siteUrl ?? `https://${domainName}`;
    const zone = this.resolveHostedZone(controlHost, props.hostedZoneId);
    const maxOnMinutes = numberContext(this, 'maxOnMinutes', DEFAULT_MAX_ON_MINUTES);
    const budgetUsd = numberContext(this, 'budgetUsd', DEFAULT_BUDGET_USD);
    const budgetEmail: string | undefined = this.node.tryGetContext('budgetEmail')
      ?? this.node.tryGetContext('notificationEmail');

    // The panel's real origin is always allow-listed, even when this synth has
    // no DNS: the panel is published there and nowhere else (G6).
    const allowedOrigins = [`https://${controlHost}`, PANEL_DEV_ORIGIN];

    const scheduleGroupName = `${CONTROL_PREFIX}visitor`;
    const functionName = `${CONTROL_PREFIX}api`;
    // Built from the fixed name so the scheduler role and the function can
    // reference each other without a CloudFormation cycle.
    const controlFunctionArn = `arn:${this.partition}:lambda:${this.region}:${this.account}:function:${functionName}`;
    const scheduleGroupArn = `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule-group/${scheduleGroupName}`;
    const scheduleArnPattern = `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule/${scheduleGroupName}/*`;

    // ── activity feed (G7) ──────────────────────────────────────────────
    const activityScope = new Construct(this, 'activity');
    const activityTable = new dynamodb.Table(activityScope, 'Table', {
      tableName: `${CONTROL_PREFIX}activity`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // 30-day horizon: the feed is a demo artefact, not an audit archive.
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.activityTable = activityTable;

    // ── schedules (G5) ──────────────────────────────────────────────────
    const schedulesScope = new Construct(this, 'schedules');
    const scheduleGroup = new scheduler.CfnScheduleGroup(schedulesScope, 'Group', { name: scheduleGroupName });
    const schedulerRole = new iam.Role(schedulesScope, 'InvokeRole', {
      roleName: `${CONTROL_PREFIX}scheduler`,
      description: 'Lets EventBridge Scheduler invoke the control Lambda for visitor schedules',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': scheduleArnPattern },
        },
      }),
    });
    schedulerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeControlFunctionOnly',
      actions: ['lambda:InvokeFunction'],
      resources: [controlFunctionArn],
    }));

    // ── the control plane itself ────────────────────────────────────────
    // Scope id `control` is the panel key for this resource group.
    const controlScope = new Construct(this, 'control');

    const controlLogGroup = new logs.LogGroup(controlScope, 'Logs', {
      logGroupName: CONTROL_LOG_GROUP,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const allowStatements = () => [
      // G1: exactly one service, by ARN. No wildcard, ever.
      new iam.PolicyStatement({
        sid: 'PowerTheOneSiteService',
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [service.serviceArn],
      }),
      // Task inspection (the watchdog's "how long has it been on?") is
      // confined to the site cluster by both ARN and condition key.
      new iam.PolicyStatement({
        sid: 'InspectTasksInTheSiteClusterOnly',
        actions: ['ecs:ListTasks', 'ecs:DescribeTasks'],
        resources: [
          cluster.clusterArn,
          `arn:${this.partition}:ecs:${this.region}:${this.account}:task/${cluster.clusterName}/*`,
          `arn:${this.partition}:ecs:${this.region}:${this.account}:container-instance/${cluster.clusterName}/*`,
        ],
        conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
      }),
      // G1: exactly one database instance, by ARN.
      new iam.PolicyStatement({
        sid: 'PowerTheOneSiteDatabase',
        actions: ['rds:StartDBInstance', 'rds:StopDBInstance', 'rds:DescribeDBInstances'],
        resources: [database.instanceArn],
      }),
      // G1/G5: scheduler access never leaves this stack's own group.
      new iam.PolicyStatement({
        sid: 'ManageVisitorSchedulesInOwnGroupOnly',
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
          'scheduler:ListSchedules',
        ],
        resources: [scheduleArnPattern, scheduleGroupArn],
      }),
      new iam.PolicyStatement({
        sid: 'PassOnlyTheSchedulerRole',
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
      // G7: the activity feed, read + append only. No Scan, no Delete.
      new iam.PolicyStatement({
        sid: 'ActivityFeedAppendAndRead',
        actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'],
        resources: [activityTable.tableArn],
      }),
      // Its own log group only — no managed policy, no logs:* on '*'.
      new iam.PolicyStatement({
        sid: 'WriteOwnLogsOnly',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [controlLogGroup.logGroupArn],
      }),
    ];

    const denyStatements = () => buildDenyStatements({
      protectedStackPrefixes: resolveProtectedStackPrefixes(this),
      partition: this.partition,
      region: this.region,
      account: this.account,
      serviceArn: service.serviceArn,
      databaseArn: database.instanceArn,
      schedulerRoleArn: schedulerRole.roleArn,
      scheduleArnPattern,
      scheduleGroupArn,
    });

    // F2: the second wall. Effective permissions are identity ∩ boundary, so
    // a future edit that widens the identity policy still cannot reach past
    // these actions and ARNs; F3's explicit denies then beat any allow.
    const guardScope = new Construct(this, 'guard');
    const boundary = new iam.ManagedPolicy(guardScope, 'ControlBoundary', {
      managedPolicyName: `${CONTROL_PREFIX}boundary`,
      description: 'Permissions boundary for the public playground control Lambda: '
        + 'only this stack\'s ECS/RDS/Scheduler/DynamoDB/Logs actions, and never anything named as protected.',
      statements: [...allowStatements(), ...denyStatements()],
    });

    const controlRole = new iam.Role(controlScope, 'Role', {
      roleName: `${CONTROL_PREFIX}api-role`,
      description: 'Execution role for the public control Lambda (least privilege + permissions boundary)',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: boundary,
    });
    for (const statement of [...allowStatements(), ...denyStatements()]) {
      controlRole.addToPolicy(statement);
    }

    const manifest = buildManifest({
      service,
      cluster,
      database,
      controlLogGroupName: controlLogGroup.logGroupName,
      siteUrl,
    });
    const diagram = buildDiagram(manifest, controlHost, domainName);

    this.controlFunction = new lambdaNodejs.NodejsFunction(controlScope, 'Api', {
      functionName,
      description: 'control.diegopalominos.dev — public power/schedule plane for the diego-site stack',
      entry: resolveEntry(),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      role: controlRole,
      logGroup: controlLogGroup,
      // G3: even if the API throttle were removed, the blast radius of a
      // scripted visitor is five concurrent invocations.
      reservedConcurrentExecutions: API_RESERVED_CONCURRENCY,
      environment: {
        MANIFEST: JSON.stringify(manifest),
        DIAGRAM: JSON.stringify(diagram),
        SCHEDULE_GROUP: scheduleGroupName,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
        CONTROL_FN_ARN: controlFunctionArn,
        ACTIVITY_TABLE: activityTable.tableName,
        MAX_ON_MINUTES: String(maxOnMinutes),
        MAX_RULES: String(MAX_RULES),
        RULE_PREFIX: RULE_PREFIX,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        // Stable per-stack salt for the hashed actor prefix (G7). Not secret,
        // but unguessable enough that a /24 cannot be brute-forced from the
        // public feed.
        ACTOR_SALT: this.stackId,
        TIMEZONE: this.node.tryGetContext('timezone') ?? 'America/Santiago',
        PANEL_URL: `https://${controlHost}`,
        SITE_URL: siteUrl,
      },
      bundling: {
        // The Node 22 runtime ships the AWS SDK v3; keeping it external means
        // no vendored SDK, a small bundle and an offline-friendly synth.
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: false,
        target: 'node22',
      },
    });

    // ── HTTP API: throttled (G3), CORS-restricted (G6) ──────────────────
    const api = new apigwv2.HttpApi(controlScope, 'HttpApi', {
      apiName: `${CONTROL_PREFIX}api`,
      description: 'Public control plane for diegopalominos.dev (anonymous by design, throttled and fenced)',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.minutes(10),
      },
    });
    this.api = api;

    const integration = new apigwv2Integrations.HttpLambdaIntegration('ControlIntegration', this.controlFunction);
    for (const route of ROUTES) {
      api.addRoutes({ path: route.path, methods: [route.method], integration });
    }
    // Catch-all so the panel's unimplemented calls (logs, pipelines, drift)
    // reach the handler and get an honest 501 payload instead of an API
    // Gateway error page. It adds no capability: the handler owns the surface.
    api.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration });
    api.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.GET], integration });

    const stage = new apigwv2.HttpStage(controlScope, 'Stage', {
      httpApi: api,
      autoDeploy: true,
      description: 'Public playground stage',
      throttle: { burstLimit: API_BURST_LIMIT, rateLimit: API_RATE_LIMIT },
      /*
       * Detailed metrics are deliberately NOT enabled stage-wide.
       *
       * They add the `Route` dimension, and API Gateway bills those per-route
       * series as CloudWatch CUSTOM metrics (~$0.30 per metric per month,
       * prorated hourly). Stage-wide that is ~6 metrics x 12 routes — and the
       * routes that would publish every single hour are exactly the ones the
       * panel polls (`GET /status`), so the bill would scale with idle
       * page-views on a stack whose entire point is a small, predictable cost
       * floor. API-level metrics (no Route dimension) stay on and are free.
       *
       * They ARE switched on below for the four mutating routes, where the
       * per-route signal is worth paying for (spotting a visitor hammering
       * `POST /power`) and traffic is rare enough to cost cents.
       */
    });
    // Per-route throttling on the mutating routes: the L2 only exposes stage
    // defaults, so the route map goes on through the L1 as raw CloudFormation
    // (route keys such as `POST /power` are not valid CDK property names).
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    for (const routeKey of MUTATING_ROUTE_KEYS) {
      cfnStage.addPropertyOverride(`RouteSettings.${routeKey}.ThrottlingBurstLimit`, 5);
      cfnStage.addPropertyOverride(`RouteSettings.${routeKey}.ThrottlingRateLimit`, 1);
      cfnStage.addPropertyOverride(`RouteSettings.${routeKey}.DetailedMetricsEnabled`, true);
    }

    this.apiUrl = api.apiEndpoint;

    // ── watchdog + nightly lights-out (G4) ──────────────────────────────
    const opsScope = new Construct(this, 'ops');
    const watchdogRule = new events.Rule(opsScope, 'Watchdog', {
      ruleName: `${CONTROL_PREFIX}watchdog`,
      description: `Every 15 minutes: power everything off when it has been on for more than ${maxOnMinutes} minutes`,
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new eventsTargets.LambdaFunction(this.controlFunction, {
        event: events.RuleTargetInput.fromObject({ mode: 'watchdog' }),
      })],
    });
    const lightsOutRule = new events.Rule(opsScope, 'LightsOut', {
      ruleName: `${CONTROL_PREFIX}lights-out`,
      description: 'Nightly unconditional lights-out (05:00 UTC / 01:00 America/Santiago)',
      schedule: events.Schedule.cron({ minute: '0', hour: '5' }),
      targets: [new eventsTargets.LambdaFunction(this.controlFunction, {
        event: events.RuleTargetInput.fromObject({ mode: 'lights-out' }),
      })],
    });

    // ── panel hosting (S3 + CloudFront + Route53) ───────────────────────
    const panelScope = new Construct(this, 'panel');
    const panelBucket = new s3.Bucket(panelScope, 'Bucket', {
      bucketName: `${CONTROL_PREFIX}panel-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      publicReadAccess: false,
      // RETAIN keeps an auto-delete custom resource (and its broad bucket
      // policy) out of a stack whose whole point is least privilege.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.panelBucket = panelBucket;

    const panelDistribution = new cloudfront.Distribution(panelScope, 'Distribution', {
      comment: 'control.diegopalominos.dev — public ops playground',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(panelBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      // Angular SPA routing. Unlike the site distribution there is no API
      // behavior here, so a distribution-wide rewrite is harmless.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
      ...(zone
        ? { domainNames: [controlHost], certificate: this.resolveEdgeCertificate(panelScope, controlHost, zone) }
        : {}),
    });
    this.panelDistribution = panelDistribution;

    if (zone) {
      const target = route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(panelDistribution));
      new route53.ARecord(panelScope, 'Alias', { zone, recordName: controlHost, target });
      new route53.AaaaRecord(panelScope, 'AliasV6', { zone, recordName: controlHost, target });
    } else {
      Annotations.of(this).addInfo(
        `DNS/TLS disabled for ${controlHost}: pass -c hostedZoneId=<Z...> (or -c hostedZoneLookup=true with credentials). `
        + 'Synthesizing with the CloudFront default domain.',
      );
    }
    this.panelUrl = zone ? `https://${controlHost}` : `https://${panelDistribution.distributionDomainName}`;

    // The panel build ships from its own private repo/pipeline; publish the
    // three things that pipeline needs and nothing else.
    new ssm.StringParameter(panelScope, 'BucketParam', {
      parameterName: `${CONTROL_SSM_PREFIX}/bucket`,
      stringValue: panelBucket.bucketName,
    });
    new ssm.StringParameter(panelScope, 'DistributionIdParam', {
      parameterName: `${CONTROL_SSM_PREFIX}/distributionId`,
      stringValue: panelDistribution.distributionId,
    });
    new ssm.StringParameter(panelScope, 'ApiUrlParam', {
      parameterName: `${CONTROL_SSM_PREFIX}/apiUrl`,
      stringValue: this.apiUrl,
    });

    // ── budget + billing alarm (F7) ─────────────────────────────────────
    const budgetNotifications = budgetEmail
      ? [80, 100].map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: budgetEmail }],
      }))
      : undefined;
    if (!budgetEmail) {
      Annotations.of(this).addInfo(
        'No -c budgetEmail=<address>: the monthly budget is created without alert subscribers. '
        + 'Pass one so 80% / 100% of the cap actually reaches a human.',
      );
    }
    new budgets.CfnBudget(guardScope, 'MonthlyBudget', {
      budget: {
        budgetName: `${PROJECT_TAG}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetUsd, unit: 'USD' },
        // Scoped BY TAG (F6/F7): only what this project tags as its own.
        costFilters: { TagKeyValue: [`user:${COST_TAG_KEY}$${COST_TAG_VALUE}`] },
      },
      notificationsWithSubscribers: budgetNotifications,
    });

    // AWS/Billing metrics only exist in us-east-1 — the target region for this
    // account. In any other region the alarm simply never has data.
    const billingAlarm = new cloudwatch.Alarm(guardScope, 'BillingAlarm', {
      alarmName: `${CONTROL_PREFIX}estimated-charges`,
      alarmDescription: `Estimated charges for the account passed $${budgetUsd} — check the playground is not stuck on`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Billing',
        metricName: 'EstimatedCharges',
        dimensionsMap: { Currency: 'USD' },
        statistic: 'Maximum',
        period: Duration.hours(6),
      }),
      threshold: budgetUsd,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (budgetEmail) {
      const alarmTopic = new sns.Topic(guardScope, 'BillingAlarmTopic', {
        topicName: `${CONTROL_PREFIX}billing-alerts`,
        displayName: 'diego-site billing alerts',
      });
      alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(budgetEmail));
      billingAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    }

    // ── panel metadata (the panel groups these apart from other stacks) ─
    panelMeta(this.controlFunction, {
      category: 'ops',
      group: CONTROL_APP_KEY,
      label: 'Control plane (public)',
    });
    panelMeta(controlLogGroup, { category: 'logs', group: CONTROL_APP_KEY, label: 'Control plane logs' });
    panelMeta(api, {
      category: 'edge',
      group: CONTROL_APP_KEY,
      label: 'Control API',
      public: { protocol: 'HTTPS', port: 443, from: 'Web' },
    });
    panelMeta(panelDistribution, {
      category: 'cdn',
      group: CONTROL_APP_KEY,
      label: controlHost,
      public: { protocol: 'HTTPS', port: 443, from: 'Web' },
    });
    panelMeta(panelBucket, { category: 'storage', group: CONTROL_APP_KEY, label: 'Panel build (private, OAC)' });
    panelMeta(activityTable, { category: 'database', group: CONTROL_APP_KEY, label: 'Activity feed (30-day TTL)' });
    panelMeta(scheduleGroup, { category: 'ops', group: CONTROL_APP_KEY, label: 'Visitor schedules' });
    panelMeta(watchdogRule, { category: 'ops', group: CONTROL_APP_KEY, label: `Auto-off after ${maxOnMinutes} min` });
    panelMeta(lightsOutRule, { category: 'ops', group: CONTROL_APP_KEY, label: 'Nightly lights-out' });
    panelMeta(boundary, { category: 'security', group: CONTROL_APP_KEY, label: 'Control permissions boundary' });

    // ── outputs ─────────────────────────────────────────────────────────
    new CfnOutput(this, 'ControlPanelUrl', { value: this.panelUrl });
    new CfnOutput(this, 'ControlApiUrl', { value: this.apiUrl });
    new CfnOutput(this, 'PanelBucketName', { value: panelBucket.bucketName });
    new CfnOutput(this, 'PanelDistributionId', { value: panelDistribution.distributionId });
    new CfnOutput(this, 'ActivityTableName', { value: activityTable.tableName });
    new CfnOutput(this, 'ScheduleGroupName', { value: scheduleGroupName });
  }

  /**
   * `hostedZoneId` (prop or context) -> attribute import, credential-free.
   * Context `hostedZoneLookup=true` -> Route53 lookup (needs env +
   * credentials). Neither -> no DNS/TLS this synth, so `cdk synth` still
   * works with no AWS account at all.
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
   * CloudFront viewer certificates must live in us-east-1 whatever region the
   * stack targets. Context `controlCertificateArn` is the no-custom-resource
   * path; otherwise `DnsValidatedCertificate` pins the region, the same
   * trade-off the site stack makes.
   */
  private resolveEdgeCertificate(scope: Construct, host: string, zone: route53.IHostedZone): acm.ICertificate {
    const arn: string | undefined = this.node.tryGetContext('controlCertificateArn');
    if (arn) {
      return acm.Certificate.fromCertificateArn(scope, 'Certificate', arn);
    }
    return new acm.DnsValidatedCertificate(scope, 'Certificate', {
      domainName: host,
      hostedZone: zone,
      region: 'us-east-1',
    });
  }
}

/**
 * F4 — the network fence.
 *
 * The playground never joins an existing VPC: a stranger-operated demo must
 * not share a network with production. Supplying `vpcId` is treated as a
 * mistake worth stopping the synth for.
 */
export function assertDedicatedNetwork(scope: Construct): void {
  const vpcId: string | undefined = scope.node.tryGetContext('vpcId');
  if (vpcId) {
    throw new Error(
      `Refusing to synthesize: context vpcId=${vpcId} was supplied. The public playground must never share a `
      + 'network with production (other workloads may run in this same account). Drop -c vpcId and let the site stack '
      + 'create its own minimal 2-AZ VPC; the control plane itself runs outside any VPC.',
    );
  }
}

interface DenyContext {
  readonly partition: string;
  readonly region: string;
  readonly account: string;
  readonly serviceArn: string;
  readonly databaseArn: string;
  readonly schedulerRoleArn: string;
  readonly scheduleArnPattern: string;
  readonly scheduleGroupArn: string;
  /**
   * Name fragments of co-resident production stacks to deny by name. Supplied
   * through `-c protectedStackPrefixes=a,b` (or `CDK_PROTECTED_STACK_PREFIXES`)
   * so no production stack name ships in source. Empty simply adds no
   * name-based deny — the ARN-scoped allow list is still the primary fence.
   */
  readonly protectedStackPrefixes?: string[];
}

/**
 * F3 — explicit denies. Deny beats allow everywhere in IAM, so these hold
 * even if a future edit widens the identity policy, and they are attached to
 * BOTH the role and the permissions boundary.
 */
export function buildDenyStatements(ctx: DenyContext): iam.PolicyStatement[] {
  const protectedPrefixes = ctx.protectedStackPrefixes ?? [];
  const protectedArnPatterns = protectedPrefixes.map(
    (prefix) => `arn:${ctx.partition}:*:*:*:*${prefix}*`,
  );

  return [
    ...(protectedArnPatterns.length > 0
      ? [new iam.PolicyStatement({
        sid: 'DenyAnythingNamedProtectedProduction',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: protectedArnPatterns,
      })]
      : []),
    new iam.PolicyStatement({
      sid: 'DenyIdentityAndOrgControl',
      effect: iam.Effect.DENY,
      actions: ['organizations:*', 'account:*', 'sts:AssumeRole', 'sts:AssumeRoleWithWebIdentity', 'sts:AssumeRoleWithSAML'],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      // iam:PassRole on the scheduler role is the one IAM action this Lambda
      // legitimately needs; everything else in IAM is denied outright.
      sid: 'DenyIamExceptPassingTheSchedulerRole',
      effect: iam.Effect.DENY,
      actions: ['iam:*'],
      notResources: [ctx.schedulerRoleArn],
    }),
    new iam.PolicyStatement({
      sid: 'DenyStackMutations',
      effect: iam.Effect.DENY,
      actions: [
        'cloudformation:DeleteStack',
        'cloudformation:UpdateStack',
        'cloudformation:CreateStack',
        'cloudformation:SetStackPolicy',
        'cloudformation:CreateChangeSet',
        'cloudformation:ExecuteChangeSet',
      ],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      sid: 'DenyDatabaseDestruction',
      effect: iam.Effect.DENY,
      actions: [
        'rds:DeleteDBInstance',
        'rds:DeleteDBCluster',
        'rds:DeleteDBSnapshot',
        'rds:RestoreDBInstanceFromDBSnapshot',
        'rds:RestoreDBInstanceFromS3',
        'rds:RestoreDBInstanceToPointInTime',
        'rds:RestoreDBClusterFromSnapshot',
      ],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      sid: 'DenyDatabaseChangesOutsideThisStack',
      effect: iam.Effect.DENY,
      actions: ['rds:ModifyDBInstance', 'rds:CreateDBSnapshot', 'rds:RebootDBInstance', 'rds:StartDBInstance', 'rds:StopDBInstance'],
      notResources: [ctx.databaseArn],
    }),
    new iam.PolicyStatement({
      sid: 'DenyEcsTopologyChanges',
      effect: iam.Effect.DENY,
      actions: [
        'ecs:DeleteService',
        'ecs:CreateService',
        'ecs:UpdateCluster',
        'ecs:DeleteCluster',
        'ecs:CreateCluster',
        'ecs:RegisterTaskDefinition',
        'ecs:DeregisterTaskDefinition',
        'ecs:RunTask',
        'ecs:StartTask',
      ],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      sid: 'DenyEcsServiceUpdatesOutsideThisStack',
      effect: iam.Effect.DENY,
      actions: ['ecs:UpdateService'],
      notResources: [ctx.serviceArn],
    }),
    new iam.PolicyStatement({
      sid: 'DenySchedulerOutsideOwnGroup',
      effect: iam.Effect.DENY,
      actions: ['scheduler:*'],
      notResources: [ctx.scheduleArnPattern, ctx.scheduleGroupArn],
    }),
    new iam.PolicyStatement({
      sid: 'DenySecretsOutsideOwnPaths',
      effect: iam.Effect.DENY,
      actions: ['secretsmanager:*'],
      notResources: [`arn:${ctx.partition}:secretsmanager:${ctx.region}:${ctx.account}:secret:${CONTROL_PREFIX}*`],
    }),
    new iam.PolicyStatement({
      sid: 'DenySsmOutsideOwnPaths',
      effect: iam.Effect.DENY,
      actions: ['ssm:*'],
      notResources: [`arn:${ctx.partition}:ssm:${ctx.region}:${ctx.account}:parameter${CONTROL_SSM_PREFIX}/*`],
    }),
  ];
}

interface ManifestInput {
  readonly service: ecs.FargateService;
  readonly cluster: ecs.ICluster;
  readonly database: rds.IDatabaseInstance;
  readonly controlLogGroupName: string;
  readonly siteUrl: string;
}

/**
 * Build the panel manifest.
 *
 * The panel keys come from each resource's PARENT construct id (`blog`,
 * `database`) — the Eleva convention the site stack is shaped around — so the
 * existing Angular panel drives this stack with no changes.
 */
export function buildManifest(input: ManifestInput): Manifest {
  const serviceKey = panelKey(input.service);
  const databaseKey = panelKey(input.database);

  const resources: ManifestResource[] = [
    {
      key: serviceKey,
      name: 'Site API service',
      type: 'ecs',
      powerable: true,
      ecs: {
        cluster: input.cluster.clusterName,
        service: input.service.serviceName,
        onDesired: 1,
      },
      logs: serviceLogGroups(input.service).map((logGroup) => ({ logGroup, format: { type: 'auto' as const } })),
    },
    {
      key: databaseKey,
      name: 'Site PostgreSQL',
      type: 'rds',
      powerable: true,
      rds: { instanceId: input.database.instanceIdentifier },
      logs: [{
        logGroup: `/aws/rds/instance/${input.database.instanceIdentifier}/postgresql`,
        format: { type: 'plain' as const },
      }],
    },
    {
      key: 'control',
      name: 'Control plane',
      type: 'info',
      powerable: false,
      logs: [{ logGroup: input.controlLogGroupName, format: { type: 'auto' as const } }],
    },
  ];

  return {
    env: 'prod',
    app: SITE_APP_KEY,
    publicDemo: true,
    siteUrl: input.siteUrl,
    resources,
  };
}

/**
 * The architecture snapshot served by `GET /diagram`.
 *
 * The private ops panel reads the live CloudFormation template for this;
 * here the same-account fencing denies `cloudformation:GetTemplate`, so the
 * graph is captured at synth time — same shape, no CloudFormation access, and
 * live on/off state is merged in at request time. Node ids match panel keys so
 * that merge is generic.
 */
export function buildDiagram(manifest: Manifest, controlHost: string, siteDomain: string): Diagram {
  const serviceKey = manifest.resources.find((r) => r.type === 'ecs')?.key ?? 'blog';
  const databaseKey = manifest.resources.find((r) => r.type === 'rds')?.key ?? 'database';

  return {
    nodes: [
      { id: 'visitor', label: 'Web', type: 'External::User', cat: 'traffic' },
      { id: 'panel', label: controlHost, type: 'AWS::CloudFront::Distribution', cat: 'edge', group: CONTROL_APP_KEY },
      { id: 'api', label: 'Control API (throttled)', type: 'AWS::ApiGatewayV2::Api', cat: 'edge', group: CONTROL_APP_KEY },
      { id: 'control', label: 'Control Lambda', type: 'AWS::Lambda::Function', cat: 'compute', group: CONTROL_APP_KEY },
      { id: 'activity', label: 'Activity feed', type: 'AWS::DynamoDB::Table', cat: 'database', group: CONTROL_APP_KEY },
      { id: 'schedules', label: 'Visitor schedules', type: 'AWS::Scheduler::ScheduleGroup', cat: 'ops', group: CONTROL_APP_KEY },
      { id: 'watchdog', label: 'Auto-off watchdog', type: 'AWS::Events::Rule', cat: 'ops', group: CONTROL_APP_KEY },
      { id: serviceKey, label: 'Site API service', type: 'AWS::ECS::Service', cat: 'compute', group: SITE_APP_KEY },
      { id: databaseKey, label: 'Site PostgreSQL', type: 'AWS::RDS::DBInstance', cat: 'database', group: SITE_APP_KEY },
      { id: 'site', label: siteDomain, type: 'AWS::CloudFront::Distribution', cat: 'edge', group: SITE_APP_KEY },
    ],
    edges: [
      { from: 'visitor', to: 'panel', label: 'HTTPS · 443', ext: true },
      { from: 'visitor', to: 'site', label: 'HTTPS · 443', ext: true },
      { from: 'panel', to: 'api', label: 'fetch' },
      { from: 'api', to: 'control', label: '5 rps / burst 20' },
      { from: 'control', to: serviceKey, label: 'desiredCount 0 ↔ 1' },
      { from: 'control', to: databaseKey, label: 'start / stop' },
      { from: 'control', to: 'activity', label: 'who flipped the lights' },
      { from: 'control', to: 'schedules', label: 'max 10 rules' },
      { from: 'watchdog', to: 'control', label: 'every 15 min' },
      { from: 'site', to: serviceKey, label: '/api/*' },
      { from: serviceKey, to: databaseKey, label: 'postgres · 5432' },
    ],
  };
}

/** The Eleva panel key: the id of the resource's parent construct. */
function panelKey(resource: IConstruct): string {
  return (resource.node.scope?.node.id ?? resource.node.id).toLowerCase();
}

/** Log groups that live in the same scope as the service (Eleva convention). */
function serviceLogGroups(service: ecs.FargateService): string[] {
  const owner = service.node.scope ?? service;
  return owner.node.findAll()
    .filter((child): child is logs.LogGroup => child instanceof logs.LogGroup)
    .map((group) => group.logGroupName);
}

/**
 * The Lambda entry point. `src/control/index.ts` when running from source
 * (ts-node via cdk.json, or ts-jest), with a fallback for the compiled `lib/`
 * layout so a packaged build bundles the same handler.
 */
function resolveEntry(): string {
  const fromSource = path.join(__dirname, 'control', 'index.ts');
  if (fs.existsSync(fromSource)) return fromSource;
  return path.join(__dirname, '..', 'src', 'control', 'index.ts');
}

function numberContext(scope: Construct, key: string, fallback: number): number {
  const raw = scope.node.tryGetContext(key);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `control.diegopalominos.dev` -> zone `diegopalominos.dev`. */
function inferZoneName(domainName: string): string {
  const labels = domainName.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : domainName;
}
