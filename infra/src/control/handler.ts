import { createHash, timingSafeEqual } from 'node:crypto';
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
  PipelineRunView,
  PipelineView,
  PowerResult,
  PowerState,
  ScheduleRule,
} from './types';

/**
 * The control plane for diegopalominos.dev — the public playground.
 *
 * Anyone on the internet may call the READ endpoints. Whether an anonymous
 * caller may also MUTATE is one deliberate boolean, `allowAnon` (G8):
 *
 * - `allowAnon: false` (the DEFAULT) — every mutating route requires a bearer
 *   token; reads stay anonymous. A panel with no token renders the whole
 *   thing read-only, which is what a private deployment wants.
 * - `allowAnon: true` — anonymous mutation is on, because that IS the demo
 *   ("it's like turning lights on or off"). Nothing else changes: still
 *   throttled, still watchdog-capped, still audited with a hashed actor.
 *
 * The flag is enforced HERE, in the handler, not merely rendered by the
 * panel: a UI that hides a button is a hint, and this is the boundary.
 *
 * Everything dangerous is removed rather than guarded by a password, so that
 * `allowAnon: true` stays defensible:
 *
 * - the only mutation on ECS is `desiredCount` clamped to 0 or 1 (G2) — there
 *   is no scale, no delete, no deploy endpoint anywhere in this file;
 * - the only mutation on RDS is start/stop of ONE instance;
 * - the pipeline surface is READ-ONLY and allow-listed: `GET /pipelines`
 *   reports the named pipelines it was handed and nothing else, and run /
 *   approve / subscribe are refused honestly (P1-P3, below);
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
  /*
   * P1 — the pipeline surface is read-only.
   *
   * `GET /pipelines` IS implemented (see the route below): the panel shows this
   * stack's own pipeline, its stages and its last few runs. Everything that
   * would let a stranger CHANGE something stays refused, and the refusal says
   * why rather than pretending the button worked. The panel renders Run and
   * Approve regardless — these payloads are what those buttons hit.
   *
   * These are not just unimplemented handlers: the role has no
   * `codepipeline:StartPipelineExecution` / `PutApprovalResult` / `sns:*`
   * permission at all, and the permissions boundary denies them explicitly, so
   * wiring one up later takes a deliberate change in two more places.
   */
  'POST /pipelines/run': {
    reason: 'This control plane is a read-only public demo: it can show a pipeline\'s state, never start one. '
      + 'Nobody should be able to trigger a deployment from an anonymous page, so the Lambda holds no '
      + 'codepipeline:StartPipelineExecution permission and its IAM boundary denies it. Deployments run from the '
      + 'private ops panel.',
    empty: {},
  },
  'POST /pipelines/approve': {
    reason: 'This control plane is a read-only public demo: approval gates cannot be actioned from it. '
      + 'The Lambda holds no codepipeline:PutApprovalResult permission and its IAM boundary denies it — an anonymous '
      + 'visitor must never be able to wave a deployment through. Approve from the private ops panel.',
    empty: {},
  },
  'GET /pipelines/subscriptions': {
    reason: 'This control plane is a read-only public demo and keeps no subscriber list: publishing the addresses '
      + 'signed up for pipeline notifications on an anonymous page would leak them. Subscriptions live in the '
      + 'private ops panel.',
    empty: { subscriptions: [] },
  },
  'POST /pipelines/subscribe': {
    reason: 'This control plane is a read-only public demo: it will not sign an email address up for anything. '
      + 'An anonymous endpoint that emails any address handed to it is a spam relay, so there is no SNS topic and no '
      + 'sns:Subscribe permission here. Subscribe from the private ops panel.',
    empty: {},
  },
  'POST /drift': {
    reason: 'Drift detection needs cloudformation:DetectStackResourceDrift, which the same-account fencing denies '
      + 'to this role (F3). Run it from the private ops panel instead.',
    empty: { resources: [] },
  },
};

/**
 * P4 — the refusals, advertised up front on `GET /manifest`.
 *
 * `SKIPPED_SURFACES` already answers every unimplemented route with
 * `{ supported: false, reason }`, but only once something CALLS it — which
 * means a panel renders "Run", "Check drift" or "Subscribe", the visitor
 * clicks, and the button explains itself afterwards. A control that refuses
 * is worse than an explained absence, so the manifest says the same thing
 * before the first paint and the panel simply never draws those controls.
 *
 * Keyed by PATH rather than `METHOD /path`: a surface is one idea to a panel
 * ("can this plane approve?"), not one HTTP verb. Where two methods share a
 * path the reason is the same anyway.
 *
 * This is a READ, and identical in both `allowAnon` modes — a read-only
 * visitor deserves the explanation exactly as much as an authenticated one.
 */
export function advertisedSurfaces(): Record<string, { supported: false; reason: string }> {
  const surfaces: Record<string, { supported: false; reason: string }> = {};
  for (const [route, skipped] of Object.entries(SKIPPED_SURFACES)) {
    const path = route.slice(route.indexOf(' ') + 1);
    surfaces[path] ??= { supported: false, reason: skipped.reason };
  }
  return surfaces;
}

/** `cron(<min> <hour> ? * <days> *)` — the only expression the panel emits. */
export const CRON_PATTERN = /^cron\(\s*([0-5]?\d)\s+([01]?\d|2[0-3])\s+\?\s+\*\s+(\*|[A-Z]{3}(-[A-Z]{3})?|[A-Z]{3}(,[A-Z]{3})*)\s+\*\s*\)$/;

/** 30 days, in seconds — the activity feed's TTL horizon (G7). */
export const ACTIVITY_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * P2 — how long a pipeline snapshot is served from memory.
 *
 * The panel polls, several visitors can poll at once, and CodePipeline's
 * describe APIs are throttled per account — an account that also runs
 * production pipelines. 45s is short enough that the panel still feels live
 * (a deploy takes minutes) and long enough that a page left open overnight
 * costs a couple of API calls a minute at most.
 */
export const PIPELINE_CACHE_TTL_MS = 45_000;

/** Runs shown per pipeline (`ListPipelineExecutions`). */
export const PIPELINE_HISTORY_LIMIT = 5;

/** A failure message is a diagnostic, not a log dump: keep it readable. */
export const FAILURE_MAX_LENGTH = 300;

/** Answer when this control plane was given no pipelines to report on. */
export const NO_PIPELINES_REASON =
  'No pipeline is exposed to this control plane. It reports only the pipelines it is explicitly handed (today: the '
  + 'one that deploys this site) and never lists the account, because the account also runs unrelated production '
  + 'pipelines whose names must not appear on a public page.';

/** Trim a failure message to something a panel row can carry. */
export function truncateFailure(message: string, max: number = FAILURE_MAX_LENGTH): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

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

/*
 * ── G8: anonymous mutation is opt-in ────────────────────────────────────
 *
 * These four routes CHANGE something. When `allowAnon` is false each of them
 * requires the bearer token; every other route — `/manifest`, `/status`,
 * `/diagram`, `/diag`, `/activity`, `/pipelines`, `GET /rules` — stays
 * anonymous in both modes, because reading is what makes the panel worth
 * showing a stranger at all.
 *
 * The stack imports this list to build its per-route throttles, so the routes
 * that are rate-limited and the routes that are gated cannot drift apart.
 */
export const MUTATING_ROUTES: readonly string[] = [
  'POST /power',
  'POST /rules',
  'POST /rules/delete',
  'POST /rules/toggle',
];

/**
 * Why a mutation was refused. Honest about the mode, and silent about the
 * token: it never says whether one was configured, only what the caller has
 * to do.
 */
export const UNAUTHORIZED_MESSAGE =
  'This control plane is read-only for anonymous callers: reading the status, the diagram, the schedules and the '
  + 'activity feed needs nothing, but changing anything needs a bearer token. Add one in the panel\'s Manage card, or '
  + 'redeploy with -c allowAnon=true if this deployment is meant to let anyone flip the lights.';

/**
 * The bearer token a request presents, or undefined when it presents none.
 *
 * `Authorization: Bearer ` with an empty value — which is exactly what the
 * panel used to send unconditionally — is NOT a token. Neither is a bare
 * `Bearer`. A raw value with no scheme is accepted, since some clients send
 * the token alone.
 */
export function bearerToken(authorization: string | undefined): string | undefined {
  const raw = (authorization ?? '').trim();
  if (!raw) return undefined;
  const value = raw.replace(/^Bearer\s*/i, '').trim();
  return value || undefined;
}

/**
 * Compare a presented token with the configured one without leaking timing.
 *
 * Both sides are hashed first, then compared with `timingSafeEqual`. Hashing
 * is what makes that possible at all: `timingSafeEqual` throws on a length
 * mismatch, so comparing the raw strings would need a length check that
 * itself tells an attacker how long the secret is. Digests are always 32
 * bytes, so the comparison is over a fixed width and reveals neither the
 * length nor the position of the first differing byte.
 *
 * No token configured, or none presented, is a plain false — never a match.
 */
export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
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

  /*
   * ── pipelines (read-only, allow-listed) ──────────────────────────────
   *
   * P3 — the allow-list is the whole design.
   *
   * `env.pipelines` is the list of pipeline names the stack handed this
   * function (its own, today). The handler iterates THAT list — it never asks
   * AWS what pipelines exist, and `deps.pipelines` has no operation that
   * could. A response is dropped unless the name AWS echoes back is on the
   * list too, so a mis-wired or mischievous port cannot smuggle a production
   * pipeline onto a public page.
   */

  /** Cached snapshot; see PIPELINE_CACHE_TTL_MS. Warm containers only. */
  let pipelineCache: { at: number; value: PipelineView[] } | undefined;

  async function pipelineView(name: string): Promise<PipelineView | undefined> {
    const snapshot = await deps.pipelines.state(name);
    if (!snapshot) return undefined;
    // The allow-list, re-checked on the way out (see P3).
    if (!env.pipelines.includes(snapshot.name)) {
      console.error('dropping a pipeline that is not on the allow-list');
      return undefined;
    }

    let updated: number | undefined;
    let failure: string | undefined;
    const stages = snapshot.stages.map((stage) => {
      for (const action of stage.actions ?? []) {
        const changed = action.lastStatusChange ? Date.parse(action.lastStatusChange) : Number.NaN;
        if (Number.isFinite(changed) && (updated === undefined || changed > updated)) updated = changed;
        if (!failure && action.status === 'Failed' && action.errorMessage) {
          failure = truncateFailure(action.errorMessage);
        }
        /*
         * A waiting manual-approval action is deliberately NOT reported.
         *
         * The panel would render "Awaiting approval" with Approve/Reject
         * buttons, and those buttons cannot work here: approving is a
         * mutation, this plane is read-only, and `POST /pipelines/approve`
         * refuses. Advertising a gate that a visitor can see but not action —
         * and doing it with the approval TOKEN in the JSON, where anyone
         * could take it to the CLI — is worse than staying quiet. So there is
         * no `pendingApproval` in the response, and `PipelineActionState` has
         * no field for the token in the first place.
         */
      }
      return { name: stage.name, status: stage.status ?? 'Unknown' };
    });

    let history: PipelineRunView[] = [];
    try {
      const executions = await deps.pipelines.executions(name, PIPELINE_HISTORY_LIMIT);
      history = executions.slice(0, PIPELINE_HISTORY_LIMIT).map((execution) => ({
        status: execution.status ?? 'Unknown',
        when: execution.startTime ?? '',
        ...(execution.id ? { id: execution.id.slice(0, 8) } : {}),
        ...(execution.summary ? { summary: truncateFailure(execution.summary) } : {}),
      }));
    } catch (err) {
      // History is a nice-to-have; the stage row is the point.
      console.error('pipeline history read failed', errorName(err));
    }

    // A pipeline that has not moved since the last cold start still deserves a
    // timestamp: fall back to its newest run.
    if (updated === undefined) {
      const newest = history.map((run) => Date.parse(run.when)).filter((ms) => Number.isFinite(ms));
      if (newest.length) updated = Math.max(...newest);
    }

    // No `logUrl` either: CodePipeline's externalExecutionUrl is a console deep
    // link carrying the account id and the CodeBuild project/build ids, and a
    // console link is useless to an anonymous visitor who cannot sign in.
    return {
      name: snapshot.name,
      ...(updated === undefined ? {} : { updated: new Date(updated).toISOString() }),
      stages,
      ...(failure ? { failure } : {}),
      history,
    };
  }

  /** `GET /pipelines` — the allow-listed pipelines, cached briefly (P2). */
  async function pipelines(): Promise<PipelineView[]> {
    const at = deps.now();
    if (pipelineCache && at - pipelineCache.at < PIPELINE_CACHE_TTL_MS) return pipelineCache.value;

    const views: PipelineView[] = [];
    for (const name of env.pipelines) {
      try {
        const view = await pipelineView(name);
        if (view) views.push(view);
      } catch (err) {
        // One unreadable pipeline must not 500 the page — and caching the
        // (possibly empty) result also keeps a failure from turning the
        // panel's polling into a retry storm against CodePipeline.
        console.error('pipeline state read failed', name, err);
      }
    }
    pipelineCache = { at, value: views };
    return views;
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
    if (env.pipelines.length > 0) {
      // Reads the FIRST allow-listed pipeline by name — never a listing.
      await run('Pipelines (read-only)', () => deps.pipelines.state(env.pipelines[0]));
    } else {
      checks.push({ name: 'Pipelines (read-only)', ok: false, skipped: true, error: NO_PIPELINES_REASON });
    }
    checks.push({ name: 'Logs explorer', ok: false, skipped: true, error: SKIPPED_SURFACES['POST /logs/query'].reason });
    checks.push({ name: 'Drift detection', ok: false, skipped: true, error: SKIPPED_SURFACES['POST /drift'].reason });
    return checks;
  }

  return async function handle(event: ControlEvent): Promise<HttpResult | Record<string, unknown>> {
    /*
     * ── non-HTTP invocations: watchdog, nightly lights-out, schedule rules ──
     *
     * These return BEFORE the G8 token gate, and must keep doing so. They do
     * not arrive over HTTP and carry no `authorization` header: EventBridge
     * invokes the function directly, and its right to do so is IAM, not a
     * bearer token. Gating them would mean the auto-off watchdog stops
     * working the moment `allowAnon` is false — the cost fence would be
     * disabled by the security setting.
     */
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

    // Preflight is answered before the gate: a browser never attaches
    // credentials to it, so a 401 here would break CORS rather than secure it.
    if (method === 'OPTIONS') return { statusCode: 204, headers };

    /*
     * G8 — the gate.
     *
     * Reads fall straight through. A mutation needs either `allowAnon` or a
     * matching bearer token; anything else is refused here, before a single
     * AWS call is made and before the body is even looked at.
     *
     * The 501 surfaces (`POST /pipelines/run`, `/pipelines/approve`,
     * `/pipelines/subscribe`, `/logs/query`, `/drift`) are deliberately NOT
     * gated. They mutate nothing — they refuse, with a reason the panel shows
     * where the control would have been — and that explanation is worth just
     * as much to a read-only visitor as to an authenticated one.
     */
    if (!env.allowAnon && MUTATING_ROUTES.includes(route)) {
      const presented = bearerToken(header(event, 'authorization'));
      if (!tokenMatches(presented, env.adminToken)) {
        await record({
          at: new Date(deps.now()).toISOString(),
          action: 'auth:denied',
          actor,
          // Says which of the two it was, never anything about the token itself.
          result: presented ? 'rejected: invalid token' : 'rejected: no token',
          target: route,
        });
        return json(401, {
          ok: false,
          error: 'unauthorized',
          message: UNAUTHORIZED_MESSAGE,
          allowAnon: false,
        }, { ...headers, 'www-authenticate': 'Bearer realm="diego-control"' });
      }
    }

    const body = parseBody(event);

    try {
      if (route === 'GET /manifest') {
        return json(200, {
          ...env.manifest,
          /*
           * G8 — the panel reads its mode from here.
           *
           * `ALLOW_ANON` wins over whatever was baked into MANIFEST at synth
           * time (the stack sets both from one value, so they agree), and
           * `publicDemo` is kept as an alias for panels built before the flag
           * existed. Never a hardcoded `true` again.
           */
          allowAnon: env.allowAnon,
          publicDemo: env.allowAnon,
          maxOnMinutes: env.maxOnMinutes,
          maxRules: env.maxRules,
          panelUrl: env.panelUrl,
          siteUrl: env.siteUrl,
          /*
           * P4 — what this plane will NOT do, said before anyone tries.
           *
           * `GET /pipelines` joins the list only when no pipeline was
           * allow-listed, because that is the one case where the route itself
           * answers 501 (see below).
           */
          surfaces: {
            ...advertisedSurfaces(),
            ...(env.pipelines.length === 0
              ? { '/pipelines': { supported: false as const, reason: NO_PIPELINES_REASON } }
              : {}),
          },
        }, headers);
      }

      if (route === 'GET /status' || route === 'GET /') {
        const services = await statusAll();
        const { anyOn, onSince, onFor } = await onDuration(services);
        return json(200, {
          services,
          demo: {
            allowAnon: env.allowAnon,
            publicDemo: env.allowAnon,
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

      if (route === 'GET /pipelines') {
        if (env.pipelines.length === 0) {
          return json(501, { supported: false, reason: NO_PIPELINES_REASON, pipelines: [] }, headers);
        }
        return json(200, { pipelines: await pipelines() }, headers);
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
