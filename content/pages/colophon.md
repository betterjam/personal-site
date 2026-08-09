# Colophon

How this site is made — because a site about event sourcing should be able to explain itself.

## One content file, many finishes

The site's first life was a design exploration: six complete templates, each a whole different site, every one rendering the same `content.json` — the proof that content and finish are separable. The exploration ended and the best of it became this **mixtape**: one deck where each section wears a different *finish* — a theme named after a guitar color: Seafoam Studio for the home grid, Candy Apple for the particle swarm, Lake Placid Blue for the event log, three-tone Sunburst for the reading rooms. The contract survived the redesign: everything still renders from that single `content.json`, and swapping a theme file changes a section's clothes without touching a word of content.

## The moving parts

- **Frontend:** TypeScript and GSAP, no framework. Sections live on a snapped scroll track; moving between them fires a particle morph that recolors mid-flight toward the destination's palette.
- **Backend:** a NestJS monolith serving the static build and a small API.
- **Content:** an append-only event log in PostgreSQL. Posts and pages are projections — `PostDrafted`, `PageRevised`, `PostPublished` — replayed from the first event on every boot. Even deploys are events; the banner on the home page reads them back.
- **Type:** Archivo, Barlow Condensed, Fraunces, Newsreader, Jost, and JetBrains Mono — self-hosted, one face per finish.

## The crew

Diego on lead — direction, taste, and the tickets. **Claude on rhythm** — an AI pair that committed most of these riffs. Every deploy stamps its commit hash into the page you're reading, so the credits are verifiable.

The code lives at [github.com/betterjam](https://github.com/betterjam).
