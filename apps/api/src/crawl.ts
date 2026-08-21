/**
 * Site discovery for the crawl ingestion flow (app-side; the platform has no
 * crawl API). Given a URL: if it is an XML sitemap, extract <loc> entries
 * (expanding one level of sitemap index); otherwise extract same-origin links
 * from the page, filtering assets, queries and common non-content paths. The
 * admin reviews the discovered list before anything is ingested.
 */

const ASSET_EXT =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|rss|pdf|zip|gz|mp4|mp3|woff2?|ttf|eot)(\?|$)/i
const SKIP_PATHS = /\/(wp-json|cdn-cgi|wp-admin|feed|tag|author)\/|[?#]|(Special|Talk|File):/i

function assertPublicHttpUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http(s) URLs can be crawled')
  }
  const host = url.hostname
  if (
    host === 'localhost' ||
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1'
  ) {
    throw new Error('Private and local addresses cannot be crawled')
  }
  return url
}

async function fetchText(url: string): Promise<{ body: string; contentType: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'research-portal-crawler/1.0' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`The site responded with ${res.status}`)
  return { body: await res.text(), contentType: res.headers.get('content-type') ?? '' }
}

const extractLocs = (xml: string): string[] =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1] ?? '').filter(Boolean)

export async function discoverLinks(
  target: string,
  cap: number,
): Promise<{ source: string; count: number; links: string[] }> {
  const origin = assertPublicHttpUrl(target)
  const { body, contentType } = await fetchText(origin.href)
  const seen = new Set<string>()
  const links: string[] = []
  const push = (raw: string) => {
    if (links.length >= cap) return
    try {
      const url = new URL(raw, origin.href)
      if (url.origin !== origin.origin) return
      if (ASSET_EXT.test(url.pathname) || SKIP_PATHS.test(url.href)) return
      const clean = `${url.origin}${url.pathname}`
      if (seen.has(clean)) return
      seen.add(clean)
      links.push(clean)
    } catch {
      // unparseable href - skip
    }
  }

  const isXml = contentType.includes('xml') || /<(urlset|sitemapindex)[\s>]/i.test(body)
  if (isXml) {
    const locs = extractLocs(body)
    const childSitemaps = locs.filter((l) => /sitemap[^/]*\.xml(\?|$)/i.test(l)).slice(0, 12)
    const pages = locs.filter((l) => !/\.xml(\?|$)/i.test(l))
    pages.forEach(push)
    for (const child of childSitemaps) {
      if (links.length >= cap) break
      try {
        const { body: childBody } = await fetchText(child)
        extractLocs(childBody)
          .filter((l) => !/\.xml(\?|$)/i.test(l))
          .forEach(push)
      } catch {
        // unreachable child sitemap - continue with what we have
      }
    }
  } else {
    for (const match of body.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
      push(match[1] ?? '')
    }
  }
  return { source: isXml ? 'sitemap' : 'page', count: links.length, links }
}
