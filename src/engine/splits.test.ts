import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect, mergeImport, parseCsv, validate } from './importer.ts'
import { DEFAULT_SETTINGS, type Account, type Txn } from './types.ts'
import { brokerView, form8949Rows, reconcile, runWash, summarize } from './wash.ts'

// Splits between a sale and its replacement shares: share counts are compared in one unit (issue #4).

const RH: Account = { id: 'rh', name: 'Robinhood', broker: 'robinhood', type: 'taxable' }
const SCH: Account = { id: 'sch', name: 'Schwab', broker: 'schwab', type: 'taxable' }
const ACCTS = [RH, SCH]

let seq = 0
const buy = (date: string, qty: number, price: number, accountId = 'rh', sym = 'XYZ'): Txn => ({ id: `t${++seq}`, seq, accountId, date, kind: 'buy', symbol: sym, qty, amount: Math.round(qty * price * 100) })
const sell = (date: string, qty: number, price: number, accountId = 'rh', sym = 'XYZ'): Txn => ({ id: `t${++seq}`, seq, accountId, date, kind: 'sell', symbol: sym, qty, amount: Math.round(qty * price * 100) })
/** A split row: `ratio` for the ratio format, or the shares added for the added-share format. */
const split = (date: string, how: { ratio: number } | { added: number }, accountId = 'rh', sym = 'XYZ'): Txn =>
  ({ id: `t${++seq}`, seq, accountId, date, kind: 'split', symbol: sym, qty: 'added' in how ? how.added : 0, amount: 0, ...('ratio' in how ? { ratio: how.ratio } : {}) })
const run = (txns: Txn[]) => runWash(txns, ACCTS, DEFAULT_SETTINGS)
const disallowed = (txns: Txn[]) => run(txns).pieces.reduce((s, p) => s + p.disallowed, 0)

// 100 shares bought for $20 and sold for $10: a $1,000 loss.
const BUY = () => buy('2026-01-05', 100, 20)
const SELL = () => sell('2026-03-02', 100, 10)

test('a 2-for-1 split between sale and replacement: 100 new shares replace 50 sold shares', () => {
  const r = run([BUY(), SELL(), split('2026-03-05', { ratio: 2 }), buy('2026-03-10', 100, 5)])
  const p = r.pieces[0]
  assert.equal(p.disallowed, 50000)
  assert.deepEqual(p.replacements.map(x => [x.qty, x.lotQty]), [[50, 100]])
  // It matches the same trades with no split: 50 shares bought after the sale.
  assert.equal(disallowed([BUY(), SELL(), buy('2026-03-10', 50, 10)]), 50000)
})

test('the replacement basis, the unreplaced rest and Form 8949 reconcile to the cent', () => {
  const r = run([BUY(), SELL(), split('2026-03-05', { ratio: 2 }), buy('2026-03-10', 100, 5)])
  const p = r.pieces[0]
  assert.equal(p.cost - p.proceeds, 100000)
  assert.equal(p.disallowed, 50000)
  assert.equal(p.gain, -50000)
  // The 100 new shares cost $500 and all replace sold shares: their basis becomes $500 + the $500 disallowed.
  assert.deepEqual(r.lots.filter(l => l.acquired === '2026-03-10').map(l => [l.qty, l.cost, l.adj]), [[100, 100000, 50000]])
  const row = form8949Rows(r, ACCTS, 2026)[1]
  assert.deepEqual([row[3], row[6], row[7], row[8], row[9], row[10]], ['100 sh XYZ', '1000.00', '2000.00', 'W', '500.00', '-500.00'])
  assert.equal(summarize(r, 2026).disallowed, 50000)
})

test('more new shares than needed: the lot is split in its own shares and the basis follows the cent', () => {
  // 300 new shares cost $1,500. The 100 sold shares need 200 of them; that 2/3 takes $1,000 plus the whole $1,000 loss.
  const r = run([BUY(), SELL(), split('2026-03-05', { ratio: 2 }), buy('2026-03-10', 300, 5)])
  const p = r.pieces[0]
  assert.equal(p.disallowed, 100000)
  assert.deepEqual(p.replacements.map(x => [x.qty, x.lotQty]), [[100, 200]])
  assert.deepEqual(r.lots.filter(l => l.acquired === '2026-03-10').map(l => [l.qty, l.cost, l.adj]), [[200, 200000, 100000], [100, 50000, 0]])
  assert.equal(r.lots.filter(l => l.acquired === '2026-03-10').reduce((s, l) => s + l.cost, 0), 150000 + 100000, 'basis added once')
})

test('the added-share format gives the same answer as the ratio format', () => {
  // 200 bought, 100 sold at a loss of $500 ($10 to $5). 100 shares are held at the split, so +100 added means 2-for-1.
  const trades = (how: { ratio: number } | { added: number }) => [buy('2026-01-05', 200, 10), sell('2026-03-02', 100, 5), split('2026-03-05', how), buy('2026-03-10', 100, 4)]
  assert.equal(disallowed(trades({ added: 100 })), 25000)
  assert.equal(disallowed(trades({ ratio: 2 })), 25000)
})

test('an added-share split with nothing held and no ratio is not guessed: it is reported', () => {
  const r = run([BUY(), SELL(), split('2026-03-05', { added: 100 }), buy('2026-03-10', 100, 5)])
  assert.ok(r.limitations.some(l => l.kind === 'split' && /no ratio is given/.test(l.message)))
  assert.equal(r.pieces[0].disallowed, 100000, 'unchanged from the unadjusted count, and flagged')
})

test('a reverse split: 10 new shares replace 100 sold shares, 5 replace 50', () => {
  const trades = (qty: number) => [BUY(), SELL(), split('2026-03-05', { ratio: 0.1 }), buy('2026-03-10', qty, 100)]
  assert.equal(disallowed(trades(10)), 100000)
  assert.equal(disallowed(trades(5)), 50000)
  assert.equal(disallowed(trades(20)), 100000, 'never more than the loss')
  assert.equal(run(trades(5)).pieces[0].replacements[0].qty, 50)
})

test('a reverse split given as shares removed (negative quantity) measures against shares held', () => {
  // 50 are still held at the split; removing 45 is 1-for-10.
  const r = run([buy('2026-01-05', 100, 20), sell('2026-03-02', 50, 10), split('2026-03-05', { added: -45 }), buy('2026-03-10', 2, 100)])
  assert.equal(r.pieces[0].replacements[0].qty, 20)
  assert.equal(r.pieces[0].disallowed, 20000, '20 of 50 shares replaced')
  assert.deepEqual(r.lots.filter(l => !l.closedBy && l.acquired === '2026-01-05').map(l => l.qty), [5])
})

test('a split removing more shares than are held is ignored and reported, not turned into a negative count', () => {
  const r = run([buy('2026-01-05', 10, 20), split('2026-03-05', { added: -50 }), sell('2026-04-01', 10, 10)])
  assert.ok(r.limitations.some(l => l.kind === 'split' && /50 shares removed against 10 held/.test(l.message)))
  assert.equal(r.pieces[0].qty, 10)
})

test('a replacement bought before the sale, with a split between the two, is counted in sale-date shares', () => {
  const r = run([buy('2026-01-05', 100, 20), buy('2026-02-01', 100, 10), split('2026-02-05', { ratio: 2 }), sell('2026-02-10', 200, 5)])
  // FIFO sells the January lot (200 shares after the split); the February lot (200 shares) is all replacement.
  assert.equal(r.pieces[0].qty, 200)
  assert.equal(r.pieces[0].disallowed, 100000)
  assert.equal(r.pieces[0].disallowed, r.pieces[0].cost - r.pieces[0].proceeds)
})

test('a replacement bought after the sale and before a later split is not rescaled', () => {
  const r = run([BUY(), SELL(), buy('2026-03-10', 100, 10), split('2026-03-20', { ratio: 2 })])
  assert.equal(r.pieces[0].disallowed, 100000)
  assert.deepEqual(r.pieces[0].replacements.map(x => [x.qty, x.lotQty]), [[100, undefined]])
  // The later split does scale what is held afterwards.
  assert.deepEqual(r.lots.filter(l => !l.closedBy).map(l => l.qty), [200])
})

test('several splits between sale and replacement multiply: 2-for-1 then 3-for-1 makes 600 shares replace 100', () => {
  const trades = (qty: number) => [BUY(), SELL(), split('2026-03-05', { ratio: 2 }), split('2026-03-12', { ratio: 3 }), buy('2026-03-20', qty, 1)]
  assert.equal(disallowed(trades(300)), 50000)
  assert.equal(disallowed(trades(600)), 100000)
  // A buy between the two splits is only scaled by the second.
  assert.equal(disallowed([BUY(), SELL(), split('2026-03-05', { ratio: 2 }), buy('2026-03-08', 100, 5), split('2026-03-12', { ratio: 3 })]), 50000)
})

test('the same split reported by two accounts scales each account once', () => {
  const trades = [
    buy('2026-01-05', 200, 20), buy('2026-01-06', 100, 20, 'sch'),
    sell('2026-03-02', 100, 10), split('2026-03-05', { ratio: 2 }), split('2026-03-05', { ratio: 2 }, 'sch'),
    buy('2026-03-10', 100, 5, 'sch'),
  ]
  const r = run(trades)
  assert.deepEqual(r.limitations, [])
  assert.equal(r.pieces[0].disallowed, 50000)
  assert.equal(r.pieces[0].replacements[0].accountId, 'sch')
  const open = (id: string) => r.lots.filter(l => l.accountId === id && !l.closedBy && l.acquired < '2026-03-01').reduce((s, l) => s + l.qty, 0)
  assert.equal(open('rh'), 200, 'the 100 left after the sale, doubled once')
  assert.equal(open('sch'), 200, '100 doubled once, not twice')
})

test('the added-share format in two accounts is one split, and the ratio is taken from the shares each held', () => {
  const r = run([
    buy('2026-01-05', 200, 20), buy('2026-01-06', 100, 20, 'sch'),
    sell('2026-03-02', 100, 10), split('2026-03-05', { added: 100 }), split('2026-03-05', { added: 100 }, 'sch'),
    buy('2026-03-10', 100, 5, 'sch'),
  ])
  assert.deepEqual(r.limitations, [])
  assert.equal(r.pieces[0].disallowed, 50000)
})

test('an account with no shares to measure an added-share split borrows the ratio from another account', () => {
  const r = run([
    buy('2026-01-05', 100, 20), sell('2026-03-02', 100, 10), buy('2026-01-06', 100, 20, 'sch'),
    split('2026-03-05', { added: 100 }, 'rh'), split('2026-03-05', { added: 100 }, 'sch'), buy('2026-03-10', 100, 5),
  ])
  assert.deepEqual(r.limitations, [])
  assert.equal(r.pieces[0].disallowed, 50000)
})

test('a split known in one account but missing from another that holds the stock is reported, not guessed', () => {
  const r = run([buy('2026-01-05', 100, 20), buy('2026-01-06', 100, 20, 'sch'), sell('2026-03-02', 100, 10), split('2026-03-05', { ratio: 2 }), buy('2026-03-10', 100, 5)])
  const lim = r.limitations.filter(l => l.kind === 'split')
  assert.equal(lim.length, 1)
  assert.equal(lim[0].accountId, 'sch')
  assert.match(lim[0].message, /Schwab held 100 shares then and reports no split/)
  assert.deepEqual(r.lots.filter(l => l.accountId === 'sch').map(l => l.qty), [100], 'Schwab shares left as reported')
})

test('an account that held nothing at the split needs no split row: it is a replacement bought after it', () => {
  const r = run([BUY(), SELL(), split('2026-03-05', { ratio: 2 }), buy('2026-03-10', 100, 5, 'sch')])
  assert.deepEqual(r.limitations, [])
  assert.equal(r.pieces[0].disallowed, 50000)
})

test('different ratios for the same split in two accounts are reported', () => {
  const r = run([buy('2026-01-05', 100, 20), buy('2026-01-06', 100, 20, 'sch'), split('2026-03-05', { ratio: 2 }), split('2026-03-05', { ratio: 3 }, 'sch')])
  assert.ok(r.limitations.some(l => l.kind === 'split' && /2-for-1.*3-for-1|3-for-1.*2-for-1/.test(l.message)))
})

test('a split in another ticker does not scale this one', () => {
  assert.equal(disallowed([BUY(), SELL(), split('2026-03-05', { ratio: 2 }, 'rh', 'OTHER'), buy('2026-03-10', 100, 5)]), 100000)
})

test('a split after the 30-day window does not change the match', () => {
  assert.equal(disallowed([BUY(), SELL(), buy('2026-03-10', 100, 5), split('2026-05-05', { ratio: 2 })]), 100000)
  assert.equal(disallowed([split('2025-12-01', { ratio: 2 }), BUY(), SELL(), buy('2026-03-10', 100, 5)]), 100000)
})

test('the broker view and reconciliation agree on a split inside one account', () => {
  const trades = [BUY(), SELL(), split('2026-03-05', { ratio: 2 }), buy('2026-03-10', 100, 5)]
  const full = run(trades)
  const broker = brokerView(trades, ACCTS, DEFAULT_SETTINGS)
  assert.equal(broker.pieces[0].disallowed, 50000)
  const line = reconcile(full, broker, ACCTS, 2026, { rh: 50000 }).find(l => l.accountId === 'rh')!
  assert.deepEqual([line.ours, line.broker, line.knockOn, line.unexplained], [50000, 50000, 0, 0])
})

test('a split gives the same totals whichever order the file lists its rows', () => {
  const trades = [BUY(), SELL(), split('2026-03-05', { ratio: 2 }), buy('2026-03-10', 100, 5)]
  assert.equal(disallowed([...trades].reverse()), 50000)
})

test('no split, no change: the same trades without a split match as before', () => {
  assert.equal(disallowed([BUY(), SELL(), buy('2026-03-10', 100, 10)]), 100000)
  assert.equal(disallowed([BUY(), SELL(), buy('2026-03-10', 30, 10)]), 30000)
})

test('importer: a negative split quantity is kept as shares removed; a reverse split code with only a positive quantity is flagged', () => {
  const read = (text: string) => { const csv = parseCsv(text); const d = detect(csv.rows); return validate(csv, d.map, d.headerRow) }
  const neg = read('date,action,symbol,quantity,price\n2026-01-05,buy,XYZ,100,20\n2026-03-05,split,XYZ,-90,\n')
  assert.deepEqual(neg.rows.map(r => [r.kind, r.qty]), [['buy', 100], ['split', -90]])
  const t = mergeImport([], 'rh', neg.rows)
  assert.equal(runWash(t, ACCTS, DEFAULT_SETTINGS).lots[0].qty, 10)
  const spr = read('date,action,symbol,quantity,price\n2026-01-05,buy,XYZ,100,20\n2026-03-05,SPR,XYZ,90,\n')
  assert.ok(spr.issues.some(i => i.level === 'warn' && /Reverse split of XYZ/.test(i.message)))
  const withRatio = read('date,action,symbol,quantity,price,ratio\n2026-01-05,buy,XYZ,100,20,\n2026-03-05,SPR,XYZ,90,,0.1\n')
  assert.deepEqual(withRatio.issues.filter(i => i.level === 'warn'), [])
})
