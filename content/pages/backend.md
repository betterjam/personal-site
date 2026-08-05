# Backend

Boring on purpose, fast where it counts — the long version.

## Contracts before handlers

Schemas come first. A versioned API with validation at the edge and errors that say *what to fix* is a kindness to every future consumer, including me in six months. Cleverness in a contract is a liability; clarity is a feature.

## Everything that can fail gets a queue

Work that can fail deserves a retry policy, a dead-letter destination, and a consumer that survives seeing the same message twice — because **at-least-once always means twice, eventually**. Idempotency isn't an optimization here; it's the admission price.

## The outbox is a promise

State change and event publication in one transaction, relayed to the bus afterward. It's the closest thing to a guarantee a distributed system can offer, and it's the pattern I reach for before anything exotic. There's a longer argument for this in the [blog](#blog).

## What I optimize for

Predictability under load, honest failure modes, and logs a stranger can navigate during an incident. Latency matters, but a p99 you can explain beats a p50 you can't.

Deeper cuts: [event sourcing](#/page/event-sourcing) for when the log becomes the system, and [distributed systems](#/page/distributed-systems) for when everything fails anyway.
