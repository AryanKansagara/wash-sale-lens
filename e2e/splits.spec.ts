import { expect, fixture, parseCsv, readDownload, test } from './fixtures.ts'

test('a split between a sale and its replacement counts shares in one unit', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  // Buy 100 ACME at $20, sell all 100 at $10 (a $1,000 loss), 2-for-1 split, then buy 100 new shares at $5.
  // The 100 new shares are 50 of the old ones, so half the loss is disallowed.
  await page.locator('input[type=file]').setInputFiles(fixture('split-synthetic.csv'))
  const card = page.locator('.pending', { hasText: 'split-synthetic.csv' })
  await expect(card).toContainText('4 trades')
  await card.getByRole('button', { name: 'Import 4 trades' }).click()
  await expect(page.locator('.toasts')).toContainText('Imported 4 rows')

  await page.getByRole('link', { name: 'Wash sales' }).click()
  await expect(page.locator('.kpi', { hasText: 'Wash sale loss disallowed' })).toContainText('$500.00')
  const row = page.getByRole('row', { name: /Mar 3.*ACME/ })
  await expect(row).toContainText('−$1,000.00')
  await row.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Why $500.00 of this ACME loss is disallowed' })).toBeVisible()
  await expect(dialog).toContainText('100 sh ACME2025-01-062025-03-03$1,000.00$2,000.00W$500.00−$500.00')
  await expect(dialog).toContainText('Mar 10')
  await expect(dialog).toContainText('(100 as bought)')
  await page.keyboard.press('Escape')

  const csv = await readDownload(page, () => page.getByRole('button', { name: '8949 CSV' }).click())
  const [head, ...rows] = parseCsv(csv.text)
  const col = (n: string) => head.indexOf(n)
  const w = rows.filter(r => r[col('(f) Code')] === 'W')
  expect(w).toHaveLength(1)
  expect([w[0][col('(d) Proceeds')], w[0][col('(e) Cost basis')], w[0][col('(g) Adjustment')], w[0][col('(h) Gain or (loss)')]]).toEqual(['1000.00', '2000.00', '500.00', '-500.00'])
})
