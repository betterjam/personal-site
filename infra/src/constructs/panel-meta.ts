import { CfnResource } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * Recreation of the eleva-infra `panelMeta` helper.
 *
 * The ops panel discovers resources by reading the
 * CloudFormation `Metadata['Eleva::Panel']` entry on each resource. This
 * helper writes that entry.
 *
 * Panel key note: the panel derives a resource's key from its *parent
 * construct's id*, so services (and their log groups) must live inside a
 * dedicated construct scope with a clear id (e.g. `blog`, `database`,
 * `pipeline`).
 */

/** Marks the resource as a public entrypoint in the panel. */
export interface PanelPublic {
  /** e.g. 'HTTPS' or 'HTTP'. */
  readonly protocol: string;
  /** e.g. 443. */
  readonly port: number;
  /** Optional source restriction (CIDR or label); omitted = internet. */
  readonly from?: string;
}

/** Shape of the `Eleva::Panel` metadata entry. */
export interface PanelMetaProps {
  /** Panel category, e.g. 'pipeline'. */
  readonly category?: string;
  /** Grouping key; shared resources of one app use the same group. */
  readonly group?: string;
  /** Human-friendly label shown in the panel. */
  readonly label?: string;
  /** Hide the resource from the panel without losing the grouping. */
  readonly hidden?: boolean;
  /** Public entrypoint descriptor (protocol/port[/from]). */
  readonly public?: PanelPublic;
  /** For pipelines: panel app keys this pipeline deploys. */
  readonly deploys?: string[];
}

const PANEL_METADATA_KEY = 'Eleva::Panel';

/**
 * Write `Metadata['Eleva::Panel']` onto a resource.
 *
 * - Given a `CfnResource`, annotates that resource directly.
 * - Given an L2 construct whose `defaultChild` is a `CfnResource` (e.g.
 *   `ecs.FargateService`, `rds.DatabaseInstance`, an ALB, a pipeline),
 *   annotates that default child.
 * - Given a plain scope (e.g. a `Construct` used only for grouping), walks
 *   the scope and annotates every `CfnResource` underneath it — the way
 *   eleva-infra group-tags all children of an app scope.
 *
 * Calling it twice on the same resource merges the entries (later fields
 * win), so a scope-level group tag can be combined with resource-specific
 * annotations such as `public` or `deploys`.
 */
export function panelMeta(target: IConstruct, meta: PanelMetaProps): void {
  if (CfnResource.isCfnResource(target)) {
    applyTo(target, meta);
    return;
  }

  const defaultChild = target.node.defaultChild;
  if (defaultChild !== undefined && CfnResource.isCfnResource(defaultChild)) {
    applyTo(defaultChild, meta);
    return;
  }

  for (const child of target.node.findAll()) {
    if (CfnResource.isCfnResource(child)) {
      applyTo(child, meta);
    }
  }
}

function applyTo(resource: CfnResource, meta: PanelMetaProps): void {
  const existing = resource.getMetadata(PANEL_METADATA_KEY) ?? {};
  resource.addMetadata(PANEL_METADATA_KEY, { ...existing, ...compact(meta) });
}

/** Drop undefined fields so the template metadata stays clean. */
function compact(meta: PanelMetaProps): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== undefined),
  );
}
