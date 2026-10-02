# Changelog

## 4.0.0 — Amazon Seller Suite

### Added
- **Amazon Suite** admin app: a single-page app with Dashboard, Profit & P&L,
  Orders, Inventory & Restock, PPC Manager, Keywords, Listing Optimizer,
  Hijackers & Buy Box, Review Requests, Reimbursements, Traffic & Returns,
  Product Research, Reports Center, Alerts and Settings.
- REST API `sg-commerce/v1/suite/*` (45 routes, `manage_options` only).
- 24 new `sg_suite_*` tables, versioned separately (`sg_suite_schema_version`).
- Data pipelines:
  - Orders v0 (incremental, lazy item fetch).
  - Finances v0 financial events (windowed and resumable per region).
  - Reports API pipeline: request → poll → download → gunzip → ingest. Covers
    all-orders, sales & traffic, ledger, reimbursements, returns, inventory
    planning, seller feedback and Search Query Performance.
  - Ads API v3: campaigns, keywords, targets, and spCampaigns / spTargeting /
    spSearchTerm reports.
- Engines:
  - Profit engine: settled + estimated fees, refunds, account fees, ads, COGS
    with sellable-return add-back, expenses, month-end forecast.
  - Restock planner: OOS-aware velocity, case pack / MOQ, stock-out gap before
    inbound.
  - PPC bid optimizer, search-term harvester / negator and budget pacing, with
    review, apply, dismiss and auto-apply.
  - Listing auditor: 100-point score, content-change detection, AI rewrite.
  - Listing monitor: hijackers, Buy Box, competitor price drops, price/BSR
    history.
  - Review requester (Solicitations API).
  - Reimbursement auditor: lost/damaged inventory, refund-no-return, fee
    overcharge, with case-message generator.
  - Product research: catalog search, BSR sales estimate, fee estimates,
    profitability calculator.
- Marketplace-local day bucketing (US = Pacific), matching Seller Central.
- Email delivery for suite alerts (configurable levels, throttled).
- Deterministic demo account for the 7 SEVEN catalog, removable exactly.
- Tests: `tests/unit.php` (79 assertions) and
  `tests/integration-smoke.php` (all REST routes, secret handling, demo
  cleanup).

### Changed
- Amazon Ads API secrets are added to the encrypted secret store.
- Rate-limiter buckets added for reports documents, order items, finances,
  listings, catalog search, fee estimates and solicitations.

### Fixed
- Uninstall now also drops `sg_inbound_plans`, `sg_product_ean` and every
  `sg_suite_*` table. It also deletes every `sg_commerce_*` option (carton
  templates and the sandbox flag were previously left behind), all suite
  options and transients, and Action Scheduler jobs.

## 3.3.1
- Baseline imported (SP-API connection, sync, repricer, AI copy, analytics,
  automation, MCF, inbound plans, PII tools, settlements, headless API).
