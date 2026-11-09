import { useEffect } from 'react'
import { diffDays } from './engine/dates.ts'
import { brokerCanSee, fateOf, form8949Rows, reconcile, summarize, yearOf } from './engine/wash.ts'
import { ACCOUNT_TYPES } from './engine/sample.ts'
import { accountName, pickYear, useAnalysis, useProject } from './projectData.ts'
import { fmtDate, Link, money, shares } from './ui.tsx'

export default function Packet({ id }: { id: string }) {
  const { loading, project, ds } = useProject(id)
  const a = useAnalysis(ds, project?.accounts, project?.settings)
  const year = project ? pickYear(project, a) : 0
  useEffect(() => { if (project) document.title = `Wash sale packet ${year} · ${project.name}` }, [project?.name, year])
  if (loading || (project && !a)) return <div className="boot" role="status"><span className="spinner" /> Preparing the packet</div>
  if (!project || !a || !ds) return <div className="page narrow center"><h1>Project not found</h1><Link href="/app" className="btn primary">Back to projects</Link></div>

  const s = summarize(a.full, year)
  const washes = a.full.pieces.filter(p => yearOf(p.sold) === year && p.disallowed > 0).sort((x, y) => x.sold.localeCompare(y.sold))
  const rec = reconcile(a.full, a.broker, project.accounts, year, Object.fromEntries(project.accounts.map(x => [x.id, project.reported[x.id]?.[year]?.washDisallowed])))
  const rows = form8949Rows(a.full, project.accounts, year)
  const lims = a.full.limitations.filter(l => yearOf(l.date) === year)
  const name = (aid: string) => accountName(project, aid)

  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <Link href={`/app/p/${id}?y=${year}`} className="btn ghost sm">&larr; Back</Link>
        <span className="muted small">Letter size, prints in black and white. Use your browser’s “Save as PDF” to send it.</span>
        <button type="button" className="btn primary sm" onClick={() => print()}>Print or save PDF</button>
      </div>
      <article className="sheet">
        <header className="sheet-head">
          <div><div className="eyebrow">Wash sale explanation packet</div><h1>{project.name}: tax year {year}</h1></div>
          <div className="sheet-meta">Prepared {fmtDate(new Date().toISOString().slice(0, 10))}<br />{project.sampleId ? 'SYNTHETIC SAMPLE DATA' : `${ds.txns.length.toLocaleString()} imported trades`}</div>
        </header>
        <p className="small">Prepared with Wash Sale Lens for review by a tax professional. It explains each disallowed loss, shares it across all of the taxpayer’s accounts, and reconciles to the broker’s Form 1099-B. <b>Not tax advice.</b></p>

        <h2>1. Summary</h2>
        <table className="data compact mono-nums">
          <tbody>
            <tr><th scope="row">Proceeds / adjusted basis</th><td className="num">{money(s.proceeds)} / {money(s.cost)}</td></tr>
            <tr><th scope="row">Wash sale loss disallowed (all accounts)</th><td className="num">{money(s.disallowed)}</td></tr>
            <tr><th scope="row">of which permanently disallowed (IRA / Roth replacement)</th><td className="num">{money(s.permanent)}</td></tr>
            <tr><th scope="row">Earlier deferrals released by sales in {year}</th><td className="num">{money(s.released)}</td></tr>
            <tr><th scope="row">Deferred into {year + 1} (in basis of shares held 12/31)</th><td className="num">{money(s.deferredOut)}</td></tr>
            <tr><th scope="row">Net short-term / long-term</th><td className="num">{money(s.st)} / {money(s.lt)}</td></tr>
          </tbody>
        </table>

        <h2>2. Accounts</h2>
        <table className="data compact"><thead><tr><th>Account</th><th>Broker</th><th>Type</th><th className="num">Trades imported</th></tr></thead>
          <tbody>{project.accounts.map(x => <tr key={x.id}><td>{x.name}</td><td>{x.broker}</td><td>{ACCOUNT_TYPES[x.type]}</td><td className="num">{ds.txns.filter(t => t.accountId === x.id).length}</td></tr>)}</tbody>
        </table>

        <h2>3. Reconciliation to Form 1099-B box 1g</h2>
        <table className="data compact mono-nums">
          <thead><tr><th>Account</th><th className="num">1099-B 1g</th><th className="num">Broker-visible</th><th className="num">Cross-account</th><th className="num">IRA / Roth</th><th className="num">Equivalents</th><th className="num">Chain effects</th><th className="num">All accounts</th></tr></thead>
          <tbody>{rec.map(r => <tr key={r.accountId}><td>{name(r.accountId)}</td><td className="num">{r.reported === undefined ? 'not entered' : money(r.reported)}</td><td className="num">{money(r.broker)}</td><td className="num">{money(r.crossAccount)}</td><td className="num">{money(r.ira)}</td><td className="num">{money(r.equivalents)}</td><td className="num">{money(r.knockOn)}</td><td className="num"><b>{money(r.ours)}</b></td></tr>)}</tbody>
        </table>
        <p className="small">“Broker-visible” rebuilds what the broker can compute: same account, same ticker. Differences are wash sales a broker is not required to track (Form 8949 instructions; Pub. 550).</p>

        <h2>4. Each wash sale</h2>
        {washes.length === 0 ? <p>No wash sales in {year}.</p> : (
          <ol className="packet-washes">
            {washes.map(p => {
              const f = fateOf(a.full, p.id)
              const hold = diffDays(p.holdingStart, p.sold)
              return (
                <li key={p.id}>
                  <p><b>{fmtDate(p.sold)}: sold {shares(p.qty)} {p.symbol} in {name(p.accountId)}</b> (acquired {fmtDate(p.acquired)}) for {money(p.proceeds)} against an adjusted basis of {money(p.cost)}{p.carriedIn ? `, which includes ${money(p.carriedIn)} deferred from earlier wash sales` : ''}: a loss of {money(p.cost - p.proceeds)}.</p>
                  <p>Replacement shares acquired within 30 days: {p.replacements.map((r, i) => <span key={i}>{i ? '; ' : ''}{shares(r.qty)} {r.symbol} on {fmtDate(r.acquired)} in {name(r.accountId)} ({money(r.amount)}{r.permanent ? ', permanently disallowed, IRA basis not increased under Rev. Rul. 2008-5' : `, added to their basis${brokerCanSee(p, r) ? '' : '; not reported by any broker'}`})</span>)}. Disallowed: <b>{money(p.disallowed)}</b> (code W). Holding period of {hold} days tacked to the replacement shares.</p>
                  <p className="muted">Outcome: {[...f.released.map(r => `${money(r.amount)} released ${fmtDate(r.date)}`), f.held ? `${money(f.held)} still in basis of shares held` : '', f.lost ? `${money(f.lost)} lost to IRA/Roth` : ''].filter(Boolean).join('; ')}.</p>
                </li>
              )
            })}
          </ol>
        )}

        <h2>5. Form 8949 detail</h2>
        <table className="data compact mono-nums tiny-print">
          <thead><tr>{rows[0].slice(0, 11).map((h, i) => <th key={i}>{String(h)}</th>)}</tr></thead>
          <tbody>{rows.slice(1).map((r, i) => <tr key={i}>{r.slice(0, 11).map((c, j) => <td key={j} className={j >= 6 && j !== 8 ? 'num' : ''}>{String(c)}</td>)}</tr>)}</tbody>
        </table>

        <h2>6. Method and limitations</h2>
        <ul className="small">
          <li>Lots: {project.settings.method === 'fifo' ? 'first in, first out' : 'specific identification where the file names a lot, else FIFO'}. Window: 30 days before through 30 days after each loss sale (IRC §1091(a)).</li>
          <li>Replacement shares matched in order of acquisition, each used once; partial wash sales by share count (Treas. Reg. §1.1091-1(b), (c), (d)).</li>
          <li>Disallowed loss added to replacement basis and holding period tacked (IRC §1091(d), §1223(3); Pub. 550). IRA and Roth replacements: loss disallowed, no basis increase (Rev. Rul. 2008-5).</li>
          <li>Substantially identical: same ticker{project.settings.equivalents.length ? `, plus taxpayer-chosen groups ${project.settings.equivalents.map(g => g.join('/')).join('; ')}` : ''}.</li>
          <li>Shares bought and fully sold before a loss sale are not treated as replacement shares.</li>
          {lims.length > 0 && <li>Not analysed: {lims.length} item(s) such as options, short sales or transfers without basis ({[...new Set(lims.map(l => l.kind))].join(', ')}).</li>}
        </ul>
        <p className="small muted">Sources: IRC §1091; Treas. Reg. §1.1091-1; IRS Publication 550, Investment Income and Expenses; Instructions for Form 8949; Rev. Rul. 2008-5. Not tax advice.</p>
      </article>
    </div>
  )
}
