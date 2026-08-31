# Live backlog - Jay's requests (2026-08-28 delivery session)

Owner-tracked so nothing drops. Status: DONE (live) | MERGED (deploying) | IN BUILD | QUEUED.

## SHIP SCOPE (frozen 2026-08-28) - complete ALL of this, then ship. No new features.
Done + verified: passcode; GRDC purge; assessment fix; logo header; generate chips; search
Find/Ask; graph full-screen redesign; stat-tile + menu-bleed light-mode fixes; cache-busting;
resource-page layout (title top, viewer hero, sticky rail); explore topics; confidence
transparency; reranker + accuracy baseline; box config (FRDC + GRDC); persona test gate.
Remaining to complete before ship:
1. Merchandising / default enrichment - real title+summary+key-takeaways everywhere (cards +
   resource page + recommendations), the generator agent + JSON schema visible in Management,
   read back the already-generated da-pagesummary + synthetic questions. (IN BUILD)
2. Large-screen responsive pass - use the full width on 2xl+; no stranded columns. (QUEUED)
3. OCR / visual extract strategy + re-ingest the scanned PDFs (corpus quality). (QUEUED)
4. Documentation section - authored docs pages, ingested + labelled "documentation", a docs link
   in the header, AI search/answer scoped to docs via label-isolated stored search configs
   (portal-doc-*), research configs exclude the documentation label. (QUEUED)
5. Theme toggle - verify/fix (light/dark did not visibly switch in a spot check). (QUEUED)
6. FULL FUNCTIONAL ACCEPTANCE SWEEP - every feature on the real FRDC corpus, green, VISUALLY
   verified by the orchestrator in light+dark, wide+390px. + answer-accuracy scorecard. This is
   the ship gate. (QUEUED)
ROADMAP (v2, NOT this ship): custom enrichment lenses / schema chooser; memory-agent into ask;
graph shortest-path; page-image/table grounding; anything new.

## Done / live
- Admin passcode set to `abc123` on production. DONE.
- Explore topic rows now read the box label index (topics populate). MERGED/live.
- Answer confidence transparency (per-answer state + low-confidence banner). Live.
- Semantic reranker pinned + accuracy-measurement harness; baseline captured. Live.
- FRDC box best-practice config; KG/label/classify agents applied to existing corpus (graph now populating). DONE.
- Both boxes have search configurations with reranker. DONE.
- Assessment quiz options were unreadable (missing text colour). FIXED. MERGED/deploying.

## In build (agents running)
- Graph page: full-screen + more intuitive and useful (redesign). IN BUILD.
- Generate page: suggested topic chips per artefact type. IN BUILD.
- Search page: support pure search (no answer) vs search-with-answer; optimise the page for its
  real value. IN BUILD.

## Merged, needs live action
- GRDC purge-failed endpoint. MERGED/deploying. NEXT: dry-run on gdrc, confirm count, execute.

## Queued (larger)
- Merchandising / ENRICHMENTS (Jay, high value, expanded 2026-08-28): a DA generator agent with a
  JSON schema writes structured JSON onto each resource; the app renders that schema PROGRAMMATICALLY
  (whatever fields the schema defines), replacing raw filenames (1981-071-DLD.pdf) with a real
  title + summary + scannable fields on cards and the resource page.
  - **Default research schema** (generic, ships by default): title, summary, key takeaways, quotes
    of interest - a good default that provides the initial resource summary.
  - **Enrichments model:** resources carry one or more "enrichments", each = a DA agent + schema +
    generated JSON, shown as enrichments in the UI. The default schema is the FIRST enrichment.
  - Users can **choose a different schema** for the default summary, and **create additional DA
    generation agents** (in Management) to add specific "lenses" on resources - each appears as a
    further enrichment. Display each enrichment programmatically from its schema.
  - PLATFORM RISK: ARAG-DEV.md records the json-output DA generator is buggy (422s) - verify the
    working path first, do not assume. Starts right after the resource-page work lands (shares
    provider toSummary + card code).

- User documentation stored in a knowledge box + a dedicated help chatbot scoped ONLY to the
  docs, excluded from all normal search/ask. QUEUED - separate help KB approach.

## ARAG exploitation roadmap (from the 2026-08-28 capability audit)
We already use: reranker, answer_json_schema, REMi, citations, rag_strategies (neighbouring,
full_resource, graph_beta, prequeries), labellers + classifier + graph + summaries + question-gen
+ memory agents, hidden-resources, KB/token provisioning. Top UNEXPLOITED, ranked by value:
1. **OCR / visual extract strategy on the scanned-PDF corpus (HIGHEST VALUE).** Uploads send no
   `X-Extract-Strategy`; scanned/image PDFs extract thin/empty text, starving search/ask/REMi/
   labels/graph. Register a visual/OCR (and table-aware) extract strategy and re-ingest the
   thin/challenge resources. Unlocks page-image/table grounding too. Needs a corpus re-ingest.
2. **Documentation-label isolation via stored search configs** (the CLAUDE.md directive) - not yet
   implemented; add `filter_expression` to portal-search/ask excluding `documentation`, add
   portal-doc-search/ask including only it, plus the server-side citation-vs-filter cross-check.
3. **Read back DA enrichments already generated** - the pagesummary DA summary and synthetic
   questions are written per resource but never read (toSummary reads metadata.summary, not
   `da-pagesummary-f-*`). Free merchandised summaries + real per-doc "people also ask". (Fed into
   the merchandising work.)
4. Page-image + `tables` grounding once OCR lands. 5. Wire the memory agent into /ask or drop it.
   6. Graph shortest-path "how is X connected to Y" explainer.

## Idea bank (post-v1)
- **Extraction Accuracy Lab (Jay, 2026-08-31, HIGH VALUE).** Let a user upload document(s), run
  them through several extraction strategies / vision models, and see a side-by-side comparison of
  ingestion accuracy (chars/page yield, structure/table fidelity, a quality score, cost, latency)
  so they can choose the right strategy before committing to a full ingest. Productises the manual
  extraction bake-off from this build. ARAG already has named extract strategies + the model
  catalogue (`GET /kb/{id}/schema`); the work is putting it behind `RetrievalProvider`. Risks:
  test-upload isolation (scratch/sandbox KB), objective scoring (needs ground-truth or a
  model-judge), cost caps. Full writeup in `docs/HANDOVER.md` section 8.

## Standing
- GRDC real content: Jay is loading it. FRDC is the demo hero.
- Full functional acceptance sweep across every feature on the real FRDC corpus before handover.
- Everything runs through the persona test gate before it ships.
