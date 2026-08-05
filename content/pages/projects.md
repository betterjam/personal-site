# Projects

The section above shows the highlights; this page is the longer cut — what each project actually taught me.

## Eleva Platform

A school management platform built event-first on AWS. The architectural bet was that **schools have office hours**, so the infrastructure should too: outside them, ECS services scale to zero and the database stops. The bill dropped accordingly, and so did the number of things that could break at midnight. Lesson: the cheapest and most reliable instance is the one that's off.

## Infra Control Panel

A single-page ops console that renders the platform's architecture **live from the deployed CloudFormation template** — never a hand-drawn diagram, because hand-drawn diagrams lie within a month. Power buttons, schedule rules, pipeline gates, drift checks. Lesson: an ops tool people actually open beats a runbook nobody reads.

## Commerce Replatform

A production storefront moved to Magento 2 with a Hyvä frontend, with the ERP and payment seams rebuilt around idempotent webhooks and a nightly reconciliation referee. Cutover happened with zero downtime, which mostly means the boring preparation worked. Lesson: [integrations](#/page/integrations) are where replatforms live or die.

## This Site

The page you're on — an event-sourced blog engine wearing seven guitar finishes. The [colophon](#/page/colophon) tells the full story, including who played rhythm.
