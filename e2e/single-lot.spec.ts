import { expect, fixture, parseCsv, readDownload, test } from './fixtures.ts'
import type { Page } from '@playwright/test'

async function importOne(page: Page, file: string, trades: number) {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  await page.locator('input[type=file]').setInputFiles(fixture(file))
  await page.locator('.pending', { hasText: file }).getByRole('button', { name: `Import ${trades} trades` }).click()
  await expect(page.locator('.toasts')).toContainText('Imported')
}

test('selling part of one purchase at a loss is not a wash sale because of the shares kept', async ({ page }) => {
  // Buy 100 ACME at $20, sell 50 at $10 ten days later, buy nothing else.
  await importOne(page, 'single-lot-synthetic.csv', 2)
  await page.getByRole('link', { name: 'Wash sales' }).click()
  await expect(page.getByRole('heading', { name: 'No wash sales in 2025' })).toBeVisible()
  await expect(page.locator('.kpi', { hasText: 'Net gain or loss 2025' })).toContainText('−$500.00')
  await expect(page.locator('.kpi', { hasText: 'Wash sale loss disallowed' })).toContainText('$0.00')
  await expect(page.getByTestId('lot-notes')).toHaveCount(0)

  const csv = await readDownload(page, () => page.getByRole('button', { name: '8949 CSV' }).click())
  const [head, ...rows] = parseCsv(csv.text)
  const col = (n: string) => head.indexOf(n)
  expect(rows).toHaveLength(1)
  expect([rows[0][col('(a) Description')], rows[0][col('(f) Code')], rows[0][col('(h) Gain or (loss)')]]).toEqual(['50 sh ACME', '', '-500.00'])

  // A broker applying the statute literally may report a wash sale here; the 1099-B check says so.
  await page.getByRole('link', { name: '1099-B check' }).click()
  await expect(page.getByTestId('same-purchase-note')).toContainText('up to $500.00 higher')
  await expect(page.getByTestId('same-purchase-note')).toContainText('Rev. Rul. 56-602')
})

test('two buy rows on one day with no order number stay separate purchases, and the page shows both figures', async ({ page }) => {
  await importOne(page, 'single-lot-fills-synthetic.csv', 3)
  await page.getByRole('link', { name: 'Wash sales' }).click()
  await expect(page.getByRole('heading', { name: 'Every wash sale in 2025' })).toBeVisible()
  await expect(page.locator('.kpi', { hasText: 'Wash sale loss disallowed' })).toContainText('$250.00')
  const note = page.getByTestId('lot-notes')
  await expect(note).toContainText('$250.00 disallowed here, $0.00 if one purchase')
  await expect(note).toContainText('order_id')
})

test('fills that carry the same order number are one purchase', async ({ page }) => {
  await importOne(page, 'single-lot-fills-order-id-synthetic.csv', 3)
  await page.getByRole('link', { name: 'Wash sales' }).click()
  await expect(page.getByRole('heading', { name: 'No wash sales in 2025' })).toBeVisible()
  await expect(page.locator('.kpi', { hasText: 'Net gain or loss 2025' })).toContainText('−$250.00')
  await expect(page.getByTestId('lot-notes')).toHaveCount(0)
})
