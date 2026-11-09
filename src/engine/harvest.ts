// Tax-loss harvest planning that does not trip a new wash sale, plus recurring-buy and DRIP detection.
import { addDays, diffDays } from './dates.ts'
import type { Account, Lot, Settings, Txn, WashResult } from './types.ts'
import { groupOf, WINDOW } from './wash.ts'

export interface AutoBuy { accountId: string; symbol: string; group: string; kind: 'recurring' | 'drip'; cadenceDays: number; last: string; avg: number; count: number; next: string[] }

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

/**
 * Finds automatic purchases: rows the broker labelled recurring or reinvested, and buys that repeat on a
 * steady cadence for similar amounts. Projects the next expected dates up to `until`.
 */
export function detectAuto(txns: Txn[], settings: Settings, from: string, until: string): AutoBuy[] {
  const by = new Map<string, Txn[]>()
  for (const t of txns) if (t.kind === 'buy') { const k = `${t.accountId}|${t.symbol}`; by.set(k, [...(by.get(k) ?? []), t]) }
  const out: AutoBuy[] = []
  for (const list of by.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    const tagged = list.filter(t => t.auto)
    let kind: AutoBuy['kind'] | null = null
    let series = list
    if (tagged.length) { kind = tagged.some(t => t.auto === 'drip') && !tagged.some(t => t.auto === 'recurring') ? 'drip' : 'recurring'; series = tagged }
    const recent = series.slice(-8)
    if (recent.length < 2) continue
    const gaps = recent.slice(1).map((t, i) => diffDays(recent[i].date, t.date)).filter(g => g > 0)
    const cadence = median(gaps)
    if (!kind) {
      const amts = recent.map(t => t.amount)
      const m = median(amts)
      const steady = recent.length >= 3 && cadence >= 6 && cadence <= 35 && gaps.every(g => Math.abs(g - cadence) <= 3) && amts.every(a => Math.abs(a - m) <= m * 0.35)
      if (!steady) continue
      kind = 'recurring'
    }
    if (!cadence) continue
    const last = recent[recent.length - 1]
    // Treat a schedule as stopped once it has missed two beats.
    if (diffDays(last.date, from) > cadence * 2 + 5) continue
    const next: string[] = []
    for (let d = addDays(last.date, cadence); d <= until && next.length < 12; d = addDays(d, cadence)) if (d >= from) next.push(d)
    out.push({ accountId: last.accountId, symbol: last.symbol, group: groupOf(last.symbol, settings), kind, cadenceDays: cadence, last: last.date, avg: Math.round(median(recent.map(t => t.amount))), count: series.length, next })
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol))
}

export const openLots = (res: WashResult, asOf: string) => res.lots.filter(l => !l.closedBy && l.arrived <= asOf && l.qty > 1e-7)

export interface Candidate { lot: Lot; price: number; value: number; unrealized: number }
export interface Blocker { lot: Lot; reason: 'recent-buy' | 'ira-recent' }
export interface GroupPlan {
  group: string
  symbols: string[]
  picked: Candidate[]
  harvest: number
  blockers: Blocker[]
  /** First day selling at a loss would not be washed by a recent purchase. */
  clearOn?: string
  /** Last day you must not buy (inclusive), and the first safe day. */
  doNotBuyThrough?: string
  firstSafe?: string
  autos: AutoBuy[]
  conflicts: { auto: AutoBuy; date: string }[]
}
export interface Plan { date: string; target: number; total: number; groups: GroupPlan[]; missingPrices: string[]; activeWindows: { group: string; symbol: string; sold: string; through: string; accountId: string }[] }

/**
 * Picks lots to sell on `date` to harvest about `target` cents of loss. A group is skipped if any account
 * (IRA included) bought it in the last 30 days and would keep those shares; selling a group means selling
 * its recent loss lots too, so nothing left behind can be a replacement.
 */
export function planHarvest(res: WashResult, txns: Txn[], accounts: Account[], settings: Settings, prices: Record<string, number>, target: number, date: string): Plan {
  const acct = new Map(accounts.map(a => [a.id, a]))
  const open = openLots(res, date)
  const recentFrom = addDays(date, -WINDOW)
  const autos = detectAuto(txns, settings, date, addDays(date, WINDOW + 31))
  const groups = new Map<string, GroupPlan>()
  const missing = new Set<string>()
  const cands: Candidate[] = []
  for (const l of open) {
    const g = groups.get(l.group) ?? { group: l.group, symbols: [], picked: [], harvest: 0, blockers: [], autos: autos.filter(a => a.group === l.group), conflicts: [] }
    if (!g.symbols.includes(l.symbol)) g.symbols.push(l.symbol)
    groups.set(l.group, g)
    if (acct.get(l.accountId)?.type !== 'taxable') continue
    const price = prices[l.symbol]
    if (!(price > 0)) { missing.add(l.symbol); continue }
    const value = Math.round(price * l.qty * 100)
    cands.push({ lot: l, price, value, unrealized: value - l.cost })
  }
  for (const g of groups.values()) {
    const loss = new Set(cands.filter(c => c.unrealized < 0 && c.lot.group === g.group).map(c => c.lot.id))
    for (const l of open) {
      if (l.group !== g.group || l.acquired < recentFrom || l.acquired > date) continue
      const ira = acct.get(l.accountId)?.type !== 'taxable'
      if (ira || !loss.has(l.id)) g.blockers.push({ lot: l, reason: ira ? 'ira-recent' : 'recent-buy' })
    }
    if (g.blockers.length) g.clearOn = addDays(g.blockers.reduce((m, b) => b.lot.acquired > m ? b.lot.acquired : m, ''), WINDOW + 1)
  }
  let total = 0
  const losers = cands.filter(c => c.unrealized < 0).sort((a, b) => a.unrealized - b.unrealized)
  for (const c of losers) {
    if (total >= target) break
    const g = groups.get(c.lot.group)!
    if (g.blockers.length || g.picked.some(p => p.lot.id === c.lot.id)) continue
    const mustSell = g.picked.length ? [] : losers.filter(x => x.lot.group === g.group && x.lot.acquired >= recentFrom && x.lot.id !== c.lot.id)
    for (const x of [c, ...mustSell]) { g.picked.push(x); g.harvest -= x.unrealized; total -= x.unrealized }
  }
  for (const g of groups.values()) {
    if (!g.picked.length) continue
    g.doNotBuyThrough = addDays(date, WINDOW)
    g.firstSafe = addDays(date, WINDOW + 1)
    for (const a of g.autos) for (const d of a.next) if (d <= g.doNotBuyThrough) g.conflicts.push({ auto: a, date: d })
  }
  const activeWindows = res.pieces
    .filter(p => p.cost > p.proceeds && p.sold >= recentFrom && p.sold <= date)
    .map(p => ({ group: groupOf(p.symbol, settings), symbol: p.symbol, sold: p.sold, through: addDays(p.sold, WINDOW), accountId: p.accountId }))
  return {
    date, target, total,
    groups: [...groups.values()].sort((a, b) => b.harvest - a.harvest || a.group.localeCompare(b.group)),
    missingPrices: [...missing].sort(),
    activeWindows: activeWindows.filter((w, i) => activeWindows.findIndex(x => x.group === w.group) === i),
  }
}

export interface CalDay { date: string; events: { type: 'sell' | 'blocked' | 'auto' | 'conflict' | 'safe' | 'window'; label: string }[] }

/** A day-by-day view of the 30 days after the harvest date. */
export function calendar(plan: Plan): CalDay[] {
  const days: CalDay[] = []
  for (let i = 0; i <= WINDOW + 1; i++) days.push({ date: addDays(plan.date, i), events: [] })
  const at = (d: string) => days.find(x => x.date === d)
  for (const g of plan.groups) {
    const name = g.symbols.join('/')
    if (g.picked.length) {
      at(plan.date)?.events.push({ type: 'sell', label: `Sell ${name}` })
      at(g.firstSafe!)?.events.push({ type: 'safe', label: `${name} safe to buy` })
      for (const c of g.conflicts) at(c.date)?.events.push({ type: 'conflict', label: `${c.auto.kind === 'drip' ? 'DRIP' : 'Auto-buy'} ${c.auto.symbol}` })
    } else if (g.clearOn) at(g.clearOn)?.events.push({ type: 'blocked', label: `${name} can be harvested` })
    for (const a of g.autos) if (!g.picked.length) for (const d of a.next) at(d)?.events.push({ type: 'auto', label: `${a.kind === 'drip' ? 'DRIP' : 'Auto-buy'} ${a.symbol}` })
  }
  for (const w of plan.activeWindows) at(addDays(w.through, 1))?.events.push({ type: 'window', label: `${w.symbol} window closes` })
  return days
}
