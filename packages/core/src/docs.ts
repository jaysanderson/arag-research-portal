/**
 * In-app user documentation for the research portal.
 *
 * The documentation is authored here as a typed content module (rather than
 * loose Markdown files) so a single source of truth is importable by BOTH the
 * web front end (which renders the help section) and the API (which ingests the
 * pages into the knowledge box as retrievable resources). Registry-free Deno +
 * esbuild bundles a TypeScript module cleanly into the web app with no file-
 * system reads at runtime, which a Markdown-directory approach could not do.
 *
 * ISOLATION CONTRACT (see packages/retrieval/CLAUDE.md): every documentation
 * resource is labelled with `DOCUMENTATION_LABEL` under `DOCUMENTATION_LABELSET`
 * and carries an origin URL of `docResourceOrigin(page.id)`. The research search
 * configurations exclude that label; the documentation-scoped configurations
 * include only it. The server-side cross-check that guarantees isolation even if
 * the platform's stored `filter_expression` misbehaves keys off BOTH the label
 * and this origin prefix - so keep them in lockstep with the provider.
 */

/** Reserved labelset + label that isolate documentation from research content. */
export const DOCUMENTATION_LABELSET = 'content-type'
export const DOCUMENTATION_LABEL = 'documentation'

/**
 * Origin-URL scheme stamped on every ingested documentation resource. A stable,
 * app-controlled marker the retrieval cross-check can trust even when the box's
 * classification labels are not returned on a retrieval payload (the label is
 * the primary signal; this is the deterministic belt-and-braces one).
 */
export const DOC_ORIGIN_PREFIX = 'portal-doc:'

/** The stable resource slug for a documentation page in the knowledge box. */
export function docResourceSlug(pageId: string): string {
  return `doc-${pageId}`
}

/** The origin URL stamped on a documentation resource (see DOC_ORIGIN_PREFIX). */
export function docResourceOrigin(pageId: string): string {
  return `${DOC_ORIGIN_PREFIX}${pageId}`
}

/** Whether an origin URL identifies a portal documentation resource. */
export function isDocOrigin(url: string | undefined | null): boolean {
  return typeof url === 'string' && url.startsWith(DOC_ORIGIN_PREFIX)
}

/** One heading-plus-body block within a documentation page. */
export interface DocSection {
  /** Section heading, rendered as an anchored sub-heading. */
  heading: string
  /**
   * Markdown-ish body. Supports paragraphs (blank-line separated), `### `
   * sub-headings, `- ` bullet lists, `1. ` numbered lists and `**bold**`.
   */
  body: string
}

/** A single documentation page - a stable id, a title and ordered sections. */
export interface DocPage {
  /** Stable slug used in the URL, the resource slug and cross-references. Never change it. */
  id: string
  /** Category the page files under in the table of contents. */
  category: string
  /** Page title. */
  title: string
  /** One-line summary shown under the title and in search results. */
  summary: string
  /** Ordered content sections. */
  sections: DocSection[]
}

/** Ordered categories - the top-level grouping in the documentation sidebar. */
export const DOC_CATEGORIES = [
  'Getting started',
  'Finding answers',
  'Exploring the corpus',
  'Working with the portal',
  'Administration',
] as const

export type DocCategory = (typeof DOC_CATEGORIES)[number]

// ---------------------------------------------------------------------------
// The documentation content. Kept accurate to the features that exist - each
// page maps to a real route/surface in apps/web/src/pages.
// ---------------------------------------------------------------------------

export const DOC_PAGES: DocPage[] = [
  {
    id: 'getting-started',
    category: 'Getting started',
    title: 'Getting started',
    summary: 'What the research portal is, how to choose a portal and find your way around.',
    sections: [
      {
        heading: 'What this is',
        body: 'The research portal is a fast, credible way to explore and question a body of ' +
          'research. You ask a question in plain language and get an answer that is grounded in ' +
          'real documents and cited back to them, then explore the underlying reports, projects ' +
          'and the relationships between them.\n\n' +
          'Every portal runs on its own knowledge box - the connected content estate for one ' +
          'organisation. What you can search, ask and browse is exactly the content in that box, ' +
          'nothing more and nothing invented.',
      },
      {
        heading: 'Choosing a portal',
        body: 'The landing page lists the portals available to you. Each card shows the ' +
          "organisation's name and branding. Select one to enter its research portal.\n\n" +
          'You can switch portals at any time from the switcher at the top left of the header. A ' +
          'portal marked **Demo only** is running on demonstration content; one marked **Not ' +
          'connected** has no knowledge box bound yet and an administrator needs to connect it ' +
          'before search and answers work.',
      },
      {
        heading: 'Finding your way around',
        body: 'The header navigation is the same on every portal:\n\n' +
          '- **Explore** - the home surface: a question box, suggested questions and topic rows.\n' +
          '- **Search** - find documents, or ask for a cited answer.\n' +
          '- **Library** - browse and filter the whole corpus.\n' +
          '- **Assistant** - a full conversational research assistant with saved sessions.\n' +
          '- **Investigations** - build up evidence around a research question over time.\n' +
          '- **Generate** - draft structured artefacts grounded in the corpus.\n' +
          '- **Assessment** - test your knowledge of the corpus.\n' +
          '- **Graph** - the knowledge graph of topics and how they connect.\n' +
          '- **Help** - this documentation, with its own scoped search.\n' +
          '- **Manage** - administration (connecting content, taxonomy, enrichments and health).\n\n' +
          'Press **Cmd/Ctrl+K** anywhere to open the command palette and jump straight to a ' +
          'search or a question. Use the theme toggle in the header to switch between light and ' +
          'dark.',
      },
    ],
  },
  {
    id: 'search',
    category: 'Finding answers',
    title: 'Search: Find versus Ask',
    summary: 'The two ways to search - retrieve documents (Find) or get a cited answer (Ask).',
    sections: [
      {
        heading: 'Two modes, one search box',
        body: 'Search gives you two distinct jobs from the same box:\n\n' +
          '- **Find** returns a ranked list of matching documents with the passage that matched, ' +
          'so you can go straight to the source.\n' +
          '- **Ask** returns a written, cited answer synthesised across the matching documents, ' +
          'with the sources it drew on listed beneath it.\n\n' +
          'Use **Find** when you want to locate documents and read them yourself. Use **Ask** ' +
          'when you want the portal to read across the corpus and answer the question for you.',
      },
      {
        heading: 'Relevance and honest ranking',
        body:
          'Each Find result shows a relevance score calibrated to a comparable 0 to 100 scale, ' +
          'so a weak match looks weak rather than being inflated to the top. Results below the ' +
          'noise floor are dropped, and an off-corpus query honestly returns no results rather ' +
          'than surfacing irrelevant hits.\n\n' +
          'Reference-list and bibliography matches are kept findable but never allowed to outrank ' +
          'real body text, and near-duplicate crawled pages are collapsed so you do not see the ' +
          'same content twice.',
      },
      {
        heading: 'Refining a search',
        body:
          'Filter by topic and by document kind to narrow a large result set. You can also change ' +
          'the retrieval mode between hybrid (the default, combining keyword and semantic ' +
          'matching), semantic only, or keyword only, when you want more precise control over how ' +
          'matching works.\n\n' +
          'Related questions appear alongside results when the corpus has suggested questions that ' +
          'genuinely overlap with what you searched.',
      },
    ],
  },
  {
    id: 'assistant',
    category: 'Finding answers',
    title: 'The research assistant',
    summary: 'Ask questions conversationally, keep sessions, and run deep research.',
    sections: [
      {
        heading: 'A grounded, cited conversation',
        body: 'The Assistant answers questions in plain language and grounds every answer in the ' +
          'corpus. As an answer streams in you see the stages it moves through - preparing the ' +
          'question, retrieving sources, generating and checking - then the finished answer with ' +
          'claim-level citations you can click straight through to the source passage.\n\n' +
          'Follow-up questions keep the context of the conversation, so you can drill in without ' +
          'restating everything each time.',
      },
      {
        heading: 'Sessions and your research trail',
        body:
          'Each conversation is saved as a session in the sidebar. Start a new session, rename ' +
          'one, or reopen an earlier one - your sessions sync so they follow you back. You can ' +
          '**Export** a session as a Word-compatible document to keep the whole research trail: ' +
          'questions, answers, sources and the quality scores.',
      },
      {
        heading: 'Deep research and self-healing answers',
        body: 'Turn on **Deep research** to have the portal first map the question into focused ' +
          'sub-questions, research each of them, and then answer with full-document grounding. ' +
          'It is slower but more thorough for broad or multi-part questions.\n\n' +
          'When an answer comes back thinly grounded, the assistant offers to re-answer it deeply ' +
          'against the full text of the matching documents. Evidence-seeking questions (about ' +
          'risk, safety, effects or comparisons) are decomposed automatically so decisive ' +
          'passages are not missed.',
      },
      {
        heading: 'Feedback and watches',
        body:
          'Mark an answer helpful or not - the rating feeds the platform learning loop. **Watch** ' +
          'a question to be flagged in Search when new results turn up for it later.',
      },
    ],
  },
  {
    id: 'trust-and-citations',
    category: 'Finding answers',
    title: 'Trust, citations and confidence',
    summary: 'How to read the confidence signals, citations and the evidence table.',
    sections: [
      {
        heading: 'Every answer is cited',
        body: 'The portal never gives a bare, unattributed answer. Each factual claim carries a ' +
          'bracketed citation marker like [1] that links to the exact source passage, and the ' +
          'sources are listed beneath the answer. Citation numbers are assigned by the ' +
          "application from the platform's own source attribution, so the number you click always " +
          'resolves to the passage that grounds that claim.',
      },
      {
        heading: 'The confidence signal',
        body:
          'Answers are scored for quality using the REMi trust signal across three dimensions - ' +
          'answer relevance, groundedness and context relevance. This is surfaced as an explicit ' +
          'per-answer confidence state, not just a coloured meter.\n\n' +
          'When an answer is weakly grounded you get an unmissable, plain-language warning to ' +
          'treat it as a lead and verify it against the cited sources. A weak answer is never ' +
          'presented as authoritative.',
      },
      {
        heading: 'Honest refusals',
        body:
          'If the corpus does not hold enough relevant material to answer confidently, the portal ' +
          'says so and shows you the closest passages it found and what to try next, rather than ' +
          'bluffing an answer. An honest "no direct evidence found" is a feature, not a failure.',
      },
      {
        heading: 'The evidence table',
        body:
          'Beneath an answer, the evidence table lists every source the answer drew on with its ' +
          'matched passage, page and relevance. You can open any source in place, and the ' +
          'portal can judge each source for how well it actually supports the question so you can ' +
          'audit the answer rather than take it on trust.',
      },
    ],
  },
  {
    id: 'explore',
    category: 'Exploring the corpus',
    title: 'Explore',
    summary: 'The home surface - suggested questions, topic rows and a way in.',
    sections: [
      {
        heading: 'Your way in',
        body:
          'Explore is the portal home. A prominent question box lets you ask straight away, and ' +
          'suggested questions - drawn from the corpus itself - give you a starting point when you ' +
          'are not sure what to ask. Selecting a suggested question hands it to the Assistant.',
      },
      {
        heading: 'Topic rows',
        body:
          'Below the question box, topic rows show what the corpus covers, each with a selection ' +
          'of representative documents. The topics come from the box classification index, so ' +
          'they reflect how the content has actually been labelled, not a fixed menu. Follow a ' +
          'topic to see everything filed under it in the Library.',
      },
    ],
  },
  {
    id: 'library',
    category: 'Exploring the corpus',
    title: 'Library',
    summary: 'Browse, filter and page through the whole corpus.',
    sections: [
      {
        heading: 'Browsing the corpus',
        body: 'The Library is the full catalogue of the connected content. Browse it, sort it by ' +
          'when documents were created or modified or by title, and page through large corpora ' +
          'without waiting on the whole set to load.',
      },
      {
        heading: 'Filtering and searching within',
        body:
          'Filter by topic and by document kind to narrow the catalogue. Type a query to search ' +
          'within the Library - this uses real retrieval, the same engine as Search, rather than ' +
          'a weak title match, so it finds documents a plain title filter would miss.',
      },
      {
        heading: 'What you see - and do not',
        body:
          'Documents are presented with a real, merchandised title and summary rather than a raw ' +
          'filename or project code. Failed ingests and junk entries (bot-challenge pages, ' +
          'system files) are hidden from the Library automatically, so what you browse is genuine ' +
          'content. Administrators still see everything, including the entries that need fixing, ' +
          'in the management views.',
      },
    ],
  },
  {
    id: 'reading-a-document',
    category: 'Exploring the corpus',
    title: 'Reading a document and chatting with it',
    summary: 'The document view, its viewer, and asking questions of a single document.',
    sections: [
      {
        heading: 'The document view',
        body:
          'Opening a document shows its title, a merchandised summary and key takeaways, and the ' +
          'source itself in the viewer - a PDF reader, a web page, a video or audio player with ' +
          'transcript, or the extracted text, depending on what the document is. A citation you ' +
          'clicked through takes you to the matching passage.',
      },
      {
        heading: 'Chatting with one document',
        body: 'You can ask questions of a single document. The answer is grounded only on that ' +
          "document's content, so it is a focused way to interrogate one report without the rest " +
          'of the corpus getting in the way. The same citations and confidence signals apply.',
      },
      {
        heading: 'Related work',
        body: 'The document view surfaces related documents from the corpus so you can follow a ' +
          'thread of connected research rather than returning to search each time.',
      },
    ],
  },
  {
    id: 'knowledge-graph',
    category: 'Exploring the corpus',
    title: 'The knowledge graph',
    summary: 'See how topics and entities in the corpus connect.',
    sections: [
      {
        heading: 'A map of the corpus',
        body:
          'The Graph is a visual map of how the corpus hangs together. Topics become weighted ' +
          'nodes and the connections between them - how often they co-occur across documents - ' +
          'become the edges. Larger nodes and heavier edges mean more content and stronger ' +
          'relationships.',
      },
      {
        heading: 'Exploring connections',
        body:
          'Open the graph full-screen and move through it to see which areas of research cluster ' +
          'together and where the bridges between them are. Follow a node to the documents behind ' +
          'it. The graph is built from the box own classification and knowledge-graph agents, so ' +
          'it reflects the real structure of the content rather than a hand-drawn diagram.',
      },
    ],
  },
  {
    id: 'generate',
    category: 'Working with the portal',
    title: 'Generate',
    summary: 'Draft structured artefacts grounded in the corpus.',
    sections: [
      {
        heading: 'Structured artefacts from real content',
        body: 'Generate produces structured artefacts - briefings, comparisons and the like - by ' +
          'having the portal write to a defined shape, grounded in retrieved corpus content. ' +
          'Suggested topic chips per artefact type help you start.',
      },
      {
        heading: 'Grounding gate',
        body:
          'Generation is gated on real grounding. If the corpus does not hold relevant enough ' +
          'material, the portal declines to fabricate an artefact and tells you the grounding was ' +
          'insufficient, rather than producing something plausible but unsupported. When ' +
          'grounding is partial, only the sources that genuinely support the content are cited.',
      },
      {
        heading: 'Using what you generate',
        body: 'A generated artefact carries its sources with it, and can be exported to a Word-' +
          'compatible document so it drops straight into your own work.',
      },
    ],
  },
  {
    id: 'assessment',
    category: 'Working with the portal',
    title: 'Assessment',
    summary: 'Test your knowledge of the corpus with a self-assessment quiz.',
    sections: [
      {
        heading: 'Self-assessment',
        body: 'The Assessment is a short quiz drawn from the corpus - a quick way to check your ' +
          'understanding of the material or to onboard someone new to the content. Answer the ' +
          'questions and see how you did, with the relevant sources to read up on anything you ' +
          'missed.',
      },
    ],
  },
  {
    id: 'investigations',
    category: 'Working with the portal',
    title: 'Investigations',
    summary: 'Accumulate evidence around a research question over time.',
    sections: [
      {
        heading: 'A first-class research question',
        body:
          'An Investigation is a persistent research question that accumulates evidence as you ' +
          'work, rather than a search you run once and lose. Create one for a question you are ' +
          'genuinely trying to answer and build it up over multiple sessions.',
      },
      {
        heading: 'Building the evidence',
        body: 'As you find passages that bear on the question - from search, the assistant or a ' +
          'document - save them into the investigation as evidence, each keeping its provenance ' +
          'back to the source. The evidence table is persistent, so the case you are building ' +
          'does not vanish when you move on.',
      },
      {
        heading: 'Synthesis',
        body:
          'When you have gathered enough, the portal can synthesise across the evidence you have ' +
          'kept - grounded strictly on that evidence, not the whole corpus - to draw the threads ' +
          'together, and you can generate artefacts from it and export the result.',
      },
    ],
  },
  {
    id: 'admin-knowledge-box',
    category: 'Administration',
    title: 'Connecting a knowledge box and adding content',
    summary: 'Connect a knowledge box, then add, ingest and sync content into it.',
    sections: [
      {
        heading: 'Connecting a knowledge box',
        body: 'Administration lives under **Manage** and is passcode-protected. A portal needs a ' +
          'knowledge box connected before search and answers work. Connect an existing box by ' +
          'binding it, or create and provision a new one from within the app - the portal ' +
          'configures the box (its taxonomy, graph, agents and suggested questions) for the ' +
          'domain you describe.\n\n' +
          'Bindings are held server-side; the credentials never reach the browser. Every call to ' +
          'the content platform is made from the server.',
      },
      {
        heading: 'Adding content',
        body: 'Add content into the connected box several ways:\n\n' +
          '- **Upload** documents (PDFs and other files) directly.\n' +
          '- **Add a link** to a web page for the box to crawl and ingest.\n' +
          '- **Add text** as a resource.\n\n' +
          'Ingestion is asynchronous. When the box is busy processing recent changes it applies ' +
          'back-pressure; the portal waits and retries within bounds, and tells you honestly when ' +
          'the box is too busy to accept more right now rather than failing silently.',
      },
      {
        heading: 'Ingesting and syncing web sources',
        body: 'Point the portal at a source site and it discovers the linkable pages so you can ' +
          'ingest them as a set. Sources can be re-synced on a schedule so the corpus keeps up ' +
          'with a site that changes, without anyone re-adding pages by hand.',
      },
      {
        heading: 'Corpus health',
        body: 'The corpus-health view scans the connected content for problems - failed ingests, ' +
          'documents whose text extracted thin or empty, bot-challenge pages that slipped in, and ' +
          'raw untitled entries. From here you can re-ingest what needs fixing and permanently ' +
          'purge the genuinely broken entries (a narrowly-scoped, confirmed delete), keeping the ' +
          'corpus that users see genuinely clean.',
      },
    ],
  },
  {
    id: 'admin-taxonomy-enrichments',
    category: 'Administration',
    title: 'Taxonomy and enrichments',
    summary: 'Shape the topic taxonomy, the knowledge graph and per-document enrichments.',
    sections: [
      {
        heading: 'Taxonomy',
        body:
          'The taxonomy is the set of topics and document kinds the corpus is classified against. ' +
          'It drives the topic rows on Explore, the filters in Search and the Library, and the ' +
          'knowledge graph. Review it, adjust the labels, and have the classification agents ' +
          'apply them across the corpus so the structure users navigate reflects the real content.',
      },
      {
        heading: 'Enrichments',
        body:
          'Enrichments are the structured fields generated onto each document - a real title, a ' +
          'summary, key takeaways and quotes of interest - that replace raw filenames and give ' +
          'every document a scannable, credible presentation on cards, in the Library and on the ' +
          'document page.\n\n' +
          'The default research enrichment ships as the first enrichment. Each enrichment is a ' +
          'generation agent plus a schema; the portal renders whatever fields the schema defines, ' +
          'so adding a new lens on the corpus is a configuration change, displayed automatically.',
      },
      {
        heading: 'The knowledge graph strategy',
        body:
          'The knowledge graph is built by an extraction agent configured with the entity types ' +
          'and relation examples that matter for the domain. Review and refine that strategy in ' +
          'management, and the graph the portal draws follows from it.',
      },
    ],
  },
  {
    id: 'help-and-this-documentation',
    category: 'Administration',
    title: 'About this documentation',
    summary: 'How the Help section works and how it stays separate from research.',
    sections: [
      {
        heading: 'A dedicated, scoped help search',
        body: 'This Help section has its own search and its own AI assistant that answer "how do ' +
          'I..." questions about using the portal. It retrieves only from this documentation.\n\n' +
          'Crucially, the documentation is kept entirely separate from research content: normal ' +
          'Search and the research Assistant never retrieve or cite these help pages, and the ' +
          'Help search never reaches into the research corpus. The two are isolated by dedicated, ' +
          'centrally-managed search configurations on the knowledge box, with a server-side ' +
          'cross-check as a safety net, so a question about the portal and a question about the ' +
          'research never bleed into each other.',
      },
      {
        heading: 'Keeping it current',
        body: 'The documentation is authored as part of the application and ingested into the ' +
          'knowledge box by an administrator. When the pages change, an administrator re-runs the ' +
          'ingestion; it is idempotent, so re-running it updates the existing pages in place ' +
          'rather than duplicating them.',
      },
    ],
  },
]

/** A documentation page by its stable id. */
export function docPageById(id: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.id === id)
}

/** Documentation pages grouped by category, in category and authored order. */
export function docPagesByCategory(): { category: DocCategory; pages: DocPage[] }[] {
  return DOC_CATEGORIES.map((category) => ({
    category,
    pages: DOC_PAGES.filter((page) => page.category === category),
  })).filter((group) => group.pages.length > 0)
}

/**
 * A documentation page rendered as the Markdown body that is ingested into the
 * knowledge box. The title leads as an H1 and each section becomes an H2 so the
 * platform extracts clean, retrievable paragraphs.
 */
export function docPageToMarkdown(page: DocPage): string {
  const parts = [`# ${page.title}`, page.summary]
  for (const section of page.sections) {
    parts.push(`## ${section.heading}`, section.body)
  }
  return parts.join('\n\n')
}

/**
 * Plain-text rendering of a page - the ingested body with Markdown markers
 * stripped - for previews and for tests that assert on content without markup.
 */
export function docPageToPlainText(page: DocPage): string {
  return docPageToMarkdown(page)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
