import { App } from 'aws-cdk-lib';
import { resolveFence } from './constructs/fenced-stack';
import { applyProjectTags } from './constructs/project-tags';
import { DiegoControlStackProps, DEFAULT_CONTROL_DOMAIN } from './control-stack-contract';
import { DiegoControlStack } from './diego-control-stack';
import { DiegoSiteStack } from './diego-site-stack';

const app = new App();

// F6 — every resource in every stack carries project/owner/exposure, so this
// playground can always be told apart from other workloads in the shared account
// (cost allocation, console filters, clean-up, future SCPs).
applyProjectTags(app);

/*
 * F1 — ACCOUNT GUARD.
 *
 * `env` is pinned to the expected account/region rather than picked up from
 * whatever profile happens to be active. Three things follow:
 *
 *  - with no account configured at all, `resolveFence` throws here, before any
 *    stack exists. The account id is never committed: pass it as
 *    `-c expectedAccount=<id>`, set `CDK_EXPECTED_ACCOUNT`, or keep it in the
 *    gitignored `cdk.context.json`.
 *  - `cdk deploy` with the wrong profile fails immediately, in the CLI, with
 *    both account numbers on screen ("current credentials are for account X,
 *    stack DiegoSiteStack is in account Y"). No resource is touched.
 *  - `cdk synth` still needs no credentials at all, because these stacks
 *    perform no context lookups (see FencedStack.availabilityZones and the
 *    dedicated-VPC rule, F4).
 *
 * `FencedStack` re-checks the resolved account as a second wall.
 */
const fence = resolveFence(app);
const env = { account: fence.account, region: fence.region };

// A. the public site — diegopalominos.dev
const site = new DiegoSiteStack(app, 'DiegoSiteStack', { env });

/*
 * B. the control plane — control.diegopalominos.dev (the playground).
 *
 * It takes the site's ECS/RDS handles as props (the shape lives in
 * `control-stack-contract.ts`, so the control stack can import it without
 * pulling in this file's `app.synth()`), which lets the control Lambda's IAM
 * policy be scoped to exactly those ARNs — G1, no `Resource: '*'` — and makes
 * CloudFormation order the deploy: site first, control second.
 */
const controlProps: DiegoControlStackProps = {
  env,
  cluster: site.cluster,
  service: site.service,
  database: site.database,
  siteDomainName: site.domainName,
  siteUrl: site.siteUrl,
  controlDomainName: app.node.tryGetContext('controlDomainName') ?? DEFAULT_CONTROL_DOMAIN,
};

new DiegoControlStack(app, 'DiegoControlStack', controlProps);

app.synth();
