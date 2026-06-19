# Analytical Frameworks — exact definitions & formulas

Use these so the math is correct, not approximate. Compute with `code_run`
(`financial-models.md` has runnable versions). Every formula notes its common trap.

---

## Unit economics

**Contribution margin (per unit)** = Price − Variable cost per unit
**Contribution margin %** = Contribution margin ÷ Price
> Trap: do NOT subtract fixed costs here. CM is per-unit and variable-only.

**Gross margin %** = (Revenue − COGS) ÷ Revenue

**CAC (Customer Acquisition Cost)** = Total sales & marketing spend ÷ New customers acquired (same period)
> Trap: include the fully-loaded S&M (ad spend + tools + the people), not just ad spend.

**ARPU** = Revenue in period ÷ Active customers in period

**Churn rate (monthly)** = Customers lost in month ÷ Customers at start of month
**Average customer lifetime (months)** = 1 ÷ monthly churn rate
> Only valid for roughly constant churn; for cohorts, measure actual retention curves.

**LTV (gross-margin basis, recommended)** = ARPU × Gross margin % ÷ monthly churn
> Trap: LTV on *revenue* not margin overstates it. Always discount LTV to margin.
> For a discounted LTV with churn r and monthly discount d: LTV = ARPU·GM% · (1+d)/(d+r) approx; use the recipe.

**LTV:CAC ratio** = LTV ÷ CAC — healthy SaaS rule of thumb ≈ 3:1 (context-dependent).
**CAC payback (months)** = CAC ÷ (ARPU × Gross margin %)

---

## Market sizing (build BOTTOM-UP)

**TAM** = total # of potential buyers × annual value per buyer
**SAM** = TAM filtered to who you can actually serve (geo, segment, channel)
**SOM** = SAM × realistic share you can win in N years (justify the share with a comp)
> Trap: "1% of a $50B market = $500M" is not analysis — it's a wish. Build up from
> units × price × reachable buyers, then sanity-check against the top-down number.

---

## Profitability & cash

**Break-even volume (units)** = Fixed costs ÷ Contribution margin per unit
**Operating profit** = Revenue − COGS − Operating expenses
**Monthly burn** = Cash out − Cash in (when negative net)
**Runway (months)** = Cash on hand ÷ Monthly net burn

---

## Investment / multi-period decisions

**NPV** = Σ [ CFₜ ÷ (1 + r)ᵗ ] for t = 0..N, where r = discount rate (cost of capital)
> Decision rule: NPV > 0 → value-creating at that discount rate. Always state r.

**IRR** = the discount rate r where NPV = 0 (solve numerically — recipe uses bisection).

**Payback period** = time until cumulative cash flow turns positive (ignores time value;
use only as a secondary, liquidity-flavored metric).

**ROI** = (Gain − Cost) ÷ Cost. For multi-period, prefer NPV/IRR over a flat ROI.

---

## Pricing

- **Value-based** (preferred): price against the quantified value delivered to the buyer,
  not against your cost. Estimate willingness-to-pay from the value created.
- **Price elasticity** = % change in quantity ÷ % change in price. If |elasticity| < 1,
  demand is inelastic → a price increase raises revenue. Test, don't assume.
- **Cost-plus** is a floor, not a strategy. Never the headline method.

---

## Strategy lenses (use to STRUCTURE, not to replace the math)

- **Porter's five forces**: rivalry, new entrants, substitutes, buyer power, supplier power
  — for "is this market attractive / defensible?"
- **Jobs To Be Done (JTBD)**: what job is the customer "hiring" the product for? Drives
  positioning and the real competitive set (often non-obvious).
- **Growth loops > funnels**: identify the loop where output (users/revenue/content) feeds
  back into input. Loops compound; funnels leak. Name the loop.
- **AARRR funnel**: Acquisition → Activation → Retention → Referral → Revenue. Find the
  weakest stage from real data; that's where the leverage is.
- **SWOT**: only as a final summarizer. It is not analysis on its own — never lead with it.
