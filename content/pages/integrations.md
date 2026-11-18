# Integrations

Every external system is a distributed-systems problem wearing a vendor logo. Store registers, payment gateways, ERPs — the seams are where production incidents are born, so the seams get the engineering. Most of what follows I learned building [Liquor Cart](#/page/commerce-replatform).

## The register that cannot move

Liquor Cart's registers run on the shop floor and are never moving to the cloud. So the integration starts from that fact instead of fighting it: database-level replication (SymmetricDS) carries rows across the boundary, including over a store's unreliable connection, and nothing on the floor waits on the internet being healthy this second.

## Webhooks done right

Signed and verified at the door, deduplicated by delivery id, acknowledged *fast* — then processed later, on a queue, where a retry costs nothing and a crash loses nothing. The webhook handler that does real work inline is the webhook handler that pages you.

## Trust, but verify with a cron

When two systems disagree about money, someone needs to notice before the accountant does. In Liquor Cart a sweeper checks every settled payment against its order on a schedule written down in advance — two minutes after settlement, then every five — and what doesn't resolve goes to a person. Boring, unglamorous, priceless.

## Anti-corruption layers

The vendor's data model stops at the boundary, behind a small frozen vocabulary of wire events. Inside, the domain speaks its own language — and never learns what SOAP is. When the vendor changes (they always change), the blast radius is one adapter, not the whole codebase.

## The hard-won rule

Design every integration as if the other side is **slow, duplicated, out of order, and occasionally lying** — because on a long enough timeline, it is. The patterns that survive this assumption are in the [backend](#/page/backend) page; the story of the build is in [Building Liquor Cart](#/page/building-liquor-cart).
