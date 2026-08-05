# Integrations

Every external system is a distributed-systems problem wearing a vendor logo. ERPs, payment gateways, shipping APIs — the seams are where production incidents are born, so the seams get the engineering.

## Webhooks done right

Signed and verified at the door, deduplicated by delivery id, acknowledged *fast* — then processed later, on a queue, where a retry costs nothing and a crash loses nothing. The webhook handler that does real work inline is the webhook handler that pages you.

## Trust, but verify with a cron

When two systems disagree about money, someone needs to notice before the accountant does. A nightly reconciliation job is the referee: it walks both ledgers, flags drift, and turns silent corruption into a morning ticket. Boring, unglamorous, priceless.

## Anti-corruption layers

The vendor's data model stops at the boundary. Inside, the domain speaks its own language — and never learns what SOAP is. When the vendor changes (they always change), the blast radius is one adapter, not the whole codebase.

## The hard-won rule

Design every integration as if the other side is **slow, duplicated, out of order, and occasionally lying** — because on a long enough timeline, it is. The patterns that survive this assumption are in the [backend](#/page/backend) page; the failures that taught them are becoming [blog posts](#blog).
