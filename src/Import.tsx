import { useMemo, useRef, useState } from 'react'
import { toCsv } from './engine/csv.ts'
import { autoMap, detect, KINDS, mergeImport, parseCsv, validate, validate1099, type Kind, type Mapping } from './engine/importer.ts'
import { ACCOUNT_TYPES, SAMPLES, sampleFiles } from './engine/sample.ts'
import type { Account, AccountType, Broker, Issue } from './engine/types.ts'
import { yearOf } from './engine/wash.ts'
import type { TabProps } from './Project.tsx'
import { createBlankProject } from './projectData.ts'
import { getPrefs, putData, uuid } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, go, Link, money, plural, toast } from './ui.tsx'

const BROKERS: Record<Broker, string> = { robinhood: 'Robinhood', fidelity: 'Fidelity', schwab: 'Charles Schwab', ibkr: 'Interactive Brokers', generic: 'Other / generic' }

interface Pending { id: string; name: string; format: string; broker: Broker; kind: Kind | null; headerRow: number; csv: ReturnType<typeof parseCsv>; map: Mapping; accountId: string }

export default function DataTab({ project, ds, update, reload }: TabProps) {
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()
  const sample = SAMPLES.find(s => s.id === project.sampleId)

  const pickAccount = (b: Broker) => project.accounts.filter(a => a.broker === b).length === 1 ? project.accounts.find(a => a.broker === b)!.id : project.accounts.length === 1 && !ds.txns.length ? project.accounts[0].id : 'new'

  const readFiles = async (files: FileList | File[]) => {
    setBusy(true)
    const next: Pending[] = []
    for (const f of [...files]) {
      if (f.size > 40_000_000) { toast(`${f.name} is over 40 MB. Export a shorter date range.`, { tone: 'error' }); continue }
      const csv = parseCsv(await f.text())
      if (csv.rows.length < 2) { toast(`${f.name} has no rows.`, { tone: 'error' }); continue }
      const d = detect(csv.rows)
      next.push({ id: uuid(), name: f.name, format: d.format, broker: d.broker, kind: d.kind, headerRow: d.headerRow, csv, map: d.map, accountId: pickAccount(d.broker) })
    }
    setPending(p => [...p, ...next])
    setBusy(false)
  }

  const ensureAccount = (p: Pending): { accounts: Account[]; id: string } => {
    if (p.accountId !== 'new') return { accounts: project.accounts, id: p.accountId }
    const n = project.accounts.filter(a => a.broker === p.broker).length
    const acct: Account = { id: uuid().slice(0, 8), name: `${BROKERS[p.broker]}${n ? ` ${n + 1}` : ''}`, broker: p.broker, type: 'taxable' }
    return { accounts: [...project.accounts, acct], id: acct.id }
  }

  const commitActivity = async (p: Pending) => {
    const v = validate(p.csv, p.map, p.headerRow, p.name)
    const { accounts, id } = ensureAccount(p)
    const next = { txns: mergeImport(ds.txns, id, v.rows) }
    await putData(project.id, next)
    const dates = v.rows.map(r => r.date).sort()
    const meta = { id: uuid(), accountId: id, fileName: p.name, format: p.format, rows: v.rows.length, skipped: v.skipped, warnings: v.issues.filter(i => i.level === 'warn').length, range: [dates[0], dates[dates.length - 1]] as [string, string], at: Date.now() }
    const before = { imports: project.imports, accounts: project.accounts, txns: ds }
    await update({ accounts, imports: [...project.imports, meta], dataMissing: false })
    setPending(x => x.filter(y => y.id !== p.id))
    reload()
    toast(`Imported ${plural(v.rows.length, 'row')} into ${accounts.find(a => a.id === id)!.name}${v.skipped ? `, skipped ${v.skipped}` : ''}`, {
      tone: 'ok', undo: () => { void putData(project.id, before.txns).then(() => { void update({ imports: before.imports, accounts: before.accounts }); reload() }) },
    })
  }

  const commit1099 = (p: Pending) => {
    const v = validate1099(p.csv, p.map, p.headerRow)
    const { accounts, id } = ensureAccount(p)
    const byYear = new Map<number, { proceeds: number; cost: number; washDisallowed: number; gain: number }>()
    for (const r of v.rows) {
      const y = yearOf(r.sold)
      const t = byYear.get(y) ?? { proceeds: 0, cost: 0, washDisallowed: 0, gain: 0 }
      t.proceeds += r.proceeds; t.cost += r.cost; t.washDisallowed += r.wash; t.gain += r.gain
      byYear.set(y, t)
    }
    const cur = project.reported[id] ?? {}
    void update({ accounts, reported: { ...project.reported, [id]: { ...cur, ...Object.fromEntries([...byYear].map(([y, t]) => [y, t])) } } })
    setPending(x => x.filter(y => y.id !== p.id))
    toast(`Read 1099-B totals for ${[...byYear.keys()].join(', ')}. See the 1099-B check tab.`, { tone: 'ok' })
  }

  const setAccount = (id: string, patch: Partial<Account>) => update({ accounts: project.accounts.map(a => a.id === id ? { ...a, ...patch } : a) })
  const rawSize = useMemo(() => project.sampleId ? 0 : JSON.stringify(ds).length, [ds, project.sampleId])
  const count = (id: string) => ds.txns.filter(t => t.accountId === id).length

  return (
    <div className="tab-body">
      {project.dataMissing && <div className="fix-banner warn"><div><strong>The trades for this project are on another device.</strong><p className="small">Settings, 1099-B totals and snapshots synced, but trade sync was off or the file was too large. Re-import the CSVs here.</p></div></div>}

      <div className="panel">
        <div className="panel-head wrap"><h2>Import activity</h2><Link href="/docs#exports" className="linkish small">Export steps for Robinhood, Fidelity, Schwab and IBKR &rarr;</Link></div>
        {sample ? (
          <div className="fix-banner">
            <div>
              <p className="small" style={{ margin: 0 }}>This sample is read-only. Download its broker files to see exactly what the importer reads, or start a project with your own exports.</p>
            </div>
            <div className="row gap-sm wrap">
              <button type="button" className="btn ghost sm" onClick={() => sampleFiles(sample).forEach((f, i) => setTimeout(() => download(f.name, f.text), i * 300))}>Download sample files</button>
              <button type="button" className="btn primary sm" onClick={async () => { const p = await createBlankProject('My trades'); go(`/app/p/${p.id}/data`) }}>Start my own project</button>
            </div>
          </div>
        ) : (
          <div className={`dropzone${drag ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}>
            <div className="drop-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg></div>
            <p style={{ fontSize: '1.1rem' }}><strong>Drop broker CSVs here</strong> or <button type="button" className="linkish" onClick={() => input.current?.click()}>choose files</button></p>
            <p className="muted small">Robinhood account activity report, Fidelity account history, Schwab transactions, IBKR Flex Query (Trades), a generic CSV, or 1099-B detail. Import every account, including IRAs: that is where the hidden wash sales are.</p>
            <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
            {busy && <p role="status"><span className="spinner" /> Reading files</p>}
          </div>
        )}
        {pending.map(p => <PendingCard key={p.id} p={p} accounts={project.accounts} onChange={np => setPending(x => x.map(y => y.id === p.id ? np : y))} onCancel={() => setPending(x => x.filter(y => y.id !== p.id))} onCommit={() => p.kind === 'form1099' ? commit1099(p) : void commitActivity(p)} />)}
      </div>

      <div className="panel">
        <div className="panel-head wrap"><h2>Accounts</h2>{!sample && <button type="button" className="btn ghost sm" onClick={() => update({ accounts: [...project.accounts, { id: uuid().slice(0, 8), name: `Account ${project.accounts.length + 1}`, broker: getPrefs().defaultBroker, type: 'taxable' }] })}>Add account</button>}</div>
        <p className="muted small">Account type matters: a replacement purchase in an IRA or Roth makes the loss permanent, so mark them correctly.</p>
        <div className="accounts">
          {project.accounts.map(acc => (
            <div key={acc.id} className={`account-row ${acc.type}`}>
              <label className="field"><span>Name</span><input defaultValue={acc.name} disabled={!!sample} onBlur={e => { const v = e.target.value.trim(); if (v && v !== acc.name) void setAccount(acc.id, { name: v }) }} /></label>
              <label className="field"><span>Broker</span><select value={acc.broker} disabled={!!sample} onChange={e => void setAccount(acc.id, { broker: e.target.value as Broker })}>{Object.entries(BROKERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="field"><span>Type</span><select value={acc.type} disabled={!!sample} onChange={e => void setAccount(acc.id, { type: e.target.value as AccountType })}>{Object.entries(ACCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <div className="account-meta"><b>{plural(count(acc.id), 'trade')}</b>
                {!sample && <button type="button" className="btn danger-ghost sm" onClick={async () => {
                  if (!(await ask(`Remove ${acc.name}?`, `Removes the account and its ${plural(count(acc.id), 'trade')} from this project. You can undo for a few seconds.`, 'Remove'))) return
                  const before = { accounts: project.accounts, imports: project.imports, ds }
                  await putData(project.id, { txns: ds.txns.filter(t => t.accountId !== acc.id) })
                  await update({ accounts: project.accounts.filter(a => a.id !== acc.id), imports: project.imports.filter(i => i.accountId !== acc.id) })
                  reload()
                  toast(`Removed ${acc.name}`, { undo: () => { void putData(project.id, before.ds).then(() => { void update({ accounts: before.accounts, imports: before.imports }); reload() }) } })
                }}>Remove</button>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {project.imports.length > 0 && (
        <div className="panel">
          <h2>Imported files</h2>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>File</th><th>Account</th><th className="hide-sm">Format</th><th className="hide-sm">Dates</th><th className="num">Trades</th><th className="num">Skipped</th></tr></thead>
            <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th scope="row" className="break">{i.fileName}</th><td>{project.accounts.find(a => a.id === i.accountId)?.name ?? 'removed'}</td><td className="hide-sm muted">{i.format}</td><td className="hide-sm">{i.range[0]} to {i.range[1]}</td><td className="num">{i.rows.toLocaleString()}</td><td className="num">{i.skipped}</td></tr>)}</tbody>
          </table></div>
          {!project.sampleId && rawSize > 200 && <p className="muted small" style={{ marginTop: 12 }}>Trades on this device: {(rawSize / 1e6).toFixed(2)} MB. {sync.user ? !getPrefs().syncTrades ? 'Trade sync is off, so they stay here.' : rawSize > RAW_SYNC_LIMIT ? 'Too large to sync; settings, totals and snapshots sync, trades stay here.' : 'Synced with your account. The original files never leave this browser.' : 'Not synced: you are signed out.'}</p>}
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><h2>Matching rules</h2><span className="muted small">Saved automatically</span></div>
        <div className="form-grid">
          <label className="field"><span>Lot selection</span>
            <select value={project.settings.method} disabled={!!sample} onChange={e => update({ settings: { ...project.settings, method: e.target.value as 'fifo' | 'specific' } })}><option value="fifo">First in, first out (broker default)</option><option value="specific">Specific ID when the file names a lot</option></select>
            <small>Specific ID uses a lot date column (generic CSV) when present, then falls back to FIFO.</small>
          </label>
          <Equivalents value={project.settings.equivalents} disabled={!!sample} onChange={eq => update({ settings: { ...project.settings, equivalents: eq } })} />
        </div>
      </div>

      {!sample && ds.txns.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Danger zone</h2></div>
          <div className="row between wrap gap">
            <p className="small" style={{ margin: 0 }}>Remove every imported trade from this project on this device. Accounts, 1099-B totals and snapshots stay.</p>
            <button type="button" className="btn danger-ghost sm" onClick={async () => {
              if (!(await ask('Clear imported trades?', 'Removes all trades from this project on this device. You can undo for a few seconds.', 'Clear trades'))) return
              const before = ds, imports = project.imports
              await putData(project.id, { txns: [] })
              await update({ imports: [] })
              reload()
              toast('Trades cleared', { undo: () => { void putData(project.id, before).then(() => { void update({ imports }); reload() }) } })
            }}>Clear trades</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Equivalents({ value, onChange, disabled }: { value: string[][]; onChange(v: string[][]): void; disabled: boolean }) {
  const text = value.map(g => g.join(', ')).join('\n')
  return (
    <label className="field wide"><span>Substantially identical groups (optional)</span>
      <textarea rows={3} defaultValue={text} key={text} disabled={disabled} placeholder={'VOO, IVV, SPLG\nQQQ, QQQM'} onBlur={e => {
        const groups = e.target.value.split('\n').map(l => [...new Set(l.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean))]).filter(g => g.length > 1)
        if (JSON.stringify(groups) !== JSON.stringify(value)) { onChange(groups); toast(groups.length ? `Treating ${groups.length} group${groups.length > 1 ? 's' : ''} as substantially identical` : 'Using same-ticker matching only', { tone: 'ok' }) }
      }} />
      <small className="warn-text">By default only the same ticker counts. The IRS has never said whether two funds tracking the same index are substantially identical. Grouping them is the cautious choice, not a ruling. One group per line.</small>
    </label>
  )
}

function PendingCard({ p, accounts, onChange, onCancel, onCommit }: { p: Pending; accounts: Account[]; onChange(p: Pending): void; onCancel(): void; onCommit(): void }) {
  const headers = p.csv.rows[p.headerRow] ?? []
  const first = p.csv.rows[p.headerRow + 1] ?? []
  const v = useMemo(() => {
    if (p.kind === 'activity') { const r = validate(p.csv, p.map, p.headerRow, p.name); return { count: r.rows.length, issues: r.issues, skipped: r.skipped, buys: r.rows.filter(x => x.kind === 'buy').length, sells: r.rows.filter(x => x.kind === 'sell').length, dates: r.rows.map(x => x.date).sort() } }
    if (p.kind === 'form1099') { const r = validate1099(p.csv, p.map, p.headerRow); return { count: r.rows.length, issues: r.issues, skipped: r.issues.length, buys: 0, sells: r.rows.length, dates: r.rows.map(x => x.sold).sort(), wash: r.rows.reduce((s, x) => s + x.wash, 0) } }
    return null
  }, [p])
  const [showAll, setShowAll] = useState(false)
  const issues: Issue[] = v?.issues ?? []
  const errors = issues.filter(i => i.level !== 'skip' && i.level !== 'warn')
  return (
    <div className="pending">
      <div className="row between wrap gap-sm">
        <div><strong className="break">{p.name}</strong> <span className="muted small">{p.format} · {plural(p.csv.rows.length - p.headerRow - 1, 'row')}{p.headerRow ? `, header on line ${p.csv.lines[p.headerRow]}` : ''}</span></div>
        <div className="row gap-sm wrap">
          <label className="ctl inline"><span>File type</span>
            <select value={p.kind ?? ''} onChange={e => { const k = (e.target.value || null) as Kind | null; onChange({ ...p, kind: k, map: k ? autoMap(k, headers) : {} }) }}>
              <option value="">Unknown</option><option value="activity">Broker activity</option><option value="form1099">1099-B detail</option>
            </select>
          </label>
          <label className="ctl inline"><span>Account</span>
            <select value={p.accountId} onChange={e => onChange({ ...p, accountId: e.target.value })}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({ACCOUNT_TYPES[a.type]})</option>)}
              <option value="new">+ New {BROKERS[p.broker]} account</option>
            </select>
          </label>
        </div>
      </div>
      {!p.kind ? <p className="warn-text small">These columns do not match a format we know. Pick the file type, then map the columns.</p> : (
        <>
          <details className="mapping-wrap" open={p.format.startsWith('Generic') || p.format === 'Unknown' || !!errors.length}>
            <summary className="small">Column mapping</summary>
            <div className="mapping">
              {KINDS[p.kind].fields.map(f => (
                <label key={f.key} className="map-row">
                  <span>{f.label}{f.required && <b className="req" aria-label="required">*</b>}</span>
                  <select value={p.map[f.key] ?? ''} onChange={e => { const m = { ...p.map }; if (e.target.value === '') delete m[f.key]; else m[f.key] = Number(e.target.value); onChange({ ...p, map: m }) }} aria-invalid={f.required && p.map[f.key] === undefined}>
                    <option value="">Not in file</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                  <code className="sample">{p.map[f.key] !== undefined ? (first[p.map[f.key]] ?? '').replace(/\s+/g, ' ').slice(0, 32) || '(empty)' : f.hint ?? ''}</code>
                </label>
              ))}
            </div>
          </details>
          {v && (
            <div className={`report ${errors.length ? (v.count ? 'warn' : 'bad') : 'good'}`}>
              <div className="row between wrap gap-sm">
                <span><b>{v.count.toLocaleString()}</b> {p.kind === 'form1099' ? `1099-B rows, wash sale total ${money(('wash' in v ? v.wash : 0) ?? 0)}` : `trades (${v.buys} buys, ${v.sells} sells)`}{v.dates.length ? `, ${v.dates[0]} to ${v.dates[v.dates.length - 1]}` : ''}{v.skipped ? <>, <b>{v.skipped}</b> skipped</> : ''}{errors.length ? `, ${plural(errors.length, 'problem')}` : ', no problems'}</span>
                {issues.length > 0 && <button type="button" className="btn ghost sm" onClick={() => download(`${p.name.replace(/\.\w+$/, '')}-validation.csv`, toCsv([['line', 'level', 'issue'], ...issues.map(i => [i.line, i.level ?? 'error', i.message])]))}>Download report</button>}
              </div>
              {issues.length > 0 && (
                <ul className="issues">
                  {issues.slice(0, showAll ? 1000 : 6).map((i, k) => <li key={k} className={i.level ?? 'error'}><span className="mono">line {i.line}</span> {i.message}</li>)}
                  {issues.length > 6 && !showAll && <li><button type="button" className="linkish small" onClick={() => setShowAll(true)}>Show all {issues.length}</button></li>}
                </ul>
              )}
            </div>
          )}
          <div className="row end gap-sm">
            <button type="button" className="btn ghost sm" onClick={onCancel}>Discard</button>
            <button type="button" className="btn primary sm" disabled={!v || !v.count} onClick={onCommit}>{p.kind === 'form1099' ? 'Use these 1099-B totals' : `Import ${v?.count.toLocaleString()} trades`}</button>
          </div>
        </>
      )}
    </div>
  )
}
