// Broker activity import: format detection, column mapping, normalisation and a line-numbered validation report.
import { parseDate, parseNum } from './dates.ts'
import type { Broker, Issue, Txn, TxnKind } from './types.ts'
export { parseCsv, toCsv } from './csv.ts'

export type Kind = 'activity' | 'form1099'
type FieldType = 'date' | 'num' | 'str'
export interface FieldSpec { key: string; label: string; required?: boolean; type: FieldType; aliases: string[]; hint?: string }
const F = (key: string, label: string, type: FieldType, aliases: string[], required = false, hint?: string): FieldSpec => ({ key, label, type, aliases, required, hint })

export const KINDS: Record<Kind, { title: string; fields: FieldSpec[] }> = {
  activity: {
    title: 'Broker activity',
    fields: [
      F('date', 'Trade date', 'date', ['activity_date', 'run_date', 'tradedate', 'trade_date', 'date', 'date/time', 'transaction_date', 'datetime'], true),
      F('action', 'Action / type', 'str', ['trans_code', 'action', 'buy/sell', 'type', 'transaction_type', 'side', 'transactiontype'], false, 'Or a signed quantity'),
      F('symbol', 'Symbol', 'str', ['instrument', 'symbol', 'ticker', 'underlyingsymbol'], true),
      F('qty', 'Quantity', 'num', ['quantity', 'shares', 'qty'], true),
      F('price', 'Price', 'num', ['price', 'price_($)', 'tradeprice', 'trade_price', 't._price', 'price_per_share']),
      F('amount', 'Amount (net)', 'num', ['amount', 'amount_($)', 'netcash', 'net_cash', 'net_amount', 'proceeds', 'total']),
      F('fees', 'Fees and commission', 'num', ['fees_&_comm', 'commission_($)', 'ibcommission', 'comm/fee', 'commission', 'fees', 'fees_($)', 'fee']),
      F('desc', 'Description', 'str', ['description', 'security_description', 'name']),
      F('asset', 'Asset class', 'str', ['assetclass', 'asset_class', 'asset_category', 'security_type', 'type_of_security']),
      F('lotDate', 'Lot acquired (specific ID)', 'date', ['lot_date', 'acquired', 'date_acquired', 'opendatetime', 'lot_acquired']),
      F('ratio', 'Split ratio', 'num', ['ratio', 'split_ratio']),
      F('cusip', 'CUSIP', 'str', ['cusip']),
    ],
  },
  form1099: {
    title: '1099-B detail',
    fields: [
      F('symbol', 'Description / symbol', 'str', ['symbol', 'symbol(cusip)', 'description', 'security_description', 'security', 'description_of_property', '1a_description'], true),
      F('sold', 'Date sold', 'date', ['date_sold', 'date_sold_or_disposed', 'date_sold_or_disposed_of', 'sale_date', '1c_date_sold', 'closed_date'], true),
      F('acquired', 'Date acquired', 'date', ['date_acquired', 'acquired', '1b_date_acquired', 'open_date', 'opened_date']),
      F('proceeds', 'Proceeds', 'num', ['proceeds', 'gross_proceeds', '1d_proceeds', 'sales_price'], true),
      F('cost', 'Cost basis', 'num', ['cost_basis', 'cost', 'cost_or_other_basis', '1e_cost_basis', 'adjusted_cost_basis', 'cost_basis_(cb)']),
      F('wash', 'Wash sale loss disallowed', 'num', ['wash_sale_loss_disallowed', 'wash_sale', 'wash_sale_disallowed', '1g_wash_sale_loss_disallowed', 'wash_sale_loss', 'disallowed_loss', 'amount_of_adjustment', 'adjustment_amount', 'adjustment'], true, 'Form 8949 style files: the adjustment column, kept only on code W rows'),
      F('code', 'Adjustment code', 'str', ['code(s)_from_instructions', 'adjustment_code', 'code(s)', 'code']),
      F('gain', 'Gain or loss', 'num', ['gain_or_loss', 'gain/loss', 'realized_gain/loss', 'gain_(loss)', 'gain_or_(loss)', 'net_gain_or_loss', 'total_gain/loss_($)']),
    ],
  },
}

// Form 8949 column letters ("(d) Proceeds") are dropped so the plain names match.
export const norm = (h: string) => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/\s+/g, '_').replace(/^\([a-h]\)_/, '')

export interface Format { id: Broker | '1099'; kind: Kind; label: string; test(hs: Set<string>): boolean }
export const FORMATS: Format[] = [
  { id: 'robinhood', kind: 'activity', label: 'Robinhood account activity report', test: h => h.has('activity_date') && h.has('trans_code') && h.has('instrument') },
  { id: 'fidelity', kind: 'activity', label: 'Fidelity account history', test: h => h.has('run_date') && h.has('action') && h.has('symbol') },
  { id: 'schwab', kind: 'activity', label: 'Charles Schwab transactions', test: h => h.has('fees_&_comm') && h.has('action') && h.has('date') },
  { id: 'ibkr', kind: 'activity', label: 'Interactive Brokers Flex Query (Trades)', test: h => (h.has('tradedate') || h.has('date/time')) && (h.has('tradeprice') || h.has('netcash') || h.has('ibcommission')) },
  { id: 'ibkr', kind: 'activity', label: 'Interactive Brokers Activity Statement (Trades)', test: h => h.has('datadiscriminator') && h.has('t._price') },
  { id: '1099', kind: 'form1099', label: '1099-B detail (consolidated CSV)', test: h => [...h].some(x => x.includes('wash') || x === 'amount_of_adjustment' || x === 'adjustment_amount' || x === 'adjustment') && [...h].some(x => x.includes('proceeds') || x === 'sales_price') },
]

export type Mapping = Record<string, number>

/** IBKR Activity Statements stack many sections in one CSV ("Trades,Header,..." / "Trades,Data,Order,..."). Keeps the
 * stock and option Trades section only, dropping subtotals, totals and closed-lot detail rows; line numbers are kept. */
export function trades(csv: { rows: string[][]; lines: number[] }): { rows: string[][]; lines: number[] } {
  const h = csv.rows.findIndex(r => r[0] === 'Trades' && r[1] === 'Header')
  if (h < 0) return csv
  const head = csv.rows[h].join('|')
  // Forex and other asset classes get their own Trades header with different columns; skip their rows.
  let current = ''
  const keep = csv.rows.map((r, i) => {
    if (r[0] === 'Trades' && r[1] === 'Header') { current = r.join('|'); return i === h }
    return r[0] === 'Trades' && r[1] === 'Data' && /^(Order|Trade)$/.test(r[2] ?? '') && current === head
  })
  return { rows: csv.rows.filter((_, i) => keep[i]), lines: csv.lines.filter((_, i) => keep[i]) }
}

export function autoMap(kind: Kind, headers: string[]): Mapping {
  const hs = headers.map(norm)
  const map: Mapping = {}
  const used = new Set<number>()
  for (const f of KINDS[kind].fields) {
    const i = f.aliases.map(a => hs.indexOf(a)).find(i => i >= 0 && !used.has(i))
    if (i !== undefined) { map[f.key] = i; used.add(i) }
  }
  return map
}

export interface Detection { kind: Kind | null; broker: Broker; format: string; headerRow: number; map: Mapping }

/** Finds the header row (Fidelity and Schwab put titles and blank lines above it) and the source format. */
export function detect(rows: string[][]): Detection {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const hs = new Set(rows[r].map(norm))
    const fmt = FORMATS.find(f => f.test(hs))
    if (fmt) return { kind: fmt.kind, broker: fmt.id === '1099' ? 'generic' : fmt.id, format: fmt.label, headerRow: r, map: autoMap(fmt.kind, rows[r]) }
  }
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    for (const kind of ['form1099', 'activity'] as Kind[]) {
      const map = autoMap(kind, rows[r])
      if (KINDS[kind].fields.every(f => !f.required || f.key in map)) return { kind, broker: 'generic', format: kind === 'activity' ? 'Generic CSV' : '1099-B detail (generic CSV)', headerRow: r, map }
    }
  }
  return { kind: null, broker: 'generic', format: 'Unknown', headerRow: 0, map: {} }
}

// ---------- Classifying an action ----------

const OPTION_CODES = /^(BTO|STO|BTC|STC|OEXP|OASGN|OEXCS|OCA)$/i
/** OCC option symbols, Fidelity's "-AAPL250117C150" and Robinhood's "AAPL 1/17/2025 Call $150.00". */
const OPTION_TEXT = /(^-?[A-Z]{1,6}\s*\d{6}[CP]\d|\b(call|put)\b.*\$\d|\b\d{1,2}\/\d{1,2}\/\d{4} (call|put)\b)/i

export function classify(action: string, desc: string, qty: number, asset: string, symbol: string): TxnKind | 'skip' {
  const a = action.trim()
  const t = `${a} ${desc}`.toLowerCase()
  if (/^forex|^cash$/i.test(asset)) return 'skip'
  if (/^(opt|fop|war)|option|warrant|future/i.test(asset) || OPTION_CODES.test(a) || OPTION_TEXT.test(symbol) || OPTION_TEXT.test(desc) || /\b(to open|to close|assigned|exercised|expired)\b/.test(t)) return 'option'
  if (/short|buy to cover/.test(t)) return 'short'
  if (/^(spl|spr)$/i.test(a) || /\bsplit\b/.test(t) || /^distribution/i.test(a)) return 'split'
  if (/^acat[io]$/i.test(a)) return !qty ? 'skip' : /i$/i.test(a) ? 'transfer_in' : 'transfer_out'
  // Cash moving in or out (EFT, MoneyLink, journals of cash) has no shares: not a trade.
  if (/transfer|journal|acat|received from|delivered/.test(t)) return !qty ? 'skip' : qty < 0 || /\bto\b|out|delivered/.test(t) ? 'transfer_out' : 'transfer_in'
  if (/^(buy|bot|b)$/i.test(a) || /you bought|^bought|reinvest(ment)? shares|^reinvestment|\bbuy\b|recurring/.test(t)) return 'buy'
  if (/^(sell|sld|s)$/i.test(a) || /you sold|^sold|\bsell\b/.test(t)) return 'sell'
  if (!a && qty) return qty > 0 ? 'buy' : 'sell'
  return 'skip'
}

export function autoTag(action: string, desc: string): Txn['auto'] {
  const t = `${action} ${desc}`.toLowerCase()
  if (/reinvest|drip|dividend re/.test(t)) return 'drip'
  if (/recurring|auto[- ]?invest|automatic investment/.test(t)) return 'recurring'
  return undefined
}

// ---------- Validation ----------

export type ParsedTxn = Omit<Txn, 'accountId' | 'seq' | 'id'> & { line: number }
export interface Validated { rows: ParsedTxn[]; issues: Issue[]; skipped: number; total: number }

export interface Row1099 { line: number; symbol: string; sold: string; acquired?: string; proceeds: number; cost: number; wash: number; gain: number }

const cents = (v: number) => Math.round(v * 100)
const cleanSymbol = (s: string) => s.trim().replace(/^"|"$/g, '').replace(/\*+$/, '').trim().toUpperCase()

/** Turns CSV records into transactions, with a report naming the line of every skipped or broken row. */
export function validate(csv: { rows: string[][]; lines: number[] }, map: Mapping, headerRow: number, file = 'file'): Validated {
  const issues: Issue[] = []
  const total = csv.rows.length - headerRow - 1
  for (const f of KINDS.activity.fields) if (f.required && !(f.key in map)) issues.push({ line: csv.lines[headerRow] ?? 1, message: `Required column "${f.label}" is not mapped` })
  if (issues.length) return { rows: [], issues, skipped: total, total }
  const get = (rec: string[], k: string) => map[k] === undefined ? '' : (rec[map[k]] ?? '').trim()
  const header = csv.rows[headerRow].map(norm).join('|')
  // A column called Proceeds (IBKR statements, many generic files) is gross: commission is a separate column.
  const gross = map.amount !== undefined && map.fees !== undefined && norm(csv.rows[headerRow][map.amount] ?? '') === 'proceeds'
  const out: ParsedTxn[] = []
  let skipped = 0
  for (let r = headerRow + 1; r < csv.rows.length; r++) {
    const rec = csv.rows[r]
    const line = csv.lines[r]
    if (rec.map(norm).join('|') === header) { skipped++; issues.push({ line, message: 'Repeated header row skipped', level: 'skip' }); continue }
    const rawDate = get(rec, 'date')
    const date = parseDate(rawDate)
    if (!date) {
      const first = rec.find(c => c.trim())?.trim() ?? ''
      if (rec.filter(c => c.trim()).length <= 2 || first.length > 60) { skipped++; issues.push({ line, message: `Note or footer skipped ("${first.slice(0, 50)}${first.length > 50 ? '…' : ''}")`, level: 'skip' }); continue }
      skipped++; issues.push({ line, message: rawDate ? `Date "${rawDate.slice(0, 30)}" is not a date` : 'Date is empty' }); continue
    }
    const action = get(rec, 'action'), desc = get(rec, 'desc').replace(/\s+/g, ' ')
    const symbol = cleanSymbol(get(rec, 'symbol'))
    const qtyRaw = parseNum(get(rec, 'qty').replace(/[^\d.,()$-]/g, ''))
    const kind = classify(action, desc, Number.isNaN(qtyRaw) ? 0 : qtyRaw, get(rec, 'asset'), symbol)
    if (kind === 'skip') { skipped++; issues.push({ line, message: `${action || 'Row'}${desc ? ` (${desc.slice(0, 40)})` : ''}: not a share trade, skipped`, level: 'skip' }); continue }
    if (kind === 'option' || kind === 'short') {
      out.push({ date, kind, symbol: symbol || desc.split(' ')[0], qty: Math.abs(qtyRaw) || 0, amount: 0, desc, src: { file, line }, line })
      issues.push({ line, message: `${kind === 'option' ? 'Option' : 'Short sale'} ${symbol || desc.slice(0, 30)} kept as a limitation; not analysed for wash sales`, level: 'warn' })
      continue
    }
    if (!symbol) { skipped++; issues.push({ line, message: `${action} has no symbol` }); continue }
    if (!/^[A-Z0-9.\-/ ]{1,12}$/.test(symbol)) { skipped++; issues.push({ line, message: `Symbol "${symbol.slice(0, 20)}" does not look like a stock or fund ticker` }); continue }
    const qty = Math.abs(qtyRaw)
    const ratio = parseNum(get(rec, 'ratio'))
    if (kind === 'split') {
      if (!(qty > 0) && !(ratio > 0)) { skipped++; issues.push({ line, message: 'Split with no share quantity or ratio' }); continue }
      out.push({ date, kind, symbol, qty: Number.isNaN(qty) ? 0 : qty, amount: 0, ...(ratio > 0 ? { ratio } : {}), desc, src: { file, line }, line })
      continue
    }
    if (!(qty > 0)) { skipped++; issues.push({ line, message: `Quantity "${get(rec, 'qty')}" is not a positive number` }); continue }
    const price = Math.abs(parseNum(get(rec, 'price')))
    const amt = parseNum(get(rec, 'amount'))
    const fees = Math.abs(parseNum(get(rec, 'fees'))) || 0
    let amount: number
    if (!Number.isNaN(amt) && amt !== 0) amount = gross ? Math.abs(amt) + (kind === 'sell' ? -fees : fees) : Math.abs(amt)
    else if (!Number.isNaN(price)) amount = kind === 'sell' ? qty * price - fees : qty * price + fees
    else if (kind === 'transfer_in' || kind === 'transfer_out') amount = 0
    else { skipped++; issues.push({ line, message: `${kind === 'buy' ? 'Buy' : 'Sell'} of ${symbol} has neither price nor amount` }); continue }
    if (kind === 'transfer_in' || kind === 'transfer_out') issues.push({ line, message: `Transfer ${kind === 'transfer_in' ? 'in' : 'out'} of ${qty} ${symbol}${amount ? '' : ' with no cost basis'}: flagged as a limitation`, level: 'warn' })
    const lotDate = parseDate(get(rec, 'lotDate')) ?? undefined
    const cusip = (get(rec, 'cusip') || desc.match(/CUSIP:?\s*([0-9A-Z]{9})/i)?.[1] || '').toUpperCase() || undefined
    const auto = kind === 'buy' ? autoTag(action, desc) : undefined
    out.push({ date, kind, symbol, qty, amount: cents(amount), desc, src: { file, line }, line, ...(lotDate ? { lotDate } : {}), ...(cusip ? { cusip } : {}), ...(auto ? { auto } : {}) })
  }
  // Robinhood and most brokers list newest first. Replay needs oldest first, keeping same-day order meaningful.
  const descending = out.length > 1 && out[0].date > out[out.length - 1].date
  const rows = descending ? [...out].reverse() : out
  return { rows, issues, skipped, total }
}

export function validate1099(csv: { rows: string[][]; lines: number[] }, map: Mapping, headerRow: number): { rows: Row1099[]; issues: Issue[] } {
  const issues: Issue[] = []
  const rows: Row1099[] = []
  for (const f of KINDS.form1099.fields) if (f.required && !(f.key in map)) issues.push({ line: csv.lines[headerRow] ?? 1, message: `Required column "${f.label}" is not mapped` })
  if (issues.length) return { rows, issues }
  const get = (rec: string[], k: string) => map[k] === undefined ? '' : (rec[map[k]] ?? '').trim()
  for (let r = headerRow + 1; r < csv.rows.length; r++) {
    const rec = csv.rows[r], line = csv.lines[r]
    const sold = parseDate(get(rec, 'sold'))
    if (!sold) { issues.push({ line, message: `Row skipped: date sold "${get(rec, 'sold').slice(0, 20)}" is not a date (totals and notes are skipped)`, level: 'skip' }); continue }
    const proceeds = parseNum(get(rec, 'proceeds')), cost = parseNum(get(rec, 'cost')), gain = parseNum(get(rec, 'gain'))
    // Form 8949 style files carry every adjustment in one column; only code W is a wash sale.
    const code = get(rec, 'code').toUpperCase()
    const wash = map.code !== undefined && !code.includes('W') ? 0 : parseNum(get(rec, 'wash'))
    if (Number.isNaN(proceeds)) { issues.push({ line, message: `Proceeds "${get(rec, 'proceeds')}" is not a number` }); continue }
    const c = Number.isNaN(cost) ? NaN : cost
    rows.push({
      line, symbol: get(rec, 'symbol').replace(/^\s*[\d.,]+\s*(sh|shs|shares?)\.?\s+(of\s+)?/i, '').split(/[\s,(]/)[0].replace(/\*+$/, '').toUpperCase(), sold, acquired: parseDate(get(rec, 'acquired')) ?? undefined,
      proceeds: cents(proceeds), cost: Number.isNaN(c) ? 0 : cents(c), wash: Number.isNaN(wash) ? 0 : cents(Math.abs(wash)),
      gain: Number.isNaN(gain) ? cents(proceeds - (Number.isNaN(c) ? 0 : c) + (Number.isNaN(wash) ? 0 : Math.abs(wash))) : cents(gain),
    })
  }
  return { rows, issues }
}

/** Stable ids from content and occurrence, so re-importing the same export does not duplicate trades. */
function hash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519) }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}

/** Adds an imported file to an account: replaces that account's trades in the file's date range, then renumbers. */
export function mergeImport(existing: Txn[], accountId: string, rows: ParsedTxn[]): Txn[] {
  if (!rows.length) return existing
  const dates = rows.map(r => r.date).sort()
  const lo = dates[0], hi = dates[dates.length - 1]
  const kept = existing.filter(t => t.accountId !== accountId || t.date < lo || t.date > hi)
  const seen = new Map<string, number>()
  const added: Txn[] = rows.map(({ line: _l, ...r }) => {
    const k = `${accountId}|${r.date}|${r.kind}|${r.symbol}|${r.qty}|${r.amount}`
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return { ...r, accountId, id: hash(`${k}#${n}`), seq: 0 }
  })
  // Keep file order within a day for each account; interleave accounts by date.
  const all = [...kept.sort((a, b) => a.seq - b.seq), ...added]
  const order = new Map(all.map((t, i) => [t.id + t.accountId, i]))
  return all.sort((a, b) => a.date.localeCompare(b.date) || order.get(a.id + a.accountId)! - order.get(b.id + b.accountId)!).map((t, i) => ({ ...t, seq: i + 1 }))
}
