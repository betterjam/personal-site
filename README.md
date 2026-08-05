# personal-site — personal site + event-sourced blog + its own AWS infrastructure

Diego Palominos' personal site: a GSAP long-scroll frontend (the "Mixtape" —
every band wears a different finish, all rendered from one `content.json`)
served by a NestJS monolith with an event-sourced blog API, deployed by a CDK
app that also builds a public control plane for its own infrastructure. The
seven design mockups the build grew out of live on in `mockups/`.

```bash
git clone git@github.com:betterjam/personal-site.git
cd personal-site

cd app      && npm install && npm run start:dev   # API + static, :3000
cd frontend && npm install && npm run dev         # Vite HMR,     :5173
```

Three self-contained npm projects — `app/` (NestJS), `frontend/` (Vite) and
`infra/` (CDK, projen-managed) — plus the content and theme JSON they render.

## Architecture

```
personal-site/
├── content/
│   ├── content.json        # THE single source of truth: profile + sections
│   └── roadmap.json        # under-construction banner todos (done/doing/next)
├── themes/                  # one JSON per finish: palette, type stacks, motion
│   └── mixtape.json         # composition: which finish each section wears
├── frontend/                # Vite + TypeScript + GSAP long-scroll frontend
│   └── src/
│       ├── assets/          # bundled captures, one folder per project
│       │   └── _review/     # QUARANTINED shots — never globbed, never shipped
│       ├── engine/          # scroll spine, particles, cursor, themes, API client
│       └── sections/        # one renderer per band (hub, orbit, strips, blog…)
├── app/                     # NestJS 11 monolith: serves frontend + /api
│   ├── public/              # BUILT frontend lands here (vite build output)
│   ├── src/                 # content/themes/posts/meta modules, event store
│   └── var/                 # append-only blog-events.jsonl (gitignored)
├── infra/                   # AWS CDK v2 app (projen): the whole stack, fenced
│   ├── src/                 # site stack (S3+CloudFront+ECS+RDS+CodePipeline)
│   │   ├── constructs/      # the account/region fence, panel metadata, tags
│   │   └── control/         # the public control plane's Lambda handler
│   └── test/                # synth-time assertions on every guardrail
├── mockups/                 # the seven design mockups (body fragments — see below)
└── tools/
    ├── make-local-previews.sh
    └── optimize-shots.mjs   # WebP derivatives for the captures (opt-in)
```

The frontend bundles `content/*.json` and `themes/*.json` at build time and
renders everything from that data — no copy lives in markup. The blog band is
live: it fetches `/api/posts` at runtime (with a drafts fallback when the API
is offline), and the under-construction banner reads `/api/meta` for the
deployed commit + recent deploys.

## Development

Two processes: the API on :3000, Vite's dev server proxying `/api` to it.

```bash
# terminal 1 — the NestJS app (API + static)
cd app && npm install && npm run start:dev        # http://localhost:3000

# terminal 2 — the frontend with HMR
cd frontend && npm install && npm run dev          # http://localhost:5173
```

`frontend/vite.config.ts` proxies `/api` → `http://localhost:3000`, so the
blog and banner are live in dev too.

## Production build

```bash
cd frontend && npm run build    # tsc --noEmit && vite build → ../app/public
cd ../app && npm run build && npm start
```

The frontend builds straight into `app/public/`; the app serves it at `/` and
the API under `/api`. See **`app/README.md`** for the full runbook: API
reference, event-sourcing model, environment variables (`PORT`, `ADMIN_TOKEN`,
`GIT_SHA`, …) and Docker usage.

## Pictures

Screenshots live in `frontend/src/assets/<project>/<name>.png|webp` and are
referenced from content — a page's front matter, the maintainer console, a
markdown block — as **`asset:<token>`**. Tokens come from the files
themselves (`src/engine/assets.ts` globs them at build time): a file
registers the qualified `<folder>/<name>` always, and the bare `<name>` when
that name is unique across folders — a collision drops the bare alias and
says so in the build log. Unknown token → no picture, never a broken one.
`https://` URLs work everywhere a token does.

- **`src/assets/_review/`** holds shots pulled aside for personal or
  customer data. It is excluded from the glob, from the size manifest and
  from the bundle. Nothing in it ever ships.
- A page's `image` opens its reading room as a framed hero; its `gallery`
  (`ref|caption` entries, 24 max) closes it as a thumbnail grid, and both
  page into the same lightbox. In a body, `!image[ref|caption]` draws one
  framed figure and `!gallery[ref, ref, …]` draws a grid.
- `vite.config.ts` reads every capture's intrinsic size out of its file
  header and serves it as `virtual:asset-meta`, so frames reserve their
  space before a byte of picture decodes.
- One token, one file: `tools/optimize-shots.mjs` writes `.webp`
  derivatives beside the originals (needs `sharp`, `cwebp` or `ffmpeg` —
  without one it says so and changes nothing), the registry then prefers
  the derivative, and the build drops the superseded original from
  `app/public`. Originals stay in the repo, always.

## The mockups (design phase)

Seven interactive finishes, all rendering the same `content.json`. They are
body *fragments*, not standalone documents — `tools/make-local-previews.sh`
wraps each one in an HTML shell in `mockups/local/` (gitignored) so a browser
will render it:

```bash
tools/make-local-previews.sh
# then open mockups/local/01-surf-orbit.html (etc.) in a browser
# from WSL: explorer.exe "$(wslpath -w mockups/local/01-surf-orbit.html)"
```

| # | Finish | Stage | Transition paradigm |
|---|--------|-------|---------------------|
| 01 | Surf Green Orbit | light | Prezi-style: sections orbit a central pick; open = rotate world + zoom into the node |
| 02 | Candy Apple Burst | dark | Particles: headlines explode into a swarm that reassembles as the next section |
| 03 | Three-Tone Sunburst | light | Classic long-scroll editorial, ScrollTrigger chapter blooms |
| 04 | Seafoam Studio | light | Swiss grid; GSAP Flip morphs a card into the fullscreen section |
| 05 | Pedalboard | dark | Sections are stompboxes: stomp → LED → patch cable draws → panel slides in |
| 06 | Event Log | dark | Developer-first: sections replay in as streaming log lines; Ctrl+K command palette; Lake Placid Blue |
| 07 | Mixtape | mixed | The one that shipped: every band keeps its own finish, stitched by a scroll spine that re-tints the accent between them |

The production frontend is the **Mixtape**: one long scroll where each section
keeps its mockup finish, stitched together by a scroll spine (accent re-tint +
rail nav) and Candy Apple particle flourishes.

## Infrastructure

`infra/` is a projen-managed AWS CDK v2 app that deploys the whole thing:
S3 + CloudFront for the built frontend, ECS Fargate (ARM, 0.25 vCPU) for the
NestJS app behind an ALB, a single **RDS t4g.micro Postgres** (not Aurora — the
control plane can only power `ecs.FargateService` and `rds.DatabaseInstance` on
and off), ECR, Secrets Manager, and a CodePipeline that builds and ships on
push. A second stack puts a public control plane in front of it, so a stranger
can turn the site's infrastructure on and off from a browser. The cheapest
instance is the one that's off.

The interesting part is the fencing. The app refuses to synthesize into an
account it was not explicitly told to expect, creates its own VPC rather than
joining one, prefixes and tags every resource, caps what the public control
plane's IAM role can reach, auto-switches things off, and carries a budget plus
a billing alarm. Every one of those guardrails is asserted in `infra/test/`.

```bash
cd infra && npm install
npx projen build                                   # compile + jest + lint
npx cdk synth -c expectedAccount=<ACCOUNT>         # no credentials needed
```

The AWS account id is deliberately **not** in source: pass
`-c expectedAccount=<id>` (or set `CDK_EXPECTED_ACCOUNT`), and keep your own
value in `infra/cdk.context.json`, which is gitignored. Synth is credential-free
because the app performs no context lookups. See **`infra/README.md`**.

### Next

- `frontend/` builds into `app/public/` on a developer machine today; move it
  into a Docker build stage so built bundles stop being committed.
- Move the ECS `DATABASE_URL` from a plain environment variable to an
  `ecs.Secret`, so the password is not readable via `ecs:DescribeTaskDefinition`.

## Licensing

Code is **MIT** — see [`LICENSE`](LICENSE). The prose in `content/`, the
screenshots in `frontend/src/assets/` and the palettes in `themes/` are **not**
MIT: they are all rights reserved, and some screenshots show client systems
that are not mine to sublicense. Third-party components, GSAP in particular,
have their own terms — see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Typography is self-hosted (Fontsource, woff2): Archivo/Archivo Black, Barlow
Condensed, Fraunces + Newsreader, Jost, JetBrains Mono — one face per finish,
mapped through the theme JSONs' type stacks.
