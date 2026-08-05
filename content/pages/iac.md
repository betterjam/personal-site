# Infrastructure as Code

If it isn't in the repo, it doesn't exist. The environment is a program, and programs have power buttons.

## CDK everything

TypeScript stacks with constructs shaped after the *domain*, not the console. A new environment is a pull request; a teardown is a `destroy`; a diff is a code review. The moment infrastructure lives outside version control, it starts lying about itself.

## Cost-aware by design

The Eleva platform powers itself down outside school hours on schedule rules — ECS to zero, RDS stopped, lights out. This isn't a FinOps afterthought; it's an architectural stance: **design systems that tolerate being off**. The discipline pays twice — once on the bill, once in the resilience you get from rehearsing shutdown and startup every single day.

## Infrastructure that explains itself

My control panel renders the architecture live from the deployed CloudFormation template. Deployed truth, not documentation. The same conventions mean any new stack — including this site's — shows up with power buttons and schedules without the panel changing at all. Conventions beat configuration.

## Pipelines with gates

Every stack ships through a pipeline: manual approval where it matters, automatic rollback where it doesn't, and every image stamped with its commit — the banner on this site's home page reads that stamp back to you.

This site's own stack lives in the repo too. See the [colophon](#/page/colophon), then check the [projects](#/page/projects) page for what running it taught me.
