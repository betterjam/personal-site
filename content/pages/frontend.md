# Frontend

Most of my frontend work is **operational**: evaluation screens, control panels, storefronts. Interfaces people operate, not just read.

## Screens a whole school answers

[Eleva](#/page/eleva-platform)'s web app is Angular, now on version 21, and its hardest screen is the humblest one: answering an evaluation. A teacher can go one question per screen with the keyboard, or answer as a conversation on a phone — same answers, same rules, two ways through. When a whole school answers in the same week, the answering screen *is* the product.

## Surface state, make actions obvious

A good ops UI is scanned, not read. A pill, a color, and a timestamp communicate more than a log line; a button says exactly what will happen when pressed, and the toast afterward confirms it happened. The [infra control panel](#/page/infra-control-panel) lives by this — power buttons that look like power buttons.

## Performance is a feature, not a virtue

On the commerce side, [Liquor Cart](#/page/commerce-replatform)'s Hyvä storefront taught me that shipping fewer megabytes is the single most honest performance strategy. Faster paint, happier checkout, fewer apologies.

## Motion with intent

Animation earns its place when it explains something: where a thing came from, where it went, what just changed. This site is my working argument — the particle swarm that carries you between sections isn't decoration, it's navigation you can feel. When an animation explains nothing, it gets cut. (The [colophon](#/page/colophon) covers how the GSAP choreography works.)

## The stack I reach for

TypeScript everywhere, Angular where an application lives for years, GSAP for choreography, and design tokens so themes are data — this site swaps entire visual identities by swapping JSON.
