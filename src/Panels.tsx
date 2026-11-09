import { useMemo, useState } from 'react'
import { toCsv } from './engine/csv.ts'
import { detect, parseCsv, validate1099 } from './engine/importer.ts'
import { compareSnapshots } from './engine/snapshot.ts'
import type { Piece, Reported, Txn } from './engine/types.ts'
import { brokerCanSee, chainOf, fateOf, form8949Rows, reconcile, released, summarize, yearOf } from './engine/wash.ts'
import { download8949, saveSnapshot, type Tab, type TabProps } from './Project.tsx'
import { accountName, accountType } from './projectData.ts'
import { deleteSnapshotCloud } from './sync.ts'
import { buildStory, StoryPlayer } from './Timeline.tsx'
import { ask, CopyButton, Empty, fmtDate, fmtDay, Link, Modal, money, plural, shares, toast } from './ui.tsx'

export default function Panels(props: TabProps & { tab: Tab }) {
  if (props.tab === 'form8949') return <Form8949 {...props} />
  if (props.tab === 'reconcile') return <Reconcile {...props} />
  if (props.tab === 'history') return <History {...props} />
  return <Washes {...props} />
}

const srcOf = (t?: Txn) => t?.src ? `${t.src.file}, line ${t.src.line}` : ''

// ---------- Wash sales ----------

function Washes({ project, ds, a, year }: TabProps) {
  const s = summarize(a.full, year)
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(location.search).get('sale'))
  const [showLim, setShowLim] = useState(false)
  const washes = a.full.pieces.filter(p => yearOf(p.sold) === year && p.disallowed > 0).sort((x, y) => x.sold.localeCompare(y.sold))
  const fates = useMemo(() => new Map(washes.map(p => [p.id, fateOf(a.full, p.id)])), [a, year])
  const end = `${year}-12-31`
  let relIn = 0, relLater = 0, held = 0, lost = 0
  for (const f of fates.values()) { for (const r of f.released) r.date <= end ? relIn += r.amount : relLater += r.amount; held += f.held; lost += f.lost }
  const flow = relIn + relLater + held + lost || 1
  const tickers = new Map<string, number>()
  for (const p of washes) tickers.set(p.symbol, (tickers.get(p.symbol) ?? 0) + p.disallowed)
  const maxT = Math.max(1, ...tickers.values())
  const lims = a.full.limitations.filter(l => yearOf(l.date) <= year)
  const piece = washes.find(p => p.id === open) ?? a.full.pieces.find(p => p.id === open)

  return (
    <div className="tab-body">
      <div className="kpis">
        <div className="kpi"><span>Net gain or loss {year}</span><b className={s.net < 0 ? 'loss' : 'gain'}>{money(s.net, { sign: true })}</b><small>Short {money(s.st, { cents: false })} · long {money(s.lt, { cents: false })}</small></div>
        <div className="kpi hl"><span>Wash sale loss disallowed</span><b>{money(s.disallowed)}</b><small>{plural(s.washCount, 'sale lot')}, all accounts. Box 1g covers only part of this.</small></div>
        <div className="kpi"><span>Released this year</span><b className="neon-text">{money(s.released)}</b><small>Earlier deferrals deducted on final sales</small></div>
        <div className="kpi"><span>Deferred into {year + 1}</span><b>{money(s.deferredOut)}</b><small>Still in the basis of shares you hold</small></div>
        <div className="kpi"><span>Lost to IRA or Roth</span><b className={s.permanent ? 'loss' : ''}>{money(s.permanent)}</b><small>Never deductible (Rev. Rul. 2008-5)</small></div>
      </div>

      {lims.length > 0 && (
        <div className="fix-banner warn">
          <div>
            <strong>{plural(lims.length, 'item')} the engine does not analyse</strong>
            <p className="small">Options, short sales, transfers without basis and sales with no matching purchase are listed so nothing is silently dropped. <button type="button" className="linkish" onClick={() => setShowLim(v => !v)}>{showLim ? 'Hide' : 'Show'} them</button></p>
            {showLim && <ul className="issues">{lims.map((l, i) => <li key={i}><span className="mono">{l.date}</span> {accountName(project, l.accountId)} · {l.message}</li>)}</ul>}
          </div>
        </div>
      )}

      {washes.length === 0 ? (
        <Empty title={`No wash sales in ${year}`}><p className="muted">No loss sale in {year} had substantially identical shares bought 30 days before or after it in any account. {s.released ? `${money(s.released)} of earlier deferrals was released.` : ''}</p></Empty>
      ) : (
        <>
          <div className="grid-main">
          <div className="panel">
            <div className="panel-head"><h2>Where {year}’s disallowed losses went</h2><span className="muted small">Traced lot by lot through every chain</span></div>
            <div className="flowbar" role="img" aria-label={`Released in ${year} ${money(relIn)}, released later ${money(relLater)}, still in basis ${money(held)}, lost to IRA ${money(lost)}`}>
              {[['rel', relIn, `Released in ${year}`], ['later', relLater, `Released after ${year}`], ['held', held, 'Still in basis'], ['lost', lost, 'Lost to IRA']].filter(x => (x[1] as number) > 0).map(([k, v, l]) => (
                <div key={k as string} className={`flow ${k}`} style={{ flexGrow: (v as number) / flow }}><span>{l as string}</span><b>{money(v as number, { cents: false })}</b></div>
              ))}
            </div>
            <p className="muted small" style={{ marginTop: 12 }}>A wash sale does not erase a loss. It moves it into the basis of the replacement shares, and it comes back when those are sold with no new purchase in the window (Pub. 550). Only replacement shares in an IRA or Roth make it permanent.</p>
          </div>
            <div className="panel">
              <h2>By ticker</h2>
              <ul className="bars">
                {[...tickers].sort((x, y) => y[1] - x[1]).map(([t, v]) => <li key={t}><span className="tick">{t}</span><i style={{ width: `${(v / maxT) * 100}%` }} /><b>{money(v, { cents: false })}</b></li>)}
              </ul>
            </div>
          </div>
            <div className="panel flush">
              <div className="panel-head pad"><h2>Every wash sale in {year}</h2><span className="muted small">Select one to see why</span></div>
              <div className="table-wrap">
                <table className="data washes">
                  <thead><tr><th>Sold</th><th>Ticker</th><th className="hide-sm">Account</th><th className="num">Shares</th><th className="num">Loss</th><th className="num">Disallowed</th><th className="hide-sm">Replaced in</th><th>What happened</th></tr></thead>
                  <tbody>
                    {washes.map(p => {
                      const f = fates.get(p.id)!
                      const seen = p.replacements.every(r => brokerCanSee(p, r))
                      return (
                        <tr key={p.id} className="clickable" tabIndex={0} onClick={() => setOpen(p.id)} onKeyDown={e => { if (e.key === 'Enter') setOpen(p.id) }}>
                          <td>{fmtDay(p.sold)}</td>
                          <th scope="row"><span className="tick">{p.symbol}</span></th>
                          <td className="hide-sm">{accountName(project, p.accountId)}</td>
                          <td className="num">{shares(p.qty)}</td>
                          <td className="num loss">{money(p.proceeds - p.cost)}</td>
                          <td className="num"><b>{money(p.disallowed)}</b></td>
                          <td className="hide-sm">{[...new Set(p.replacements.map(r => r.accountId))].map(id => <span key={id} className={`acct-chip ${accountType(project, id)}`}>{accountName(project, id)}</span>)}{!seen && <span className="chip warn" title="Not on any 1099-B">Broker can’t see</span>}</td>
                          <td><FateChip f={f} year={year} /></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
        </>
      )}
      <Modal open={!!piece} onClose={() => setOpen(null)} title={piece ? `Why ${money(piece.disallowed)} of this ${piece.symbol} loss is disallowed` : ''} wide>
        {piece && <Explain {...{ project, ds, a, year }} piece={piece} onOpen={setOpen} />}
      </Modal>
    </div>
  )
}

function FateChip({ f, year }: { f: ReturnType<typeof fateOf>; year: number }) {
  const parts: string[] = []
  const rel = f.released.reduce((s, r) => s + r.amount, 0)
  if (f.lost) return <span className="chip critical">Lost to IRA{f.lost && (rel || f.held) ? ' (part)' : ''}</span>
  if (f.held && !rel) return <span className="chip neon">Still in basis</span>
  if (rel) { const last = f.released[f.released.length - 1]; parts.push(`Released ${fmtDay(last.date)}${yearOf(last.date) !== year ? ` ${yearOf(last.date)}` : ''}`) }
  if (f.held) parts.push('part still held')
  return <span className="chip good">{parts.join(', ')}</span>
}

function Explain({ project, ds, a, piece, onOpen }: Pick<TabProps, 'project' | 'ds' | 'a' | 'year'> & { piece: Piece; onOpen(id: string): void }) {
  const txById = useMemo(() => new Map(ds.txns.map(t => [t.id, t])), [ds])
  const lotById = useMemo(() => new Map(a.full.lots.map(l => [l.id, l])), [a])
  const chain = chainOf(a.full, piece.id)
  const pieces = [...chain.back, piece, ...chain.forward.map(f => f.to).filter((x): x is Piece => !!x)]
  const story = useMemo(() => {
    const sales = new Set(pieces.map(p => p.saleId))
    const buys = new Set<string>()
    for (const p of pieces) {
      const b = lotById.get(p.lotId)?.buyId
      if (b) buys.add(b)
      for (const r of p.replacements) { const rb = lotById.get(r.lotId)?.buyId; if (rb) buys.add(rb) }
    }
    return buildStory(a.full, ds.txns, buys, sales, id => accountName(project, id), new Set(project.accounts.filter(x => x.type !== 'taxable').map(x => x.id)))
  }, [piece.id, a])
  const f = fateOf(a.full, piece.id)
  const sale = txById.get(piece.saleId)
  const buy = txById.get(lotById.get(piece.lotId)?.buyId ?? '')
  const loss = piece.cost - piece.proceeds
  return (
    <div className="explain">
      <StoryPlayer story={story} label="Timeline of this wash sale chain" />
      <div className="explain-grid">
        <section>
          <h3>The sale</h3>
          <dl className="facts">
            <div><dt>Sold</dt><dd>{shares(piece.qty)} {piece.symbol} on {fmtDate(piece.sold)} in {accountName(project, piece.accountId)}</dd></div>
            <div><dt>Bought</dt><dd>{fmtDate(piece.acquired)}{piece.holdingStart !== piece.acquired ? ` (holding period from ${fmtDate(piece.holdingStart)} after tacking)` : ''}</dd></div>
            <div><dt>Proceeds</dt><dd>{money(piece.proceeds)}</dd></div>
            <div><dt>Basis</dt><dd>{money(piece.cost)}{piece.carriedIn ? <> incl. <b className="neon-text">{money(piece.carriedIn)}</b> carried from {piece.carriedFrom.map((c, i) => { const src = a.full.pieces.find(p => p.id === c.pieceId); return src ? <button key={i} type="button" className="linkish" onClick={() => onOpen(src.id)}>{fmtDay(src.sold)} sale</button> : null })}</> : null}</dd></div>
            <div><dt>Loss</dt><dd className="loss">{money(-loss)}</dd></div>
            <div><dt>Source</dt><dd className="muted small">{srcOf(sale) || 'imported'}{buy ? `; bought at ${srcOf(buy)}` : ''}</dd></div>
          </dl>
        </section>
        <section>
          <h3>The replacement shares</h3>
          <p className="small muted">Bought {fmtDay(piece.sold)} ± 30 days, matched in the order they were acquired (Treas. Reg. §1.1091-1).</p>
          <table className="data compact">
            <thead><tr><th>Bought</th><th>Account</th><th className="num">Shares</th><th className="num">Moved</th><th>1099-B?</th></tr></thead>
            <tbody>
              {piece.replacements.map((r, i) => {
                const t = txById.get(lotById.get(r.lotId)?.buyId ?? '')
                return (
                  <tr key={i} title={srcOf(t)}>
                    <td>{fmtDay(r.acquired)}{t?.auto && <span className="chip neutral tiny">{t.auto === 'drip' ? 'DRIP' : 'auto'}</span>}</td>
                    <td>{accountName(project, r.accountId)}{r.symbol !== piece.symbol ? ` (${r.symbol})` : ''}</td>
                    <td className="num">{shares(r.qty)}</td>
                    <td className={`num ${r.permanent ? 'loss' : 'neon-text'}`}>{money(r.amount)}</td>
                    <td>{brokerCanSee(piece, r) ? <span className="chip neutral">Reported</span> : r.permanent ? <span className="chip critical">Lost</span> : <span className="chip warn">You adjust</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {piece.qty - piece.replacements.reduce((s, r) => s + r.qty, 0) > 1e-6 && <p className="small">Only {shares(piece.replacements.reduce((s, r) => s + r.qty, 0))} of {shares(piece.qty)} shares were replaced, so {money(loss - piece.disallowed)} of the loss is allowed now.</p>}
        </section>
      </div>
      <section className="fate">
        <h3>Where it went next</h3>
        <ul className="fate-list">
          {f.released.map((r, i) => <li key={i} className="rel"><b>{money(r.amount)}</b> released on {fmtDate(r.date)}, when the replacement shares were sold with no new purchase in the window.</li>)}
          {f.held > 0 && <li className="held"><b>{money(f.held)}</b> is still in the basis of shares you hold. It becomes deductible when you sell them and stay out for 31 days.</li>}
          {f.lost > 0 && <li className="lost"><b>{money(f.lost)}</b> went into an IRA or Roth and is permanently disallowed (Rev. Rul. 2008-5).</li>}
        </ul>
      </section>
      <section>
        <h3>Form 8949 row</h3>
        <div className="table-wrap"><table className="data compact mono-nums">
          <thead><tr><th>(a)</th><th>(b)</th><th>(c)</th><th className="num">(d)</th><th className="num">(e)</th><th>(f)</th><th className="num">(g)</th><th className="num">(h)</th></tr></thead>
          <tbody><tr><td>{shares(piece.qty)} sh {piece.symbol}</td><td>{piece.acquired}</td><td>{piece.sold}</td><td className="num">{money(piece.proceeds)}</td><td className="num">{money(piece.cost)}</td><td>W</td><td className="num">{money(piece.disallowed)}</td><td className="num">{money(piece.gain)}</td></tr></tbody>
        </table></div>
        <p className="muted small">Code W with the disallowed amount as a positive number in column (g), per the Form 8949 instructions. {piece.term === 'long' ? 'Long-term (Part II).' : 'Short-term (Part I).'} Not tax advice.</p>
      </section>
    </div>
  )
}

// ---------- Form 8949 ----------

function Form8949({ project, a, year }: TabProps) {
  const [onlyW, setOnlyW] = useState(false)
  const rows = form8949Rows(a.full, project.accounts, year)
  const [head, ...body] = rows
  const shown = onlyW ? body.filter(r => r[8] === 'W') : body
  const ps = a.full.pieces.filter(p => yearOf(p.sold) === year)
  const part = (t: 'short' | 'long') => { const x = ps.filter(p => p.term === t); return { d: x.reduce((s, p) => s + p.proceeds, 0), e: x.reduce((s, p) => s + p.cost, 0), g: x.reduce((s, p) => s + p.disallowed, 0), h: x.reduce((s, p) => s + p.gain, 0), n: x.length } }
  const st = part('short'), lt = part('long')
  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head wrap">
          <h2>Form 8949 rows for {year}</h2>
          <div className="row gap-sm wrap">
            <label className="row gap-sm small"><input type="checkbox" checked={onlyW} onChange={e => setOnlyW(e.target.checked)} /> Only code W rows</label>
            <CopyButton text={toCsv(rows)} label="Copy CSV" />
            <button type="button" className="btn primary sm" onClick={() => download8949(project, a, year)}>Download CSV</button>
          </div>
        </div>
        <div className="parts">
          {([['Part I · short-term', st], ['Part II · long-term', lt]] as const).map(([l, v]) => (
            <div key={l} className="part"><span>{l}</span><dl><div><dt>(d) Proceeds</dt><dd>{money(v.d)}</dd></div><div><dt>(e) Basis</dt><dd>{money(v.e)}</dd></div><div><dt>(g) Adj.</dt><dd>{money(v.g)}</dd></div><div><dt>(h) Gain</dt><dd className={v.h < 0 ? 'loss' : 'gain'}>{money(v.h)}</dd></div></dl></div>
          ))}
        </div>
        <div className="table-wrap tall">
          <table className="data compact mono-nums">
            <thead><tr>{head.slice(2, 11).map((h, i) => <th key={i} className={i >= 4 && i !== 6 ? 'num' : ''}>{String(h)}</th>)}</tr></thead>
            <tbody>{shown.map((r, i) => <tr key={i} className={r[8] === 'W' ? 'w' : ''}>{r.slice(2, 11).map((c, j) => <td key={j} className={j >= 4 && j !== 6 ? 'num' : ''}>{String(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>One row per lot sold. Column (e) is the adjusted basis, already including earlier disallowed losses carried in. Box A (short) and D (long) assume basis was reported to the IRS; use B/E or C/F if your 1099-B says otherwise. For wash sales your broker did not report, keep code W and the amount in (g). Not tax advice.</p>
      </div>
    </div>
  )
}

// ---------- 1099-B check ----------

function Reconcile({ project, a, year, update }: TabProps) {
  const reported = Object.fromEntries(project.accounts.map(x => [x.id, project.reported[x.id]?.[year]?.washDisallowed]))
  const lines = reconcile(a.full, a.broker, project.accounts, year, reported)
  const setRep = (acct: string, patch: Reported) => {
    const cur = project.reported[acct] ?? {}
    update({ reported: { ...project.reported, [acct]: { ...cur, [year]: { ...cur[year], ...patch } } } })
  }
  const import1099 = async (acct: string, file: File) => {
    const csv = parseCsv(await file.text())
    const d = detect(csv.rows)
    if (d.kind !== 'form1099') { toast('That file does not look like 1099-B detail: it needs proceeds and wash sale columns.', { tone: 'error' }); return }
    const v = validate1099(csv, d.map, d.headerRow)
    const rows = v.rows.filter(r => yearOf(r.sold) === year)
    if (!rows.length) { toast(`No ${year} sales found in ${file.name}`, { tone: 'error' }); return }
    const sum = (k: 'proceeds' | 'cost' | 'wash' | 'gain') => rows.reduce((s, r) => s + r[k], 0)
    setRep(acct, { proceeds: sum('proceeds'), cost: sum('cost'), washDisallowed: sum('wash'), gain: sum('gain') })
    toast(`Read ${plural(rows.length, 'row')} from ${file.name}${v.issues.length ? `, skipped ${v.issues.length}` : ''}`, { tone: 'ok' })
  }
  const missed = a.full.pieces.filter(p => yearOf(p.sold) === year && p.replacements.some(r => !brokerCanSee(p, r)))
  return (
    <div className="tab-body">
      <div className="callout">
        <b>Does the 1099-B cost basis already include the wash sale?</b> Usually yes. Box 1e is the adjusted basis, which already carries losses deferred from earlier sales your broker tracked. Box 1g is the loss disallowed on this sale, shown separately and added back in Form 8949 column (g). Brokers only track wash sales inside one account and one CUSIP (Form 8949 instructions; Pub. 550), so anything across accounts or into an IRA is on you.
      </div>
      {lines.map(l => {
        const acct = project.accounts.find(x => x.id === l.accountId)!
        const rep = project.reported[l.accountId]?.[year] ?? {}
        const ours = summarize(a.broker, year, new Set([l.accountId]))
        const basisFix = summarize(a.full, year, new Set([l.accountId])).cost - ours.cost
        const steps = [['Your broker’s view (same account, same ticker)', l.broker, 'base'], ['+ Replaced in another taxable account', l.crossAccount, 'cross'], ['+ Replaced in an IRA or Roth', l.ira, 'ira'], ['+ Equivalent tickers you grouped', l.equivalents, 'equiv'], ['+ Knock-on from different basis in chains', l.knockOn, 'knock']] as const
        const max = Math.max(1, l.ours, l.broker, l.reported ?? 0)
        let run = 0
        return (
          <div key={l.accountId} className="panel">
            <div className="panel-head wrap"><h2>{acct.name}</h2>
              <label className="btn ghost sm file-btn">Import 1099-B CSV<input type="file" accept=".csv,text/csv" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void import1099(l.accountId, f); e.target.value = '' }} /></label>
            </div>
            <div className="grid-2 gap">
              <div>
                <h3 className="h4">Your {year} 1099-B totals</h3>
                <div className="form-grid two" key={`${l.accountId}-${year}-${JSON.stringify(rep)}`}>
                  {([['proceeds', 'Box 1d proceeds'], ['cost', 'Box 1e cost basis'], ['washDisallowed', 'Box 1g wash sale loss disallowed'], ['gain', 'Net gain or loss']] as const).map(([k, label]) => (
                    <label key={k} className="field"><span>{label}</span>
                      <input inputMode="decimal" placeholder="0.00" defaultValue={rep[k] !== undefined ? (rep[k]! / 100).toFixed(2) : ''} onBlur={e => { const v = e.target.value.trim(); const n = Number(v.replace(/[$,]/g, '')); setRep(l.accountId, { [k]: v === '' || Number.isNaN(n) ? undefined : Math.round(n * 100) }) }} />
                    </label>
                  ))}
                </div>
                <table className="data compact mono-nums" style={{ marginTop: 12 }}>
                  <thead><tr><th /><th className="num">1099-B</th><th className="num">Replica</th><th className="num">Diff</th></tr></thead>
                  <tbody>
                    {([['Proceeds', rep.proceeds, ours.proceeds], ['Cost basis', rep.cost, ours.cost], ['Box 1g', rep.washDisallowed, ours.disallowed], ['Gain or loss', rep.gain, ours.net]] as const).map(([lab, r, o]) => (
                      <tr key={lab}><th scope="row">{lab}</th><td className="num">{r === undefined ? '—' : money(r)}</td><td className="num">{money(o)}</td><td className={`num ${r !== undefined && r !== o ? 'warn-text' : ''}`}>{r === undefined ? '' : r === o ? 'matches' : money(r - o, { sign: true })}</td></tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small">The replica is what this account’s trades produce when we look only inside this account at the same ticker, the way a broker does.</p>
              </div>
              <div>
                <h3 className="h4">From box 1g to what you actually owe</h3>
                <div className="waterfall">
                  {steps.map(([label, v, k]) => {
                    if (k !== 'base' && !v) return null
                    const left = k === 'base' ? 0 : run
                    run += v
                    return <div key={k} className={`wf ${k}`}><span>{label}</span><div className="wf-track"><i style={{ left: `${(Math.min(left, left + v) / max) * 100}%`, width: `${(Math.abs(v) / max) * 100}%` }} /></div><b>{money(v, { sign: k !== 'base' })}</b></div>
                  })}
                  <div className="wf total"><span>All accounts, all equivalents</span><div className="wf-track"><i style={{ left: 0, width: `${(l.ours / max) * 100}%` }} /></div><b>{money(l.ours)}</b></div>
                </div>
                {l.reported !== undefined && (
                  <div className={`verdict ${l.unexplained === 0 ? 'good' : 'warn'}`}>
                    {l.unexplained === 0
                      ? <>Your box 1g of {money(l.reported)} matches what the broker could see. {l.ours > l.broker ? <>The extra <b>{money(l.ours - l.broker)}</b> above is yours to report.</> : 'Nothing more to adjust.'}</>
                      : <>Box 1g ({money(l.reported)}) differs from the replica by <b>{money(l.unexplained!, { sign: true })}</b>. Usual causes: trades before your imported history, options or short sales (not analysed), corporate actions, transfers in, or the broker matching by CUSIP rather than ticker.</>}
                  </div>
                )}
                {basisFix !== 0 && <div className="verdict warn">Sales in this account used shares carrying <b>{money(basisFix)}</b> of loss deferred from wash sales the broker could not see. Box 1e is too {basisFix > 0 ? 'low' : 'high'} by that amount; the 8949 CSV uses the corrected basis.</div>}
              </div>
            </div>
          </div>
        )
      })}
      {missed.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Wash sales no 1099-B reports</h2><span className="muted small">{plural(missed.length, 'lot')}</span></div>
          <div className="table-wrap"><table className="data compact">
            <thead><tr><th>Sold</th><th>Ticker</th><th>Account</th><th>Replaced in</th><th className="num">Amount</th><th>Effect</th></tr></thead>
            <tbody>{missed.flatMap(p => p.replacements.filter(r => !brokerCanSee(p, r)).map((r, i) => (
              <tr key={p.id + i}><td>{fmtDay(p.sold)}</td><td><span className="tick">{p.symbol}</span></td><td>{accountName(project, p.accountId)}</td><td>{accountName(project, r.accountId)}{r.symbol !== p.symbol ? ` (${r.symbol})` : ''}</td><td className="num">{money(r.amount)}</td><td>{r.permanent ? <span className="chip critical">Lost for good</span> : <span className="chip warn">Deferred to {r.symbol}</span>}</td></tr>
            )))}</tbody>
          </table></div>
          <p className="muted small">On Form 8949, use code W and enter the amount in column (g) for these sales, and add the deferred amounts to the replacement shares’ basis when you sell them. Our 8949 CSV already does both. Not tax advice.</p>
        </div>
      )}
    </div>
  )
}

// ---------- History ----------

function History({ project, ds, a, year, update }: TabProps) {
  const snaps = [...project.snapshots].sort((x, y) => x.createdAt - y.createdAt)
  const [pa, setPa] = useState(snaps[snaps.length - 2]?.id ?? '')
  const [pb, setPb] = useState(snaps[snaps.length - 1]?.id ?? '')
  const A = snaps.find(s => s.id === pa), B = snaps.find(s => s.id === pb)
  const cmp = A && B && A.id !== B.id ? compareSnapshots(A, B) : null
  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head wrap"><h2>Snapshots</h2><button type="button" className="btn primary sm" onClick={() => saveSnapshot(project, ds, a, year, update)}>Save {year} snapshot</button></div>
        <p className="muted small">Freeze a tax year when you file, when the corrected 1099-B arrives, or after importing another account. Compare any two.</p>
        {snaps.length === 0 ? <Empty title="No snapshots yet"><p className="muted">Save one now; the next import can then be compared against it.</p></Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Year</th><th>Label</th><th className="hide-sm">Saved</th><th className="num">Disallowed</th><th className="num">Lost to IRA</th><th className="num">Net</th><th /></tr></thead>
            <tbody>{[...snaps].reverse().map(s => (
              <tr key={s.id}>
                <td>{s.year}</td><th scope="row">{s.label}</th><td className="hide-sm">{new Date(s.createdAt).toLocaleDateString()}</td>
                <td className="num">{money(s.summary.disallowed, { cents: false })}</td><td className="num">{money(s.summary.permanent, { cents: false })}</td><td className={`num ${s.summary.net < 0 ? 'loss' : 'gain'}`}>{money(s.summary.net, { cents: false })}</td>
                <td className="num"><button type="button" className="btn danger-ghost sm" onClick={async () => {
                  if (!(await ask('Delete this snapshot?', `${s.year} · ${s.label}. You can undo for a few seconds.`, 'Delete'))) return
                  const before = project.snapshots
                  update({ snapshots: project.snapshots.filter(x => x.id !== s.id) })
                  void deleteSnapshotCloud(s.id)
                  toast('Snapshot deleted', { undo: () => update({ snapshots: before }) })
                }}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {snaps.length >= 2 && (
        <div className="panel">
          <div className="panel-head wrap"><h2>Compare</h2>
            <div className="row gap-sm wrap">
              <select aria-label="Before" value={pa} onChange={e => setPa(e.target.value)}>{snaps.map(s => <option key={s.id} value={s.id}>{s.year} · {s.label}</option>)}</select>
              <span aria-hidden="true">→</span>
              <select aria-label="After" value={pb} onChange={e => setPb(e.target.value)}>{snaps.map(s => <option key={s.id} value={s.id}>{s.year} · {s.label}</option>)}</select>
            </div>
          </div>
          {!cmp ? <p className="muted">Pick two different snapshots.</p> : (
            <div className="grid-2 gap">
              <table className="data compact mono-nums">
                <thead><tr><th /><th className="num">Before</th><th className="num">After</th><th className="num">Change</th></tr></thead>
                <tbody>{cmp.totals.map(c => <tr key={c.key}><th scope="row">{c.label}</th><td className="num">{money(c.before, { cents: false })}</td><td className="num">{money(c.after, { cents: false })}</td><td className={`num ${c.delta ? 'strong' : 'muted'}`}>{c.delta ? money(c.delta, { sign: true, cents: false }) : '—'}</td></tr>)}</tbody>
              </table>
              <div>
                {A!.year !== B!.year && <p className="warn-text small">These snapshots are for different tax years.</p>}
                <h3 className="h4">Disallowed by ticker</h3>
                {cmp.tickers.length ? <ul className="bars">{cmp.tickers.map(t => <li key={t.key}><span className="tick">{t.label}</span><span className="small muted">{money(t.before, { cents: false })} → {money(t.after, { cents: false })}</span><b>{money(t.delta, { sign: true, cents: false })}</b></li>)}</ul> : <p className="muted small">No change by ticker.</p>}
                <h3 className="h4">Wash sales</h3>
                <p className="small">{plural(cmp.added.length, 'new wash sale lot')}, {plural(cmp.removed.length, 'lot')} no longer a wash sale.</p>
                <ul className="small plain">{cmp.added.slice(0, 8).map(w => <li key={w.id}>+ {w.symbol} sold {fmtDay(w.sold)} · {money(w.disallowed)}{w.permanent ? ' (IRA)' : ''}</li>)}{cmp.removed.slice(0, 8).map(w => <li key={w.id} className="muted">− {w.symbol} sold {fmtDay(w.sold)} · {money(w.disallowed)}</li>)}</ul>
              </div>
            </div>
          )}
        </div>
      )}
      <p className="muted small">Need something to hand over? <Link href={`/app/p/${project.id}/packet?y=${year}`}>Open the CPA packet</Link>.</p>
    </div>
  )
}


