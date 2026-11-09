export type AccountType = 'taxable' | 'ira' | 'roth'
export type Broker = 'robinhood' | 'fidelity' | 'schwab' | 'ibkr' | 'generic'

export interface Account { id: string; name: string; broker: Broker; type: AccountType }

export type TxnKind = 'buy' | 'sell' | 'split' | 'transfer_in' | 'transfer_out' | 'option' | 'short' | 'dividend'

/** One normalised row of broker activity. Money in cents; share counts may be fractional. */
export interface Txn {
  id: string
  accountId: string
  date: string
  kind: TxnKind
  symbol: string
  qty: number
  /** Buys: total cost including fees. Sells: proceeds net of fees. Cents, always positive. */
  amount: number
  /** For splits: new shares per old share. */
  ratio?: number
  /** Specific-ID sale: the acquisition date of the lot to sell first. */
  lotDate?: string
  /** Recurring investment or dividend reinvestment, from the broker's description. */
  auto?: 'recurring' | 'drip'
  cusip?: string
  desc?: string
  /** Where the row came from, for the validation report and the CPA packet. */
  src?: { file: string; line: number }
  seq: number
}

export interface Settings {
  method: 'fifo' | 'specific'
  /** Groups of tickers to treat as substantially identical, e.g. [["VOO","IVV","SPLG"]]. */
  equivalents: string[][]
}

export const DEFAULT_SETTINGS: Settings = { method: 'fifo', equivalents: [] }

export interface Replacement {
  lotId: string
  accountId: string
  accountType: AccountType
  acquired: string
  qty: number
  /** Disallowed loss moved into that lot's basis (zero basis change for IRA lots, which is the point). */
  amount: number
  symbol: string
  permanent: boolean
}

/** One Form 8949 row: a sale of one lot (or part of one). */
export interface Piece {
  id: string
  saleId: string
  accountId: string
  symbol: string
  qty: number
  acquired: string
  holdingStart: string
  sold: string
  proceeds: number
  cost: number
  /** Disallowed wash sale loss, positive (column g, code W). */
  disallowed: number
  /** Part of `disallowed` that went into an IRA or Roth and never comes back (Rev. Rul. 2008-5). */
  permanent: number
  /** Earlier disallowed losses already sitting in this lot's basis and now part of this sale. */
  carriedIn: number
  carriedFrom: { pieceId: string; amount: number }[]
  replacements: Replacement[]
  term: 'short' | 'long'
  /** Gain or loss after the adjustment: proceeds - cost + disallowed. */
  gain: number
  lotId: string
}

export interface Lot {
  id: string
  accountId: string
  accountType: AccountType
  symbol: string
  group: string
  acquired: string
  /** The day the shares arrived in the account (differs from `acquired` for transfers that keep their original date). */
  arrived: string
  holdingStart: string
  qty: number
  cost: number
  /** Wash sale adjustment included in cost, with where it came from. */
  adj: number
  adjFrom: { pieceId: string; amount: number; holdDays: number }[]
  usedAsReplacement: boolean
  closedBy?: string
  buyId: string
  seq: number
  auto?: Txn['auto']
}

export interface Issue { line: number; message: string; level?: 'error' | 'warn' | 'skip' }

export interface Limitation { kind: 'option' | 'short' | 'transfer' | 'unmatched' | 'split'; accountId: string; symbol: string; date: string; message: string }

export interface WashResult {
  pieces: Piece[]
  lots: Lot[]
  limitations: Limitation[]
}

/** Typed totals from a 1099-B, per account and tax year. Cents. */
export interface Reported { proceeds?: number; cost?: number; washDisallowed?: number; gain?: number }

export interface Dataset { txns: Txn[] }
export const EMPTY_DATASET: Dataset = { txns: [] }
