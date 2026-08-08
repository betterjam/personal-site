import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advertisedSurfaces,
  bearerToken,
  clampDesired,
  corsHeaders,
  createHandler,
  FAILURE_MAX_LENGTH,
  hashActor,
  ipPrefix,
  MUTATING_ROUTES,
  normalizeRuleName,
  PIPELINE_CACHE_TTL_MS,
  tokenMatches,
  validateRule,
} from '../src/control/handler';
import {
  ActivityEntry,
  ControlEnv,
  ControlEvent,
  Deps,
  Diagram,
  HttpResult,
  Manifest,
  PipelineExecutionSummary,
  PipelineStateSnapshot,
  PowerMarker,
  ScheduleRule,
} from '../src/control/types';

/**
 * Unit tests for the control Lambda, run with `node:test` against stubbed AWS
 * ports — no credentials, no network, no `@aws-sdk/*` package. Run them with
 * `npx projen test:control` (the projen `test` task spawns it).
 *
 * Filename is `*.nodetest.ts` on purpose: jest's testMatch only picks up
 * `*.test.ts` / `*.spec.ts`, so these do not collide with the CDK assertions.
 */

const PANEL_ORIGIN = 'https://control.diegopalominos.dev';
const DEV_ORIGIN = 'http://localhost:4200';
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const MINUTE = 60_000;
/** The one pipeline this stack owns — the whole allow-list. */
const OWN_PIPELINE = 'eleva-diego-site-prod';
/**
 * A co-resident PRODUCTION pipeline. It exists in these tests purely so they
 * can prove it never appears in a response, is never asked about, and is
 * dropped even when a port hands it over unprompted.
 */
const PRODUCTION_PIPELINE = 'eleva-api-prod';
/**
 * Stand-in for the generated `diego-control-admin-token` secret. The real one
 * never leaves Secrets Manager; these tests only need a value to compare
 * against.
 */
const ADMIN_TOKEN = 'test-admin-token-2rWq9xL4';

const manifest: Manifest = {
  env: 'prod',
  app: 'diego-site',
  allowAnon: true,
  publicDemo: true,
  siteUrl: 'https://diegopalominos.dev',
  resources: [
    {
      key: 'blog',
      name: 'Site API service',
      type: 'ecs',
      powerable: true,
      ecs: { cluster: 'diego-site-cluster', service: 'diego-site-service', onDesired: 1 },
      logs: [{ logGroup: '/diego/prod/site/blog', format: { type: 'auto' } }],
    },
    {
      key: 'database',
      name: 'Site PostgreSQL',
      type: 'rds',
      powerable: true,
      rds: { instanceId: 'diego-site-db' },
      logs: [],
    },
    { key: 'control', name: 'Control plane', type: 'info', powerable: false, logs: [] },
  ],
};

const diagram: Diagram = {
  nodes: [
    { id: 'visitor', label: 'Web', type: 'External::User', cat: 'traffic' },
    { id: 'blog', label: 'Site API service', type: 'AWS::ECS::Service', cat: 'compute' },
    { id: 'database', label: 'Site PostgreSQL', type: 'AWS::RDS::DBInstance', cat: 'database' },
  ],
  edges: [{ from: 'visitor', to: 'blog', label: 'HTTPS · 443', ext: true }],
};

const env: ControlEnv = {
  manifest,
  diagram,
  scheduleGroup: 'diego-control-visitor',
  rulePrefix: 'diego-control-',
  maxRules: 10,
  maxOnMinutes: 180,
  allowedOrigins: [PANEL_ORIGIN, DEV_ORIGIN],
  pipelines: [OWN_PIPELINE],
  actorSalt: 'stack/DiegoControlStack/1234',
  timezone: 'America/Santiago',
  panelUrl: PANEL_ORIGIN,
  siteUrl: 'https://diegopalominos.dev',
  /*
   * The public playground's setting, so every test below this line exercises
   * the behaviour that ships at control.diegopalominos.dev. The G8 section
   * overrides it to `false` to test the read-only mode.
   */
  allowAnon: true,
  adminToken: ADMIN_TOKEN,
};

/** In-memory stand-ins for ECS / RDS / Scheduler / DynamoDB. */
class Stub {
  public ecsState = { desired: 1, running: 1, pending: 0 };
  public rdsStatus = 'available';
  public oldestTask: number | undefined = undefined;
  public rules: ScheduleRule[] = [];
  public activity: ActivityEntry[] = [];
  public marker: PowerMarker | undefined = undefined;
  public clock = NOW;

  public pipelineStates: Record<string, PipelineStateSnapshot> = {};
  public pipelineExecutions: Record<string, PipelineExecutionSummary[]> = {};

  /** Recorded calls, so a test can assert exactly what reached AWS. */
  public desiredCounts: number[] = [];
  public rdsActions: string[] = [];
  public putRules: ScheduleRule[] = [];
  public removedRules: string[] = [];
  /** Every CodePipeline call the handler made, in order. */
  public pipelineCalls: string[] = [];

  public deps(overrides: Partial<ControlEnv> = {}): Deps {
    return {
      env: { ...env, ...overrides },
      ecs: {
        describe: async () => this.ecsState,
        setDesiredCount: async (_cluster, _service, desiredCount) => {
          this.desiredCounts.push(desiredCount);
          this.ecsState = {
            desired: desiredCount,
            running: desiredCount,
            pending: 0,
          };
        },
        oldestTaskStart: async () => this.oldestTask,
      },
      rds: {
        status: async () => this.rdsStatus,
        start: async (id) => {
          this.rdsActions.push(`start:${id}`);
          this.rdsStatus = 'starting';
        },
        stop: async (id) => {
          this.rdsActions.push(`stop:${id}`);
          this.rdsStatus = 'stopping';
        },
      },
      schedules: {
        list: async () => this.rules,
        get: async (name) => this.rules.find((r) => r.name === name),
        put: async (rule) => {
          this.putRules.push(rule);
          this.rules = [...this.rules.filter((r) => r.name !== rule.name), rule];
        },
        remove: async (name) => {
          this.removedRules.push(name);
          this.rules = this.rules.filter((r) => r.name !== name);
        },
      },
      activity: {
        record: async (entry) => {
          this.activity.unshift(entry);
        },
        recent: async (limit) => this.activity.slice(0, limit),
        readMarker: async () => this.marker,
        writeMarker: async (marker) => {
          this.marker = marker;
        },
      },
      /*
       * The pipeline port takes a NAME and has no list operation — the stub
       * mirrors the real port exactly, so a handler that tried to enumerate
       * the account would not compile, let alone run.
       */
      pipelines: {
        state: async (name) => {
          this.pipelineCalls.push(`state:${name}`);
          return this.pipelineStates[name];
        },
        executions: async (name, limit) => {
          this.pipelineCalls.push(`executions:${name}:${limit}`);
          return this.pipelineExecutions[name] ?? [];
        },
      },
      now: () => this.clock,
      id: () => 'testid',
    };
  }
}

/** A realistic GetPipelineState reply: source ok, build running. */
function runningPipeline(name: string): PipelineStateSnapshot {
  return {
    name,
    stages: [
      {
        name: 'Source',
        status: 'Succeeded',
        actions: [{ name: 'GitHub', status: 'Succeeded', lastStatusChange: '2026-08-05T11:40:00.000Z' }],
      },
      {
        name: 'Build',
        status: 'InProgress',
        actions: [
          { name: 'DockerBuild', status: 'InProgress', lastStatusChange: '2026-08-05T11:52:00.000Z' },
          { name: 'FrontendBuild', status: 'InProgress', lastStatusChange: '2026-08-05T11:51:00.000Z' },
        ],
      },
      { name: 'Deploy', status: 'Failed', actions: [] },
    ],
  };
}

/**
 * A request from the panel.
 *
 * The default `authorization: 'Bearer '` is not an accident: that is what the
 * panel sent unconditionally before it learned about tokens, and it must read
 * as NO token — an empty bearer that authenticated anything would be the
 * worst possible bug in G8. Pass `token` for a request that really carries
 * one, or `authorization` to send a raw header.
 */
function http(
  method: string,
  path: string,
  options: { body?: unknown; origin?: string; ip?: string; token?: string; authorization?: string } = {},
): ControlEvent {
  const authorization = options.authorization
    ?? (options.token === undefined ? 'Bearer ' : `Bearer ${options.token}`);
  return {
    version: '2.0',
    rawPath: path,
    headers: options.origin ? { origin: options.origin, authorization } : { authorization },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    requestContext: {
      http: { method, path, sourceIp: options.ip ?? '203.0.113.42' },
    },
  };
}

/** A minimal valid body for each mutating route, so only auth decides. */
const MUTATION_BODIES: Record<string, unknown> = {
  'POST /power': { target: 'all', state: 'off' },
  'POST /rules': { name: 'nightly', schedule: 'cron(0 21 ? * MON-FRI *)', state: 'off', target: 'all' },
  'POST /rules/delete': { name: 'nightly' },
  'POST /rules/toggle': { name: 'nightly', enabled: false },
};

/** `'POST /power'` -> the arguments `http()` wants. */
function mutation(route: string): { method: string; path: string; body: unknown } {
  const [method, path] = route.split(' ');
  return { method, path, body: MUTATION_BODIES[route] };
}

function json(result: HttpResult | Record<string, unknown>): any {
  const response = result as HttpResult;
  return response.body ? JSON.parse(response.body) : {};
}

// ── G2: bounded actions ────────────────────────────────────────────────────
//
// `void test(...)`: node:test returns a promise per test and the runner awaits
// it; `void` states that explicitly for @typescript-eslint/no-floating-promises.

void test('clampDesired only ever yields 0 or 1', () => {
  assert.equal(clampDesired(5), 1);
  assert.equal(clampDesired(1), 1);
  assert.equal(clampDesired(0.7), 0);
  assert.equal(clampDesired(0), 0);
  assert.equal(clampDesired(-3), 0);
  assert.equal(clampDesired(Number.NaN), 0);
  assert.equal(clampDesired(Number.POSITIVE_INFINITY), 0);
});

void test('POST /power on sets desiredCount to exactly 1, ignoring anything else in the body', async () => {
  const stub = new Stub();
  stub.ecsState = { desired: 0, running: 0, pending: 0 };
  stub.rdsStatus = 'stopped';
  const handle = createHandler(stub.deps());

  const result = await handle(http('POST', '/power', {
    body: { target: 'all', state: 'on', desiredCount: 42, count: 42 },
    origin: PANEL_ORIGIN,
  }));

  assert.equal((result as HttpResult).statusCode, 200);
  assert.deepEqual(stub.desiredCounts, [1]);
  assert.deepEqual(stub.rdsActions, ['start:diego-site-db']);
  assert.deepEqual(json(result).affected, ['blog', 'database']);
});

void test('POST /power off scales to 0 and stops the database', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());

  await handle(http('POST', '/power', { body: { target: 'all', state: 'off' }, origin: PANEL_ORIGIN }));

  assert.deepEqual(stub.desiredCounts, [0]);
  assert.deepEqual(stub.rdsActions, ['stop:diego-site-db']);
  assert.deepEqual(stub.marker, {});
});

void test('POST /power rejects an unknown state and an unknown target', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());

  const badState = await handle(http('POST', '/power', { body: { target: 'all', state: 'reboot' } }));
  assert.equal((badState as HttpResult).statusCode, 400);

  const badTarget = await handle(http('POST', '/power', { body: { target: 'someone-elses-stack', state: 'off' } }));
  assert.equal((badTarget as HttpResult).statusCode, 404);
  assert.deepEqual(json(badTarget).targets, ['all', 'blog', 'database']);

  assert.deepEqual(stub.desiredCounts, []);
  assert.deepEqual(stub.rdsActions, []);
});

void test('a single resource can be powered without touching the other', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());

  await handle(http('POST', '/power', { body: { target: 'blog', state: 'off' } }));

  assert.deepEqual(stub.desiredCounts, [0]);
  assert.deepEqual(stub.rdsActions, []);
});

// ── G5: schedule hygiene ───────────────────────────────────────────────────

void test('rule names are slugged and prefixed', () => {
  assert.equal(normalizeRuleName('Evening Off!', 'diego-control-'), 'diego-control-evening-off');
  assert.equal(normalizeRuleName('diego-control-morning', 'diego-control-'), 'diego-control-morning');
  assert.equal(normalizeRuleName('   ', 'diego-control-'), undefined);
});

void test('validateRule enforces the cron shape, the target and the state', () => {
  const ctx = {
    prefix: 'diego-control-',
    maxRules: 10,
    timezone: 'America/Santiago',
    targets: ['all', 'blog', 'database'],
    existing: [],
  };

  const good = validateRule({ name: 'evening-off', schedule: 'cron(0 21 ? * MON-FRI *)', target: 'all', state: 'off' }, ctx);
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.rule.name, 'diego-control-evening-off');
  assert.equal(good.ok && good.rule.timezone, 'America/Santiago');

  const badCron = validateRule({ name: 'x', schedule: 'rate(1 minute)', target: 'all', state: 'off' }, ctx);
  assert.equal(badCron.ok, false);
  assert.equal(!badCron.ok && badCron.error, 'invalid_schedule');

  const badTarget = validateRule({ name: 'x', schedule: 'cron(0 21 ? * * *)', target: 'someone-elses-stack', state: 'off' }, ctx);
  assert.equal(!badTarget.ok && badTarget.error, 'unknown_target');

  const badState = validateRule({ name: 'x', schedule: 'cron(0 21 ? * * *)', target: 'all', state: 'boom' }, ctx);
  assert.equal(!badState.ok && badState.error, 'invalid_state');
});

void test('the rule cap rejects the new rule and says the oldest ones keep their slots', async () => {
  const stub = new Stub();
  stub.rules = Array.from({ length: 10 }, (_, i) => ({
    name: `diego-control-rule-${i}`,
    schedule: 'cron(0 21 ? * * *)',
    target: 'all',
    state: 'off' as const,
    enabled: true,
  }));
  const handle = createHandler(stub.deps());

  const rejected = await handle(http('POST', '/rules', {
    body: { name: 'one-more', schedule: 'cron(0 22 ? * * *)', target: 'all', state: 'off' },
    origin: PANEL_ORIGIN,
  }));

  assert.equal((rejected as HttpResult).statusCode, 409);
  assert.equal(json(rejected).error, 'rule_limit');
  assert.match(json(rejected).message, /oldest/i);
  assert.equal(stub.putRules.length, 0);
  // the rejection is still recorded in the public feed
  assert.equal(stub.activity[0].result, 'rejected: rule_limit');

  // updating an EXISTING rule at the cap is still allowed
  const updated = await handle(http('POST', '/rules', {
    body: { name: 'rule-3', schedule: 'cron(30 22 ? * * *)', target: 'blog', state: 'on' },
  }));
  assert.equal((updated as HttpResult).statusCode, 200);
  assert.equal(stub.putRules.length, 1);
  assert.equal(stub.putRules[0].name, 'diego-control-rule-3');
});

void test('rules can be listed, toggled and deleted', async () => {
  const stub = new Stub();
  stub.rules = [{
    name: 'diego-control-evening-off',
    schedule: 'cron(0 21 ? * MON-FRI *)',
    target: 'all',
    state: 'off',
    enabled: true,
  }];
  const handle = createHandler(stub.deps());

  const listed = await handle(http('GET', '/rules'));
  assert.equal(json(listed).rules.length, 1);
  assert.equal(json(listed).max, 10);

  const toggled = await handle(http('POST', '/rules/toggle', { body: { name: 'evening-off', enabled: false } }));
  assert.equal((toggled as HttpResult).statusCode, 200);
  assert.equal(stub.putRules[0].enabled, false);

  const missing = await handle(http('POST', '/rules/toggle', { body: { name: 'nope', enabled: true } }));
  assert.equal((missing as HttpResult).statusCode, 404);

  const deleted = await handle(http('POST', '/rules/delete', { body: { name: 'evening-off' } }));
  assert.equal((deleted as HttpResult).statusCode, 200);
  assert.deepEqual(stub.removedRules, ['diego-control-evening-off']);
});

void test('a scheduled "all" rule does not fight a rule someone made for one resource', async () => {
  const stub = new Stub();
  stub.rules = [{
    name: 'diego-control-blog-stays-up',
    schedule: 'cron(0 9 ? * * *)',
    target: 'blog',
    state: 'on',
    enabled: true,
  }];
  const handle = createHandler(stub.deps());

  const result = await handle({ target: 'all', state: 'off', rule: 'diego-control-nightly' });

  assert.deepEqual((result as any).skipped, ['blog']);
  assert.deepEqual(stub.desiredCounts, []);
  assert.deepEqual(stub.rdsActions, ['stop:diego-site-db']);
  assert.equal(stub.activity[0].actor, 'schedule diego-control-nightly');
});

// ── G4: the auto-off watchdog ──────────────────────────────────────────────

void test('pressing "on" again does not extend the auto-off window', async () => {
  const stub = new Stub();
  stub.ecsState = { desired: 0, running: 0, pending: 0 };
  stub.rdsStatus = 'stopped';
  const handle = createHandler(stub.deps());

  await handle(http('POST', '/power', { body: { target: 'all', state: 'on' } }));
  const firstOn = stub.marker?.onSince;
  assert.equal(firstOn, NOW);

  // two hours later somebody taps "on" again
  stub.clock = NOW + 120 * MINUTE;
  await handle(http('POST', '/power', { body: { target: 'all', state: 'on' } }));
  assert.equal(stub.marker?.onSince, firstOn);

  // so the watchdog still fires on the original clock
  stub.clock = NOW + 181 * MINUTE;
  const result = await handle({ mode: 'watchdog' }) as Record<string, unknown>;
  assert.equal(result.action, 'off');
});

void test('the watchdog powers everything off past MAX_ON_MINUTES', async () => {
  const stub = new Stub();
  stub.marker = { onSince: NOW - 200 * MINUTE };
  const handle = createHandler(stub.deps());

  const result = await handle({ mode: 'watchdog' }) as Record<string, unknown>;

  assert.equal(result.action, 'off');
  assert.equal(result.onForMinutes, 200);
  assert.deepEqual(stub.desiredCounts, [0]);
  assert.deepEqual(stub.rdsActions, ['stop:diego-site-db']);
  assert.equal(stub.activity[0].action, 'watchdog:off');
  assert.equal(stub.activity[0].actor, 'watchdog');
});

void test('the watchdog leaves things alone inside the allowance', async () => {
  const stub = new Stub();
  stub.marker = { onSince: NOW - 60 * MINUTE };
  const handle = createHandler(stub.deps());

  const result = await handle({ mode: 'watchdog' }) as Record<string, unknown>;

  assert.equal(result.action, 'none');
  assert.equal(result.onForMinutes, 60);
  assert.deepEqual(stub.desiredCounts, []);
  assert.deepEqual(stub.rdsActions, []);
});

void test('the watchdog does nothing when everything is already off', async () => {
  const stub = new Stub();
  stub.ecsState = { desired: 0, running: 0, pending: 0 };
  stub.rdsStatus = 'stopped';
  const handle = createHandler(stub.deps());

  const result = await handle({ mode: 'watchdog' }) as Record<string, unknown>;

  assert.equal(result.action, 'none');
  assert.equal(result.reason, 'already off');
});

void test('with no marker the watchdog falls back to the oldest running task', async () => {
  const stub = new Stub();
  stub.marker = undefined;
  stub.oldestTask = NOW - 240 * MINUTE;
  const handle = createHandler(stub.deps());

  const result = await handle({ mode: 'watchdog' }) as Record<string, unknown>;

  assert.equal(result.action, 'off');
  assert.equal(result.onForMinutes, 240);
});

void test('with neither marker nor task start the watchdog arms the clock instead of guessing', async () => {
  const stub = new Stub();
  stub.marker = undefined;
  stub.oldestTask = undefined;
  const handle = createHandler(stub.deps());

  const result = await handle({ mode: 'watchdog' }) as Record<string, unknown>;

  assert.equal(result.action, 'none');
  assert.deepEqual(stub.marker, { onSince: NOW });
});

void test('the nightly lights-out turns things off regardless of how long they have been on', async () => {
  const stub = new Stub();
  stub.marker = { onSince: NOW - 5 * MINUTE };
  const handle = createHandler(stub.deps());

  const result = await handle({ mode: 'lights-out' }) as Record<string, unknown>;

  assert.equal(result.action, 'off');
  assert.deepEqual(stub.desiredCounts, [0]);
  assert.equal(stub.activity[0].action, 'lights-out:off');
});

void test('MAX_ON_MINUTES is configurable', async () => {
  const stub = new Stub();
  stub.marker = { onSince: NOW - 50 * MINUTE };
  const handle = createHandler(stub.deps({ maxOnMinutes: 45 }));

  const result = await handle({ mode: 'watchdog' }) as Record<string, unknown>;
  assert.equal(result.action, 'off');
});

// ── G7: the activity feed ──────────────────────────────────────────────────

void test('ipPrefix keeps only the network part', () => {
  assert.equal(ipPrefix('203.0.113.42'), '203.0.113.0/24');
  assert.equal(ipPrefix('2001:db8:1234:5678:9abc:def0:1234:5678'), '2001:db8:1234:5678::/64');
  assert.equal(ipPrefix(undefined), 'unknown');
  assert.equal(ipPrefix('not-an-ip'), 'unknown');
});

void test('the actor is a salted hash of the prefix — never the address', () => {
  const actor = hashActor('203.0.113.42', 'salt');
  assert.match(actor, /^visitor-[0-9a-f]{12}$/);
  assert.ok(!actor.includes('203.0.113.42'));
  assert.ok(!actor.includes('203.0.113'));
  // same /24 -> same actor; different /24 -> different actor
  assert.equal(actor, hashActor('203.0.113.99', 'salt'));
  assert.notEqual(actor, hashActor('198.51.100.42', 'salt'));
  // the salt matters, so the feed cannot be reversed with a generic table
  assert.notEqual(actor, hashActor('203.0.113.42', 'other-salt'));
  assert.equal(hashActor(undefined, 'salt'), 'visitor-anon');
});

void test('a power action records a hashed actor and never the raw IP', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());

  await handle(http('POST', '/power', { body: { target: 'all', state: 'off' }, ip: '198.51.100.7' }));

  const entry = stub.activity[0];
  assert.equal(entry.action, 'power:off');
  assert.match(entry.actor, /^visitor-[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(stub.activity).includes('198.51.100.7'));
  assert.equal(entry.at, new Date(NOW).toISOString());
});

void test('GET /activity returns the 20 most recent entries', async () => {
  const stub = new Stub();
  stub.activity = Array.from({ length: 40 }, (_, i) => ({
    at: new Date(NOW - i * MINUTE).toISOString(),
    action: 'power:on',
    actor: 'visitor-abcdef123456',
    result: 'ok',
  }));
  const handle = createHandler(stub.deps());

  const result = await handle(http('GET', '/activity'));
  assert.equal(json(result).activity.length, 20);
  assert.equal(json(result).ttlDays, 30);
});

// ── P1/P2/P3: the read-only, allow-listed pipeline surface ─────────────────

void test('GET /pipelines maps GetPipelineState onto the panel shape', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  stub.pipelineExecutions[OWN_PIPELINE] = [
    { id: 'abcdef1234567890', status: 'InProgress', startTime: '2026-08-05T11:50:00.000Z' },
    { id: 'bbbbbbbb-2222', status: 'Succeeded', startTime: '2026-08-05T09:00:00.000Z' },
  ];
  const handle = createHandler(stub.deps());

  const result = await handle(http('GET', '/pipelines', { origin: PANEL_ORIGIN })) as HttpResult;
  const body = json(result);

  assert.equal(result.statusCode, 200);
  assert.equal(body.pipelines.length, 1);
  const pipeline = body.pipelines[0];
  assert.equal(pipeline.name, OWN_PIPELINE);
  assert.deepEqual(pipeline.stages, [
    { name: 'Source', status: 'Succeeded' },
    { name: 'Build', status: 'InProgress' },
    { name: 'Deploy', status: 'Failed' },
  ]);
  // `updated` is the newest action status change, as an ISO string.
  assert.equal(pipeline.updated, '2026-08-05T11:52:00.000Z');
  assert.deepEqual(pipeline.history, [
    { status: 'InProgress', when: '2026-08-05T11:50:00.000Z', id: 'abcdef12' },
    { status: 'Succeeded', when: '2026-08-05T09:00:00.000Z', id: 'bbbbbbbb' },
  ]);
  // Nothing failed with a message, so no failure field is invented.
  assert.equal('failure' in pipeline, false);
});

void test('GET /pipelines reports the first failed action\'s message, truncated', async () => {
  const stub = new Stub();
  const long = `Docker build failed: ${'x'.repeat(600)}`;
  stub.pipelineStates[OWN_PIPELINE] = {
    name: OWN_PIPELINE,
    stages: [
      { name: 'Source', status: 'Succeeded', actions: [{ name: 'GitHub', status: 'Succeeded' }] },
      {
        name: 'Build',
        status: 'Failed',
        actions: [
          { name: 'DockerBuild', status: 'Failed', errorMessage: long },
          { name: 'FrontendBuild', status: 'Failed', errorMessage: 'the second failure is not the headline' },
        ],
      },
    ],
  };
  const handle = createHandler(stub.deps());

  const pipeline = json(await handle(http('GET', '/pipelines'))).pipelines[0];

  assert.equal(pipeline.failure.length, FAILURE_MAX_LENGTH);
  assert.ok(pipeline.failure.startsWith('Docker build failed: '));
  assert.ok(pipeline.failure.endsWith('…'));
  assert.ok(!pipeline.failure.includes('second failure'));
});

void test('GET /pipelines asks only about allow-listed pipelines', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  stub.pipelineStates[PRODUCTION_PIPELINE] = runningPipeline(PRODUCTION_PIPELINE);
  const handle = createHandler(stub.deps());

  const body = json(await handle(http('GET', '/pipelines')));

  assert.deepEqual(body.pipelines.map((p: any) => p.name), [OWN_PIPELINE]);
  // The production pipeline is never even named in a call.
  assert.ok(!stub.pipelineCalls.some((call) => call.includes(PRODUCTION_PIPELINE)));
  assert.ok(!JSON.stringify(body).includes(PRODUCTION_PIPELINE));
});

void test('a pipeline the port hands back off-list is dropped, not rendered', async () => {
  const stub = new Stub();
  // The port answers a question about our pipeline with somebody else's — the
  // shape a mis-wired alias, a rename or a hostile stub would produce.
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(PRODUCTION_PIPELINE);
  const handle = createHandler(stub.deps());

  const result = await handle(http('GET', '/pipelines')) as HttpResult;

  assert.equal(result.statusCode, 200);
  assert.deepEqual(json(result).pipelines, []);
  assert.ok(!(result.body ?? '').includes(PRODUCTION_PIPELINE));
});

void test('GET /pipelines never advertises a pending approval or its token', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = {
    name: OWN_PIPELINE,
    stages: [
      { name: 'Source', status: 'Succeeded', actions: [{ name: 'GitHub', status: 'Succeeded' }] },
      {
        name: 'Approve',
        status: 'InProgress',
        // A real GetPipelineState carries `latestExecution.token` here. The
        // port has no field for it, so it cannot reach the response — and the
        // handler does not surface the gate at all, because the Approve button
        // on a public panel cannot work.
        actions: [{ name: 'ManualApproval', status: 'InProgress', lastStatusChange: '2026-08-05T11:55:00.000Z' }],
      },
    ],
  };
  const handle = createHandler(stub.deps());

  const result = await handle(http('GET', '/pipelines')) as HttpResult;
  const pipeline = json(result).pipelines[0];

  assert.equal(pipeline.pendingApproval, undefined);
  assert.equal('pendingApproval' in pipeline, false);
  assert.ok(!(result.body ?? '').includes('token'));
  // The stage itself is still shown, honestly, as InProgress.
  assert.deepEqual(pipeline.stages[1], { name: 'Approve', status: 'InProgress' });
});

void test('GET /pipelines exposes no console/log URL', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  const handle = createHandler(stub.deps());

  const result = await handle(http('GET', '/pipelines')) as HttpResult;

  assert.equal(json(result).pipelines[0].logUrl, undefined);
  assert.ok(!(result.body ?? '').includes('console.aws.amazon.com'));
});

void test('history is capped at the last five runs', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  stub.pipelineExecutions[OWN_PIPELINE] = Array.from({ length: 12 }, (_, i) => ({
    id: `run-${i}`,
    status: i === 0 ? 'Failed' : 'Succeeded',
    startTime: new Date(NOW - i * 60 * MINUTE).toISOString(),
    summary: i === 0 ? 'Stopped by the pipeline owner' : undefined,
  }));
  const handle = createHandler(stub.deps());

  const pipeline = json(await handle(http('GET', '/pipelines'))).pipelines[0];

  assert.equal(pipeline.history.length, 5);
  assert.equal(pipeline.history[0].summary, 'Stopped by the pipeline owner');
  assert.equal(pipeline.history[1].summary, undefined);
  assert.ok(stub.pipelineCalls.includes(`executions:${OWN_PIPELINE}:5`));
});

void test('pipeline state is cached so the panel\'s polling cannot hammer CodePipeline', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  const handle = createHandler(stub.deps());

  await handle(http('GET', '/pipelines'));
  const afterFirst = [...stub.pipelineCalls];
  assert.deepEqual(afterFirst, [`state:${OWN_PIPELINE}`, `executions:${OWN_PIPELINE}:5`]);

  // Five more polls inside the window: no further AWS calls at all.
  for (let i = 0; i < 5; i++) {
    stub.clock += 5_000;
    const cached = json(await handle(http('GET', '/pipelines')));
    assert.equal(cached.pipelines[0].name, OWN_PIPELINE);
  }
  assert.deepEqual(stub.pipelineCalls, afterFirst);

  // Past the TTL the state is refreshed.
  stub.clock = NOW + PIPELINE_CACHE_TTL_MS + 1;
  await handle(http('GET', '/pipelines'));
  assert.deepEqual(stub.pipelineCalls, [...afterFirst, ...afterFirst]);
});

void test('an unreadable pipeline degrades to an empty list instead of a 500', async () => {
  const stub = new Stub();
  const deps = stub.deps();
  const handle = createHandler({
    ...deps,
    pipelines: {
      ...deps.pipelines,
      state: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); },
    },
  });

  const result = await handle(http('GET', '/pipelines')) as HttpResult;

  assert.equal(result.statusCode, 200);
  assert.deepEqual(json(result).pipelines, []);
});

void test('with an empty allow-list GET /pipelines refuses honestly rather than listing anything', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  const handle = createHandler(stub.deps({ pipelines: [] }));

  const result = await handle(http('GET', '/pipelines')) as HttpResult;

  assert.equal(result.statusCode, 501);
  assert.equal(json(result).supported, false);
  assert.deepEqual(json(result).pipelines, []);
  assert.match(json(result).reason, /never lists the account/);
  assert.deepEqual(stub.pipelineCalls, []);
});

void test('run / approve / subscribe refuse politely and say why', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  const handle = createHandler(stub.deps());

  const refusals: Array<[string, string, unknown]> = [
    ['POST', '/pipelines/run', { name: OWN_PIPELINE }],
    ['POST', '/pipelines/approve', { name: OWN_PIPELINE, stage: 'Approve', action: 'ManualApproval', token: 'x', approved: true }],
    ['POST', '/pipelines/subscribe', { email: 'stranger@example.com' }],
  ];

  for (const [method, path, body] of refusals) {
    const result = await handle(http(method, path, { body, origin: PANEL_ORIGIN })) as HttpResult;
    assert.equal(result.statusCode, 501, path);
    assert.equal(json(result).supported, false, path);
    assert.match(json(result).reason, /read-only public demo/i, path);
    assert.equal(json(result).ok, undefined, path);
  }

  // The refusals are refusals: no AWS call of any kind was made.
  assert.deepEqual(stub.pipelineCalls, []);
  assert.deepEqual(stub.desiredCounts, []);
  assert.deepEqual(stub.rdsActions, []);

  // …and the subscriber list stays empty rather than leaking addresses.
  const subscriptions = await handle(http('GET', '/pipelines/subscriptions')) as HttpResult;
  assert.equal(subscriptions.statusCode, 501);
  assert.deepEqual(json(subscriptions).subscriptions, []);
  assert.match(json(subscriptions).reason, /read-only public demo/i);
});

void test('the refusals hold for a mutation dressed up as the read route', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  const handle = createHandler(stub.deps());

  // POST /pipelines is not a route at all: 404, and nothing is started.
  const posted = await handle(http('POST', '/pipelines', { body: { name: OWN_PIPELINE } })) as HttpResult;
  assert.equal(posted.statusCode, 404);
  assert.deepEqual(stub.pipelineCalls, []);
});

// ── G6: CORS ───────────────────────────────────────────────────────────────

void test('corsHeaders echoes only allow-listed origins and never uses a wildcard', () => {
  const allowed = corsHeaders(PANEL_ORIGIN, [PANEL_ORIGIN, DEV_ORIGIN]);
  assert.equal(allowed['access-control-allow-origin'], PANEL_ORIGIN);

  const dev = corsHeaders(DEV_ORIGIN, [PANEL_ORIGIN, DEV_ORIGIN]);
  assert.equal(dev['access-control-allow-origin'], DEV_ORIGIN);

  for (const origin of ['https://evil.example', 'null', undefined]) {
    const denied = corsHeaders(origin, [PANEL_ORIGIN, DEV_ORIGIN]);
    assert.equal(denied['access-control-allow-origin'], undefined);
    assert.ok(!Object.values(denied).includes('*'));
  }
});

void test('responses carry the CORS header only for allow-listed origins', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());

  const ok = await handle(http('GET', '/manifest', { origin: PANEL_ORIGIN })) as HttpResult;
  assert.equal(ok.headers?.['access-control-allow-origin'], PANEL_ORIGIN);

  const evil = await handle(http('GET', '/manifest', { origin: 'https://evil.example' })) as HttpResult;
  assert.equal(evil.headers?.['access-control-allow-origin'], undefined);
  assert.equal(evil.statusCode, 200); // still readable, just not from a browser page
});

void test('OPTIONS is answered without a body', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());
  const result = await handle(http('OPTIONS', '/power', { origin: DEV_ORIGIN })) as HttpResult;
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers?.['access-control-allow-origin'], DEV_ORIGIN);
});

// ── the rest of the panel's surface ────────────────────────────────────────

void test('GET /manifest advertises the playground limits', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());
  const body = json(await handle(http('GET', '/manifest')));

  assert.equal(body.publicDemo, true);
  assert.equal(body.maxOnMinutes, 180);
  assert.equal(body.maxRules, 10);
  assert.deepEqual(body.resources.map((r: any) => r.key), ['blog', 'database', 'control']);
  assert.deepEqual(body.resources.map((r: any) => r.powerable), [true, true, false]);
});

void test('GET /status returns the panel shape plus the auto-off clock', async () => {
  const stub = new Stub();
  stub.marker = { onSince: NOW - 30 * MINUTE };
  const handle = createHandler(stub.deps());

  const body = json(await handle(http('GET', '/status')));

  assert.deepEqual(body.services.blog, { type: 'ecs', desired: 1, running: 1, pending: 0, on: true });
  assert.deepEqual(body.services.database, { type: 'rds', status: 'available', on: true });
  assert.deepEqual(body.services.control, { type: 'info', on: true });
  assert.equal(body.demo.anyOn, true);
  assert.equal(body.demo.onForMinutes, 30);
  assert.equal(body.demo.autoOffAt, new Date(NOW - 30 * MINUTE + 180 * MINUTE).toISOString());
});

void test('GET / is the same as GET /status, and trailing slashes are ignored', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());
  assert.ok(json(await handle(http('GET', '/'))).services);
  assert.ok(json(await handle(http('GET', '/status/'))).services);
});

void test('GET /diagram merges live state onto the synth-time graph', async () => {
  const stub = new Stub();
  stub.ecsState = { desired: 0, running: 0, pending: 0 };
  stub.rdsStatus = 'stopped';
  const handle = createHandler(stub.deps());

  const body = json(await handle(http('GET', '/diagram')));
  const byId = Object.fromEntries(body.nodes.map((n: any) => [n.id, n]));

  assert.equal(byId.blog.state, 'off');
  assert.equal(byId.database.state, 'off');
  assert.equal(byId.visitor.state, undefined); // not a manifest resource
  assert.equal(body.edges.length, 1);
});

void test('GET /diag reports what works and is honest about what is skipped', async () => {
  const stub = new Stub();
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  const handle = createHandler(stub.deps());

  const checks = json(await handle(http('GET', '/diag'))).checks as any[];
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

  assert.equal(byName['ECS service'].ok, true);
  assert.equal(byName['RDS instance'].ok, true);
  assert.equal(byName['Scheduling rules'].ok, true);
  assert.equal(byName['Activity log'].ok, true);
  // The pipeline check reads the allow-listed pipeline BY NAME, never a list.
  assert.equal(byName['Pipelines (read-only)'].ok, true);
  assert.deepEqual(stub.pipelineCalls, [`state:${OWN_PIPELINE}`]);
  assert.equal(byName['Logs explorer'].skipped, true);
  assert.equal(byName['Drift detection'].skipped, true);
});

void test('GET /diag says so when no pipeline is exposed at all', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps({ pipelines: [] }));

  const checks = json(await handle(http('GET', '/diag'))).checks as any[];
  const check = checks.find((c) => c.name === 'Pipelines (read-only)');

  assert.equal(check.skipped, true);
  assert.match(check.error, /never lists the account/);
  assert.deepEqual(stub.pipelineCalls, []);
});

void test('a failing port shows up as a failed check rather than a 500', async () => {
  const stub = new Stub();
  const deps = stub.deps();
  const handle = createHandler({
    ...deps,
    rds: { ...deps.rds, status: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); } },
  });

  const checks = json(await handle(http('GET', '/diag'))).checks as any[];
  const rdsCheck = checks.find((c) => c.name === 'RDS instance');
  assert.equal(rdsCheck.ok, false);
  assert.match(rdsCheck.error, /AccessDenied/);
});

void test('skipped surfaces answer 501 with an honest reason and an empty collection', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());

  const logs = await handle(http('POST', '/logs/query', { body: { logGroup: '/diego/prod/site/blog' } })) as HttpResult;
  assert.equal(logs.statusCode, 501);
  assert.equal(json(logs).supported, false);
  assert.deepEqual(json(logs).events, []);
  assert.match(json(logs).reason, /logs:FilterLogEvents/);

  const drift = await handle(http('POST', '/drift')) as HttpResult;
  assert.equal(drift.statusCode, 501);
  assert.deepEqual(json(drift).resources, []);
});

void test('an unknown route is a 404, not a 500', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());

  const result = await handle(http('GET', '/nope')) as HttpResult;
  assert.equal(result.statusCode, 404);
  assert.equal(json(result).error, 'not found');
  assert.equal(json(result).path, '/nope');

  const wrongMethod = await handle(http('POST', '/status')) as HttpResult;
  assert.equal(wrongMethod.statusCode, 404);
});

void test('a port failure becomes a 500 with a name, not an unhandled rejection', async () => {
  const stub = new Stub();
  const deps = stub.deps();
  const handle = createHandler({
    ...deps,
    schedules: { ...deps.schedules, list: async () => { throw Object.assign(new Error('boom'), { name: 'ThrottlingException' }); } },
  });

  const result = await handle(http('GET', '/rules')) as HttpResult;
  assert.equal(result.statusCode, 500);
  assert.equal(json(result).error, 'ThrottlingException');
});

void test('a malformed body does not crash the handler', async () => {
  const stub = new Stub();
  const handle = createHandler(stub.deps());

  const result = await handle({
    version: '2.0',
    rawPath: '/power',
    body: '{not json',
    requestContext: { http: { method: 'POST', sourceIp: '203.0.113.1' } },
  }) as HttpResult;

  assert.equal(result.statusCode, 400);
  assert.deepEqual(stub.desiredCounts, []);
});

// ── G8: anonymous mutation is opt-in ───────────────────────────────────────
//
// The whole point of these: the flag is enforced HERE. A panel that hides its
// buttons is a courtesy; a handler that returns 401 is the boundary.

/** Every route a token-less caller may still use, in either mode. */
const READ_ROUTES = [
  'GET /manifest',
  'GET /status',
  'GET /',
  'GET /rules',
  'GET /diagram',
  'GET /diag',
  'GET /activity',
  'GET /pipelines',
];

/** A stub with a rule to toggle/delete and a pipeline to read. */
function seeded(): Stub {
  const stub = new Stub();
  stub.rules = [{
    name: 'diego-control-nightly',
    schedule: 'cron(0 21 ? * MON-FRI *)',
    timezone: 'America/Santiago',
    target: 'all',
    state: 'off',
    enabled: true,
  }];
  stub.pipelineStates[OWN_PIPELINE] = runningPipeline(OWN_PIPELINE);
  return stub;
}

void test('bearerToken treats an empty or bare Bearer header as no token at all', () => {
  // What the panel sent for years, unconditionally.
  assert.equal(bearerToken('Bearer '), undefined);
  assert.equal(bearerToken('Bearer'), undefined);
  assert.equal(bearerToken(''), undefined);
  assert.equal(bearerToken('   '), undefined);
  assert.equal(bearerToken(undefined), undefined);

  assert.equal(bearerToken('Bearer abc123'), 'abc123');
  assert.equal(bearerToken('bearer  abc123  '), 'abc123');
  // Some clients send the value on its own.
  assert.equal(bearerToken('abc123'), 'abc123');
});

void test('tokenMatches accepts only the exact token and never a missing one', () => {
  assert.equal(tokenMatches(ADMIN_TOKEN, ADMIN_TOKEN), true);
  assert.equal(tokenMatches(`${ADMIN_TOKEN}x`, ADMIN_TOKEN), false);
  assert.equal(tokenMatches(ADMIN_TOKEN.slice(0, -1), ADMIN_TOKEN), false);
  assert.equal(tokenMatches(ADMIN_TOKEN.toUpperCase(), ADMIN_TOKEN), false);
  // A different length must be a plain false, not a thrown timingSafeEqual.
  assert.equal(tokenMatches('x', ADMIN_TOKEN), false);
  assert.equal(tokenMatches('', ADMIN_TOKEN), false);
  assert.equal(tokenMatches(undefined, ADMIN_TOKEN), false);
  // No token configured means nothing can authorise a mutation.
  assert.equal(tokenMatches(ADMIN_TOKEN, undefined), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches(undefined, undefined), false);
});

void test('allowAnon=false refuses every mutating route to an anonymous caller', async () => {
  for (const route of MUTATING_ROUTES) {
    const stub = seeded();
    const handle = createHandler(stub.deps({ allowAnon: false }));
    const { method, path, body } = mutation(route);

    const result = await handle(http(method, path, { body, origin: PANEL_ORIGIN })) as HttpResult;

    assert.equal(result.statusCode, 401, route);
    assert.equal(json(result).error, 'unauthorized', route);
    assert.equal(json(result).allowAnon, false, route);
    assert.ok(json(result).message.includes('bearer token'), route);
    assert.equal(result.headers?.['www-authenticate'], 'Bearer realm="diego-control"', route);
    // Still an allow-listed origin: a 401 must not also break CORS.
    assert.equal(result.headers?.['access-control-allow-origin'], PANEL_ORIGIN, route);
    // Refused before a single AWS call.
    assert.deepEqual(stub.desiredCounts, [], route);
    assert.deepEqual(stub.rdsActions, [], route);
    assert.deepEqual(stub.putRules, [], route);
    assert.deepEqual(stub.removedRules, [], route);
  }
});

void test('allowAnon=false accepts the same routes when they carry the admin token', async () => {
  for (const route of MUTATING_ROUTES) {
    const stub = seeded();
    const handle = createHandler(stub.deps({ allowAnon: false }));
    const { method, path, body } = mutation(route);

    const result = await handle(http(method, path, {
      body,
      token: ADMIN_TOKEN,
      origin: PANEL_ORIGIN,
    })) as HttpResult;

    assert.equal(result.statusCode, 200, route);
    assert.equal(json(result).ok, true, route);
  }

  // …and the work actually happened, not just a 200.
  const stub = seeded();
  const handle = createHandler(stub.deps({ allowAnon: false }));
  await handle(http('POST', '/power', { body: { target: 'all', state: 'off' }, token: ADMIN_TOKEN }));
  assert.deepEqual(stub.desiredCounts, [0]);
  assert.deepEqual(stub.rdsActions, ['stop:diego-site-db']);
});

void test('allowAnon=false refuses a wrong token, an empty bearer and a bare scheme', async () => {
  for (const authorization of ['Bearer wrong-token', 'Bearer ', 'Bearer', '', 'Basic abc']) {
    const stub = seeded();
    const handle = createHandler(stub.deps({ allowAnon: false }));

    const result = await handle(http('POST', '/power', {
      body: { target: 'all', state: 'on' },
      authorization,
    })) as HttpResult;

    assert.equal(result.statusCode, 401, JSON.stringify(authorization));
    assert.deepEqual(stub.desiredCounts, [], JSON.stringify(authorization));
  }
});

void test('allowAnon=false with no token configured cannot be talked into a mutation', async () => {
  const stub = seeded();
  const handle = createHandler(stub.deps({ allowAnon: false, adminToken: undefined }));

  for (const authorization of ['Bearer ', 'Bearer undefined', 'Bearer null', 'Bearer ""']) {
    const result = await handle(http('POST', '/power', {
      body: { target: 'all', state: 'on' },
      authorization,
    })) as HttpResult;
    assert.equal(result.statusCode, 401, authorization);
  }
  assert.deepEqual(stub.desiredCounts, []);
});

void test('allowAnon=true lets an anonymous caller mutate, exactly as before', async () => {
  for (const route of MUTATING_ROUTES) {
    const stub = seeded();
    const handle = createHandler(stub.deps({ allowAnon: true }));
    const { method, path, body } = mutation(route);

    const result = await handle(http(method, path, { body, origin: PANEL_ORIGIN })) as HttpResult;

    assert.equal(result.statusCode, 200, route);
    assert.equal(json(result).ok, true, route);
  }
});

void test('read routes stay anonymous in BOTH modes', async () => {
  for (const allowAnon of [true, false]) {
    for (const route of READ_ROUTES) {
      const stub = seeded();
      const handle = createHandler(stub.deps({ allowAnon }));
      const [method, path] = route.split(' ');

      const result = await handle(http(method, path, { origin: PANEL_ORIGIN })) as HttpResult;

      assert.equal(result.statusCode, 200, `${route} (allowAnon=${allowAnon})`);
    }
  }
});

void test('the honest 501 surfaces still explain themselves in read-only mode', async () => {
  // A control the panel must hide is better explained than silently 401'd:
  // these mutate nothing, so the reason is worth as much to a visitor as to
  // an operator.
  const stub = seeded();
  const handle = createHandler(stub.deps({ allowAnon: false }));

  for (const path of ['/pipelines/run', '/pipelines/approve', '/pipelines/subscribe', '/logs/query', '/drift']) {
    const result = await handle(http('POST', path, { body: {} })) as HttpResult;
    assert.equal(result.statusCode, 501, path);
    assert.equal(json(result).supported, false, path);
    assert.ok(json(result).reason.length > 0, path);
  }
});

void test('the watchdog and the nightly lights-out run whatever allowAnon says', async () => {
  for (const allowAnon of [true, false]) {
    const stub = seeded();
    stub.marker = { onSince: NOW - 200 * MINUTE };
    const handle = createHandler(stub.deps({ allowAnon, adminToken: undefined }));

    // Not an HTTP event: EventBridge invokes the function directly, and its
    // right to do so is IAM, not a bearer token.
    const watchdog = await handle({ mode: 'watchdog' }) as Record<string, unknown>;
    assert.equal(watchdog.action, 'off', `allowAnon=${allowAnon}`);
    assert.deepEqual(stub.desiredCounts, [0], `allowAnon=${allowAnon}`);

    // A fresh stub: the watchdog above already left everything off.
    const nightly = seeded();
    const lightsOut = await createHandler(nightly.deps({ allowAnon, adminToken: undefined }))(
      { mode: 'lights-out' },
    ) as Record<string, unknown>;
    assert.equal(lightsOut.action, 'off', `allowAnon=${allowAnon}`);
    assert.deepEqual(nightly.desiredCounts, [0], `allowAnon=${allowAnon}`);
  }
});

void test('a schedule rule firing is not gated either', async () => {
  const stub = seeded();
  const handle = createHandler(stub.deps({ allowAnon: false, adminToken: undefined }));

  await handle({ target: 'all', state: 'off', rule: 'diego-control-nightly' });

  assert.deepEqual(stub.desiredCounts, [0]);
  assert.equal(stub.activity[0].action, 'schedule:off');
});

void test('GET /manifest advertises allowAnon, with publicDemo as its alias', async () => {
  for (const allowAnon of [true, false]) {
    const stub = seeded();
    const handle = createHandler(stub.deps({ allowAnon }));
    const body = json(await handle(http('GET', '/manifest')));

    assert.equal(body.allowAnon, allowAnon);
    assert.equal(body.publicDemo, allowAnon);
  }
});

void test('GET /manifest advertises every refused surface, so the panel never draws a control that would refuse', async () => {
  // P4. Without this the panel renders Run / Check drift / Subscribe, the
  // visitor clicks, and only then learns the plane will not do it.
  for (const allowAnon of [true, false]) {
    const stub = seeded();
    const handle = createHandler(stub.deps({ allowAnon }));
    const body = json(await handle(http('GET', '/manifest')));
    const surfaces = body.surfaces as Record<string, { supported: boolean; reason: string }>;

    // Keyed by PATH, exactly as the panel's `reason(path)` looks them up.
    for (const path of ['/pipelines/run', '/pipelines/approve', '/pipelines/subscribe', '/pipelines/subscriptions', '/logs/query', '/drift']) {
      assert.equal(surfaces[path]?.supported, false, `${path} should be advertised as unsupported`);
      assert.ok((surfaces[path]?.reason ?? '').length > 40, `${path} should carry the API's own reason`);
    }
    // Implemented routes are absent from the map — their controls stay.
    assert.equal(surfaces['/pipelines'], undefined);
    assert.equal(surfaces['/power'], undefined);
    assert.equal(surfaces['/rules'], undefined);
    // The reasons are the same text the 501 bodies carry.
    assert.equal(surfaces['/drift'].reason, json(await handle(http('POST', '/drift'))).reason);
  }
});

void test('GET /manifest advertises /pipelines itself when nothing was allow-listed', async () => {
  const stub = seeded();
  const handle = createHandler(stub.deps({ pipelines: [] }));
  const surfaces = json(await handle(http('GET', '/manifest'))).surfaces as Record<string, { reason: string }>;

  assert.equal(surfaces['/pipelines'].reason, json(await handle(http('GET', '/pipelines'))).reason);
});

void test('advertisedSurfaces collapses METHOD /path to the path the panel keys on', () => {
  const surfaces = advertisedSurfaces();
  for (const key of Object.keys(surfaces)) {
    assert.ok(key.startsWith('/'), `${key} should be a bare path`);
    assert.equal(surfaces[key].supported, false);
  }
});

void test('GET /manifest never inherits a stale publicDemo from the baked manifest', async () => {
  // MANIFEST is captured at synth time; ALLOW_ANON is the authority. A
  // manifest that still said `publicDemo: true` must not out-vote the gate.
  const stub = seeded();
  const handle = createHandler(stub.deps({
    allowAnon: false,
    manifest: { ...manifest, allowAnon: true, publicDemo: true },
  }));

  const body = json(await handle(http('GET', '/manifest')));
  assert.equal(body.allowAnon, false);
  assert.equal(body.publicDemo, false);
});

void test('GET /status reports the same flag as GET /manifest', async () => {
  for (const allowAnon of [true, false]) {
    const stub = seeded();
    const handle = createHandler(stub.deps({ allowAnon }));
    const body = json(await handle(http('GET', '/status')));

    assert.equal(body.demo.allowAnon, allowAnon);
    assert.equal(body.demo.publicDemo, allowAnon);
  }
});

void test('a refused mutation is audited with a hashed actor and never the token', async () => {
  const stub = seeded();
  const handle = createHandler(stub.deps({ allowAnon: false }));

  await handle(http('POST', '/power', { body: { target: 'all', state: 'on' } }));
  await handle(http('POST', '/power', { body: { target: 'all', state: 'on' }, token: 'not-the-token' }));

  const [withToken, withoutToken] = stub.activity;
  assert.equal(withoutToken.action, 'auth:denied');
  assert.equal(withoutToken.result, 'rejected: no token');
  assert.equal(withoutToken.target, 'POST /power');
  assert.ok(withoutToken.actor.startsWith('visitor-'));
  assert.equal(withToken.result, 'rejected: invalid token');

  const feed = JSON.stringify(stub.activity);
  assert.ok(!feed.includes('not-the-token'));
  assert.ok(!feed.includes(ADMIN_TOKEN));
});

void test('no response ever echoes the admin token', async () => {
  const stub = seeded();
  const handle = createHandler(stub.deps({ allowAnon: false }));

  const bodies: string[] = [];
  for (const route of [...READ_ROUTES, ...MUTATING_ROUTES]) {
    const [method, path] = route.split(' ');
    const anonymous = await handle(http(method, path, { body: MUTATION_BODIES[route] })) as HttpResult;
    const authenticated = await handle(http(method, path, {
      body: MUTATION_BODIES[route],
      token: ADMIN_TOKEN,
    })) as HttpResult;
    bodies.push(anonymous.body ?? '', authenticated.body ?? '');
  }

  for (const body of bodies) assert.ok(!body.includes(ADMIN_TOKEN));
});

void test('OPTIONS preflight is never gated — a browser attaches no credentials to it', async () => {
  const stub = seeded();
  const handle = createHandler(stub.deps({ allowAnon: false }));

  const result = await handle(http('OPTIONS', '/power', { origin: PANEL_ORIGIN })) as HttpResult;

  assert.equal(result.statusCode, 204);
  assert.equal(result.headers?.['access-control-allow-origin'], PANEL_ORIGIN);
});
