---
summary: The build story behind Liquor Cart — one virtual host per store, a payment saga with compensating actions, a clock the broker cannot keep, and a release budgeted at ten minutes. How the middleware between on-premise registers and a cloud storefront actually got made.
---
# Building Liquor Cart

A liquor retailer sells in two places at once: the shop floor and the internet. The registers run on-premise and are never moving to the cloud; the storefront runs on Magento in AWS. The [case study](#/page/commerce-replatform) shows what Liquor Cart is. This is the story of how it was built — the decisions, in the order they were forced on us.

The first decision was the honest one: **the shop floor cannot depend on the internet being healthy this second.** A register that stops selling because a cloud service hiccuped is not a distributed system, it's a liability with a network cable. Every design choice below follows from taking that sentence seriously.

## One virtual host per store

The middleware runs on **MassTransit over RabbitMQ** (Amazon MQ), and every store gets its **own virtual host** — created through the broker's management API when the store onboards, deleted when it retires. Queues, exchanges, permissions: one store, one namespace.

This sounds like ceremony until the day one store's connection degrades into a retry storm. With a shared broker topology, that store's backlog is everyone's backlog. With a vhost per store, the blast radius is exactly one store. Isolation you configure once beats throttling you tune forever.

## An order is a promise made at commit

When a storefront order commits, an outbox module publishes the event **inside the same transaction** — Magento and the middleware never disagree about what happened, because there is no gap for them to disagree in. The middleware dedupes, pulls the full order, acknowledges it back, and posts it to the register **once it is paid**. A cron retries failed publishes every ten minutes and marks anything not fetched within thirty as stalled, so nothing quietly rots in a queue.

The same discipline runs the other direction: when the middleware writes a product, it is live on the storefront **on the next request** — indexers forced to realtime, page-cache tags purged on save. Not "eventually". Next request.

## Money and orders disagree; a saga decides

The hardest problem wasn't moving data. It was that **settled money and acknowledged orders are two different facts** that mostly — not always — line up. A payment can settle for an order that never confirms. An order can confirm while its payment is still in flight.

The answer is a saga: a state machine that reconciles the two, with a **compensating action for every way the story can end** — void the authorization, refund the capture, cancel the pending order, or complete it — each running under deterministic idempotent keys, so replaying a step is safe. And the ending I'm proudest of: when the facts genuinely don't resolve, the saga doesn't guess. **It escalates to a person.** An automated system that knows when to stop automating is worth two that don't.

## A clock the broker cannot keep

Sagas need deadlines, and deadlines need a clock. Amazon MQ doesn't ship the delayed-exchange plugin, so the broker couldn't be the clock. Instead, **deadlines live in Postgres and a sweeper checks them every minute**: first check two minutes after settlement, then up to four more checks five minutes apart, then abandon at fifteen — and abandoning is itself a compensated, escalated path, not a shrug.

I like this piece because it's the shape of most real infrastructure work: the elegant tool is missing, and the craft is building the boring, inspectable replacement — a table you can query at 3 a.m. instead of a plugin you can't.

## Paying the idempotency tax

[Retries mean duplicates](#/page/distributed-systems), so every consumer is designed for the second delivery: a transactional **outbox and inbox**, deterministic message ids, and a content hash that gates event appends — the same message twice is a no-op, not a double charge. Every endpoint retries five times, backing off from a second to five minutes; what still fails parks in an **error queue an operator can replay** once the world is fixed. Failure handling isn't an exception path here. It's the main path, drawn first.

At the border with the outside world sits an **anti-corruption layer** with a small frozen vocabulary of wire event kinds: wire values never change, so integrations stay stable while the domain model evolves behind them. An unknown kind is acknowledged and dropped — never retried into an infinite loop, never allowed to poison a queue.

## Shipping it like it matters

The runtime discipline would be theater if releases were chaos, so they aren't: a release is **zero-restart** — the web server follows a symlink swap — and enters maintenance only if the schema actually changed, on a countdown budgeted at ten minutes. The infrastructure is [CDK all the way down](#/page/iac): dev, qa and prod in separate AWS accounts, fed from one trunk, with production behind a manual approval. Every push runs 1,600+ unit tests; the work landed as 178 pull requests from a six-person team whose juniors I mentor — on conventions designed so they can touch production safely.

And because a platform the business can't operate is just a developer with extra steps, the [40+ custom admin modules](#/page/commerce-replatform) let the business onboard stores, inspect the integration and re-sync it from the admin they already live in.

## What the numbers mean

Notice what kind of numbers this story has: two minutes, five retries, fifteen minutes, ten-minute budgets, next request. They're **designed intervals, written down** — not marketing measurements. When someone asks "how long until the register sees the order?", the system has an answer before anyone checks a dashboard. That, more than any single pattern, is what I'd carry to the next build: a distributed system should be able to tell you what to expect of it, in numbers it chose on purpose.
