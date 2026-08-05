import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampDesired,
  corsHeaders,
  createHandler,
  hashActor,
  ipPrefix,
  normalizeRuleName,
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

const manifest: Manifest = {
  env: 'prod',
  app: 'diego-site',
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
  actorSalt: 'stack/DiegoControlStack/1234',
  timezone: 'America/Santiago',
  panelUrl: PANEL_ORIGIN,
  siteUrl: 'https://diegopalominos.dev',
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

  /** Recorded calls, so a test can assert exactly what reached AWS. */
  public desiredCounts: number[] = [];
  public rdsActions: string[] = [];
  public putRules: ScheduleRule[] = [];
  public removedRules: string[] = [];

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
      now: () => this.clock,
      id: () => 'testid',
    };
  }
}

function http(
  method: string,
  path: string,
  options: { body?: unknown; origin?: string; ip?: string } = {},
): ControlEvent {
  return {
    version: '2.0',
    rawPath: path,
    headers: options.origin ? { origin: options.origin, authorization: 'Bearer ' } : { authorization: 'Bearer ' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    requestContext: {
      http: { method, path, sourceIp: options.ip ?? '203.0.113.42' },
    },
  };
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
  const handle = createHandler(stub.deps());

  const checks = json(await handle(http('GET', '/diag'))).checks as any[];
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

  assert.equal(byName['ECS service'].ok, true);
  assert.equal(byName['RDS instance'].ok, true);
  assert.equal(byName['Scheduling rules'].ok, true);
  assert.equal(byName['Activity log'].ok, true);
  assert.equal(byName.Pipelines.skipped, true);
  assert.equal(byName['Drift detection'].skipped, true);
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

  const pipelines = await handle(http('GET', '/pipelines')) as HttpResult;
  assert.equal(pipelines.statusCode, 501);
  assert.deepEqual(json(pipelines).pipelines, []);

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
