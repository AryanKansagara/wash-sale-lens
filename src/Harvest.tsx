import { useMemo, useState } from 'react'
import { toCsv } from './engine/csv.ts'
import { addDays } from './engine/dates.ts'
import { calendar, openLots, planHarvest } from './engine/harvest.ts'
import type { TabProps } from './Project.tsx'
import { accountName } from './projectData.ts'
import { CopyButton, download, Empty, fmtDate, fmtDay, money, plural, shares } from './ui.tsx'

const today = () => new Date().toISOString().slice(0, 10)

export default function Harvest({ project, ds, a, update }: TabProps) {
  const [date, setDate] = useState(project.harvest.date ?? today())
  const target = project.harvest.target
  const held = useMemo(() => openLots(a.full, date), [a, date])
  const symbols = [...new Set(held.map(l => l.symbol))].sort()
  const plan = useMemo(() => planHarvest(a.full, ds.txns, project.accounts, project.settings, project.prices, target, date), [a, ds, project.prices, project.accounts, project.settings, target, date])
  const days = useMemo(() => calendar(plan), [plan])
  const picked = plan.groups.filter(g => g.picked.length)
  const blocked = plan.groups.filter(g => g.blockers.length)
  const autos = plan.groups.flatMap(g => g.autos)
  const conflicts = picked.flatMap(g => g.conflicts)
  const setPrice = (s: string, v: string) => {
    const n = Number(v.replace(/[$,]/g, ''))
    const prices = { ...project.prices }
    if (v.trim() === '' || !(n > 0)) delete prices[s]; else prices[s] = n
    update({ prices, pricesAt: today() })
  }
  const planCsv = () => toCsv([['Ticker', 'Account', 'Lot acquired', 'Shares', 'Basis', 'Price', 'Value', 'Unrealized', 'Do not buy through', 'First safe day'], ...picked.flatMap(g => g.picked.map(c => [c.lot.symbol, accountName(project, c.lot.accountId), c.lot.acquired, c.lot.qty, (c.lot.cost / 100).toFixed(2), c.price.toFixed(2), (c.value / 100).toFixed(2), (c.unrealized / 100).toFixed(2), g.doNotBuyThrough!, g.firstSafe!]))])

  if (!held.length) return <div className="tab-body"><Empty title="Nothing held on this date"><p className="muted">The planner works on the lots you still hold. Import your latest activity, or pick a later date.</p></Empty></div>

  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head wrap"><h2>Plan a harvest</h2><span className="muted small">Uses your lots across all {plural(project.accounts.length, 'account')}, including wash sale basis already carried in</span></div>
        <div className="harvest-controls">
          <label className="field"><span>Harvest about</span>
            <div className="target"><input type="range" min="0" max="2000000" step="25000" value={target} onChange={e => update({ harvest: { ...project.harvest, target: Number(e.target.value) } })} aria-label="Target loss" /><b>{money(target, { cents: false })}</b></div>
            <small>$3,000 is the most net capital loss you can deduct against ordinary income per year (Pub. 550); more carries forward.</small>
          </label>
          <label className="field"><span>Sell on</span><input type="date" value={date} onChange={e => { setDate(e.target.value); update({ harvest: { ...project.harvest, date: e.target.value } }) }} /><small>Recent buys are checked 30 days back from this date.</small></label>
        </div>
        <h3 className="h4">Prices{project.pricesAt ? <span className="muted small"> · entered {fmtDate(project.pricesAt)}</span> : null}</h3>
        <div className="prices">
          {symbols.map(s => (
            <label key={s} className={`price${project.prices[s] ? '' : ' missing'}`}><span className="tick">{s}</span><span className="dollar">$</span><input inputMode="decimal" defaultValue={project.prices[s] ?? ''} placeholder="price" onBlur={e => setPrice(s, e.target.value)} aria-label={`${s} price`} /></label>
          ))}
        </div>
        <p className="muted small">Type current prices from your broker app. There is no free, keyless quote feed that browsers can call directly, so nothing is fetched and your holdings never leave this page.</p>
      </div>

      {plan.missingPrices.length > 0 && <div className="fix-banner warn"><p className="small" style={{ margin: 0 }}>No price for {plan.missingPrices.join(', ')}: those lots are left out of the plan.</p></div>}

      <div className="kpis three">
        <div className="kpi hl"><span>Planned harvest</span><b className="loss">{money(-plan.total, { cents: false })}</b><small>{plan.total < target ? `${money(target - plan.total, { cents: false })} short of target with the lots available` : 'Meets your target'}</small></div>
        <div className="kpi"><span>Tickers to sell</span><b>{picked.length}</b><small>{picked.map(g => g.symbols.join('/')).join(', ') || 'None'}</small></div>
        <div className="kpi"><span>Blocked by recent buys</span><b className={blocked.length ? 'warn-text' : ''}>{blocked.length}</b><small>{blocked.length ? 'See when each clears below' : 'No recent purchases in the way'}</small></div>
      </div>

      {picked.length > 0 && (
        <div className="panel flush">
          <div className="panel-head pad wrap"><h2>Lots to sell on {fmtDate(date)}</h2><div className="row gap-sm"><CopyButton text={planCsv()} label="Copy" /><button type="button" className="btn ghost sm" onClick={() => download(`harvest-plan-${date}.csv`, planCsv())}>Download CSV</button></div></div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Ticker</th><th>Account</th><th>Lot bought</th><th className="num">Shares</th><th className="num">Basis</th><th className="num">Value</th><th className="num">Loss</th></tr></thead>
            <tbody>{picked.flatMap(g => g.picked.map(c => (
              <tr key={c.lot.id}><th scope="row"><span className="tick">{c.lot.symbol}</span></th><td>{accountName(project, c.lot.accountId)}</td><td>{fmtDay(c.lot.acquired)}{c.lot.adj ? <span className="chip neon tiny" title="This lot carries an earlier disallowed loss in its basis">+{money(c.lot.adj, { cents: false })} wash basis</span> : null}</td><td className="num">{shares(c.lot.qty)}</td><td className="num">{money(c.lot.cost)}</td><td className="num">{money(c.value)}</td><td className="num loss">{money(c.unrealized)}</td></tr>
            )))}</tbody>
          </table></div>
          <p className="muted small pad">Most brokers sell first-in, first-out unless you choose specific lots when you place the order. Robinhood lets you pick a cost basis method in settings; use specific lots so these are the shares sold.</p>
        </div>
      )}

      <div className="grid-2 gap">
        <div className="panel">
          <h2>Do not buy until</h2>
          <p className="muted small">In any account: taxable, IRA, Roth, a spouse’s. Buying sooner turns the harvest into a wash sale.</p>
          <ul className="dnb">
            {picked.map(g => <li key={g.group}><span className="tick">{g.symbols.join(' / ')}</span><span>through <b>{fmtDate(g.doNotBuyThrough!)}</b></span><span className="chip good">Safe {fmtDay(g.firstSafe!)}</span></li>)}
            {plan.activeWindows.filter(w => !picked.some(g => g.group === w.group)).map(w => <li key={w.group}><span className="tick">{w.symbol}</span><span>through <b>{fmtDate(w.through)}</b> <span className="muted small">(loss sale {fmtDay(w.sold)})</span></span><span className="chip neutral">Safe {fmtDay(addDays(w.through, 1))}</span></li>)}
            {!picked.length && !plan.activeWindows.length && <li className="muted">Nothing planned yet.</li>}
          </ul>
          {project.settings.equivalents.length > 0 && <p className="small warn-text">Your equivalence list groups {project.settings.equivalents.map(g => g.join('/')).join('; ')}. Those count as the same ticker here.</p>}
        </div>
        <div className="panel">
          <h2>Automatic buys to pause</h2>
          <p className="muted small">Recurring investments and dividend reinvestment buy shares on their own, and each buy can wash part of a harvested loss.</p>
          {autos.length === 0 ? <p className="muted small">No recurring buys or DRIP detected in your history.</p> : (
            <ul className="autos">
              {autos.map((x, i) => {
                const c = conflicts.filter(c => c.auto === x)
                return <li key={i} className={c.length ? 'conflict' : ''}><span className="tick">{x.symbol}</span><span>{x.kind === 'drip' ? 'Dividend reinvestment' : `Every ${x.cadenceDays === 7 ? 'week' : `${x.cadenceDays} days`}`} · {accountName(project, x.accountId)} · ~{money(x.avg, { cents: false })}</span>{c.length ? <span className="chip critical">Pause: next {fmtDay(c[0].date)}</span> : <span className="chip neutral">Next {x.next[0] ? fmtDay(x.next[0]) : '—'}</span>}</li>
              })}
            </ul>
          )}
        </div>
      </div>

      {blocked.length > 0 && (
        <div className="panel">
          <h2>Not harvestable today</h2>
          <ul className="blocked">
            {blocked.map(g => (
              <li key={g.group}>
                <span className="tick">{g.symbols.join(' / ')}</span>
                <span>{g.blockers.slice(0, 3).map((b, i) => <span key={i}>{i ? '; ' : ''}bought {shares(b.lot.qty)} on {fmtDay(b.lot.acquired)} in {accountName(project, b.lot.accountId)}{b.reason === 'ira-recent' ? ' (IRA: the loss would be lost for good)' : ''}</span>)}{g.blockers.length > 3 ? ` and ${g.blockers.length - 3} more` : ''}.</span>
                <span className="chip warn">Clear {fmtDay(g.clearOn!)}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">Shares bought in the 30 days before a loss sale count as replacement shares unless they are sold too (Treas. Reg. §1.1091-1). Recurring buys reset this clock every time they run.</p>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><h2>The next 30 days</h2><span className="muted small">{fmtDate(date)} to {fmtDate(addDays(date, 31))}</span></div>
        <div className="cal" role="list">
          {days.map((d, i) => (
            <div key={d.date} role="listitem" className={`cal-day${i === 0 ? ' start' : ''}${i === days.length - 1 ? ' safe' : ''}${d.events.some(e => e.type === 'conflict') ? ' conflict' : ''}`}>
              <span className="cal-date">{new Date(d.date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>
              {d.events.map((e, j) => <span key={j} className={`ev ${e.type}`}>{e.label}</span>)}
            </div>
          ))}
        </div>
        <div className="legend small"><span className="ev sell">Sell</span><span className="ev conflict">Auto-buy inside window</span><span className="ev auto">Auto-buy</span><span className="ev blocked">Becomes harvestable</span><span className="ev safe">Safe to buy</span></div>
      </div>
      <p className="muted small">Planning aid, not tax advice. Wash sale rules apply to your spouse’s accounts too (Pub. 550); import them if relevant.</p>
    </div>
  )
}
