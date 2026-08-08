---
summary: Liquor Cart — a hybrid cloud/on-premise commerce platform built from scratch on Magento with 40+ custom modules, an event-driven .NET middleware, and an admin the business runs without a developer.
image: asset:liquor-cart-app/storefront-homepage-hero
gallery: asset:liquor-cart-app/liquor-category-layered-navigation|Category browsing with layered navigation, asset:liquor-cart-app/homepage-category-promos-and-product-grid|Homepage promotions and product grid
---
# Liquor Cart — Hybrid Commerce

A liquor retailer sells in two places at once: the shop floor and the internet. The registers run on-premise and are never moving to the cloud; the storefront runs on Magento in AWS. **Liquor Cart is the machinery that lets both be true** — built from scratch, storefront to infrastructure.

## The bridge between two worlds

**SymmetricDS** replicates at the database level between the on-premise systems and the cloud — the plumbing that moves rows across the boundary reliably, including over a store's unreliable connection.

On top of it I built a **custom middleware in .NET**, and this is where the interesting engineering lives:

- **Event-driven** — services talk asynchronously over RabbitMQ (MassTransit). Nothing blocks on a store's network being healthy this second.
- **Domain-driven** — point-of-sale vocabulary stops at the boundary; inside, the domain speaks its own language and an anti-corruption layer translates. When a vendor's schema shifts, one adapter changes.
- **Event-sourced catalog** — an append-only log, so "why is this product priced this way?" is a query instead of an argument between two databases.
- **CQRS and clean architecture** across independently deployable services behind an API gateway, each owning its own PostgreSQL database.

The storefront mirrors the pattern: an **order outbox** module publishes commerce events transactionally, so Magento and the middleware never disagree about what happened.

## Making it almost headless

The part I'd show an engineer first isn't the storefront — it's the **40+ custom Magento modules** that turn a notoriously developer-dependent platform into something the business operates alone:

- **Merchant self-service** — onboarding, a merchant dashboard, catalog management and a custom merchant home, so a new store goes live without a deployment.
- **Middleware control from the admin** — start, inspect and re-sync the integration from the same screen the business already lives in, instead of an SSH session.
- **Diagnostics and live documentation** — the platform documents itself; the docs are generated from the modules rather than maintained beside them.
- **Release manager, version info and a config-structure guard** — safe upgrades, visible versions, and configuration that refuses to drift into an invalid shape.
- **Commerce specifics** — a custom checkout, delivery integration, payment-gateway middleware, fees and tipping, ordering status, product families, stock-aware sorting and search relevance, plus the compliance rules a regulated category demands.

The storefront itself is **Hyvä**-based: fewer megabytes, faster paint, happier checkout.

## How it ships

Dockerised local development with live file sync, a production-like environment for rehearsals, Playwright end-to-end tests, and CI/CD to AWS — Magento on ECS with Aurora, OpenSearch, ElastiCache and a shared file system, all defined in CDK. The same [infrastructure-as-code](#/page/iac) discipline as everything else I build.

## What it taught me

Hybrid is the honest word for most real commerce: there is nearly always a system that cannot move — a register, an ERP, a box in a back room — and the craft is a seam that tolerates it being slow, duplicated, out of order or briefly offline. Everything I believe about [integrations](#/page/integrations) and [event sourcing](#/page/event-sourcing) was stress-tested here.
