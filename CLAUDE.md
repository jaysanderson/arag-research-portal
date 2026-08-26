# Research Portal - world-class reference application

## What this is
A **world-class research portal**: a web application where a user explores a body of
research/knowledge and gets fast, credible, beautifully-designed answers and discovery. It is
built as a **reference application** - the standard other teams point to, not a prototype.

## The end goal (read this - it shapes every decision)
Once this is world-class, it is handed to the Progress Agentic RAG (ARAG) GTM factory and turned
into a **live sales & marketing asset** - a demo the field and prospects can use. So build it:
- **Credible in front of a CIO / technical buyer** - nothing that looks like a toy.
- **ARAG-ready** - keep the retrieval/answer/AI layer behind a **clean interface** so wiring it to
  Progress Agentic RAG later (grounded + cited answers, a knowledge graph, per-answer quality
  signals) is a config change, not a rewrite. Do NOT hardcode a specific LLM or vector store into
  the UI or the components.
- **Own-system framing** - it is "the research portal," a product in its own right, not an "AI
  demo." When it becomes a demo, AI/vendor branding stays out of the default customer-facing view.

## The bar: what "world-class" means here
- **Design & UX**: genuinely excellent - considered typography, spacing, motion, and real
  empty/loading/error states; responsive to mobile (test at 390px); accessible (WCAG AA). The kind
  of interface people screenshot.
- **Performance**: fast first paint, streamed answers, no jank; works on a throttled connection.
- **Content credibility**: real, cited sources; never a bare unattributed answer.
- **Code quality**: typed, tested, readable; no dead scaffolding; production-grade.
- **Discovery, not just search**: browse, filter, related-work, a knowledge graph/map - a portal
  you *explore*, not just a search box.

## Lock these decisions with Jay FIRST (before building features)
This scaffold is deliberately empty on these - do not assume them:
1. **Domain / corpus** - what research? (scientific papers, internal R&D, industry reports, a
   specific vertical?) This drives everything.
2. **Primary user & their job** - a researcher, an analyst, an exec? What do they come to do?
3. **Hero experience** - the one thing that makes it world-class (the "wow" moment).
4. **Stack** - recommended default: a modern typed web app (React + TypeScript + Vite front end,
   a thin typed API server) unless Jay prefers otherwise. Keep the AI/retrieval layer behind an
   interface either way.
5. **Sample corpus** - a real set of documents to build against (even 50-100 real docs beats
   lorem ipsum, and makes the eventual ARAG wiring realistic).

Capture the answers in `docs/VISION.md` as they're decided.

## First task for this session
1. Read this CLAUDE.md and anything already in the repo, then produce an **assessment**: current
   state, the gaps to the world-class bar above, and a proposed plan - before writing code.
2. Run the "lock these decisions" conversation with Jay; get the five answers.
3. Propose the architecture (AI/retrieval layer cleanly abstracted for later ARAG wiring), then
   build in small, reviewable increments.

## Conventions
- Small, typed, tested increments; a render/lint/test loop before calling anything done.
- Real content over placeholders; real empty/error/loading states, not blank divs.
- Australian English, no em dashes (spaced hyphen) in any user-facing copy - this becomes a
  Progress asset.
- Work on a branch; don't commit to main without asking. Secrets live in `.env` only (gitignored).
- **Deployment order is local -> repo -> fly.io, always.** Never run `fly deploy`
  from a developer machine. Commit, push to `origin/scaffold`, and the GitHub
  Actions pipeline gates (typecheck, lint, format, tests, build) then deploys.
  A push that fails the gate never reaches production.

## Model & orchestration
Default is **`fable`** (set in `.claude/settings.json`). Fable acts as **product owner and
orchestrator**: it owns product decisions, contracts (schemas, interfaces, API shape) and review,
and delegates well-specified implementation to subagents with the model matched to the job -
Sonnet for spec-driven implementation, Opus/Fable for judgment-heavy passes (architecture, the
design system, the world-class polish), Haiku only for trivial mechanical sweeps.

## Developing on Progress Agentic RAG - READ FIRST
This portal provisions and configures ARAG knowledge boxes, so you are developing on Progress
Agentic RAG from day one, not "later". **`docs/ARAG-DEV.md` is the hard-won reference** - the
working call shapes, the credential model (which token for which call - most 403s are a
wrong-token bug), the provisioning recipe, and every KNOWN PLATFORM BUG (the `json:true` DA
generator and the RAO `/session/ephemeral` agent-session are both broken - don't burn cycles
rediscovering them). Read it before writing any retrieval or provisioning code, and put ARAG
behind the `RetrievalProvider` interface so a stub covers local dev. When you hit something it
doesn't cover, ask Jay to relay the question to the ARAG factory session rather than probing the
live platform blindly.

## Handoff back to the ARAG factory (later)
When this is ready to become a live demo, it returns to the Progress Agentic RAG factory, where it
must additionally meet that factory's demo standards (grounded/cited answers via ARAG, a REMi
trust signal, own-system framing, synthetic/cleared content, a solution-architecture reveal, a
30-second reset). Building ARAG-ready now (point 2 above) makes that handoff a wiring exercise, not
a rebuild.
