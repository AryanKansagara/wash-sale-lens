import { useMemo, useState } from 'react'
import { SAMPLES } from './engine/sample.ts'
import type { Account } from './engine/types.ts'
import { runWash, summarize } from './engine/wash.ts'
import { sampleData } from './projectData.ts'
import { buildStory, StoryPlayer } from './Timeline.tsx'
import { Link, money } from './ui.tsx'

type HeroId = 'dip-buyer' | 'cross-account'

function useHeroStory(id: HeroId) {
  return useMemo(() => {
    const def = SAMPLES.find(s => s.id === id)!
    const { ds } = sampleData(id)!
    const accounts: Account[] = def.accounts.map(({ file: _f, ...a }) => a)
    const res = runWash(ds.txns, accounts, def.settings)
    const syms = id === 'dip-buyer' ? ['PLTR'] : ['NVDA', 'TSLA']
    const in2025 = ds.txns.filter(t => t.date.startsWith('2025') && syms.includes(t.symbol))
    const buys = new Set(in2025.filter(t => t.kind === 'buy').map(t => t.id))
    const sells = new Set(in2025.filter(t => t.kind === 'sell').map(t => t.id))
    const name = (aid: string) => accounts.find(a => a.id === aid)?.name ?? aid
    const story = buildStory(res, ds.txns, buys, sells, name, new Set(accounts.filter(a => a.type !== 'taxable').map(a => a.id)))
    return { story, summary: summarize(res, 2025), def }
  }, [id])
}

function Hero() {
  const [id, setId] = useState<HeroId>('dip-buyer')
  const { story, summary, def } = useHeroStory(id)
  return (
    <section className="hero">
      <div className="hero-inner">
        <div className="hero-copy">
          <div className="eyebrow neon-text">For Robinhood traders with a second account</div>
          <h1>Find out where your <em>wash sale</em> loss went.</h1>
          <p className="hero-lede">Wash Sale Lens explains every wash sale on your 1099-B, catches the ones your broker can’t see across accounts and IRAs, and plans tax-loss harvesting that doesn’t trigger new ones.</p>
          <div className="hero-cta">
            <Link href="/app?sample=dip-buyer" className="btn primary lg">Try a sample trader</Link>
            <Link href="/app" className="btn ghost lg">Import your CSV</Link>
          </div>
          <p className="hero-note">Runs in your browser. Robinhood, Fidelity, Schwab and IBKR exports. Not tax advice.</p>
        </div>
        <div className="hero-visual">
          <div className="hero-card">
            <div className="hero-card-head">
              <div className="seg" role="group" aria-label="Sample story">
                <button type="button" aria-pressed={id === 'dip-buyer'} onClick={() => setId('dip-buyer')}>Dip buyer · chain</button>
                <button type="button" aria-pressed={id === 'cross-account'} onClick={() => setId('cross-account')}>Robinhood + Roth</button>
              </div>
              <span className="muted small">{def.person} · 2025 · engine output</span>
            </div>
            <StoryPlayer story={story} label={`Live lot timeline for the ${def.name} sample`} />
            <div className="hero-card-foot">
              <span>2025 box 1g equivalent <b>{money(summary.disallowed, { cents: false })}</b></span>
              <span>Released on final sales <b className="neon-text">{money(summary.released, { cents: false })}</b></span>
              <span>Still deferred at year end <b>{money(summary.deferredOut, { cents: false })}</b></span>
              {summary.permanent > 0 && <span>Gone for good <b className="loss">{money(summary.permanent, { cents: false })}</b></span>}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const PAINS = [
  { q: 'I never bought the stock back, so where did my disallowed loss go?', a: 'It moved into the basis of shares you bought inside the 61-day window, maybe months earlier in a chain. A wash sale stays a wash sale until those shares are sold. The lens shows which shares, on which date.' },
  { q: 'My 1099-B shows tens of thousands in box 1g and I can’t reconcile it.', a: 'Box 1g adds up every deferral, even ones released later in the year. We split it into losses still deferred, losses released on final sale, and losses lost to an IRA.' },
  { q: 'I buy every dip. Is my loss stuck forever?', a: 'It rides along on the new shares and comes back when you sell and stay out for 31 days. The planner gives you that date for every ticker, in every account.' },
  { q: 'Does the 1099-B cost basis already include the wash sale?', a: 'Usually yes: box 1e is the adjusted basis, and box 1g is shown separately and added back in Form 8949 column (g) with code W. Our 8949 CSV shows both, row by row.' },
]

const SEES = [
  { k: 'broker', t: 'Same account, same ticker', d: 'Your broker catches these and reports them in box 1g.', tag: 'On your 1099-B' },
  { k: 'cross', t: 'Another taxable account', d: 'Sold on Robinhood, bought at Schwab. Still a wash sale; nobody reports it but you.', tag: 'You must adjust' },
  { k: 'ira', t: 'An IRA or Roth', d: 'The loss is disallowed and the IRA basis does not go up. It never comes back (Rev. Rul. 2008-5).', tag: 'Lost for good' },
  { k: 'equiv', t: 'A near-twin fund', d: 'VOO and IVV track the same index. The IRS has not ruled; add your own equivalence list if you want to be careful.', tag: 'Your call' },
]

export function Landing() {
  return (
    <>
      <Hero />
      <section className="section">
        <div className="section-inner">
          <div className="eyebrow">The questions people actually ask</div>
          <h2 className="display">Box 1g is a number. You deserve the story behind it.</h2>
          <div className="pains">
            {PAINS.map((p, i) => <article key={i} className="pain"><p className="pain-q">“{p.q}”</p><p className="pain-a">{p.a}</p></article>)}
          </div>
          <p className="muted small">Paraphrased from public threads in r/tax, r/stocks and r/fidelityinvestments.</p>
        </div>
      </section>

      <section className="section alt">
        <div className="section-inner">
          <div className="eyebrow">What your broker can’t see</div>
          <h2 className="display">Brokers only look inside one account, at one ticker.</h2>
          <p className="lede">The rule applies to you, across every account you own, including your spouse’s and your IRAs (Pub. 550). A broker sees one slice of it.</p>
          <div className="sees">
            {SEES.map(s => <article key={s.k} className={`see ${s.k}`}><span className="see-tag">{s.tag}</span><h3>{s.t}</h3><p>{s.d}</p></article>)}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-inner">
          <div className="eyebrow">How it works</div>
          <h2 className="display">From a confusing 1099-B to a plan, in four steps.</h2>
          <ol className="steps">
            <li><b>Import</b><span>Drop in your Robinhood activity report, plus Fidelity, Schwab or IBKR exports and any IRA. Formats are detected; every skipped row is listed by line.</span></li>
            <li><b>Explain</b><span>Every wash sale gets a timeline: the shares sold, the replacement shares, the dates, and where the basis went next.</span></li>
            <li><b>Reconcile</b><span>Type your 1099-B totals. We rebuild what your broker could see and explain every dollar of difference.</span></li>
            <li><b>Act</b><span>Download the 8949-ready CSV, print a packet for your CPA, and plan this year’s harvest with do-not-buy dates and a recurring-buy check.</span></li>
          </ol>
          <div className="row gap wrap"><Link href="/app?sample=recurring-trap&tab=harvest" className="btn primary">See the harvest planner</Link><Link href="/docs" className="btn ghost">Export steps for each broker</Link></div>
        </div>
      </section>

      <section className="section alt" id="rules">
        <div className="section-inner grid-2">
          <div>
            <div className="eyebrow">The rules we apply</div>
            <h2 className="display">Cited, not guessed.</h2>
            <p className="lede">Every number traces to a rule. When the law is unsettled, like whether two index funds are substantially identical, we say so and let you decide.</p>
            <Link href="/docs#rules" className="btn ghost">Read the method</Link>
          </div>
          <ul className="cites">
            <li><b>IRC §1091</b><span>Loss disallowed when substantially identical stock is acquired 30 days before or after the sale.</span></li>
            <li><b>Treas. Reg. §1.1091-1</b><span>Replacement shares matched in order of acquisition; partial wash sales by share count.</span></li>
            <li><b>IRS Publication 550</b><span>Basis adjustment, holding-period tacking, and purchases by your IRA or spouse.</span></li>
            <li><b>Form 8949 instructions</b><span>Code W and column (g) for the disallowed amount.</span></li>
            <li><b>Rev. Rul. 2008-5</b><span>Replacement in an IRA or Roth: loss disallowed, IRA basis not increased.</span></li>
          </ul>
        </div>
      </section>

      <section className="section cta-final">
        <div className="section-inner center">
          <h2 className="display">Open the lens on your own trades.</h2>
          <p className="lede">No account needed. Your files never leave this browser unless you choose to sync.</p>
          <div className="row gap center-x wrap"><Link href="/app" className="btn primary lg">Get started</Link><Link href="/app?sample=cross-account" className="btn ghost lg">Robinhood + Roth sample</Link></div>
          <p className="muted small">Not tax advice. Check your return with a tax professional.</p>
        </div>
      </section>
    </>
  )
}
