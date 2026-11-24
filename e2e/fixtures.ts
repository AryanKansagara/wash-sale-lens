import { expect, test as base, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const fixture = (name: string) => join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name)

/** The page's own stylesheet asks Google Fonts for typefaces. Those hosts are stubbed; any other external host fails the test. */
const STUBBED_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

export const test = base.extend<{ guard: void }>({
  // Runs for every test: stubs or blocks everything that is not the local preview server (so no Supabase,
  // no network at all), and fails the test on uncaught page errors or on requests to unexpected hosts.
  guard: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin
    const blocked: string[] = []
    const errors: string[] = []
    await context.route(url => new URL(url).origin !== origin, route => {
      const u = new URL(route.request().url())
      if (STUBBED_HOSTS.has(u.hostname)) {
        return route.fulfill({ status: 200, contentType: u.hostname === 'fonts.googleapis.com' ? 'text/css' : 'font/woff2', body: '' })
      }
      blocked.push(route.request().url())
      return route.abort('blockedbyclient')
    })
    page.on('pageerror', e => errors.push(e.message))
    await use()
    expect(blocked, 'requests to hosts outside the preview server').toEqual([])
    expect(errors, 'uncaught page errors').toEqual([])
  }, { auto: true }],
})
export { expect }

/** Opens a synthetic trader straight into a tab; the sample is built by the real importer in the browser. */
export async function openSample(page: Page, id: string, tab?: string) {
  await page.goto(`/app?sample=${id}${tab ? `&tab=${tab}` : ''}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('(sample)')
}

/** Parses the small CSVs the app downloads (quoted fields, doubled quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

export async function readDownload(page: Page, click: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent('download'), click()])
  const path = await download.path()
  return { name: download.suggestedFilename(), text: readFileSync(path, 'utf8') }
}
