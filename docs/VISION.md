# Vision - Research Portal

> The five decisions from CLAUDE.md, locked with Jay on 2026-08-21.

## The one-line vision
A world-class, multi-tenant research portal that you point at a blank Progress Agentic RAG
knowledge box: the application provisions and configures everything for the domain you describe
(knowledge graph, agents, labels, suggested questions, branding), then gives that organisation's
researchers a fast, credible, beautifully designed way to explore and question their entire
research estate.

## 1. Domain / corpus
**Domain-agnostic by design.** The portal is not built for one corpus - it is built to be pointed
at a *blank* knowledge box and configure itself from a domain brief. Everything the domain shapes
(topic taxonomy, labels, knowledge graph entity and relation types, running agents, suggested
questions, terminology, theming) is set up *by the application* when a knowledge box is initiated,
then exposed in-app for administrators to manage.

First two tenants:
- **GRDC** - Grains Research and Development Corporation (grains R&D).
- **FRDC** - Fisheries Research and Development Corporation (fisheries and aquaculture R&D).

## 2. Primary user & their job-to-be-done
The **typical research person at an organisation like FRDC or GRDC**: arrives with a question or
a topic, needs fast, cited, trustworthy answers, and then explores the underlying reports,
projects and relationships. A secondary persona is the **knowledge administrator** who provisions
and manages a tenant (corpus, labels, graph config, agents) from inside the application.

## 3. Hero experience (the "wow")
Benchmark: the demo that won the deal - https://frdc-6xdp.bolt.host/ ("FRDC Knowledge Hub").
We need **feature parity plus whatever it takes to be world-class** (see
`docs/PARITY.md` for the full feature inventory of that demo).

Two heroes, one per persona:
- **For the researcher:** ask a question anywhere and watch a beautifully streamed, cited answer
  build, with per-source confidence, matched passages, key takeaways and one click from any
  citation to the exact source passage.
- **For the buyer/administrator:** the provisioning moment - hand the app a blank knowledge box
  and a domain brief, and watch it configure a complete, branded research portal (corpus, graph,
  labels, agents, questions) in front of you. No other demo does this.

## 4. Stack
**React + TypeScript + Vite front end, thin typed Fastify API server** (confirmed 2026-08-21).
The AI/retrieval layer lives behind a clean `RetrievalProvider` interface on the server; the
Progress Agentic RAG wiring is configuration, not code spread through the UI. No LLM or vector
store is hardcoded into components.

## 5. Sample corpus for the build
**Small real sample corpora for each of the two tenants** - a starter set of genuine public GRDC
and FRDC research reports (final reports, reviews, briefings) seeded by the provisioning engine.
Real data goes in for actual testing once the portal stands up; the corpus grows through the
in-app admin surface, not by hand.

---

## Decisions log
- **2026-08-21** - All five decisions locked with Jay (this document). Key reframe from the
  original scaffold: the portal is **multi-tenant and self-provisioning** against blank knowledge
  boxes, not a single-domain build. GRDC and FRDC are tenants one and two.
- **2026-08-21** - Hero benchmark set: feature parity with https://frdc-6xdp.bolt.host/ plus
  world-class over-delivery; parity inventory captured in `docs/PARITY.md`.
- **2026-08-21** - Stack confirmed: React + TS + Vite + Fastify, retrieval behind a provider
  interface.
- **2026-08-21** - Jay's directive: **nothing faked, ever**. No mock provider, no mock mode -
  the portal points at real knowledge boxes through the Progress Agentic RAG API from day one;
  sample content is real documents uploaded into those knowledge boxes. Test doubles live only
  inside test files.
- **2026-08-21** - Operating model: Fable is product owner and orchestrator (project default
  model), delegating implementation to subagents with the model matched to the job.
- **2026-08-21** - Toolchain: this machine deliberately blocks the npm registry (hosts-level
  "NPM BLOCK"), so the build is registry-free - Deno 2 + Hono (JSR) + esbuild/Tailwind
  standalone (brew) + React/Zod via esm.sh import maps. Same product, same architecture.
- **2026-08-21** - Deployment decision (Jay): when the app is deployed, **Jay personally
  connects the two knowledge boxes** through the in-app admin "connect knowledge box" flow -
  bindings are not baked into the deploy. Local dev keeps `.env` bindings from the provision
  script.
- **2026-08-21** - Scope direction (Jay): the bar is **every Progress Agentic RAG feature**,
  with the factory reference app (`research-portal-arag.fly.dev`, source local in the GTM
  factory's reference-repos) as merely the starting point. Near-term admin roadmap, in order:
  (1) set up/create + connect knowledge boxes inside the app, (2) upload resources into a
  knowledge box from inside the app, (3) **migrate resources from one knowledge box to
  another** as an admin tool.
- **2026-08-22** - Jay approved the full "world-class while ARAG-only" roadmap ("all of it."):
  ask analytics + knowledge-gap dashboard (app-side insights log; the platform's activity
  endpoints are 403 to service-account tokens), answer feedback into the platform learning
  loop, self-healing deep re-answers, deep-research prequeries, federated ask across the whole
  estate, "interpreted as" rephrasing, multi-document summaries, image/table grounding toggle,
  hidden-resource draft/publish curation, scheduled source re-syncs (one Fly machine now stays
  up for the daily job), entity dossier pages, server-synced research trails with export,
  saved searches with change badges, and the conversation-memory DA agent.
- **2026-08-28** - Operating model (Jay): Claude acts as SVP of Product - product and engineering
  roll up to it, implementation is delegated to model-matched subagents (Haiku mechanical, Sonnet
  spec-driven, Opus/Fable judgment-heavy).
- **2026-08-28** - **The portal becomes an open-source project.** Positioning locked by Jay: the
  portal is a thin application layer that can be handed an *empty* Progress Agentic RAG knowledge
  box and provides all portal functionality on top of it. GRDC and FRDC are **real examples and
  live opportunities** - showcase tenants running real knowledge, used to drive adoption of the
  product immediately. (This supersedes the earlier open-source-audit suggestion of fictional
  tenant names: the showcases stay real; the corpus they run on must be genuinely real/cleared
  content, never synthetic content presented as theirs.)
- **2026-08-28** - Jay reviewed and agreed with the full state-of-the-nation program review
  (four audits, five-wave roadmap). Wave 0 (outage + credential exposure) executed same day:
  admin passcode rotated by Jay after `/api/admin-prefill` was found serving it publicly.
- **2026-08-28** - Launch mandate (Jay): drive all the way to the **v1.0 public open-source
  launch**; client feedback is to be simulated by optimised persona agents rather than waited on.
  As owner-of-record, Claude makes the delegated calls: **licence = Apache-2.0**; **route around
  the Progress sign-off blocker by removing the Progress-internal material from the public repo**
  (the unpatched-platform-bug notes and GTM framing are removed rather than published - if
  Progress later wants neutral integration notes public, that is a separate Progress decision);
  public repo ships from a **squashed history**. The single reserved human gate is the
  irreversible, outward-facing act of **making the repository public** - Claude prepares a
  complete launch candidate and Jay gives the one go that flips it.
- **2026-08-28** - Feedback model (Jay): the 0.x pilot feedback loop is **replaced by
  agent-simulated feedback** - a persona panel (research scientists per tenant, an adversarial
  reviewer, a skeptical technical-buyer/CIO, an accessibility auditor) roleplays client
  evaluation each iteration, and their findings drive the next build. This compresses the pilot
  era into an agent-speed loop and feeds straight into the v1.0 launch candidate. Real client
  feedback is welcome but not on the critical path.
- **2026-08-28** - Trust-through-transparency directive (Jay): maximise accuracy via ARAG's
  advanced retrieval configurations AND make confidence fully transparent, so a low-confidence
  answer is clearly communicated rather than presented as authoritative. Two workstreams:
  (1) Accuracy - add a reranking pass and an accuracy-measurement harness over dozens of real
  scientist questions, tuning retrieval configs (rag_strategies, search configurations, reranker)
  against measured results, not assertion. Current ask already uses neighbouring_paragraphs,
  graph_beta, full_resource (deep), prequeries, image/table strategies and REMi. (2) Transparency
  - promote the REMi trust signal from coloured meters to an explicit per-answer confidence state
  with an unmissable plain-language low-confidence warning ("treat as a lead, verify against the
  cited sources"); never present a weak answer as authoritative. The acceptance sweep reports the
  confidence distribution. Sequenced after the in-flight FRDC punch-list to avoid conflicts.
- **2026-08-28** - Handover quality bar (Jay): "I can't have anything not working when I hand it
  over." Hard gate before any client handover: a **full functional acceptance sweep** - every
  user-facing feature and endpoint exercised against the real FRDC corpus, scored pass/fail,
  all green. Distinct from factual accuracy of AI answers, which is inherently probabilistic:
  the guarantee there is no fabrication (grounding gates), every citation resolves to a real
  openable source, and honest refusal over bluffing - measured with a scored rubric across
  dozens of scientist questions, not claimed as infallible. The acceptance sweep runs AFTER the
  in-flight fixes land, so it tests the fixed portal, and its green result is part of the go.
- **2026-08-28** - Design directive (Jay): the portal must not look "vibe coded" - no generic
  AI-generated design tells. A judgment-tier design-craft pass joins the roadmap: considered
  typography and spacing, distinct per-tenant identity, purposeful motion, nothing templated.
- **2026-08-28** - Delivery directive (Jay): number one goal is handover to the client (FRDC +
  GRDC, who have both seen the bolt reference) **today**. Bolt parity is the delivery baseline.
- **2026-08-28** - Platform directive (Jay): exploit Progress Agentic RAG to the fullest -
  anything it can do, the portal should use it for. For state that cannot or should not live in
  the knowledge box, use **SQLite** for basic administration data. This supersedes the earlier
  "no SQLite" persistence rule (JSON-on-volume stays only until the migration lands, scheduled
  immediately after today's handover - not before, to protect the deadline). Deno 2's built-in
  node:sqlite keeps this registry-free.
- **2026-08-28** - Parity direction (Jay): the bolt demo's feature set is to be netted out and
  folded into the short-term roadmap. This settles the open question from the product audit:
  the **search-page cited AI answer returns** (AI Answer panel, resources/cited header,
  Resources-Citations toggle, Cited badges), alongside the PDF reader, Self Assessment route,
  and the parity tail (rotating questions, see-all rows, command palette, floating chat button,
  language picker, agentic event rail).
- **2026-08-28** - MVP acceptance (Jay): Jay personally tests the portal at MVP, supported by
  release notes / "what's been done" presentation. A user-facing "What's new" release-notes
  surface becomes part of the portal itself (roadmap Wave 3).
- **2026-08-23** - External expert audit received (research-portal expert +
  research-scientist walkthrough of the FRDC portal). Verdict: AI plumbing
  ahead of peers; blocked from professional use by corpus corruption
  (bot-challenge pages cited as sources), answer-level-only citations, and
  the absence of a research workspace. Response in progress, following the
  audit's own priority order: corpus purge + ingestion quality gate, real
  research documents ingested (13 NCCP final reports, the R&D Plan 2025-30),
  calibrated search scores + working mode switch, claim-level citation
  prompting, structured refusal states, persistent evidence tables replacing
  the ephemeral journey verdicts, and Investigations - a first-class research
  question that accumulates Evidence with provenance.
