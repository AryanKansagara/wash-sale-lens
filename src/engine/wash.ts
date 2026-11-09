// The wash sale engine: IRC §1091, Treas. Reg. §1.1091-1, IRS Pub. 550 and Rev. Rul. 2008-5.
//
// Model: every purchase becomes a lot up front (so purchases after a sale can be found as replacement
// shares), then sales and splits are replayed in date order. A loss on a lot is disallowed to the extent
// substantially identical shares were acquired 30 days before through 30 days after the sale, in any of
// the taxpayer's accounts. Replacement shares are matched in the order they were acquired, each share is
// used once, and the disallowed loss (with the sold shares' holding period) moves onto them. Shares that
// land in an IRA or Roth take nothing: the loss is gone for good.

import { addDays, diffDays, isLongTerm } from './dates.ts'
import type { Account, Limitation, Lot, Piece, Replacement, Settings, Txn, WashResult } from './types.ts'

export const WINDOW = 30
const q6 = (x: number) => Math.round(x * 1e6) / 1e6
const EPS = 1e-7

export function groupOf(symbol: string, settings: Pick<Settings, 'equivalents'>): string {
  const s = symbol.toUpperCase()
  const g = settings.equivalents.find(list => list.some(x => x.toUpperCase() === s))
  return g ? [...g].map(x => x.toUpperCase()).sort().join('|') : s
}

export interface RunOptions {
  /** Only look for replacement shares in the account that sold. With no equivalents this is what a broker can see. */
  sameAccountOnly?: boolean
}

const before = (a: { date: string; seq: number }, b: { date: string; seq: number }) => a.date < b.date || (a.date === b.date && a.seq < b.seq)

/** Splits `qty` shares off a lot. The original object becomes the taken part; the rest is returned as a new lot. */
function splitLot(lot: Lot, qty: number, nextId: () => string): Lot | null {
  if (qty >= lot.qty - EPS) return null
  const f = qty / lot.qty
  const takenCost = Math.round(lot.cost * f)
  const takenAdj = Math.round(lot.adj * f)
  const rest: Lot = {
    ...lot, id: nextId(), qty: q6(lot.qty - qty), cost: lot.cost - takenCost, adj: lot.adj - takenAdj,
    adjFrom: lot.adjFrom.map(a => ({ ...a, amount: a.amount - Math.round(a.amount * f) })).filter(a => a.amount !== 0),
  }
  lot.qty = q6(qty)
  lot.cost = takenCost
  lot.adj = takenAdj
  lot.adjFrom = lot.adjFrom.map(a => ({ ...a, amount: Math.round(a.amount * f) })).filter(a => a.amount !== 0)
  return rest
}

export function runWash(txns: Txn[], accounts: Account[], settings: Settings, opts: RunOptions = {}): WashResult {
  const acct = new Map(accounts.map(a => [a.id, a]))
  const typeOf = (id: string) => acct.get(id)?.type ?? 'taxable'
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)
  let n = 0
  const nextId = () => `L${++n}`
  const lots: Lot[] = []
  const pieces: Piece[] = []
  const limitations: Limitation[] = []

  for (const t of sorted) {
    const isBuy = t.kind === 'buy' || (t.kind === 'transfer_in' && t.amount > 0)
    if (!isBuy) continue
    const acquired = t.kind === 'transfer_in' && t.lotDate ? t.lotDate : t.date
    const lot: Lot = {
      id: nextId(), accountId: t.accountId, accountType: typeOf(t.accountId), symbol: t.symbol, group: groupOf(t.symbol, settings),
      acquired, arrived: t.date, holdingStart: acquired, qty: q6(t.qty), cost: t.amount, adj: 0, adjFrom: [], usedAsReplacement: false, buyId: t.id, seq: t.seq, auto: t.auto,
    }
    lots.push(lot)
  }
  const arr = (l: Lot) => ({ date: l.arrived, seq: l.seq })
  const addLot = (rest: Lot | null, parent: Lot) => { if (rest) lots.splice(lots.indexOf(parent) + 1, 0, rest) }
  const byAcq = (a: Lot, b: Lot) => a.acquired.localeCompare(b.acquired) || a.seq - b.seq

  for (const t of sorted) {
    if (t.kind === 'option' || t.kind === 'short') {
      limitations.push({ kind: t.kind, accountId: t.accountId, symbol: t.symbol, date: t.date, message: t.kind === 'option' ? 'Options are not analysed. Options on the same stock can be substantially identical, so check option losses by hand.' : 'Short sales are not analysed.' })
      continue
    }
    if (t.kind === 'transfer_in' && t.amount <= 0) {
      limitations.push({ kind: 'transfer', accountId: t.accountId, symbol: t.symbol, date: t.date, message: `Transfer in of ${t.qty} ${t.symbol} has no cost basis. Add it as a buy with the original date and cost (generic format) so later sales match.` })
      continue
    }
    if (t.kind === 'transfer_out') {
      limitations.push({ kind: 'transfer', accountId: t.accountId, symbol: t.symbol, date: t.date, message: `Transfer out of ${t.qty} ${t.symbol}. The shares and any wash sale basis go with them; import the receiving account to keep following them.` })
      closeShares(t)
      continue
    }
    if (t.kind === 'split') {
      const open = lots.filter(l => l.accountId === t.accountId && l.symbol === t.symbol && !l.closedBy && before(arr(l), t) && l.qty > EPS)
      const held = open.reduce((s, l) => s + l.qty, 0)
      const ratio = t.ratio ?? (held > EPS ? (held + t.qty) / held : 0)
      if (!ratio || ratio <= 0) { limitations.push({ kind: 'split', accountId: t.accountId, symbol: t.symbol, date: t.date, message: `Split in ${t.symbol} with no shares held; ignored.` }); continue }
      for (const l of open) l.qty = q6(l.qty * ratio)
      continue
    }
    if (t.kind !== 'sell') continue
    if (typeOf(t.accountId) !== 'taxable') { closeShares(t); continue }
    sell(t)
  }

  function takeShares(t: Txn): Lot[] {
    let open = lots.filter(l => l.accountId === t.accountId && l.symbol === t.symbol && !l.closedBy && before(arr(l), t) && l.qty > EPS).sort(byAcq)
    if (settings.method === 'specific' && t.lotDate) open = [...open.filter(l => l.acquired === t.lotDate), ...open.filter(l => l.acquired !== t.lotDate)]
    let need = q6(t.qty)
    const taken: Lot[] = []
    for (const l of open) {
      if (need <= EPS) break
      const take = Math.min(need, l.qty)
      addLot(splitLot(l, take, nextId), l)
      l.closedBy = t.id
      taken.push(l)
      need = q6(need - take)
    }
    if (need > EPS) limitations.push({ kind: 'unmatched', accountId: t.accountId, symbol: t.symbol, date: t.date, message: `Sold ${t.qty} ${t.symbol} but only ${q6(t.qty - need)} shares were bought in the imported history. ${need} shares have no basis here: import earlier activity or add the buy.` })
    return taken
  }

  function closeShares(t: Txn) { takeShares(t) }

  function sell(t: Txn) {
    const taken = takeShares(t)
    const totalQty = taken.reduce((s, l) => s + l.qty, 0)
    if (totalQty <= EPS) return
    const matchedProceeds = Math.round(t.amount * Math.min(1, totalQty / t.qty))
    let left = matchedProceeds
    const salePieces: Piece[] = taken.map((l, i) => {
      const proceeds = i === taken.length - 1 ? left : Math.round(matchedProceeds * l.qty / totalQty)
      left -= proceeds
      const p: Piece = {
        id: `${t.id}#${i}`, saleId: t.id, accountId: t.accountId, symbol: t.symbol, qty: l.qty, acquired: l.acquired, holdingStart: l.holdingStart, sold: t.date,
        proceeds, cost: l.cost, disallowed: 0, permanent: 0, carriedIn: l.adj, carriedFrom: l.adjFrom.map(a => ({ pieceId: a.pieceId, amount: a.amount })),
        replacements: [], term: isLongTerm(l.holdingStart, t.date) ? 'long' : 'short', gain: proceeds - l.cost, lotId: l.id,
      }
      return p
    })
    // Loss shares are matched in the order they were acquired (Reg. §1.1091-1(b)).
    for (const p of salePieces) {
      const loss = p.cost - p.proceeds
      if (loss <= 0) continue
      const group = groupOf(p.symbol, settings)
      const lo = addDays(t.date, -WINDOW), hi = addDays(t.date, WINDOW)
      const cands = lots
        .filter(l => !l.closedBy && !l.usedAsReplacement && l.group === group && l.qty > EPS && l.acquired >= lo && l.acquired <= hi && (!opts.sameAccountOnly || l.accountId === t.accountId))
        .sort(byAcq)
      let matched = 0
      let given = 0
      const holdDays = diffDays(p.holdingStart, t.date)
      for (const c of cands) {
        if (matched >= p.qty - EPS) break
        const take = Math.min(p.qty - matched, c.qty)
        addLot(splitLot(c, take, nextId), c)
        matched = q6(matched + take)
        const amount = Math.round(loss * matched / p.qty) - given
        given += amount
        c.usedAsReplacement = true
        const permanent = c.accountType !== 'taxable'
        if (!permanent) {
          c.cost += amount
          c.adj += amount
          c.adjFrom = [...c.adjFrom, { pieceId: p.id, amount, holdDays }]
          // Holding period tacks on: the replacement is treated as held since before it was bought.
          const tacked = addDays(c.acquired, -holdDays)
          if (tacked < c.holdingStart) c.holdingStart = tacked
        }
        const r: Replacement = { lotId: c.id, accountId: c.accountId, accountType: c.accountType, acquired: c.acquired, qty: take, amount, symbol: c.symbol, permanent }
        p.replacements.push(r)
        p.disallowed += amount
        if (permanent) p.permanent += amount
      }
      p.gain = p.proceeds - p.cost + p.disallowed
    }
    pieces.push(...salePieces)
  }

  return { pieces, lots, limitations }
}

// ---------- Reading the result ----------

export const yearOf = (d: string) => Number(d.slice(0, 4))

/** How much previously deferred loss this sale finally lets you deduct. */
export function released(p: Piece): number {
  if (!p.carriedIn) return 0
  const loss = p.cost - p.proceeds
  if (loss <= 0) return p.carriedIn
  return Math.round(p.carriedIn * (1 - p.disallowed / loss))
}

export interface YearSummary {
  year: number
  sales: number
  proceeds: number
  cost: number
  disallowed: number
  permanent: number
  released: number
  /** Disallowed losses sitting in the basis of shares still held at year end. */
  deferredOut: number
  washCount: number
  st: number
  lt: number
  net: number
}

export function summarize(res: WashResult, year: number, accountIds?: Set<string>): YearSummary {
  const ps = res.pieces.filter(p => yearOf(p.sold) === year && (!accountIds || accountIds.has(p.accountId)))
  const sum = (f: (p: Piece) => number) => ps.reduce((s, p) => s + f(p), 0)
  const pieceSold = new Map(res.pieces.map(p => [p.id, p.sold]))
  const end = `${year}-12-31`
  const closedOn = new Map(res.pieces.map(p => [p.lotId, p.sold]))
  let deferredOut = 0
  for (const l of res.lots) {
    if (!l.adj || l.accountType !== 'taxable' || (accountIds && !accountIds.has(l.accountId))) continue
    const closed = closedOn.get(l.id)
    if (closed && closed <= end) continue
    for (const a of l.adjFrom) if ((pieceSold.get(a.pieceId) ?? '9999') <= end) deferredOut += a.amount
  }
  const st = sum(p => p.term === 'short' ? p.gain : 0), lt = sum(p => p.term === 'long' ? p.gain : 0)
  return {
    year, sales: new Set(ps.map(p => p.saleId)).size, proceeds: sum(p => p.proceeds), cost: sum(p => p.cost), disallowed: sum(p => p.disallowed), permanent: sum(p => p.permanent),
    released: sum(released), deferredOut, washCount: ps.filter(p => p.disallowed > 0).length, st, lt, net: st + lt,
  }
}

export const years = (res: WashResult) => [...new Set(res.pieces.map(p => yearOf(p.sold)))].sort()

/** The path of one disallowed loss: where it came from and where it went, until it is deducted or lost. */
export interface ChainStep { piece: Piece; via?: Replacement }
export function chainOf(res: WashResult, pieceId: string): { back: Piece[]; forward: { from: Piece; to: Piece | null; r: Replacement; heldLot?: Lot }[] } {
  const byId = new Map(res.pieces.map(p => [p.id, p]))
  const back: Piece[] = []
  const seen = new Set<string>()
  const walkBack = (p: Piece) => { for (const c of p.carriedFrom) { const q = byId.get(c.pieceId); if (q && !seen.has(q.id)) { seen.add(q.id); walkBack(q); back.push(q) } } }
  const start = byId.get(pieceId)
  if (!start) return { back: [], forward: [] }
  walkBack(start)
  const forward: { from: Piece; to: Piece | null; r: Replacement; heldLot?: Lot }[] = []
  const walk = (p: Piece, depth: number) => {
    if (depth > 40) return
    for (const r of p.replacements) {
      const next = res.pieces.filter(x => x.carriedFrom.some(c => c.pieceId === p.id) && x.accountId === r.accountId && x.symbol === r.symbol)
      if (r.permanent || !next.length) {
        forward.push({ from: p, to: null, r, heldLot: res.lots.find(l => l.id === r.lotId) })
        continue
      }
      for (const x of next) { if (forward.some(f => f.to?.id === x.id)) continue; forward.push({ from: p, to: x, r }); walk(x, depth + 1) }
    }
  }
  walk(start, 0)
  return { back, forward }
}

// ---------- Broker view and reconciliation ----------

/** What a broker computes: same account, same ticker, nothing else. Run per taxable account. */
export function brokerView(txns: Txn[], accounts: Account[], settings: Settings): WashResult {
  const out: WashResult = { pieces: [], lots: [], limitations: [] }
  for (const a of accounts) {
    if (a.type !== 'taxable') continue
    const r = runWash(txns.filter(t => t.accountId === a.id), [a], { ...settings, equivalents: [] }, { sameAccountOnly: true })
    out.pieces.push(...r.pieces)
    out.lots.push(...r.lots)
  }
  return out
}

export interface ReconLine {
  accountId: string
  ours: number
  broker: number
  reported?: number
  crossAccount: number
  ira: number
  equivalents: number
  knockOn: number
  unexplained?: number
}

/** Explains the gap between what you actually owe and what the 1099-B says, per account. */
export function reconcile(full: WashResult, broker: WashResult, accounts: Account[], year: number, reported: Record<string, number | undefined>): ReconLine[] {
  return accounts.filter(a => a.type === 'taxable').map(a => {
    const mine = full.pieces.filter(p => p.accountId === a.id && yearOf(p.sold) === year)
    const theirs = broker.pieces.filter(p => p.accountId === a.id && yearOf(p.sold) === year)
    let crossAccount = 0, ira = 0, equivalents = 0
    for (const p of mine) for (const r of p.replacements) {
      if (r.permanent) ira += r.amount
      else if (r.accountId !== a.id) crossAccount += r.amount
      else if (r.symbol !== p.symbol) equivalents += r.amount
    }
    const ours = mine.reduce((s, p) => s + p.disallowed, 0)
    const brokerTotal = theirs.reduce((s, p) => s + p.disallowed, 0)
    const rep = reported[a.id]
    return {
      accountId: a.id, ours, broker: brokerTotal, reported: rep, crossAccount, ira, equivalents,
      knockOn: ours - brokerTotal - crossAccount - ira - equivalents,
      unexplained: rep === undefined ? undefined : rep - brokerTotal,
    }
  })
}

/** Which of our wash sales the broker could see (same account, same ticker). */
export const brokerCanSee = (p: Piece, r: Replacement) => !r.permanent && r.accountId === p.accountId && r.symbol === p.symbol

// ---------- Form 8949 ----------

const mdy = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`
const usd = (c: number) => (c / 100).toFixed(2)
const fmtQty = (q: number) => String(Math.round(q * 1e6) / 1e6)

export function form8949Rows(res: WashResult, accounts: Account[], year: number): (string | number)[][] {
  const name = new Map(accounts.map(a => [a.id, a.name]))
  const rows: (string | number)[][] = [['Part', 'Box (assumed)', 'Account', '(a) Description', '(b) Date acquired', '(c) Date sold', '(d) Proceeds', '(e) Cost basis', '(f) Code', '(g) Adjustment', '(h) Gain or (loss)', 'Of (g): lost to IRA', 'Prior wash basis included in (e)']]
  const ps = res.pieces.filter(p => yearOf(p.sold) === year).sort((a, b) => (a.term === b.term ? 0 : a.term === 'short' ? -1 : 1) || a.sold.localeCompare(b.sold) || a.symbol.localeCompare(b.symbol))
  for (const p of ps) rows.push([
    p.term === 'short' ? 'I (short-term)' : 'II (long-term)', p.term === 'short' ? 'A' : 'D', name.get(p.accountId) ?? p.accountId,
    `${fmtQty(p.qty)} sh ${p.symbol}`, mdy(p.acquired), mdy(p.sold), usd(p.proceeds), usd(p.cost), p.disallowed ? 'W' : '', p.disallowed ? usd(p.disallowed) : '', usd(p.gain),
    p.permanent ? usd(p.permanent) : '', p.carriedIn ? usd(p.carriedIn) : '',
  ])
  return rows
}

/** Where one sale's disallowed loss ended up: released on later sales, still in the basis of held shares, or lost to an IRA. */
export interface Fate { released: { date: string; amount: number; pieceId: string }[]; held: number; lost: number }
export function fateOf(res: WashResult, pieceId: string): Fate {
  const byId = new Map(res.pieces.map(p => [p.id, p]))
  const fate: Fate = { released: [], held: 0, lost: 0 }
  const walk = (p: Piece, amountIn: number, depth: number) => {
    if (!p.disallowed || amountIn <= 0 || depth > 50) return
    fate.lost += amountIn * p.permanent / p.disallowed
    const moved = amountIn * (p.disallowed - p.permanent) / p.disallowed
    const basisTotal = p.disallowed - p.permanent
    let traced = 0
    for (const x of res.pieces) {
      const c = x.carriedFrom.find(c => c.pieceId === p.id)
      if (!c || !basisTotal) continue
      const part = moved * c.amount / basisTotal
      traced += part
      const loss = x.cost - x.proceeds
      const keep = loss <= 0 ? 0 : x.disallowed / loss
      if (part * (1 - keep) > 0) fate.released.push({ date: x.sold, amount: part * (1 - keep), pieceId: x.id })
      if (keep > 0) walk(x, part * keep, depth + 1)
    }
    fate.held += Math.max(0, moved - traced)
  }
  const start = byId.get(pieceId)
  if (start) walk(start, start.disallowed, 0)
  const merged = new Map<string, { date: string; amount: number; pieceId: string }>()
  for (const r of fate.released) { const m = merged.get(r.date); if (m) m.amount += r.amount; else merged.set(r.date, { ...r }) }
  return { released: [...merged.values()].map(r => ({ ...r, amount: Math.round(r.amount) })).sort((a, b) => a.date.localeCompare(b.date)), held: Math.round(fate.held), lost: Math.round(fate.lost) }
}
