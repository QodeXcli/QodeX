# Seven Gum Commerce Pro — with Amazon Seller Suite (v4.0)

A WordPress plugin that turns **sevengum.com** into the command center for the
7 SEVEN Amazon business. v4.0 adds the **Amazon Seller Suite**, a full
single-page app inside wp-admin (**Amazon Suite** menu) that covers what sellers
usually pay several monthly subscriptions for. It runs on Amazon's official
SP-API and Ads API and needs no external SaaS.

| Suite module | Replaces / matches | Data source (official APIs only) |
|---|---|---|
| **Dashboard**: Today / Yesterday / MTD / Last month, month-end forecast, action center | Sellerboard dashboard | Orders, Finances, Ads, Reports |
| **Profit & P&L**: net profit per day / SKU / order, fee breakdown, waterfall, COGS editor, custom expenses | Sellerboard, Shopkeeper | Finances v0 events, Orders v0, all-orders report, Ads reports |
| **Orders**: every order with its own profit, settled vs. estimated fees | Sellerboard orders | Orders v0 (near real time) + flat-file orders report |
| **Inventory & Restock**: velocity forecast, days of cover, stock-out date, order-by date, PO qty (case pack / MOQ), lost-sales estimate, gap-before-inbound warning, aged inventory & storage | SoStocked, Forecastly, RestockPro | FBA inventory, order items, FBA inventory planning report |
| **PPC Manager**: bid optimisation to target ACoS, pause bleeders, search-term harvesting (exact + ASIN), negative keywords, budget pacing, change log, auto-apply | Helium 10 Adtomic, Perpetua, PPC Entourage | Ads API v3 (Sponsored Products + Reporting v3) |
| **Keywords**: share-of-search tracker (impression / click / purchase share, 8-week trend), keyword research, all Brand Analytics queries per ASIN | Helium 10 Keyword Tracker / Cerebro | Brand Analytics Search Query Performance, Ads keyword recommendations, your search-term report |
| **Listing Optimizer**: 100-point grade (title policy 2025, bullets, description, backend bytes, images, Amazon issues, suppression, keyword coverage) + AI rewrite in brand voice | Helium 10 Listing Analyzer / Scribbles | Listings Items API 2021-08-01 + your AI provider (Ollama) |
| **Hijackers & Buy Box**: new-seller (hijacker) alerts, Buy Box lost/suppressed alerts, competitor price-drop alerts, Keepa-style price & BSR history | Seller Snap alerts, Keepa | Product Pricing v0 `getItemOffers` |
| **Review Requests**: automatic Amazon "Request a Review" 5–30 days after delivery, skipping refunded/returned orders, daily cap; seller-feedback monitor | FeedbackWhiz, Jungle Scout review automation | Solicitations API, seller feedback report |
| **Reimbursements**: lost & damaged FBA inventory, refunded-but-never-returned orders, FBA fee overcharges, each with a ready-to-paste case message | GETIDA, Refunds Manager | Inventory ledger, reimbursements, returns reports, Finances |
| **Traffic & Returns**: sessions, page views, unit-session %, Buy Box % per day and ASIN; return reasons & dispositions | Business Reports+ | Sales & Traffic report, customer returns report |
| **Product Research**: niche explorer (BSR-based sales estimate, page-1 revenue, offers, opportunity score), exact FBA fees for any ASIN, profitability calculator (break-even ACoS, max CPC, ROI) | Jungle Scout, Helium 10 Black Box, FBA calculator | Catalog Items 2022-04-01, Product Pricing, Product Fees |
| **Reports Center**, **Alerts** (+ email), **Settings**, **Demo mode** | | |

---

## Install

1. Upload the plugin zip in **Plugins → Add New → Upload**, then activate.
   Requirements: WordPress 6.4+, PHP 8.1+ with `openssl`, `curl`, `json`, `mbstring`.
2. Open **Amazon Suite** in wp-admin. Before you connect anything, you can click
   **Load demo account** to explore every screen with a realistic 90-day
   sample account for the 19 SKUs. Demo rows are flagged and removed exactly by
   **Clear demo data**; real data is never touched.

### Hostinger / shared hosting: use a real cron

WP-Cron only runs when someone visits the site. In hPanel → **Advanced → Cron
Jobs**, add (every 5 minutes):

```
wget -q -O - https://sevengum.com/wp-cron.php?doing_wp_cron >/dev/null 2>&1
```

and add `define( 'DISABLE_WP_CRON', true );` to `wp-config.php`. All jobs are
batched to fit shared-hosting time limits (report polling, item fetches and
monitor checks are capped per tick and resume on the next one).

---

## Connect Amazon (SP-API)

1. **Seller Central → Apps and Services → Develop Apps** (or the Solution
   Provider Portal) → register as a *private developer* and create an app client.
2. Request these **roles** so every suite module works:
   - Product Listing (listings, catalog)
   - Pricing (Buy Box / offers, competitive pricing, fee estimates)
   - Inventory and Order Tracking (orders, FBA inventory)
   - Amazon Fulfillment (FBA reports, inbound, MCF)
   - Finance and Accounting (financial events)
   - Buyer Solicitation (review requests)
   - Brand Analytics (Search Query Performance; needs Brand Registry)
   - Selling Partner Insights (seller feedback)
3. **Authorize** the app for your own account to get the **refresh token**.
4. In wp-admin → **Seven Gum → Amazon Connect**, enter the LWA Client ID, Client
   Secret and Refresh Token, choose the primary marketplace (US) and the enabled
   marketplaces (e.g. US + AE), save, and click **Run connection test**.
5. In **Amazon Suite → Settings**, enter your **Seller ID (Merchant Token)**:
   Seller Central → Settings → Account Info → *Merchant Token*. Listing audits
   and hijacker detection need it.
6. Click **Settings → Run now → Backfill history**. This requests the orders and
   traffic reports for the backfill window (default 60 days) and resets the
   finance cursor. Data then fills in over the next cron ticks.

## Connect the Amazon Ads API (PPC)

1. Apply for Amazon Ads API access (advertising.amazon.com → API), using a Login
   with Amazon security profile.
2. Generate a refresh token with scope `advertising::campaign_management`.
3. In **Amazon Suite → Settings → Amazon Ads API**: choose the region, enter the
   refresh token, plus the client ID and secret if they differ from your SP-API
   app. Click **Test & list profiles**, then **Use** on your seller profile
   (e.g. US).
4. Turn on **Sync ads daily**. Set a target ACoS. Optionally set a harvest
   destination campaign and ad group (your exact-match campaign).
5. The optimizer plans changes daily. Review them in **PPC → Optimizer** and
   apply the ones you want. Turn on **Auto-apply** only after you trust the
   rules; it pushes bid changes and negatives only.

---

## How the numbers are computed

- **Profit basis.** Sales, units and promotions are counted on the order date,
  in the marketplace's own timezone (US = Pacific), the same as Seller Central.
  Amazon fees are the settled amounts for those orders. For orders that are not
  settled yet, fees are estimated from each SKU's trailing 90-day fee per unit.
  Refunds, storage, subscription, reimbursements and adjustments are counted on
  their posted date. Ads spend comes from the Ads API (or from invoices if the
  Ads API is not connected). COGS is units × landed cost, with cost added back
  for returns restocked as sellable. Monthly expenses are pro-rated per day.
  Taxes are pass-through.
- **Restock.** Velocity = 0.5·v7 + 0.3·v30 + 0.2·v90, with out-of-stock days
  excluded. Reorder point = velocity × (lead time + safety days). Order quantity
  covers lead time plus target cover, rounded up to the case pack and at least
  the MOQ.
- **Bid rules.** With orders: move the bid toward (sales ÷ clicks) × target ACoS,
  at most ±max-step per run. No orders after N clicks: cut the bid, or pause once
  spend reaches 2× break-even CPA. Low impressions: raise by half a step. Bids
  are always clamped to [min, max].

### Honest limitations

- **BSR → monthly sales is an estimate (about ±40%).** No tool has real unit
  data for other sellers' ASINs.
- **Amazon has no official organic-rank API.** The keyword tracker uses Brand
  Analytics share of impressions, clicks and purchases, which is the compliant
  equivalent.
- **Search Query Performance requires Brand Registry.**
- **Review requests use Amazon's own template only.** That is the only
  ToS-compliant automation.

---

## Security & privacy

- Every secret (LWA, Ads, AI keys) is encrypted at rest with AES-256-GCM and
  never returned to the browser or written to logs. The settings API only
  exposes "is set" flags.
- Every admin page and REST route requires `manage_options`. REST uses the
  `wp_rest` nonce.
- Buyer PII is never requested (no RDT) and never stored. PII columns in flat
  files (buyer email, name, address) are skipped at ingest. Only ship country is
  kept.
- **Uninstall leaves zero traces**: all `sg_*` / `sg_suite_*` tables, all
  `sg_commerce_*` / `sg_suite_*` options and transients, encrypted secrets,
  cron events and Action Scheduler jobs are removed (multisite-safe).

## Tests

```bash
php tests/unit.php                                   # 79 pure-logic tests, no WordPress needed
wp eval-file wp-content/plugins/sg-commerce-pro/tests/integration-smoke.php
                                                     # seeds demo, hits every REST route, checks secrets & cleanup
```

---

## راهنمای سریع (فارسی)

۱. افزونه را نصب و فعال کنید. منوی جدید **Amazon Suite** در پیشخوان وردپرس اضافه می‌شود.
۲. برای دیدن همه‌ی بخش‌ها قبل از اتصال، روی **Load demo account** بزنید. داده‌های نمونه‌ی ۹۰ روزه برای ۱۹ محصول ساخته می‌شود و با **Clear demo data** کامل پاک می‌شود.
۳. اتصال آمازون: در **Seven Gum → Amazon Connect** مقادیر Client ID، Client Secret و Refresh Token را وارد کنید و تست اتصال را بزنید.
۴. در **Amazon Suite → Settings** شناسه‌ی فروشنده (Merchant Token) را وارد کنید و سپس **Backfill history** را بزنید.
۵. برای مدیریت تبلیغات (PPC)، اطلاعات Amazon Ads API را در همان تنظیمات وارد کنید، **Test & list profiles** را بزنید و پروفایل US را انتخاب کنید.
۶. روی هاستینگر حتماً Cron واقعی تنظیم کنید (دستور بالا).

بخش‌ها: سود خالص واقعی و صورت سود و زیان، سفارش‌ها، برنامه‌ریزی موجودی و سفارش مجدد، مدیریت تبلیغات، ردیابی کلمات کلیدی، بهینه‌سازی لیستینگ با هوش مصنوعی، هشدار هایجکر و Buy Box، درخواست خودکار نظر، پیدا کردن غرامت‌های آمازون، ترافیک و مرجوعی‌ها، تحقیق محصول و ماشین‌حساب سود.
