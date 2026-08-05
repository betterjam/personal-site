import { StackProps } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * The seam between the two stacks.
 *
 * `src/main.ts` builds these props from the site stack and hands them to
 * `DiegoControlStack` (`src/diego-control-stack.ts`). Keeping the interface in
 * its own module — rather than in `main.ts`, which calls `app.synth()` on
 * import — lets the control stack import it without side effects.
 *
 * The handles are passed as *objects*, not strings, on purpose: the control
 * Lambda's IAM policy must be scoped to `service.serviceArn` /
 * `database.instanceArn` / `cluster.clusterArn` and nothing else (G1 — no
 * `Resource: '*'` on any ecs/rds control-plane action).
 */
export interface DiegoControlStackProps extends StackProps {
  /** Cluster hosting the site service — scopes `ecs:ListTasks`/`DescribeTasks`. */
  readonly cluster: ecs.ICluster;
  /** The one service the panel may scale between 0 and 1 (G2). */
  readonly service: ecs.FargateService;
  /** The one database the panel may start/stop. */
  readonly database: rds.DatabaseInstance;
  /** Apex domain of the site when DNS is configured, else undefined. */
  readonly siteDomainName?: string;
  /** Where the site is reachable — shown by the panel as "the lights". */
  readonly siteUrl: string;
  /** Domain the panel itself is published under. */
  readonly controlDomainName?: string;
}

/** Panel group / app key for the control plane's own resources. */
export const CONTROL_APP_KEY = 'diego-control';
/** SSM namespace the panel's pipeline reads to publish its build. */
export const CONTROL_SSM_PREFIX = '/diego/prod/control';
/** Public playground: control.diegopalominos.dev. */
export const DEFAULT_CONTROL_DOMAIN = 'control.diegopalominos.dev';
