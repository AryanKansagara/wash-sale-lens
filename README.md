# Wash Sale Lens

Explains every wash sale on your 1099-B, catches the ones your broker can't see (across accounts and into IRAs), and plans tax-loss harvesting without triggering new ones. Built for active Robinhood traders who also have a second broker or an IRA.

**Live:** https://wash-sale-lens.vercel.app

## The pain

"Wash sale loss disallowed" on a 1099-B is one number with no story. Traders who never bought a stock back can't find where the loss went; dip buyers see five-figure box 1g totals they can't reconcile; nobody tells you that a buy in your Roth IRA made a loss disappear for good. Brokers only track wash sales inside one account and one CUSIP, so the rest is on you.

## Features

- **Import** Robinhood account activity reports, Fidelity history, Schwab transactions, IBKR Flex Query trades or Activity Statements, a generic CSV, and 1099-B detail (broker CSVs, Schwab Realized Gain/Loss, Form 8949 style files from tax software). Format detection, column mapping and a line-numbered validation report. Multiple accounts per project, each taxable, IRA or Roth.
- **Engine** (plain TypeScript, 60 tests, including the IRS Publication 550 worked examples and fixtures that follow each broker's real export layout): FIFO or specific-ID lots, the 61-day window, replacement shares matched in acquisition order, partial wash sales by share count, basis adjustment and holding-period tacking, chains and release on final sale, cross-account and IRA/Roth (Rev. Rul. 2008-5) matching, splits, optional substantially-identical groups.
- **Why is this loss disallowed?** A step-by-step lot timeline for every wash sale: the shares, the dates, and where the basis went next.
- **Form 8949** rows with code W and column (g), as a CSV.
- **1099-B check**: rebuilds what your broker could see and explains every dollar of difference.
- **Harvest planner**: lots to sell for a target loss, do-not-buy-until dates across all accounts, recurring-investment and DRIP conflicts, and a 30-day calendar.
- **CPA packet**: a printable explanation with citations.
- **History**: tax-year snapshots with a compare view.
- Local-first (IndexedDB). Optional email sign-in syncs projects via Supabase. Light and dark themes.

Three synthetic sample traders are included. Not tax advice.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine and importer tests
npm run build
```

Optional sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.

Built by Aryan Kansagara. Independent project, not affiliated with Robinhood.
