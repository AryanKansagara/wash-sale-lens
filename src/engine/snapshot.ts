import type { Account, Reported, WashResult } from './types.ts'
import { reconcile, summarize, yearOf, type YearSummary } from './wash.ts'

/** A frozen tax year: what the 1099-B season looked like on the day you saved it. */
export interface Snapshot {
  id: string
  year: number
  label: string
  createdAt: number
  summary: YearSummary
  byTicker: { symbol: string; disallowed: number; permanent: number; net: number; sales: number }[]
  washes: { id: string; symbol: string; accountId: string; sold: string; qty: number; disallowed: number; permanent: number }[]
  recon: { accountId: string; ours: number; broker: number; reported?: number }[]
  trades: number
}

export function makeSnapshot(id: string, year: number, label: string, full: WashResult, broker: WashResult, accounts: Account[], reported: Record<string, Reported | undefined>, trades: number): Snapshot {
  const ps = full.pieces.filter(p => yearOf(p.sold) === year)
  const tick = new Map<string, Snapshot['byTicker'][number]>()
  for (const p of ps) {
    const t = tick.get(p.symbol) ?? { symbol: p.symbol, disallowed: 0, permanent: 0, net: 0, sales: 0 }
    t.disallowed += p.disallowed; t.permanent += p.permanent; t.net += p.gain; t.sales++
    tick.set(p.symbol, t)
  }
  const rec = reconcile(full, broker, accounts, year, Object.fromEntries(Object.entries(reported).map(([k, v]) => [k, v?.washDisallowed])))
  return {
    id, year, label, createdAt: Date.now(), summary: summarize(full, year),
    byTicker: [...tick.values()].sort((a, b) => b.disallowed - a.disallowed || a.symbol.localeCompare(b.symbol)),
    washes: ps.filter(p => p.disallowed > 0).map(p => ({ id: p.id, symbol: p.symbol, accountId: p.accountId, sold: p.sold, qty: p.qty, disallowed: p.disallowed, permanent: p.permanent })),
    recon: rec.map(r => ({ accountId: r.accountId, ours: r.ours, broker: r.broker, reported: r.reported })),
    trades,
  }
}

export interface Change { key: string; label: string; before: number; after: number; delta: number }

const FIELDS: [keyof YearSummary, string][] = [['net', 'Net gain or loss'], ['disallowed', 'Wash sale loss disallowed'], ['permanent', 'Lost to IRA or Roth'], ['released', 'Earlier deferrals released'], ['deferredOut', 'Deferred into next year'], ['proceeds', 'Proceeds'], ['cost', 'Cost basis'], ['st', 'Short-term'], ['lt', 'Long-term']]

/** What changed between two snapshots, field by field and ticker by ticker. */
export function compareSnapshots(a: Snapshot, b: Snapshot): { totals: Change[]; tickers: Change[]; added: Snapshot['washes']; removed: Snapshot['washes'] } {
  const totals = FIELDS.map(([k, label]) => ({ key: k, label, before: a.summary[k] as number, after: b.summary[k] as number, delta: (b.summary[k] as number) - (a.summary[k] as number) }))
  const syms = new Set([...a.byTicker, ...b.byTicker].map(t => t.symbol))
  const tickers = [...syms].map(s => {
    const x = a.byTicker.find(t => t.symbol === s)?.disallowed ?? 0, y = b.byTicker.find(t => t.symbol === s)?.disallowed ?? 0
    return { key: s, label: s, before: x, after: y, delta: y - x }
  }).filter(c => c.delta !== 0).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta))
  const key = (w: Snapshot['washes'][number]) => `${w.accountId}|${w.symbol}|${w.sold}|${w.qty}`
  const ak = new Set(a.washes.map(key)), bk = new Set(b.washes.map(key))
  return { totals, tickers, added: b.washes.filter(w => !ak.has(key(w))), removed: a.washes.filter(w => !bk.has(key(w))) }
}
