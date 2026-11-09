// node scripts/qa-sync.mjs : signs up a throwaway account, round-trips a project and a snapshot, then deletes the account
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => l.split('=')))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
const email = `qa-wash-sale-lens-${Date.now()}@example.com`, password = 'qa-' + Math.random().toString(36).slice(2) + 'X9!'
const up = await sb.auth.signUp({ email, password })
if (up.error) { console.log('sign-up failed:', up.error.message); process.exit(1) }
console.log('signed up', email, 'session', !!up.data.session)
const id = crypto.randomUUID()
const r1 = await sb.from('projects').upsert({ id, app: 'wash-sale-lens', name: 'QA project', data: { project: { id, name: 'QA project' }, dataset: { txns: [] } }, updated_at: new Date().toISOString() })
console.log('project upsert', r1.error?.message ?? 'ok')
const r2 = await sb.from('project_versions').upsert({ id: crypto.randomUUID(), project_id: id, label: '2025 · QA', data: { year: 2025 } })
console.log('version upsert', r2.error?.message ?? 'ok')
const r3 = await sb.from('projects').select('id,name').eq('app', 'wash-sale-lens')
console.log('read back', r3.data?.length, r3.error?.message ?? '')
const d = await sb.rpc('delete_my_account')
console.log(d.error ? 'delete failed: ' + d.error.message : 'deleted ' + email)
