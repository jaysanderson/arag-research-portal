# Live backlog - Jay's requests (2026-08-28 delivery session)

Owner-tracked so nothing drops. Status: DONE (live) | MERGED (deploying) | IN BUILD | QUEUED.

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

## Standing
- GRDC real content: Jay is loading it. FRDC is the demo hero.
- Full functional acceptance sweep across every feature on the real FRDC corpus before handover.
- Everything runs through the persona test gate before it ships.
