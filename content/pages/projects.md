# Projects

The section above shows the highlights; this page is the longer cut — what each project actually taught me.

## Eleva Platform

A school management platform built event-first on AWS. The architectural bet was that **schools have office hours**, so the infrastructure should too: outside them, ECS services scale to zero and the database stops. The bill dropped accordingly, and so did the number of things that could break at midnight. Lesson: the cheapest and most reliable instance is the one that's off.

## Infra Control Panel

A single-page ops console that renders the platform's architecture **live from the deployed CloudFormation template** — never a hand-drawn diagram, because hand-drawn diagrams lie within a month. Power buttons, schedule rules, pipeline gates, drift checks. Lesson: an ops tool people actually open beats a runbook nobody reads.

## Commerce Replatform

A liquor retailer's legacy storefront replaced with Magento 2 and a Hyvä frontend — Magento chosen because it is almost headless, with the heavy and delicate parts (orders, payments, point-of-sale sync) moved into an event-sourced .NET middleware, and the whole platform standardized as CDK so Magento stopped being hard to deploy. Releases are zero-restart. Lesson: [integrations](#/page/integrations) are where replatforms live or die, and the right tradeoff keeps the delicate parts where you can see them.

## This Site

The page you're on — an event-sourced blog engine wearing seven guitar finishes. The [colophon](#/page/colophon) tells the full story, including who played rhythm.
