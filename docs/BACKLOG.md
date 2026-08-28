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
- Merchandising data-augmentation agent (Jay, high value): a DA generator agent configured in
  Management with a JSON schema that writes per-resource "merchandising" fields, so cards show a
  real title + summary + scannable fields instead of the raw filename (1981-071-DLD.pdf). Schema:
  clean title, one-line hook, summary, 3 key takeaways, a standout statistic, year/authors/org,
  species/region/method tags, doc-type, read length. Then display them on Explore/Library/Search
  cards and the resource page. PLATFORM RISK: ARAG-DEV.md records the json-output DA generator is
  buggy (422s) - verify the working path first, do not assume. Starts right after the resource-
  page redesign lands (shares provider toSummary + card code - sequenced to avoid conflicts).

- User documentation stored in a knowledge box + a dedicated help chatbot scoped ONLY to the
  docs, excluded from all normal search/ask. QUEUED - separate help KB approach.

## Standing
- GRDC real content: Jay is loading it. FRDC is the demo hero.
- Full functional acceptance sweep across every feature on the real FRDC corpus before handover.
- Everything runs through the persona test gate before it ships.
