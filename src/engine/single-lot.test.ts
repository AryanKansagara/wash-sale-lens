// Selling part of one purchase at a loss (Rev. Rul. 56-602, 1956-2 C.B. 527) and the cases the ruling does not cover.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brokerView, reconcile, runWash, summarize } from './wash.ts'
import { detect, mergeImport, parseCsv, trades, validate } from './importer.ts'
import { DEFAULT_SETTINGS, type Account, type Txn } from './types.ts'

const RH: Account = { id: 'rh', name: 'Robinhood', broker: 'robinhood', type: 'taxable' }
const SCH: Account = { id: 'sch', name: 'Schwab', broker: 'schwab', type: 'taxable' }
const ACCTS = [RH, SCH]
let seq = 0
const buy = (date: string, qty: number, price: number, extra: Partial<Txn> & { accountId?: string } = {}): Txn => ({ id: `t${++seq}`, seq, accountId: 'rh', date, kind: 'buy', symbol: 'XYZ', qty, amount: Math.round(qty * price * 100), ...extra })
const sell = (date: string, qty: number, price: number, extra: Partial<Txn> & { accountId?: string } = {}): Txn => ({ id: `t${++seq}`, seq, accountId: 'rh', date, kind: 'sell', symbol: 'XYZ', qty, amount: Math.round(qty * price * 100), ...extra })
const run = (txns: Txn[], opts = {}) => runWash(txns, ACCTS, DEFAULT_SETTINGS, opts)
const notes = (r: ReturnType<typeof run>) => r.limitations.filter(l => l.kind === 'lot')

test('one purchase, part sold at a loss, nothing else bought: the loss is allowed', () => {
  const tx = [buy('2026-03-02', 100, 20), sell('2026-03-12', 50, 10)]
  const r = run(tx)
  assert.equal(r.pieces.length, 1)
  assert.equal(r.pieces[0].disallowed, 0)
  assert.deepEqual(r.pieces[0].replacements, [])
  assert.equal(r.pieces[0].gain, -50000)
  assert.equal(notes(r).length, 0)
  // The kept 50 shares keep their own basis.
  assert.equal(r.lots.find(l => !l.closedBy)!.adj, 0)
  assert.equal(summarize(r, 2026).disallowed, 0)
})

test('the strict reading (what a broker may apply) still disallows it, so the difference can be shown', () => {
  const r = run([buy('2026-03-02', 100, 20), sell('2026-03-12', 50, 10)], { countSamePurchase: true })
  assert.equal(r.pieces[0].disallowed, 50000)
  assert.equal(notes(r).length, 0)
})

test('selling the rest of the purchase later is also a plain loss', () => {
  const r = run([buy('2026-03-02', 100, 20), sell('2026-03-12', 50, 10), sell('2026-03-20', 50, 8)])
  assert.deepEqual(r.pieces.map(p => p.disallowed), [0, 0])
  assert.equal(r.pieces[1].gain, -60000)
})

test('two purchases on different days: the other purchase is a replacement', () => {
  const r = run([buy('2026-03-02', 50, 20), buy('2026-03-05', 50, 20), sell('2026-03-12', 50, 10)])
  assert.equal(r.pieces[0].disallowed, 50000)
  assert.equal(r.pieces[0].replacements[0].acquired, '2026-03-05')
  assert.equal(notes(r).length, 0, 'different days are different purchases; nothing to flag')
})

test('a purchase in another account still counts as a replacement', () => {
  const r = run([buy('2026-03-02', 100, 20), buy('2026-03-05', 50, 20, { accountId: 'sch' }), sell('2026-03-12', 50, 10)])
  assert.equal(r.pieces[0].disallowed, 50000)
  assert.equal(r.pieces[0].replacements[0].accountId, 'sch')
})

test('a real replacement bought after the sale is matched, not the kept shares', () => {
  const r = run([buy('2026-03-02', 100, 20), sell('2026-03-12', 50, 10), buy('2026-03-20', 30, 9)])
  const p = r.pieces[0]
  assert.equal(p.disallowed, 30000, 'only the 30 re-bought shares')
  assert.equal(p.replacements.length, 1)
  assert.equal(p.replacements[0].acquired, '2026-03-20')
  assert.equal(p.gain, -20000)
  // The strict reading would have matched the 50 kept shares first.
  assert.equal(run([buy('2026-03-02', 100, 20), sell('2026-03-12', 50, 10), buy('2026-03-20', 30, 9)], { countSamePurchase: true }).pieces[0].replacements[0].acquired, '2026-03-02')
})

test('an older lot plus a recent purchase: the recent purchase washes the old lot, not itself', () => {
  const r = run([buy('2026-01-05', 20, 20), buy('2026-03-02', 100, 20), sell('2026-03-12', 70, 10)])
  const [oldPiece, newPiece] = r.pieces
  assert.equal(oldPiece.acquired, '2026-01-05')
  assert.equal(oldPiece.disallowed, 20000, 'the old lot’s 20 shares are replaced by 20 of the 50 March shares kept')
  assert.equal(oldPiece.replacements[0].acquired, '2026-03-02')
  assert.equal(newPiece.acquired, '2026-03-02')
  assert.equal(newPiece.disallowed, 0, 'the March shares sold are not washed by the March shares kept (30 would be, strictly)')
  assert.equal(run([buy('2026-01-05', 20, 20), buy('2026-03-02', 100, 20), sell('2026-03-12', 70, 10)], { countSamePurchase: true }).pieces[1].disallowed, 30000)
})

test('one order reported as several fills: no order number means separate purchases, with a note showing both figures', () => {
  const r = run([buy('2026-03-02', 25, 20), buy('2026-03-02', 25, 20), sell('2026-03-12', 25, 10)])
  assert.equal(r.pieces[0].disallowed, 25000, 'number unchanged: the second row counts as a replacement')
  const n = notes(r)
  assert.equal(n.length, 1)
  assert.match(n[0].message, /\$250\.00 disallowed here, \$0\.00 if one purchase/)
  assert.match(n[0].message, /order_id/)
})

test('fills that share an order number are one purchase', () => {
  const r = run([buy('2026-03-02', 25, 20, { orderId: 'A1' }), buy('2026-03-02', 25, 20, { orderId: 'A1' }), sell('2026-03-12', 25, 10)])
  assert.equal(r.pieces[0].disallowed, 0)
  assert.equal(notes(r).length, 0)
})

test('different order numbers are different purchases and need no note', () => {
  const r = run([buy('2026-03-02', 25, 20, { orderId: 'A1' }), buy('2026-03-02', 25, 20, { orderId: 'A2' }), sell('2026-03-12', 25, 10)])
  assert.equal(r.pieces[0].disallowed, 25000)
  assert.equal(notes(r).length, 0)
})

test('an order number on only one of two rows is not enough to merge them', () => {
  const r = run([buy('2026-03-02', 25, 20, { orderId: 'A1' }), buy('2026-03-02', 25, 20), sell('2026-03-12', 25, 10)])
  assert.equal(r.pieces[0].disallowed, 25000)
  assert.equal(notes(r).length, 1)
})

test('an order number is not trusted across days or accounts', () => {
  const sameId = (extra: Partial<Txn> & { accountId?: string }) => run([buy('2026-03-02', 25, 20, { orderId: 'A1' }), buy('2026-03-03', 25, 20, { orderId: 'A1', ...extra }), sell('2026-03-12', 25, 10)])
  assert.equal(sameId({}).pieces[0].disallowed, 25000, 'a different day')
  const other = run([buy('2026-03-02', 25, 20, { orderId: 'A1' }), buy('2026-03-02', 25, 20, { orderId: 'A1', accountId: 'sch' }), sell('2026-03-12', 25, 10)])
  assert.equal(other.pieces[0].disallowed, 25000, 'a different account')
})

test('shares that carry a deferred loss keep the strict reading, with both figures shown', () => {
  // 100 sold at a $1,000 loss, re-bought in one 200-share purchase: 100 of it absorbs the loss. Selling that 100 while
  // keeping the other 100 of the same purchase is not what the ruling addresses.
  const tx = [buy('2026-01-05', 100, 20), sell('2026-03-01', 100, 10), buy('2026-03-05', 200, 12), sell('2026-03-20', 100, 6)]
  const r = run(tx)
  const [first, second] = r.pieces
  assert.equal(first.disallowed, 100000)
  assert.equal(second.carriedIn, 100000)
  assert.equal(second.disallowed, 160000, 'unchanged from the strict reading')
  const n = notes(r)
  assert.equal(n.length, 1)
  assert.match(n[0].message, /\$1,600\.00 disallowed\. If the ruling applied, \$0\.00 would be/)
  assert.equal(n[0].date, '2026-03-20')
})

test('a gain on part of one purchase, and sales with no loss, are untouched', () => {
  const r = run([buy('2026-03-02', 100, 20), sell('2026-03-12', 50, 30)])
  assert.equal(r.pieces[0].disallowed, 0)
  assert.equal(notes(r).length, 0)
})

test('the 1099-B check shows what a broker applying the strict reading could add', () => {
  const tx = [buy('2026-03-02', 100, 20), sell('2026-03-12', 50, 10)]
  const full = run(tx)
  const broker = brokerView(tx, ACCTS, DEFAULT_SETTINGS)
  const strict = brokerView(tx, ACCTS, DEFAULT_SETTINGS, { countSamePurchase: true })
  const line = reconcile(full, broker, ACCTS, 2026, { rh: 50000 }, strict).find(l => l.accountId === 'rh')!
  assert.equal(line.ours, 0)
  assert.equal(line.broker, 0)
  assert.equal(line.samePurchase, 50000)
  assert.equal(line.knockOn, 0)
  assert.equal(line.unexplained, 50000, 'a box 1g of $500 differs from the replica by exactly that amount')
  // Without the strict run there is nothing to show, and nothing breaks.
  assert.equal(reconcile(full, broker, ACCTS, 2026, {}).find(l => l.accountId === 'rh')!.samePurchase, 0)
})

test('the strict view adds nothing when no purchase was partly sold', () => {
  const tx = [buy('2026-03-02', 50, 20), buy('2026-03-05', 50, 20), sell('2026-03-12', 50, 10)]
  const line = reconcile(run(tx), brokerView(tx, ACCTS, DEFAULT_SETTINGS), ACCTS, 2026, {}, brokerView(tx, ACCTS, DEFAULT_SETTINGS, { countSamePurchase: true })).find(l => l.accountId === 'rh')!
  assert.equal(line.samePurchase, 0)
  assert.equal(line.broker, 50000)
})

test('totals are conserved: proceeds, cost and disallowed + allowed loss add up either way', () => {
  const tx = [buy('2026-01-05', 100, 20), buy('2026-03-02', 100, 20), sell('2026-03-12', 140, 10), buy('2026-03-25', 20, 9)]
  for (const opts of [{}, { countSamePurchase: true }]) {
    const r = run(tx, opts)
    assert.equal(r.pieces.reduce((s, p) => s + p.qty, 0), 140)
    assert.equal(r.pieces.reduce((s, p) => s + p.proceeds, 0), 140000)
    assert.equal(r.pieces.reduce((s, p) => s + p.cost, 0), 100 * 2000 + 40 * 2000)
    const basis = r.lots.filter(l => !l.closedBy).reduce((s, l) => s + l.adj, 0)
    assert.equal(basis, r.pieces.reduce((s, p) => s + p.disallowed, 0), 'every disallowed cent sits in a replacement lot')
  }
})

test('generic CSV: an order_id column is read onto buy rows only', () => {
  const text = ['date,action,symbol,quantity,price,order_id', '2026-03-02,buy,XYZ,25,20,A1', '2026-03-02,buy,XYZ,25,20,A1', '2026-03-12,sell,XYZ,25,10,A9'].join('\n')
  const csv = trades(parseCsv(text))
  const d = detect(csv.rows)
  const v = validate(csv, d.map, d.headerRow)
  assert.equal(v.issues.filter(i => !i.level || i.level === 'error').length, 0)
  const txns = mergeImport([], 'rh', v.rows)
  assert.deepEqual(txns.filter(t => t.kind === 'buy').map(t => t.orderId), ['A1', 'A1'])
  assert.equal(txns.find(t => t.kind === 'sell')!.orderId, undefined)
  const r = runWash(txns, ACCTS, DEFAULT_SETTINGS)
  assert.equal(r.pieces[0].disallowed, 0, 'the two fills are one purchase end to end')
  // Without the column the same rows are separate purchases.
  const bare = ['date,action,symbol,quantity,price', '2026-03-02,buy,XYZ,25,20', '2026-03-02,buy,XYZ,25,20', '2026-03-12,sell,XYZ,25,10'].join('\n')
  const c2 = trades(parseCsv(bare)); const d2 = detect(c2.rows)
  assert.equal(runWash(mergeImport([], 'rh', validate(c2, d2.map, d2.headerRow).rows), ACCTS, DEFAULT_SETTINGS).pieces[0].disallowed, 25000)
})
