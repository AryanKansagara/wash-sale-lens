import { expect, fixture, openSample, parseCsv, readDownload, test } from './fixtures.ts'

test('opens a sample and explains a disallowed loss', async ({ page }) => {
  await openSample(page, 'dip-buyer')
  await expect(page.getByRole('heading', { name: 'Dip buyer (sample)' })).toBeVisible()
  await expect(page.getByText('Synthetic', { exact: true })).toBeVisible()

  // The first wash sale: 40 PLTR bought Jan 6, sold Feb 24 at a loss, rebought Mar 5.
  await page.getByRole('row', { name: /Feb 24.*PLTR/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Why $399.60 of this PLTR loss is disallowed' })).toBeVisible()
  await expect(dialog).toContainText('Bought 40 PLTR')
  await expect(dialog).toContainText('Proceeds$2,592.80')
  await expect(dialog).toContainText('Basis$2,992.40')
  await expect(dialog).toContainText('Loss−$399.60')
  await expect(dialog).toContainText('Mar 5Robinhood individual40$399.60Reported')
  await expect(dialog).toContainText('$99.90 released on May 12, 2025')
  await expect(dialog).toContainText('$299.70 released on November 10, 2025')
  await expect(dialog).toContainText('40 sh PLTR2025-01-062025-02-24$2,592.80$2,992.40W$399.60$0.00')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('imports synthetic trades in two accounts and finds a cross-account wash sale', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  await expect(page.getByRole('heading', { name: 'Import activity' })).toBeVisible()

  // Robinhood: buy 10 ACME Jan 6 at $100, sell Mar 3 at $80 (a $200 loss). On its own this is a plain loss.
  await page.locator('input[type=file]').setInputFiles(fixture('robinhood-synthetic.csv'))
  const rh = page.locator('.pending', { hasText: 'robinhood-synthetic.csv' })
  await expect(rh).toContainText('Robinhood account activity report')
  await expect(rh).toContainText('2 trades (1 buys, 1 sells)')
  await rh.getByRole('button', { name: 'Import 2 trades' }).click()
  await expect(page.locator('.toasts')).toContainText('Imported 2 rows into Robinhood individual')
  await expect(page.getByRole('heading', { name: 'Imported files' })).toBeVisible()

  // Schwab: buy 10 ACME on Mar 17, inside the 30 days after the sale, in a second account.
  await page.locator('input[type=file]').setInputFiles(fixture('schwab-synthetic.csv'))
  const sw = page.locator('.pending', { hasText: 'schwab-synthetic.csv' })
  await expect(sw).toContainText('Schwab')
  await expect(sw.getByLabel('Account')).toHaveValue('new')
  await sw.getByRole('button', { name: 'Import 1 trades' }).click()
  await expect(page.locator('.toasts')).toContainText('Imported 1 row into Charles Schwab')
  await expect(page.locator('.account-row')).toHaveCount(2)

  await page.getByRole('link', { name: 'Wash sales' }).click()
  await expect(page.getByRole('heading', { name: 'Every wash sale in 2025' })).toBeVisible()
  await expect(page.locator('.kpi', { hasText: 'Wash sale loss disallowed' })).toContainText('$200.00')
  const row = page.getByRole('row', { name: /Mar 3.*ACME/ })
  await expect(row).toContainText('Robinhood individual')
  await expect(row).toContainText('Charles Schwab')
  await expect(row).toContainText('Broker can’t see')
  await expect(row).toContainText('Still in basis')

  // Form 8949: one code W row carrying the $200 adjustment.
  const csv = await readDownload(page, () => page.getByRole('button', { name: '8949 CSV' }).click())
  expect(csv.name).toBe('form-8949-2025-my-trades.csv')
  const [head, ...rows] = parseCsv(csv.text)
  const col = (n: string) => head.indexOf(n)
  expect(head).toContain('(f) Code')
  const w = rows.filter(r => r[col('(f) Code')] === 'W')
  expect(w).toHaveLength(1)
  expect(w[0][col('Account')]).toBe('Robinhood individual')
  expect(w[0][col('(a) Description')]).toBe('10 sh ACME')
  expect(w[0][col('(d) Proceeds')]).toBe('800.00')
  expect(w[0][col('(e) Cost basis')]).toBe('1000.00')
  expect(w[0][col('(g) Adjustment')]).toBe('200.00')
  expect(w[0][col('(h) Gain or (loss)')]).toBe('0.00')

  // Persistence: the project is kept in the browser (IndexedDB) and comes back after a reload.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Every wash sale in 2025' })).toBeVisible()
  await expect(page.getByRole('row', { name: /Mar 3.*ACME/ })).toContainText('Broker can’t see')
  await page.getByRole('link', { name: 'Projects', exact: true }).first().click()
  const card = page.locator('.project-card', { hasText: 'My trades' })
  await expect(card).toContainText('Robinhood individual')
  await expect(card).toContainText('Charles Schwab')
  await expect(card).toContainText('2 files')
})

test('Form 8949 download for a sample has code W rows', async ({ page }) => {
  await openSample(page, 'cross-account')
  const csv = await readDownload(page, () => page.getByRole('button', { name: '8949 CSV' }).click())
  expect(csv.name).toMatch(/^form-8949-2025-robinhood-roth-ira-sample.*\.csv$/)
  const [head, ...rows] = parseCsv(csv.text)
  const col = (n: string) => head.indexOf(n)
  expect(head.slice(0, 9)).toEqual(['Part', 'Box (assumed)', 'Account', '(a) Description', '(b) Date acquired', '(c) Date sold', '(d) Proceeds', '(e) Cost basis', '(f) Code'])
  const w = rows.filter(r => r[col('(f) Code')] === 'W')
  // Three Robinhood sales were washed: TSLA by a Schwab buy, NVDA by a Roth IRA buy, AMD by a Robinhood rebuy.
  expect(w.map(r => [r[col('Account')], r[col('(a) Description')], r[col('(g) Adjustment')], r[col('(h) Gain or (loss)')]])).toEqual([
    ['Robinhood individual', '10 sh TSLA', '1608.30', '0.00'],
    ['Robinhood individual', '30 sh NVDA', '798.80', '-399.40'],
    ['Robinhood individual', '25 sh AMD', '507.75', '0.00'],
  ])
  // Every row that is not code W has no adjustment.
  for (const r of rows.filter(r => r[col('(f) Code')] !== 'W')) expect(r[col('(g) Adjustment')]).toBe('')
  // The NVDA loss was replaced in a Roth IRA, so all of it is lost for good.
  expect(w.find(r => r[col('(a) Description')].endsWith('NVDA'))![col('Of (g): lost to IRA')]).toBe('798.80')
})

test('the harvest planner shows do-not-buy-until dates and persists its settings', async ({ page }) => {
  await openSample(page, 'cross-account', 'harvest')
  await expect(page.getByRole('heading', { name: 'Plan a harvest' })).toBeVisible()
  // The sample's planner prices are dated Nov 6, 2026; pin the sell date so the plan does not depend on today's date.
  await page.getByLabel('Sell on').fill('2026-11-08')

  const dnb = page.locator('.panel', { has: page.getByRole('heading', { name: 'Do not buy until' }) })
  await expect(dnb.getByRole('listitem').filter({ hasText: 'TSLA' })).toContainText('through December 8, 2026')
  await expect(dnb.getByRole('listitem').filter({ hasText: 'TSLA' })).toContainText('Safe Dec 9')
  await expect(dnb.getByRole('listitem').filter({ hasText: 'NVDA' })).toContainText('through December 8, 2026')
  await expect(page.getByRole('heading', { name: 'Lots to sell on November 8, 2026' })).toBeVisible()
  await expect(page.getByRole('row', { name: /TSLA.*Schwab brokerage.*−\$224\.40/ })).toBeVisible()
  // AMD cannot be harvested yet: a Roth IRA buy on Oct 27 would make the loss permanent.
  await expect(page.getByRole('heading', { name: 'Not harvestable today' })).toBeVisible()
  await expect(page.getByText('bought 10 on Oct 27 in Fidelity Roth IRA')).toBeVisible()

  // The sell date is saved with the project.
  await page.reload()
  await expect(page.getByLabel('Sell on')).toHaveValue('2026-11-08')
  await expect(dnb.getByRole('listitem').filter({ hasText: 'TSLA' })).toContainText('through December 8, 2026')
})

test('a wrong-format or unreadable file gets a clear message and the app stays usable', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  await expect(page.getByRole('heading', { name: 'Import activity' })).toBeVisible()
  const input = page.locator('input[type=file]')
  const toasts = page.locator('.toasts')
  const header = 'Activity Date,Process Date,Settle Date,Instrument,Description,Trans Code,Quantity,Price,Amount'

  // Empty file.
  await input.setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) })
  await expect(toasts).toContainText('empty.csv has no rows.')

  // A known header with no rows under it.
  await input.setInputFiles({ name: 'header-only.csv', mimeType: 'text/csv', buffer: Buffer.from(`${header}\n`) })
  await expect(toasts).toContainText('header-only.csv has no rows.')

  // A CSV that is not a broker file.
  await input.setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from('name,color\nfoo,red\nbar,blue\n') })
  const wrong = page.locator('.pending', { hasText: 'contacts.csv' })
  await expect(wrong).toContainText('These columns do not match a format we know. Pick the file type, then map the columns.')
  await expect(wrong.getByRole('button', { name: /^Import/ })).toHaveCount(0)

  // Binary data with a .csv name (a PNG header).
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0, 1, 2, 3, 0x0a, 0xde, 0xad, 0xbe, 0xef, 0, 0, 0x0a, 1, 2])
  await input.setInputFiles({ name: 'photo.csv', mimeType: 'text/csv', buffer: png })
  const bin = page.locator('.pending', { hasText: 'photo.csv' })
  await expect(bin).toContainText('These columns do not match a format we know')
  await expect(bin.getByRole('button', { name: /^Import/ })).toHaveCount(0)

  // An unrecognised file can be dismissed without picking a type; only that card goes away.
  await wrong.getByRole('button', { name: 'Discard' }).click()
  await expect(wrong).toHaveCount(0)
  await expect(bin).toBeVisible()
  await bin.getByRole('button', { name: 'Discard' }).click()
  await expect(bin).toHaveCount(0)
  await expect(page.locator('.pending')).toHaveCount(0)

  // A real header over rows that are not trades: reported line by line, nothing can be imported.
  const junk = `${header}\nsoon,soon,soon,ACME,x,Buy,10,$1.00,($10.00)\n13/45/2025,x,x,ACME,x,Sell,10,$1.00,$10.00\n`
  await input.setInputFiles({ name: 'junk.csv', mimeType: 'text/csv', buffer: Buffer.from(junk) })
  const bad = page.locator('.pending', { hasText: 'junk.csv' })
  await expect(bad.locator('.report')).toContainText('0 trades')
  await expect(bad.locator('.report')).toContainText('2 skipped')
  await expect(bad.locator('.report')).toContainText('2 problems')
  await expect(bad.locator('.issues')).toContainText('line 2 Date "soon" is not a date')
  await expect(bad.locator('.issues')).toContainText('line 3 Date "13/45/2025" is not a date')
  await expect(bad.getByRole('button', { name: 'Import 0 trades' })).toBeDisabled()

  // Nothing was imported and nothing reported success.
  await expect(toasts).not.toContainText('Imported')
  await expect(page.getByRole('heading', { name: 'Imported files' })).toHaveCount(0)
  await expect(page.locator('.account-row')).toHaveCount(1)
  await expect(page.locator('.account-row')).toContainText('0 trades')

  // Still usable: discard the junk, switch tabs, then import a good file.
  await bad.getByRole('button', { name: 'Discard' }).click()
  await expect(bad).toHaveCount(0)
  await page.getByRole('link', { name: 'Wash sales' }).click()
  await expect(page.getByRole('heading', { name: 'No trades yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Import trades' }).click()
  await expect(page.getByRole('heading', { name: 'Import activity' })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles(fixture('robinhood-synthetic.csv'))
  await page.locator('.pending', { hasText: 'robinhood-synthetic.csv' }).getByRole('button', { name: 'Import 2 trades' }).click()
  await expect(toasts).toContainText('Imported 2 rows into Robinhood individual')
})
