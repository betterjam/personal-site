---
summary: A multitenant SaaS for schools — 360° performance evaluations and improvement plans. Built since 2017, Startup Chile Ignite in 2022, running on AWS.
repo: betterjam/eleva-modular
image: asset:eleva-app/process-results-report
gallery: asset:eleva-landing/eleva-landing-hero|eleva.school, asset:eleva-app/evaluation-stages-config|Evaluation stages — set centrally, overridable per school, asset:eleva-app/org-chart-editor|Org chart editor, asset:eleva-app/role-catalog-tree|Role catalogue, asset:eleva-app/question-bank-catalog|Question bank, asset:eleva-app/generated-evaluation-rubric|A generated rubric, asset:eleva-app/role-template-ai-match|AI-assisted role and template matching, asset:eleva-app/perspective-weights-wizard|Weighting the 360° perspectives, asset:eleva-app/evaluation-answering-360|Answering a 360° evaluation, asset:eleva-app/collaborator-profile-timeline|A collaborator's profile and timeline
---
# Eleva Platform

[eleva.school](https://eleva.school) is where schools run **360° performance evaluations** and turn the results into improvement plans that actually get followed. Teachers, coordinators and leadership each see the process from their own perspective — boss-to-subordinate, peer, self — and every evaluation moves through a defined lifecycle: prepared, started, in feedback, feedback answered, finalised, closed.

The detail I'm proudest of is the one nobody notices: **a process freezes its configuration the moment it is created.** Change the stages next term and historical evaluations keep the shape they were judged under. Evaluations are about people's careers; the rules can't quietly change after the fact.

## The long build

I started this in 2017. In 2022 it won **Startup Chile Ignite** (the fourth generation of the program), which bought the runway to make it a real product instead of a good idea. Everything since has been the unglamorous work that makes software last: multitenancy, tenant-level configuration, migrations that don't lose history, and an operations story that survives a school year.

## The platform underneath

Multitenant and fully hosted on AWS, shipped through CI/CD, defined entirely as [infrastructure as code](#/page/iac). It is fast where schools feel it: the evaluations for a whole school of 200 staff are generated in about five minutes, and the school's progress is consolidated in under 20 seconds. The platform runs on ECS Fargate and is ready to scale out when a term's peak demands it. Each school is a tenant with its own configuration layered over a central default — the screenshot of the stage configuration above is exactly that: set the defaults centrally, let each school override them.

Underneath the product is a **modular monolith** — the right tradeoff for a platform one engineer designs, builds and runs. One deployable, with module boundaries and tenant scopes enforced in code so it never slides into a plain monolith; multitenancy as a layer rather than a column, each school's configuration sitting over central defaults. That shape is why the product keeps adapting: a new feature lands as a module or a tenant override, not a rewrite. Innovating with schools took an agile cadence to match — small releases, every push through a pipeline with automatic rollback — which is how it shipped 19 production deployments in 30 days without a failure, each live in about nine minutes.

And because schools keep office hours, the environment does too: outside them, services scale down and the lights go out. The [control panel](#/page/infra-control-panel) is where that happens, with power buttons and schedules anyone on the team can read.

## Where AI fits (and where it doesn't)

AI is being folded in as a **helper** — drafting feedback, summarising evidence, suggesting improvement actions — while the functions that decide anything stay **deterministic**. Scores, stage transitions and reports are computed the same way every time, auditable and repeatable.

That line isn't philosophical squeamishness; it's the product requirement. When an evaluation affects someone's career, "the model felt this way today" is not an acceptable explanation. AI accelerates the writing, the system still does the judging by rules you can inspect.

Related reading: [Event Sourcing](#/page/event-sourcing) on why history matters, and [Distributed Systems](#/page/distributed-systems) on designing for the failures that come with multitenancy.
