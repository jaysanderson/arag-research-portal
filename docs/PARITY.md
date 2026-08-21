# Feature parity baselines

Two reference apps set the floor. Every feature must exist in the portal (generalised to any
tenant), executed to a higher standard.

## Baseline B - the factory reference Research Portal (reviewed live 2026-08-21)

Source: https://research-portal-arag.fly.dev - source code is LOCAL at
`/Users/jsanders/Claude/arag-gtm/reference-repos/research-portal` (mine it for working ARAG
call shapes; do not reinvent). What it does:

1. **Dashboard** - live KB stats (resources, paragraphs, sentences, index MB), topic chips,
   get-started cards.
2. **Knowledge box switcher** - multiple KBs connected at once, switch active KB, "Add
   Knowledge Box" in-app. (Ours maps this to tenants + the admin screen.)
3. **Add content** - upload files (PDF/Word/PPT/text/images/audio/video), add links, paste
   text, crawl a site; "Add a theme" seeds a topic by retrieving fresh resources; recent
   additions list with per-item processing status ("Indexed").
4. **Taxonomy** - label categories with per-label counts; add new categories in-app.
5. **Search** - modes (Hybrid/Semantic/Keyword), content filters (Scanned OCR, Tables,
   Transcripts), answer language picker, saved searches, image search, faceted filters with
   counts (from taxonomy), cited AI answer alongside ranked results.
6. **Library** - sort options, type filter, full faceted filtering, label-badged cards.
7. **Assistant** - streaming chat, numbered inline citations mapped to a sources list, copy +
   listen actions, multi-turn. (Live bug seen: 422 on multi-turn context author enum - ours
   must handle context correctly.)
8. **Agentic** - multi-step retrieval with visible pipeline/reasoning trace, live REMi
   scoring, trace history (sources count, tokens, seconds).
9. **Generate** - schema-enforced artifacts grounded in the KB: Comparison, Briefing,
   Timeline, Pros & cons, FAQ, Assessment.
10. **Knowledge graph** - entity/relation explorer: search a concept, neighbourhood view,
    click-to-recentre.
11. **⌘K** global search-or-ask.

Ours adds on top: multi-tenant white-labelled portals from TenantConfig, own-system framing,
demo-vs-connected binding model, passcode-gated admin screen, registry-free toolchain.

## Baseline A - the demo that won the deal

Source: https://frdc-6xdp.bolt.host/ ("FRDC Knowledge Hub"), reviewed in-browser 2026-08-21.

## 1. Dashboard (home / explore)
- Full-bleed hero: "What would you like to explore?" with a single large search box.
- AI-generated suggested questions appear under the hero (domain-specific, rotating).
- Netflix-style topic rows (e.g. "Fisheries stock assessment", "Aquaculture biosecurity",
  "Post-harvest innovation", "Marine sustainability", "Fisheries management policy"), each with
  "See all" and horizontally scrolling document cards.
- Document cards: real thumbnail, PDF/Video type badge, title, 2-3 line summary.

## 2. Search results (the ask experience)
- **AI Answer** panel: streamed answer with numbered inline citations, "N sources cited".
- Results header: "5 resources · 2 cited"; toggle between **Resources** and **Citations** views.
- Result cards carry: "Cited N" badge, type badge, thumbnail, **curated summary**,
  **confidence / relevance %** meter, **key takeaways** (numbered), and a **matched passage**
  quote from the document.
- **People also ask**: follow-on questions generated from the corpus.

## 3. Research (assistant with sessions)
- Persistent research **sessions** in a sidebar (title, message count, age).
- "New Research Session" + suggested research questions list.
- **Research Mode** toggle: "responses include comprehensive multi-source analysis with extended
  citations".
- Assistant header with status ("Live", "Full Access") and a **Sources** panel.

## 4. Knowledge (member library)
- "Knowledge Explorer": search within library, **All Topics / All Types / sort** filters,
  resource counts by type ("10 resources | 2 videos | 8 documents").
- Cards show curated summary plus 2 key facts each.
- **Document detail**: inline PDF viewer (page nav, zoom, fit, print, download, open), keyboard
  navigation, and a per-resource **AI Chat** panel ("Ask questions about this resource") with
  suggested questions and answer-language selection (English/Spanish/French/German/Mandarin/
  Japanese).

## 5. Graph (knowledge graph)
- Entity sidebar grouped by type - in FRDC's case: **Species, Researcher, FRDC Project,
  Pathogen, Location** (must be tenant-configurable in ours).
- Entity search, **Entity Types** and **Relations** filters.
- Force-directed graph of the whole estate; select an entity (sidebar or canvas) to view its
  relationships in a detail panel.

## 6. Agentic Retrieval (beta)
- "Ask anything across your knowledge estate" - agent searches every driver (Knowledge Box, web,
  MCP endpoints) and returns a cited, scored answer auditable end-to-end.
- **Memory** switch: Persistent / Ephemeral.
- Right rail: status (IDLE, elapsed ms, steps, sources), **Stages** pipeline (Preprocessing,
  Retrieval, Generating, Validating) with timings, **Live event feed**, **Sources** list.
- Rich cross-corpus example prompts; ⌘K switcher.

## 7. Self Assessment (/certification)
- "Industry Knowledge Areas" cards.
- "Build Your Assessment": pick knowledge area, question count (3/5/10), depth (Foundational /
  Intermediate / Advanced), then take a generated knowledge check.

## Cross-cutting
- Branding in the demo is "Progress Agentic RAG - Sample API Application Only - FRDC". Ours
  inverts this: **own-system framing**, tenant brand first (per CLAUDE.md), vendor reveal kept
  for the solution-architecture view.
- Floating "Open AI chat" button on browse pages.
- Everything is real corpus content - no lorem ipsum anywhere.

## Known gaps in the demo (our over-delivery starts here)
- Single-tenant, hardcoded to FRDC; no provisioning, no admin surfaces.
- No visible trust/quality signal per answer (REMi) beyond a confidence %.
- Some sections load slowly with skeletons that sit empty (certification areas).
- No export/share of an answer or research session as a cited note.
- Unknown mobile/accessibility standard - ours must hit 390 px and WCAG AA.
