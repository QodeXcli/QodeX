# Collection Playbook — method hierarchy, ethics, robustness

The reference behind the skill. Decisions first, code second.

---

## Method hierarchy (exhaust each before dropping down)

| # | Method | When | Notes |
|---|--------|------|-------|
| 1 | **Official API** | Whenever one exists | Stable, ToS-clean, structured. Amazon → SP-API (never scrape Amazon). Run `openapi_digest` on the spec first. |
| 2 | **Official feeds** | RSS/Atom, sitemap.xml, exports, datasets | Often overlooked; cheapest + most stable. |
| 3 | **Tavily** (search/extract) | Market/competitor *research* | Licensed, ToS-clean read of the open web → clean markdown. |
| 4 | **Polite public scrape** | Last resort, **public pages only** | robots.txt + rate limits + honest UA + structured-data-first. JS pages → `browser_*`. |

If only #4 fits **and** the site's ToS forbids scraping → stop and tell the user. Don't
engineer around a prohibition.

---

## Ethics & legality (the professional's guardrails)
- **robots.txt is a floor, not the whole story** — also read the ToS. Both can forbid.
- **Identify honestly** in the User-Agent (name + contact). Cloaking identity is a red flag.
- **Rate-limit to not harm the server** — you're a guest. Honor `Crawl-delay`/`Retry-After`.
- **Public data only.** No login/paywall bypass, no CAPTCHA-solving, no ban-evasion.
- **No personal data.** Emails, names, profiles → privacy/GDPR exposure. Collect catalog,
  price, availability, public listings — not people.
- **Respect copyright.** You may collect facts (prices, specs); don't republish whole
  copyrighted text. Store what you need, attribute sources.
- **Jurisdiction varies.** Flag the considerations; the user owns the decision. Not legal advice.

A collector built this way is the one that's *still running and un-banned in six months*.
That durability IS "flawless" — not raw extraction speed.

---

## Robustness checklist (every bot ships with these)
- [ ] **Incremental & idempotent** — cursor/last-seen/ETag; re-run collects only deltas, no dupes.
- [ ] **Conditional GET** — `If-None-Match`/`If-Modified-Since`; handle `304` as success.
- [ ] **Backoff + jitter** — exponential, capped, honors `Retry-After`; bounded retries; timeouts.
- [ ] **robots/ToS check** — before the first request, not after the ban.
- [ ] **Explicit schema validation** — reject malformed records loudly; log the bad payload.
- [ ] **Dedup / entity key** — normalized hash; collapse duplicates across runs/sources.
- [ ] **Durable store** — SQLite/CSV with stable schema + upsert; survives crashes mid-run.
- [ ] **Change detection** — diff vs stored; emit only meaningful changes (for monitoring).
- [ ] **Observability** — structured logs, dead-letter for failures, end-of-run summary.
- [ ] **Secrets in env/.env** — never hardcoded; `.env.example` documents them.
- [ ] **Resilient extraction** — structured data (JSON-LD / embedded JSON / the page's own
      API) over brittle CSS selectors; the bot survives a layout change.

## "Smart algorithms" worth adding (all legitimate)
- **Adaptive polling**: increase frequency where data churns, back off where it's static —
  saves requests and catches changes faster.
- **Anomaly / change-point detection** on a metric series (price drop, stock-out, new SKU)
  → that's the alert your business actually wants.
- **Prioritized frontier**: rank the crawl queue by expected value within allowed scope.
- **Fuzzy entity resolution**: match the same product/competitor across differently-formatted
  sources (normalize → token-set ratio / hashing).

## Recommended real-project stack (in the user's repo, not the sandbox)
- HTTP: `httpx` (async, HTTP/2) or `requests`. Retries: `tenacity`.
- Parse: `selectolax` (fast) or `BeautifulSoup`+`lxml`. JSON-LD: read `<script type="application/ld+json">`.
- JS pages: Playwright (QodeX exposes it via `browser_*`).
- Validate: `pydantic`. Store: `sqlite3`/SQLAlchemy or CSV. Schedule: QodeX scheduler (cron).
- Keep the pure-stdlib `patterns.py` shapes as the fallback that runs with zero install.

## Wire it to run itself
```bash
qodex schedule add "run the price monitor in ./collector" --cron "0 */6 * * *"
```
Runs every 6h, logs to ~/.qodex/schedule-logs, desktop-notifies on finish/anomaly.
Long one-shot backfills → background jobs so they don't block the session.
