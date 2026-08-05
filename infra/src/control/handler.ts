import { createHash } from 'node:crypto';
import {
  ActivityEntry,
  ControlEnv,
  ControlEvent,
  Deps,
  Diagram,
  HttpEvent,
  HttpResult,
  Manifest,
  ManifestResource,
  PowerResult,
  PowerState,
  ScheduleRule,
} from './types';

/**
 * The control plane for diegopalominos.dev — the public playground.
 *
 * Anyone on the internet may call the read endpoints, flip the site on/off
 * and add a schedule: that IS the demo ("it's like turning lights on or
 * off"). Everything dangerous is therefore removed rather than guarded by a
 * password:
 *
 * - the only mutation on ECS is `desiredCount` clamped to 0 or 1 (G2) — there
 *   is no scale, no delete, no deploy endpoint anywhere in this file;
 * - the only mutation on RDS is start/stop of ONE instance;
 * - schedules live in a dedicated group, are name-prefixed and capped (G5);
 * - every action is written to a DynamoDB feed with a hashed IP prefix as the
 *   actor — never a raw IP (G7);
 * - a watchdog invocation turns everything off after MAX_ON_MINUTES (G4).
 *
 * Rate limiting (G3), CORS (G6) and IAM scoping (G1/F2/F3) are enforced by the
 * stack; the CORS allow-list is re-checked here so the Lambda is safe even if
 * it is ever reachable through another front door.
 */

/** Panel surfaces this stack deliberately does not implement. */
export interface SkippedSurface {
  readonly reason: string;
  /** Empty collection under the key the panel reads, so `|| []` degrades. */
  readonly empty: Record<string, unknown>;
}

export const SKIPPED_SURFACES: Record<string, SkippedSurface> = {
  'POST /logs/query': {
    reason: 'Log reads are not exposed on the public playground: the control role has no logs:FilterLogEvents '
      + 'permission, so visitor traffic can never read application logs.',
    empty: { events: [] },
  },
  'GET /pipelines': {
    reason: 'Pipelines are driven from the private ops panel. The public control plane has no codepipeline permissions.',
    empty: { pipelines: [] },
  },
  'POST /pipelines/run': {
    reason: 'Starting a deployment is not a visitor action. Use the private ops panel.',
    empty: {},
  },
  'POST /pipelines/approve': {
    reason: 'Approvals are not a visitor action. Use the private ops panel.',
    empty: {},
  },
  'GET /pipelines/subscriptions': {
    reason: 'Notification subscriptions are managed in the private ops panel.',
    empty: { subscriptions: [] },
  },
  'POST /pipelines/subscribe': {
    reason: 'Notification subscriptions are managed in the private ops panel.',
    empty: {},
  },
  'POST /drift': {
    reason: 'Drift detection needs cloudformation:DetectStackResourceDrift, which the same-account fencing denies '
      + 'to this role (F3). Run it from the private ops panel instead.',
    empty: { resources: [] },
  },
};

/** `cron(<min> <hour> ? * <days> *)` — the only expression the panel emits. */
export const CRON_PATTERN = /^cron\(\s*([0-5]?\d)\s+([01]?\d|2[0-3])\s+\?\s+\*\s+(\*|[A-Z]{3}(-[A-Z]{3})?|[A-Z]{3}(,[A-Z]{3})*)\s+\*\s*\)$/;

/** 30 days, in seconds — the activity feed's TTL horizon (G7). */
export const ACTIVITY_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The single most important guardrail (G2): a visitor may ask for "on" or
 * "off" and nothing else. Anything that is not clearly >= 1 becomes 0, and
 * anything >= 1 becomes exactly 1 — no scale-out is reachable through this
 * control plane, whatever the request body says.
 */
export function clampDesired(value: number): 0 | 1 {
  if (!Number.isFinite(value) || value < 1) return 0;
  return 1;
}

/** IPv4 -> `a.b.c.0/24`, IPv6 -> `h1:h2:h3:h4::/64`. Never the full address. */
export function ipPrefix(ip?: string): string {
  const raw = (ip ?? '').trim();
  if (!raw) return 'unknown';
  if (raw.includes(':')) {
    const hextets = raw.split(':').filter((part) => part !== '');
    if (hextets.length === 0) return 'unknown';
    return `${hextets.slice(0, 4).join(':')}::/64`;
  }
  const octets = raw.split('.');
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o))) return 'unknown';
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * The actor recorded in the public feed (G7). The raw IP never leaves this
 * function: it is reduced to a network prefix and then salted-hashed, so the
 * feed can say "same visitor" without ever storing a personal identifier.
 */
export function hashActor(ip: string | undefined, salt: string): string {
  const prefix = ipPrefix(ip);
  if (prefix === 'unknown') return 'visitor-anon';
  const digest = createHash('sha256').update(`${salt}|${prefix}`).digest('hex').slice(0, 12);
  return `visitor-${digest}`;
}

/**
 * CORS allow-list (G6). An origin that is not on the list gets no
 * `access-control-allow-origin` header at all — there is no wildcard branch.
 */
export function corsHeaders(origin: string | undefined, allowed: string[]): Record<string, string> {
  const base: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'vary': 'Origin',
  };
  if (!origin || !allowed.includes(origin)) return base;
  return {
    ...base,
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '600',
  };
}

/** Visitor rule names are slugged and prefixed so they can never collide (G5/F5). */
export function normalizeRuleName(raw: unknown, prefix: string): string | undefined {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!slug) return undefined;
  return slug.startsWith(prefix) ? slug : `${prefix}${slug}`;
}

/** Outcome of validating a visitor-submitted schedule. */
export type RuleValidation =
  | { readonly ok: true; readonly rule: ScheduleRule }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly message: string };

/** Everything `validateRule` needs to know about the current world. */
export interface RuleContext {
  readonly prefix: string;
  readonly maxRules: number;
  readonly timezone: string;
  /** Valid `target` values: the powerable panel keys plus `all`. */
  readonly targets: string[];
  /** Names of the rules that already exist in the group. */
  readonly existing: string[];
}

/**
 * Validate a schedule rule from an anonymous visitor.
 *
 * Cap semantics (G5): oldest wins. Once the group holds `maxRules` rules the
 * NEW one is rejected with a message that says what to do — existing rules are
 * never silently evicted, because someone else created them.
 */
export function validateRule(input: unknown, ctx: RuleContext): RuleValidation {
  const body = (input ?? {}) as Record<string, unknown>;
  const name = normalizeRuleName(body.name, ctx.prefix);
  if (!name) {
    return { ok: false, status: 400, error: 'invalid_name', message: 'A schedule needs a name (letters, digits and dashes).' };
  }

  const schedule = String(body.schedule ?? '');
  if (!CRON_PATTERN.test(schedule)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_schedule',
      message: 'Schedule must look like cron(<minute> <hour> ? * <days> *), e.g. cron(0 21 ? * MON-FRI *).',
    };
  }

  const state = String(body.state ?? '');
  if (state !== 'on' && state !== 'off') {
    return { ok: false, status: 400, error: 'invalid_state', message: 'state must be "on" or "off".' };
  }

  const target = String(body.target ?? 'all');
  if (!ctx.targets.includes(target)) {
    return {
      ok: false,
      status: 400,
      error: 'unknown_target',
      message: `Unknown target "${target}". Known targets: ${ctx.targets.join(', ')}.`,
    };
  }

  if (!ctx.existing.includes(name) && ctx.existing.length >= ctx.maxRules) {
    return {
      ok: false,
      status: 409,
      error: 'rule_limit',
      message: `The playground keeps at most ${ctx.maxRules} schedules and it already has ${ctx.existing.length}. `
        + 'The oldest ones keep their slots — delete one from the list before adding another.',
    };
  }

  return {
    ok: true,
    rule: {
      name,
      schedule,
      timezone: typeof body.timezone === 'string' && body.timezone ? body.timezone : ctx.timezone,
      target,
      state,
      enabled: body.enabled !== false,
    },
  };
}

/** Powerable manifest keys plus `all`. */
export function powerTargets(manifest: Manifest): string[] {
  return ['all', ...manifest.resources.filter((r) => r.powerable).map((r) => r.key)];
}

/** JSON response with the CORS headers this origin is entitled to. */
function json(statusCode: number, body: unknown, headers: Record<string, string>): HttpResult {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function parseBody(event: HttpEvent): Record<string, unknown> {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function header(event: HttpEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return hit ? headers[hit] : undefined;
}

/** Strip a trailing slash so `/status/` and `/status` are the same route. */
function normalizePath(event: HttpEvent): string {
  const raw = event.rawPath ?? event.requestContext?.http.path ?? '/';
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Build the handler around a set of ports. Production wires the real AWS
 * clients (see `aws.ts`); tests wire stubs.
 */
export function createHandler(deps: Deps) {
  const { env } = deps;

  const resourcesByKey = new Map<string, ManifestResource>(env.manifest.resources.map((r) => [r.key, r]));

  async function statusOf(resource: ManifestResource): Promise<Record<string, unknown>> {
    if (resource.type === 'ecs' && resource.ecs) {
      const state = await deps.ecs.describe(resource.ecs.cluster, resource.ecs.service);
      return {
        type: 'ecs',
        desired: state.desired,
        running: state.running,
        pending: state.pending,
        on: state.running > 0,
      };
    }
    if (resource.type === 'rds' && resource.rds) {
      const state = await deps.rds.status(resource.rds.instanceId);
      return { type: 'rds', status: state, on: state === 'available' };
    }
    return { type: 'info', on: true };
  }

  /** `{ blog: {...}, database: {...}, control: {...} }` — the panel's shape. */
  async function statusAll(): Promise<Record<string, Record<string, unknown>>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const resource of env.manifest.resources) {
      out[resource.key] = await statusOf(resource);
    }
    return out;
  }

  /** Pass a status map already in hand to avoid describing everything twice. */
  async function anythingOn(status?: Record<string, Record<string, unknown>>): Promise<boolean> {
    const map = status ?? await statusAll();
    return env.manifest.resources.some((resource) => resource.powerable && map[resource.key]?.on === true);
  }

  /**
   * Turn the lights on or off.
   *
   * `respectOverrides` is only true for schedule-driven `all` actions: a
   * general rule must not fight a rule someone created for one resource —
   * same semantics as the private ops panel.
   */
  async function applyPower(
    target: string,
    state: PowerState,
    options: { respectOverrides?: boolean } = {},
  ): Promise<PowerResult> {
    const on = state === 'on';
    const notes: string[] = [];
    const skipped: string[] = [];

    if (options.respectOverrides && target === 'all') {
      try {
        for (const rule of await deps.schedules.list()) {
          if (rule.enabled && rule.target !== 'all') skipped.push(rule.target);
        }
      } catch (err) {
        notes.push(`override check skipped: ${errorName(err)}`);
      }
    }

    const candidates = env.manifest.resources.filter((r) => r.powerable
      && (target === 'all' ? !skipped.includes(r.key) : r.key === target));

    const affected: string[] = [];
    for (const resource of candidates) {
      if (resource.type === 'ecs' && resource.ecs) {
        // G2: the only value that can ever reach ECS is 0 or 1.
        const desired = clampDesired(on ? resource.ecs.onDesired : 0);
        await deps.ecs.setDesiredCount(resource.ecs.cluster, resource.ecs.service, desired);
        affected.push(resource.key);
      } else if (resource.type === 'rds' && resource.rds) {
        const current = await deps.rds.status(resource.rds.instanceId);
        if (on && current === 'stopped') {
          await deps.rds.start(resource.rds.instanceId);
          affected.push(resource.key);
        } else if (!on && current === 'available') {
          await deps.rds.stop(resource.rds.instanceId);
          affected.push(resource.key);
        } else {
          notes.push(`${resource.key} is ${current} — nothing to do`);
        }
      }
    }

    return { ok: true, target, state, affected, skipped: [...new Set(skipped)], notes };
  }

  /**
   * Remember when the lights went on so the watchdog can time them out even
   * across cold starts. Cleared on the way down.
   *
   * First-on wins: pressing "on" again does NOT reset the clock, otherwise a
   * visitor could hold the playground open indefinitely by tapping the button
   * every couple of hours. The window always measures from the first switch-on
   * since everything was last off.
   */
  async function markPower(state: PowerState): Promise<void> {
    try {
      if (state === 'off') {
        await deps.activity.writeMarker({});
        return;
      }
      const existing = await deps.activity.readMarker();
      if (existing?.onSince) return;
      await deps.activity.writeMarker({ onSince: deps.now() });
    } catch (err) {
      console.error('power marker write failed', err);
    }
  }

  async function record(entry: ActivityEntry): Promise<void> {
    try {
      await deps.activity.record(entry);
    } catch (err) {
      console.error('activity write failed', err);
    }
  }

  /** How long the playground has been on, in ms, or undefined when it is off. */
  async function onDuration(
    status?: Record<string, Record<string, unknown>>,
  ): Promise<{ onSince?: number; onFor?: number; anyOn: boolean }> {
    const anyOn = await anythingOn(status);
    if (!anyOn) return { anyOn: false };

    let onSince: number | undefined;
    try {
      onSince = (await deps.activity.readMarker())?.onSince;
    } catch (err) {
      console.error('power marker read failed', err);
    }

    if (onSince === undefined) {
      // No marker (cold table, or someone started a task outside the panel):
      // fall back to the oldest running task, then to "now" so the next
      // window still catches it. Cost can never run away unattended.
      for (const resource of env.manifest.resources) {
        if (resource.type !== 'ecs' || !resource.ecs) continue;
        const started = await deps.ecs.oldestTaskStart(resource.ecs.cluster, resource.ecs.service);
        if (started !== undefined && (onSince === undefined || started < onSince)) onSince = started;
      }
    }

    if (onSince === undefined) {
      onSince = deps.now();
      await markPower('on');
    }

    return { anyOn, onSince, onFor: deps.now() - onSince };
  }

  /**
   * G4: the visitor-proof cost fence. Every 15 minutes this runs; when the
   * lights have been on longer than MAX_ON_MINUTES it switches them off and
   * says so in the public feed. `lights-out` is the nightly unconditional
   * version.
   */
  async function watchdog(mode: 'watchdog' | 'lights-out'): Promise<Record<string, unknown>> {
    const { anyOn, onSince, onFor } = await onDuration();
    const limitMs = env.maxOnMinutes * 60_000;

    if (!anyOn) {
      return { mode, action: 'none', reason: 'already off', maxOnMinutes: env.maxOnMinutes };
    }
    if (mode === 'watchdog' && (onFor ?? 0) <= limitMs) {
      return {
        mode,
        action: 'none',
        reason: 'within the allowance',
        onSince,
        onForMinutes: Math.round((onFor ?? 0) / 60_000),
        maxOnMinutes: env.maxOnMinutes,
      };
    }

    const result = await applyPower('all', 'off');
    await markPower('off');
    await record({
      at: new Date(deps.now()).toISOString(),
      action: mode === 'watchdog' ? 'watchdog:off' : 'lights-out:off',
      actor: mode,
      result: `ok (${result.affected.join(', ') || 'nothing running'})`,
      target: 'all',
    });
    return {
      mode,
      action: 'off',
      onSince,
      onForMinutes: Math.round((onFor ?? 0) / 60_000),
      maxOnMinutes: env.maxOnMinutes,
      affected: result.affected,
    };
  }

  /** A schedule rule fired: `{ target, state, rule }`. */
  async function scheduledAction(event: ControlEvent): Promise<Record<string, unknown>> {
    const state: PowerState = event.state === 'on' ? 'on' : 'off';
    const target = event.target ?? 'all';
    const result = await applyPower(target, state, { respectOverrides: true });
    await markPower(state);
    await record({
      at: new Date(deps.now()).toISOString(),
      action: `schedule:${state}`,
      actor: event.rule ? `schedule ${event.rule}` : 'schedule',
      result: `ok (${result.affected.join(', ') || 'no change'})`,
      target,
    });
    return result as unknown as Record<string, unknown>;
  }

  /** The live-status-annotated architecture snapshot (`GET /diagram`). */
  async function diagram(): Promise<Diagram> {
    const status = await statusAll();
    const nodes = env.diagram.nodes.map((node) => {
      const live = status[node.id];
      if (!live) return { ...node };
      return { ...node, state: live.on === true ? 'on' : 'off' };
    });
    return { nodes, edges: env.diagram.edges };
  }

  /** `GET /diag`: exercise every capability and report honestly (panel shape). */
  async function diag(): Promise<Array<Record<string, unknown>>> {
    const checks: Array<Record<string, unknown>> = [];
    const run = async (name: string, fn: () => Promise<unknown>) => {
      const started = deps.now();
      try {
        await fn();
        checks.push({ name, ok: true, ms: deps.now() - started });
      } catch (err) {
        checks.push({ name, ok: false, ms: deps.now() - started, error: `${errorName(err)}: ${errorMessage(err)}`.slice(0, 160) });
      }
    };

    const ecsResource = env.manifest.resources.find((r) => r.type === 'ecs');
    const rdsResource = env.manifest.resources.find((r) => r.type === 'rds');
    if (ecsResource?.ecs) {
      await run('ECS service', () => deps.ecs.describe(ecsResource.ecs!.cluster, ecsResource.ecs!.service));
    }
    if (rdsResource?.rds) {
      await run('RDS instance', () => deps.rds.status(rdsResource.rds!.instanceId));
    }
    await run('Scheduling rules', () => deps.schedules.list());
    await run('Activity log', () => deps.activity.recent(1));
    checks.push({ name: 'Logs explorer', ok: false, skipped: true, error: SKIPPED_SURFACES['POST /logs/query'].reason });
    checks.push({ name: 'Pipelines', ok: false, skipped: true, error: SKIPPED_SURFACES['GET /pipelines'].reason });
    checks.push({ name: 'Drift detection', ok: false, skipped: true, error: SKIPPED_SURFACES['POST /drift'].reason });
    return checks;
  }

  return async function handle(event: ControlEvent): Promise<HttpResult | Record<string, unknown>> {
    // ── non-HTTP invocations: watchdog, nightly lights-out, schedule rules ──
    if (!event.requestContext?.http) {
      if (event.mode === 'watchdog' || event.mode === 'lights-out') return watchdog(event.mode);
      return scheduledAction(event);
    }

    const method = event.requestContext.http.method.toUpperCase();
    const path = normalizePath(event);
    const route = `${method} ${path}`;
    const origin = header(event, 'origin');
    const headers = corsHeaders(origin, env.allowedOrigins);
    const actor = hashActor(event.requestContext.http.sourceIp, env.actorSalt);

    if (method === 'OPTIONS') return { statusCode: 204, headers };

    // Anonymous by design: this playground has no token. The panel always
    // sends `authorization`, which is simply ignored — so it works unmodified.
    const body = parseBody(event);

    try {
      if (route === 'GET /manifest') {
        return json(200, {
          ...env.manifest,
          publicDemo: true,
          maxOnMinutes: env.maxOnMinutes,
          maxRules: env.maxRules,
          panelUrl: env.panelUrl,
          siteUrl: env.siteUrl,
        }, headers);
      }

      if (route === 'GET /status' || route === 'GET /') {
        const services = await statusAll();
        const { anyOn, onSince, onFor } = await onDuration(services);
        return json(200, {
          services,
          demo: {
            publicDemo: true,
            anyOn,
            onSince: onSince ? new Date(onSince).toISOString() : undefined,
            onForMinutes: onFor === undefined ? undefined : Math.round(onFor / 60_000),
            maxOnMinutes: env.maxOnMinutes,
            autoOffAt: onSince ? new Date(onSince + env.maxOnMinutes * 60_000).toISOString() : undefined,
          },
        }, headers);
      }

      if (route === 'POST /power') {
        const state: PowerState | undefined = body.state === 'on' ? 'on' : body.state === 'off' ? 'off' : undefined;
        const target = String(body.target ?? 'all');
        if (!state) {
          return json(400, { ok: false, error: 'invalid_state', message: 'state must be "on" or "off".' }, headers);
        }
        if (!powerTargets(env.manifest).includes(target)) {
          return json(404, {
            ok: false,
            error: 'unknown_target',
            message: `Unknown target "${target}".`,
            targets: powerTargets(env.manifest),
          }, headers);
        }
        const result = await applyPower(target, state);
        await markPower(state);
        await record({
          at: new Date(deps.now()).toISOString(),
          action: `power:${state}`,
          actor,
          result: `ok (${result.affected.join(', ') || 'no change'})`,
          target,
        });
        return json(200, { ...result, actor, autoOffMinutes: env.maxOnMinutes }, headers);
      }

      if (route === 'GET /rules') {
        return json(200, { rules: await deps.schedules.list(), max: env.maxRules }, headers);
      }

      if (route === 'POST /rules') {
        const existing = await deps.schedules.list();
        const validation = validateRule(body, {
          prefix: env.rulePrefix,
          maxRules: env.maxRules,
          timezone: env.timezone,
          targets: powerTargets(env.manifest),
          existing: existing.map((r) => r.name),
        });
        if (!validation.ok) {
          await record({
            at: new Date(deps.now()).toISOString(),
            action: 'rule:create',
            actor,
            result: `rejected: ${validation.error}`,
            target: String(body.target ?? 'all'),
          });
          return json(validation.status, { ok: false, error: validation.error, message: validation.message }, headers);
        }
        await deps.schedules.put(validation.rule);
        await record({
          at: new Date(deps.now()).toISOString(),
          action: 'rule:create',
          actor,
          result: `ok (${validation.rule.name})`,
          target: validation.rule.target,
        });
        return json(200, { ok: true, name: validation.rule.name, rule: validation.rule }, headers);
      }

      if (route === 'POST /rules/delete') {
        const name = normalizeRuleName(body.name, env.rulePrefix);
        if (!name) return json(400, { ok: false, error: 'invalid_name', message: 'name is required.' }, headers);
        await deps.schedules.remove(name);
        await record({
          at: new Date(deps.now()).toISOString(),
          action: 'rule:delete',
          actor,
          result: `ok (${name})`,
        });
        return json(200, { ok: true, name }, headers);
      }

      if (route === 'POST /rules/toggle') {
        const name = normalizeRuleName(body.name, env.rulePrefix);
        if (!name) return json(400, { ok: false, error: 'invalid_name', message: 'name is required.' }, headers);
        const rule = await deps.schedules.get(name);
        if (!rule) return json(404, { ok: false, error: 'unknown_rule', message: `No schedule named "${name}".` }, headers);
        const enabled = body.enabled !== false;
        await deps.schedules.put({ ...rule, enabled });
        await record({
          at: new Date(deps.now()).toISOString(),
          action: enabled ? 'rule:enable' : 'rule:disable',
          actor,
          result: `ok (${name})`,
          target: rule.target,
        });
        return json(200, { ok: true, name, enabled }, headers);
      }

      if (route === 'GET /diagram') return json(200, await diagram(), headers);
      if (route === 'GET /diag') return json(200, { checks: await diag() }, headers);

      if (route === 'GET /activity') {
        const activity = await deps.activity.recent(20);
        return json(200, { activity, ttlDays: 30 }, headers);
      }

      const skipped = SKIPPED_SURFACES[route];
      if (skipped) {
        return json(501, { supported: false, reason: skipped.reason, ...skipped.empty }, headers);
      }

      return json(404, { error: 'not found', path, method }, headers);
    } catch (err) {
      console.error(route, err);
      return json(500, { error: errorName(err), message: errorMessage(err) }, headers);
    }
  };
}

function errorName(err: unknown): string {
  return (err as { name?: string } | undefined)?.name ?? 'Error';
}

function errorMessage(err: unknown): string {
  return String((err as { message?: string } | undefined)?.message ?? err);
}

/** Re-exported so the stack and the tests share one definition. */
export type { ControlEnv, Deps };
