import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, type Account, type Txn } from './types.ts'
import { openLots } from './harvest.ts'
import { brokerView, form8949Rows, reconcile, runWash } from './wash.ts'

// Transfers between the user's own accounts are not purchases (issue #5).

const A: Account = { id: 'A', name: 'Account A', broker: 'robinhood', type: 'taxable' }
const B: Account = { id: 'B', name: 'Account B', broker: 'schwab', type: 'taxable' }
const C: Account = { id: 'C', name: 'Account C', broker: 'fidelity', type: 'taxable' }
const IRA: Account = { id: 'IRA', name: 'My IRA', broker: 'fidelity', type: 'ira' }
const ROTH: Account = { id: 'ROTH', name: 'My Roth', broker: 'fidelity', type: 'roth' }
const ACCTS = [A, B, C, IRA, ROTH]

let seq = 0
const row = (kind: Txn['kind'], date: string, qty: number, amount: number, accountId: string, extra: Partial<Txn> = {}): Txn => ({ id: `t${++seq}`, seq, accountId, date, kind, symbol: 'XYZ', qty, amount: Math.round(amount * 100), ...extra })
const buy = (date: string, qty: number, price: number, acc = 'A') => row('buy', date, qty, qty * price, acc)
const sell = (date: string, qty: number, price: number, acc = 'A') => row('sell', date, qty, qty * price, acc)
const out = (date: string, qty: number, acc = 'A') => row('transfer_out', date, qty, 0, acc)
/** A transfer in as the broker importers produce it: quantity only, no cost. */
const tin = (date: string, qty: number, acc = 'B', extra: Partial<Txn> = {}) => row('transfer_in', date, qty, 0, acc, extra)
const run = (txns: Txn[]) => runWash(txns, ACCTS, DEFAULT_SETTINGS)
const disallowed = (txns: Txn[]) => run(txns).pieces.reduce((s, p) => s + p.disallowed, 0)
const msgs = (txns: Txn[]) => run(txns).limitations.map(l => l.message)

// The issue: 200 bought Jan 5, 100 sold at a $1,000 loss Mar 2, the other 100 moved to another own account.
const BASE = () => [buy('2026-01-05', 200, 20), sell('2026-03-02', 100, 10)]

test('moving the remaining shares to another own account is not a replacement purchase', () => {
  const r = run([...BASE(), out('2026-03-05', 100), tin('2026-03-05', 100)])
  assert.equal(r.pieces[0].disallowed, 0)
  assert.deepEqual(r.limitations, [])
  const moved = r.lots.find(l => l.accountId === 'B')!
  assert.deepEqual([moved.acquired, moved.qty, moved.cost, moved.holdingStart], ['2026-01-05', 100, 200000, '2026-01-05'])
})

test('the same with a cost on the transfer in but no lot date (what the issue describes)', () => {
  const r = run([...BASE(), out('2026-03-05', 100), row('transfer_in', '2026-03-05', 100, 2000, 'B')])
  assert.equal(r.pieces[0].disallowed, 0)
  assert.deepEqual(r.limitations, [])
  assert.equal(r.lots.find(l => l.accountId === 'B')!.acquired, '2026-01-05')
})

test('a transfer changes nothing about later sales: the same sale in either account gives the same row', () => {
  // A wash sale first (rebuy Feb 20), so the lot carries a $1,000 adjustment and a tacked holding period.
  const base = [buy('2026-01-05', 100, 20), sell('2026-02-10', 100, 10), buy('2026-02-20', 100, 10)]
  const direct = run([...base, sell('2026-06-01', 100, 12)]).pieces[1]
  const moved = run([...base, out('2026-03-20', 100), tin('2026-03-22', 100), sell('2026-06-01', 100, 12, 'B')]).pieces[1]
  const same = (p: typeof direct) => [p.acquired, p.holdingStart, p.term, p.proceeds, p.cost, p.carriedIn, p.disallowed, p.gain]
  assert.deepEqual(same(moved), same(direct))
  assert.equal(moved.carriedIn, 100000)
  assert.equal(moved.accountId, 'B')
  assert.deepEqual(moved.carriedFrom.map(c => c.amount), [100000])
})

test('shares bought inside the window and then transferred are still replacement shares', () => {
  const r = run([buy('2026-01-05', 100, 20), buy('2026-03-01', 100, 10), sell('2026-03-02', 100, 8), out('2026-03-05', 100), tin('2026-03-06', 100)])
  assert.equal(r.pieces[0].disallowed, 120000)
  // The adjustment travelled with the shares.
  const moved = r.lots.find(l => l.accountId === 'B')!
  assert.deepEqual([moved.acquired, moved.cost, moved.adj], ['2026-03-01', 100000 + 120000, 120000])
})

test('a purchase after the transfer is still a replacement purchase', () => {
  const r = run([...BASE(), out('2026-03-03', 100), tin('2026-03-04', 100), buy('2026-03-10', 100, 10, 'B')])
  assert.equal(r.pieces[0].disallowed, 100000)
  assert.equal(r.pieces[0].replacements[0].accountId, 'B')
})

test('settlement lag: the transfer in may be recorded days after the transfer out, or a day before', () => {
  assert.equal(disallowed([...BASE(), out('2026-03-05', 100), tin('2026-03-15', 100)]), 0)
  assert.equal(disallowed([...BASE(), out('2026-03-05', 100), tin('2026-03-04', 100)]), 0)
  const late = msgs([...BASE(), out('2026-03-05', 100), tin('2026-03-16', 100)])
  assert.equal(late.length, 2, 'both ends reported when they are too far apart to pair')
  assert.match(late.join('\n'), /matches no transfer in/)
  assert.match(late.join('\n'), /no cost basis/)
  assert.equal(msgs([...BASE(), out('2026-03-05', 100), tin('2026-03-01', 100)]).length, 2)
})

test('a partial transfer of one lot splits the lot and the basis to the cent', () => {
  const r = run([row('buy', '2026-01-05', 3, 99.99, 'A'), out('2026-02-01', 1), tin('2026-02-02', 1)])
  const lots = r.lots.map(l => [l.accountId, l.qty, l.cost, l.acquired])
  assert.deepEqual(lots, [['B', 1, 3333, '2026-01-05'], ['A', 2, 6666, '2026-01-05']])
  assert.equal(r.lots.reduce((s, l) => s + l.cost, 0), 9999)
})

test('a transfer spanning several lots carries each lot with its own date and basis', () => {
  const r = run([buy('2026-01-05', 50, 10), buy('2026-02-05', 50, 20), out('2026-03-01', 80), tin('2026-03-03', 80), sell('2026-06-01', 80, 30, 'B')])
  assert.deepEqual(r.pieces.map(p => [p.accountId, p.qty, p.acquired, p.cost]), [['B', 50, '2026-01-05', 50000], ['B', 30, '2026-02-05', 60000]])
  assert.deepEqual(r.limitations, [])
})

test('one transfer out received as two transfers in is split between them oldest lot first', () => {
  const r = run([buy('2026-01-05', 50, 10), buy('2026-02-05', 50, 20), out('2026-03-01', 100), tin('2026-03-03', 60), tin('2026-03-04', 40, 'B')])
  assert.deepEqual(r.lots.filter(l => l.accountId === 'B').map(l => [l.acquired, l.qty, l.arrived]), [['2026-01-05', 50, '2026-03-03'], ['2026-02-05', 10, '2026-03-03'], ['2026-02-05', 40, '2026-03-04']])
  assert.deepEqual(r.limitations, [])
})

test('several transfers out received as one transfer in', () => {
  const r = run([buy('2026-01-05', 50, 10), buy('2026-02-05', 50, 20), out('2026-03-01', 50), out('2026-03-01', 50), tin('2026-03-03', 100)])
  assert.deepEqual(r.lots.filter(l => l.accountId === 'B').map(l => [l.acquired, l.qty]), [['2026-01-05', 50], ['2026-02-05', 50]])
  assert.deepEqual(r.limitations, [])
})

test('a round trip brings the lots back with their original dates', () => {
  const r = run([buy('2026-01-05', 100, 20), out('2026-02-01', 100), tin('2026-02-02', 100), out('2026-02-10', 100, 'B'), tin('2026-02-11', 100, 'A'), sell('2026-03-01', 100, 10)])
  assert.deepEqual(r.pieces.map(p => [p.acquired, p.cost]), [['2026-01-05', 200000]])
  assert.deepEqual(r.limitations, [])
})

test('a transfer in that two other accounts could match is not guessed', () => {
  const r = run([...BASE(), out('2026-03-05', 100), tin('2026-03-06', 100, 'B'), tin('2026-03-06', 100, 'C')])
  assert.ok(r.limitations.some(l => /more than one other account/.test(l.message)))
  assert.ok(r.limitations.some(l => /matches no transfer in/.test(l.message)))
  assert.equal(r.lots.filter(l => l.accountId !== 'A').length, 0, 'no lots invented in either account')
})

test('a nearer transfer in wins over a farther one with the same quantity', () => {
  const r = run([...BASE(), out('2026-03-05', 100), tin('2026-03-09', 100, 'C'), tin('2026-03-06', 100, 'B')])
  assert.deepEqual(r.lots.filter(l => l.accountId !== 'A').map(l => l.accountId), ['B'])
  assert.equal(r.limitations.length, 1, 'the unmatched one is reported')
})

test('a transfer in with a cost, no lot date and no matching transfer out is not a purchase: it is reported', () => {
  const r = run([...BASE(), row('transfer_in', '2026-03-05', 100, 2000, 'B')])
  assert.equal(r.pieces[0].disallowed, 0)
  assert.equal(r.lots.filter(l => l.accountId === 'B').length, 0)
  assert.match(r.limitations[0].message, /gives no original purchase date/)
  assert.equal(r.limitations[0].kind, 'transfer')
})

test('a transfer in with a lot date and cost (the generic format) is still read as written', () => {
  const far = run([...BASE(), row('transfer_in', '2026-03-05', 100, 2000, 'B', { lotDate: '2026-01-05' })])
  assert.equal(far.pieces[0].disallowed, 0)
  assert.equal(far.lots.find(l => l.accountId === 'B')!.acquired, '2026-01-05')
  assert.deepEqual(far.limitations, [])
  // Bought inside the window, per its own date: a genuine replacement.
  const near = run([...BASE(), row('transfer_in', '2026-03-20', 100, 2000, 'B', { lotDate: '2026-03-10' })])
  assert.equal(near.pieces[0].disallowed, 100000)
})

test('a transfer out with no matching transfer in takes the shares out and says so', () => {
  const r = run([...BASE(), out('2026-03-05', 100)])
  assert.match(r.limitations[0].message, /matches no transfer in to another account/)
  assert.equal(r.lots.filter(l => !l.closedBy).length, 0)
  assert.equal(r.pieces[0].disallowed, 0)
})

test('a different quantity is not a match: both ends are reported', () => {
  const m = msgs([...BASE(), out('2026-03-05', 100), tin('2026-03-05', 99)])
  assert.equal(m.length, 2)
})

test('another ticker or the same account is not a match', () => {
  const other = run([...BASE(), out('2026-03-05', 100), row('transfer_in', '2026-03-05', 100, 0, 'B', { symbol: 'OTHER' })])
  assert.equal(other.limitations.length, 2)
  const same = run([...BASE(), out('2026-03-05', 100), tin('2026-03-05', 100, 'A')])
  assert.equal(same.limitations.length, 2)
})

test('taxable to IRA is not a carry-over: the shares leave, nothing lands in the IRA, a limitation says why', () => {
  const r = run([...BASE(), out('2026-03-05', 100), tin('2026-03-05', 100, 'IRA')])
  assert.equal(r.pieces[0].disallowed, 0, 'no wash sale was worked out from the move')
  assert.equal(r.lots.filter(l => l.accountId === 'IRA').length, 0)
  assert.equal(r.lots.filter(l => l.accountId === 'A' && !l.closedBy).length, 0)
  assert.equal(r.limitations.length, 1)
  assert.match(r.limitations[0].message, /taxable and an IRA or Roth.*not a simple carry-over/)
  // The same trades with the transfer into the IRA unmatched: the shares are not a purchase either.
  const lone = run([...BASE(), row('transfer_in', '2026-03-05', 100, 2000, 'IRA')])
  assert.equal(lone.pieces[0].disallowed, 0)
  assert.match(lone.limitations[0].message, /gives no original purchase date/)
})

test('IRA to taxable is reported the same way, and IRA to Roth carries the lots', () => {
  const back = run([buy('2026-01-05', 100, 20, 'IRA'), out('2026-03-05', 100, 'IRA'), tin('2026-03-06', 100, 'A'), sell('2026-04-01', 100, 10)])
  assert.equal(back.pieces.length, 0)
  assert.ok(back.limitations.some(l => /taxable and an IRA or Roth/.test(l.message)))
  const roth = run([buy('2026-01-05', 100, 20, 'IRA'), out('2026-03-05', 100, 'IRA'), tin('2026-03-06', 100, 'ROTH')])
  assert.deepEqual(roth.limitations, [])
  assert.deepEqual(roth.lots.map(l => [l.accountId, l.acquired]), [['ROTH', '2026-01-05']])
})

test('a basis or date on the transfer in that disagrees with the carried lots is reported, and the carried lots win', () => {
  const basis = run([...BASE(), out('2026-03-05', 100), row('transfer_in', '2026-03-05', 100, 1500, 'B')])
  assert.match(basis.limitations[0].message, /gives a basis of 1500.00.*have 2000.00/)
  assert.equal(basis.lots.find(l => l.accountId === 'B')!.cost, 200000)
  const date = run([...BASE(), out('2026-03-05', 100), row('transfer_in', '2026-03-05', 100, 2000, 'B', { lotDate: '2026-03-01' })])
  assert.match(date.limitations[0].message, /gives 2026-03-01.*bought 2026-01-05/)
  assert.equal(date.pieces[0].disallowed, 0, 'the carried date, not the transfer in row, decides')
  // The original cost without a wash sale adjustment is a fair way to report the same lot.
  const wash = [buy('2026-01-05', 100, 20), sell('2026-02-10', 100, 10), buy('2026-02-20', 100, 10), out('2026-03-20', 100), row('transfer_in', '2026-03-22', 100, 1000, 'B')]
  assert.deepEqual(run(wash).limitations, [])
})

test('the broker view and the 1099-B reconciliation follow the lots across the transfer', () => {
  const trades = [buy('2026-01-05', 100, 20), sell('2026-02-10', 100, 10), buy('2026-02-20', 100, 10), out('2026-03-20', 100), tin('2026-03-22', 100), sell('2026-06-01', 100, 12, 'B')]
  const full = run(trades)
  const broker = brokerView(trades, ACCTS, DEFAULT_SETTINGS)
  const key = (r: typeof full) => r.pieces.map(p => [p.accountId, p.sold, p.qty, p.cost, p.disallowed, p.gain])
  assert.deepEqual(key(broker), key(full))
  const lines = reconcile(full, broker, ACCTS, 2026, {})
  for (const l of lines) assert.deepEqual([l.ours, l.broker, l.knockOn], [l.ours, l.ours, 0])
  assert.equal(form8949Rows(full, ACCTS, 2026).length, 3)
})

test('the harvest planner sees the moved lots in the receiving account with their original dates and basis', () => {
  const r = run([buy('2026-01-05', 100, 20), sell('2026-02-10', 100, 10), buy('2026-02-20', 100, 10), out('2026-03-20', 100), tin('2026-03-22', 100)])
  assert.deepEqual(openLots(r, '2026-04-01').map(l => [l.accountId, l.acquired, l.qty, l.cost, l.adj]), [['B', '2026-02-20', 100, 200000, 100000]])
  assert.deepEqual(openLots(r, '2026-03-21'), [], 'in transit: held by neither account')
})

test('the broker view only sees replacements in the account that sold', () => {
  const trades = [buy('2026-01-05', 100, 20), sell('2026-03-02', 100, 10), buy('2026-03-10', 100, 10, 'B')]
  assert.equal(brokerView(trades, ACCTS, DEFAULT_SETTINGS).pieces[0].disallowed, 0)
  assert.equal(disallowed(trades), 100000)
})

test('row order in the file does not matter', () => {
  const trades = [...BASE(), out('2026-03-05', 100), tin('2026-03-06', 100)]
  assert.equal(disallowed([...trades].reverse()), 0)
})

test('no transfers, no change', () => {
  assert.equal(disallowed([...BASE(), buy('2026-03-10', 100, 10)]), 100000)
  assert.equal(disallowed(BASE()), 0)
})
