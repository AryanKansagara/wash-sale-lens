import { useEffect } from 'react'
import { Code, Link } from './ui.tsx'

const GENERIC = `date,action,symbol,quantity,price,amount,fees,lot_date,ratio
2025-01-06,buy,PLTR,40,78.20,3128.00,0,,
2025-02-24,sell,PLTR,40,64.10,2564.00,0,2025-01-06,
2025-06-10,split,NVDA,,,,,,10
2024-03-01,transfer_in,AAPL,10,,1700.00,,2019-05-14,`

const SECTIONS = [['exports', 'Getting your data out'], ['generic', 'Generic CSV format'], ['form1099', '1099-B totals'], ['rules', 'The rules we apply'], ['method', 'Method and assumptions'], ['limits', 'Limitations'], ['privacy', 'Privacy and sync']] as const

export default function Docs() {
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView() }, [])
  return (
    <section className="page docs">
      <nav className="docs-nav" aria-label="Docs sections">
        <div className="eyebrow">Docs</div>
        {SECTIONS.map(([id, l]) => <a key={id} href={`#${id}`}>{l}</a>)}
      </nav>
      <div className="docs-body">
        <h1>Docs</h1>
        <p className="lede">How to export your activity from each broker, what the importer expects, and exactly which IRS rules the engine applies. Export steps last checked <b>November 2026</b>; brokers move menus, so tell us if one has changed.</p>
        <p className="callout small"><b>Not tax advice.</b> Wash Sale Lens is a calculator and an explainer. Confirm your return with a tax professional.</p>

        <h2 id="exports">Getting your data out</h2>
        <p>Export <b>every</b> account you (and your spouse, if filing jointly) own that holds the same stocks, including IRAs and Roth IRAs. Include at least 31 days before the start of the tax year so January sales can find their replacement shares, and ideally your full history so lots have a real cost basis.</p>

        <h3>Robinhood: account activity report</h3>
        <ol>
          <li>On robinhood.com or in the app, open <b>Account</b> → <b>Reports and statements</b> → <b>Reports</b>.</li>
          <li>Choose <b>Generate new report</b>, pick the account (individual or IRA, one at a time) and a custom date range. Robinhood prepares it in the background; you get a notification when it is ready.</li>
          <li>Download the CSV. It has the columns <code>Activity Date, Process Date, Settle Date, Instrument, Description, Trans Code, Quantity, Price, Amount</code>; newer files may add <code>Account Type</code> and <code>Suppressed</code>, which are ignored.</li>
        </ol>
        <p className="small muted">Trans codes read: <code>Buy</code>, <code>Sell</code>, <code>SPL</code>/<code>SPR</code> (splits: Quantity is the shares added), <code>ACATI</code>/<code>ACATO</code> (transfers, flagged). Options codes (<code>BTO, STC, STO, BTC, OEXP, OASGN, OEXCS</code>) are listed as limitations. Dividends, deposits, interest and fees are skipped and shown in the validation report. The file lists newest first and ends with a disclaimer row; both are handled. Descriptions containing “Recurring” or “Reinvest” tag automatic buys. Robinhood Crypto activity is not in this report and crypto is not covered by §1091 in any case.</p>

        <h3>Fidelity: account history</h3>
        <ol>
          <li>Go to <b>Accounts &amp; Trade</b> → <b>Portfolio</b>, select the account, then <b>Activity &amp; Orders</b>.</li>
          <li>Set the date range (export longer ranges in pieces if needed) and choose <b>Download</b> (the CSV icon).</li>
          <li>The file (often <code>Accounts_History.csv</code>) starts with blank lines; the importer finds the header row (<code>Run Date, Action, Symbol, …, Amount ($)</code>) and skips the disclaimer at the bottom. Both the older layout and the newer one with <code>Account</code>, <code>Account Number</code> and <code>Cash Balance ($)</code> columns are read. <code>YOU BOUGHT</code>, <code>YOU SOLD</code> and <code>REINVESTMENT</code> rows are read; cash rows such as <code>Electronic Funds Transfer Received</code> are skipped, and the <code>**</code> Fidelity puts after core money market symbols (<code>SPAXX**</code>) is dropped.</li>
        </ol>

        <h3>Charles Schwab: transaction history</h3>
        <ol>
          <li>Go to <b>Accounts</b> → <b>History</b> → <b>Transactions</b>, pick the account and date range.</li>
          <li>Choose <b>Export</b> and download CSV. Columns: <code>Date, Action, Symbol, Description, Quantity, Price, Fees &amp; Comm, Amount</code>.</li>
          <li><code>Buy</code>, <code>Sell</code>, <code>Reinvest Shares</code> (tagged DRIP) and <code>Stock Split</code> are read; <code>Reinvest Dividend</code> is the cash leg and is skipped. Dates like “11/03/2025 as of 11/01/2025” use the first date. The account title line above the header, cash rows (<code>MoneyLink Transfer</code>, cash <code>Journal</code>) and the closing <code>Transactions Total</code> row are skipped.</li>
        </ol>

        <h3>Interactive Brokers: Flex Query (Trades)</h3>
        <ol>
          <li>In Client Portal: <b>Performance &amp; Reports</b> → <b>Flex Queries</b> → create an <b>Activity Flex Query</b>.</li>
          <li>Add the <b>Trades</b> section at execution level with at least <code>Symbol, AssetClass, TradeDate, Quantity, TradePrice, IBCommission, NetCash, Buy/Sell</code> (add <code>CUSIP</code> and <code>Description</code> if you like). Format: <b>CSV</b>, dates <code>yyyyMMdd</code>.</li>
          <li>Run it for your period and download. Signed quantities and repeated header rows are handled; <code>OPT</code> rows are limitations.</li>
        </ol>
        <h3>Interactive Brokers: Activity Statement (CSV)</h3>
        <p className="small">The default statement from <b>Performance &amp; Reports</b> → <b>Statements</b> → <b>Activity</b>, format <b>CSV</b>, also works. Only the <code>Trades</code> section is read: <code>Order</code> rows for stocks and options; subtotals, totals, forex conversions and every other section are ignored. <code>Proceeds</code> there is gross, so <code>Comm/Fee</code> is added to buys and taken off sales.</p>

        <h2 id="generic">Generic CSV format</h2>
        <p>For any other broker, or to add a transfer with its original cost, use these columns (only date, action, symbol and quantity are required; give price or amount):</p>
        <Code code={GENERIC} label="CSV" />
        <ul className="small">
          <li><code>action</code>: buy, sell, split, transfer_in, transfer_out. Signed quantity works if there is no action column.</li>
          <li><code>amount</code>: total cost of a buy including fees, or net proceeds of a sale. If missing, quantity × price ± fees is used.</li>
          <li><code>lot_date</code>: for sales, the lot to sell first under specific ID; for transfers in, the original purchase date.</li>
          <li><code>ratio</code>: new shares per old share for a split (10 for a 10-for-1).</li>
        </ul>

        <h2 id="form1099">1099-B totals</h2>
        <p>On the <b>1099-B check</b> tab, type each taxable account’s totals from the summary page of your consolidated 1099: box 1d (proceeds), box 1e (cost basis), box 1g (wash sale loss disallowed) and the net gain or loss. If your broker offers 1099-B detail as CSV, drop it in instead; rows with a wash sale column are recognised and summed by year. Also read: Schwab’s <b>Realized Gain/Loss</b> export (<code>Disallowed Loss</code> column), Fidelity closed positions with <code>Symbol(CUSIP)</code>, and Form 8949 style files from tax software (<code>Code(s) from instructions</code>, <code>Amount of adjustment</code>), where only rows with code W count as wash sales. This app’s own Form 8949 CSV reads back in the same way.</p>
        <p><b>Does box 1e already include the wash sale?</b> Box 1e is the adjusted basis, so it already includes losses deferred from earlier wash sales the broker tracked inside that account. Box 1g is this sale’s disallowed loss, added back on Form 8949 in column (g) with code W.</p>

        <h2 id="rules">The rules we apply</h2>
        <table className="data rules-table">
          <tbody>
            <tr><th scope="row">IRC §1091(a)</th><td>A loss on stock is disallowed if, within 30 days before or after the sale, you acquire substantially identical stock (a 61-day window including the sale day).</td></tr>
            <tr><th scope="row">Treas. Reg. §1.1091-1(b)–(d)</th><td>If fewer shares are acquired than sold, only that many shares’ loss is disallowed, matched to the loss shares in the order they were acquired. Replacement shares are matched in the order they were acquired, and each is used only once.</td></tr>
            <tr><th scope="row">IRC §1091(d); §1223(3)</th><td>The disallowed loss is added to the basis of the replacement shares, and the holding period of the sold shares is added to theirs.</td></tr>
            <tr><th scope="row">IRS Publication 550</th><td>Wash sales include purchases by your spouse and by your IRA or Roth IRA. A wash sale stays deferred until the replacement shares are sold without another wash sale.</td></tr>
            <tr><th scope="row">Rev. Rul. 2008-5</th><td>If the replacement shares are bought in your IRA or Roth IRA, the loss is disallowed and the IRA’s basis is not increased. The loss is gone.</td></tr>
            <tr><th scope="row">Form 8949 instructions</th><td>Report a wash sale with code W in column (f) and the disallowed loss as a positive number in column (g). Brokers must report wash sales only for identical securities (same CUSIP) in the same account.</td></tr>
          </tbody>
        </table>

        <h2 id="method">Method and assumptions</h2>
        <ul>
          <li><b>Lots.</b> Each buy is a lot. Sales use FIFO, or specific ID when your file names a lot and you choose it in the project’s matching rules.</li>
          <li><b>Order.</b> Loss sales are processed in date order across all accounts, so an earlier sale gets first claim on replacement shares.</li>
          <li><b>Replacement shares</b> are lots acquired in the window that are still held at the sale or bought after it, in any account, and not part of the sale itself. Shares bought and fully sold before a loss sale are not counted; this matches common broker practice, though the statute is not explicit.</li>
          <li><b>Partial lots</b> are split by share count, with basis allocated to the cent so totals never drift. Fractional shares are supported to six decimals.</li>
          <li><b>Splits</b> scale share counts and keep total basis.</li>
          <li><b>Substantially identical</b> means the same ticker by default. You can add groups (for example VOO, IVV, SPLG); the IRS has not ruled on index funds from different issuers, so this is a conservative choice, not a requirement.</li>
          <li><b>Broker replica.</b> For the 1099-B check, we rerun each account alone with exact tickers only. That is what a broker can see.</li>
          <li><b>Harvest planner.</b> Selling on a date is blocked if any account bought the same group in the prior 30 days and would keep those shares. Selling a group sells its recent loss lots too. Recurring buys are detected from labels and from steady cadence and amounts; DRIP from reinvestment rows.</li>
        </ul>

        <h2 id="limits">Limitations</h2>
        <ul>
          <li>Options, short sales, futures and crypto are not analysed. Options on a stock can be substantially identical to it; check option losses by hand.</li>
          <li>Mergers, spin-offs, ticker changes and return of capital are not modelled; a ticker change looks like a sale and a new purchase.</li>
          <li>Transfers in without a cost are flagged. Add them as <code>transfer_in</code> rows with the original cost and date in the generic format.</li>
          <li>Prices for the harvest planner are typed in. No quote feed is called: there is no free, keyless one that browsers can use directly.</li>
          <li>Form 8949 box (A/D vs B/E) is assumed from covered securities; follow your 1099-B.</li>
        </ul>

        <h2 id="privacy">Privacy and sync</h2>
        <p>Files are parsed in your browser and stored in this browser (IndexedDB). Nothing is uploaded unless you sign in. Signing in is optional; it syncs project settings, accounts, 1099-B totals, snapshots and (unless you turn it off in <Link href="/settings">Settings</Link>) the parsed trades, up to 1.5 MB per project. The original CSV files are never stored or sent anywhere. You can export everything as JSON, delete your cloud data, or delete your account from the account menu.</p>
      </div>
    </section>
  )
}
