# Seed content

The 20 documents in this directory (`grdc/` and `frdc/`, 10 each, indexed by `manifest.json`) are
**AI-generated synthetic content**, written in the style of Australian grains and fisheries
research, for the GRDC and FRDC showcase tenants.

They are **not** real GRDC (Grains Research and Development Corporation) or FRDC (Fisheries
Research and Development Corporation) publications. No statistic, figure, date, survey result or
finding in any of these documents is real - do not cite, quote, rely on or present any of it as
genuine research. They exist purely so `deno task provision` has something concrete to upload into
a fresh knowledge box while you evaluate the portal, and so the portal has real-looking content to
demonstrate search, citation and the knowledge graph against.

If you are running this portal for GRDC, FRDC, or any other organisation for real, replace this
seed content with that organisation's actual, cleared documents before treating any answer the
portal gives as trustworthy. See `docs/VISION.md` for the product decision that the showcase
tenants are meant to run genuinely real, cleared content in production - this synthetic seed set
is a local/demo starting point only, not the intended end state.

## Manifest

`manifest.json` lists all 20 entries with the metadata `apps/api/scripts/provision.ts` uploads
alongside each document (title, topic, publication date, type, summary, key facts). It carries no
explicit synthetic-content flag in its schema; this README is the authoritative disclaimer for
everything in this directory.
