/* eslint-disable @typescript-eslint/no-require-imports */
import {
  ActivityEntry,
  ActivityPort,
  ControlEnv,
  Deps,
  Diagram,
  EcsPort,
  EcsServiceState,
  Manifest,
  PipelineExecutionSummary,
  PipelinePort,
  PipelineStateSnapshot,
  PowerMarker,
  RdsPort,
  ScheduleRule,
  SchedulePort,
} from './types';

/**
 * Live wiring for the control Lambda.
 *
 * The AWS SDK v3 is `require`d lazily from the Node 22 Lambda runtime rather
 * than imported: esbuild keeps `@aws-sdk/*` external (see the stack's bundling
 * options), so nothing is vendored into the bundle and the handler module can
 * be unit-tested with `node:test` without the SDK installed at all.
 *
 * Every call here maps 1:1 to an action the role is allowed to take on one
 * named resource — there is no generic "call AWS" escape hatch.
 */

const ACTIVITY_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACTIVITY_PK = 'activity';
const STATE_PK = 'state';
const STATE_SK = 'power';

type AnyClient = { send(command: unknown): Promise<any> };

let ecsClient: AnyClient | undefined;
let rdsClient: AnyClient | undefined;
let schedulerClient: AnyClient | undefined;
let dynamoClient: AnyClient | undefined;
let codePipelineClient: AnyClient | undefined;

function ecsSdk() {
  const sdk = require('@aws-sdk/client-ecs');
  ecsClient ??= new sdk.ECSClient({});
  return { sdk, client: ecsClient! };
}

function rdsSdk() {
  const sdk = require('@aws-sdk/client-rds');
  rdsClient ??= new sdk.RDSClient({});
  return { sdk, client: rdsClient! };
}

function schedulerSdk() {
  const sdk = require('@aws-sdk/client-scheduler');
  schedulerClient ??= new sdk.SchedulerClient({});
  return { sdk, client: schedulerClient! };
}

function dynamoSdk() {
  const sdk = require('@aws-sdk/client-dynamodb');
  dynamoClient ??= new sdk.DynamoDBClient({});
  return { sdk, client: dynamoClient! };
}

function codePipelineSdk() {
  const sdk = require('@aws-sdk/client-codepipeline');
  codePipelineClient ??= new sdk.CodePipelineClient({});
  return { sdk, client: codePipelineClient! };
}

/** `a, b,,c` -> `['a','b','c']`, de-duplicated and order-preserving. */
function splitList(raw: string | undefined): string[] {
  const parts = (raw ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return [...new Set(parts)];
}

/** Parse and validate the environment the stack hands to the function. */
export function parseEnv(raw: NodeJS.ProcessEnv = process.env): ControlEnv {
  const manifest = JSON.parse(raw.MANIFEST ?? '{"env":"prod","app":"diego-site","resources":[]}') as Manifest;
  const diagram = JSON.parse(raw.DIAGRAM ?? '{"nodes":[],"edges":[]}') as Diagram;
  return {
    manifest,
    diagram,
    scheduleGroup: raw.SCHEDULE_GROUP ?? 'diego-control-visitor',
    rulePrefix: raw.RULE_PREFIX ?? 'diego-control-',
    maxRules: numberOr(raw.MAX_RULES, 10),
    maxOnMinutes: numberOr(raw.MAX_ON_MINUTES, 180),
    allowedOrigins: splitList(raw.ALLOWED_ORIGINS),
    // The pipeline allow-list. Empty (the default) means `GET /pipelines`
    // reports nothing at all — it never falls back to listing the account.
    pipelines: splitList(raw.PIPELINES),
    actorSalt: raw.ACTOR_SALT ?? 'diego-control',
    timezone: raw.TIMEZONE ?? 'America/Santiago',
    panelUrl: raw.PANEL_URL || undefined,
    siteUrl: raw.SITE_URL || undefined,
    /*
     * G8 — fail closed.
     *
     * Only the exact string 'true' opts anonymous callers into mutating.
     * Missing, empty, 'True', 'yes', or anything else leaves the mutating
     * routes behind the bearer token: a typo in the environment must not be
     * able to open the write surface. The stack validates the context value
     * at synth time as well, so 'yes' never reaches here in the first place.
     */
    allowAnon: raw.ALLOW_ANON === 'true',
    // Injected by CloudFormation from this stack's own Secrets Manager
    // secret. Absent means no mutation can be authorised at all.
    adminToken: raw.ADMIN_TOKEN || undefined,
  };
}

function numberOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ecsPort: EcsPort = {
  async describe(cluster: string, service: string): Promise<EcsServiceState> {
    const { sdk, client } = ecsSdk();
    const out = await client.send(new sdk.DescribeServicesCommand({ cluster, services: [service] }));
    const found = out.services?.[0] ?? {};
    return {
      desired: found.desiredCount ?? 0,
      running: found.runningCount ?? 0,
      pending: found.pendingCount ?? 0,
    };
  },

  async setDesiredCount(cluster: string, service: string, desiredCount: 0 | 1): Promise<void> {
    const { sdk, client } = ecsSdk();
    await client.send(new sdk.UpdateServiceCommand({ cluster, service, desiredCount }));
  },

  async oldestTaskStart(cluster: string, service: string): Promise<number | undefined> {
    const { sdk, client } = ecsSdk();
    const list = await client.send(new sdk.ListTasksCommand({ cluster, serviceName: service, desiredStatus: 'RUNNING' }));
    const arns: string[] = list.taskArns ?? [];
    if (arns.length === 0) return undefined;
    const described = await client.send(new sdk.DescribeTasksCommand({ cluster, tasks: arns }));
    const starts: number[] = (described.tasks ?? [])
      .map((task: { startedAt?: string | Date }) => (task.startedAt ? new Date(task.startedAt).getTime() : NaN))
      .filter((ms: number) => Number.isFinite(ms));
    return starts.length ? Math.min(...starts) : undefined;
  },
};

const rdsPort: RdsPort = {
  async status(instanceId: string): Promise<string> {
    const { sdk, client } = rdsSdk();
    try {
      const out = await client.send(new sdk.DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceId }));
      return out.DBInstances?.[0]?.DBInstanceStatus ?? 'unknown';
    } catch (err) {
      // The identity policy scopes rds:DescribeDBInstances to this one
      // instance ARN (G1). Should RDS reject resource-scoped Describe calls in
      // this account, the demo degrades to "unknown" instead of 500-ing — see
      // the README note on widening just that one statement.
      console.error('describe db instance failed', err);
      return 'unknown';
    }
  },

  async start(instanceId: string): Promise<void> {
    const { sdk, client } = rdsSdk();
    await client.send(new sdk.StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
  },

  async stop(instanceId: string): Promise<void> {
    const { sdk, client } = rdsSdk();
    await client.send(new sdk.StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
  },
};

/**
 * CodePipeline, read-only and one named pipeline at a time.
 *
 * Note what is NOT here: no `ListPipelinesCommand` (that would enumerate an
 * account which also runs production pipelines), no `StartPipelineExecution`,
 * no `PutApprovalResult`. The role's policy is scoped to the allow-listed
 * pipeline ARNs and the boundary denies the rest, so those calls would fail
 * anyway — this module simply never makes them.
 *
 * The mapping also drops two fields the API returns: the approval `token` of a
 * waiting manual-approval action (a bearer credential) and
 * `externalExecutionUrl` (a console link carrying the account id).
 */
const pipelinePort: PipelinePort = {
  async state(name: string): Promise<PipelineStateSnapshot | undefined> {
    const { sdk, client } = codePipelineSdk();
    const out = await client.send(new sdk.GetPipelineStateCommand({ name }));
    if (!out?.pipelineName) return undefined;
    return {
      name: out.pipelineName,
      stages: (out.stageStates ?? []).map((stage: any) => ({
        name: stage.stageName,
        status: stage.latestExecution?.status,
        actions: (stage.actionStates ?? []).map((action: any) => {
          const execution = action.latestExecution ?? {};
          return {
            name: action.actionName,
            status: execution.status,
            lastStatusChange: isoOrUndefined(execution.lastStatusChange),
            // Only a FAILED action's text is carried across. `summary` on a
            // successful source action is the commit message, and nothing here
            // should be one bad edit away from publishing that.
            errorMessage: execution.status === 'Failed'
              ? (execution.errorDetails?.message ?? execution.summary)
              : undefined,
          };
        }),
      })),
    };
  },

  async executions(name: string, limit: number): Promise<PipelineExecutionSummary[]> {
    const { sdk, client } = codePipelineSdk();
    const out = await client.send(new sdk.ListPipelineExecutionsCommand({ pipelineName: name, maxResults: limit }));
    return (out.pipelineExecutionSummaries ?? []).map((execution: any) => ({
      id: execution.pipelineExecutionId,
      status: execution.status,
      startTime: isoOrUndefined(execution.startTime),
      // `statusSummary` explains a stop/supersede. `sourceRevisions` is
      // deliberately not read: it carries commit messages and author trailers,
      // which is more than a pipeline status page needs to say in public.
      summary: execution.status === 'Succeeded' ? undefined : execution.statusSummary,
    }));
  },
};

function isoOrUndefined(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function schedulePort(env: ControlEnv): SchedulePort {
  const group = env.scheduleGroup;
  const target = (rule: ScheduleRule) => ({
    Arn: process.env.CONTROL_FN_ARN,
    RoleArn: process.env.SCHEDULER_ROLE_ARN,
    Input: JSON.stringify({ target: rule.target, state: rule.state, rule: rule.name }),
  });

  const toRule = (detail: any): ScheduleRule => {
    let action: { target?: string; state?: string } = {};
    try {
      action = JSON.parse(detail.Target?.Input ?? '{}');
    } catch {
      action = {};
    }
    return {
      name: detail.Name,
      schedule: detail.ScheduleExpression,
      timezone: detail.ScheduleExpressionTimezone,
      target: action.target ?? 'all',
      state: action.state === 'on' ? 'on' : 'off',
      enabled: detail.State !== 'DISABLED',
    };
  };

  return {
    async list(): Promise<ScheduleRule[]> {
      const { sdk, client } = schedulerSdk();
      const out = await client.send(new sdk.ListSchedulesCommand({ GroupName: group }));
      const rules: ScheduleRule[] = [];
      for (const summary of out.Schedules ?? []) {
        const detail = await client.send(new sdk.GetScheduleCommand({ Name: summary.Name, GroupName: group }));
        rules.push(toRule(detail));
      }
      return rules;
    },

    async get(name: string): Promise<ScheduleRule | undefined> {
      const { sdk, client } = schedulerSdk();
      try {
        return toRule(await client.send(new sdk.GetScheduleCommand({ Name: name, GroupName: group })));
      } catch (err) {
        if ((err as { name?: string }).name === 'ResourceNotFoundException') return undefined;
        throw err;
      }
    },

    async put(rule: ScheduleRule): Promise<void> {
      const { sdk, client } = schedulerSdk();
      const params = {
        Name: rule.name,
        GroupName: group,
        ScheduleExpression: rule.schedule,
        ScheduleExpressionTimezone: rule.timezone ?? env.timezone,
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: target(rule),
        State: rule.enabled ? 'ENABLED' : 'DISABLED',
      };
      try {
        await client.send(new sdk.GetScheduleCommand({ Name: rule.name, GroupName: group }));
        await client.send(new sdk.UpdateScheduleCommand(params));
      } catch (err) {
        if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
        await client.send(new sdk.CreateScheduleCommand(params));
      }
    },

    async remove(name: string): Promise<void> {
      const { sdk, client } = schedulerSdk();
      try {
        await client.send(new sdk.DeleteScheduleCommand({ Name: name, GroupName: group }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
      }
    },
  };
}

function activityPort(tableName: string, now: () => number, id: () => string): ActivityPort {
  return {
    async record(entry: ActivityEntry): Promise<void> {
      const { sdk, client } = dynamoSdk();
      await client.send(new sdk.PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: ACTIVITY_PK },
          sk: { S: `${entry.at}#${id()}` },
          at: { S: entry.at },
          action: { S: entry.action },
          actor: { S: entry.actor },
          result: { S: entry.result },
          ...(entry.target ? { target: { S: entry.target } } : {}),
          ttl: { N: String(Math.floor(now() / 1000) + ACTIVITY_TTL_SECONDS) },
        },
      }));
    },

    async recent(limit: number): Promise<ActivityEntry[]> {
      const { sdk, client } = dynamoSdk();
      const out = await client.send(new sdk.QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: ACTIVITY_PK } },
        ScanIndexForward: false,
        Limit: limit,
      }));
      return (out.Items ?? []).map((item: Record<string, { S?: string }>) => ({
        at: item.at?.S ?? '',
        action: item.action?.S ?? '',
        actor: item.actor?.S ?? '',
        result: item.result?.S ?? '',
        target: item.target?.S,
      }));
    },

    async readMarker(): Promise<PowerMarker | undefined> {
      const { sdk, client } = dynamoSdk();
      const out = await client.send(new sdk.GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: STATE_PK }, sk: { S: STATE_SK } },
      }));
      if (!out.Item) return undefined;
      const onSince = out.Item.onSince?.N;
      return { onSince: onSince ? Number(onSince) : undefined };
    },

    async writeMarker(marker: PowerMarker): Promise<void> {
      const { sdk, client } = dynamoSdk();
      await client.send(new sdk.PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: STATE_PK },
          sk: { S: STATE_SK },
          updatedAt: { S: new Date(now()).toISOString() },
          ...(marker.onSince ? { onSince: { N: String(marker.onSince) } } : {}),
        },
      }));
    },
  };
}

/** Build the production dependency set from the process environment. */
export function liveDeps(raw: NodeJS.ProcessEnv = process.env): Deps {
  const env = parseEnv(raw);
  const now = () => Date.now();
  const id = () => Math.random().toString(36).slice(2, 10);
  return {
    env,
    ecs: ecsPort,
    rds: rdsPort,
    schedules: schedulePort(env),
    activity: activityPort(raw.ACTIVITY_TABLE ?? 'diego-control-activity', now, id),
    pipelines: pipelinePort,
    now,
    id,
  };
}
