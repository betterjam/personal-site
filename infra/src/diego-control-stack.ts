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
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
import { MUTATING_ROUTES } from './control/handler';
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
/**
 * G8 — may an ANONYMOUS caller mutate? Default NO.
 *
 * Read-only is the safe default, so a deployment that says nothing gets the
 * private-ops-panel behaviour: anyone may look, only a bearer token may
 * change. The public playground opts in deliberately with
 * `-c allowAnon=true`, because letting visitors flip the lights is that
 * deployment's whole purpose.
 */
export const DEFAULT_ALLOW_ANON = false;
/** Secrets Manager secret holding the bearer token that authorises mutations. */
export const ADMIN_TOKEN_SECRET_NAME = `${CONTROL_PREFIX}admin-token`;
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
  /*
   * P1 — read-only pipelines.
   *
   * `GET /pipelines` is the ONLY pipeline route that exists. `POST
   * /pipelines/run`, `/pipelines/approve` and `/pipelines/subscribe` are
   * deliberately absent: they reach the handler through the catch-all and get
   * the honest refusal payload, and the difference is visible right here in
   * the route table. Nothing on this list can start a deployment.
   */
  { method: apigwv2.HttpMethod.GET, path: '/pipelines' },
];

/**
 * Per-route throttles for the mutating routes (G3).
 *
 * The list comes from the handler itself, which is also the list its G8 token
 * gate protects: the routes that are rate-limited and the routes that require
 * a token are one definition, so a fifth mutating route added later cannot be
 * throttled but left ungated (or the reverse).
 */
const MUTATING_ROUTE_KEYS = MUTATING_ROUTES;

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
  /**
   * ALLOW-LIST: the pipelines the panel may READ. Today that is exactly one —
   * the pipeline that deploys the site — and the Lambda's IAM statement names
   * those ARNs and nothing else. Never `codepipeline:ListPipelines`: this
   * account also runs unrelated production pipelines, and their names must not
   * reach an anonymous page (P3).
   */
  readonly pipelines?: codepipeline.IPipeline[];
  /** Alias of `pipelines` for the single-pipeline case (what the app passes). */
  readonly pipeline?: codepipeline.IPipeline;
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
 * That last part is now a choice, not a property of the stack. `allowAnon`
 * (G8) decides whether a token-less caller may change anything; it defaults
 * to FALSE, so an unqualified deploy is anonymous-read / token-write, and the
 * public playground turns it on with `-c allowAnon=true`.
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
 * G7 activity feed with hashed actors · G8 anonymous mutation is opt-in
 * (`-c allowAnon=true`), and the handler — not the panel — enforces it.
 *
 * The pipeline surface adds three of its own:
 * P1 read-only — `GET /pipelines` is the only pipeline route; run/approve/
 * subscribe are refused honestly and hold no permission ·
 * P2 briefly cached in the Lambda so the panel's polling cannot hammer
 * CodePipeline · P3 an explicit allow-list of pipeline names/ARNs, never
 * `codepipeline:ListPipelines` — the account's production pipelines must stay
 * invisible to a public page.
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

    /*
     * P3 — the pipeline allow-list, built from construct handles (never a
     * hardcoded name): the SAME objects give the Lambda its `PIPELINES`
     * environment value and its IAM statement its resource ARNs, so the two
     * can never drift into "reports a pipeline it may not read" — or, worse,
     * "may read a pipeline it was never handed".
     */
    const allowListedPipelines = dedupePipelines([
      ...(props.pipelines ?? []),
      ...(props.pipeline ? [props.pipeline] : []),
    ]);
    const pipelineNames = allowListedPipelines.map((pipeline) => pipeline.pipelineName);
    const pipelineArns = allowListedPipelines.map((pipeline) => pipeline.pipelineArn);
    if (pipelineArns.length === 0) {
      Annotations.of(this).addInfo(
        'No pipeline was passed to the control stack: GET /pipelines will answer 501 with an honest reason and the '
        + 'role gets no codepipeline permission at all. Pass `pipeline` (or `pipelines`) from the site stack to '
        + 'light up the panel\'s Pipelines page.',
      );
    }

    const domainName: string = props.domainName ?? props.siteDomainName
      ?? this.node.tryGetContext('domainName') ?? DEFAULT_DOMAIN_NAME;
    const controlHost: string = props.controlDomainName
      ?? this.node.tryGetContext('controlDomainName') ?? `control.${domainName}`;
    const siteUrl: string = props.siteUrl ?? `https://${domainName}`;
    const zone = this.resolveHostedZone(controlHost, props.hostedZoneId);
    const maxOnMinutes = numberContext(this, 'maxOnMinutes', DEFAULT_MAX_ON_MINUTES);
    const budgetUsd = numberContext(this, 'budgetUsd', DEFAULT_BUDGET_USD);
    const allowAnon = resolveAllowAnon(this);
    if (allowAnon) {
      Annotations.of(this).addInfo(
        'allowAnon=true: this deployment lets ANY anonymous caller flip the power and edit schedules — that is the '
        + 'public playground\'s point, and the watchdog, the throttles, the 0|1 clamp and the activity feed are what '
        + 'make it safe. Drop the context flag for a read-only deployment where mutations need the '
        + `${ADMIN_TOKEN_SECRET_NAME} bearer token.`,
      );
    }
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

    /*
     * G8 — the token that authorises a mutation when `allowAnon` is false.
     *
     * Same mechanism the site stack already uses for its maintainer API's
     * ADMIN_TOKEN: a Secrets Manager secret with a generated value, so there
     * is nothing to invent, type or paste anywhere. A SEPARATE secret, under
     * this stack's own `diego-control-` prefix (the one path the F3 denies
     * leave open to this role), because the two planes are different trust
     * boundaries — leaking the site's maintainer token must not hand someone
     * the control plane, or the reverse.
     *
     * It exists in BOTH modes. The public playground still wants a way for
     * Diego's own panel to authenticate, and flipping `allowAnon` back to
     * false must not require provisioning a credential in the same deploy
     * that starts demanding it.
     */
    const adminToken = new secretsmanager.Secret(controlScope, 'AdminToken', {
      secretName: ADMIN_TOKEN_SECRET_NAME,
      description: 'Bearer token for mutating routes on the control API when allowAnon is false',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 48,
      },
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
      /*
       * P1/P3: the pipeline surface, in one statement.
       *
       * Two READ actions, on the allow-listed pipeline ARNs only. There is no
       * `codepipeline:ListPipelines` (it is account-wide and would enumerate
       * the co-resident production pipelines), no `StartPipelineExecution` and
       * no `PutApprovalResult` — a stranger cannot deploy or approve, because
       * the permission to do so does not exist. Omitted entirely when no
       * pipeline was passed: no allow-list, no access.
       */
      ...(pipelineArns.length > 0
        ? [new iam.PolicyStatement({
          sid: 'ReadStateOfAllowListedPipelinesOnly',
          actions: ['codepipeline:GetPipelineState', 'codepipeline:ListPipelineExecutions'],
          resources: pipelineArns,
        })]
        : []),
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

    const denyStatements = (protectedServices?: string[]) => buildDenyStatements({
      protectedStackPrefixes: resolveProtectedStackPrefixes(this),
      protectedServices,
      partition: this.partition,
      region: this.region,
      account: this.account,
      serviceArn: service.serviceArn,
      databaseArn: database.instanceArn,
      schedulerRoleArn: schedulerRole.roleArn,
      scheduleArnPattern,
      scheduleGroupArn,
      pipelineArns,
    });

    // F2: the second wall. Effective permissions are identity ∩ boundary, so
    // a future edit that widens the identity policy still cannot reach past
    // these actions and ARNs; F3's explicit denies then beat any allow.
    const guardScope = new Construct(this, 'guard');
    const boundary = new iam.ManagedPolicy(guardScope, 'ControlBoundary', {
      /*
       * Deliberately UNNAMED (F5 makes an exception here).
       *
       * A managed policy is replaced — not updated in place — whenever
       * CloudFormation decides the resource must be recreated, and with a
       * fixed physical name the create-before-delete step collides with the
       * live policy: "A policy called diego-control-boundary already exists".
       * That deadlocks every future deploy of this stack and can only be
       * broken by detaching the boundary from the role by hand, which is
       * exactly the guardrail you least want to remove under pressure.
       * CDK's generated name still carries the stack and construct id.
       */
      description: 'Permissions boundary for the public playground control Lambda: '
        + 'only this stack\'s ECS/RDS/Scheduler/DynamoDB/Logs/CodePipeline-read actions, '
        + 'and never anything named as protected.',
      /*
       * A managed policy is capped at 6,144 characters and this is the app's
       * largest document, so the name-based deny is expanded here only across
       * the services the boundary grants — everywhere else the boundary's own
       * implicit deny is already absolute. See BOUNDARY_PROTECTED_SERVICES.
       */
      statements: [...allowStatements(), ...denyStatements(BOUNDARY_PROTECTED_SERVICES)],
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
      allowAnon,
    });
    const diagram = buildDiagram(manifest, controlHost, domainName, pipelineNames);

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
      /*
       * G3: even if the API throttle were removed, the blast radius of a
       * scripted visitor is capped at this many concurrent invocations.
       *
       * Opt-in, because a reservation is only safe when the account has
       * headroom. AWS refuses any reservation that would drop unreserved
       * concurrency below 10, and an account still on the default limit of
       * 10 therefore cannot reserve at all. Worse, in a shared account a
       * reservation carved out for this public playground comes straight out
       * of the pool the co-resident production functions draw on — the
       * guardrail would become the outage. Raise the account's concurrency
       * quota first, then set `-c reservedConcurrency=5`.
       *
       * Until then the rate ceiling is the API Gateway throttle (G3's stage
       * and per-route limits), which is enforced before Lambda is invoked.
       */
      reservedConcurrentExecutions: resolveReservedConcurrency(this),
      environment: {
        MANIFEST: JSON.stringify(manifest),
        DIAGRAM: JSON.stringify(diagram),
        SCHEDULE_GROUP: scheduleGroupName,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
        CONTROL_FN_ARN: controlFunctionArn,
        ACTIVITY_TABLE: activityTable.tableName,
        /*
         * P3: the allow-list, as names. The handler iterates exactly this list
         * and drops anything else an API hands back; the IAM statement above
         * is built from the same construct handles' ARNs.
         */
        PIPELINES: pipelineNames.join(','),
        MAX_ON_MINUTES: String(maxOnMinutes),
        MAX_RULES: String(MAX_RULES),
        RULE_PREFIX: RULE_PREFIX,
        /*
         * G8: the same value that went into MANIFEST above, so the flag the
         * panel reads and the flag the gate enforces are one decision. The
         * handler treats only the exact string 'true' as opting in.
         */
        ALLOW_ANON: String(allowAnon),
        /*
         * The bearer token, as a `{{resolve:secretsmanager:...}}` dynamic
         * reference — the same trick the site stack uses for DATABASE_URL.
         * CloudFormation substitutes the value at deploy time, so no secret
         * material lands in the synthesized template or in cdk.out, and the
         * handler needs no SDK call (and no secretsmanager permission) on the
         * request path. The trade-off, stated plainly: the resolved value is
         * then readable in the function's configuration by anyone who can
         * already read this account's Lambda config. Rotating it is
         * `update-secret` followed by a redeploy of this stack.
         */
        ADMIN_TOKEN: adminToken.secretValue.unsafeUnwrap(),
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
      description: allowAnon
        ? 'Public control plane for diegopalominos.dev (anonymous mutation by design, throttled and fenced)'
        : 'Public control plane for diegopalominos.dev (anonymous reads, token-gated mutations, throttled and fenced)',
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
    const allRoutes: apigwv2.HttpRoute[] = [];
    for (const route of ROUTES) {
      allRoutes.push(...api.addRoutes({ path: route.path, methods: [route.method], integration }));
    }
    // Catch-all so the panel's unimplemented calls (logs, pipelines, drift)
    // reach the handler and get an honest 501 payload instead of an API
    // Gateway error page. It adds no capability: the handler owns the surface.
    allRoutes.push(...api.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration }));
    allRoutes.push(...api.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.GET], integration }));

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
    // RouteSettings name routes by key (`POST /power`), and API Gateway
    // validates that each key exists when the stage is created. Without this
    // dependency CloudFormation is free to build the stage first and the
    // create fails with "Unable to find Route by key POST /rules/delete".
    for (const route of allRoutes) {
      stage.node.addDependency(route);
    }

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
    panelMeta(adminToken, {
      category: 'secret',
      group: CONTROL_APP_KEY,
      label: allowAnon ? 'Control API token (anonymous mutation is on)' : 'Control API token (required to mutate)',
    });

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
   * The pipelines the panel is allowed to READ. Everything else in
   * CodePipeline — every other pipeline, and every mutating action on this one
   * — is denied. Empty means "deny CodePipeline outright".
   */
  readonly pipelineArns: string[];
  /**
   * Name fragments of co-resident production stacks to deny by name. Supplied
   * through `-c protectedStackPrefixes=a,b` (or `CDK_PROTECTED_STACK_PREFIXES`)
   * so no production stack name ships in source. Empty simply adds no
   * name-based deny — the ARN-scoped allow list is still the primary fence.
   */
  readonly protectedStackPrefixes?: string[];
  /**
   * Services the name-based deny is expanded across. Defaults to
   * `PROTECTED_SERVICES`; the boundary passes `BOUNDARY_PROTECTED_SERVICES`.
   */
  readonly protectedServices?: string[];
}

/**
 * Services the name-based deny (F3) covers on the ROLE's identity policy:
 * everything this control plane could conceivably be edited into reaching.
 */
export const PROTECTED_SERVICES = [
  'cloudformation', 'ecs', 'rds', 'secretsmanager', 'ssm', 'logs',
  'lambda', 'dynamodb', 'events', 'scheduler', 'ecr', 'elasticloadbalancing',
  'cloudfront', 'ec2', 'kms', 'codepipeline',
  /*
   * NOT 'iam'. An IAM ARN's resource must start with a known type
   * (role/, policy/, user/, …), so a bare `*<name>*` glob is rejected at
   * deploy with "IAM resource path must either be *, root, or start with
   * user/, …". Nothing is lost: DenyIamExceptPassingTheSchedulerRole below
   * already denies iam:* on every resource except the one scheduler role,
   * which is strictly stronger than any name-based pattern could be.
   */
  // s3 last: its ARNs carry no region or account, so it gets its own shape.
  's3',
];

/**
 * The same deny, as expanded on the PERMISSIONS BOUNDARY: only the services
 * the boundary actually grants.
 *
 * Not a weakening. A principal is authorized only where its boundary allows,
 * so for every other service the boundary's implicit deny is already total and
 * an extra `arn:aws:s3:::*prod*` pattern in there can never decide anything.
 * It is dropped for a concrete reason: an IAM managed policy is capped at
 * 6,144 characters, this document is by far the app's biggest, and the full
 * prefixes x services cross-product no longer fits beside the pipeline
 * statements. The ROLE keeps the wide list (`PROTECTED_SERVICES`), where it
 * does guard against a future edit widening the identity policy — and a deny
 * on either side is enough, because effective permissions are the
 * intersection of the two.
 */
export const BOUNDARY_PROTECTED_SERVICES = [
  'ecs', 'rds', 'scheduler', 'dynamodb', 'logs', 'codepipeline',
];

/**
 * F3 — explicit denies. Deny beats allow everywhere in IAM, so these hold
 * even if a future edit widens the identity policy, and they are attached to
 * BOTH the role and the permissions boundary.
 */
/**
 * Services whose ARNs are GLOBAL: no region, and for S3 no account either.
 * IAM rejects a region in these outright — `arn:aws:iam:*:*:*name*` fails the
 * deploy with "IAM resource ... cannot contain region information", which
 * synth and template tests cannot catch because only IAM validates ARN shape.
 */
const REGIONLESS_SERVICES = new Set(['iam', 'cloudfront', 'organizations', 'route53', 'waf']);

/** A name-matching ARN pattern for one service, in that service's own shape. */
export function protectedArn(partition: string, service: string, prefix: string): string {
  if (service === 's3') return `arn:${partition}:s3:::*${prefix}*`;
  if (REGIONLESS_SERVICES.has(service)) return `arn:${partition}:${service}::*:*${prefix}*`;
  return `arn:${partition}:${service}:*:*:*${prefix}*`;
}

export function buildDenyStatements(ctx: DenyContext): iam.PolicyStatement[] {
  const protectedPrefixes = ctx.protectedStackPrefixes ?? [];
  /*
   * IAM requires the SERVICE ("vendor") segment of an ARN to be fully
   * qualified — `arn:aws:*:*:*:*name*` is rejected outright with "Resource
   * vendor must be fully qualified and cannot contain regexes". So the
   * name-based deny is expanded per service instead of using one wildcard,
   * covering everything this control plane could conceivably reach. S3 gets
   * its own shape because its ARNs carry no region or account.
   */
  const services = ctx.protectedServices ?? PROTECTED_SERVICES;
  const protectedArnPatterns = protectedPrefixes.flatMap((prefix) =>
    services.map((svc) => protectedArn(ctx.partition, svc, prefix)),
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
    /*
     * P1 — on the allow-listed pipelines, the two reads and NOTHING else.
     *
     * `NotAction` is the compact way to say "everything but these" and it is
     * also the future-proof one: a CodePipeline API released next year is
     * denied the day it ships, without anyone editing this list. It covers
     * every mutation (StartPipelineExecution, PutApprovalResult, Update…) and
     * the reads that would say too much on a public page — GetPipeline (the
     * whole definition: source repo, buildspecs, role ARNs) and the
     * action/execution detail calls (commit messages, console URLs).
     *
     * `NotAction` deserves the usual caution: paired with `Resource: '*'` it
     * would deny this role's ECS and RDS work too. It is pinned to the
     * pipeline ARNs, so it only ever judges requests against those pipelines.
     */
    ...(ctx.pipelineArns.length > 0
      ? [
        new iam.PolicyStatement({
          sid: 'DenyEverythingButStateReadsOnAllowListedPipelines',
          effect: iam.Effect.DENY,
          notActions: ['codepipeline:GetPipelineState', 'codepipeline:ListPipelineExecutions'],
          resources: ctx.pipelineArns,
        }),
        /*
         * P3 — and nothing at all outside the allow-list.
         *
         * `NotResource` also catches the account-wide calls, whose resource is
         * every pipeline rather than one of ours: `codepipeline:ListPipelines`
         * — the call that would enumerate the production pipelines living in
         * this account — is denied here.
         */
        new iam.PolicyStatement({
          sid: 'DenyCodePipelineOutsideTheAllowList',
          effect: iam.Effect.DENY,
          actions: ['codepipeline:*'],
          notResources: ctx.pipelineArns,
        }),
      ]
      // No allow-list, nothing to except: CodePipeline is denied outright.
      : [new iam.PolicyStatement({
        sid: 'DenyCodePipelineEntirely',
        effect: iam.Effect.DENY,
        actions: ['codepipeline:*'],
        resources: ['*'],
      })]),
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
  /** G8: whether anonymous callers may mutate. Defaults to the safe `false`. */
  readonly allowAnon?: boolean;
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

  const allowAnon = input.allowAnon ?? DEFAULT_ALLOW_ANON;
  return {
    env: 'prod',
    app: SITE_APP_KEY,
    // G8, and its pre-flag alias. Both from one value: a manifest that
    // advertised `publicDemo: true` while the gate refused anonymous
    // mutations would send the panel to draw buttons the API then rejects.
    allowAnon,
    publicDemo: allowAnon,
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
export function buildDiagram(
  manifest: Manifest,
  controlHost: string,
  siteDomain: string,
  pipelineNames: string[] = [],
): Diagram {
  const serviceKey = manifest.resources.find((r) => r.type === 'ecs')?.key ?? 'blog';
  const databaseKey = manifest.resources.find((r) => r.type === 'rds')?.key ?? 'database';
  // The diagram is served publicly too, so it shows the allow-listed
  // pipelines and no others — same list the API reports.
  const pipelineId = (index: number) => (index === 0 ? 'pipeline' : `pipeline-${index}`);

  return {
    nodes: [
      ...pipelineNames.map((name, index) => ({
        id: pipelineId(index),
        label: name,
        type: 'AWS::CodePipeline::Pipeline',
        cat: 'pipeline',
        group: SITE_APP_KEY,
      })),
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
      ...pipelineNames.map((_name, index) => ({ from: pipelineId(index), to: serviceKey, label: 'deploy', pipe: true })),
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

/** Same pipeline passed twice (`pipeline` + `pipelines`) is still one entry. */
function dedupePipelines(pipelines: codepipeline.IPipeline[]): codepipeline.IPipeline[] {
  const byArn = new Map<string, codepipeline.IPipeline>();
  for (const pipeline of pipelines) {
    if (!byArn.has(pipeline.pipelineArn)) byArn.set(pipeline.pipelineArn, pipeline);
  }
  return [...byArn.values()];
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

/**
 * Reserved concurrency for the control Lambda (G3), opt-in via
 * `-c reservedConcurrency=<n>` or `CDK_RESERVED_CONCURRENCY`.
 *
 * Returns undefined when unset, which leaves the function on the shared
 * account pool. See the call site for why that is the safe default in an
 * account whose concurrency quota is still the default 10.
 */
/**
 * G8 — may anonymous callers mutate? `-c allowAnon=true|false` (or
 * `CDK_ALLOW_ANON`), defaulting to `DEFAULT_ALLOW_ANON` (false).
 *
 * Anything that is not exactly `true` or `false` throws rather than being
 * coerced. `-c allowAnon=yes` quietly meaning "no" is the kind of near-miss
 * that leaves a deployment locked out — or, in the other direction, open —
 * and neither should be discoverable only in production.
 */
export function resolveAllowAnon(scope: Construct): boolean {
  const raw = scope.node.tryGetContext('allowAnon') ?? process.env.CDK_ALLOW_ANON;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ALLOW_ANON;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new Error(
    `allowAnon must be true or false, got: ${String(raw)}. It decides whether an ANONYMOUS caller may change `
    + 'anything through the control API, so it is never guessed.',
  );
}

export function resolveReservedConcurrency(scope: Construct): number | undefined {
  const raw = scope.node.tryGetContext('reservedConcurrency') ?? process.env.CDK_RESERVED_CONCURRENCY;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`reservedConcurrency must be a positive integer, got: ${String(raw)}`);
  }
  return value;
}
