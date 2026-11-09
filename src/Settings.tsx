import type { Broker } from './engine/types.ts'
import { deleteProject, getProjects, saveProject, setPrefs, usePrefs, type Prefs } from './store.ts'
import { exportAll, syncNow, useSync } from './sync.ts'
import { ask, download, Link, money, setTheme, toast, useDark } from './ui.tsx'

export default function Settings() {
  const p = usePrefs()
  const dark = useDark()
  const sync = useSync()
  const save = (patch: Partial<Prefs>, msg = 'Saved') => { setPrefs(patch); toast(msg, { tone: 'ok', ttl: 1500 }) }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel" id="privacy">
        <div className="panel-head"><h2>Privacy and sync</h2>{sync.user ? <span className="chip neutral">Signed in as {sync.user.email}</span> : <span className="chip good">Signed out: nothing syncs</span>}</div>
        <label className="toggle">
          <input type="checkbox" checked={p.syncTrades} onChange={async e => {
            const on = e.target.checked
            save({ syncTrades: on }, on ? 'Parsed trades will sync' : 'Trades stay on this device')
            if (sync.user) { for (const x of getProjects()) await saveProject(x, { silent: true }); void syncNow() }
          }} />
          <span><b>Sync parsed trades when signed in</b><br /><span className="muted small">On by default so another device can open your projects. Off means only accounts, settings, 1099-B totals, prices and snapshots sync, and each device needs its own import. Projects over 1.5 MB of trades never sync their trades.</span></span>
        </label>
        <hr />
        <div className="local-list">
          <div><h3>Always stays on this device</h3><ul><li>The CSV files you drop in</li><li>Trades, if trade sync is off or a project is large</li><li>Everything, if you never sign in</li></ul></div>
          <div><h3>Syncs when you sign in</h3><ul><li>Project names, accounts and their types</li><li>Matching rules, equivalence groups, harvest prices</li><li>1099-B totals and tax-year snapshots</li>{p.syncTrades && <li>Parsed trades up to 1.5 MB per project</li>}</ul></div>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>The engine runs in your browser; there is no server step. <Link href="/docs#privacy">More on data handling</Link>.</p>
      </div>

      <div className="panel">
        <h2>Defaults for new projects</h2>
        <div className="form-grid">
          <label className="field"><span>Lot selection</span>
            <select value={p.method} onChange={e => save({ method: e.target.value as Prefs['method'] })}><option value="fifo">First in, first out</option><option value="specific">Specific ID when the file names a lot</option></select>
          </label>
          <label className="field"><span>First account’s broker</span>
            <select value={p.defaultBroker} onChange={e => save({ defaultBroker: e.target.value as Broker })}><option value="robinhood">Robinhood</option><option value="fidelity">Fidelity</option><option value="schwab">Charles Schwab</option><option value="ibkr">Interactive Brokers</option><option value="generic">Other</option></select>
          </label>
          <label className="field"><span>Harvest target</span><input type="number" min="0" step="100" defaultValue={p.harvestTarget / 100} onBlur={e => save({ harvestTarget: Math.max(0, Math.round(Number(e.target.value) * 100) || 0) })} /><small>Default {money(300000, { cents: false })}: the yearly limit on net capital losses against ordinary income.</small></label>
          <label className="field"><span>Equivalence groups</span>
            <textarea rows={2} defaultValue={p.equivalents.map(g => g.join(', ')).join('\n')} placeholder="VOO, IVV, SPLG" onBlur={e => save({ equivalents: e.target.value.split('\n').map(l => l.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean)).filter(g => g.length > 1) })} />
            <small className="warn-text">Optional and conservative. The IRS has not ruled that different funds on one index are substantially identical.</small>
          </label>
        </div>
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={dark} aria-pressed={dark} onClick={() => setTheme('dark')}>Dark</button>
          <button type="button" role="radio" aria-checked={!dark} aria-pressed={!dark} onClick={() => setTheme('light')}>Light</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Projects live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>.</> : 'Sign in from the account menu to use them on another device. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`wash-sale-lens-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete every project?', `Removes ${list.length} project${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(x => deleteProject(x.id)))
            toast(`Deleted ${list.length} projects`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all projects</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>6</kbd></dt><dd>Switch sections in a project</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next tax year</dd></div>
          <div><dt><kbd>D</kbd></dt><dd>Download Form 8949 CSV</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>CPA packet</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save a snapshot</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last change</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts in a project</dd></div>
        </dl>
      </div>
    </section>
  )
}
