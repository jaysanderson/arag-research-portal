// ---------------------------------------------------------------------------
// Browser E2E persona journeys - CI-runnable, no real ARAG account.
//
// Drives a real headless Chromium (via @astral/astral) against the built SPA
// served by the production Hono app (apps/api/src/app.ts), with only the
// RetrievalProvider swapped for a deterministic test double (see
// e2e/support/double-provider.ts). Everything else - routing, SSE streaming,
// tenant config, static file serving - is the real production code path.
//
// Journeys assert what docs/PERSONAS.md's persona gates require of the
// researcher journey: the portal picker, the explore page's topic rows, the
// search page's cited AI Answer panel (inline [n] markers, resources/cited
// header, Resources/Citations toggle), a citation marker's click-through to
// its source, the Self Assessment page's knowledge-area cards, and that the
// search journey stays usable at a 390px mobile viewport.
//
// Run with `deno task test:e2e` - NOT part of plain `deno task test` (the
// unit gate), since e2e/ sits outside the packages/ and apps/ roots that
// task scans, and downloading/driving a real browser is much slower than
// the unit suite.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch } from '@astral/astral'
import { RESOURCE_ONE } from './support/double-provider.ts'
import { startTestServer, type TestServer } from './support/test-server.ts'

let browser: Browser
let server: TestServer

beforeAll(async () => {
  server = startTestServer()
  browser = await launch()
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

describe('portal picker', () => {
  it('renders both configured portals', async () => {
    const page = await browser.newPage(`${server.url}/`)
    try {
      await page.waitForSelector('h1')
      const bodyText = await page.evaluate(() => document.body.innerText)
      expect(bodyText).toContain('Choose a portal')
      expect(bodyText).toContain('FRDC Knowledge Hub')
      expect(bodyText).toContain('GRDC Research Portal')
    } finally {
      await page.close()
    }
  })
})

describe('explore page', () => {
  it('renders topic rows with resource cards', async () => {
    const page = await browser.newPage(`${server.url}/t/frdc`)
    try {
      // Topic row heading for the topic the double's resources are filed
      // against ("stock-assessment" -> "Fisheries stock assessment").
      await page.waitForSelector('h2', { timeout: 15_000 })
      const bodyText = await page.evaluate(() => document.body.innerText)
      expect(bodyText).toContain('Fisheries stock assessment')
      expect(bodyText).toContain(RESOURCE_ONE.title)
    } finally {
      await page.close()
    }
  })
})

describe('search - AI answer panel and citations', () => {
  it('shows the AI Answer panel with an inline citation marker, the resources/cited header and the toggle', async () => {
    const page = await browser.newPage(`${server.url}/t/frdc/search?q=abalone`)
    try {
      await page.waitForSelector('[aria-label="AI answer"]', { timeout: 15_000 })

      // Inline `[1]` citation marker rendered as a superscript link.
      await page.waitForSelector('sup a', { timeout: 15_000 })
      const markerText = await (await page.$('sup a'))?.innerText()
      expect(markerText).toBe('[1]')

      // The resources/cited count header - waits for the answer's citation
      // to have been reported up to the results list ("1 cited").
      await page.waitForFunction(() => document.body.innerText.includes('1 cited'))

      // Resources/Citations toggle (role=radiogroup, aria-label="Results view").
      const bodyText = await page.evaluate(() => document.body.innerText)
      expect(bodyText).toMatch(/Resources \(\d+\)/)
      expect(bodyText).toMatch(/Citations \(\d+\)/)
    } finally {
      await page.close()
    }
  })

  it('a citation marker click targets the right source', async () => {
    const page = await browser.newPage(`${server.url}/t/frdc/search?q=abalone`)
    try {
      const marker = await page.waitForSelector('sup a', { timeout: 15_000 })
      await marker.click()
      // A citation marker is a react-router <Link> - a client-side route
      // change (history.pushState), not a full navigation - so this waits
      // for the URL to change rather than for a load/network event.
      await page.waitForFunction(() => location.pathname.includes('/library/'))
      await page.waitForSelector('h1', { timeout: 15_000 })

      // astral's `page.url` only updates on a full Page.frameNavigated event,
      // which a react-router client-side route change never fires - read the
      // live location from the page itself instead.
      const pathname = await page.evaluate(() => location.pathname)
      expect(pathname).toBe(`/t/frdc/library/${RESOURCE_ONE.id}`)
      const heading = await (await page.$('h1'))?.innerText()
      expect(heading).toContain(RESOURCE_ONE.title)
    } finally {
      await page.close()
    }
  })
})

describe('assessment page', () => {
  it('renders its knowledge-area cards', async () => {
    const page = await browser.newPage(`${server.url}/t/frdc/assessment`)
    try {
      await page.waitForSelector('h1', { timeout: 15_000 })
      const heading = await (await page.$('h1'))?.innerText()
      expect(heading).toContain('Industry Knowledge Areas')

      const bodyText = await page.evaluate(() => document.body.innerText)
      // One card per configured frdc topic.
      expect(bodyText).toContain('Fisheries stock assessment')
      expect(bodyText).toContain('Aquaculture biosecurity')
      expect(bodyText).toContain('Build an assessment')
    } finally {
      await page.close()
    }
  })
})

describe('390px mobile viewport', () => {
  it('keeps the search journey usable - no horizontal body scroll, tap targets reachable', async () => {
    const page = await browser.newPage()
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${server.url}/t/frdc/search?q=abalone`, { waitUntil: 'load' })
      await page.waitForSelector('[aria-label="AI answer"]', { timeout: 15_000 })
      await page.waitForSelector('sup a', { timeout: 15_000 })

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)

      // The search input and submit button stay within the viewport and are
      // reachable tap targets (non-zero size, left/right edges in bounds).
      const rects = await page.evaluate(() => {
        const input = document.getElementById('search-input')
        const button = input?.closest('form')?.querySelector('button[type="submit"]')
        const rectOf = (el: Element | null | undefined) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.x, right: r.right, width: r.width, height: r.height }
        }
        return { input: rectOf(input), button: rectOf(button) }
      })

      expect(rects.input).not.toBeNull()
      expect(rects.button).not.toBeNull()
      expect(rects.input!.x).toBeGreaterThanOrEqual(0)
      expect(rects.input!.right).toBeLessThanOrEqual(390)
      expect(rects.input!.width).toBeGreaterThan(0)
      expect(rects.button!.x).toBeGreaterThanOrEqual(0)
      expect(rects.button!.right).toBeLessThanOrEqual(390)
      expect(rects.button!.height).toBeGreaterThan(0)

      // The citation marker link is likewise on-screen and clickable.
      const markerRect = await page.evaluate(() => {
        const marker = document.querySelector('sup a')
        if (!marker) return null
        const r = marker.getBoundingClientRect()
        return { x: r.x, right: r.right, width: r.width, height: r.height }
      })
      expect(markerRect).not.toBeNull()
      expect(markerRect!.right).toBeLessThanOrEqual(390)
      expect(markerRect!.width).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })
})
