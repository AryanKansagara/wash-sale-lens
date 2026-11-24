import { expect, fixture, parseCsv, readDownload, test } from './fixtures.ts'

test('moving shares to another of your own accounts is not a replacement purchase', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  const toasts = page.locator('.toasts')

  // Account 1: buy 200 ACME at $20, sell 100 at $10 (a $1,000 loss), send the other 100 to a second account.
  await page.locator('input[type=file]').setInputFiles(fixture('transfer-out-synthetic.csv'))
  await page.locator('.pending', { hasText: 'transfer-out-synthetic.csv' }).getByRole('button', { name: 'Import 3 trades' }).click()
  await expect(toasts).toContainText('Imported 3 rows')

  // Account 2: the 100 shares arrive the next day, with their cost but no purchase date.
  await page.locator('input[type=file]').setInputFiles(fixture('transfer-in-synthetic.csv'))
  const inCard = page.locator('.pending', { hasText: 'transfer-in-synthetic.csv' })
  await expect(inCard.getByLabel('Account')).toHaveValue('new')
  await inCard.getByRole('button', { name: 'Import 1 trades' }).click()
  await expect(page.locator('.account-row')).toHaveCount(2)

  // The move is not a purchase: the loss is allowed, nothing is left unexplained.
  await page.getByRole('link', { name: 'Wash sales' }).click()
  await expect(page.getByRole('heading', { name: 'No wash sales in 2025' })).toBeVisible()
  await expect(page.locator('.kpi', { hasText: 'Net gain or loss 2025' })).toContainText('−$1,000.00')
  await expect(page.locator('.kpi', { hasText: 'Wash sale loss disallowed' })).toContainText('$0.00')
  await expect(page.locator('.fix-banner.warn')).toHaveCount(0)

  const csv = await readDownload(page, () => page.getByRole('button', { name: '8949 CSV' }).click())
  const [head, ...rows] = parseCsv(csv.text)
  const col = (n: string) => head.indexOf(n)
  expect(rows).toHaveLength(1)
  expect([rows[0][col('(a) Description')], rows[0][col('(b) Date acquired')], rows[0][col('(f) Code')], rows[0][col('(h) Gain or (loss)')]]).toEqual(['100 sh ACME', '01/06/2025', '', '-1000.00'])
})
