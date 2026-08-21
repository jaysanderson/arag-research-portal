# Research Portal

A world-class, multi-tenant research portal: point it at a blank Progress Agentic RAG knowledge
box, describe the domain, and the application provisions a complete, branded portal for that
organisation's research estate. See `docs/VISION.md` (locked decisions), `docs/ARCHITECTURE.md`
(system design) and `docs/PARITY.md` (the feature benchmark).

## Layout

```
apps/web         React + TypeScript + Vite front end
apps/api         Fastify + TypeScript API server (port 8787)
packages/core    shared Zod schemas and types
packages/retrieval   RetrievalProvider interface + providers (mock now, ARAG next)
```

## Getting started

```sh
npm install
cp .env.example .env   # then fill in the Agentic RAG account values
npm run provision      # create + seed the GRDC and FRDC knowledge boxes (idempotent)
npm run dev            # api on :8787, web on :5173 (proxied /api)
npm run check          # typecheck + lint + format + test + build
```

There is no mock mode - the portal always talks to live Progress Agentic RAG knowledge boxes.
Seed corpora live in `content/seed/` and are uploaded into the knowledge boxes by the
provision script.
