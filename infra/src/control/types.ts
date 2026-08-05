/**
 * Shared types for the control Lambda (control.diegopalominos.dev).
 *
 * The handler never talks to the AWS SDK directly: it talks to the narrow
 * ports declared here. `aws.ts` implements them against the SDK that the
 * Node 22 Lambda runtime ships, and the unit tests implement them with
 * in-memory stubs — which is why `handler.ts` can be tested with `node:test`
 * and no credentials, no network and no `@aws-sdk/*` dependency.
 */

/** Resource kinds the Eleva panel knows how to render. */
export type PanelResourceType = 'ecs' | 'rds' | 'info';

/** Power state vocabulary shared by the API, the rules and the watchdog. */
export type PowerState = 'on' | 'off';

/** How the panel's log explorer should parse a group (kept for shape parity). */
export interface PanelLogFormat {
  readonly type: 'json' | 'auto' | 'plain';
}

/** A log group entry inside a manifest resource. */
export interface ManifestLogGroup {
  readonly logGroup: string;
  readonly format?: PanelLogFormat;
}

/**
 * One row in the panel's dashboard. `key` is the Eleva panel key: it comes
 * from the resource's PARENT construct id (`blog`, `database`), which is why
 * the site stack gives each service its own scope.
 */
export interface ManifestResource {
  readonly key: string;
  readonly name: string;
  readonly type: PanelResourceType;
  readonly powerable: boolean;
  readonly ecs?: { readonly cluster: string; readonly service: string; readonly onDesired: number };
  readonly rds?: { readonly instanceId: string };
  readonly logs?: ManifestLogGroup[];
}

/** `GET /manifest` payload — built at synth time and passed in as an env var. */
export interface Manifest {
  readonly env: string;
  readonly app: string;
  readonly resources: ManifestResource[];
  /** Public playground flag: the panel may show the "anyone can flip it" hint. */
  readonly publicDemo?: boolean;
  readonly siteUrl?: string;
}

/** A node in the `GET /diagram` graph (same shape the Eleva panel renders). */
export interface DiagramNode {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly cat: string;
  readonly group?: string;
  readonly details?: Record<string, string | number | boolean>;
  /** Merged in at request time from live status (`on` / `off` / `mid`). */
  state?: string;
}

/** An edge in the `GET /diagram` graph. */
export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly ext?: boolean;
  readonly pipe?: boolean;
}

/** The synth-time architecture snapshot served by `GET /diagram`. */
export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** Live ECS service counters. */
export interface EcsServiceState {
  readonly desired: number;
  readonly running: number;
  readonly pending: number;
}

/** ECS operations the control plane is allowed to perform. */
export interface EcsPort {
  describe(cluster: string, service: string): Promise<EcsServiceState>;
  /** desiredCount is clamped to 0 | 1 before it ever reaches this port. */
  setDesiredCount(cluster: string, service: string, desiredCount: 0 | 1): Promise<void>;
  /** Epoch ms of the oldest RUNNING task, used by the auto-off watchdog. */
  oldestTaskStart(cluster: string, service: string): Promise<number | undefined>;
}

/** RDS operations the control plane is allowed to perform. */
export interface RdsPort {
  /** `available` | `stopped` | `starting` | … | `unknown` when not readable. */
  status(instanceId: string): Promise<string>;
  start(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
}

/** A visitor-created schedule, as stored in EventBridge Scheduler. */
export interface ScheduleRule {
  readonly name: string;
  readonly schedule: string;
  readonly timezone?: string;
  readonly target: string;
  readonly state: PowerState;
  readonly enabled: boolean;
}

/** EventBridge Scheduler operations, all confined to one schedule group. */
export interface SchedulePort {
  list(): Promise<ScheduleRule[]>;
  get(name: string): Promise<ScheduleRule | undefined>;
  put(rule: ScheduleRule): Promise<void>;
  remove(name: string): Promise<void>;
}

/** One line of the public "who flipped the lights" feed. */
export interface ActivityEntry {
  /** ISO-8601 timestamp. */
  readonly at: string;
  /** e.g. `power:on`, `rule:create`, `watchdog:off`. */
  readonly action: string;
  /** Hashed /24 (or /64) IP prefix — never a raw address. */
  readonly actor: string;
  /** `ok`, `rejected: …`, `error: …`. */
  readonly result: string;
  readonly target?: string;
}

/** Persisted "the lights went on at …" marker used by the watchdog. */
export interface PowerMarker {
  readonly onSince?: number;
}

/** DynamoDB-backed activity log + power marker. */
export interface ActivityPort {
  record(entry: ActivityEntry): Promise<void>;
  recent(limit: number): Promise<ActivityEntry[]>;
  readMarker(): Promise<PowerMarker | undefined>;
  writeMarker(marker: PowerMarker): Promise<void>;
}

/** Everything the handler needs from its environment. */
export interface ControlEnv {
  readonly manifest: Manifest;
  readonly diagram: Diagram;
  readonly scheduleGroup: string;
  readonly rulePrefix: string;
  readonly maxRules: number;
  readonly maxOnMinutes: number;
  readonly allowedOrigins: string[];
  readonly actorSalt: string;
  readonly timezone: string;
  readonly panelUrl?: string;
  readonly siteUrl?: string;
}

/** Ports + clock + environment: the handler's entire universe. */
export interface Deps {
  readonly env: ControlEnv;
  readonly ecs: EcsPort;
  readonly rds: RdsPort;
  readonly schedules: SchedulePort;
  readonly activity: ActivityPort;
  /** Epoch ms. Injected so the watchdog tests can time-travel. */
  now(): number;
  /** Random suffix for activity sort keys. */
  id(): string;
}

/** API Gateway HTTP API (payload format 2.0) request. */
export interface HttpEvent {
  readonly version?: string;
  readonly rawPath?: string;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly http: {
      readonly method: string;
      readonly path?: string;
      readonly sourceIp?: string;
    };
  };
}

/** Direct invocation: the watchdog, the nightly lights-out, a schedule rule. */
export interface InvokeEvent {
  readonly mode?: 'watchdog' | 'lights-out';
  readonly target?: string;
  readonly state?: PowerState;
  /** Name of the schedule rule that fired, recorded as the actor. */
  readonly rule?: string;
}

export type ControlEvent = HttpEvent & InvokeEvent;

/** API Gateway proxy response. */
export interface HttpResult {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** Result of a power action, returned by `POST /power` and the watchdog. */
export interface PowerResult {
  readonly ok: boolean;
  readonly target: string;
  readonly state: PowerState;
  readonly affected: string[];
  readonly skipped: string[];
  readonly notes: string[];
}
