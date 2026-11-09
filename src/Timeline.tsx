// The lot timeline: lots as bars across time, a disallowed loss visibly flowing into the replacement
// lot's basis, and the release on the final sale. Driven entirely by the engine's output.
import { useEffect, useMemo, useState } from 'react'
import { addDays, diffDays } from './engine/dates.ts'
import type { Txn, WashResult } from './engine/types.ts'
import { WINDOW, released } from './engine/wash.ts'
import { fmtDay, money, shares } from './ui.tsx'

interface Lane { key: string; date: string; qty: number; cost: number; price: number; symbol: string; accountId: string; ira: boolean; soldOn?: string; soldStep?: number; buyStep: number; adj: { step: number; amount: number; permanent: boolean }[] }
export interface Step { date: string; kind: 'buy' | 'sale' | 'wash' | 'release'; title: string; text: string; lane: string; fromLane?: string; amount?: number; permanent?: boolean; saleDate?: string; gain?: number }
export interface Story { lanes: Lane[]; steps: Step[]; from: string; to: string; symbol: string }

/** Turns a set of buys and sales into the steps the timeline plays. */
export function buildStory(res: WashResult, txns: Txn[], buyIds: Set<string>, saleIds: Set<string>, accountName: (id: string) => string, iraIds: Set<string>): Story {
  const lotBuy = new Map(res.lots.map(l => [l.id, l.buyId]))
  const buys = txns.filter(t => buyIds.has(t.id)).sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)
  const sales = txns.filter(t => saleIds.has(t.id)).sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)
  const events: { date: string; seq: number; t: Txn; kind: 'buy' | 'sale' }[] = [...buys.map(t => ({ date: t.date, seq: t.seq, t, kind: 'buy' as const })), ...sales.map(t => ({ date: t.date, seq: t.seq, t, kind: 'sale' as const }))].sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)
  const lanes = new Map<string, Lane>()
  const steps: Step[] = []
  const pendingWash: { lane: string; fromLane: string; amount: number; permanent: boolean; saleDate: string; hold: number }[] = []
  const multiAcct = new Set(buys.map(b => b.accountId)).size > 1
  const where = (id: string) => multiAcct ? ` in ${accountName(id)}` : ''
  for (const e of events) {
    const t = e.t
    if (e.kind === 'buy') {
      lanes.set(t.id, { key: t.id, date: t.date, qty: t.qty, cost: t.amount, price: t.amount / t.qty, symbol: t.symbol, accountId: t.accountId, ira: iraIds.has(t.accountId), buyStep: steps.length, adj: [] })
      steps.push({ date: t.date, kind: 'buy', lane: t.id, title: `Bought ${shares(t.qty)} ${t.symbol}${where(t.accountId)}`, text: `${shares(t.qty)} shares at ${money(Math.round(t.amount / t.qty))} each. Cost basis ${money(t.amount)}.${t.auto ? ` This was an automatic ${t.auto === 'drip' ? 'dividend reinvestment' : 'recurring investment'}.` : ''}` })
      for (const w of pendingWash.filter(w => w.lane === t.id)) pushWash(w)
      continue
    }
    const ps = res.pieces.filter(p => p.saleId === t.id)
    const proceeds = ps.reduce((s, p) => s + p.proceeds, 0), cost = ps.reduce((s, p) => s + p.cost, 0)
    const dis = ps.reduce((s, p) => s + p.disallowed, 0), carried = ps.reduce((s, p) => s + p.carriedIn, 0), rel = ps.reduce((s, p) => s + released(p), 0)
    const raw = proceeds - cost
    for (const p of ps) { const l = lanes.get(lotBuy.get(p.lotId) ?? ''); if (l && !l.soldOn) { l.soldOn = t.date; l.soldStep = steps.length } }
    const lo = fmtDay(addDays(t.date, -WINDOW)), hi = fmtDay(addDays(t.date, WINDOW))
    const firstLane = lanes.get(lotBuy.get(ps[0]?.lotId ?? '') ?? '')?.key ?? ''
    steps.push({
      date: t.date, kind: 'sale', lane: firstLane, gain: raw, saleDate: t.date,
      title: `Sold ${shares(t.qty)} ${t.symbol}${raw < 0 ? ` for a ${money(-raw)} loss` : ` for a ${money(raw)} gain`}`,
      text: raw >= 0
        ? `Proceeds ${money(proceeds)} against basis ${money(cost)}.${carried ? ` That basis included ${money(carried)} of earlier disallowed losses, which this sale finally uses up.` : ''} Gains are never wash sales.`
        : `Proceeds ${money(proceeds)} against basis ${money(cost)}${carried ? ` (which already carries ${money(carried)} of earlier disallowed losses)` : ''}. The 61-day window runs ${lo} to ${hi}: any purchase of the same stock in that window, in any account, can disallow this loss.`,
    })
    if (raw < 0 && dis === 0) {
      steps.push({ date: t.date, kind: 'release', lane: firstLane, amount: -raw, saleDate: t.date, title: carried ? `Released: ${money(rel)} of deferred loss comes back` : 'No replacement shares: the loss counts', text: carried ? `Nothing was bought from ${lo} to ${hi}, so the whole ${money(-raw)} loss is deductible this year, including the ${money(carried)} that had been riding along in the basis. A wash sale defers a loss; it only disappears when the replacement is in an IRA.` : `Nothing was bought from ${lo} to ${hi}. The ${money(-raw)} loss is allowed.` })
    }
    for (const p of ps) for (const r of p.replacements) {
      const lane = lotBuy.get(r.lotId) ?? ''
      const w = { lane, fromLane: lotBuy.get(p.lotId) ?? '', amount: r.amount, permanent: r.permanent, saleDate: t.date, hold: diffDays(p.holdingStart, p.sold) }
      if (lanes.has(lane)) pushWash(w)
      else pendingWash.push(w)
    }
  }
  function pushWash(w: (typeof pendingWash)[number]) {
    const l = lanes.get(w.lane)
    if (!l) return
    l.adj.push({ step: steps.length, amount: w.amount, permanent: w.permanent })
    const basis = l.cost + l.adj.filter(a => !a.permanent).reduce((s, a) => s + a.amount, 0)
    steps.push({
      date: l.date > w.saleDate ? l.date : w.saleDate, kind: 'wash', lane: w.lane, fromLane: w.fromLane, amount: w.amount, permanent: w.permanent, saleDate: w.saleDate,
      title: w.permanent ? `${money(w.amount)} lost for good to ${accountName(l.accountId)}` : `${money(w.amount)} moves into the new shares’ basis`,
      text: w.permanent
        ? `The replacement shares landed in an IRA or Roth. The loss is disallowed and, under Rev. Rul. 2008-5, the IRA basis does not go up, so this ${money(w.amount)} never comes back.`
        : `The ${fmtDay(l.date)} purchase is inside the window, so ${money(w.amount)} of the loss is disallowed (Form 8949 code W) and added to those shares: basis ${money(l.cost)} + ${money(w.amount)} = ${money(basis)}. Their holding period also tacks on ${w.hold} days.`,
    })
  }
  const all = [...buys, ...sales].map(t => t.date).sort()
  const from = all[0] ?? '2025-01-01', to = all[all.length - 1] ?? '2025-12-31'
  return { lanes: [...lanes.values()], steps, from: addDays(from, -12), to: addDays(to, 40), symbol: buys[0]?.symbol ?? '' }
}

const W = 760, PADL = 8, PADR = 8, TOP = 34, LANE = 46, BAR = 30

export function LotTimeline({ story, step, onStep, compact }: { story: Story; step: number; onStep?(i: number): void; compact?: boolean }) {
  const span = Math.max(1, diffDays(story.from, story.to))
  const x = (d: string) => PADL + (W - PADL - PADR) * Math.min(1, Math.max(0, diffDays(story.from, d) / span))
  const H = TOP + story.lanes.length * LANE + 28
  const cur = story.steps[Math.min(step, story.steps.length - 1)]
  const nowDate = cur?.date ?? story.from
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const laneY = (key: string) => TOP + Math.max(0, story.lanes.findIndex(l => l.key === key)) * LANE
  const months = useMemo(() => {
    const out: string[] = []
    let d = story.from.slice(0, 7) + '-01'
    if (d < story.from) d = addDays(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)).toISOString().slice(0, 10), 0)
    while (d <= story.to) { out.push(d); d = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)).toISOString().slice(0, 10) }
    return out
  }, [story.from, story.to])
  const windowSale = cur && (cur.kind === 'sale' || cur.kind === 'wash' || cur.kind === 'release') && cur.saleDate ? cur.saleDate : null

  return (
    <svg className={`lot-timeline${compact ? ' compact' : ''}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Lot timeline for ${story.symbol}: ${cur?.title ?? ''}`}>
      <defs>
        <linearGradient id="lt-adj" x1="0" x2="1"><stop offset="0" stopColor="var(--neon)" stopOpacity="1" /><stop offset="1" stopColor="var(--neon)" stopOpacity=".55" /></linearGradient>
        <pattern id="lt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--loss)" fillOpacity=".18" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--loss)" strokeWidth="2" /></pattern>
      </defs>
      {months.map(m => <g key={m} className="lt-month"><line x1={x(m)} x2={x(m)} y1={TOP - 14} y2={H - 22} /><text x={x(m) + 4} y={TOP - 18}>{new Date(m + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</text></g>)}
      {windowSale && (
        <g className="lt-window" key={windowSale}>
          <rect x={x(addDays(windowSale, -WINDOW))} y={TOP - 10} width={Math.max(0, x(addDays(windowSale, WINDOW)) - x(addDays(windowSale, -WINDOW)))} height={H - TOP - 8} rx="10" />
          <text x={x(windowSale)} y={H - 8} textAnchor="middle">61-day window</text>
        </g>
      )}
      {story.lanes.map((l, i) => {
        if (step < l.buyStep) return null
        const y = TOP + i * LANE
        const sold = l.soldStep !== undefined && step >= l.soldStep
        const end = sold ? l.soldOn! : (nowDate > l.date ? nowDate : addDays(l.date, 4))
        const x0 = x(l.date), x1 = Math.max(x0 + 26, x(end))
        const adj = l.adj.filter(a => step >= a.step)
        const moved = adj.filter(a => !a.permanent).reduce((s, a) => s + a.amount, 0)
        const lost = adj.filter(a => a.permanent).reduce((s, a) => s + a.amount, 0)
        const total = l.cost + moved
        const capW = moved ? Math.max(10, Math.min(80, (x1 - x0) * moved / total)) : 0
        const isCur = cur?.lane === l.key
        const labelW = (String(shares(l.qty)).length + l.symbol.length + money(total, { cents: false }).length + (moved ? money(moved, { cents: false }).length + 7 : 0) + (l.ira ? 6 : 0) + 4) * 7.2
        const inside = x1 - x0 - capW - 20 > labelW
        const right = x1 + 10 + labelW < W
        const labelX = inside ? x0 + capW + 12 : right ? x1 + 10 : x0 - 8
        const labelAnchor = inside || right ? 'start' : 'end'
        return (
          <g key={l.key} className={`lt-lane${sold ? ' sold' : ''}${isCur ? ' current' : ''}${l.ira ? ' ira' : ''}`} onClick={() => onStep?.(l.buyStep)}>
            <rect className="lt-bar" x={x0} y={y} width={x1 - x0} height={LANE - 18} rx={BAR / 2} />
            {capW > 0 && <rect className="lt-adj" x={x0} y={y} width={capW + BAR / 2} height={LANE - 18} rx={BAR / 2} fill="url(#lt-adj)" />}
            {lost > 0 && <rect className="lt-lost" x={x0} y={y} width={Math.min(60, x1 - x0)} height={LANE - 18} rx={BAR / 2} fill="url(#lt-hatch)" />}
            <text className="lt-label" x={labelX} y={y + BAR / 2 + 4} textAnchor={labelAnchor}>
              {shares(l.qty)} {l.symbol} · {money(total, { cents: false })}{moved ? <tspan className="lt-plus"> incl. +{money(moved, { cents: false })}</tspan> : null}{l.ira ? <tspan className="lt-ira"> · IRA</tspan> : null}
            </text>
            {sold && <circle className="lt-sold" cx={x1} cy={y + BAR / 2} r="5" />}
          </g>
        )
      })}
      {cur?.kind === 'wash' && cur.fromLane && !reduced && (() => {
        const from = story.lanes.find(l => l.key === cur.fromLane), to = story.lanes.find(l => l.key === cur.lane)
        if (!from || !to) return null
        const sx = x(from.soldOn ?? cur.saleDate ?? from.date), sy = laneY(from.key) + BAR / 2
        const tx = x(to.date) + 10, ty = laneY(to.key) + BAR / 2
        const path = `M${sx},${sy} Q${(sx + tx) / 2},${Math.min(sy, ty) - 46} ${tx},${ty}`
        return (
          <g key={`fly-${step}`} className={`lt-fly${cur.permanent ? ' lost' : ''}`}>
            <path d={path} className="lt-trail" pathLength={1} />
            <g>
              <rect x="-34" y="-12" width="68" height="24" rx="12" />
              <text y="4" textAnchor="middle">{money(cur.amount ?? 0, { cents: false })}</text>
              <animateMotion dur="1.1s" fill="freeze" path={path} calcMode="spline" keyTimes="0;1" keySplines=".4 0 .2 1" />
              <animate attributeName="opacity" values="1;1;0" keyTimes="0;.75;1" dur="1.7s" fill="freeze" />
            </g>
          </g>
        )
      })()}
      {cur?.kind === 'release' && (() => {
        const l = story.lanes.find(x => x.key === cur.lane)
        if (!l) return null
        const cx = x(l.soldOn ?? cur.date), cy = laneY(l.key) + BAR / 2
        return <g key={`rel-${step}`} className="lt-release" transform={`translate(${Math.min(cx, W - 120)},${cy})`}><circle r="22" className="lt-ring" /><rect x="10" y="-30" width="104" height="24" rx="12" /><text x="62" y="-14" textAnchor="middle">{money(cur.amount ?? 0, { cents: false })} counts</text></g>
      })()}
      <line className="lt-now" x1={x(nowDate)} x2={x(nowDate)} y1={TOP - 12} y2={H - 22} />
    </svg>
  )
}

/** Plays a story step by step, with captions, controls and running totals. */
export function StoryPlayer({ story, autoplay = true, label }: { story: Story; autoplay?: boolean; label?: string }) {
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const last = story.steps.length - 1
  const [step, setStep] = useState(reduced || !autoplay ? last : 0)
  const [playing, setPlaying] = useState(autoplay && !reduced)
  useEffect(() => { setStep(reduced || !autoplay ? last : 0); setPlaying(autoplay && !reduced) }, [story])
  useEffect(() => {
    if (!playing) return
    const s = story.steps[step]
    const delay = step >= last ? 5200 : s?.kind === 'wash' || s?.kind === 'release' ? 3000 : 2100
    const t = setTimeout(() => setStep(i => i >= last ? 0 : i + 1), delay)
    return () => clearTimeout(t)
  }, [playing, step, last, story])
  const upTo = story.steps.slice(0, step + 1)
  const lossTotal = upTo.filter(s => s.kind === 'sale' && (s.gain ?? 0) < 0).reduce((a, s) => a - (s.gain ?? 0), 0)
  const moved = upTo.filter(s => s.kind === 'wash' && !s.permanent).reduce((a, s) => a + (s.amount ?? 0), 0)
  const lost = upTo.filter(s => s.kind === 'wash' && s.permanent).reduce((a, s) => a + (s.amount ?? 0), 0)
  const cur = story.steps[step]
  const go = (i: number) => { setPlaying(false); setStep(Math.max(0, Math.min(last, i))) }
  return (
    <div className="story" aria-label={label}>
      <div className="story-stats" aria-live="off">
        <div><span>Losses booked</span><b className="loss">{money(-lossTotal, { cents: false })}</b></div>
        <div><span>Moved into basis</span><b className="neon-text">{money(moved, { cents: false })}</b></div>
        {lost > 0 && <div><span>Lost to IRA</span><b className="loss">{money(lost, { cents: false })}</b></div>}
        <div><span>Step</span><b>{step + 1}<small>/{last + 1}</small></b></div>
      </div>
      <LotTimeline story={story} step={step} onStep={go} />
      <div className="story-caption" aria-live="polite">
        <div className={`story-kind ${cur?.kind}`}>{cur ? `${fmtDay(cur.date)} · ${cur.kind === 'wash' ? 'wash sale' : cur.kind}` : ''}</div>
        <h3>{cur?.title}</h3>
        <p>{cur?.text}</p>
      </div>
      <div className="story-controls">
        <button type="button" className="icon-btn" aria-label="Previous step" onClick={() => go(step - 1)} disabled={step === 0}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 6-6 6 6 6" /></svg></button>
        <button type="button" className="icon-btn play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (step >= last) setStep(0); setPlaying(p => !p) }}>
          {playing ? <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg> : <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 5v14l12-7z" /></svg>}
        </button>
        <button type="button" className="icon-btn" aria-label="Next step" onClick={() => go(step + 1)} disabled={step === last}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 6 6 6-6 6" /></svg></button>
        <div className="story-dots" role="group" aria-label="Steps">
          {story.steps.map((s, i) => <button key={i} type="button" className={`${s.kind}${i === step ? ' on' : ''}${i < step ? ' past' : ''}`} aria-label={`Step ${i + 1}: ${s.title}`} onClick={() => go(i)} />)}
        </div>
      </div>
    </div>
  )
}
