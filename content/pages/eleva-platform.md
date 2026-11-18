---
summary: Performance management for schools and, as Eleva Works, any organization — 360° evaluations, feedback and improvement plans. Written since 2017, Startup Chile Ignite in 2022, running on AWS.
repo: betterjam/eleva-modular
image: asset:eleva-app/process-results-report
gallery: asset:eleva-landing/eleva-landing-hero|eleva.school today — the assistant proposing a process, asset:eleva-app/evaluation-answering-360|Answering an evaluation — one thing per screen, asset:eleva-app/answering-on-a-phone|Answering on a phone — as a conversation, asset:eleva-app/person-result-by-perspective|One person's result — what each perspective contributed, asset:eleva-app/feedback-conversation|Feedback as a conversation — an answer improved with its evidence, asset:eleva-app/compliance-coverage-by-law|Which laws each evaluation covers, asset:eleva-app/climate-survey-by-unit|Climate survey by unit — no results below five answers, asset:eleva-app/improvement-plan-activities|An improvement plan — goal, activities and evidence
---
# Eleva Platform

[eleva.school](https://eleva.school) is where schools run **360° performance evaluations** and turn the results into improvement plans that actually get followed. I started writing it in 2017 and I still run it: the product, the architecture, the code, the infrastructure and the operations are mine. In 2022 it won **Startup Chile Ignite**. In 2026 the same platform opened to companies and health organizations as [Eleva Works](https://eleva.works).

## What it solves

Every school has to evaluate its staff, and most still do it on spreadsheets, on paper or with a consultant's binder: weeks of setup, results nobody can trace back to a rule, and improvement plans that die in a drawer. Eleva runs the whole cycle — the evaluation, the feedback conversation, the improvement plan and its evidence — cheap enough to repeat every year and solid enough that careers can rest on it.

## The long build

I wrote this the slow way, one module at a time. The Startup Chile win (the fourth generation of the program) bought the runway to make it a real product instead of a good idea. Everything since has been the unglamorous work that makes software last: multitenancy, tenant-level configuration, migrations that don't lose history, and an operations story that survives a school year.

## The evaluation engine

Teachers, coordinators and leadership each see the process from their own perspective — boss-to-subordinate, peer, self — and every evaluation moves through a defined lifecycle: prepared, started, in feedback, feedback answered, finalised, closed.

- **A process freezes its configuration the moment it is created.** Change the stages next term and historical evaluations keep the shape they were judged under. It is the detail I'm proudest of, and the one nobody notices: evaluations are about people's careers, and the rules can't quietly change after the fact.
- **An answered rubric is never edited.** A change creates a new version, and weights are whole numbers that add up to 100 — no 33.33…% for anyone to round.
- **Climate surveys are anonymous at rest**, not by a promise in the UI: results exist only for groups large enough to hide an individual.
- **Evidence travels with the evaluation**: photos and PDFs attached per question, merged into the final report.
- **Answers are idempotent**: one answer per question, enforced by the database, so a double tap on a school's patchy Wi-Fi can't corrupt an evaluation.

## Built for the week everyone answers

A whole school answers in the same week. The evaluations for 200 staff are generated in about five minutes, progress is consolidated in under 20 seconds, and the platform has been load-tested at **1,000 simultaneous evaluators**. Real-time updates — stage changes, feedback threads — ride on **PostgreSQL LISTEN/NOTIFY with long polling** instead of a new Redis or SignalR tier: one less system to run, pay for and secure.

## What 2026 added

- **Eleva Works.** Every feature is built neutral to the sector: vocabulary, defaults and organization types come from data, never from code that assumes a school. That is how companies and health organizations run **on the same codebase**, with sector-only modules — clinical procedures, for instance — switched on by the kind of organization instead of a fork.
- **A self-serve trial.** Schools and public bodies buy slowly, so the product makes its own case: sign up with a code or with Google and get **a working organization at once**. A guided first-steps chat — a script, not a model, so every prospect walks the same reliable path — takes it to a first process.
- **An AI assistant for administrators.** It reads the organization through **the same permissions as the screens**, sees people as **pseudonyms** ("Person 3", never a name), answers with links to the exact screen and with PDF reports, and proposes whole evaluation processes. **Only a button pressed by a person writes anything.**
- **Reach.** A blog engine where one article, in Spanish and English, publishes to eleva.school, eleva.works or both, with canonical links so search engines see one original. And an importer that brings a whole staff in from a spreadsheet: it checks Chile's national ID digit, keeps a history of every import and can revert one.

## The platform underneath

Multitenant and fully hosted on AWS, shipped through CI/CD, defined entirely as [infrastructure as code](#/page/iac), running on ECS Fargate and ready to scale out when a term's peak demands it. Each school is a tenant with its own configuration layered over a central default: set the defaults centrally, let each school override them.

Underneath the product is a **modular monolith**: one deployable, with module boundaries and tenant scopes enforced in code so it never slides into a plain monolith. A new feature lands as a module or a tenant override, not a rewrite. It ships often: **129 production releases in the last 30 days** across the API and the web app, every push through a pipeline with automatic rollback, the API live in about eight minutes and the web app in about four.

And because schools keep office hours, the environment does too: outside them, services scale down and the lights go out. The [control panel](#/page/infra-control-panel) is where that happens, with power buttons and schedules anyone on the team can read.

## Where AI fits (and where it doesn't)

The assistant **proposes**; the system **decides**. Scores, stage transitions and reports are computed the same way every time, auditable and repeatable.

That line isn't philosophical squeamishness; it's the product requirement. When an evaluation affects someone's career, "the model felt this way today" is not an acceptable explanation. AI speeds up the reading, the writing and the setup; the system still does the judging by rules you can inspect.

Related reading: [Event Sourcing](#/page/event-sourcing) on why history matters, and [Distributed Systems](#/page/distributed-systems) on designing for the failures that come with multitenancy.
