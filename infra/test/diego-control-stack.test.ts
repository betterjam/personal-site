import { App, Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { UNCONFIGURED_ACCOUNT_ERROR } from '../src/constructs/fenced-stack';
import { DiegoControlStack, DiegoControlStackProps } from '../src/diego-control-stack';

// A documentation-placeholder account: the real one is never in source — it
// is supplied per invocation as `-c expectedAccount=<id>` (see
// `constructs/fenced-stack.ts`), and these tests do exactly the same.
const ACCOUNT = '123456789012';
/**
 * Stand-in protected stack prefixes. The real ones are supplied through
 * `-c protectedStackPrefixes=` (or CDK_PROTECTED_STACK_PREFIXES) so no
 * production stack name ships in source — see constructs/fenced-stack.ts.
 */
const PROTECTED_PREFIXES = ['acme-prod', 'acme-modular'];
const REGION = 'us-east-1';
const ENV = { account: ACCOUNT, region: REGION };
const HOSTED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';

/**
 * A stand-in for the site stack: the same construct SHAPE that matters to the
 * control plane — a `blog` scope holding the Fargate service and its log
 * group, a `database` scope holding the Postgres instance — so the panel keys
 * (`blog`, `database`) come out of the parent construct ids exactly as they do
 * in production. Using a double keeps these tests independent of the site
 * stack's own evolution.
 */
class SiteDouble extends Stack {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly database: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const database = new Construct(this, 'database');
    this.database = new rds.DatabaseInstance(database, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      storageEncrypted: true,
    });

    const blog = new Construct(this, 'blog');
    this.cluster = new ecs.Cluster(blog, 'Cluster', { vpc });
    const logGroup = new logs.LogGroup(blog, 'ServiceLogs', { retention: logs.RetentionDays.ONE_MONTH });
    const taskDefinition = new ecs.FargateTaskDefinition(blog, 'TaskDefinition', { cpu: 256, memoryLimitMiB: 512 });
    taskDefinition.addContainer('blog', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'blog' }),
    });
    this.service = new ecs.FargateService(blog, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      healthCheckGracePeriod: Duration.seconds(60),
    });
  }
}

interface Built {
  readonly template: Template;
  readonly control: DiegoControlStack;
}

function build(options: {
  context?: Record<string, unknown>;
  env?: { account: string; region: string };
  props?: Partial<DiegoControlStackProps>;
} = {}): Built {
  const app = new App({
    context: {
      expectedAccount: ACCOUNT,
      protectedStackPrefixes: PROTECTED_PREFIXES.join(','),
      budgetEmail: 'alerts@example.com',
      ...options.context,
    },
  });
  const env = options.env === undefined ? ENV : options.env;
  const site = new SiteDouble(app, 'DiegoSiteStack', { env });
  const control = new DiegoControlStack(app, 'DiegoControlStack', {
    env,
    service: site.service,
    cluster: site.cluster,
    dbInstance: site.database,
    hostedZoneId: HOSTED_ZONE_ID,
    ...options.props,
  });
  return { template: Template.fromStack(control), control };
}

interface PolicyStatementJson {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: Record<string, unknown>;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Every policy statement in the template, wherever it is attached. */
function policyStatements(template: Template): PolicyStatementJson[] {
  const found: PolicyStatementJson[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.Statement)) found.push(...(record.Statement as PolicyStatementJson[]));
    Object.values(record).forEach(walk);
  };
  walk(template.toJSON().Resources);
  return found;
}

function statementBySid(template: Template, sid: string): PolicyStatementJson {
  const hit = policyStatements(template).find((s) => s.Sid === sid);
  expect(hit).toBeDefined();
  return hit!;
}

function resourceOfType(template: Template, type: string): Record<string, any> {
  const resources = template.findResources(type);
  const ids = Object.keys(resources);
  expect(ids.length).toBeGreaterThan(0);
  return resources[ids[0]];
}

let base: Built;

beforeAll(() => {
  base = build();
});

describe('G1 — least privilege IAM, no wildcards on the power actions', () => {
  const POWER_ACTION = /^(ecs:UpdateService|rds:Start.*|rds:Stop.*)$/;

  test('no statement grants a power action on Resource "*"', () => {
    const offenders = policyStatements(base.template).filter((statement) => {
      const actions = asArray(statement.Action).filter((a): a is string => typeof a === 'string');
      if (!actions.some((a) => POWER_ACTION.test(a))) return false;
      return asArray(statement.Resource).includes('*');
    });
    expect(offenders).toEqual([]);
  });

  test('ecs:UpdateService is bound to the one site service ARN', () => {
    const statement = statementBySid(base.template, 'PowerTheOneSiteService');
    expect(statement.Effect).toBe('Allow');
    expect(asArray(statement.Action)).toEqual(['ecs:UpdateService', 'ecs:DescribeServices']);
    const resources = asArray(statement.Resource);
    expect(resources).toHaveLength(1);
    expect(JSON.stringify(resources[0])).toContain('Fn::ImportValue');
    expect(resources[0]).not.toBe('*');
  });

  test('ecs task inspection is confined to the site cluster', () => {
    const statement = statementBySid(base.template, 'InspectTasksInTheSiteClusterOnly');
    expect(asArray(statement.Action).sort()).toEqual(['ecs:DescribeTasks', 'ecs:ListTasks']);
    expect(asArray(statement.Resource)).not.toContain('*');
    expect(statement.Condition).toHaveProperty('ArnEquals');
  });

  test('rds start/stop/describe is bound to the one instance ARN', () => {
    const statement = statementBySid(base.template, 'PowerTheOneSiteDatabase');
    expect(asArray(statement.Action).sort()).toEqual([
      'rds:DescribeDBInstances',
      'rds:StartDBInstance',
      'rds:StopDBInstance',
    ]);
    const resources = asArray(statement.Resource);
    expect(resources).toHaveLength(1);
    expect(resources[0]).not.toBe('*');
  });

  test('scheduler access never leaves the dedicated schedule group', () => {
    const statement = statementBySid(base.template, 'ManageVisitorSchedulesInOwnGroupOnly');
    const rendered = JSON.stringify(asArray(statement.Resource));
    expect(rendered).toContain('schedule/diego-control-visitor/*');
    expect(rendered).toContain('schedule-group/diego-control-visitor');
    expect(asArray(statement.Resource)).not.toContain('*');
  });

  test('the control role carries no AWS managed policy', () => {
    const roles = base.template.findResources('AWS::IAM::Role');
    const controlRole = Object.values(roles).find((r) => r.Properties?.RoleName === 'diego-control-api-role');
    expect(controlRole).toBeDefined();
    expect(controlRole!.Properties.ManagedPolicyArns).toBeUndefined();
  });

  test('logs are writable only to the control plane log group', () => {
    const statement = statementBySid(base.template, 'WriteOwnLogsOnly');
    expect(asArray(statement.Action).sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(asArray(statement.Resource)).not.toContain('*');
  });
});

describe('G2 — bounded actions', () => {
  test('the API exposes no destructive route', () => {
    const routes = Object.values(base.template.findResources('AWS::ApiGatewayV2::Route'))
      .map((r) => r.Properties.RouteKey as string);
    expect(routes).toEqual(expect.arrayContaining([
      'GET /manifest', 'GET /status', 'POST /power', 'GET /rules', 'POST /rules',
      'POST /rules/delete', 'POST /rules/toggle', 'GET /diagram', 'GET /diag', 'GET /activity',
    ]));
    const forbidden = routes.filter((key) => /delete\s|\/scale|\/destroy|\/deploy|desired/i.test(key));
    expect(forbidden).toEqual([]);
  });

  test('no statement allows deleting or resizing the service or the database', () => {
    const allows = policyStatements(base.template).filter((s) => s.Effect !== 'Deny');
    const actions = allows.flatMap((s) => asArray(s.Action)).filter((a): a is string => typeof a === 'string');
    expect(actions).not.toContain('ecs:DeleteService');
    expect(actions).not.toContain('ecs:CreateService');
    expect(actions).not.toContain('rds:DeleteDBInstance');
    expect(actions).not.toContain('rds:ModifyDBInstance');
    expect(actions).not.toContain('application-autoscaling:RegisterScalableTarget');
  });
});

describe('G3 — rate limiting', () => {
  test('stage-wide throttle is burst 20 / rate 5', () => {
    base.template.hasResourceProperties('AWS::ApiGatewayV2::Stage', Match.objectLike({
      DefaultRouteSettings: Match.objectLike({ ThrottlingBurstLimit: 20, ThrottlingRateLimit: 5 }),
    }));
  });

  test('the mutating routes carry their own tighter throttle', () => {
    base.template.hasResourceProperties('AWS::ApiGatewayV2::Stage', Match.objectLike({
      RouteSettings: Match.objectLike({
        'POST /power': Match.objectLike({ ThrottlingBurstLimit: 5, ThrottlingRateLimit: 1 }),
        'POST /rules': Match.objectLike({ ThrottlingBurstLimit: 5, ThrottlingRateLimit: 1 }),
      }),
    }));
  });

  test('the control Lambda has reserved concurrency', () => {
    base.template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      FunctionName: 'diego-control-api',
      ReservedConcurrentExecutions: 5,
    }));
  });
});

describe('G4 — auto-off watchdog', () => {
  test('a 15-minute rule invokes the Lambda in watchdog mode', () => {
    base.template.hasResourceProperties('AWS::Events::Rule', Match.objectLike({
      Name: 'diego-control-watchdog',
      ScheduleExpression: 'rate(15 minutes)',
      State: 'ENABLED',
      Targets: Match.arrayWith([Match.objectLike({ Input: '{"mode":"watchdog"}' })]),
    }));
  });

  test('a nightly lights-out rule exists', () => {
    base.template.hasResourceProperties('AWS::Events::Rule', Match.objectLike({
      Name: 'diego-control-lights-out',
      ScheduleExpression: 'cron(0 5 * * ? *)',
      Targets: Match.arrayWith([Match.objectLike({ Input: '{"mode":"lights-out"}' })]),
    }));
  });

  test('MAX_ON_MINUTES defaults to 180 and is overridable by context', () => {
    base.template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Environment: Match.objectLike({ Variables: Match.objectLike({ MAX_ON_MINUTES: '180' }) }),
    }));
    build({ context: { maxOnMinutes: 45 } }).template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Environment: Match.objectLike({ Variables: Match.objectLike({ MAX_ON_MINUTES: '45' }) }),
    }));
  });
});

describe('G5 — schedule hygiene', () => {
  test('visitor schedules live in their own prefixed group', () => {
    base.template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', Match.objectLike({
      Name: 'diego-control-visitor',
    }));
  });

  test('the rule cap and the name prefix reach the Lambda', () => {
    base.template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          MAX_RULES: '10',
          RULE_PREFIX: 'diego-control-',
          SCHEDULE_GROUP: 'diego-control-visitor',
        }),
      }),
    }));
  });

  test('the scheduler invoke role can only call the control function', () => {
    const statement = statementBySid(base.template, 'InvokeControlFunctionOnly');
    expect(asArray(statement.Action)).toEqual(['lambda:InvokeFunction']);
    expect(JSON.stringify(statement.Resource)).toContain('function:diego-control-api');
  });
});

describe('G6 — CORS allow-list', () => {
  test('exactly the panel origin and the panel dev server, no wildcard', () => {
    const api = resourceOfType(base.template, 'AWS::ApiGatewayV2::Api');
    expect(api.Properties.CorsConfiguration.AllowOrigins).toEqual([
      'https://control.diegopalominos.dev',
      'http://localhost:4200',
    ]);
    expect(api.Properties.CorsConfiguration.AllowOrigins).not.toContain('*');
    expect(api.Properties.CorsConfiguration.AllowHeaders).toEqual(['authorization', 'content-type']);
  });

  test('the same allow-list is handed to the Lambda', () => {
    base.template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          ALLOWED_ORIGINS: 'https://control.diegopalominos.dev,http://localhost:4200',
        }),
      }),
    }));
  });
});

describe('G7 — activity log', () => {
  test('on-demand table with a TTL attribute', () => {
    base.template.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({
      TableName: 'diego-control-activity',
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: Match.objectLike({ AttributeName: 'ttl', Enabled: true }),
    }));
  });

  test('the Lambda may append and read the feed but never scan or delete it', () => {
    const statement = statementBySid(base.template, 'ActivityFeedAppendAndRead');
    expect(asArray(statement.Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']);
    expect(asArray(statement.Resource)).not.toContain('*');
  });

  test('GET /activity is routed', () => {
    base.template.hasResourceProperties('AWS::ApiGatewayV2::Route', Match.objectLike({ RouteKey: 'GET /activity' }));
  });
});

describe('F1 — account guard', () => {
  test('a wrong account fails synth loudly, naming both accounts', () => {
    expect(() => build({ env: { account: '111111111111', region: REGION } }))
      .toThrow(new RegExp(`111111111111[\\s\\S]*${ACCOUNT}|${ACCOUNT}[\\s\\S]*111111111111`));
    expect(() => build({ env: { account: '111111111111', region: REGION } }))
      .toThrow(/unrelated production/);
  });

  test('the expected account synthesizes', () => {
    expect(() => build()).not.toThrow();
  });

  test('an environment-agnostic synth still works (no credentials needed)', () => {
    expect(() => build({ env: undefined as unknown as { account: string; region: string } })).not.toThrow();
  });

  test('context expectedAccount can retarget the guard deliberately', () => {
    expect(() => build({
      env: { account: '111111111111', region: REGION },
      context: { expectedAccount: '111111111111' },
    })).not.toThrow();
  });

  test('an unconfigured fence refuses to synthesize at all', () => {
    const app = new App({ context: {} });
    const site = new SiteDouble(app, 'DiegoSiteStack');
    expect(() => new DiegoControlStack(app, 'DiegoControlStack', {
      service: site.service,
      cluster: site.cluster,
      dbInstance: site.database,
    })).toThrow(UNCONFIGURED_ACCOUNT_ERROR);
  });
});

describe('F2 — permissions boundary', () => {
  test('the control role carries the boundary managed policy', () => {
    const roles = base.template.findResources('AWS::IAM::Role');
    const controlRole = Object.values(roles).find((r) => r.Properties?.RoleName === 'diego-control-api-role');
    expect(controlRole?.Properties?.PermissionsBoundary).toBeDefined();
    const boundaryRef = JSON.stringify(controlRole!.Properties.PermissionsBoundary);
    expect(boundaryRef).toContain('ControlBoundary');
  });

  test('the boundary is a managed policy named diego-control-boundary', () => {
    base.template.hasResourceProperties('AWS::IAM::ManagedPolicy', Match.objectLike({
      ManagedPolicyName: 'diego-control-boundary',
    }));
  });

  test('the boundary allows nothing beyond this stack (implicit deny is the wall)', () => {
    const boundary = resourceOfType(base.template, 'AWS::IAM::ManagedPolicy');
    const allowed = (boundary.Properties.PolicyDocument.Statement as PolicyStatementJson[])
      .filter((s) => s.Effect !== 'Deny')
      .flatMap((s) => asArray(s.Action));
    const services = new Set(allowed.map((a) => String(a).split(':')[0]));
    expect([...services].sort()).toEqual(['dynamodb', 'ecs', 'iam', 'logs', 'rds', 'scheduler']);
  });
});

describe('F3 — explicit denies (deny wins over allow)', () => {
  const boundarySids = (template: Template): string[] => {
    const boundary = resourceOfType(template, 'AWS::IAM::ManagedPolicy');
    return (boundary.Properties.PolicyDocument.Statement as PolicyStatementJson[])
      .filter((s) => s.Effect === 'Deny')
      .map((s) => String(s.Sid));
  };

  test('the boundary denies the configured protected stacks by ARN pattern', () => {
    const statement = statementBySid(base.template, 'DenyAnythingNamedProtectedProduction');
    expect(statement.Effect).toBe('Deny');
    expect(asArray(statement.Action)).toEqual(['*']);
    const rendered = JSON.stringify(statement.Resource);
    for (const prefix of PROTECTED_PREFIXES) expect(rendered).toContain(`*${prefix}*`);
  });

  test('no protected prefixes configured means no name-based deny — the ARN allow-list still fences', () => {
    const sids = boundarySids(build({ context: { protectedStackPrefixes: '' } }).template);
    expect(sids).not.toContain('DenyAnythingNamedProtectedProduction');
    expect(sids).toEqual(expect.arrayContaining([
      'DenyIamExceptPassingTheSchedulerRole',
      'DenyEcsServiceUpdatesOutsideThisStack',
      'DenyDatabaseChangesOutsideThisStack',
    ]));
  });

  test('iam / organizations / account / sts are denied', () => {
    const identity = statementBySid(base.template, 'DenyIdentityAndOrgControl');
    expect(asArray(identity.Action)).toEqual(expect.arrayContaining(['organizations:*', 'account:*', 'sts:AssumeRole']));
    const iamDeny = statementBySid(base.template, 'DenyIamExceptPassingTheSchedulerRole');
    expect(asArray(iamDeny.Action)).toEqual(['iam:*']);
    // Everything except passing the scheduler role — hence NotResource.
    expect(iamDeny.NotResource).toBeDefined();
    expect(iamDeny.Resource).toBeUndefined();
  });

  test('CloudFormation stack mutations are denied', () => {
    const statement = statementBySid(base.template, 'DenyStackMutations');
    expect(asArray(statement.Action)).toEqual(expect.arrayContaining([
      'cloudformation:DeleteStack',
      'cloudformation:UpdateStack',
    ]));
  });

  test('destructive RDS actions are denied everywhere, mutations outside this instance too', () => {
    const destruction = statementBySid(base.template, 'DenyDatabaseDestruction');
    expect(asArray(destruction.Action)).toEqual(expect.arrayContaining([
      'rds:DeleteDBInstance',
      'rds:RestoreDBInstanceFromDBSnapshot',
      'rds:RestoreDBInstanceToPointInTime',
    ]));
    const elsewhere = statementBySid(base.template, 'DenyDatabaseChangesOutsideThisStack');
    expect(asArray(elsewhere.Action)).toEqual(expect.arrayContaining(['rds:ModifyDBInstance', 'rds:CreateDBSnapshot']));
    expect(elsewhere.NotResource).toBeDefined();
  });

  test('ECS topology changes are denied and UpdateService is pinned to one ARN', () => {
    const topology = statementBySid(base.template, 'DenyEcsTopologyChanges');
    expect(asArray(topology.Action)).toEqual(expect.arrayContaining(['ecs:DeleteService', 'ecs:UpdateCluster']));
    const elsewhere = statementBySid(base.template, 'DenyEcsServiceUpdatesOutsideThisStack');
    expect(asArray(elsewhere.Action)).toEqual(['ecs:UpdateService']);
    expect(elsewhere.NotResource).toBeDefined();
  });

  test('secrets and SSM outside this stack\'s own paths are denied', () => {
    const secrets = statementBySid(base.template, 'DenySecretsOutsideOwnPaths');
    expect(asArray(secrets.Action)).toEqual(['secretsmanager:*']);
    expect(JSON.stringify(secrets.NotResource)).toContain('secret:diego-control-');
    const ssm = statementBySid(base.template, 'DenySsmOutsideOwnPaths');
    expect(JSON.stringify(ssm.NotResource)).toContain('parameter/diego/prod/control/*');
  });

  test('every deny also lives on the boundary, not just the role policy', () => {
    expect(boundarySids(base.template)).toEqual(expect.arrayContaining([
      'DenyAnythingNamedProtectedProduction',
      'DenyIdentityAndOrgControl',
      'DenyIamExceptPassingTheSchedulerRole',
      'DenyStackMutations',
      'DenyDatabaseDestruction',
      'DenyEcsTopologyChanges',
      'DenySchedulerOutsideOwnGroup',
    ]));
  });
});

describe('F4 — dedicated network', () => {
  test('supplying vpcId fails synth with an explanation', () => {
    expect(() => build({ context: { vpcId: 'vpc-0123456789abcdef0' } }))
      .toThrow(/must never share a network with production/);
  });

  test('the control stack creates no VPC of its own (the Lambda runs outside any VPC)', () => {
    base.template.resourceCountIs('AWS::EC2::VPC', 0);
    base.template.resourceCountIs('AWS::EC2::NatGateway', 0);
    const fns = Object.values(base.template.findResources('AWS::Lambda::Function'));
    const control = fns.find((f) => f.Properties?.FunctionName === 'diego-control-api');
    expect(control!.Properties.VpcConfig).toBeUndefined();
  });
});

describe('F5 — name prefixes', () => {
  test('every physically-named resource is prefixed diego-control- (or diego-site- for cost objects)', () => {
    const resources = base.template.toJSON().Resources as Record<string, { Type: string; Properties?: any }>;
    // Physical-name properties only, read per type: `Name` on a Route53
    // RecordSet is a DNS name, not a resource name.
    const namePropsByType: Record<string, string[]> = {
      'AWS::Lambda::Function': ['FunctionName'],
      'AWS::DynamoDB::Table': ['TableName'],
      'AWS::IAM::Role': ['RoleName'],
      'AWS::IAM::ManagedPolicy': ['ManagedPolicyName'],
      'AWS::Events::Rule': ['Name'],
      'AWS::Scheduler::ScheduleGroup': ['Name'],
      'AWS::ApiGatewayV2::Api': ['Name'],
      'AWS::S3::Bucket': ['BucketName'],
      'AWS::SNS::Topic': ['TopicName'],
      'AWS::CloudWatch::Alarm': ['AlarmName'],
    };
    const names: string[] = [];
    for (const resource of Object.values(resources)) {
      for (const prop of namePropsByType[resource.Type] ?? []) {
        const value = resource.Properties?.[prop];
        if (typeof value === 'string') names.push(value);
      }
      const budgetName = resource.Properties?.Budget?.BudgetName;
      if (typeof budgetName === 'string') names.push(budgetName);
    }
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      expect(name).toMatch(/^diego-(control|site)-/);
    }
  });

  test('the panel bucket is namespaced by account so it cannot collide', () => {
    base.template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
      BucketName: `diego-control-panel-${ACCOUNT}`,
    }));
  });

  test('no protected stack name appears anywhere in the synthesized template', () => {
    const rendered = JSON.stringify(build({ context: { protectedStackPrefixes: '' } }).template.toJSON());
    for (const prefix of PROTECTED_PREFIXES) expect(rendered).not.toContain(prefix);
  });
});

describe('F6 — cost allocation tags', () => {
  test('project / owner / exposure ride on the stack resources', () => {
    base.template.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({
      // CDK renders tags sorted by key: exposure, owner, project.
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'exposure', Value: 'public-demo' }),
        Match.objectLike({ Key: 'owner', Value: 'diego' }),
        Match.objectLike({ Key: 'project', Value: 'diego-site' }),
      ]),
    }));
  });
});

describe('F7 — budget guard', () => {
  test('monthly budget scoped by the project tag with 80% / 100% alerts', () => {
    base.template.hasResourceProperties('AWS::Budgets::Budget', Match.objectLike({
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: Match.objectLike({ Amount: 40, Unit: 'USD' }),
        CostFilters: Match.objectLike({ TagKeyValue: ['user:project$diego-site'] }),
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 80, NotificationType: 'ACTUAL' }),
          Subscribers: Match.arrayWith([Match.objectLike({ Address: 'alerts@example.com', SubscriptionType: 'EMAIL' })]),
        }),
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 100 }) }),
      ]),
    }));
  });

  test('budgetUsd context moves both the budget and the billing alarm', () => {
    const custom = build({ context: { budgetUsd: 25 } }).template;
    custom.hasResourceProperties('AWS::Budgets::Budget', Match.objectLike({
      Budget: Match.objectLike({ BudgetLimit: Match.objectLike({ Amount: 25 }) }),
    }));
    custom.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
      AlarmName: 'diego-control-estimated-charges',
      Namespace: 'AWS/Billing',
      MetricName: 'EstimatedCharges',
      Threshold: 25,
    }));
  });

  test('the billing alarm notifies the budget email through SNS', () => {
    base.template.hasResourceProperties('AWS::SNS::Subscription', Match.objectLike({
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
    }));
  });
});

describe('panel hosting + Eleva panel metadata', () => {
  test('CloudFront fronts a private bucket for control.diegopalominos.dev', () => {
    base.template.hasResourceProperties('AWS::CloudFront::Distribution', Match.objectLike({
      DistributionConfig: Match.objectLike({
        Aliases: ['control.diegopalominos.dev'],
        DefaultRootObject: 'index.html',
      }),
    }));
    base.template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
    }));
  });

  test('the panel build targets are published to SSM', () => {
    for (const name of ['/diego/prod/control/bucket', '/diego/prod/control/distributionId', '/diego/prod/control/apiUrl']) {
      base.template.hasResourceProperties('AWS::SSM::Parameter', Match.objectLike({ Name: name }));
    }
  });

  test('principal resources carry Metadata[Eleva::Panel] in the diego-control group', () => {
    const resources = base.template.toJSON().Resources as Record<string, { Type: string; Metadata?: any }>;
    const meta = (type: string) => Object.values(resources).find((r) => r.Type === type)?.Metadata?.['Eleva::Panel'];

    expect(meta('AWS::Lambda::Function')).toMatchObject({ category: 'ops', group: 'diego-control' });
    expect(meta('AWS::DynamoDB::Table')).toMatchObject({ group: 'diego-control' });
    expect(meta('AWS::Scheduler::ScheduleGroup')).toMatchObject({ category: 'ops', group: 'diego-control' });
    expect(meta('AWS::CloudFront::Distribution')).toMatchObject({
      category: 'cdn',
      group: 'diego-control',
      public: { protocol: 'HTTPS', port: 443, from: 'Web' },
    });
    expect(meta('AWS::ApiGatewayV2::Api')).toMatchObject({
      group: 'diego-control',
      public: { protocol: 'HTTPS', port: 443, from: 'Web' },
    });
  });

  test('the manifest handed to the Lambda uses the site scope ids as panel keys', () => {
    const fns = Object.values(base.template.findResources('AWS::Lambda::Function'));
    const control = fns.find((f) => f.Properties?.FunctionName === 'diego-control-api')!;
    const manifest = JSON.stringify(control.Properties.Environment.Variables.MANIFEST);
    expect(manifest).toContain('\\"key\\":\\"blog\\"');
    expect(manifest).toContain('\\"key\\":\\"database\\"');
    expect(manifest).toContain('\\"powerable\\":true');
    expect(manifest).toContain('\\"type\\":\\"info\\"');
  });

  test('without a hosted zone the stack still synthesizes on the CloudFront default domain', () => {
    const app = new App({ context: { expectedAccount: ACCOUNT } });
    const site = new SiteDouble(app, 'DiegoSiteStack');
    const control = new DiegoControlStack(app, 'DiegoControlStack', {
      service: site.service,
      cluster: site.cluster,
      dbInstance: site.database,
    });
    const template = Template.fromStack(control);
    const distribution = resourceOfType(template, 'AWS::CloudFront::Distribution');
    expect(distribution.Properties.DistributionConfig.Aliases).toBeUndefined();
  });
});
