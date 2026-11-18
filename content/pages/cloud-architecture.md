---
summary: How I build on AWS — multitenant SaaS, hybrid cloud/on-premise, cost designed in rather than apologised for, and infrastructure other people can operate.
image: asset:eleva-control-app/live-architecture-diagram
---
# Cloud Architecture

I design systems on AWS and I write the code that runs on them. The architecture is the part you can't see in a diff: where state lives, what happens when a boundary fails, what a system costs at 3 a.m. on a Sunday, and who can operate it when I'm not there.

Here is how that looks in the systems I built.

## Multitenancy that survives real tenants

[Eleva](#/page/eleva-platform) is a multitenant SaaS I wrote, and that schools depend on for evaluations of their own staff. Multitenancy is easy to draw and hard to live with: tenant-scoped configuration layered over central defaults, isolation you can prove, migrations that don't lose a single tenant's history, and a rule I hold as architecture rather than policy — **a process freezes its configuration when it is created**, so the ground never shifts under a decision that already affected someone's career. Since 2026 the tenants include companies and health organizations too, on the same codebase.

## Hybrid, because reality is hybrid

Most interesting systems have a piece that cannot move to the cloud. In [Liquor Cart](#/page/commerce-replatform) it's the registers on the shop floor: database-level replication carries data across the boundary, and an event-driven middleware I wrote turns two incompatible worlds into one coherent domain. Cloud architecture that assumes greenfield is architecture for slide decks.

## Two shapes, each on purpose

Liquor Cart is **Magento plus a middleware**. Magento brings a catalog, a checkout and an admin the business can run without a developer; it is also hard to deploy and weak at traceability, so the design never asks it to be good at either. The heavy, delicate parts — orders, payments, point-of-sale sync — live in the event-sourced middleware, and the whole platform is defined as code, so every environment is identical, patchable and schedulable.

Eleva is the opposite shape: a **modular monolith**, one deployable I can run alone, with module and tenant scopes keeping the boundaries honest and a multitenant configuration layer that takes new features without a rewrite.

In both, observability and security came with the architecture rather than after it: traces that cross service boundaries, alarms that mean something, least privilege by default. [The experience page](#/page/experience) has the details.

## AI with a boundary

Eleva's assistant is an architecture decision more than a feature. The model reads the organization through the same permission checks as the screens, sees people as pseudonyms, and can only *propose* — a person presses the button that writes. Scores, stage transitions and reports stay deterministic, because "the model felt this way today" is not an explanation anyone's career should hang on.

## Cost is a design constraint, not a monthly surprise

The line I'm known for is **"the cheapest instance is the one that's off."** Eleva's environments power down outside school hours on schedule rules the team can read. That isn't a FinOps afterthought bolted on later; it's a shape the system was written to have — services that tolerate being stopped, state that survives it, and startup rehearsed every single day.

It also buys resilience for free: a platform that starts cleanly every morning is a platform whose recovery path is tested every morning.

## Everything as code, with conventions instead of configuration

CDK in TypeScript, constructs shaped after the domain rather than the console, pipelines with gates where they matter and rollback where they don't. The convention layer is the part I'm proudest of: any stack that follows the naming rules shows up in my [control panel](#/page/infra-control-panel) with power buttons and schedules, without the panel changing at all.

## Infrastructure someone else can operate

An architecture that only its author can run is a liability wearing a diagram. So I build the operating surface too — power buttons, schedule rules, drift checks, live diagrams read from deployed templates rather than drawn by hand. The measure of a design is whether the person on call at 3 a.m. can act on it.

## Least privilege, on purpose

This site makes that concrete. Its own control plane is live at **control.diegopalominos.dev** as a public playground: anyone can turn this site's infrastructure on and off and watch it come back. Behind that friendly switch sits the boring discipline — IAM scoped to exactly two resource ARNs, bounded actions, rate limits, an auto-off watchdog so nobody's curiosity becomes my bill, and an audit trail of every flip.

Making something safe enough to hand to strangers is the clearest architecture exam I know.

## The foundation

B.Eng. in Computer Systems Engineering from **Universidad Técnica Federico Santa María**, Chile — [the fundamentals](#/page/about) under all of the above. Since 2017 I've been running a production platform I wrote, which is a different education entirely.

Related: [Infrastructure as Code](#/page/iac), [Distributed Systems](#/page/distributed-systems), [Event Sourcing](#/page/event-sourcing).
