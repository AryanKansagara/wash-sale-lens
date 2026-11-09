import { useEffect, useMemo, useState } from 'react'
import { ACCOUNT_TYPES, SAMPLES } from './engine/sample.ts'
import { createBlankProject, createSampleProject } from './projectData.ts'
import { deleteProject, saveProject, useProjects, type Project } from './store.ts'
import { useSync } from './sync.ts'
import { ask, go, Link, money, plural, SyntheticBadge, toast } from './ui.tsx'

export default function Workspace() {
  const list = useProjects()
  const sync = useSync()
  const [busy, setBusy] = useState<string | null>(null)

  // /app?sample=dip-buyer opens (or creates) the sample straight away.
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const s = q.get('sample')
    const tab = q.get('tab')?.replace(/[^a-z0-9]/g, '')
    if (!s || list === null || busy) return
    if (!SAMPLES.some(x => x.id === s)) return
    setBusy(s)
    void createSampleProject(s).then(p => go(`/app/p/${p.id}${tab ? '/' + tab : ''}`, { replace: true }))
  }, [list, busy])

  const openSample = async (id: string) => { setBusy(id); const p = await createSampleProject(id); go(`/app/p/${p.id}`) }
  const newProject = async () => {
    const n = (list?.filter(p => !p.sampleId).length ?? 0) + 1
    const p = await createBlankProject(n === 1 ? 'My trades' : `My trades ${n}`)
    go(`/app/p/${p.id}/data`)
  }

  if (list === null || busy) return <div className="boot" role="status"><span className="spinner" /> {busy ? 'Importing the synthetic trader’s files' : 'Opening your projects'}</div>

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Projects</h1>
          <p className="muted">One project per taxpayer (or household). Put every account in it: Robinhood, your other brokers, your IRA and Roth. {sync.user ? 'Synced to your account.' : 'Stored in this browser only.'}</p>
        </div>
        {list.length > 0 && <button type="button" className="btn primary" onClick={newProject}>New project</button>}
      </div>

      {list.length === 0 ? (
        <div className="onboard">
          <article className="onboard-card feature">
            <div className="eyebrow neon-text">Two minutes</div>
            <h2>Try a sample trader</h2>
            <p>Synthetic traders with real-looking broker files, already imported through the same importer your files use.</p>
            <div className="stack-sm">
              {SAMPLES.map(s => (
                <button key={s.id} type="button" className="sample-btn" onClick={() => void openSample(s.id)}>
                  <span><strong>{s.name}</strong><small>{s.blurb}</small></span><span aria-hidden="true">&rarr;</span>
                </button>
              ))}
            </div>
          </article>
          <article className="onboard-card">
            <div className="eyebrow">Your trades</div>
            <h2>Import your data</h2>
            <p>In Robinhood: Account → Reports and statements → Reports → Generate new report, choose the date range, then download the CSV. Add your other brokers and IRAs the same way.</p>
            <div className="row gap wrap">
              <button type="button" className="btn primary" onClick={newProject}>Import your data</button>
              <Link href="/docs" className="btn ghost">Export steps per broker</Link>
            </div>
            <p className="muted small" style={{ marginTop: 16 }}>Files are read in your browser. Nothing is uploaded unless you sign in to sync, and even then the original files stay here.</p>
          </article>
        </div>
      ) : (
        <>
          <div className="project-grid">{list.map(p => <ProjectCard key={p.id} p={p} />)}</div>
          <div className="samples-row">
            <span className="muted small">Sample traders:</span>
            {SAMPLES.map(s => <button key={s.id} type="button" className="linkish small" onClick={() => void openSample(s.id)}>{s.name}</button>)}
          </div>
        </>
      )}
    </section>
  )
}

function ProjectCard({ p }: { p: Project }) {
  const [renaming, setRenaming] = useState(false)
  const last = useMemo(() => [...p.snapshots].sort((a, b) => b.createdAt - a.createdAt)[0], [p.snapshots])
  return (
    <article className="project-card">
      <div className="row between gap-sm">
        {renaming ? (
          <form onSubmit={e => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('n')).trim(); if (v) void saveProject({ ...p, name: v }); setRenaming(false) }}>
            <input name="n" defaultValue={p.name} autoFocus aria-label="Project name" onBlur={e => e.currentTarget.form?.requestSubmit()} />
          </form>
        ) : <h3><Link href={`/app/p/${p.id}`}>{p.name}</Link></h3>}
        {p.sampleId && <SyntheticBadge />}
      </div>
      <div className="acct-chips">{p.accounts.map(a => <span key={a.id} className={`acct-chip ${a.type}`}>{a.name}<small>{a.type === 'taxable' ? '' : ` · ${ACCOUNT_TYPES[a.type]}`}</small></span>)}</div>
      <dl className="mini-stats">
        <div><dt>Last snapshot</dt><dd>{last ? `${last.year} · ${last.label}` : 'None yet'}</dd></div>
        <div><dt>Disallowed</dt><dd>{last ? money(last.summary.disallowed, { cents: false }) : '—'}</dd></div>
        <div><dt>Lost to IRA</dt><dd className={last?.summary.permanent ? 'loss' : ''}>{last ? money(last.summary.permanent, { cents: false }) : '—'}</dd></div>
      </dl>
      {p.dataMissing && <p className="warn-text small">The trades for this project live on another device. Re-import the CSVs here to analyse.</p>}
      <div className="row between">
        <span className="muted small">{plural(p.imports.length, 'file')} · updated {new Date(p.updatedAt).toLocaleDateString()}</span>
        <div className="row gap-sm">
          <button type="button" className="btn ghost sm" onClick={() => setRenaming(true)}>Rename</button>
          <button type="button" className="btn danger-ghost sm" onClick={async () => {
            if (!(await ask(`Delete “${p.name}”?`, 'Removes the project, its trades and its snapshots from this device (and the cloud, if you are signed in). You can undo for a few seconds.', 'Delete'))) return
            const undo = await deleteProject(p.id)
            toast(`Deleted ${p.name}`, { undo: () => void undo() })
          }}>Delete</button>
        </div>
      </div>
    </article>
  )
}
