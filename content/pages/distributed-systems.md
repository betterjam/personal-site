# Distributed Systems

Everything fails. The craft is deciding *how*.

## Consistency is a spectrum — pick your point

Two-phase commit promises certainty and delivers fragility. Sagas admit the truth: a long-running workflow is a chain of local transactions, each with an undo. When step four fails, steps one through three know how to apologize. Choosing where a system sits on the consistency spectrum — and writing it down — beats pretending the spectrum doesn't exist.

## Backpressure over heroism

Systems should slow down gracefully instead of falling over heroically. Bounded queues, load shedding, honest `429`s. The service that says "not right now" survives the traffic spike; the one that accepts everything dies with a full inbox.

## Idempotency is the tax

Retries are how distributed systems stay alive, and retries mean duplicates. Every consumer, every handler, every side effect gets designed for the second delivery. Pay the tax upfront; it's cheaper than the incident.

## Observability is the map

Traces that cross service boundaries, metrics with alarms that mean something, logs you can actually search at 3 a.m. An incident with a map is engineering; an incident without one is spelunking.

The patterns here lean on the [backend](#/page/backend) foundations and get concrete in [event sourcing](#/page/event-sourcing). The failures that taught them belong to the [blog](#blog).
