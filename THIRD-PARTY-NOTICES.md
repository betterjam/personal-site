# Third-party notices

This repository's own code is MIT licensed (see [`LICENSE`](LICENSE)). The
components below are **not** ours and are covered by their own terms. Nothing
here grants you rights to them.

## GSAP (GreenSock Animation Platform)

- **Version:** 3.x (`gsap@^3.13.0`, see [`frontend/package.json`](frontend/package.json))
- **Copyright:** Copyright 2025, GreenSock. All rights reserved.
- **License:** GreenSock Standard "No Charge" License — <https://gsap.com/standard-license>
- **Not an OSI open-source license.** It grants use within your own project; it
  does **not** grant redistribution of the library as standalone downloadable
  files.

GSAP appears in this repository in two places:

1. **As an npm dependency of the frontend.** `frontend/src/sections/editorial.ts`
   and the other scroll sections import it; it is installed by `npm install`
   and bundled into the build. It is not vendored into this repo.
2. **Inlined inside `mockups/*.html`.** Each design mockup is a single
   self-contained file with its own copy of GSAP (and, in some, ScrollTrigger
   and Flip) inlined so the file opens in a browser with no build step. Every
   one of those copies carries its original `gsap.com/standard-license` banner,
   which must be preserved.

A `vendor/` directory previously held standalone `gsap.min.js`,
`ScrollTrigger.min.js` and `Flip.min.js` copies. Nothing loaded them, and
checking un-built library files into a public repository is the redistribution
case the GreenSock license does not cover, so `vendor/` is no longer tracked
(it is listed in `.gitignore`).

If you fork this repository and use the mockups or the frontend, **you need
your own GSAP license** — the free Standard license for most uses, or a Club
GreenSock membership for the bonus plugins. See <https://gsap.com/licensing/>.

## Fonts

Typography is self-hosted through [Fontsource](https://fontsource.org/) (woff2):
Archivo / Archivo Black, Barlow Condensed, Fraunces, Newsreader, Jost and
JetBrains Mono. Each family ships under its own upstream license — all are
[SIL Open Font License 1.1](https://openfontlicense.org/) at the time of
writing. See the individual `node_modules/@fontsource*/LICENSE` files.

## AWS Cloud Development Kit

`infra/` builds on [aws-cdk-lib](https://github.com/aws/aws-cdk), Apache-2.0,
Copyright Amazon.com, Inc. or its affiliates.
