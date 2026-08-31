# Developer handover

_Snapshot: 2026-08-31. This is the "pick it up cold" document for a development team._
_It is a synthesis + forward-look; the deep references it points to are the source of truth._

## 0. Read these first (in order)

| Doc | What it gives you |
|---|---|
| `CLAUDE.md` (repo root) | The product bar, the hard operating rules, conventions. Non-negotiable. |
| `docs/VISION.md` | Why this exists, the locked product decisions, the end goal. |
| `docs/ARCHITECTURE.md` | The system design and the layering. |
| `docs/ARAG-DEV.md` | **The hard-won platform reference.** Call shapes, the credential model, and every KNOWN PLATFORM BUG. Read before touching retrieval or provisioning. |
| `docs/BACKLOG.md` | Owner-tracked backlog + the ARAG exploitation roadmap. |
| This doc | Current state, what's in flight, known issues, and the idea bank. |

## 1. What this is (in one paragraph)

A **world-class research portal**: a web app where a user explores a body of research and gets
fast, credible, cited answers and discovery (search, ask, browse, generate, assess, a knowledge
graph). It runs on **Progress Agentic RAG (ARAG / Nuclia)** knowledge boxes, behind a clean
`RetrievalProvider` interface so the AI/retrieval layer can be re-wired without touching the UI.
Two **real** showcase tenants ship with it: **FRDC** (Fisheries R&D Corp) and **GRDC** (Grains
R&D Corp). The destination is a **v1.0 public open-source launch**, after which it returns to the
Progress ARAG GTM factory to become a live sales/marketing demo. Build everything credible in
front of a CIO, and keep AI/vendor branding out of the default customer-facing view.

## 2. Architecture at a glance

- **Stack:** Deno 2 + Hono (typed API) · React + TypeScript front end (esm.sh import maps, no
  bundler registry) · `node:sqlite` for admin state · ARAG for retrieval/generation.
- **Repo layout:**
  - `apps/api` — the Hono API server (`src/app.ts` routes, `src/analyse.ts` taxonomy design,
    `src/tenants.ts` tenant store, `src/arag-account.ts` account/token mint, `src/scheduler.ts`).
  - `apps/web` — the React SPA (`src/pages`, `src/components`, `src/api/client.ts`, `src/lib`).
    Router is in `src/main.tsx`.
  - `packages/core` — shared types + the in-app documentation content (`src/docs.ts`).
  - `packages/retrieval` — the ARAG integration behind `RetrievalProvider` (`src/providers/arag`).
- **The key contracts (do not break these):**
  - **Retrieval is behind an interface.** Never hardcode a specific LLM or vector store into the
    UI or components. A stub provider covers local dev; the product never ships a mock provider.
  - **Search-config isolation is central, not per-request.** Label filters live in named stored
    search configs on the box (`ensureSearchConfigs`): `portal-search` / `portal-ask` EXCLUDE the
    `documentation` label; `portal-doc-*` include ONLY it. Select the config by context — do not
    pass ad-hoc label filters at runtime. See `packages/retrieval/CLAUDE.md`.
  - **Merchandising:** resources render via DA-generated fields (title, hook, summary, key
    takeaways, stat, tags), never raw filenames like `1981-071-DLD.pdf`. `isDisplayableResource`
    hides failed/junk ingests from users but not from admin views.
  - **Tenants:** every portal = one slug + one knowledge box. Public read endpoints are
    `/api/t/{slug}/*` (no auth). Admin endpoints are `/api/admin/t/{slug}/*`, passcode-gated via
    the `x-admin-passcode` header.

## 3. Running and developing

- **Gates (necessary, not sufficient):** `deno task check` (typecheck + lint + fmt + tests) and
  `deno task build:web`. Run both before calling anything done.
- **The testing bar (this is a HARD rule):** a UI change is NOT done until it has been
  **visually verified in a real browser on the deployed page** — light AND dark, wide desktop AND
  ~390px mobile, the change plus surrounding chrome. Gates do not catch visual/theme/layout bugs.
  Say what you visually verified; never claim "tested" on gates alone.
- **Use the full screen on large displays.** Layouts scale UP on 2xl+; avoid fixed centred
  `max-w-6xl` columns that strand half a monitor. Keep prose at a readable measure (~65-75ch).
- **Vendor deps** load from esm.sh via the import map in `apps/web/index.html`; the npm registry
  is blocked — do not add npm/node_modules. `/app.js` and `/styles.css` are served no-cache with
  `?v=<build sha>` cache-busters — keep that intact so deploys are not masked by stale bundles.
- **Conventions:** Australian English, no em dashes (use a spaced hyphen) in any user-facing copy.
  Small, typed, tested increments. Secrets live in `.env` only (gitignored).

## 4. Deploy and ops

- **Deployment order is `local -> repo -> fly.io`, always. Never run `fly deploy` from a dev
  machine.** Commit, push to `origin/scaffold`; GitHub Actions gates (typecheck, lint, format,
  tests, build) then deploys. A push that fails the gate never reaches production. Confirm the
  live `app.js?v=` hash before telling anyone a change is live.
- **Admin:** production passcode is `abc123` (see `docs/BACKLOG.md`). Useful admin endpoints:
  - `POST /api/admin/t/{slug}/docs/ingest` — (re)ingest the in-app help docs into the box.
  - `POST /api/admin/t/{slug}/enrichments/run` — DA merchandising; body `{scope:'missing'|'all',
    limit}`, streams SSE. For a full drain, loop `scope:'missing'` in batches until `enriched` < batch.
  - `POST /api/admin/t/{slug}/analyse` — design the taxonomy/graph dimensions/questions from the
    corpus (samples the corpus to fit the 20k-char generation limit).

## 5. Developing on ARAG (the platform)

Read `docs/ARAG-DEV.md` before writing any retrieval/provisioning code. The essentials:

- **Credential model (most 403s are a wrong-token bug):** a **NUA key** does processing +
  KB-management/mint; a **service-account (SA) token** does KB-scoped reads/writes
  (`x-nuclia-serviceaccount: Bearer <tok>`); **user/PAT tokens** are the only ones that can read
  the account model catalogue. Never commit a raw token.
- **Known platform bugs (do not rediscover):** the `json:true` DA generator 422s; the RAO
  `/session/ephemeral` agent-session is broken. `ARAG-DEV.md` is the running list — add to it.
- **Gotchas learned the hard way:** the `X-Extract-Strategy` header must be the FULL strategy
  UUID (a truncated id is silently ignored -> default extraction); the `/ask` (and taxonomy) query
  field has a 20,000-char limit (overflow -> `string_too_long` 422); the `/graph` endpoint 422s on
  a missing/empty `query` (use `{prop:'path'}` for "everything"); the model catalogue is readable
  KB-scoped via `GET /kb/{id}/schema`.

## 6. Current state (2026-08-31)

**Live and working** (verified in-browser on the deployed app, both tenants): Explore, Search
(results + cited Ask AI, hybrid/semantic/keyword modes, facets, watch-search), Library (merchandised
cards, sorts, filters), Assistant (cited answers, confidence + REMi quality, evidence table,
sessions, deep research), Investigations, Generate (6 artefact types), Assessment, Graph (Entity
graph + Concept map + a built-in-entities toggle), Help (scoped docs + a docs-only assistant).

**Recently shipped:**
- Per-source AI verdict/rationale now generates **only on "Journey through the context"**, not on
  every answer (token saving). — `apps/web/src/components/EvidenceTable.tsx`, `AnswerStream.tsx`,
  `pages/AssistantPage.tsx`.
- A **not-found page** for unmatched routes (previously any unknown URL rendered a blank screen —
  the router had no catch-all). — `apps/web/src/pages/NotFoundPage.tsx`, `main.tsx`.
- **GRDC fully merchandised** (all ~1,070 resources enriched with DA titles/summaries).
- Help documentation rewritten to match the live app and re-ingested into both boxes.

**In flight:** the **full FRDC corpus load** (~3,920 old scanned + digital PDFs) via a resumable
loader — see the "corpus loader" memory / `~/frdc-docs/`. At snapshot time ~48% done, running
clean. **When it finishes, run the post-load passes: FRDC enrichment -> graph rebuild -> taxonomy
rebuild -> a full acceptance sweep.**

## 7. Known issues / still to do (the honest list)

1. **FRDC post-load passes** — once `=== LOAD COMPLETE ===`, run enrichment (merchandising),
   graph, and taxonomy rebuilds, then a full functional acceptance sweep on the real corpus. This
   is the client-handover gate.
2. **Live-health monitoring needs a home that can reach the internet.** A cloud (CCR) cron was set
   up to acceptance-sweep the live app, but the cloud environment's egress is locked to a package
   allowlist — it cannot reach `arag-research-portal.fly.dev` **or** `jsr.io`/`esm.sh`, so it runs
   neither the live smoke nor the gates. **Fix:** a scheduled **GitHub Actions** workflow (runners
   have open network) that curls the live public endpoints on both tenants and fails loud. Gates
   already run on every push, so the Action only needs the live smoke.
3. **Two reported UX bugs are unaddressed** because the screenshots never reached a session that
   could see them: a **deep-research error** ("this happened when I tried the deep research
   option") and a second **UX bug ("Image #32")**. Reproduce/collect these and fix. A screenshot
   of a live UX bug belongs with a session that can run the browser, not a no-network worktree.
4. **`carp control` returns 0 results on FRDC** while `carp`->10 and a 50-doc "Carp Control" topic
   exists. Isolated to that phrase; most likely the modern National Carp Control Plan content is
   not loaded yet (corpus is mid-load, currently old fisheries reports). Re-test after the load +
   re-analysis; if it persists, investigate the search-config relevance floor. Do NOT change the
   retrieval layer mid-load.
5. **Oversized documents fail ingestion.** A 125-page / 22 MB scanned PDF (`1995-167-DLD.pdf`) was
   routed to vision (Pagehound) by text-density and the platform errored on the huge vision job.
   Recovery: re-ingest with default extraction (works, text-only). **Systematic fix to consider:**
   cap vision routing by page count in the loader's `classify()` — docs over ~60 pages go to
   default regardless of density, since the vision job will not complete.
6. **The FRDC loader's SA token is not durably on disk.** It reads the token from
   `FRDC_SA_TOKEN` / a `~/frdc-docs/.sa_token` file / config. A restart in a fresh session needs
   the token re-supplied (mint via the NUA key + account, or paste one). Never store the raw token
   in the repo.
7. **`docs/BACKLOG.md` is dated (2026-08-28)** and partly superseded — several "ship scope" items
   (merchandising, documentation section, theme toggle, cache-busting) are now done. Reconcile it
   with section 6 above during the next planning pass.

## 8. Idea bank / roadmap

The `docs/BACKLOG.md` "ARAG exploitation roadmap" holds the platform-capability ideas
(page-image/table grounding, memory-agent-into-ask, graph shortest-path, custom enrichment lenses).
Headline product idea below.

### Extraction Accuracy Lab (new — Jay, 2026-08-31) — HIGH VALUE

**The pitch:** let a user upload one or more documents, run them through several extraction
strategies / vision models, and see a **side-by-side comparison of how accurately each ingests**
— so they can choose the right strategy for a corpus _before_ committing to a full ingest.

**Why it matters:** ingestion quality varies wildly by extractor and model, especially on scanned
or complex PDFs, and today choosing an extract strategy is a blind, global, all-or-nothing
decision. A manual bake-off during this build proved the top vision models differ materially in
accuracy and cost (Pagehound won on cost/quality; see the extraction-OCR findings). Productising
that bake-off turns a hidden risk into a visible, buyer-facing capability: **"prove your ingestion
quality before you trust it."**

**Shape (for the team to refine):**
- An admin/tool surface: upload test doc(s) -> pick a set of strategies/models to compare -> run.
- Show per-strategy results side by side: extracted-text yield (chars/page), structure/table
  fidelity, a quality score, plus cost and latency. Highlight the winner per document.
- Let the user then apply the chosen strategy to a real ingest.

**Where it plugs in:** ARAG already supports named extract strategies (`extract_strategies`,
`vllm_config` vision path) and exposes the model catalogue via `GET /kb/{id}/schema`. The
comparison harness exists manually — the work is productising it behind the `RetrievalProvider`.

**Risks / open questions:**
- **Isolation:** test uploads must not pollute a real corpus — use a scratch/sandbox KB or
  per-run isolation, and clean up.
- **Objective scoring is the hard part:** accuracy needs either a ground-truth reference or a
  model-as-judge; be explicit that the score is advisory.
- **Cost controls:** running N models over M pages is expensive — cap pages/models per run.
- Platform note: the `json:true` DA generator is buggy (see `ARAG-DEV.md`) — verify the working
  path first.

---
_Keep this document current: when a "known issue" is fixed or the corpus load completes, update
section 6/7. When an idea ships, move it out of the idea bank._
