// Excerpts written to match the real layouts of each broker's export (headers, preambles, footers, cash rows,
// codes and number formats). Account numbers, names and amounts are invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect, mergeImport, parseCsv, trades, validate, validate1099 } from './importer.ts'
import { form8949Rows, runWash, summarize } from './wash.ts'
import { toCsv } from './csv.ts'
import type { Account, Txn } from './types.ts'

const read = (text: string) => {
  const csv = trades(parseCsv(text))
  const d = detect(csv.rows)
  return { csv, d, v: d.kind === 'activity' ? validate(csv, d.map, d.headerRow) : null, f: d.kind === 'form1099' ? validate1099(csv, d.map, d.headerRow) : null }
}
const errors = (v: { issues: { level?: string; line: number; message: string }[] }) => v.issues.filter(i => !i.level || i.level === 'error')

test('Robinhood activity report: SPL split rows, fractional buys, options and cash codes', () => {
  const text = [
    '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"',
    '"7/15/2024","7/15/2024","7/16/2024","NVDA","NVIDIA\nCUSIP: 67066G104","Sell","100","$128.44","$12,844.00"',
    '"7/1/2024","7/1/2024","7/1/2024","","Gold Subscription Fee","GOLD","","","($5.00)"',
    '"6/20/2024","6/20/2024","6/21/2024","AAPL","AAPL 7/19/2024 Call $220.00","BTO","1","$2.10","($210.00)"',
    '"6/10/2024","6/10/2024","6/10/2024","NVDA","NVIDIA\nCUSIP: 67066G104\nStock Split","SPL","90S","",""',
    '"5/2/2024","5/2/2024","5/3/2024","VOO","Vanguard S&P 500 ETF\nCUSIP: 922908363","Buy","0.211873","$471.95","($99.99)"',
    '"4/1/2024","4/1/2024","4/1/2024","","ACH Deposit","ACH","","","$2,000.00"',
    '"3/4/2024","3/4/2024","3/5/2024","NVDA","NVIDIA\nCUSIP: 67066G104","Buy","10","$852.37","($8,523.70)"',
    '"3/1/2024","3/1/2024","3/1/2024","","Interest Payment","INT","","","$0.42"',
    '',
    '"","","","","","","","","The data provided is for informational purposes only. Please consult a professional tax service or personal tax advisor if you need instructions on how to calculate cost basis or questions regarding your specific tax situation. Reminder: This data does not include Robinhood Crypto or Robinhood Spending activity."',
  ].join('\n')
  const { d, v } = read(text)
  assert.equal(d.broker, 'robinhood')
  assert.deepEqual(errors(v!), [])
  assert.deepEqual(v!.rows.map(r => [r.date, r.kind, r.symbol, r.qty]), [
    ['2024-03-04', 'buy', 'NVDA', 10], ['2024-05-02', 'buy', 'VOO', 0.211873], ['2024-06-10', 'split', 'NVDA', 90],
    ['2024-06-20', 'option', 'AAPL', 1], ['2024-07-15', 'sell', 'NVDA', 100],
  ])
  const acct: Account = { id: 'rh', name: 'RH', broker: 'robinhood', type: 'taxable' }
  const res = runWash(mergeImport([], 'rh', v!.rows), [acct], { method: 'fifo', equivalents: [] })
  const sale = res.pieces.filter(p => p.symbol === 'NVDA')
  assert.equal(sale.reduce((s, p) => s + p.qty, 0), 100)
  assert.equal(sale.reduce((s, p) => s + p.cost, 0), 852370, 'the split keeps total basis')
})

test('Fidelity history (Account columns, Cash Balance): cash transfers and core money market are not errors', () => {
  const text = [
    '', '',
    'Run Date,Account,Account Number,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date',
    '04/08/2025,"Individual","Z12345678"," YOU SOLD APPLE INC (AAPL) (Cash)", AAPL,"APPLE INC",Cash,-10,172.41,,0.02,,1724.08,1824.08,04/09/2025',
    '04/01/2025,"Individual","Z12345678"," REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)", SPAXX**,"FIDELITY GOVERNMENT MONEY MARKET",Cash,0.37,1,,,,-0.37,100.00,',
    '03/31/2025,"Individual","Z12345678"," Electronic Funds Transfer Received (Cash)", ,"No Description",Cash,0.000,,,,,500,100.37,',
    '03/03/2025,"Individual","Z12345678"," YOU BOUGHT APPLE INC (AAPL) (Cash)", AAPL,"APPLE INC",Cash,10,238.03,,,,-2380.30,0.00,03/04/2025',
    '', '',
    '"The data and information in this spreadsheet is provided to you solely for your use and is not for distribution. The spreadsheet is provided for informational purposes only, and is not intended to provide advice, nor should it be construed as an offer to sell, a solicitation of an offer to buy or a recommendation for any security or insurance product by Fidelity or any third party."',
    '"Date downloaded 11/06/2026 9:14 pm"',
  ].join('\n')
  const { d, v } = read(text)
  assert.equal(d.broker, 'fidelity')
  assert.deepEqual(errors(v!), [])
  assert.deepEqual(v!.rows.map(r => [r.kind, r.symbol, r.qty, r.amount]), [['buy', 'AAPL', 10, 238030], ['buy', 'SPAXX', 0.37, 37], ['sell', 'AAPL', 10, 172408]])
})

test('Schwab transactions: MoneyLink, journals, stock split and the Transactions Total footer', () => {
  const text = [
    '"Transactions  for account Individual ...123 as of 11/06/2026 21:14:02 ET"',
    '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
    '"06/11/2024","Sell","NVDA","NVIDIA CORP","50","$121.79","$0.06","$6,089.44"',
    '"06/10/2024 as of 06/07/2024","Stock Split","NVDA","NVIDIA CORP","45","","",""',
    '"05/20/2024","MoneyLink Transfer","","Tfr BANK OF AMERICA, J DOE","","","","$5,000.00"',
    '"05/02/2024","Buy","NVDA","NVIDIA CORP","5","$858.17","","-$4,290.85"',
    '"04/30/2024","Journal","","JOURNAL FRM ...456","","","","$100.00"',
    '"Transactions Total","","","","","","","$10,798.59"',
  ].join('\n')
  const { d, v } = read(text)
  assert.equal(d.broker, 'schwab')
  assert.deepEqual(errors(v!), [])
  assert.deepEqual(v!.rows.map(r => [r.kind, r.qty]), [['buy', 5], ['split', 45], ['sell', 50]])
})

test('IBKR Activity Statement: Trades section only, gross proceeds plus commission, forex skipped', () => {
  const text = [
    'Statement,Header,Field Name,Field Value',
    'Statement,Data,Title,Activity Statement',
    'Statement,Data,Period,"January 1, 2025 - December 31, 2025"',
    'Account Information,Header,Field Name,Field Value',
    'Account Information,Data,Account,U1234567',
    'Net Asset Value,Header,Asset Class,Prior Total,Current Long,Current Short,Current Total,Change',
    'Net Asset Value,Data,Stock,0,4800,0,4800,4800',
    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code',
    'Trades,Data,Order,Stocks,USD,AMD,"2025-03-03, 10:01:12",25,101.2,100.9,-2530,-1,2531,0,-7.5,O',
    'Trades,Data,Order,Stocks,USD,AMD,"2025-04-08, 15:40:55",-25,81.5,80.95,2037.5,-1.02,-2531,-494.52,13.75,C',
    'Trades,SubTotal,,Stocks,USD,AMD,,0,,,-492.5,-2.02,0,-494.52,6.25,',
    'Trades,Total,,Stocks,USD,,,,,,-492.5,-2.02,0,-494.52,6.25,',
    'Trades,Data,Order,Equity and Index Options,USD,AMD 18APR25 90 P,"2025-04-01, 09:45:00",1,4.1,4.3,-410,-0.7,410.7,0,20,O',
    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,,Proceeds,Comm in USD,,,MTM in USD,Code',
    'Trades,Data,Order,Forex,USD,EUR.USD,"2025-02-03, 08:00:00",1000,1.03,,-1030,-2,,,0,',
    'Dividends,Header,Currency,Date,Description,Amount',
    'Dividends,Data,USD,2025-05-15,AMD Cash Dividend,0.00',
  ].join('\n')
  const { d, v } = read(text)
  assert.equal(d.format, 'Interactive Brokers Activity Statement (Trades)')
  assert.deepEqual(errors(v!), [])
  assert.deepEqual(v!.rows.map(r => [r.kind, r.symbol, r.qty, r.amount]), [['buy', 'AMD', 25, 253100], ['sell', 'AMD', 25, 203648], ['option', 'AMD 18APR25 90 P', 1, 0]])
  assert.equal(v!.rows[0].line, 9, 'line numbers still point into the original file')
})

test('Form 8949 style CSV: only code W adjustments count as wash sales', () => {
  const text = [
    'Description of property,Date acquired,Date sold or disposed of,Proceeds,Cost or other basis,Code(s) from instructions,Amount of adjustment,Gain or (loss)',
    '40 sh PLTR,01/06/2025,02/24/2025,2592.80,2992.40,W,399.60,0.00',
    '10 sh XYZ,01/06/2025,03/24/2025,500.00,700.00,B,25.00,-175.00',
    '8 sh AAPL,01/13/2025,09/02/2025,1852.88,1945.12,,,(92.24)',
  ].join('\n')
  const { d, f } = read(text)
  assert.equal(d.kind, 'form1099')
  assert.deepEqual(f!.rows.map(r => [r.symbol, r.wash, r.gain]), [['PLTR', 39960, 0], ['XYZ', 0, -17500], ['AAPL', 0, -9224]])
})

test('Schwab Realized Gain/Loss export and Fidelity symbol(CUSIP) read as 1099-B detail', () => {
  const schwab = [
    '"Realized Gain/Loss for Individual ...123 for 01/01/2025 to 12/31/2025 as of Thu Nov 06 21:14:02 EST 2026"',
    '"Symbol","Name","Closed Date","Opened Date","Quantity","Proceeds","Cost Basis (CB)","Total Gain/Loss ($)","Wash Sale?","Disallowed Loss"',
    '"TSLA","TESLA INC","03/10/2025","02/03/2025","10","$2,215.40","$3,830.00","-$1,614.60","No","--"',
    '"AMD","ADVANCED MICRO DEVICES","04/08/2025","03/03/2025","25","$2,036.48","$2,531.00","$0.00","Yes","$494.52"',
    '"Total","","","","","$4,251.88","$6,361.00","-$1,614.60","",""',
  ].join('\n')
  const s = read(schwab)
  assert.equal(s.d.kind, 'form1099')
  assert.deepEqual(s.f!.rows.map(r => [r.symbol, r.acquired, r.cost, r.wash, r.gain]), [['TSLA', '2025-02-03', 383000, 0, -161460], ['AMD', '2025-03-03', 253100, 49452, 0]])
  const fid = 'Symbol(CUSIP),Security Description,Quantity,Date Acquired,Date Sold,Proceeds,Cost Basis,Wash Sale Loss Disallowed,Gain/Loss\nNVDA(67066G104),NVIDIA CORP,30,01/07/2025,04/04/2025,2829.00,4140.00,,-1311.00\n'
  assert.equal(read(fid).f!.rows[0].symbol, 'NVDA')
})

// IRS Publication 550, "Wash Sales": the worked examples, to the dollar.
const acct: Account = { id: 'a', name: 'A', broker: 'generic', type: 'taxable' }
let n = 0
const t = (date: string, kind: 'buy' | 'sell', qty: number, usd: number): Txn => ({ id: `p${++n}`, seq: n, accountId: 'a', date, kind, symbol: 'X', qty, amount: usd * 100 })

test('Pub 550 example 1: $250 loss disallowed, new basis $800 + $250 = $1,050', () => {
  const res = runWash([t('2025-01-02', 'buy', 100, 1000), t('2025-03-03', 'sell', 100, 750), t('2025-03-20', 'buy', 100, 800)], [acct], { method: 'fifo', equivalents: [] })
  assert.equal(res.pieces[0].disallowed, 25000)
  assert.equal(res.lots.find(l => l.acquired === '2025-03-20')!.cost, 105000)
})

test('Pub 550 example 2: rebuy at $1,100 gives a basis of $1,350', () => {
  const res = runWash([t('2025-01-02', 'buy', 100, 1000), t('2025-03-03', 'sell', 100, 750), t('2025-03-20', 'buy', 100, 1100)], [acct], { method: 'fifo', equivalents: [] })
  assert.equal(res.lots.find(l => l.acquired === '2025-03-20')!.cost, 135000)
})

test('Pub 550 example 3: 50 replacement shares bought before the sale disallow the loss on 50 of 100 shares', () => {
  const res = runWash([t('2025-09-24', 'buy', 100, 1000), t('2025-12-21', 'buy', 50, 400), t('2025-12-28', 'sell', 100, 700)], [acct], { method: 'fifo', equivalents: [] })
  const loss = res.pieces.filter(p => p.sold === '2025-12-28')
  assert.equal(loss.reduce((s, p) => s + p.disallowed, 0), 15000)
  assert.equal(summarize(res, 2025).disallowed, 15000)
})

test('this app\'s own Form 8949 CSV reads back as 1099-B detail with the same wash total', () => {
  const res = runWash([t('2025-01-02', 'buy', 100, 1000), t('2025-03-03', 'sell', 100, 750), t('2025-03-20', 'buy', 100, 800), t('2025-06-02', 'sell', 100, 1200)], [acct], { method: 'fifo', equivalents: [] })
  const { d, f } = read(toCsv(form8949Rows(res, [acct], 2025)))
  assert.equal(d.kind, 'form1099')
  assert.deepEqual(f!.rows.map(r => [r.symbol, r.wash, r.gain]), [['X', 25000, 0], ['X', 0, 15000]])
})
