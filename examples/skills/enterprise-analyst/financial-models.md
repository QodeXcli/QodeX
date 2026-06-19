# Financial Model Recipes (pure Python — no numpy/pandas, always runs)

Paste into `code_run` (language: python). Every recipe is stdlib-only so it runs on
any Mac without installing anything. Replace the inputs with computed/cited/assumed
values — and SHOW those inputs in your answer.

---

## 1. Unit economics + LTV:CAC + payback
```python
# --- inputs (replace with real/grounded values; label assumptions) ---
price          = 12.00     # per unit / per month
variable_cost  = 4.20      # per unit (COGS, variable only)
arpu           = 12.00     # avg revenue per user per month
monthly_churn  = 0.05      # 5% monthly churn  [ASSUMPTION if not measured]
sm_spend       = 8000.0    # fully-loaded sales+marketing this period
new_customers  = 220       # acquired this period

cm        = price - variable_cost
cm_pct    = cm / price
gross_mgn = cm_pct                      # if variable_cost == COGS
cac       = sm_spend / new_customers
lifetime  = 1 / monthly_churn           # months, constant-churn approx
ltv       = arpu * gross_mgn / monthly_churn   # margin-based LTV
ratio     = ltv / cac
payback   = cac / (arpu * gross_mgn)    # months

print(f"Contribution margin: ${cm:.2f} ({cm_pct*100:.0f}%)")
print(f"CAC: ${cac:.2f} | LTV(margin): ${ltv:.2f} | LTV:CAC = {ratio:.2f}:1")
print(f"Avg lifetime: {lifetime:.1f} mo | CAC payback: {payback:.1f} mo")
```

## 2. Bottom-up TAM / SAM / SOM
```python
# Build UP from units, never "1% of a big number".
potential_buyers = 2_000_000   # cite the source for this
annual_value     = 60.0        # price * purchases/yr per buyer
tam = potential_buyers * annual_value

serviceable_frac = 0.15        # geo/segment/channel you can actually reach [why?]
sam = tam * serviceable_frac

win_share_3yr    = 0.04        # realistic share; justify with a comparable
som = sam * win_share_3yr

print(f"TAM ${tam/1e6:.1f}M | SAM ${sam/1e6:.1f}M | SOM(3yr) ${som/1e6:.2f}M")
```

## 3. Break-even + runway
```python
fixed_costs_month = 15000.0
cm_per_unit       = 7.80
breakeven_units   = fixed_costs_month / cm_per_unit

cash_on_hand = 120000.0
monthly_in   = 22000.0
monthly_out  = 38000.0
net_burn     = monthly_out - monthly_in
runway = cash_on_hand / net_burn if net_burn > 0 else float('inf')

print(f"Break-even: {breakeven_units:.0f} units/mo")
print(f"Net burn: ${net_burn:,.0f}/mo | Runway: {runway:.1f} months")
```

## 4. NPV + IRR (bisection — no libraries)
```python
def npv(rate, cashflows):           # cashflows[0] = t0 (usually negative)
    return sum(cf / (1+rate)**t for t, cf in enumerate(cashflows))

def irr(cashflows, lo=-0.9, hi=10.0, tol=1e-6):
    # bisection; assumes one sign change (typical invest-then-return)
    flo, fhi = npv(lo, cashflows), npv(hi, cashflows)
    if flo * fhi > 0:
        return None  # no IRR in range — report and inspect cashflows
    for _ in range(200):
        mid = (lo+hi)/2
        fm = npv(mid, cashflows)
        if abs(fm) < tol: return mid
        if flo * fm < 0: hi, fhi = mid, fm
        else: lo, flo = mid, fm
    return (lo+hi)/2

cashflows = [-50000, 12000, 18000, 22000, 26000]   # t0..t4
r = 0.12  # cost of capital — STATE this
print(f"NPV @ {r*100:.0f}%: ${npv(r, cashflows):,.0f}")
i = irr(cashflows)
print("IRR:", f"{i*100:.1f}%" if i is not None else "none in range")
```

## 5. Sensitivity table (which assumption moves the answer?)
```python
def ltv_cac(churn, cac, arpu=12.0, gm=0.65):
    return (arpu * gm / churn) / cac

base_churn, base_cac = 0.05, 36.0
print("LTV:CAC sensitivity (rows=churn, cols=CAC)")
cac_vals   = [24, 30, 36, 42, 48]
churn_vals = [0.03, 0.04, 0.05, 0.06, 0.07]
header = "churn\\CAC " + " ".join(f"{c:>6}" for c in cac_vals)
print(header)
for ch in churn_vals:
    row = " ".join(f"{ltv_cac(ch, c):>6.1f}" for c in cac_vals)
    print(f"{ch*100:>5.0f}%   {row}")
# Read it: where does the ratio cross your 3:1 threshold? That's the break-even line.
```

## 6. Cohort retention → revenue contribution
```python
# Actual retention curve beats a single churn number when you have it.
cohort_size = 1000
retention   = [1.00, 0.62, 0.50, 0.44, 0.40, 0.38]  # month 0..5 (measured)
arpu        = 12.0
gm          = 0.65
rev_by_month = [cohort_size * r * arpu * gm for r in retention]
cumulative   = sum(rev_by_month)
print("Margin $ by month:", [f"{x:,.0f}" for x in rev_by_month])
print(f"Cumulative margin from cohort (6mo): ${cumulative:,.0f}")
print(f"Per-customer 6mo margin: ${cumulative/cohort_size:.2f}")
```

---

**Discipline:** print the inputs alongside outputs, and when you change an assumption,
re-run and report the delta. The point of computing (vs guessing) is that the user can
see exactly what drives the number — and challenge the assumption, not the arithmetic.
