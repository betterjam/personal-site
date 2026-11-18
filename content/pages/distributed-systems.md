# Distributed Systems

Everything fails. The craft is deciding *how*. What follows is how [Liquor Cart](#/page/commerce-replatform) fails — on purpose, in ways I chose.

## Consistency is a spectrum — pick your point

Two-phase commit promises certainty and delivers fragility. Sagas admit the truth: a long-running workflow is a chain of local transactions, each with an undo. Liquor Cart's payment recovery is one: settled money and acknowledged orders are two different facts, and a state machine reconciles them with a compensating action for every ending — void, refund, cancel or complete. When the facts don't resolve, it escalates to a person instead of guessing.

## Backpressure over heroism

Systems should slow down gracefully instead of falling over heroically. Bounded queues, load shedding, honest `429`s — and isolation, which is backpressure you configure once: every Liquor Cart store has its own virtual host on the broker, so the day one store's connection degrades into a retry storm, the blast radius is exactly one store.

## Idempotency is the tax

Retries are how distributed systems stay alive, and retries mean duplicates. Every consumer, every handler, every side effect gets designed for the second delivery: an outbox and an inbox, deterministic message ids, and a content hash that gates appends. Pay the tax upfront; it's cheaper than the incident.

## Observability is the map

OpenTelemetry traces that cross service boundaries — an order can be followed from checkout to register — metrics with alarms that mean something, logs you can actually search at 3 a.m. An incident with a map is engineering; an incident without one is spelunking.

The patterns here lean on the [backend](#/page/backend) foundations and get concrete in [event sourcing](#/page/event-sourcing). The whole story, in the order the decisions were forced, is in [Building Liquor Cart](#/page/building-liquor-cart).
