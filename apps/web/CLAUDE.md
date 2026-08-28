# Frontend rules (apps/web)

These apply to every change under `apps/web`. See root `CLAUDE.md` for the full rule set.

## Visual QA is mandatory - "done" means SEEN, not just compiled

A UI change is not finished until it has been VISUALLY verified in a real browser on the deployed
page (or a local run). Gates (`deno task check`, `build:web`) do not catch visual, layout, theme or
UX bugs. Before calling any UI work done, check with your own eyes:

- **Light mode AND dark mode** - theme-specific bugs are common (translucency bleed, contrast, seams
  where a translucent surface straddles two backgrounds).
- **Wide desktop AND ~390px mobile** - no horizontal body scroll; rails stack sensibly on mobile.
- The changed element PLUS the surrounding chrome (sticky header/menu, rails, scroll behaviour).

## Design bar

- World-class, never "vibe coded". Considered typography, spacing, hierarchy, motion; real
  empty/loading/error states. Use the `rp-*` design tokens and component classes, never raw one-off
  colours.
- **Use the full screen on large displays.** Layouts scale UP on 2xl+ (27-inch, maximised windows),
  not only down to mobile. Avoid fixed centred `max-w-6xl` columns that strand half a large monitor;
  keep prose columns at a readable measure (~65-75ch) while using the extra width for grids, rails
  and viewers.
- Translucent surfaces (`rp-glass`) must not let page content bleed through when content scrolls
  under them - use an opaque or near-opaque fill for the sticky header and any floating tiles that
  overlap a two-tone background. Verify in light mode specifically.
- Australian English, no em dashes (spaced hyphen) in any user-facing copy.
- Accessibility: keyboard reachable, visible focus, logical heading order, `prefers-reduced-motion`.

## Vendor deps

Loaded from esm.sh via the import map in `index.html` and `--external` in `deno.json`'s build:js.
The npm registry is blocked; do not add npm/node_modules. The entry HTML is served no-cache with
`?v=<build sha>` on `/app.js` and `/styles.css` (see `apps/api/src/server.ts`) so deploys are not
masked by a stale browser bundle - keep that intact.
