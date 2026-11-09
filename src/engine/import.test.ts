import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calendar, detectAuto, planHarvest } from './harvest.ts'
import { detect, mergeImport, parseCsv, validate, validate1099 } from './importer.ts'
import { SAMPLES, sampleFiles } from './sample.ts'
import type { Txn } from './types.ts'
import { brokerView, reconcile, runWash, summarize } from './wash.ts'

const load = (id: string) => {
  const def = SAMPLES.find(s => s.id === id)!
  let txns: Txn[] = []
  for (const f of sampleFiles(def)) {
    const csv = parseCsv(f.text)
    const d = detect(csv.rows)
    const v = validate(csv, d.map, d.headerRow, f.name)
    txns = mergeImport(txns, f.account.id, v.rows)
  }
  return { def, txns, res: runWash(txns, def.accounts, def.settings) }
}

test('detects the Robinhood activity report and skips dividends, deposits and the disclaimer by line', () => {
  const f = sampleFiles(SAMPLES[0])[0]
  const csv = parseCsv(f.text)
  const d = detect(csv.rows)
  assert.equal(d.broker, 'robinhood')
  const v = validate(csv, d.map, d.headerRow, f.name)
  assert.equal(v.rows.length, SAMPLES[0].trades.filter(t => t.k === 'buy' || t.k === 'sell').length)
  assert.ok(v.issues.some(i => i.level === 'skip' && /CDIV/.test(i.message)))
  assert.ok(v.issues.some(i => i.level === 'skip' && /footer/i.test(i.message)))
  // Newest-first file comes out oldest-first, with CUSIPs pulled from the multi-line description.
  assert.ok(v.rows[0].date <= v.rows[v.rows.length - 1].date)
  assert.equal(v.rows.find(r => r.symbol === 'PLTR')!.cusip, '69608A108')
})

test('detects Fidelity history below its blank preamble and reads signed quantities', () => {
  const f = sampleFiles(SAMPLES[1]).find(x => x.account.broker === 'fidelity')!
  const csv = parseCsv(f.text)
  const d = detect(csv.rows)
  assert.equal(d.broker, 'fidelity')
  const v = validate(csv, d.map, d.headerRow)
  assert.ok(v.rows.every(r => r.kind === 'buy' && r.qty > 0))
  assert.equal(v.issues.filter(i => i.level !== 'skip').length, 0)
})

test('Schwab: reinvested shares are buys tagged DRIP; the cash leg is skipped', () => {
  const f = sampleFiles(SAMPLES[2]).find(x => x.account.broker === 'schwab')!
  const csv = parseCsv(f.text)
  const d = detect(csv.rows)
  assert.equal(d.broker, 'schwab')
  const v = validate(csv, d.map, d.headerRow)
  assert.ok(v.rows.some(r => r.auto === 'drip'))
  assert.ok(v.issues.some(i => /Reinvest Dividend/.test(i.message)))
})

test('IBKR Flex Query: signed quantity, net cash, options flagged and repeated headers skipped', () => {
  const text = [
    'ClientAccountID,AssetClass,Symbol,Description,TradeDate,Quantity,TradePrice,IBCommission,NetCash,Buy/Sell',
    'U123,STK,AAPL,APPLE INC,20250103,10,240.5,-1,-2406,BUY',
    'U123,OPT,AAPL  250117C00250000,AAPL 17JAN25 250 C,20250104,1,3.2,-0.65,-320.65,BUY',
    'ClientAccountID,AssetClass,Symbol,Description,TradeDate,Quantity,TradePrice,IBCommission,NetCash,Buy/Sell',
    'U123,STK,AAPL,APPLE INC,20250210,-10,230,-1,2299,SELL',
  ].join('\n')
  const csv = parseCsv(text)
  const d = detect(csv.rows)
  assert.equal(d.broker, 'ibkr')
  const v = validate(csv, d.map, d.headerRow)
  assert.deepEqual(v.rows.map(r => [r.kind, r.qty, r.amount]), [['buy', 10, 240600], ['option', 1, 0], ['sell', 10, 229900]])
  assert.ok(v.issues.some(i => i.line === 4 && /Repeated header/.test(i.message)))
})

test('generic CSV: lot dates, split ratios and a line-numbered report of bad rows', () => {
  const text = 'date,action,symbol,quantity,price,lot_date,ratio\n2025-01-02,buy,XYZ,5,10,,\nnot-a-date,buy,XYZ,1,1,,\n2025-06-01,split,XYZ,,,,2\n2025-07-01,sell,XYZ,10,8,2025-01-02,\n2025-07-02,sell,XYZ,abc,8,,\n'
  const csv = parseCsv(text)
  const d = detect(csv.rows)
  assert.equal(d.format, 'Generic CSV')
  const v = validate(csv, d.map, d.headerRow)
  assert.deepEqual(v.rows.map(r => r.kind), ['buy', 'split', 'sell'])
  assert.equal(v.rows[1].ratio, 2)
  assert.equal(v.rows[2].lotDate, '2025-01-02')
  assert.deepEqual(v.issues.filter(i => i.level !== 'skip').map(i => i.line), [3, 6])
})

test('1099-B detail CSV totals the wash sale column and skips total rows', () => {
  const text = 'Description,Date Acquired,Date Sold,Proceeds,Cost Basis,Wash Sale Loss Disallowed,Gain or Loss\nPLTR,01/06/2025,02/24/2025,"2,564.00","3,128.00",564.00,0.00\nTotals,,,"2,564.00","3,128.00",564.00,0.00\n'
  const csv = parseCsv(text)
  const d = detect(csv.rows)
  assert.equal(d.kind, 'form1099')
  const v = validate1099(csv, d.map, d.headerRow)
  assert.equal(v.rows.length, 1)
  assert.equal(v.rows[0].wash, 56400)
})

test('re-importing the same file does not duplicate trades', () => {
  const f = sampleFiles(SAMPLES[0])[0]
  const csv = parseCsv(f.text)
  const d = detect(csv.rows)
  const v = validate(csv, d.map, d.headerRow)
  const once = mergeImport([], 'rh', v.rows)
  const twice = mergeImport(once, 'rh', v.rows)
  assert.equal(twice.length, once.length)
  assert.deepEqual(twice.map(t => t.id), once.map(t => t.id))
})

test('sample: the dip buyer chain ends in a full release by year end', () => {
  const { res } = load('dip-buyer')
  const s = summarize(res, 2025)
  assert.ok(s.disallowed > 0)
  assert.equal(s.deferredOut, 0)
  assert.ok(s.released > 0)
  const pltr = res.pieces.filter(p => p.symbol === 'PLTR' && p.sold.startsWith('2025'))
  assert.ok(pltr.filter(p => p.disallowed > 0).length >= 3)
})

test('sample: the Roth purchase permanently disallows a loss Robinhood never reports', () => {
  const { def, txns, res } = load('cross-account')
  const s = summarize(res, 2025)
  assert.ok(s.permanent > 0)
  const line = reconcile(res, brokerView(txns, def.accounts, def.settings), def.accounts, 2025, {}).find(l => l.accountId === 'rh')!
  assert.ok(line.broker > 0, 'the AMD wash sale is one Robinhood can see')
  assert.ok(line.ira > 0 && line.crossAccount > 0)
  assert.equal(line.ours, line.broker + line.ira + line.crossAccount + line.equivalents + line.knockOn)
})

test('sample: weekly recurring buys and DRIP are detected, and Roth IVV buys block a VOO harvest', () => {
  const { def, txns, res } = load('recurring-trap')
  const autos = detectAuto(txns, def.settings, '2026-11-08', '2026-12-31')
  assert.ok(autos.some(a => a.symbol === 'VOO' && a.kind === 'recurring' && a.cadenceDays === 7))
  assert.ok(autos.some(a => a.symbol === 'SCHD' && a.kind === 'drip'))
  const s = summarize(res, 2025)
  assert.ok(s.disallowed > 0 && s.permanent > 0)
  const plan = planHarvest(res, txns, def.accounts, def.settings, def.prices, 500000, '2026-11-08')
  const voo = plan.groups.find(g => g.symbols.includes('VOO'))!
  assert.ok(voo.blockers.some(b => b.reason === 'ira-recent'))
  assert.equal(voo.picked.length, 0)
})

test('planner: selling a group sells its recent loss lots too and sets the do-not-buy dates', () => {
  const { def, txns, res } = load('dip-buyer')
  const plan = planHarvest(res, txns, def.accounts, def.settings, def.prices, 200000, '2026-11-08')
  const pltr = plan.groups.find(g => g.group === 'PLTR')!
  assert.ok(pltr.picked.length >= 2)
  assert.ok(pltr.picked.some(p => p.lot.acquired === '2026-10-20'))
  assert.equal(pltr.doNotBuyThrough, '2026-12-08')
  assert.equal(pltr.firstSafe, '2026-12-09')
  const cal = calendar(plan)
  assert.equal(cal.length, 32)
  assert.ok(cal[0].events.some(e => e.type === 'sell'))
})

test('planner: prices missing for a holding are reported, not guessed', () => {
  const { def, txns, res } = load('dip-buyer')
  const plan = planHarvest(res, txns, def.accounts, def.settings, { PLTR: 50 }, 1000, '2026-11-08')
  assert.ok(plan.missingPrices.includes('SOFI'))
})
