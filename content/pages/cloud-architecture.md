---
summary: What I actually do as a cloud architect — multitenant SaaS, hybrid cloud/on-premise, cost designed in rather than apologised for, and infrastructure other people can operate.
image: asset:eleva-control-app/live-architecture-diagram
---
# Cloud Architecture

I design and run systems on AWS — and I still write the code that lives on them. The title I'd defend is **cloud architect**, because the decisions I get paid for are architectural: where state lives, what happens when a boundary fails, what a system costs at 3 a.m. on a Sunday, and who can operate it when I'm not there.

Here's what that means in practice, with the receipts.

## Multitenancy that survives real tenants

[Eleva](#/page/eleva-platform) is a multitenant SaaS that schools depend on for evaluations of their own staff. Multitenancy is easy to draw and hard to live with: tenant-scoped configuration layered over central defaults, isolation you can prove, migrations that don't lose a single tenant's history, and a rule I hold as architecture rather than policy — **a process freezes its configuration when it is created**, so the ground never shifts under a decision that already affected someone's career.

## Hybrid, because reality is hybrid

Most interesting systems have a piece that cannot move to the cloud. In a [hybrid commerce platform](#/page/commerce-replatform) I built, it's the registers on the shop floor: database-level replication carries data across the boundary, and a custom event-driven middleware turns two incompatible worlds into one coherent domain. Cloud architecture that assumes greenfield is architecture for slide decks.

## Cost is a design constraint, not a monthly surprise

The line I'm known for is **"the cheapest instance is the one that's off."** Eleva's environments power down outside school hours on schedule rules the team can read. That isn't a FinOps afterthought bolted on later; it's a shape the system was designed to have — services that tolerate being stopped, state that survives it, and startup rehearsed every single day.

It also buys resilience for free: a platform that starts cleanly every morning is a platform whose recovery path is tested every morning.

## Everything as code, with conventions instead of configuration

CDK in TypeScript, constructs shaped after the domain rather than the console, pipelines with gates where they matter and rollback where they don't. The convention layer is the part I'm proudest of: any stack that follows the naming rules shows up in my [control panel](#/page/infra-control-panel) with power buttons and schedules, without the panel changing at all.

## Infrastructure someone else can operate

An architecture that only its author can run is a liability wearing a diagram. So I build the operating surface too — power buttons, schedule rules, drift checks, live diagrams read from deployed templates rather than drawn by hand. The measure of a design is whether the person on call at 3 a.m. can act on it.

## Least privilege, on purpose

This site is about to make that concrete. Its own control plane goes live at **control.diegopalominos.dev** as a public playground: anyone can turn this site's infrastructure on and off and watch it come back. Behind that friendly switch sits the boring discipline — IAM scoped to exactly two resource ARNs, bounded actions, rate limits, an auto-off watchdog so nobody's curiosity becomes my bill, and an audit trail of every flip.

Making something safe enough to hand to strangers is the clearest architecture exam I know.

## The foundation

B.Eng. in Computer Science from **Universidad Técnica Federico Santa María**, Chile — [the fundamentals](#/page/about) that make all of the above reasoning rather than pattern-matching. Since 2017 I've been running a production platform I designed, which is a different education entirely.

Related: [Infrastructure as Code](#/page/iac), [Distributed Systems](#/page/distributed-systems), [Event Sourcing](#/page/event-sourcing).
