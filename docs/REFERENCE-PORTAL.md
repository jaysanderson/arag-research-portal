# Reference portal extraction - proven ARAG call shapes

Mined 2026-08-21 from `/Users/jsanders/Claude/arag-gtm/reference-repos/research-portal`
(deployed: research-portal-arag.fly.dev; React+Vite SPA + one Express proxy in
`server/index.mjs`). Use these WORKING shapes when building features; complements
`ARAG-DEV.md`. Golden rule preserved in our port: the browser never holds a KB key -
every call proxies through our server.

## KB stats (dashboard)
`GET {kb}/counters` -> `{ resources, paragraphs, fields, sentences, index_size }`.
"Index MB" = round(index_size / 1e6). Also used as the connectivity probe (2 attempts,
15s timeout).

## Search
- `POST {kb}/find` body: `{ query, features: [keyword|semantic|both], page_size,
  show: ['basic','origin'], filters: ['/classification.labels/<labelset>/<label>', ...] }`.
  Flat label-path strings - the reference never uses `filter_expression`.
- Client-side polish: relevance floor MIN_SCORE=0.1 (honest empty states), near-duplicate
  suppression via 120-char first-paragraph signature (kills crawled nav/footer chrome).
- Facet counts: `GET {kb}/catalog?faceted=/classification.labels/<id>&page_size=0`
  (repeat `faceted=` for batching) -> `data.fulltext.facets` map; display label = last
  path segment. Never count client-side.
- Library list: `GET {kb}/catalog?page_number&page_size&show=basic&show=origin&show=values
  &query&filters&sort_field=created|modified|title&sort_order` -> `resources` +
  `fulltext.total`.

## Streaming /ask
- Body: `{ query, features, citations: true, show: ['basic','origin'],
  prompt: { system }, filters?, context?: [{author:'USER'|'AGENT', text}],
  resource_filters?: ['<rid>'] }` with `Accept: application/x-ndjson`.
- Set `X-SHOW-CONSUMPTION: true` on the upstream request to receive the `metadata` item
  (tokens + timings).
- System prompt override needed - Nuclia's default guardrail answers "Not enough data to
  answer this." even with good retrieval. Reference ships an analyst-persona system prompt
  plus a client regex filter for that exact refusal string.
- NDJSON items: `answer {text}` (delta), `retrieval {results.resources}` (build
  rid->title/url map), `citations {"<rid>/<field_type>/<field>/<range>": [[start,end]..]}`,
  `status`, `metadata {tokens:{input,output}, timings:{generative_first_chunk,
  generative_total}}`, `answer_json {object}`.
- Citation numbering: number sources by FIRST APPEARANCE order in the citations map;
  marks placed at each range's END char offset into the answer; splice sentinels from
  highest offset down, then render as superscript anchors.
- Multi-turn: `/ask` takes `context` with authors `USER`/`AGent` (uppercase); the
  Retrieval Agent endpoint instead takes `user_context` - conflating the two fields is
  the likely source of the 422-on-author bug seen live.
- Retry: up to 3 attempts, 700ms*attempt backoff, ONLY for 412/5xx before any text has
  streamed.
- Footgun: never send `generative_model: ""` - omit the field to use the KB default.

## Ingestion
- File upload: single-call `POST {kb}/upload`, raw bytes body, original Content-Type,
  filename base64-encoded in `X-FILENAME` header. Then PATCH
  `{kb}/resource/{uuid}` `{usermetadata:{classifications:[...]}}` for labels.
  (Two-step create+PUT-file 500s on PDFs - also in ARAG-DEV.md.)
- Link resource: `POST {kb}/resources` `{ title, icon: 'application/stf-link',
  origin: {url}, links: {link: {uri}}, usermetadata? }` - platform crawls/extracts async.
- Text: `POST {kb}/resources` `{ title, icon: 'text/plain',
  texts: {text: {body, format: 'PLAIN'|'MARKDOWN'}}, usermetadata? }`.
- Site crawl is APP-side: fetch sitemap.xml (`<loc>` extraction, one level of index
  expansion) or same-origin `<a href>` scrape with asset/query filtering; user reviews the
  URL list; then one link-resource per URL.
- Status polling: no dedicated endpoint - re-list `/catalog` (size 12, created desc,
  show=basic) every 4s while any `metadata.status === 'PENDING'`; PROCESSED renders as
  "Indexed".

## Taxonomy
- List: `GET {kb}/labelsets` -> `{labelsets: {id: {title, color, multiple, labels}}}`.
- Create: `POST {kb}/labelset/{id}` `{ title, color, multiple, kind: ['RESOURCES'],
  labels: [{title}] }`; id = slugified title.
- Counts: the catalog faceted call above.

## Knowledge graph (reference's version)
NOT the native entity graph - built from label co-occurrence: primary facet counts, then
one filtered facet call per primary label for secondary counts (N+1 catalog calls);
nodes = labels weighted by count, edges = co-occurrence. D3 force layout. A real
entity/relation graph must be built fresh (our tenants carry entityTypes/relationTypes
for exactly that).

## Agentic
- Real Retrieval Agent: `POST {dp-host}/agent/{agentId}/session/ephemeral` body
  `{question, user_context?}` NDJSON stream: `operation: 2|3`, `step {module,title,value}`,
  `context {id, question, chunks:[{chunk_id,title,source,text,score}]}`,
  `streaming_response_chunk`, `answer`, `answer_citations {metadata}`, `exception`.
  Stage/module classification in the reference is client-side regex on step titles.
  NOTE ARAG-DEV.md: `/session/ephemeral` is BROKEN upstream (TaskGroup error) as of Aug 2026.
- Fallback "KB-pipeline" mode: reinterpret the plain `/ask` stream into stages
  (retrieval item -> Retrieve, first answer -> Generate, status -> Validate) with real
  token/timing telemetry from `metadata`. One driver, honestly disclosed.
- REMi: defined in the reference UI but NEVER populated - no working consumption example;
  wire it fresh via `POST {kb}/predict/remi` (see ARAG-DEV.md: score against FULL
  retrieved context).

## Structured generation (Generate)
- `POST {kb}/ask` with `answer_json_schema: {name, description, parameters}` +
  `max_tokens: 4096`, NO `citations` (crashes together - both docs agree), NO system
  prompt. Result arrives as `answer_json` item; sources reconstructed from the
  `retrieval` item (dedupe, cap 12).
- Default max_tokens cap causes 412 "Error generating json: max_tokens" on big payloads -
  always set 4096.
- Strict schema form: every object node needs `additionalProperties: false` and ALL
  properties in `required` (some KB models enforce, strict form works on all).
- Only three schemas exist in the reference: comparison_matrix, research_briefing,
  assessment_quiz. Timeline/Pros&cons/FAQ were never built - author fresh.

## Multi-KB management
- Env-configured KBs (keys server-side) + BYO-key KBs (localStorage, forwarded per-request
  as headers, proxy still makes the upstream call).
- SSRF guard: proxy rejects KB hosts not matching `*.rag.progress.cloud`,
  `*.dp.progress.cloud`, `*.nuclia.cloud`, `progress.cloud`.
- `cleanKey()`: strip quotes/whitespace/accidental "Bearer " prefix from pasted keys -
  otherwise surfaces as an opaque "JWT decoding error".
- Probe errors mapped to human guidance: 401/403/jwt-ish -> "check it's the full
  service-account key (no Bearer prefix or quotes) and the region matches"; 404 -> "check
  the URL ends with /api/v1/kb/<id>".
- Soft disconnect/reconnect for env KBs persisted to a JSON file on the volume.
- HARD-WON: per-KB responses selected by HEADER (not URL) got cross-KB cache-poisoned by
  shared HTTP caches - always `cache: 'no-store'` on such fetches. (Our design keys KB by
  URL path `/t/:slug/...`, which avoids this class.)

## Misc hard-won
- Friendly error map: 401/403 access denied; 404 not found; 412/422/400 +
  /token|json|max_tokens/ -> "request too large to generate"; 429 rate limit; 5xx
  temporarily unavailable.
- Extracted text read: `?show=basic&show=origin&show=values&show=extracted&show=extra
  &extracted=text&extracted=metadata`; walk `data.{texts,links,files,conversations}[f]
  .extracted.text.text`, fall back to `value.body` while still processing.
- Strip markdown fragments (`toPlainText`) and web boilerplate (cookie/nav/footer regex
  denylist on short lines) before rendering snippets.
- Sanitise any HTML rendered from extracted content (script/iframe/on*/javascript: etc.);
  `target=_blank rel=noopener noreferrer nofollow` on links.
- Media elements can't send auth headers - proxy media by URL-selected KB, or fetch to
  Blob/ObjectURL when the key can't ride a URL.
- Reader-vs-writer key: several POST endpoints are semantically reads (find/ask/search/
  catalog/suggest/feedback) - if split keys are used, route them to the reader key.
