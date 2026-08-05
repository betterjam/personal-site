# diego-site app

NestJS 11 monolith serving Diego's personal site: a static frontend at `/`
(the Mixtape build will land in `public/`) and a JSON API under `/api`,
including an **event-sourced blog**.

## Run

```bash
npm install
npm run build
npm start            # http://localhost:3000

npm run start:dev    # watch mode
npm test             # compiles src+test, runs node:test against the output
```

## API

| Method | Path                         | Notes                                                     |
| ------ | ---------------------------- | --------------------------------------------------------- |
| GET    | /api/content                 | content.json from CONTENT_DIR                              |
| GET    | /api/themes                  | theme ids (THEMES_DIR/*.json basenames)                    |
| GET    | /api/themes/:id              | one theme document; 404 unknown                            |
| GET    | /api/posts                   | published posts, newest `publishedAt` first                |
| GET    | /api/posts/:slug             | one published post; 404 unknown/unpublished                |
| POST   | /api/posts                   | admin; `{title, deck, tags?, body?, draft?}` -> 201        |
| PATCH  | /api/posts/:slug             | admin; `{title?, deck?, tags?, body?}` -> 200 updated post |
| POST   | /api/posts/:slug/publish     | admin; 200 post, idempotent (no event if published)        |
| POST   | /api/posts/:slug/unpublish   | admin; 200 post, idempotent (no event if not published)    |
| GET    | /api/admin/posts             | admin; ALL posts any status, `updatedAt` desc              |
| GET    | /api/admin/posts/:slug       | admin; any status; 404 unknown                             |
| GET    | /api/admin/posts/:slug/events| admin; that slug's raw events `[{seq,type,at,data}]`, seq asc |
| GET    | /api/pages                   | published pages `[{slug, title, publishedAt, summary?, image?, repo?, gallery?}]`, `title` asc |
| GET    | /api/pages/:slug             | one published page; 404 unknown/unpublished                |
| POST   | /api/pages                   | admin; `{title, body, summary?, image?, repo?, gallery?, draft?}` -> 201 |
| PATCH  | /api/pages/:slug             | admin; `{title?, body?, summary?, image?, repo?, gallery?}` -> 200 updated page |
| POST   | /api/pages/:slug/publish     | admin; 200 page, idempotent (no event if published)        |
| POST   | /api/pages/:slug/unpublish   | admin; 200 page, idempotent (no event if not published)    |
| GET    | /api/admin/pages             | admin; ALL pages any status, `updatedAt` desc              |
| GET    | /api/admin/pages/:slug       | admin; any status; 404 unknown                             |
| GET    | /api/admin/pages/:slug/events| admin; that slug's raw events `[{seq,type,at,data}]`, seq asc |
| GET    | /api/meta                    | `{commit, builtAt, deploys}` deploy metadata               |
| GET    | /api/github/:owner/:repo     | cached GitHub repo card; always 200 `{state: public\|private\|unavailable, …}`, 400 on a malformed reference |

A post reads as `{slug, title, deck, tags, body?, status, publishedAt?,
updatedAt}` with `status` one of `draft | published | unpublished`.
`updatedAt` is the `at` of the latest event applied to the post.

WordPress-style **pages** live alongside posts with the same lifecycle. A
page reads as `{slug, title, body, summary?, image?, repo?, gallery?,
status, publishedAt?, updatedAt}`; the public list returns `{slug, title,
publishedAt, summary?, image?, repo?, gallery?}` summaries sorted by title.

`summary` and `image` are the page's **card metadata** — what a page block
renders when a section or another page references this page instead of
repeating its copy. Both are optional and both are absent keys (never empty
strings) when unset. `summary` is trimmed and at most **300 characters**;
`image` is either an `https://` URL or an `asset:<token>` reference to an
image bundled with the frontend. A token is either a bare name
(`asset:maintainer`) or one qualified by its folder
(`asset:eleva-app/org-chart-editor`) — `^asset:[a-z0-9-]+(/[a-z0-9-]+)?$`,
so exactly one slash and no traversal. Anything else — `http://`, `data:`,
`javascript:`, protocol-relative `//host`, a bare path — is a 400 on create
and revise, so no unsafe URL reaches the log. On PATCH, `summary: ""` /
`image: ""` is a real revision: it clears the field.

`gallery` is the page's **picture strip**: an ARRAY of `{ref, caption?}`
entries in the order they should be shown, at most **24** of them, each
`ref` held to exactly the rule `image` is held to (a bare string is the
caption-less shorthand for `{ref}`). Refs and captions are trimmed and a
blank caption is dropped rather than stored as `""`; a non-array, an entry
without a `ref`, a ref the rule rejects, or a 25th entry is a 400. Like the
other fields it is an absent key — never `[]` — when the page has none, and
on PATCH an **empty array clears it**. Nothing about the picture itself is
stored: the reference is resolved against the frontend's asset registry at
render time, so a screenshot that is renamed or withdrawn changes nothing an
event replay would see.

`repo` is the third piece of card metadata: the `owner/name` of the GitHub
repository the page is about, e.g. `betterjam/eleva-aws-infra-control`. It
must match `^[A-Za-z0-9_.-]{1,39}/[A-Za-z0-9_.-]{1,100}$` (and no segment
may be all dots) — anything else is a 400 on create and revise, because the
same reference is later interpolated into an api.github.com URL by the
proxy below. Like the other two it is an absent key when unset, and
`repo: ""` on PATCH clears it. The page holds the REFERENCE only: stars,
description and visibility are upstream state fetched through
`/api/github`, never stored in the log — a repo going private changes
nothing an event replay would see.

Posts and pages share ONE slug namespace (routes stay unambiguous):
creating a page whose kebab-cased title collides with an existing post OR
page slug is a 409 (page create checks both projections). Pages seed
per slug from the authored Markdown in `PAGES_DIR` — see *Seeding* below.

`GET /api/meta` reports `commit` (`GIT_SHA`, `dev` when unset), `builtAt`
(`BUILD_TIME`, process start when unset), and `deploys`: the last 5
`DeployRecorded` events as `{sha, at}`, newest first.

## GitHub repo proxy

`GET /api/github/:owner/:repo` is what the repo widget reads. It exists as a
server proxy, not a browser call, for three reasons: the unauthenticated
GitHub API allows **60 requests per hour per IP** (one shared budget for the
whole site, so the answer has to be cached once centrally rather than once
per visitor), a token must never reach a browser, and a repo the site cannot
see needs a designed answer rather than a failed request in a console.

Both params are validated against the page field's reference format above;
a malformed one is `400` and **never** interpolated into the upstream URL.
Everything else is `200` with one of three states:

```jsonc
{ "state": "public", "fullName": "octocat/Hello-World",
  "url": "https://github.com/octocat/Hello-World",
  "description": "…|null", "language": "TypeScript|null",
  "stars": 2431, "forks": 187, "topics": ["nestjs"],
  "pushedAt": "2026-07-30T09:12:04Z", "homepage": "https://…|null" }

{ "state": "private", "fullName": "…", "url": "…" }

{ "state": "unavailable", "fullName": "…", "url": "…",
  "reason": "rate-limited|timeout|error" }
```

| Upstream                          | State                        |
| --------------------------------- | ---------------------------- |
| 200                               | `public`                     |
| 404, or 403 with quota left       | `private`                    |
| 403 with `x-ratelimit-remaining: 0` / `retry-after`, or 429 | `unavailable` `rate-limited` |
| abort after 3s                    | `unavailable` `timeout`      |
| network failure, 5xx, unusable body | `unavailable` `error`      |

**`private` is a first-class state, not an error.** Unauthenticated GitHub
answers 404 for a private repo, a renamed one and a deleted one alike, and
the proxy does not guess which: it reports "we cannot see this" and the
widget renders a non-clickable card rather than a link into a 404.

Answers are cached in memory, keyed on the lowercased `owner/name`
(GitHub is case-insensitive, so `BetterJam/X` and `betterjam/x` cost one
request between them):

| State         | TTL     | Why                                                     |
| ------------- | ------- | ------------------------------------------------------- |
| `public`      | 1 hour  | stars and pushes move slowly; 60/hr is the real budget   |
| `private`     | 6 hours | this answer changes least often and costs the same quota |
| `unavailable` | 5 min   | short on purpose, so a rate limit or blip **retries** soon |

Concurrent reads of the same repo share ONE in-flight request, so a page
with several placements of the same widget still spends one call. Upstream
requests carry a `User-Agent` (GitHub rejects requests without one) and are
aborted after **3 seconds**. The service never throws: a failure becomes an
`unavailable` card, so a GitHub outage can never take a page render down.

**`GITHUB_TOKEN` (optional) — read this before setting it.** When set, it is
sent as `Authorization: Bearer …` on upstream calls. It raises the rate
limit, but it also means the proxy can SEE Diego's private repositories —
and a repo the token can read answers 200, so the endpoint will publish that
repo's name, description, language, topics and activity **publicly, to
anyone who hits the site**. The private-repo card exists precisely so the
site does not need this. Leave it unset unless you want private repo
metadata public; if you do set it, use a fine-grained token scoped to
public metadata only. The token is never logged and never included in any
response.

Every admin endpoint requires header `x-admin-token: $ADMIN_TOKEN`. If
`ADMIN_TOKEN` is unset they answer `503 {"error":"admin disabled"}`; a
missing or wrong token answers 401. Blank/missing `title` or `deck` on
create is 400, as is a PATCH with no recognized field; creating a slug that
already exists is 409. `draft: true` on create appends `PostDrafted` only
(the post stays invisible publicly until `/publish`).

## Event sourcing model

The blog's source of truth is an **append-only event log**, not a posts
table. Writes append events; reads come from a projection folded over the
log.

- **Store**: two implementations behind the `EventStore` interface
  (`src/blog/event-store.ts`), selected by env — see *Store selection*
  below. Both hand out `{seq, type, at, data}` with a monotonic `seq`.
- **Events**: `PostDrafted {slug, title, deck, tags[], body?}`,
  `PostPublished {slug, publishedAt}`, `PostRevised {slug, changes:
  {title?, deck?, tags?, body?}}`, and `PostUnpublished {slug, at}`.
  Timestamps are ISO strings. Unpublishing hides a post from public reads;
  its history stays in the log and a later `PostPublished` republishes it.
- **Page events**: `PageCreated {slug, title, body, summary?, image?, repo?,
  gallery?}`, `PageRevised {slug, changes: {title?, body?, summary?, image?,
  repo?, gallery?}}` (an empty-string change clears that field, as does an
  empty `gallery` array), `PagePublished {slug, publishedAt}`, and
  `PageUnpublished {slug, at}` ride the same log. `PagesProjection` mirrors
  `PostsProjection` (rebuilt on boot by full replay); each projection folds
  only its own event types, so posts ignore page events and vice versa.
- **Projection**: `PostsProjection` is an in-memory read model rebuilt on
  every boot by replaying the whole log (restart = full replay), and fed
  in-process on each append. It keeps nothing a replay cannot reproduce.
- **Seeding (posts)**: when the log is empty on boot, the blog items in
  `content.json` (`sections[id=blog].items`) are appended as
  `PostDrafted` + `PostPublished` pairs (slug kebab-cased from the title,
  `item.date` as `publishedAt`).
- **Seeding (pages, per slug)**: after replay, the boot walks the authored
  Markdown files in `PAGES_DIR` (default `<repo>/content/pages`) in
  filename order. For each `*.md` file whose slug — the filename without
  `.md` — has ZERO page events in the log, it appends `PageCreated {slug,
  title, body, summary?, image?, repo?, gallery?}` + `PagePublished {slug,
  publishedAt}` and feeds them through the projection immediately (no
  restart needed to serve them). **The seeding guarantee: on a FRESH
  database, one boot recreates every page in `content/pages` whole — title,
  body, summary, image, repo AND gallery — so a production deploy
  reproduces the site's content exactly from the repo, with no import step
  and nothing to click.** Each file is read in two steps. First, **front
  matter**: an OPTIONAL leading block delimited by `---` lines, parsed into
  the event data and STRIPPED from the body:

  ```markdown
  ---
  summary: Seven guitar finishes over an event-sourced CMS.
  image: asset:maintainer
  repo: betterjam/eleva-aws-infra-control
  gallery: asset:eleva-app/org-chart-editor|Org chart editor, asset:eleva-app/question-bank-catalog|Question bank
  ---
  # This Site
  ```

  | Key       | Value                    | Becomes                     | Rule                                                                 |
  | --------- | ------------------------ | --------------------------- | -------------------------------------------------------------------- |
  | `summary` | one line of prose        | `summary`                   | trimmed, at most 300 characters                                      |
  | `image`   | one reference            | `image`                     | `https://…` or `asset:<token>`                                       |
  | `repo`    | `owner/name`             | `repo`                      | the same reference format `/api/github` accepts                      |
  | `gallery` | comma-separated list of `ref` or `ref\|caption` | `gallery: [{ref, caption?}]` | each ref as `image`; at most 24 entries; authored order kept |

  It is a flat `key: value` list, not YAML: one key per line, values
  trimmed (optional wrapping quotes removed), only the FIRST colon splits
  (so `asset:maintainer` and `https://...` survive), and any key other than
  the four above is ignored rather than an error. A file that does
  not OPEN with `---`, or whose block is never closed, has no front matter
  and is passed through untouched.

  In a `gallery:` list, whitespace around items, refs and captions is
  trimmed; an item with no `|` has no caption; an item with nothing before
  the `|` is skipped rather than seeded as a broken picture; and an empty
  value is the same as an absent key. A caption MAY contain commas — a comma
  starts the next entry only when what follows it opens a reference
  (`asset:` or `https://`), so `…|Live docs, generated from the modules`
  stays one picture with its whole sentence.

  A value the API would reject (over-long
  summary, non-`https`/non-`asset` image, a `repo` that is not
  `owner/name`) is dropped with a warning — one bad line must not fail a
  boot; for the gallery the same rule applies per ENTRY, so a bad reference
  costs its own picture rather than the strip, and a list longer than 24
  keeps its first 24. Then the existing rule applies to what
  remains: a `# Heading` first line becomes the title (that line and one
  following blank line leave the body, which is trimmed); a file with no
  heading titles itself from the humanized filename (`guitar-shelf` ->
  `Guitar Shelf`). The invariant: a slug with ANY existing page events
  (created, revised, unpublished — anything) is NEVER touched by the
  seeder. So dropping a new `.md` file in seeds just that file on the
  next boot, while editing a page through the maintainer permanently
  detaches it from its file — the file is only ever a page's first
  version, never an update, and an unpublished page stays unpublished
  across restarts. A missing or empty directory is a quiet no-op. The
  gate is per page slug rather than log emptiness because posts and
  deploys share the log: a fresh boot's post events never suppress the
  page seed.
- **Deploys**: deploy history lives in the same log as `DeployRecorded
  {sha, at}` events — on boot, a `GIT_SHA` differing from the latest recorded
  sha appends one (restarts of the same build append nothing). Each
  projection folds only its own event types, so the streams stay independent.

## Store selection (file vs Postgres)

`EVENT_STORE=postgres` switches the app from the JSONL file store to a
Postgres-backed store; any other value (or unset) keeps the file store.
The Postgres store needs `DATABASE_URL` and owns a `pg` connection pool
that is drained on shutdown. It keeps the whole log in one append-only
table, created on first use:

```sql
CREATE TABLE IF NOT EXISTS blog_events (
  seq  bigserial   PRIMARY KEY,
  type text        NOT NULL,
  at   timestamptz NOT NULL,
  data jsonb       NOT NULL
);
```

Appends are single `INSERT ... RETURNING seq` statements, reads a single
`SELECT ... ORDER BY seq`. Seeding, projections, and `DeployRecorded`
events behave identically on either store — an empty log gets seeded from
content.json, and any page slug without events gets seeded from
`PAGES_DIR/*.md`, regardless of what's underneath.

Local Postgres for development (use your own password, never commit it):

```bash
docker run -d --name eleva-blog-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=eleva_blog postgres:17

EVENT_STORE=postgres \
DATABASE_URL='postgres://postgres:<password>@localhost:5432/eleva_blog' \
npm start
```

Copy `.env.example` to `.env` for local settings; `.env` is gitignored and
real credentials must never land in tracked files.

## Environment variables

| Variable         | Default                       | Purpose                             |
| ---------------- | ----------------------------- | ----------------------------------- |
| PORT             | 3000                          | HTTP port                           |
| CONTENT_DIR      | `<app>/../content`            | directory with content.json         |
| PAGES_DIR        | `<app>/../content/pages`      | authored page Markdown seed files   |
| THEMES_DIR       | `<app>/../themes`             | directory with theme JSON           |
| EVENT_STORE      | unset (file store)            | `postgres` selects the Postgres store |
| DATABASE_URL     | unset                         | Postgres connection string (required with `EVENT_STORE=postgres`) |
| BLOG_EVENTS_PATH | `<app>/var/blog-events.jsonl` | append-only blog event log (file store) |
| ADMIN_TOKEN      | unset (admin writes disabled) | token for the admin endpoints       |
| GITHUB_TOKEN     | unset (anonymous, 60 req/hr)  | Bearer credential for `/api/github` — **makes PRIVATE repo metadata public on the site**; see *GitHub repo proxy* |
| GIT_SHA          | unset (`commit` reads `dev`)  | deployed commit; stamps deploys     |
| BUILD_TIME       | unset (process start used)    | ISO build timestamp                 |

## Docker

```bash
docker build -t diego-site \
  --build-arg GIT_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_TIME="$(date -u +%FT%TZ)" .
docker run --rm -p 3000:3000 \
  -v "$PWD/../content:/content:ro" -v "$PWD/../themes:/themes:ro" \
  -e CONTENT_DIR=/content -e THEMES_DIR=/themes \
  -e ADMIN_TOKEN="$(openssl rand -hex 24)" \
  diego-site
```

The image contains `dist/`, `public/`, and production deps only. The event
log defaults to `/app/var` inside the container — mount a volume to keep it.

## ECS/RDS

The container ships to ECS Fargate behind an ALB, with content/themes baked
into the image at CDK time. In production set `EVENT_STORE=postgres` and
point `DATABASE_URL` at RDS — the single append-only `blog_events` table
replaces the JSONL file; the projection and API do not change.
