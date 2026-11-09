import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addYears, isLongTerm, parseDate, parseNum } from './dates.ts'
import { brokerView, chainOf, form8949Rows, groupOf, reconcile, released, runWash, summarize } from './wash.ts'
import { DEFAULT_SETTINGS, type Account, type Settings, type Txn } from './types.ts'

const RH: Account = { id: 'rh', name: 'Robinhood', broker: 'robinhood', type: 'taxable' }
const SCH: Account = { id: 'sch', name: 'Schwab', broker: 'schwab', type: 'taxable' }
const IRA: Account = { id: 'ira', name: 'Fidelity IRA', broker: 'fidelity', type: 'ira' }
const ROTH: Account = { id: 'roth', name: 'Roth', broker: 'fidelity', type: 'roth' }
const ACCTS = [RH, SCH, IRA, ROTH]

let seq = 0
const buy = (date: string, qty: number, price: number, sym = 'XYZ', accountId = 'rh', extra: Partial<Txn> = {}): Txn => ({ id: `t${++seq}`, seq, accountId, date, kind: 'buy', symbol: sym, qty, amount: Math.round(qty * price * 100), ...extra })
const sell = (date: string, qty: number, price: number, sym = 'XYZ', accountId = 'rh', extra: Partial<Txn> = {}): Txn => ({ id: `t${++seq}`, seq, accountId, date, kind: 'sell', symbol: sym, qty, amount: Math.round(qty * price * 100), ...extra })
const run = (txns: Txn[], s: Settings = DEFAULT_SETTINGS) => runWash(txns, ACCTS, s)

// ---------- dates and numbers ----------

test('addYears handles Feb 29 and the one-year holding boundary', () => {
  assert.equal(addYears('2024-02-29', 1), '2025-02-28')
  assert.equal(isLongTerm('2024-03-01', '2025-03-01'), false)
  assert.equal(isLongTerm('2024-03-01', '2025-03-02'), true)
})

test('parseDate reads broker date formats', () => {
  assert.equal(parseDate('1/2/2025'), '2025-01-02')
  assert.equal(parseDate('01/02/25'), '2025-01-02')
  assert.equal(parseDate('20250102'), '2025-01-02')
  assert.equal(parseDate('20250102;093000'), '2025-01-02')
  assert.equal(parseDate('11/03/2025 as of 11/01/2025'), '2025-11-03')
  assert.equal(parseDate('2025-13-01'), null)
  assert.equal(parseDate('Disclaimer text'), null)
})

test('parseNum reads accounting negatives, dollar signs and trailing minus', () => {
  assert.equal(parseNum('($1,234.56)'), -1234.56)
  assert.equal(parseNum('$1,234.56'), 1234.56)
  assert.equal(parseNum('12.5-'), -12.5)
  assert.ok(Number.isNaN(parseNum('')))
  assert.ok(Number.isNaN(parseNum('abc')))
})

// ---------- basics ----------

test('a gain is never a wash sale, even with a rebuy', () => {
  const r = run([buy('2025-01-02', 10, 100), sell('2025-02-01', 10, 120), buy('2025-02-05', 10, 118)])
  assert.equal(r.pieces[0].gain, 20000)
  assert.equal(r.pieces[0].disallowed, 0)
})

test('a loss with no repurchase in the window is fully allowed', () => {
  const r = run([buy('2025-01-02', 10, 100), sell('2025-03-01', 10, 80)])
  assert.equal(r.pieces[0].gain, -20000)
  assert.equal(r.pieces[0].disallowed, 0)
})

test('rebuy 30 days after a loss is a wash sale; day 31 is not', () => {
  const a = run([buy('2025-01-02', 10, 100), sell('2025-03-01', 10, 80), buy('2025-03-31', 10, 82)])
  assert.equal(a.pieces[0].disallowed, 20000)
  const b = run([buy('2025-01-02', 10, 100), sell('2025-03-01', 10, 80), buy('2025-04-01', 10, 82)])
  assert.equal(b.pieces[0].disallowed, 0)
})

test('disallowed loss moves into the replacement basis and the holding period tacks on', () => {
  const r = run([buy('2025-01-02', 10, 100), sell('2025-03-01', 10, 80), buy('2025-03-10', 10, 82)])
  const p = r.pieces[0]
  assert.equal(p.disallowed, 20000)
  assert.equal(p.gain, 0)
  const rep = r.lots.find(l => l.id === p.replacements[0].lotId)!
  assert.equal(rep.cost, 82000 + 20000)
  assert.equal(rep.adj, 20000)
  // Held Jan 2 to Mar 1 = 58 days, so the replacement counts as held from Jan 11.
  assert.equal(rep.holdingStart, '2025-01-11')
})

test('buying more within 30 days before the loss sale (doubling up) is a wash sale', () => {
  const r = run([buy('2025-01-02', 10, 100), buy('2025-02-15', 10, 85), sell('2025-03-01', 10, 80)])
  assert.equal(r.pieces.length, 1)
  assert.equal(r.pieces[0].acquired, '2025-01-02')
  assert.equal(r.pieces[0].disallowed, 20000)
})

test('the shares sold are never their own replacement', () => {
  const r = run([buy('2025-02-10', 10, 100), sell('2025-02-20', 10, 90)])
  assert.equal(r.pieces[0].disallowed, 0)
})

test('selling every lot in one sale leaves nothing to replace', () => {
  const r = run([buy('2025-02-01', 10, 100), buy('2025-02-10', 5, 95), sell('2025-02-20', 15, 80)])
  assert.equal(r.pieces.length, 2)
  assert.ok(r.pieces.every(p => p.disallowed === 0))
})

test('partial wash sale: 30 replacement shares disallow 30% of a 100 share loss', () => {
  const r = run([buy('2025-01-02', 100, 50), sell('2025-02-15', 100, 40), buy('2025-03-01', 30, 41)])
  assert.equal(r.pieces[0].disallowed, 30000)
  assert.equal(r.pieces[0].gain, -70000)
})

test('more replacement shares than loss shares: only the shares needed are adjusted', () => {
  const r = run([buy('2025-01-02', 10, 50), sell('2025-02-15', 10, 40), buy('2025-03-01', 25, 41)])
  const adjusted = r.lots.filter(l => l.adj > 0)
  assert.equal(adjusted.length, 1)
  assert.equal(adjusted[0].qty, 10)
  const rest = r.lots.find(l => l.acquired === '2025-03-01' && l.adj === 0)!
  assert.equal(rest.qty, 15)
  assert.equal(rest.cost, 15 * 41 * 100)
})

test('replacement shares are matched in the order they were acquired', () => {
  const r = run([buy('2025-01-02', 10, 50), sell('2025-02-15', 10, 40), buy('2025-02-20', 4, 41), buy('2025-03-01', 10, 42)])
  const reps = r.pieces[0].replacements
  assert.deepEqual(reps.map(x => [x.acquired, x.qty]), [['2025-02-20', 4], ['2025-03-01', 6]])
  assert.equal(reps[0].amount + reps[1].amount, 10000)
})

test('loss shares are matched in the order they were acquired within one sale', () => {
  const r = run([buy('2025-01-02', 10, 50), buy('2025-01-10', 10, 48), sell('2025-02-15', 20, 40), buy('2025-02-20', 10, 41)])
  assert.equal(r.pieces[0].acquired, '2025-01-02')
  assert.equal(r.pieces[0].disallowed, 10000)
  assert.equal(r.pieces[1].disallowed, 0)
})

test('each replacement share is used only once', () => {
  const r = run([buy('2025-01-02', 10, 50), buy('2025-01-03', 10, 50, 'XYZ', 'sch'), sell('2025-02-10', 10, 40), sell('2025-02-11', 10, 40, 'XYZ', 'sch'), buy('2025-02-20', 10, 41)])
  assert.equal(r.pieces[0].disallowed, 10000)
  assert.equal(r.pieces[1].disallowed, 0)
})

test('a later purchase on the same day as the sale still counts', () => {
  const r = run([buy('2025-01-02', 10, 50), sell('2025-02-10', 10, 40), buy('2025-02-10', 10, 39.5)])
  assert.equal(r.pieces[0].disallowed, 10000)
})

test('gain lots in a mixed sale are untouched while loss lots are washed', () => {
  const r = run([buy('2025-01-02', 10, 30), buy('2025-01-20', 10, 60), sell('2025-02-10', 20, 45), buy('2025-02-12', 10, 44)])
  assert.equal(r.pieces[0].gain, 15000)
  assert.equal(r.pieces[0].disallowed, 0)
  assert.equal(r.pieces[1].disallowed, 15000)
})

// ---------- chains and release ----------

test('chained wash sales carry the loss forward and the final sale releases it all', () => {
  const r = run([
    buy('2025-01-02', 10, 50), sell('2025-02-03', 10, 40), // -100, washed
    buy('2025-02-10', 10, 42), sell('2025-03-03', 10, 38), // -40 own, +100 carried, washed
    buy('2025-03-12', 10, 39), sell('2025-06-02', 10, 35), // final: no rebuy
  ])
  const [a, b, c] = r.pieces
  assert.equal(a.disallowed, 10000)
  assert.equal(b.carriedIn, 10000)
  assert.equal(b.disallowed, 14000)
  assert.equal(c.carriedIn, 14000)
  assert.equal(c.disallowed, 0)
  assert.equal(c.gain, 35000 - 39000 - 14000)
  assert.equal(released(c), 14000)
  // Total loss over the round trips equals the economic loss.
  assert.equal(r.pieces.reduce((s, p) => s + p.gain, 0), (40000 + 38000 + 35000) - (50000 + 42000 + 39000))
})

test('a wash sale stays a wash sale: the deferred loss sits in basis until the replacement is sold', () => {
  const r = run([buy('2025-01-02', 10, 50), sell('2025-02-03', 10, 40), buy('2025-02-10', 10, 42)])
  const s = summarize(r, 2025)
  assert.equal(s.disallowed, 10000)
  assert.equal(s.deferredOut, 10000)
  assert.equal(s.released, 0)
})

test('a December loss washed by a January buy crosses tax years', () => {
  const r = run([buy('2025-06-02', 10, 50), sell('2025-12-20', 10, 40), buy('2026-01-05', 10, 41), sell('2026-03-02', 10, 45)])
  const y25 = summarize(r, 2025), y26 = summarize(r, 2026)
  assert.equal(y25.disallowed, 10000)
  assert.equal(y25.deferredOut, 10000)
  assert.equal(y26.released, 10000)
  assert.equal(y26.net, 45000 - 41000 - 10000)
})

test('tacked holding period can turn the replacement sale long-term', () => {
  const r = run([buy('2024-01-02', 10, 50), sell('2024-11-01', 10, 40), buy('2024-11-15', 10, 41), sell('2025-03-01', 10, 45)])
  const last = r.pieces[1]
  assert.equal(last.term, 'long')
  assert.equal(r.pieces[0].term, 'short')
})

test('chainOf traces back to the origin and forward to release', () => {
  const r = run([buy('2025-01-02', 10, 50), sell('2025-02-03', 10, 40), buy('2025-02-10', 10, 42), sell('2025-03-03', 10, 38), buy('2025-03-12', 10, 39), sell('2025-06-02', 10, 35)])
  const fwd = chainOf(r, r.pieces[0].id).forward
  assert.deepEqual(fwd.map(f => f.to?.sold ?? null), ['2025-03-03', '2025-06-02'])
  assert.deepEqual(chainOf(r, r.pieces[2].id).back.map(p => p.sold), ['2025-02-03', '2025-03-03'])
})

// ---------- across accounts ----------

test('a buy in another taxable account triggers a wash sale the broker cannot see', () => {
  const tx = [buy('2025-01-02', 10, 50), sell('2025-02-03', 10, 40), buy('2025-02-10', 10, 41, 'XYZ', 'sch')]
  const r = run(tx)
  assert.equal(r.pieces[0].disallowed, 10000)
  assert.equal(r.pieces[0].replacements[0].accountId, 'sch')
  const b = brokerView(tx, ACCTS, DEFAULT_SETTINGS)
  assert.equal(b.pieces.filter(p => p.accountId === 'rh')[0].disallowed, 0)
})

test('IRA replacement: loss permanently disallowed and IRA basis unchanged (Rev. Rul. 2008-5)', () => {
  const r = run([buy('2025-01-02', 10, 50), sell('2025-02-03', 10, 40), buy('2025-02-10', 10, 41, 'XYZ', 'ira')])
  const p = r.pieces[0]
  assert.equal(p.disallowed, 10000)
  assert.equal(p.permanent, 10000)
  const lot = r.lots.find(l => l.accountId === 'ira')!
  assert.equal(lot.cost, 41000)
  assert.equal(summarize(r, 2025).deferredOut, 0)
})

test('Roth purchases are treated like IRA purchases', () => {
  const r = run([buy('2025-01-02', 10, 50), sell('2025-02-03', 10, 40), buy('2025-01-20', 5, 45, 'XYZ', 'roth')])
  assert.equal(r.pieces[0].permanent, 5000)
})

test('sales inside an IRA are not reported and cannot be wash sales', () => {
  const r = run([buy('2025-01-02', 10, 50, 'XYZ', 'ira'), sell('2025-02-03', 10, 40, 'XYZ', 'ira'), buy('2025-02-04', 10, 40, 'XYZ', 'ira')])
  assert.equal(r.pieces.length, 0)
})

// ---------- substantially identical ----------

test('different tickers are not substantially identical by default', () => {
  const r = run([buy('2025-01-02', 10, 500, 'VOO'), sell('2025-02-03', 10, 450, 'VOO'), buy('2025-02-04', 10, 460, 'IVV')])
  assert.equal(r.pieces[0].disallowed, 0)
})

test('a user equivalence list makes tickers wash each other', () => {
  const s: Settings = { ...DEFAULT_SETTINGS, equivalents: [['VOO', 'ivv']] }
  assert.equal(groupOf('IVV', s), 'IVV|VOO')
  const r = run([buy('2025-01-02', 10, 500, 'VOO'), sell('2025-02-03', 10, 450, 'VOO'), buy('2025-02-04', 10, 460, 'IVV')], s)
  assert.equal(r.pieces[0].disallowed, 50000)
})

// ---------- lots, splits and limitations ----------

test('FIFO sells the oldest lot first and specific-ID can pick a lot', () => {
  const tx = [buy('2025-01-02', 10, 50), buy('2025-03-02', 10, 30), sell('2025-05-01', 10, 40, 'XYZ', 'rh', { lotDate: '2025-03-02' })]
  assert.equal(run(tx).pieces[0].acquired, '2025-01-02')
  assert.equal(run(tx, { ...DEFAULT_SETTINGS, method: 'specific' }).pieces[0].acquired, '2025-03-02')
})

test('a split given as added shares multiplies quantity and keeps total basis', () => {
  const r = run([buy('2025-01-02', 10, 400), { id: 'sp', seq: ++seq, accountId: 'rh', date: '2025-06-10', kind: 'split', symbol: 'XYZ', qty: 30, amount: 0 }, sell('2025-07-01', 40, 120)])
  assert.equal(r.pieces[0].qty, 40)
  assert.equal(r.pieces[0].cost, 400000)
  assert.equal(r.pieces[0].gain, 80000)
})

test('a split given as a ratio works too', () => {
  const r = run([buy('2025-01-02', 3, 300), { id: 'sp2', seq: ++seq, accountId: 'rh', date: '2025-06-10', kind: 'split', symbol: 'XYZ', qty: 0, ratio: 10, amount: 0 }, sell('2025-07-01', 30, 25)])
  assert.equal(r.pieces[0].qty, 30)
  assert.equal(r.limitations.length, 0)
})

test('selling shares with no purchase history is flagged, not invented', () => {
  const r = run([buy('2025-01-02', 5, 50), sell('2025-02-03', 8, 60)])
  assert.equal(r.pieces[0].qty, 5)
  assert.equal(r.pieces[0].proceeds, 30000)
  assert.equal(r.limitations[0].kind, 'unmatched')
})

test('options and basis-less transfers are reported as limitations', () => {
  const r = run([{ id: 'o', seq: ++seq, accountId: 'rh', date: '2025-01-02', kind: 'option', symbol: 'XYZ', qty: 1, amount: 100 }, { id: 'ti', seq: ++seq, accountId: 'rh', date: '2025-01-03', kind: 'transfer_in', symbol: 'ABC', qty: 4, amount: 0 }])
  assert.deepEqual(r.limitations.map(l => l.kind), ['option', 'transfer'])
})

test('fractional shares: the disallowed pieces add up to the whole loss to the cent', () => {
  const r = run([buy('2025-01-02', 1.234567, 333.33), sell('2025-02-03', 1.234567, 290.17), buy('2025-02-04', 0.4, 291), buy('2025-02-05', 0.9, 292)])
  const p = r.pieces[0]
  assert.equal(p.disallowed, p.cost - p.proceeds)
  assert.equal(p.replacements.reduce((s, x) => s + x.qty, 0), 1.234567)
})

// ---------- outputs ----------

test('Form 8949 rows use code W and (h) = (d) - (e) + (g)', () => {
  const r = run([buy('2025-01-02', 10, 50), sell('2025-03-01', 10, 40), buy('2025-03-10', 4, 41)])
  const rows = form8949Rows(r, ACCTS, 2025)
  const row = rows[1]
  assert.equal(row[8], 'W')
  assert.equal(row[9], '40.00')
  assert.equal(row[10], (400 - 500 + 40).toFixed(2))
  assert.equal(row[4], '01/02/2025')
})

test('reconciliation splits our extra disallowed loss into cross-account, IRA and equivalents', () => {
  const s: Settings = { ...DEFAULT_SETTINGS, equivalents: [['VOO', 'IVV']] }
  const tx = [
    buy('2025-01-02', 10, 50), sell('2025-02-03', 10, 40), buy('2025-02-10', 10, 41, 'XYZ', 'sch'),
    buy('2025-01-02', 10, 30, 'ABC'), sell('2025-02-03', 10, 20, 'ABC'), buy('2025-02-10', 10, 21, 'ABC', 'ira'),
    buy('2025-01-02', 1, 500, 'VOO'), sell('2025-04-01', 1, 450, 'VOO'), buy('2025-04-02', 1, 455, 'IVV'),
    buy('2025-05-01', 10, 10, 'QQQ'), sell('2025-06-01', 10, 9, 'QQQ'), buy('2025-06-05', 10, 9, 'QQQ'),
  ]
  const full = runWash(tx, ACCTS, s)
  const line = reconcile(full, brokerView(tx, ACCTS, s), ACCTS, 2025, { rh: 1200 }).find(l => l.accountId === 'rh')!
  assert.equal(line.broker, 1000)
  assert.equal(line.crossAccount, 10000)
  assert.equal(line.ira, 10000)
  assert.equal(line.equivalents, 5000)
  assert.equal(line.knockOn, 0)
  assert.equal(line.ours, 26000)
  assert.equal(line.unexplained, 200)
})
