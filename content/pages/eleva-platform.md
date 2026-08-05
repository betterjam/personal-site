---
summary: A multitenant SaaS for schools — 360° performance evaluations and improvement plans. Built since 2017, Startup Chile Ignite in 2020, running on AWS.
repo: betterjam/eleva-modular
image: asset:eleva-app/process-results-report
gallery: asset:eleva-landing/eleva-landing-hero|eleva.school, asset:eleva-app/evaluation-stages-config|Evaluation stages — set centrally, overridable per school, asset:eleva-app/org-chart-editor|Org chart editor, asset:eleva-app/role-catalog-tree|Role catalogue, asset:eleva-app/question-bank-catalog|Question bank, asset:eleva-app/generated-evaluation-rubric|A generated rubric, asset:eleva-app/role-template-ai-match|AI-assisted role and template matching, asset:eleva-app/perspective-weights-wizard|Weighting the 360° perspectives, asset:eleva-app/evaluation-answering-360|Answering a 360° evaluation, asset:eleva-app/collaborator-profile-timeline|A collaborator's profile and timeline
---
# Eleva Platform

[eleva.school](https://eleva.school) is where schools run **360° performance evaluations** and turn the results into improvement plans that actually get followed. Teachers, coordinators and leadership each see the process from their own perspective — boss-to-subordinate, peer, self — and every evaluation moves through a defined lifecycle: prepared, started, in feedback, feedback answered, finalised, closed.

The detail I'm proudest of is the one nobody notices: **a process freezes its configuration the moment it is created.** Change the stages next term and historical evaluations keep the shape they were judged under. Evaluations are about people's careers; the rules can't quietly change after the fact.

## The long build

I started this in 2017. In 2020 it won **Startup Chile Ignite**, which bought the runway to make it a real product instead of a good idea. Everything since has been the unglamorous work that makes software last: multitenancy, tenant-level configuration, migrations that don't lose history, and an operations story that survives a school year.

## The platform underneath

Multitenant and fully hosted on AWS, shipped through CI/CD, defined entirely as [infrastructure as code](#/page/iac). Each school is a tenant with its own configuration layered over a central default — the screenshot of the stage configuration above is exactly that: set the defaults centrally, let each school override them.

And because schools keep office hours, the environment does too: outside them, services scale down and the lights go out. The [control panel](#/page/infra-control-panel) is where that happens, with power buttons and schedules anyone on the team can read.

## Where AI fits (and where it doesn't)

AI is being folded in as a **helper** — drafting feedback, summarising evidence, suggesting improvement actions — while the functions that decide anything stay **deterministic**. Scores, stage transitions and reports are computed the same way every time, auditable and repeatable.

That line isn't philosophical squeamishness; it's the product requirement. When an evaluation affects someone's career, "the model felt this way today" is not an acceptable explanation. AI accelerates the writing, the system still does the judging by rules you can inspect.

Related reading: [Event Sourcing](#/page/event-sourcing) on why history matters, and [Distributed Systems](#/page/distributed-systems) on designing for the failures that come with multitenancy.
