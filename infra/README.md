# diego-site infra

CDK v2 (TypeScript, projen-managed) infrastructure for **diegopalominos.dev**
and its **public** ops playground at **control.diegopalominos.dev**, following
the eleva-infra conventions so every resource shows up — and can be
power-scheduled — in the Angular ops panel.

Two stacks, one app:

| Stack | What it is |
| --- | --- |
| **`DiegoSiteStack`** | the site: S3 + CloudFront (the only public entry), the blog API on Fargate behind an ALB, PostgreSQL, and the `eleva-diego-site-prod` pipeline |
| **`DiegoControlStack`** | the playground: a control API + the panel hosting at `control.diegopalominos.dev`, where **anyone** can turn the site's infrastructure on and off |

The demo *is* the point: if the API is off, the site tells you to go to
`control.` and switch the lights on. Nothing behind it is sensitive.
Everything that makes handing strangers a power switch defensible is in the
[guardrails](#guardrails) section — and every line of it is asserted in tests.

## `DiegoSiteStack` — diegopalominos.dev

Scope ids are panel keys, so they matter:

| Scope (panel key) | Contents |
| --- | --- |
| `site` | private S3 bucket (OAC, no public access) with the built frontend + the CloudFront distribution: default behavior → S3 with SPA routing, `/api/*` → the ALB, uncached, all methods forwarded |
| `blog` | ECR repo, ECS cluster, ARM64 Fargate task (0.25 vCPU / 512 MiB) on FARGATE_SPOT with a FARGATE fallback lane, its LogGroup, the internet-facing ALB (a CloudFront *origin*, not the front door), the ADMIN_TOKEN secret |
| `database` | RDS PostgreSQL 16 `db.t4g.micro`, 20 GiB gp3, single-AZ, encrypted, isolated subnets, 7-day backups, deletion protection |
| `pipeline` | CodePipeline **`eleva-diego-site-prod`**: GitHub (CodeStar connection) → ARM CodeBuild image build → ECS deploy + S3 publish + CloudFront invalidation |

Networking: its own minimal 2-AZ VPC, public + isolated subnets, **zero NAT
gateways**. The task runs in public subnets with a public IP so it can reach
ECR / Secrets Manager / CloudWatch without paying for NAT; Postgres sits in
isolated subnets and accepts 5432 from the service's security group only.

Two deliberate design calls worth knowing about:

- **SPA routing is a CloudFront Function on the default behavior**, not
  distribution-level `CustomErrorResponses`. Custom error responses are
  distribution-wide, so a `403/404 → /index.html` rule would also rewrite the
  API's honest 404 (unknown post) and 403 (bad ADMIN_TOKEN) into a 200 page of
  HTML. Behavior-scoped rewriting leaves `/api/*` responses exactly as the
  service sent them.
- **`desiredCount: 1` is in the template.** A CloudFormation update therefore
  turns the lights back on even if a visitor switched them off. The control
  plane's watchdog switches them off again within 15 minutes; the alternative
  (omitting the property) would mean CloudFormation could never restore the
  service at all.

## `DiegoControlStack` — control.diegopalominos.dev

The playground: a Node 22 Lambda behind a throttled HTTP API, the panel's
static hosting (S3 + CloudFront + Route53), a DynamoDB activity feed, the
`diego-control-admin-token` secret that authorises mutations when `allowAnon`
is off, and the EventBridge watchdog. It receives the site's `cluster` / `service` / `database`
handles as props (see `src/control-stack-contract.ts`) so its IAM policy can be
scoped to exactly those ARNs — which also makes CloudFormation order the
deploys correctly.

## Runbook

### 0. Prerequisites, once

```bash
# the domain: register diegopalominos.dev (Route53 or elsewhere) and create a
# public hosted zone. Note the zone id (Z...) — everything DNS keys off it.
aws route53 list-hosted-zones-by-name --dns-name diegopalominos.dev

# the fence: the target account id is deliberately NOT in source. Put it in the
# gitignored cdk.context.json (or export CDK_EXPECTED_ACCOUNT).
cat > infra/cdk.context.json <<'JSON'
{
  "expectedAccount": "<ACCOUNT_ID>",
  "expectedRegion": "us-east-1",
  "protectedStackPrefixes": "<prod-stack-prefixes-in-this-account>",
  "budgetEmail": "<you@example.com>"
}
JSON

# CDK bootstrap, once per account/region
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

# pipeline source: a CodeStar connection to the GitHub org, completed in the
# console (status must be AVAILABLE), then published where the stack reads it
aws codestar-connections create-connection --provider-type GitHub --connection-name diego-site
aws ssm put-parameter --name /diego/prod/site/connectionArn --type String --value <CONNECTION_ARN>

# cost allocation: activate the `project` tag in Billing → Cost allocation tags,
# otherwise the budget's tag filter matches nothing (takes ~24h to backfill).
```

### 1. Build and check, no credentials required

```bash
npm install          # or: npx projen — regenerates the managed files too
npm run build        # compile + eslint + jest + synth
npx cdk synth -q     # succeeds with NO AWS credentials: this app performs no lookups
npm test
```

### 2. Deploy, site first

```bash
npx cdk deploy DiegoSiteStack    -c hostedZoneId=<Z...>
npx cdk deploy DiegoControlStack -c hostedZoneId=<Z...> -c budgetEmail=<you@example.com> -c allowAnon=true
```

`-c allowAnon=true` is what makes `control.diegopalominos.dev` the playground it
advertises: without it the mutating routes answer 401 to anonymous callers and
the panel renders read-only (G8). Leave it off for any deployment that is not
meant to let strangers flip the lights. It lives in `cdk.context.json` alongside
`expectedAccount`, so the playground keeps its behaviour across deploys.

Order matters: the control stack imports the site's service/database ARNs.
`cdk deploy` with the wrong profile fails immediately, before touching
anything, naming both account numbers (see [F1](#guardrails)).

`budgetEmail` is only optional for a synth. **Deploy the control stack without
it and the budget is created with no subscribers** — the 80% / 100% alerts of
[F7](#guardrails) go nowhere, and so does the billing alarm, which is not what
you want on a stack strangers can switch on. Synth says so (`INFO No -c
budgetEmail=...`), and putting it in `cdk.context.json` above means you cannot
forget it. Confirm the SNS subscription from your inbox afterwards, or the
billing alarm stays silent.

### 3. First-boot image push (read before the first deploy)

The task definition points at `<repo>:latest` and the ECR repo starts empty, so
on the *first* deploy the service cannot stabilize until an image exists. The
repo has a fixed name (`diego-site-blog`), so as soon as CloudFormation has
created it (the database takes ~10 minutes, so there is plenty of time), push
from the repo root:

```bash
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/arm64 \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/diego-site-blog:latest app
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/diego-site-blog:latest
```

(`--platform linux/arm64` matters on x86 machines — the task runs on ARM64.)
`npx cdk deploy --no-rollback` keeps a slow first push from rolling the whole
stack back. After that, every push to `main` flows through the pipeline.

### 4. Publish the panel build

The Angular panel lives in its own private repo; this app only provisions its
hosting and publishes the coordinates its pipeline needs:

```bash
aws ssm get-parameter --name /diego/prod/control/bucket         --query Parameter.Value
aws ssm get-parameter --name /diego/prod/control/distributionId --query Parameter.Value
aws ssm get-parameter --name /diego/prod/control/apiUrl         --query Parameter.Value

# in the panel repo, after `ng build`:
aws s3 sync dist/ s3://<bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <distributionId> --paths '/*'
```

The site's own frontend needs no manual step — the pipeline builds `frontend/`,
publishes it to the site bucket and invalidates the distribution.

**How the panel authenticates: reads never, writes it depends — one boolean,
`allowAnon` (G8).** Reading is always anonymous: `/manifest`, `/status`,
`/diagram`, `/diag`, `/activity`, `/pipelines` and `GET /rules` need nothing at
all, in every deployment. Whether an anonymous caller may also *change*
something is the flag:

| `allowAnon` | `POST /power`, `POST /rules`, `/rules/delete`, `/rules/toggle` | who deploys it this way |
| --- | --- | --- |
| `false` (**default**) | 401 unless the request carries the bearer token | anything that is not a public playground |
| `true` (`-c allowAnon=true`) | anonymous, exactly as before | `control.diegopalominos.dev` — letting visitors flip the lights *is* the demo |

The flag is enforced in the **handler**, not in the panel: a UI that hides its
buttons is a courtesy, and `curl` does not read Angular. `GET /manifest`
advertises it as `allowAnon` (and as `publicDemo`, its pre-flag alias, always
with the same value) so the panel can render read-only without guessing, and
`ALLOW_ANON` is parsed fail-closed — only the exact string `true` opts in.

Point the panel's API base URL at `/diego/prod/control/apiUrl`. A panel that
sends `Authorization: Bearer ` with an empty value — which is what the panel
did for years — counts as *no token*, so it still works unmodified against an
`allowAnon=true` deployment and lands in read-only mode against a default one.

The token itself is generated into Secrets Manager as
`diego-control-admin-token`, the same mechanism as the site stack's maintainer
`ADMIN_TOKEN` and a deliberately separate secret (two planes, two trust
boundaries). Read it with `aws secretsmanager get-secret-value --secret-id
diego-control-admin-token`; rotate it with `update-secret` followed by a
redeploy of this stack, since CloudFormation injects it into the function's
environment as a `{{resolve:secretsmanager:…}}` dynamic reference — no secret
material lands in the synthesized template, and the Lambda needs no
`secretsmanager` permission at request time.

`allowAnon=true` is still defensible because it is not standing alone: the API
can only reach two ARNs, `desiredCount` can only be 0 or 1, throttling and
reserved concurrency cap the request rate, the watchdog undoes anything left
on, and every action lands in the public activity feed. Three consequences to
keep in mind:

- the panel must be served from `https://control.diegopalominos.dev` (or
  `http://localhost:4200` while developing), because those are the only two
  origins the CORS allow-list echoes back — G6 has no wildcard branch;
- the EventBridge watchdog, the nightly lights-out and visitor schedule rules
  invoke the Lambda **directly**, not over HTTP. They are never token-gated, in
  either mode — a security setting that switched off the cost fence would be a
  bad trade;
- do **not** reuse this API URL from the private ops panel as
  though it were an authenticated one. It is a different plane that happens to
  speak the same protocol, and on the playground it is deliberately public.

### Contexts

| Context | Default | Effect |
| --- | --- | --- |
| `expectedAccount` | — (**required**) | The only account this app may synthesize/deploy into. No default: unset is a hard stop, not a guess |
| `expectedRegion` | `us-east-1` | Region half of the fence |
| `protectedStackPrefixes` | — | Stack-name prefixes in the same account the control plane must never touch (feeds the IAM denies) |
| `domainName` | `diegopalominos.dev` | Apex domain |
| `hostedZoneId` | — (DNS off) | Turns on ACM + Route53 aliases. Without it the stacks still synth and deploy, on the CloudFront default domain with a plain HTTP origin listener |
| `cloudfrontCertificateArn` | — | An existing **us-east-1** certificate for the edge, skipping the `DnsValidatedCertificate` custom resource |
| `cloudfrontPrefixListId` | — (open) | Locks the ALB's security group to the CloudFront origin-facing prefix list (region-specific id) |
| `connectionArn` | SSM `/diego/prod/site/connectionArn` | CodeStar connection for the pipeline source |
| `githubOwner` / `githubRepo` / `githubBranch` | `betterjam` / `diego-site` / `main` | Pipeline source |
| `allowAnon` | `false` | **May an anonymous caller mutate?** `false` gates `POST /power` and the three `/rules` writes behind the `diego-control-admin-token` bearer token; reads stay anonymous either way. The public playground deploys with `-c allowAnon=true`. Anything that is not exactly `true` or `false` fails the synth rather than being coerced |
| `budgetUsd` / `budgetEmail` | `40` / — | Monthly cost budget (control stack) and where its alerts go. Without an address the budget is created with no subscribers and says so at synth time — pass one for a real deployment |
| `vpcId` | — | **Refused.** Passing it fails the synth on purpose (F4) |

## Guardrails

Public power switches, and the fences that make them safe. Every row is
asserted in `test/diego-site-stack.test.ts` or `test/diego-control-stack.test.ts`.

| # | Guardrail | How |
| --- | --- | --- |
| G1 | **Least-privilege IAM, no wildcards** | `ecs:UpdateService`/`DescribeServices` on the one service ARN, `ecs:List/DescribeTasks` scoped to the cluster, `rds:Start/Stop/DescribeDBInstances` on the one instance ARN, `scheduler:*` inside one schedule group, `codepipeline:GetPipelineState`/`ListPipelineExecutions` on the allow-listed pipeline ARN. A test asserts no statement has `Resource: '*'` for those actions |
| G2 | **Bounded actions** | `desiredCount` is validated and clamped to 0 or 1. There is no delete, no destroy, no scale-beyond-1 endpoint anywhere in the API |
| G3 | **Rate limiting** | HTTP API route-level throttling (burst 20, 5 rps) plus reserved Lambda concurrency, so a bored visitor cannot spam AWS control-plane calls |
| G4 | **Auto-off watchdog** | An EventBridge rule every 15 minutes powers everything off once it has been on longer than `MAX_ON_MINUTES` (default 180), plus a nightly lights-out rule |
| G5 | **Schedule hygiene** | Visitor schedules live in a dedicated EventBridge Scheduler group, are name-prefixed, and are capped at 10 (oldest-wins rejection with a clear message) |
| G6 | **CORS allow-list** | `https://control.diegopalominos.dev` and `http://localhost:4200` for the panel's dev server. No wildcard origin |
| G7 | **Activity log** | DynamoDB on-demand table recording `{ at, action, actor, result }` for every power/schedule action, with a 30-day TTL, exposed as `GET /activity`. `actor` is a hashed IP prefix — never a raw IP |
| G8 | **Anonymous mutation is opt-in** | One boolean, `allowAnon`, default **false**. With it off, the four mutating routes require the `diego-control-admin-token` bearer token and answer 401 without it; reads stay anonymous in both modes, and so do the EventBridge watchdog / schedule invocations, which are not HTTP callers. Enforced in the handler — the panel's read-only rendering is a courtesy, this is the boundary. The token is compared over SHA-256 digests with `timingSafeEqual`, never logged and never echoed. The stage's per-route throttle list and the gated-route list are one exported definition, so they cannot drift |
| F1 | **Account guard** | The app refuses to synthesize unless the resolved account matches `expectedAccount` (never hardcoded: context, `CDK_EXPECTED_ACCOUNT`, or the gitignored `cdk.context.json`). `env` is pinned to it, so the CDK CLI refuses a wrong-profile deploy naming both accounts; `FencedStack` re-checks as a second wall |
| F2 | **Permissions boundary** | The control Lambda's role carries a managed policy as its `PermissionsBoundary` allowing only the specific ecs/rds/scheduler/dynamodb/logs actions — plus the two CodePipeline *reads* — on this app's own resources. The identity policy is already least-privilege; the boundary is the wall a future edit cannot widen. IAM caps a managed policy at 6,144 characters and this document is the app's biggest, so the name-based deny below is expanded on the boundary only across the services the boundary actually grants; everywhere else its implicit deny is already absolute. A test asserts the document still fits, with room for another protected prefix |
| F3 | **Explicit denies** | Boundary and role deny: anything whose ARN or name matches the configured production prefixes; `iam:*`, `organizations:*`, `account:*`, `sts:AssumeRole`; `cloudformation:DeleteStack`/`UpdateStack`; `rds:DeleteDBInstance`/`ModifyDBInstance`/`Restore*`/`CreateDBSnapshot` outside this stack's instance; `ecs:DeleteService`/`UpdateCluster`; every CodePipeline action but the two state reads on the allow-listed pipeline, and *all* of CodePipeline anywhere else (which is what denies `ListPipelines`); Secrets Manager and SSM outside this app's own paths. Deny wins over allow, always |
| F4 | **Dedicated network** | The site stack always creates its own VPC. Passing `-c vpcId` **fails the synth** with an explanation rather than silently sharing a network with production |
| F5 | **Name prefixes** | Stacks `DiegoSiteStack` / `DiegoControlStack`; every physically-named resource starts with `diego-site-` or `diego-control-`. The one exception is the pipeline, which the panel requires to be `eleva-<app>-<env>` — `eleva-diego-site-prod` still reads unmistakably. A test asserts nothing else is named `eleva-*` |
| F6 | **Tagging** | `Tags.of(app)` adds `project=diego-site`, `owner=diego`, `exposure=public-demo` to everything, which is what makes cost allocation, console filtering, clean-up and any future SCP work trivial |
| F7 | **Budget guard** | A monthly AWS Budget scoped **by tag** to `project=diego-site` (default $40, alerts at 80% and 100%) plus a CloudWatch billing alarm. It lives in `DiegoControlStack` — `BudgetName` is account-global, so exactly one stack may declare it — and the site stack supplies the tag it filters on. Strangers can start this infrastructure: the watchdog caps runtime, the budget catches what the watchdog misses |
| F8 | **Shared-account visibility** | See below |

### F8 — sharing the account, honestly

This app deploys into an account that also runs production workloads (their
stack prefixes are configured via `protectedStackPrefixes`, never committed).
That was a deliberate choice, and it has one consequence worth stating plainly:

**Diego's existing private, authenticated ops panel may discover these
resources by convention** — it walks CloudFormation metadata
looking for `Eleva::Panel`, and these stacks write it too. That is acceptable:
he owns both, and the panel group `diego-site` keeps them visually separated
from the production group. Nothing flows the other way — the public control
plane's IAM boundary denies every production resource by name, so the
playground can see itself and nothing else.

## Control API surface

The panel expects a fixed set of endpoints. What is implemented against *this*
app's resources:

| Endpoint | Status |
| --- | --- |
| `GET /manifest` | implemented — the resources this panel may drive |
| `GET /status` | implemented — current power state of the service and database |
| `POST /power` | implemented — on/off, clamped to `desiredCount` 0 or 1. **401 for an anonymous caller unless `allowAnon` (G8)** |
| `GET /rules` | implemented — anonymous in every mode |
| `POST /rules`, `POST /rules/delete`, `POST /rules/toggle` | implemented — visitor schedules in a dedicated, capped scheduler group. **401 for an anonymous caller unless `allowAnon` (G8)** |
| `GET /diagram` | implemented — the live architecture diagram |
| `GET /diag` | implemented — self-check, including which surfaces are skipped |
| `GET /activity` | implemented — the public "who flipped the lights" feed, last 20 |
| `GET /pipelines` | implemented, **read-only** — this stack's own pipeline: stages, the first failure, the last 5 runs (see below) |
| `POST /logs/query` | **501, honestly** — the control role has no `logs:FilterLogEvents`, so visitor traffic can never read application logs |
| `POST /pipelines/run`, `POST /pipelines/approve`, `GET /pipelines/subscriptions`, `POST /pipelines/subscribe` | **501, honestly** — a read-only public demo does not deploy, approve or sign an address up for mail |
| `POST /drift` | **501, honestly** — drift detection needs broad CloudFormation read access this role must not have |

Every 501 returns `{ supported: false, reason, <empty collection> }` so the
panel degrades to an explanatory empty state instead of breaking.

### `GET /pipelines` — read-only, allow-listed

The panel's Pipelines page renders Run and Approve buttons for every pipeline
it is shown. On a page anyone can open, those buttons must not work — and the
list itself must not become a directory of the account. Three rules
(P1–P3, asserted in both test suites) make that true:

| | |
| --- | --- |
| P1 **read-only** | `GET /pipelines` is the only pipeline route the API declares. Run / approve / subscribe reach the handler through the catch-all and get an honest refusal. It is not just unimplemented: the role has no `StartPipelineExecution`, `PutApprovalResult` or `sns:Subscribe` permission, and the boundary denies them |
| P2 **cached 45s** | Pipeline state is memoised in the Lambda, so the panel's polling — from any number of visitors — cannot hammer CodePipeline in an account that also runs production pipelines |
| P3 **allow-listed, never listed** | `codepipeline:ListPipelines` is *denied*. The control stack is handed the site stack's pipeline construct and passes its **name** to the Lambda (`PIPELINES`) and its **ARN** to a two-action IAM statement, so the handler asks about exactly those pipelines and drops anything else an API hands back |

The response also leaves two things out on purpose: `pendingApproval` (a gate
a visitor can see but not action — and its `token` is a bearer credential) and
`logUrl` (a console link carrying the account id, useless to someone who
cannot sign in).

## Monthly cost

us-east-1 list prices, one environment. "Lights on" means the Fargate service
and the RDS instance are running; "lights off" is what a visitor leaves behind
when they switch them off (or the watchdog does).

| Item | Lights ON | Lights OFF |
| --- | --- | --- |
| ALB (hourly, ~zero LCU at this traffic) | ~$16.40 | ~$16.40 — it bills whether or not anything runs |
| RDS `db.t4g.micro`, single-AZ | ~$11.70 | ~$0 (instance stopped) |
| RDS 20 GiB gp3 + backups (7d, within the free allocation) | ~$2.30 | ~$2.30 — storage bills while stopped |
| Fargate **Spot**, ARM64 0.25 vCPU / 0.5 GB | ~$3–4 | ~$0 |
| Route53 hosted zone | ~$0.50 | ~$0.50 |
| Secrets Manager (3 secrets: db credentials, site `ADMIN_TOKEN`, control API token) | ~$1.20 | ~$1.20 |
| CloudWatch billing alarm | ~$0.10 | ~$0.10 |
| CloudFront (2 distributions), DynamoDB, Lambda, API Gateway, S3, ECR, logs | ~$1–2 | ~$0.50–1 |
| CodePipeline V2 (per action-minute, 100 free/month) | ~$0 | ~$0 |
| **Total** | **~$36–38** | **~$20–21** |

So the floor is the ALB: about **$16/month you pay no matter what any visitor
does**. Everything else that is always-on adds roughly $4, so the honest
**lights-off floor is ~$20–21/month**, and the swing a visitor actually
controls is ~$16/month. The budget is set at $40 for that reason — it should
never fire unless something is stuck on. Note that RDS auto-restarts any
instance stopped for 7 straight days; the nightly lights-out rule turns it back
off.

**One line item that is easy to miss:** API Gateway *detailed* metrics add a
`Route` dimension and are billed as CloudWatch **custom** metrics (~$0.30 per
metric per month, prorated hourly) — roughly 6 series per route. Enabled
stage-wide that is ~72 series across the 12 routes, and the ones that would
publish every hour of the month are exactly the ones the panel polls, so an
idle-but-open browser tab would quietly cost more than the Fargate task. They
are therefore **off by default and switched on only for the four mutating
routes** (`POST /power`, `POST /rules*`), where the per-route signal is worth
having and the traffic is rare enough to round to cents. Free API-level metrics
(no `Route` dimension) stay on for everything. Throttling is unaffected — it is
configured independently of metrics.

### The cheaper, ALB-less variant (considered, not chosen)

The ALB exists only to give CloudFront a stable `/api/*` origin. A Fargate task
gets a fresh public IP every start, so the alternative is: an ECS task
state-change event → a small Lambda → update a Route53 A record to the new task
IP, and point the CloudFront origin at that record. That removes the $16 floor
and takes the lights-off cost to roughly **$3–5/month**.

It was not chosen as the default because it trades a managed, boring component
for a moving one: no health checks or connection draining, a DNS-TTL-shaped
window (30–60s) where the origin points at a dead IP after every task
replacement, an extra Lambda and IAM role in the blast radius, and a failure
mode ("the site is down") that is much less obvious than "the ALB target is
unhealthy". For a portfolio site whose whole point is that visitors flip it on
and off and *watch it come back*, predictable recovery beats $16/month. The
variant is a good follow-up if the floor ever stops being worth it — the
`/api/*` behavior is the only thing that would change.

## Eleva panel conventions applied

- **`panelMeta`** (`src/constructs/panel-meta.ts`) writes
  `Metadata['Eleva::Panel']` — `category`, `group`, `label`, `hidden`,
  `public { protocol, port, from? }`, `deploys[]`. It annotates a
  `CfnResource` (or an L2's default child) directly, or walks a plain scope to
  group-tag every child; repeat calls merge.
- **Panel keys come from the parent construct id**, so the service, database
  and pipeline each live in their own scope (`blog`, `database`, `pipeline`),
  and the service's LogGroup is *inside* the `blog` scope.
- **Power/scheduling** works because the app uses the supported L2s:
  `ecs.FargateService` and `rds.DatabaseInstance` (not Aurora).
- **Group `diego-site`** on the site's principal resources, `diego-control` on
  the control plane's own.
- **Public entrypoint** on the CloudFront distribution:
  `public: { protocol: 'HTTPS', port: 443, from: 'Web' }`. The ALB deliberately
  does *not* carry it — it is an origin, not the front door.
- **Pipeline** `eleva-diego-site-prod` with
  `panelMeta({ category: 'pipeline', deploys: ['diego-site'] })`.
- **SSM** under `/diego/prod/site/` (`siteBucket`, `distributionId`,
  `albDnsName`, `ecrRepoUri`, `serviceName`, `dbInstanceId`) and
  `/diego/prod/control/` (`bucket`, `distributionId`, `apiUrl`).

## Project layout

```
.projenrc.ts                      projen config — edit this, then `npx projen`
src/main.ts                       CDK app: fence, tags, both stacks
src/diego-site-stack.ts           A. the site (scopes: site / blog / database / pipeline)
src/diego-control-stack.ts        B. the public playground
src/control/                      the control Lambda (bundled by NodejsFunction)
src/control-stack-contract.ts     the props seam between the two stacks
src/constructs/fenced-stack.ts    account/region fence, no-lookup base stack
src/constructs/panel-meta.ts      Eleva::Panel metadata helper
src/constructs/project-tags.ts    project/owner/exposure tags + the cost tag
src/eleva-blog-stack.ts           deprecated re-export of the old stack name
test/                             assertions tests, incl. the guardrail suite
```
