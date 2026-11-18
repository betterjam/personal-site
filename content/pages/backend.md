# Backend

Boring on purpose, fast where it counts — the long version, from the two backends I'd point you to: the modular monolith behind [Eleva](#/page/eleva-platform), which I wrote and have run since 2017, and the .NET middleware behind [Liquor Cart](#/page/commerce-replatform), where about 90% of the C# is mine.

## Contracts before handlers

Schemas come first. A versioned API with validation at the edge and errors that say *what to fix* is a kindness to every future consumer, including me in six months. Cleverness in a contract is a liability; clarity is a feature.

## Everything that can fail gets a queue

Work that can fail deserves a retry policy, a dead-letter destination, and a consumer that survives seeing the same message twice — because **at-least-once always means twice, eventually**. In Liquor Cart that is MassTransit over RabbitMQ: five retries backing off from a second to five minutes, then an error queue an operator can replay once the world is fixed. Idempotency isn't an optimization here; it's the admission price.

## The outbox is a promise

State change and event publication in one transaction, relayed to the bus afterward. Liquor Cart keeps one on each side: the storefront publishes an order inside the transaction that commits it, and the middleware runs an outbox and an inbox of its own. It's the closest thing to a guarantee a distributed system can offer, and it's the pattern I reach for before anything exotic.

## A monolith with walls

Eleva is the opposite shape, on purpose: one deployable, with module boundaries and tenant scopes enforced in code so it never slides into a plain monolith. The database does the guarding where it can — one answer per question is a unique index, so a retry can't corrupt an evaluation — and real-time updates ride on PostgreSQL LISTEN/NOTIFY instead of a new tier to run.

## What I optimize for

Predictability under load, honest failure modes, and logs a stranger can navigate during an incident. Latency matters, but a p99 you can explain beats a p50 you can't.

Deeper cuts: [event sourcing](#/page/event-sourcing) for when the log becomes the system, and [distributed systems](#/page/distributed-systems) for when everything fails anyway.
