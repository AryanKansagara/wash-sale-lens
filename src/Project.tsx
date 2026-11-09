import { lazy, Suspense, useEffect, useState } from 'react'
import { toCsv } from './engine/csv.ts'
import { makeSnapshot } from './engine/snapshot.ts'
import type { Dataset } from './engine/types.ts'
import { form8949Rows } from './engine/wash.ts'
import { pickYear, useAnalysis, useProject, type Analysis } from './projectData.ts'
import { uuid, type Project } from './store.ts'
import { download, go, isTyping, Link, Modal, SyntheticBadge, toast } from './ui.tsx'

const Panels = lazy(() => import('./Panels.tsx'))
const Harvest = lazy(() => import('./Harvest.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [['washes', 'Wash sales'], ['form8949', 'Form 8949'], ['reconcile', '1099-B check'], ['harvest', 'Harvest planner'], ['history', 'History'], ['data', 'Accounts & data']] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps {
  project: Project
  ds: Dataset
  a: Analysis
  year: number
  update(p: Partial<Project>): void
  reload(): void
  onTab(t: Tab): void
}

export const download8949 = (p: Project, a: Analysis, year: number) => {
  download(`form-8949-${year}-${p.name.replace(/\W+/g, '-').toLowerCase()}.csv`, toCsv(form8949Rows(a.full, p.accounts, year)))
  toast(`Downloaded the ${year} Form 8949 rows`, { tone: 'ok' })
}

export function saveSnapshot(p: Project, ds: Dataset, a: Analysis, year: number, update: (x: Partial<Project>) => void, label?: string) {
  const reported = Object.fromEntries(p.accounts.map(x => [x.id, p.reported[x.id]?.[year]]))
  const snap = makeSnapshot(uuid(), year, label ?? `Saved ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, a.full, a.broker, p.accounts, reported, ds.txns.length)
  const before = p.snapshots
  update({ snapshots: [...p.snapshots, snap] })
  toast(`Saved a ${year} snapshot`, { tone: 'ok', undo: () => update({ snapshots: before }) })
}

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, ds, update, reload } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'washes') as Tab
  const a = useAnalysis(ds, project?.accounts, project?.settings)
  const year = project ? pickYear(project, a) : new Date().getFullYear()
  const [help, setHelp] = useState(false)

  useEffect(() => { if (project) document.title = `${project.name} · ${year} · Wash Sale Lens` }, [project?.name, year])

  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'washes' ? '' : '/' + t}${location.search}`, { keepScroll: true })
  const setYear = (y: number) => { go(`${location.pathname}?y=${y}`, { replace: true, keepScroll: true }); void update({ year: y }) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1][0]) }
      else if (e.key === '?') setHelp(true)
      else if (e.key === 'p' && project) go(`/app/p/${id}/packet?y=${year}`)
      else if (e.key === 'd' && project && a) download8949(project, a, year)
      else if (e.key === 's' && project && a && ds) saveSnapshot(project, ds, a, year, update)
      else if ((e.key === '[' || e.key === ']') && a) {
        const i = a.years.indexOf(year)
        const y = a.years[e.key === '[' ? i - 1 : i + 1]
        if (y) setYear(y)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading || (project && !a)) return <div className="boot" role="status"><span className="spinner" /> Matching lots and replacement shares</div>
  if (!project || !ds || !a) return (
    <section className="page narrow center notfound">
      <h1>Project not found</h1>
      <p className="muted">It may have been deleted, or it lives on another device and has not synced yet.</p>
      <Link href="/app" className="btn primary">Back to projects</Link>
    </section>
  )

  const empty = ds.txns.length === 0
  const props: TabProps = { project, ds, a, year, update, reload, onTab: setTab }

  return (
    <section className="page project">
      <div className="project-head">
        <div className="crumbs"><Link href="/app">Projects</Link><span aria-hidden="true">/</span></div>
        <div className="row between wrap gap">
          <div className="project-title">
            <h1>{project.name}</h1>
            {project.sampleId && <SyntheticBadge />}
          </div>
          <div className="row gap-sm wrap">
            {a.years.length > 0 && (
              <div className="seg" role="group" aria-label="Tax year">
                {a.years.map(y => <button key={y} type="button" aria-pressed={y === year} onClick={() => setYear(y)}>{y}</button>)}
              </div>
            )}
            {!empty && <button type="button" className="btn ghost sm" onClick={() => download8949(project, a, year)}>8949 CSV</button>}
            {!empty && <Link href={`/app/p/${id}/packet?y=${year}`} className="btn primary sm">CPA packet</Link>}
          </div>
        </div>
      </div>
      <nav className="tabs" aria-label="Project sections">
        {TABS.map(([k, label], i) => (
          <Link key={k} href={`/app/p/${id}${k === 'washes' ? '' : '/' + k}${location.search}`} aria-current={tab === k ? 'page' : undefined} title={`${label} (${i + 1})`}>{label}</Link>
        ))}
      </nav>
      <Suspense fallback={<div className="boot" role="status"><span className="spinner" /> Loading</div>}>
        {empty && tab !== 'data' ? (
          <div className="empty big">
            <div className="empty-icon" aria-hidden="true" />
            <h3>No trades yet</h3>
            <p className="muted">Import your Robinhood activity report (and your other accounts) to see every wash sale.</p>
            <div className="row gap center-x"><button type="button" className="btn primary" onClick={() => setTab('data')}>Import trades</button><Link href="/docs" className="btn ghost">How to export</Link></div>
          </div>
        ) : tab === 'harvest' ? <Harvest {...props} /> : tab === 'data' ? <DataTab {...props} /> : <Panels {...props} tab={tab} />}
      </Suspense>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>6</kbd></dt><dd>Switch sections</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next tax year</dd></div>
          <div><dt><kbd>D</kbd></dt><dd>Download Form 8949 CSV</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable CPA packet</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save a snapshot of this year</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last change</dd></div>
        </dl>
      </Modal>
    </section>
  )
}
