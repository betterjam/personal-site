# Frontend

Most of my frontend work is **operational**: dashboards, control panels, storefronts. Interfaces people operate, not just read.

## Surface state, make actions obvious

A good ops UI is scanned, not read. A pill, a color, and a timestamp communicate more than a log line; a button says exactly what will happen when pressed, and the toast afterward confirms it happened. The infra control panel lives by this — power buttons that look like power buttons.

## Performance is a feature, not a virtue

On the commerce side, Hyvä-style storefronts taught me that shipping fewer megabytes is the single most honest performance strategy. Faster paint, happier checkout, fewer apologies.

## Motion with intent

Animation earns its place when it explains something: where a thing came from, where it went, what just changed. This site is my working argument — the particle swarm that carries you between sections isn't decoration, it's navigation you can feel. When an animation explains nothing, it gets cut. (The [colophon](#/page/colophon) covers how the GSAP choreography works.)

## The stack I reach for

TypeScript everywhere, frameworks only when they pay rent, GSAP for choreography, and design tokens so themes are data — this site swaps entire visual identities by swapping JSON.
