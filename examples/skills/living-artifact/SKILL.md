---
name: living-artifact
description: Build a visual artifact (dashboard, chart, table, page, mini-app) the RIGHT way — generate it, render it, screenshot it, have a vision model review it (LOOKS_GOOD / NEEDS_WORK / BROKEN), fix until it actually looks right, then serve it live with hot-reload. Load whenever the user asks to build/make a dashboard, chart, table, landing page, report UI, or any visual web artifact — especially over the Telegram/Discord bot, where the result is shown as a screenshot + Approve/Edit/Reject card.
version: 0.1.0
author: QodeX
triggers:
  - dashboard
  - chart
  - table
  - landing page
  - artifact
  - build a page
  - build a ui
  - mini-app
  - report
  - visualize
  - داشبورد
  - چارت
  - جدول
  - صفحه
  - نمودار
  - بساز
slash-aliases:
  - artifact
  - living
---

# Living Artifact — build → review → fix → live

You have a deterministic visual-QA loop. **Never** hand the user an unrendered blob of HTML and
call it done — drive it through the loop so what they get is verified to actually render.

## The loop (do every step, in order)

1. **Create.** Generate a single self-contained artifact and save it:
   `artifact_create` with `type` (`html` / `react` / `vue` / `svg`) + the full content. Keep it
   self-contained (inline styles/scripts, a CDN for charts is fine). For "a sales dashboard with a
   chart and a table": real-looking sample data, one chart, one table, a clean responsive layout.
2. **Go live early.** `artifact_live id=<id>` — this starts the hot-reload server and returns the
   URL. Doing it now means every later fix the user sees update in place.
3. **Render + screenshot.** `artifact_preview id=<id>` → `browser_navigate <preview url>` →
   `browser_screenshot`. Also grab `browser_console` (console + page errors).
4. **Review (vision).** `artifact_review id=<id> screenshot_path=<png> intent="<what it should be>"`
   with the console/page errors. It returns **LOOKS_GOOD / NEEDS_WORK / BROKEN** + concrete issues.
5. **Fix the real problems.** If the verdict is **not LOOKS_GOOD**, address the listed issues with
   `artifact_update` (the live page hot-reloads), then **go back to step 3**. Cap it at ~3 rounds —
   if still not good, say what's wrong honestly rather than looping forever.
6. **Present.** End your turn with the artifact LIVE (`artifact_live` already running) and a one-line
   summary: the verdict and the live link. On the bot this automatically renders as a card with the
   screenshot + **Approve / Edit / Reject** buttons, so keep your closing text short.

## Example — "build a sales dashboard with a chart and a table"

```text
1. artifact_create  type=html  → a self-contained dashboard: KPI row, a bar chart
                                  (Chart.js via CDN), a sortable orders table, sample data.
2. artifact_live    id=sales-dashboard          → http://localhost:7xxx (hot-reload, opens)
3. artifact_preview → browser_navigate → browser_screenshot → /…/shot.png
                      browser_console → []  (no errors)
4. artifact_review  id=sales-dashboard screenshot_path=/…/shot.png
                    intent="a clean sales dashboard with one chart + one table"
   → NEEDS_WORK · ["the chart legend overlaps the table on narrow widths"]
5. artifact_update  id=sales-dashboard  (give the chart a max-height + margin)  → page hot-reloads
   re-screenshot → artifact_review → LOOKS_GOOD ✅
6. Close: "Sales dashboard is live — review: looks good." + the live link.
```

On the bot this lands as a card: the screenshot, **✅ Looks good**, the hot-reload link, and
**Approve / Edit / Reject**. *Edit* lets the user reply "make it dark mode" and it updates in place.

## Rules

- **The screenshot is the source of truth**, not your intentions — only call it done when the vision
  verdict is LOOKS_GOOD (or you've explained an honest limitation).
- **Fix issues, don't paper over them.** "overlapping cards", "unreadable contrast", "cut-off table"
  are concrete — change the CSS/layout, re-render, re-review.
- **Keep it live.** Leave `artifact_live` running so the user (and the Edit button) can iterate.
- If no vision backend is configured, `artifact_review` still reports runtime errors — fix those and
  state that you couldn't get a visual verdict.
