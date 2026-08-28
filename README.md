# Research Portal

A thin application layer you point at an empty Progress Agentic RAG (ARAG) knowledge box. It
provisions and configures a complete, branded research portal on top of that knowledge box -
corpus, knowledge graph, labels, agents and suggested questions - then gives an organisation's
researchers a fast, cited way to explore and question their research estate.

Two showcase tenants ship as examples: **GRDC** (Grains Research and Development Corporation) and
**FRDC** (Fisheries Research and Development Corporation). See `docs/VISION.md` for the locked
product decisions, `docs/ARCHITECTURE.md` for the system design, and `docs/PARITY.md` for the
feature benchmark this portal targets.

A licence is forthcoming; none is set yet.

## Prerequisites

- **Deno 2.x** (developed against 2.9.5).
- **esbuild** and **tailwindcss**, as standalone binaries on your `PATH` (not via npm - see
  below). Versions are pinned in `Dockerfile` and `.github/workflows/deploy.yml`; keep your local
  binaries in step with those pins (esbuild 0.28.2, Tailwind CSS 4.3.3 at time of writing).
- **A Progress Agentic RAG account** (zone, account id, NUA key). There is no mock mode - this is
  a deliberate product decision ("nothing faked, ever"): the portal always talks to live ARAG
  knowledge boxes, never a stub. You cannot run this app end-to-end without one.

### Why no npm

This project deliberately does not use the npm registry or any npm-based tooling (no
`package.json`, no `node_modules`). Dependencies are resolved two ways:

- Server and shared code: Deno's native module resolution, via `deno.json` import maps - JSR
  packages (e.g. `hono`) and `https://esm.sh/...` URLs.
- Front end (React, TanStack Query, React Router, Zod, d3-force): also `esm.sh` URLs, wired into
  the browser via an `<script type="importmap">` in `apps/web/index.html`, loaded at runtime with
  no bundler-side dependency resolution.
- The web bundle itself is built with the **esbuild** and **tailwindcss** standalone binaries
  (fetched directly as platform binaries in `Dockerfile` and CI, not through `npm`/`npx`).

If a command in an old doc, issue or PR mentions `npm install` or `npm run <script>`, it is
stale - the equivalent is `deno task <name>` (see the table below).

## Setup

```sh
cp .env.example .env
# fill in ARAG_ZONE, ARAG_ACCOUNT, ARAG_NUA_KEY (and set ADMIN_PASSCODE if you want the
# admin surface enabled locally)

deno task provision   # create + seed the GRDC and FRDC knowledge boxes (idempotent);
                       # writes ARAG_KB_* bindings back into .env

deno task dev          # builds the web bundle, then serves the API + SPA on :8787
```

Without `ADMIN_PASSCODE` set, the server still runs, but every `/api/admin/*` route returns
`503 { error: "admin_disabled" }` - there is no default passcode and no way to reach the admin
surface (provisioning, corpus upload, labels, graph config, agents, branding) until you set one.

Open `http://localhost:8787`.

## Deno tasks

All commands are `deno task <name>`, defined in `deno.json`.

| Task        | What it does                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `dev`       | Builds the web bundle, then runs the API server with `--watch` on port 8787 (serves the SPA too). |
| `build:web` | Builds the full web bundle: copies `index.html`, then runs `build:css` and `build:js`.          |
| `build:css` | Compiles `apps/web/src/styles.css` with the Tailwind CLI into `apps/web/dist/styles.css`.       |
| `build:js`  | Bundles `apps/web/src/main.tsx` with esbuild into `apps/web/dist/app.js` (React and friends stay external, resolved by the browser's import map). |
| `check`     | The full gate: `deno check` on the server/scripts/web entry points, `deno lint`, `deno fmt --check`, then `test`. This is what CI runs. |
| `test`      | Runs the Deno test suite (`deno test`) across `packages/` and `apps/`.                          |
| `enrich`    | Runs `apps/api/scripts/enrich-labels.ts` - a second-dimension labelling enrichment pass, idempotent. |
| `provision` | Runs `apps/api/scripts/provision.ts` - creates/binds each tenant's knowledge box, pushes the topic labelset, uploads the seed corpus from `content/seed/`, and appends the resulting bindings to `.env`. Idempotent - safe to re-run. |

## Testing

`deno task test` runs the whole suite (Deno's built-in test runner, with `@std/testing/bdd` and
`@std/expect`). Test doubles live only inside test files - there is no mock provider or mock mode
in product code (see "nothing faked, ever" above). `deno task check` runs tests as part of the
full gate; run that before considering anything done.

## Deployment

Deployment order is **local -> repo -> fly.io, always**. Nobody runs `fly deploy` from a developer
machine. The flow is:

1. Commit locally and push to `origin/scaffold`.
2. `.github/workflows/deploy.yml` runs the gate job (`deno task build:web` then `deno task
   check` - typecheck, lint, format, tests) on GitHub's runners.
3. Only if the gate passes does the `deploy` job run `flyctl deploy --remote-only` against the Fly
   app named in `fly.toml`.

A push that fails the gate never reaches production. The `app` name in `fly.toml` is the
reference deployment for this repository; if you fork this project, change it (and the
`concurrency.group` in `deploy.yml`) to your own Fly app before deploying, or you will attempt to
deploy over someone else's app.

State (tenant configs, knowledge-box bindings, sessions, investigations, watches, sources,
insights, suggestions, branding assets) is plain JSON/JSONL on a mounted Fly volume - no database
server, see `docs/ARCHITECTURE.md`.

## Project layout

```
research-portal/
  apps/
    web/                 React + TypeScript SPA (esbuild + Tailwind, esm.sh import map)
      src/
        pages/            route-level views, including admin/ (provisioning, corpus, labels, ...)
        components/        shared UI
        api/               typed client for the API server
      index.html
    api/                  Deno + Hono API server (port 8787), serves the built SPA too
      src/
        server.ts          entry point
        app.ts              route definitions
        tenants.ts, bindings.ts, stores.ts, kg.ts, persist.ts   JSON-file-backed stores
        arag-account.ts, rate-limit.ts, scheduler.ts, ...
      scripts/
        provision.ts        create/seed tenant knowledge boxes (deno task provision)
        enrich-labels.ts     labelling enrichment pass (deno task enrich)
  packages/
    core/                 shared Zod schemas and types (Tenant, Answer, Citation, Entity, ...)
    retrieval/             RetrievalProvider interface + the Progress Agentic RAG implementation
  content/
    seed/                 seed documents for the showcase tenants - see content/seed/README.md
  docs/                   VISION, ARCHITECTURE, ARAG-DEV, PARITY, REFERENCE-PORTAL
  deno.json               import map, compiler options, fmt/lint config, tasks
  Dockerfile, fly.toml    container build and Fly deployment config
  .github/workflows/      CI gate + deploy pipeline
```
