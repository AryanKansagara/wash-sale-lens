import { useEffect, useMemo, useState } from 'react'
import { detect, mergeImport, parseCsv, validate } from './engine/importer.ts'
import { SAMPLES, sampleFiles } from './engine/sample.ts'
import { makeSnapshot } from './engine/snapshot.ts'
import { EMPTY_DATASET, type Account, type Dataset, type Settings, type Txn, type WashResult } from './engine/types.ts'
import { brokerView, runWash, summarize, years, yearOf } from './engine/wash.ts'
import { blankSettings, getData, getPrefs, getProjects, saveProject, useProjects, uuid, type ImportMeta, type Project } from './store.ts'

const sampleCache = new Map<string, { ds: Dataset; imports: Omit<ImportMeta, 'id' | 'at'>[] }>()

/** Builds a sample by running its broker CSVs through the real importer. */
export function sampleData(id: string) {
  const def = SAMPLES.find(s => s.id === id)
  if (!def) return null
  if (!sampleCache.has(id)) {
    let txns: Txn[] = []
    const imports: Omit<ImportMeta, 'id' | 'at'>[] = []
    for (const f of sampleFiles(def)) {
      const csv = parseCsv(f.text)
      const d = detect(csv.rows)
      const v = validate(csv, d.map, d.headerRow, f.name)
      txns = mergeImport(txns, f.account.id, v.rows)
      const dates = v.rows.map(r => r.date).sort()
      imports.push({ accountId: f.account.id, fileName: f.name, format: d.format, rows: v.rows.length, skipped: v.skipped, warnings: v.issues.filter(i => i.level === 'warn').length, range: [dates[0], dates[dates.length - 1]] })
    }
    sampleCache.set(id, { ds: { txns }, imports })
  }
  return sampleCache.get(id)!
}

export async function createSampleProject(sampleId: string): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === sampleId)
  if (existing) return existing
  const def = SAMPLES.find(s => s.id === sampleId)!
  const { ds, imports } = sampleData(sampleId)!
  const accounts: Account[] = def.accounts.map(({ file: _f, ...a }) => a)
  const full = runWash(ds.txns, accounts, def.settings)
  const broker = brokerView(ds.txns, accounts, def.settings)
  // The 1099-B totals a broker would print: what its same-account, same-ticker view computes.
  const reported: Project['reported'] = {}
  for (const a of accounts.filter(a => a.type === 'taxable')) {
    const s = summarize(broker, def.focusYear, new Set([a.id]))
    if (!s.sales) continue
    reported[a.id] = { [def.focusYear]: { proceeds: s.proceeds, cost: s.cost, washDisallowed: s.disallowed, gain: s.net } }
  }
  const now = Date.now()
  const id = uuid()
  // An earlier snapshot taken before the year ended, so History has something to compare.
  const early = ds.txns.filter(t => t.date <= `${def.focusYear}-06-30`)
  const earlyRes = runWash(early, accounts, def.settings)
  const snapshots = [
    { ...makeSnapshot(uuid(), def.focusYear, 'Mid-year check', earlyRes, brokerView(early, accounts, def.settings), accounts, {}, early.length), createdAt: Date.parse(`${def.focusYear}-07-01T12:00:00Z`) },
    { ...makeSnapshot(uuid(), def.focusYear, '1099-B season', full, broker, accounts, Object.fromEntries(Object.entries(reported).map(([k, v]) => [k, v[def.focusYear]])), ds.txns.filter(t => yearOf(t.date) <= def.focusYear).length), createdAt: Date.parse(`${def.focusYear + 1}-02-20T12:00:00Z`) },
  ]
  return saveProject({
    id, name: `${def.name} (sample)`, createdAt: now, updatedAt: now, accounts, settings: def.settings, reported, prices: def.prices, pricesAt: '2026-11-06',
    harvest: { target: getPrefs().harvestTarget }, year: def.focusYear, snapshots, sampleId,
    imports: imports.map(i => ({ ...i, id: uuid(), at: now })),
  })
}

export async function createBlankProject(name: string, accounts?: Account[]): Promise<Project> {
  const now = Date.now()
  const acc = accounts ?? [{ id: uuid().slice(0, 8), name: 'Robinhood individual', broker: getPrefs().defaultBroker, type: 'taxable' as const }]
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, accounts: acc, settings: blankSettings(), reported: {}, prices: {}, harvest: { target: getPrefs().harvestTarget }, snapshots: [], imports: [] })
}

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const [version, setVersion] = useState(0)
  const importsKey = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    if (project.sampleId) { setDs(sampleData(project.sampleId)?.ds ?? EMPTY_DATASET); return }
    void getData(project.id).then(d => { if (live) setDs(d ?? EMPTY_DATASET) })
    return () => { live = false }
  }, [project?.id, project?.sampleId, importsKey, version])
  const update = (patch: Partial<Project>) => project ? saveProject({ ...project, ...patch }) : Promise.resolve(null)
  return { loading: list === null || (project !== null && ds === null), project, ds, update, reload: () => setVersion(v => v + 1) }
}

export interface Analysis { full: WashResult; broker: WashResult; years: number[] }

export function useAnalysis(ds: Dataset | null, accounts: Account[] | undefined, settings: Settings | undefined): Analysis | null {
  return useMemo(() => {
    if (!ds || !accounts || !settings) return null
    const full = runWash(ds.txns, accounts, settings)
    return { full, broker: brokerView(ds.txns, accounts, settings), years: years(full) }
  }, [ds, accounts, settings])
}

/** The tax year to show: from the URL, the project's choice, else the latest year with sales. */
export function pickYear(project: Project, a: Analysis | null): number {
  const q = Number(new URLSearchParams(location.search).get('y'))
  const ys = a?.years ?? []
  if (q && ys.includes(q)) return q
  if (project.year && ys.includes(project.year)) return project.year
  return ys[ys.length - 1] ?? new Date().getFullYear() - 1
}

export const accountName = (p: Project, id: string) => p.accounts.find(a => a.id === id)?.name ?? id
export const accountType = (p: Project, id: string) => p.accounts.find(a => a.id === id)?.type ?? 'taxable'
