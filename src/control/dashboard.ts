/**
 * Control Center dashboard — one self-contained HTML page (inline CSS + JS, no
 * CDN, no build step) served by src/control/server.ts.
 *
 * Panels:
 *   - Live:      screencast of the agent's browser (SSE /api/frames), URL bar,
 *                back/forward/reload and a Take over / Hand back switch. Only while
 *                the human holds control are clicks, wheel, keys and touch-scrolls
 *                on the frame forwarded to /api/input (in frame coordinates).
 *   - Approvals: pending human decisions with a risk/category badge and one button
 *                per option (plus mission-queue approvals when that action exists).
 *   - Steer:     a note injected into the running agent at its next step.
 *   - Stop:      emergency stop (src/control/emergency-stop.ts), missions included.
 *   - Missions:  shown only when a `missions.list` control action is registered.
 *   - Activity:  the event bus timeline, newest first.
 *
 * Dark, responsive (phone-first ordering puts Approvals on top), and bilingual:
 * an EN/FA toggle swaps every label and flips the page to `dir=rtl`.
 *
 * Security notes: all dynamic text is inserted with textContent (never innerHTML),
 * links are only rendered for http(s) URLs, and the page talks only to its own
 * origin (the server sends a CSP with connect-src 'self', frame-ancestors 'none' and
 * a script-src that allows only this file's inline script by hash).
 */

import { createHash } from 'node:crypto';

export type DashboardLang = 'en' | 'fa';

export interface DashboardOptions {
  /** Custom title; omitted → the localized default "QodeX Control Center". */
  title?: string;
  /** Initial language (the viewer can toggle; the choice is remembered locally). */
  lang?: DashboardLang;
  /**
   * Open in hand-off mode for this hand-off (a CAPTCHA / bot check a human solves).
   * `scoped` = the viewer came through a hand-off link: only the live view of this
   * hand-off exists for them (no events, approvals, steering, missions or stop).
   * Without it the page still enters hand-off mode from `?handoff=<id>`.
   */
  handoff?: { id: string; scoped?: boolean };
}

/** Every UI string in both languages. Keys must exist in both maps. */
export const DASHBOARD_STRINGS: Record<DashboardLang, Record<string, string>> = {
  en: {
    title: 'QodeX Control Center',
    live: 'Live browser',
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    go: 'Go',
    urlPh: 'Enter a URL (take over first)',
    takeOver: 'Take over',
    handBack: 'Hand back',
    agentInControl: 'The agent is in control. Take over to drive the browser yourself.',
    youInControl: 'You are in control — the agent waits until you hand back.',
    idle: 'No browser is running in this QodeX process yet. It appears here as soon as the agent opens a page.',
    idleHint: 'Take over and enter a URL to open the browser yourself.',
    starting: 'Starting the live view…',
    liveError: 'The live view is unavailable',
    typePh: 'Type into the page…',
    send: 'Send',
    enter: 'Enter ⏎',
    approvals: 'Approvals',
    noApprovals: 'Nothing is waiting for you.',
    missionBadge: 'mission',
    from: 'from',
    steer: 'Steer the agent',
    steerPh: 'Add a note for the agent — it is injected at its next step.',
    steerSent: 'Sent — the agent will see it at its next step.',
    noAgent: 'No agent is running in this process.',
    stopAll: '⏹ Stop',
    confirmStop: 'Stop everything QodeX is doing — the running task, background runs, dev servers and all active missions?',
    stopDone: 'Stopped',
    stopNothing: 'Nothing was running.',
    missions: 'Missions',
    noMissions: 'No missions yet.',
    cancel: 'Cancel',
    confirmCancel: 'Cancel this mission?',
    open: 'Open',
    activity: 'Activity',
    noActivity: 'No activity yet.',
    connected: 'Live',
    disconnected: 'Reconnecting…',
    authLost: 'Access expired. Re-open the full link printed by QodeX (it ends with ?k=…).',
    failed: 'Failed',
    answered: 'answered',
    by: 'by',
    tabs: 'tabs',
    headless: 'headless',
    headed: 'headed',
    attached: 'attached',
    warnShare: 'Anyone with this link can watch and drive QodeX\'s browser and answer its approvals. Keep it private.',
    k_agent: 'Agent',
    k_approval: 'Approval',
    k_mission: 'Mission',
    k_browser: 'Browser',
    k_sentinel: 'Sentinel',
    k_notice: 'Notice',
    risk_low: 'low',
    risk_medium: 'medium',
    risk_high: 'high',
    risk_critical: 'critical',
    autoAsks: 'Auto mode still asks',
    cat_purchase: 'purchase',
    cat_payment: 'payment',
    cat_send: 'send',
    cat_credential: 'credential',
    cat_delete: 'delete',
    cat_publish: 'publish',
    cat_account: 'account',
    cat_download: 'download',
    cat_upload: 'upload',
    cat_navigation: 'navigation',
    cat_desktop: 'desktop',
    cat_other: 'other',
    opt_yes: 'Yes',
    opt_no: 'No',
    opt_always: 'Always',
    opt_approve: 'Approve',
    opt_deny: 'Deny',
    opt_accept: 'Accept',
    opt_reject: 'Reject',
    opt_cancel: 'Cancel',
    opt_skip: 'Skip',
    opt_edit: 'Edit',
    opt_continue: 'Continue',
    opt_done: 'Done',
    cat_challenge: 'bot check',
    hoBanner: 'Solve it — QodeX continues by itself',
    hoSub: 'A bot check needs a person. Tap, press and hold, or drag on the page below just as you would on the site.',
    hoDone: 'Done ✓',
    hoCant: 'Can\'t solve it',
    hoConfirmCant: 'Give up on this check? QodeX stops waiting and tells you.',
    hoWaiting: 'Waiting for you…',
    hoChecking: 'Checking the page…',
    hoStill: 'QodeX still sees the check — keep going.',
    hoCleared: '✓ Cleared — QodeX continues by itself. You can close this page.',
    hoEnded: 'This hand-off is over — QodeX continues by itself. You can close this page.',
    hoCancelled: 'Cancelled — QodeX will not retry by itself.',
    hoTimeout: 'Time ran out — QodeX stopped waiting.',
    hoZoomIn: 'Zoom to the check',
    hoZoomOut: 'Whole page',
    hoModeHold: 'Touch: tap · hold · drag',
    hoModeScroll: 'Touch: scroll',
    hoKeyboard: 'Keyboard',
    hoOpen: 'Open live view',
    hoHoldCapped: 'Released — a hold lasts at most 15 seconds.',
    hoScopedNote: 'This link only shows this check and expires soon. Don\'t share it.',
    st_planning: 'planning',
    st_running: 'running',
    st_paused: 'paused',
    st_awaiting_approval: 'awaiting approval',
    st_completed: 'completed',
    st_failed: 'failed',
    st_cancelled: 'cancelled',
  },
  fa: {
    title: 'مرکز کنترل QodeX',
    live: 'مرورگر زنده',
    back: 'عقب',
    forward: 'جلو',
    reload: 'بارگذاری مجدد',
    go: 'برو',
    urlPh: 'آدرس را وارد کنید (اول کنترل را بگیرید)',
    takeOver: 'گرفتن کنترل',
    handBack: 'تحویل به عامل',
    agentInControl: 'عامل در حال کنترل است. برای کار با مرورگر، کنترل را بگیرید.',
    youInControl: 'کنترل دست شماست — عامل تا وقتی کنترل را تحویل ندهید منتظر می‌ماند.',
    idle: 'هنوز مرورگری در این پردازش QodeX اجرا نشده است. به محض اینکه عامل صفحه‌ای باز کند، اینجا نمایش داده می‌شود.',
    idleHint: 'برای باز کردن مرورگر، کنترل را بگیرید و یک آدرس وارد کنید.',
    starting: 'در حال راه‌اندازی نمای زنده…',
    liveError: 'نمای زنده در دسترس نیست',
    typePh: 'در صفحه تایپ کنید…',
    send: 'ارسال',
    enter: 'اینتر ⏎',
    approvals: 'تأییدها',
    noApprovals: 'چیزی منتظر تأیید شما نیست.',
    missionBadge: 'مأموریت',
    from: 'از طرف',
    steer: 'هدایت عامل',
    steerPh: 'یادداشتی برای عامل بنویسید — در قدم بعدی به آن اضافه می‌شود.',
    steerSent: 'ارسال شد — عامل در قدم بعدی آن را می‌بیند.',
    noAgent: 'در این پردازش عاملی در حال اجرا نیست.',
    stopAll: '⏹ توقف',
    confirmStop: 'همهٔ کارهای QodeX متوقف شود — کار در حال اجرا، اجراهای پس‌زمینه، سرورهای توسعه و همهٔ مأموریت‌های فعال؟',
    stopDone: 'متوقف شد',
    stopNothing: 'چیزی در حال اجرا نبود.',
    missions: 'مأموریت‌ها',
    noMissions: 'هنوز مأموریتی وجود ندارد.',
    cancel: 'لغو',
    confirmCancel: 'این مأموریت لغو شود؟',
    open: 'باز کردن',
    activity: 'فعالیت‌ها',
    noActivity: 'هنوز فعالیتی ثبت نشده است.',
    connected: 'متصل',
    disconnected: 'در حال اتصال مجدد…',
    authLost: 'دسترسی منقضی شده است. لینک کاملی را که QodeX چاپ کرده دوباره باز کنید (با ?k=… تمام می‌شود).',
    failed: 'ناموفق',
    answered: 'پاسخ داده شد',
    by: 'توسط',
    tabs: 'زبانه',
    headless: 'بدون پنجره',
    headed: 'با پنجره',
    attached: 'متصل به کروم',
    warnShare: 'هر کس این لینک را داشته باشد می‌تواند مرورگر QodeX را ببیند و کنترل کند و به تأییدها پاسخ دهد. آن را خصوصی نگه دارید.',
    k_agent: 'عامل',
    k_approval: 'تأیید',
    k_mission: 'مأموریت',
    k_browser: 'مرورگر',
    k_sentinel: 'نگهبان',
    k_notice: 'اطلاعیه',
    risk_low: 'کم',
    risk_medium: 'متوسط',
    risk_high: 'زیاد',
    risk_critical: 'بحرانی',
    autoAsks: 'حالت خودکار باز هم می‌پرسد',
    cat_purchase: 'خرید',
    cat_payment: 'پرداخت',
    cat_send: 'ارسال',
    cat_credential: 'اطلاعات ورود',
    cat_delete: 'حذف',
    cat_publish: 'انتشار',
    cat_account: 'حساب کاربری',
    cat_download: 'دانلود',
    cat_upload: 'آپلود',
    cat_navigation: 'ناوبری',
    cat_desktop: 'دسکتاپ',
    cat_other: 'سایر',
    opt_yes: 'بله',
    opt_no: 'خیر',
    opt_always: 'همیشه',
    opt_approve: 'تأیید',
    opt_deny: 'رد',
    opt_accept: 'قبول',
    opt_reject: 'رد کردن',
    opt_cancel: 'لغو',
    opt_skip: 'رد شدن',
    opt_edit: 'ویرایش',
    opt_continue: 'ادامه',
    opt_done: 'انجام شد',
    cat_challenge: 'بررسی ضدربات',
    hoBanner: 'حلش کنید — QodeX خودش ادامه می‌دهد',
    hoSub: 'یک بررسیِ ضدربات به انسان نیاز دارد. روی صفحهٔ زیر همان‌طور که در خودِ سایت کار می‌کنید بزنید، نگه دارید یا بکشید.',
    hoDone: 'انجام شد ✓',
    hoCant: 'نمی‌توانم حلش کنم',
    hoConfirmCant: 'از این بررسی صرف‌نظر شود؟ QodeX دیگر منتظر نمی‌ماند و به شما خبر می‌دهد.',
    hoWaiting: 'منتظر شما…',
    hoChecking: 'در حال بررسی صفحه…',
    hoStill: 'QodeX هنوز بررسی را می‌بیند — ادامه دهید.',
    hoCleared: '✓ برطرف شد — QodeX خودش ادامه می‌دهد. می‌توانید این صفحه را ببندید.',
    hoEnded: 'این واگذاری تمام شد — QodeX خودش ادامه می‌دهد. می‌توانید این صفحه را ببندید.',
    hoCancelled: 'لغو شد — QodeX خودش دوباره امتحان نمی‌کند.',
    hoTimeout: 'مهلت تمام شد — QodeX دیگر منتظر نمی‌ماند.',
    hoZoomIn: 'بزرگ‌نمایی روی بررسی',
    hoZoomOut: 'کل صفحه',
    hoModeHold: 'لمس: زدن · نگه‌داشتن · کشیدن',
    hoModeScroll: 'لمس: پیمایش',
    hoKeyboard: 'صفحه‌کلید',
    hoOpen: 'باز کردن نمای زنده',
    hoHoldCapped: 'رها شد — نگه‌داشتن حداکثر ۱۵ ثانیه طول می‌کشد.',
    hoScopedNote: 'این لینک فقط همین بررسی را نشان می‌دهد و به‌زودی منقضی می‌شود. آن را با کسی به اشتراک نگذارید.',
    st_planning: 'در حال برنامه‌ریزی',
    st_running: 'در حال اجرا',
    st_paused: 'متوقف',
    st_awaiting_approval: 'منتظر تأیید',
    st_completed: 'انجام شد',
    st_failed: 'ناموفق',
    st_cancelled: 'لغو شد',
  },
};

/** Same shape as src/control/handoff.ts HANDOFF_ID_RE (kept local: the page script tests it too). */
const HANDOFF_BOOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** JSON safe to embed inside a <script> element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const CSS = String.raw`
:root{--bg:#0b0f14;--panel:#121821;--panel2:#18202b;--border:#243041;--text:#e5e7eb;--muted:#94a3b8;--accent:#22d3ee;--accent2:#0891b2;--ok:#22c55e;--warn:#f59e0b;--high:#f97316;--danger:#ef4444;--crit:#dc2626;--radius:12px}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Vazirmatn",Tahoma,sans-serif}
html[lang=fa] body{font-family:"Vazirmatn","Vazir","Segoe UI",Tahoma,system-ui,sans-serif}
button,input,textarea{font:inherit;color:inherit}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:10px 16px;background:rgba(11,15,20,.92);backdrop-filter:blur(6px);border-bottom:1px solid var(--border)}
header h1{font-size:16px;margin:0;font-weight:650;letter-spacing:.2px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:10px;height:10px;border-radius:50%;background:var(--danger);flex:none;box-shadow:0 0 0 3px rgba(239,68,68,.15)}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px rgba(34,197,94,.15)}
.conn{color:var(--muted);font-size:12px;white-space:nowrap}
.badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--panel2);border:1px solid var(--border);color:var(--muted);white-space:nowrap}
.badge.count{background:var(--danger);color:#fff;border-color:transparent}
.badge.r-critical{background:rgba(220,38,38,.18);color:#fca5a5;border-color:rgba(220,38,38,.5)}
.badge.r-high{background:rgba(249,115,22,.16);color:#fdba74;border-color:rgba(249,115,22,.45)}
.badge.r-medium{background:rgba(245,158,11,.14);color:#fcd34d;border-color:rgba(245,158,11,.4)}
.badge.r-low{color:var(--muted)}
.badge.mission{color:#a5b4fc;border-color:rgba(165,180,252,.4)}
.btn{border:1px solid var(--border);background:var(--panel2);border-radius:9px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.btn:hover:not(:disabled){border-color:var(--accent2)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.primary{background:var(--accent2);border-color:var(--accent2);color:#fff}
.btn.ok{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.55);color:#bbf7d0}
.btn.no{background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.5);color:#fecaca}
.btn.danger{background:var(--danger);border-color:var(--danger);color:#fff}
.btn.icon{padding:6px 10px;min-width:36px}
main{display:grid;gap:14px;padding:14px 16px 28px;grid-template-columns:minmax(0,2fr) minmax(300px,1fr);grid-template-areas:"live side" "activity activity";align-items:start}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:12px;min-width:0}
.panel h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);display:flex;align-items:center;gap:8px}
html[lang=fa] .panel h2{text-transform:none;letter-spacing:0;font-size:14px}
#livePanel{grid-area:live}#side{grid-area:side;display:flex;flex-direction:column;gap:14px;min-width:0}#activityPanel{grid-area:activity}
.toolbar{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.toolbar form{flex:1;display:flex;gap:6px;min-width:180px}
.toolbar input{flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:6px 10px;direction:ltr}
.toolbar input:disabled{opacity:.6}
.status{font-size:12px;color:var(--muted);margin:0 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.status .who{font-weight:600;color:var(--text)}
body.takeover .status .who{color:var(--warn)}
#screen{position:relative;direction:ltr;background:#05080c;border:1px solid var(--border);border-radius:10px;overflow:hidden;min-height:220px;outline:none;touch-action:auto}
body.takeover #screen{border-color:var(--warn);box-shadow:0 0 0 2px rgba(245,158,11,.25);cursor:crosshair;touch-action:none}
#screen:focus-visible{box-shadow:0 0 0 2px var(--accent)}
#frame{display:block;width:100%;height:auto;user-select:none;-webkit-user-drag:none}
#frame.hidden{display:none}
#overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center;color:var(--muted)}
#overlay.hidden{display:none}
#overlay .big{font-size:28px}
.typebar{display:flex;gap:6px;margin-top:8px}
.typebar input{flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:6px 10px}
.msg{font-size:12px;color:var(--muted);min-height:18px;margin-top:6px}
.msg.err{color:#fca5a5}
.card{border:1px solid var(--border);background:var(--panel2);border-radius:10px;padding:10px;margin-bottom:10px}
.card.r-critical{border-color:rgba(220,38,38,.6)}
.card.r-high{border-color:rgba(249,115,22,.5)}
.card .meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;font-size:11px;color:var(--muted)}
.card .prompt{white-space:pre-wrap;word-break:break-word;margin:4px 0 10px}.card .why{color:var(--warn);font-size:12px;margin:4px 0 0}
.card .opts{display:flex;gap:6px;flex-wrap:wrap}
.empty{color:var(--muted);font-size:13px;padding:6px 2px}
textarea{width:100%;min-height:70px;resize:vertical;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:8px 10px}
.row{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px}
.mission{border-bottom:1px solid var(--border);padding:8px 0;display:flex;gap:8px;align-items:flex-start}
.mission:last-child{border-bottom:0}
.mission .body{flex:1;min-width:0}
.mission .goal{word-break:break-word}
.mission .sub{font-size:11px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.mission .acts{display:flex;gap:6px;flex:none}
.st-running,.st-planning{color:var(--accent)}.st-completed{color:var(--ok)}.st-failed{color:#fca5a5}.st-awaiting_approval,.st-paused{color:var(--warn)}.st-cancelled{color:var(--muted)}
#activityList{list-style:none;margin:0;padding:0;max-height:420px;overflow:auto;font-size:12.5px}
#activityList li{display:flex;gap:8px;padding:5px 2px;border-bottom:1px solid rgba(36,48,65,.6);align-items:baseline}
#activityList time{color:var(--muted);font-variant-numeric:tabular-nums;flex:none;direction:ltr}
#activityList .chip{flex:none;font-size:10.5px;padding:0 6px;border-radius:6px;background:var(--panel2);border:1px solid var(--border);color:var(--muted)}
#activityList .chip.k-sentinel{color:#fca5a5}#activityList .chip.k-mission{color:#a5b4fc}#activityList .chip.k-browser{color:var(--accent)}#activityList .chip.k-approval{color:var(--warn)}#activityList .chip.k-warn{color:var(--warn)}#activityList .chip.k-error{color:#fca5a5}
#activityList .txt{min-width:0;word-break:break-word}
.banner{display:none;margin:12px 16px 0;padding:10px 12px;border-radius:10px;background:rgba(239,68,68,.14);border:1px solid rgba(239,68,68,.5);color:#fecaca}
.banner.show{display:block}
footer{color:var(--muted);font-size:11.5px;text-align:center;padding:0 16px 22px}
.hidden{display:none!important}
@media (max-width:900px){main{display:flex;flex-direction:column;align-items:stretch;padding:10px}#side{display:contents}#approvalsPanel{order:1}#livePanel{order:2}#steerPanel{order:3}#missionsPanel{order:4}#activityPanel{order:5}header{padding:10px}#activityList{max-height:300px}}
.hobar{border:1px solid rgba(245,158,11,.55);background:rgba(245,158,11,.10);border-radius:10px;padding:10px;margin-bottom:10px}
.hobar .hotitle{font-weight:700;font-size:15px;color:#fde68a}
.hobar .hoinfo,.hobar .hosub{font-size:12px;color:var(--muted);margin-top:2px}
.hobar .hostatus{font-size:13px;margin:6px 0;min-height:18px}
.hobar .hostatus.ok{color:#bbf7d0}.hobar .hostatus.err{color:#fca5a5}
.hobar .opts{display:flex;gap:6px;flex-wrap:wrap}
.hobar .btn.big{padding:9px 16px;font-weight:650}
#frame{transform-origin:0 0;transition:transform .2s ease}
body.handoff #takeBtn{display:none}
body.handoff #screen{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
body.handoff.takeover #screen{touch-action:pinch-zoom}
body.handoff.hoscroll.takeover #screen{touch-action:none}
body.scoped #side,body.scoped #activityPanel,body.scoped #stopBtn,body.scoped #urlForm,body.scoped #backBtn,body.scoped #fwdBtn,body.scoped #approvalCount{display:none!important}
body.scoped main{grid-template-columns:minmax(0,1fr);grid-template-areas:"live"}
@media (max-width:900px){body.handoff #livePanel{order:0}}
`;

/**
 * Page-side input helpers as plain ES5 source. The page script embeds this exact
 * string, and the unit tests evaluate it with `new Function`, so both run the same
 * code (no DOM needed — the functions only look at the event fields they're given).
 *
 * qxKeyAction(keydownEvent) → null (ignore) | {kind:'paste'} (let the native paste
 * event carry the text) | {kind:'text', text} | {kind:'key', key: <Playwright key>}.
 * Rules: one user-perceived character (any script, emoji, ZWNJ, AltGr / macOS
 * Option compositions) is typed as text — Playwright's keyboard.press() only knows
 * US-layout keys. Shortcuts on a non-Latin layout (Persian Ctrl+A arrives as "ش")
 * are sent by PHYSICAL key (e.code, e.g. "ControlOrMeta+KeyA"), which Playwright
 * accepts and which matches what the user pressed.
 *
 * qxEnqueueInput(queue, ev, max?) adds an input event to the not-yet-sent queue,
 * coalescing so a slow link never builds a backlog: consecutive pointer moves
 * collapse to the latest, a move right before a click (or a positioned scroll) is
 * dropped, scrolls at the same point and consecutive typing merge, and the queue is
 * bounded (oldest move dropped first, then the oldest event). A press-and-hold's
 * 'down' / 'up' are never merged or dropped: a lost 'up' would leave a button held.
 *
 * qxHoldStep(g, ev, now) is the hand-off gesture state machine: it turns the human's
 * pointer events ({kind:'down'|'move'|'up'|'cancel'|'abort'|'tick', id, p}) into the
 * 'down' / 'move' / 'up' input events to relay, one gesture at a time. Every 'down'
 * it emits is followed by exactly one 'up' — on release, cancel, a second finger
 * (that is a pinch zoom, not page input), abort (page hidden, stream dropped, control
 * lost) or after QX_HOLD_MAX_MS (a hold is capped; 'capped' is set on the gesture).
 */
export const DASHBOARD_INPUT_HELPERS = String.raw`
var QX_MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super', 'Symbol', 'SymbolLock'];
var QX_PHYSICAL_KEY = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|IntlBackslash)$/;
var QX_MAX_DELTA = 100000;
function qxKeyAction(e) {
  var key = e && typeof e.key === 'string' ? e.key : '';
  if (!key || e.isComposing || key === 'Unidentified' || key === 'Dead' || key === 'Process') return null;
  if (QX_MODIFIER_KEYS.indexOf(key) >= 0) return null;
  var code = typeof e.code === 'string' ? e.code : '';
  var altGr = false;
  try { altGr = !!(e.getModifierState && e.getModifierState('AltGraph')); } catch (x) { altGr = false; }
  // Windows reports AltGr as Ctrl+Alt: those characters are typed, not shortcuts.
  var ctrlOrMeta = !!(e.ctrlKey || e.metaKey) && !altGr;
  var alt = !!e.altKey && !altGr;
  var single = Array.from(key).length === 1;
  if (ctrlOrMeta && !alt && (code === 'KeyV' || key === 'v' || key === 'V')) return { kind: 'paste' };
  if (single && !ctrlOrMeta && (!alt || !/^[A-Za-z0-9]$/.test(key))) return { kind: 'text', text: key };
  var name;
  if (key === ' ') name = 'Space';
  else if (single) {
    if (/^[\x21-\x7e]$/.test(key)) name = e.shiftKey ? key : key.toLowerCase();
    else if (QX_PHYSICAL_KEY.test(code)) name = code;
    else return null;
  } else name = key;
  var parts = [];
  if (ctrlOrMeta) parts.push('ControlOrMeta');
  if (alt) parts.push('Alt');
  if (e.shiftKey && (!single || ctrlOrMeta || alt)) parts.push('Shift');
  parts.push(name);
  return { kind: 'key', key: parts.join('+') };
}
function qxClampDelta(v) { return Math.max(-QX_MAX_DELTA, Math.min(QX_MAX_DELTA, Math.round(v))); }
function qxEnqueueInput(queue, ev, max) {
  var cap = max > 0 ? max : 200;
  var last = queue.length ? queue[queue.length - 1] : null;
  if (ev.type === 'move') {
    if (last && last.type === 'move') { queue[queue.length - 1] = ev; return queue; }
  } else if (ev.type === 'click' || (ev.type === 'scroll' && typeof ev.x === 'number')) {
    while (queue.length && queue[queue.length - 1].type === 'move') queue.pop();
    last = queue.length ? queue[queue.length - 1] : null;
  }
  if (ev.type === 'scroll') {
    ev.dx = qxClampDelta(ev.dx || 0); ev.dy = qxClampDelta(ev.dy || 0);
    if (last && last.type === 'scroll' && last.x === ev.x && last.y === ev.y && last.frameWidth === ev.frameWidth && last.frameHeight === ev.frameHeight) {
      last.dx = qxClampDelta(last.dx + ev.dx); last.dy = qxClampDelta(last.dy + ev.dy);
      return queue;
    }
  } else if (ev.type === 'type' && last && last.type === 'type' && (last.text + ev.text).length <= 10000) {
    last.text = last.text + ev.text;
    return queue;
  }
  queue.push(ev);
  while (queue.length > cap) {
    var drop = -1, i;
    for (i = 0; i < queue.length - 1; i++) if (queue[i].type === 'move') { drop = i; break; }
    if (drop < 0) for (i = 0; i < queue.length; i++) if (queue[i].type !== 'down' && queue[i].type !== 'up') { drop = i; break; }
    if (drop < 0) break;
    queue.splice(drop, 1);
  }
  return queue;
}
var QX_HOLD_MAX_MS = 15000;
var QX_MOVE_EVERY_MS = 40;
function qxHoldEvent(type, p) {
  var ev = { type: type, button: 'left' };
  if (p) { ev.x = p.x; ev.y = p.y; if (p.frameWidth) ev.frameWidth = p.frameWidth; if (p.frameHeight) ev.frameHeight = p.frameHeight; }
  return ev;
}
function qxHoldStep(g, ev, now) {
  var out = [];
  if (!g.pointers) g.pointers = {};
  var kind = ev && ev.kind;
  var release = function (p) {
    if (!g.down) return;
    g.down = false;
    out.push(qxHoldEvent('up', p || g.p));
  };
  if (kind === 'down') {
    g.pointers[ev.id] = true;
    var n = 0, k;
    for (k in g.pointers) if (Object.prototype.hasOwnProperty.call(g.pointers, k)) n++;
    if (n > 1) { release(null); return out; }
    if (!ev.p) return out;
    release(null);
    g.down = true; g.id = ev.id; g.p = ev.p; g.t0 = now; g.lastMove = 0; g.capped = false;
    out.push(qxHoldEvent('down', ev.p));
  } else if (kind === 'move') {
    if (!g.down || ev.id !== g.id || !ev.p) return out;
    g.p = ev.p;
    if (now - (g.lastMove || 0) < QX_MOVE_EVERY_MS) return out;
    g.lastMove = now;
    out.push(qxHoldEvent('move', ev.p));
  } else if (kind === 'up' || kind === 'cancel') {
    delete g.pointers[ev.id];
    if (g.down && ev.id === g.id) release(kind === 'up' && ev.p ? ev.p : null);
  } else if (kind === 'abort') {
    g.pointers = {};
    release(null);
  } else if (kind === 'tick') {
    if (g.down && now - g.t0 >= QX_HOLD_MAX_MS) { g.capped = true; release(null); }
  }
  return out;
}
`;

const SCRIPT = String.raw`
(function () {
  'use strict';
` + DASHBOARD_INPUT_HELPERS + String.raw`
  var boot = {};
  try { boot = JSON.parse(document.getElementById('qx-boot').textContent || '{}'); } catch (e) { boot = {}; }
  var STR = boot.strings || { en: {} };
  var lang = boot.lang === 'fa' ? 'fa' : 'en';
  try { var saved = window.localStorage.getItem('qx-control-lang'); if (saved === 'en' || saved === 'fa') lang = saved; } catch (e) {}

  function t(key) {
    var d = STR[lang] || {};
    if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    if (STR.en && Object.prototype.hasOwnProperty.call(STR.en, key)) return STR.en[key];
    return key;
  }
  function has(key) { return !!(STR[lang] && Object.prototype.hasOwnProperty.call(STR[lang], key)); }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  // Dynamic text (prompts, goals, page titles) can be English inside the Persian UI or
  // vice versa: let each piece pick its own direction so punctuation lands correctly.
  function autoDir(n) { n.setAttribute('dir', 'auto'); return n; }
  function clip(s, n) { s = String(s === undefined || s === null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function hhmmss(ts) { var d = new Date(typeof ts === 'number' ? ts : Date.now()); return d.toTimeString().slice(0, 8); }
  function isHttp(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }

  var state = {
    browser: null, approvals: {}, missionApprovals: {}, actions: [], missions: null,
    takeover: false, live: false, frameW: 0, frameH: 0, activity: [], connected: false, authLost: false
  };

  // Hand-off mode: a CAPTCHA / bot check waits for a person (boot.handoff from a
  // hand-off link — scoped to this one hand-off — or ?handoff=<id> for the owner).
  var HO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
  var HO = boot.handoff && HO_ID_RE.test(String(boot.handoff.id || '')) ? { id: String(boot.handoff.id), scoped: !!boot.handoff.scoped } : null;
  if (!HO) {
    try { var qho = new URLSearchParams(window.location.search).get('handoff'); if (qho && HO_ID_RE.test(qho)) HO = { id: qho, scoped: false }; } catch (e) {}
  }
  var ho = { info: null, zoom: true, mode: 'hold', answered: '', ended: '', autoTook: false };
  var hold = { down: false, pointers: {} }, holdTimer = null;

  // ── API ─────────────────────────────────────────────────────────────────────
  function api(method, path, body) {
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body === undefined ? {} : body); }
    return fetch(path, init).then(function (r) {
      return r.text().then(function (txt) {
        var j = {};
        try { j = txt ? JSON.parse(txt) : {}; } catch (e) { j = {}; }
        if (r.status === 401) { if (HO && HO.scoped) handoffEnded(''); else setAuthLost(true); }
        if (r.status === 410 && HO) handoffEnded(j.outcome || '');
        if (!r.ok) { var err = new Error(j.error || ('HTTP ' + r.status)); err.status = r.status; throw err; }
        return j;
      });
    });
  }
  function errText(e) { return (e && e.message) ? String(e.message) : t('failed'); }
  function setAuthLost(v) { state.authLost = v; $('authBanner').classList.toggle('show', !!v); }

  // ── language ────────────────────────────────────────────────────────────────
  function baseTitle() { return boot.title ? String(boot.title) : t('title'); }
  function applyLang() {
    var root = document.documentElement;
    root.lang = lang;
    root.dir = lang === 'fa' ? 'rtl' : 'ltr';
    var nodes = document.querySelectorAll('[data-i18n]'), i;
    for (i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    nodes = document.querySelectorAll('[data-i18n-ph]');
    for (i = 0; i < nodes.length; i++) nodes[i].setAttribute('placeholder', t(nodes[i].getAttribute('data-i18n-ph')));
    nodes = document.querySelectorAll('[data-i18n-title]');
    for (i = 0; i < nodes.length; i++) { var k = t(nodes[i].getAttribute('data-i18n-title')); nodes[i].setAttribute('title', k); nodes[i].setAttribute('aria-label', k); }
    $('appTitle').textContent = baseTitle();
    $('langBtn').textContent = lang === 'fa' ? 'English' : 'فارسی';
    renderConn(); renderTakeover(); renderApprovals(); renderMissions(); renderActivity(); renderBrowserInfo();
    if (HO) renderHandoff();
  }
  $('langBtn').addEventListener('click', function () {
    lang = lang === 'fa' ? 'en' : 'fa';
    try { window.localStorage.setItem('qx-control-lang', lang); } catch (e) {}
    applyLang();
  });

  // ── connection + title ──────────────────────────────────────────────────────
  function renderConn() {
    $('connDot').classList.toggle('on', state.connected);
    $('connText').textContent = state.connected ? t('connected') : t('disconnected');
  }
  function pendingCount() { return Object.keys(state.approvals).length + Object.keys(state.missionApprovals).filter(function (id) { return !state.approvals[id]; }).length; }
  function updateTitle() {
    var n = pendingCount();
    document.title = (n ? '(' + n + ') ' : '') + baseTitle();
    var c = $('approvalCount');
    c.textContent = String(n);
    c.classList.toggle('hidden', n === 0);
  }

  // ── browser / takeover ──────────────────────────────────────────────────────
  function activeTab(b) {
    if (!b || !b.tabs) return null;
    for (var i = 0; i < b.tabs.length; i++) if (b.tabs[i].active) return b.tabs[i];
    return b.tabs[0] || null;
  }
  function setBrowser(b) {
    state.browser = b || null;
    // A hand-off link drives the browser only through its own hand-off's takeover.
    state.takeover = !!(b && b.takeover) && !(HO && HO.scoped && b.takeoverBy !== 'handoff:' + HO.id);
    var tab = activeTab(b);
    if (tab && document.activeElement !== $('url')) $('url').value = tab.url || '';
    renderTakeover();
    renderBrowserInfo();
  }
  function renderBrowserInfo() {
    var b = state.browser, parts = [];
    if (b && b.running) {
      parts.push(b.mode === 'cdp' ? t('attached') : (b.headless ? t('headless') : t('headed')));
      if (b.profile) parts.push(b.profile);
      if (b.tabs) parts.push(b.tabs.length + ' ' + t('tabs'));
    }
    $('browserInfo').textContent = parts.join(' · ');
  }
  function renderTakeover() {
    document.body.classList.toggle('takeover', state.takeover);
    $('who').textContent = state.takeover ? t('youInControl') : t('agentInControl');
    var btn = $('takeBtn');
    btn.textContent = state.takeover ? t('handBack') : t('takeOver');
    btn.className = 'btn ' + (state.takeover ? 'danger' : 'primary');
    var ids = ['url', 'goBtn', 'backBtn', 'fwdBtn', 'reloadBtn', 'typeBox', 'typeSend', 'enterBtn'];
    for (var i = 0; i < ids.length; i++) $(ids[i]).disabled = !state.takeover;
    if (!state.takeover && inputQueue) { inputQueue.length = 0; typeBuf = ''; }
    if (!state.takeover && hold && hold.down) holdAbort();
    renderOverlay();
  }
  $('takeBtn').addEventListener('click', function () {
    var want = !state.takeover, btn = $('takeBtn');
    btn.disabled = true;
    api('POST', '/api/takeover', { on: want }).then(function (j) {
      if (j.browser) setBrowser(j.browser);
      state.takeover = !!j.takeover; // the server's answer is authoritative
      renderTakeover();
      liveMsg('');
      if (state.takeover) $('screen').focus();
    }).catch(function (e) { liveMsg(errText(e), true); }).then(function () { btn.disabled = false; });
  });

  // ── live frames ─────────────────────────────────────────────────────────────
  var idleReason = 'connecting', idleDetail = '';
  function renderOverlay() {
    var ov = $('overlay');
    if (state.live) { ov.classList.add('hidden'); $('frame').classList.remove('hidden'); return; }
    $('frame').classList.add('hidden');
    ov.classList.remove('hidden');
    var main = idleReason === 'starting' || idleReason === 'connecting' ? t('starting')
      : idleReason === 'error' ? t('liveError') + (idleDetail ? ': ' + idleDetail : '')
      : t('idle');
    $('overlayText').textContent = main;
    $('overlayHint').textContent = (idleReason === 'no-browser' || idleReason === 'closed') && !state.takeover ? t('idleHint') : '';
  }
  var framesES = null, framesRetry = null;
  function openFrames() {
    if (framesES || document.hidden || (HO && HO.scoped && ho.ended)) return;
    var es = new EventSource('/api/frames');
    framesES = es;
    es.addEventListener('frame', function (e) {
      var f; try { f = JSON.parse(e.data); } catch (x) { return; }
      if (!f || typeof f.data !== 'string') return;
      state.frameW = f.w || 0; state.frameH = f.h || 0;
      $('frame').src = 'data:image/jpeg;base64,' + f.data;
      if (!state.live) { state.live = true; renderOverlay(); }
      if (HO) applyZoom();
    });
    es.addEventListener('idle', function (e) {
      var d = {}; try { d = JSON.parse(e.data); } catch (x) {}
      idleReason = d.reason || 'no-browser'; idleDetail = d.message || '';
      state.live = false; renderOverlay();
      holdAbort(); // the human can no longer see what they hold
    });
    es.onerror = function () {
      holdAbort();
      if (es.readyState === 2) {
        if (framesES === es) framesES = null;
        clearTimeout(framesRetry);
        framesRetry = setTimeout(openFrames, 3000);
      }
    };
  }
  function closeFrames() { if (framesES) { framesES.close(); framesES = null; } }
  document.addEventListener('visibilitychange', function () {
    // A hidden tab stops the screencast server-side (no viewers → no frames).
    if (document.hidden) { holdAbort(); closeFrames(); } else { openFrames(); refreshState(); }
  });

  // ── human input (only while the human holds control) ───────────────────────
  // One request in flight at a time; everything else waits in a coalescing queue
  // (qxEnqueueInput), so a slow phone/tunnel link never builds a backlog of moves.
  var inputQueue = [], inputBusy = false;
  function liveMsg(text, isErr) { var m = $('liveMsg'); m.textContent = text || ''; m.classList.toggle('err', !!isErr); }
  function sendInput(ev) {
    if (!state.takeover) return;
    qxEnqueueInput(inputQueue, ev);
    pumpInput();
  }
  function pumpInput() {
    if (inputBusy || !inputQueue.length) return;
    if (!state.takeover) { inputQueue.length = 0; return; }
    var ev = inputQueue.shift();
    inputBusy = true;
    api('POST', '/api/input', ev).then(function () { liveMsg(''); }).catch(function (e) {
      liveMsg(errText(e), true);
      if (e && e.status === 409) { inputQueue.length = 0; refreshState(); }
    }).then(function () { inputBusy = false; pumpInput(); });
  }
  var frameImg = $('frame'), screen = $('screen');
  function framePoint(e) {
    var r = frameImg.getBoundingClientRect();
    var fw = frameImg.naturalWidth || state.frameW, fh = frameImg.naturalHeight || state.frameH;
    if (!state.live || !r.width || !r.height || !fw || !fh) return null;
    var x = (e.clientX - r.left) / r.width * fw, y = (e.clientY - r.top) / r.height * fh;
    if (x < 0 || y < 0 || x > fw || y > fh) return null;
    return { x: Math.round(x), y: Math.round(y), frameWidth: fw, frameHeight: fh };
  }
  frameImg.addEventListener('dragstart', function (e) { e.preventDefault(); });
  screen.addEventListener('click', function (e) {
    if (!state.takeover) return;
    if (hoGestures()) { e.preventDefault(); return; } // relayed as down/up already
    screen.focus();
    var p = framePoint(e); if (!p) return;
    e.preventDefault();
    flushType();
    sendInput({ type: 'click', x: p.x, y: p.y, button: 'left', clickCount: Math.min(3, Math.max(1, e.detail || 1)), frameWidth: p.frameWidth, frameHeight: p.frameHeight });
  });
  screen.addEventListener('contextmenu', function (e) {
    if (HO) { e.preventDefault(); return; } // a phone long-press is a hold, never a right-click
    if (!state.takeover) return;
    e.preventDefault();
    var p = framePoint(e); if (!p) return;
    sendInput({ type: 'click', x: p.x, y: p.y, button: 'right', clickCount: 1, frameWidth: p.frameWidth, frameHeight: p.frameHeight });
  });
  screen.addEventListener('auxclick', function (e) {
    if (!state.takeover || e.button !== 1) return;
    e.preventDefault();
    var p = framePoint(e); if (!p) return;
    sendInput({ type: 'click', x: p.x, y: p.y, button: 'middle', clickCount: 1, frameWidth: p.frameWidth, frameHeight: p.frameHeight });
  });
  var lastMove = 0;
  screen.addEventListener('mousemove', function (e) {
    if (!state.takeover || hold.down) return;
    var now = Date.now(); if (now - lastMove < 120) return;
    var p = framePoint(e); if (!p) return;
    lastMove = now;
    sendInput({ type: 'move', x: p.x, y: p.y, frameWidth: p.frameWidth, frameHeight: p.frameHeight });
  });
  var wheel = { dx: 0, dy: 0, p: null, timer: null };
  function flushWheel() {
    wheel.timer = null;
    if (!wheel.dx && !wheel.dy) return;
    var ev = { type: 'scroll', dx: Math.round(wheel.dx), dy: Math.round(wheel.dy) };
    if (wheel.p) { ev.x = wheel.p.x; ev.y = wheel.p.y; ev.frameWidth = wheel.p.frameWidth; ev.frameHeight = wheel.p.frameHeight; }
    wheel.dx = 0; wheel.dy = 0;
    sendInput(ev);
  }
  screen.addEventListener('wheel', function (e) {
    if (!state.takeover) return;
    e.preventDefault();
    var k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    wheel.dx += e.deltaX * k; wheel.dy += e.deltaY * k; wheel.p = framePoint(e);
    if (!wheel.timer) wheel.timer = setTimeout(flushWheel, 80);
  }, { passive: false });
  var touch = null;
  screen.addEventListener('touchstart', function (e) {
    if (!state.takeover || e.touches.length !== 1 || hoGestures()) { touch = null; return; }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  screen.addEventListener('touchmove', function (e) {
    if (!state.takeover || !touch || e.touches.length !== 1 || hoGestures()) return;
    e.preventDefault();
    var nx = e.touches[0].clientX, ny = e.touches[0].clientY;
    var r = frameImg.getBoundingClientRect(), fw = frameImg.naturalWidth || state.frameW || r.width;
    var scale = r.width ? fw / r.width : 1;
    wheel.dx += (touch.x - nx) * scale; wheel.dy += (touch.y - ny) * scale;
    touch = { x: nx, y: ny };
    if (!wheel.timer) wheel.timer = setTimeout(flushWheel, 80);
  }, { passive: false });

  // Hand-off gestures: the human's own press-and-hold and drag, relayed as they
  // happen ('down' → 'move'… → 'up', see qxHoldStep). Two fingers = pinch zoom.
  function hoGestures() { return !!HO && !ho.ended && ho.mode === 'hold' && state.takeover; }
  function syncHoldTimer() {
    if (hold.down && !holdTimer) holdTimer = setInterval(function () { relayHold(qxHoldStep(hold, { kind: 'tick' }, Date.now())); }, 500);
    else if (!hold.down && holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  }
  function relayHold(evs) {
    for (var i = 0; i < evs.length; i++) sendInput(evs[i]);
    if (hold.capped) { hold.capped = false; liveMsg(t('hoHoldCapped')); }
    syncHoldTimer();
  }
  function holdAbort() { relayHold(qxHoldStep(hold, { kind: 'abort' }, Date.now())); }
  function clampedPoint(e) {
    var r = frameImg.getBoundingClientRect();
    var fw = frameImg.naturalWidth || state.frameW, fh = frameImg.naturalHeight || state.frameH;
    if (!state.live || !r.width || !r.height || !fw || !fh) return null;
    var x = (e.clientX - r.left) / r.width * fw, y = (e.clientY - r.top) / r.height * fh;
    return { x: Math.round(Math.max(0, Math.min(fw, x))), y: Math.round(Math.max(0, Math.min(fh, y))), frameWidth: fw, frameHeight: fh };
  }
  screen.addEventListener('pointerdown', function (e) {
    if (!hoGestures() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var evs = qxHoldStep(hold, { kind: 'down', id: e.pointerId, p: framePoint(e) }, Date.now());
    if (hold.down && hold.id === e.pointerId) {
      e.preventDefault();
      try { screen.setPointerCapture(e.pointerId); } catch (x) {}
      flushType();
    }
    relayHold(evs);
  });
  screen.addEventListener('pointermove', function (e) {
    if (!hold.down || e.pointerId !== hold.id) return;
    e.preventDefault();
    relayHold(qxHoldStep(hold, { kind: 'move', id: e.pointerId, p: clampedPoint(e) }, Date.now()));
  });
  function pointerEnd(kind) {
    return function (e) { relayHold(qxHoldStep(hold, { kind: kind, id: e.pointerId, p: kind === 'up' ? clampedPoint(e) : null }, Date.now())); };
  }
  screen.addEventListener('pointerup', pointerEnd('up'));
  screen.addEventListener('pointercancel', pointerEnd('cancel'));
  screen.addEventListener('lostpointercapture', pointerEnd('cancel'));
  window.addEventListener('blur', function () { if (hold.down) holdAbort(); });

  // ── hand-off banner ─────────────────────────────────────────────────────────
  function hoMeta() { return ho.info && ho.info.meta ? ho.info.meta : null; }
  function endedText(o) {
    return o === 'cleared' || o === 'done' ? t('hoCleared') : o === 'cancelled' ? t('hoCancelled') : o === 'timeout' ? t('hoTimeout') : t('hoEnded');
  }
  function applyZoom() {
    var img = $('frame'), m = HO && ho.zoom && !ho.ended ? hoMeta() : null, box = m && m.frameBox;
    var fw = img.naturalWidth || state.frameW, lw = img.offsetWidth, lh = img.offsetHeight;
    var tf = '';
    if (box && state.live && fw && lw && lh) {
      var k = lw / fw, pad = 12;
      var bx = box.x * k, by = box.y * k, bw = box.width * k, bh = box.height * k;
      var s = Math.max(1, Math.min(4, lw / (bw + 2 * pad), lh / (bh + 2 * pad)));
      var tx = Math.min(0, Math.max(lw - lw * s, lw / 2 - (bx + bw / 2) * s));
      var ty = Math.min(0, Math.max(lh - lh * s, lh / 2 - (by + bh / 2) * s));
      tf = 'translate(' + Math.round(tx) + 'px,' + Math.round(ty) + 'px) scale(' + s.toFixed(3) + ')';
    }
    if (img.style.transform !== tf) img.style.transform = tf;
  }
  window.addEventListener('resize', function () { if (HO) applyZoom(); });
  function renderHandoff() {
    if (!HO) return;
    $('handoffBar').classList.remove('hidden');
    var m = hoMeta(), info = ho.info, parts = [];
    if (m && m.vendor) parts.push(String(m.vendor));
    if (m && m.host) parts.push(String(m.host));
    $('hoInfo').textContent = parts.join(' · ');
    $('hoNote').classList.toggle('hidden', !HO.scoped);
    $('hoZoomBtn').textContent = ho.zoom ? t('hoZoomOut') : t('hoZoomIn');
    $('hoZoomBtn').classList.toggle('hidden', !(m && m.frameBox));
    $('hoModeBtn').textContent = ho.mode === 'hold' ? t('hoModeHold') : t('hoModeScroll');
    document.body.classList.toggle('hoscroll', ho.mode !== 'hold');
    if (!ho.ended && info && info.active === false) { handoffEnded(info.outcome || 'ended'); return; }
    var txt, cls = '';
    if (ho.ended) { txt = endedText(ho.ended); cls = ho.ended === 'cleared' || ho.ended === 'done' ? 'ok' : (ho.ended === 'ended' ? '' : 'err'); }
    else if (info && !info.pending) txt = t('hoChecking');
    else if (ho.answered === 'done') txt = t('hoStill');
    else txt = t('hoWaiting');
    var st = $('hoStatus');
    st.textContent = txt; st.className = 'hostatus' + (cls ? ' ' + cls : '');
    $('hoDoneBtn').disabled = !!ho.ended; $('hoCantBtn').disabled = !!ho.ended;
    applyZoom();
    // A hand-off link holds the browser through its hand-off's own takeover (never the owner's).
    if (HO.scoped && !ho.ended && info && info.active && state.browser && !state.browser.takeover && !ho.autoTook) {
      ho.autoTook = true;
      api('POST', '/api/takeover', { on: true }).then(function (j) { if (j.browser) setBrowser(j.browser); }).catch(function () {});
    }
  }
  function handoffEnded(outcome) {
    if (!HO || ho.ended) return;
    ho.ended = outcome || 'ended';
    holdAbort();
    if (HO.scoped) { state.takeover = false; renderTakeover(); closeFrames(); }
    else document.body.classList.remove('handoff');
    renderHandoff();
    try { if (navigator.vibrate) navigator.vibrate([60, 60, 60]); } catch (x) {}
  }
  function enterHandoff() {
    document.body.classList.add('handoff');
    if (HO.scoped) document.body.classList.add('scoped');
    renderHandoff();
  }
  function openHandoff(id) {
    HO = { id: id, scoped: false };
    ho = { info: null, zoom: true, mode: 'hold', answered: '', ended: '', autoTook: false };
    try { window.history.replaceState(null, '', '?handoff=' + encodeURIComponent(id)); } catch (e) {}
    enterHandoff();
    refreshState();
    try { $('livePanel').scrollIntoView({ block: 'start' }); } catch (e) {}
  }
  function hoAnswer(answer) {
    if (!HO || ho.ended) return;
    if (answer === 'cancel' && !window.confirm(t('hoConfirmCant'))) return;
    var b1 = $('hoDoneBtn'), b2 = $('hoCantBtn');
    b1.disabled = true; b2.disabled = true;
    holdAbort(); flushType();
    api('POST', '/api/handoff/' + encodeURIComponent(HO.id), { answer: answer }).then(function () {
      ho.answered = answer;
      if (ho.info) ho.info.pending = false;
      renderHandoff(); scheduleState();
    }).catch(function (e) {
      if (e && e.status === 404) handoffEnded('ended');
      else if (!ho.ended) { var st = $('hoStatus'); st.textContent = e && e.status === 409 ? t('hoChecking') : errText(e); st.className = 'hostatus' + (e && e.status === 409 ? '' : ' err'); }
    }).then(function () { if (!ho.ended) { b1.disabled = false; b2.disabled = false; } });
  }
  $('hoDoneBtn').addEventListener('click', function () { hoAnswer('done'); });
  $('hoCantBtn').addEventListener('click', function () { hoAnswer('cancel'); });
  $('hoZoomBtn').addEventListener('click', function () { ho.zoom = !ho.zoom; renderHandoff(); });
  $('hoModeBtn').addEventListener('click', function () { holdAbort(); ho.mode = ho.mode === 'hold' ? 'scroll' : 'hold'; renderHandoff(); });
  $('hoKbBtn').addEventListener('click', function () {
    var tb = $('typeBox');
    try { tb.focus(); tb.scrollIntoView({ block: 'center' }); } catch (e) {}
  });

  // Keyboard: characters are batched into one "type" event; everything else becomes
  // a Playwright key name ("Enter", "ControlOrMeta+a", "Shift+Tab") — see qxKeyAction.
  var typeBuf = '', typeTimer = null;
  function flushType() { clearTimeout(typeTimer); typeTimer = null; if (typeBuf) { var s = typeBuf; typeBuf = ''; sendInput({ type: 'type', text: s }); } }
  screen.addEventListener('keydown', function (e) {
    if (!state.takeover) return;
    var a = qxKeyAction(e);
    if (!a || a.kind === 'paste') return; // paste: the 'paste' event below carries the text
    e.preventDefault();
    if (a.kind === 'text') {
      typeBuf += a.text;
      clearTimeout(typeTimer);
      // (flush long bursts early: the server takes at most 10000 characters per event)
      if (typeBuf.length >= 2000) flushType(); else typeTimer = setTimeout(flushType, 120);
      return;
    }
    flushType();
    sendInput({ type: 'key', key: a.key });
  });
  screen.addEventListener('paste', function (e) {
    if (!state.takeover) return;
    var text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!text) return;
    e.preventDefault();
    flushType();
    sendInput({ type: 'type', text: text.slice(0, 10000) });
  });

  $('urlForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = $('url').value.trim();
    if (!u || !state.takeover) return;
    sendInput({ type: 'navigate', url: u });
    screen.focus();
  });
  $('backBtn').addEventListener('click', function () { sendInput({ type: 'back' }); });
  $('fwdBtn').addEventListener('click', function () { sendInput({ type: 'forward' }); });
  $('reloadBtn').addEventListener('click', function () { sendInput({ type: 'reload' }); });
  function sendTypeBox(pressEnter) {
    var v = $('typeBox').value;
    if (v) { sendInput({ type: 'type', text: v }); $('typeBox').value = ''; }
    if (pressEnter) sendInput({ type: 'key', key: 'Enter' });
  }
  $('typeSend').addEventListener('click', function () { sendTypeBox(false); });
  $('enterBtn').addEventListener('click', function () { sendTypeBox(true); });
  $('typeBox').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendTypeBox(true); } });

  // ── approvals ───────────────────────────────────────────────────────────────
  function optLabel(o) { var k = 'opt_' + String(o).toLowerCase(); return has(k) ? t(k) : String(o); }
  function optClass(o) {
    if (/^(n|deny|reject|cancel|block|skip|stop)/i.test(o)) return 'btn no';
    if (/^(y|approve|allow|accept|confirm|always|continue)/i.test(o)) return 'btn ok';
    return 'btn';
  }
  function optionsOf(a) {
    if (Array.isArray(a.options)) return a.options.map(String);
    if (typeof a.options_json === 'string') { try { var o = JSON.parse(a.options_json); if (Array.isArray(o)) return o.map(String); } catch (e) {} }
    return ['yes', 'no'];
  }
  function approvalCard(a, isMission) {
    var risk = a.risk ? String(a.risk) : '';
    var card = el('div', 'card' + (risk ? ' r-' + risk : ''));
    var meta = el('div', 'meta');
    if (risk) meta.appendChild(el('span', 'badge r-' + risk, has('risk_' + risk) ? t('risk_' + risk) : risk));
    if (a.category) meta.appendChild(el('span', 'badge', has('cat_' + a.category) ? t('cat_' + a.category) : String(a.category)));
    if (isMission) meta.appendChild(el('span', 'badge mission', t('missionBadge') + (a.missionId || a.mission_id ? ' ' + clip(a.missionId || a.mission_id, 14) : '')));
    if (a.source) meta.appendChild(el('span', '', t('from') + ' ' + clip(a.source, 60)));
    var ts = a.createdAt || a.created_at;
    if (ts) meta.appendChild(el('time', '', hhmmss(typeof ts === 'number' ? ts : Date.parse(ts))));
    card.appendChild(meta);
    // Auto mode is on but this still needs a person: say why (remote delete, outside the project, critical…).
    var autoWhy = a.meta && typeof a.meta.autoMode === 'string' ? a.meta.autoMode : '';
    if (autoWhy) card.appendChild(autoDir(el('div', 'why', '⚡ ' + t('autoAsks') + ': ' + clip(autoWhy, 400))));
    card.appendChild(autoDir(el('div', 'prompt', clip(a.prompt, 4000))));
    var opts = el('div', 'opts'), msg = el('div', 'msg');
    optionsOf(a).forEach(function (o) {
      var b = el('button', optClass(o), optLabel(o));
      b.type = 'button';
      b.addEventListener('click', function () {
        var all = opts.querySelectorAll('button');
        for (var i = 0; i < all.length; i++) all[i].disabled = true;
        var req = isMission
          ? api('POST', '/api/actions/missions.resolveApproval', { id: a.id, answer: o, by: 'control' })
          : api('POST', '/api/approvals/' + encodeURIComponent(a.id), { answer: o });
        req.then(function () {
          if (isMission) delete state.missionApprovals[String(a.id)]; else delete state.approvals[a.id];
          renderApprovals();
        }).catch(function (e) {
          msg.textContent = errText(e); msg.classList.add('err');
          // 404 = gone, 409 = answered elsewhere meanwhile: drop the card (from the right list).
          if (e && (e.status === 404 || e.status === 409)) {
            if (isMission) delete state.missionApprovals[String(a.id)]; else delete state.approvals[a.id];
            setTimeout(renderApprovals, 1500);
            return;
          }
          for (var j = 0; j < all.length; j++) all[j].disabled = false;
        });
      });
      opts.appendChild(b);
    });
    var hid = !isMission && a.meta && a.meta.handoff && typeof a.meta.handoff.id === 'string' ? a.meta.handoff.id : '';
    if (hid && HO_ID_RE.test(hid) && !(HO && HO.id === hid)) {
      var ob = el('button', 'btn primary', t('hoOpen'));
      ob.type = 'button';
      ob.addEventListener('click', function () { openHandoff(hid); });
      opts.appendChild(ob);
    }
    card.appendChild(opts);
    card.appendChild(msg);
    return card;
  }
  function renderApprovals() {
    var list = $('approvalList');
    list.textContent = '';
    var items = Object.keys(state.approvals).map(function (k) { return state.approvals[k]; });
    items.sort(function (x, y) { return (x.createdAt || 0) - (y.createdAt || 0); });
    items.forEach(function (a) { list.appendChild(approvalCard(a, false)); });
    Object.keys(state.missionApprovals).forEach(function (k) {
      if (!state.approvals[k]) list.appendChild(approvalCard(state.missionApprovals[k], true));
    });
    if (!list.firstChild) list.appendChild(el('div', 'empty', t('noApprovals')));
    updateTitle();
  }

  // ── steer ───────────────────────────────────────────────────────────────────
  function steerMsg(text, isErr) { var m = $('steerMsg'); m.textContent = text || ''; m.classList.toggle('err', !!isErr); }
  function sendSteer() {
    var note = $('steerText').value.trim();
    if (!note) return;
    var btn = $('steerBtn'); btn.disabled = true;
    api('POST', '/api/steer', { note: note }).then(function () {
      $('steerText').value = ''; steerMsg(t('steerSent'));
    }).catch(function (e) {
      steerMsg(e && e.status === 409 ? t('noAgent') : errText(e), true);
    }).then(function () { btn.disabled = false; });
  }
  $('steerBtn').addEventListener('click', sendSteer);

  // ── emergency stop ──────────────────────────────────────────────────────────
  $('stopBtn').addEventListener('click', function () {
    if (!window.confirm(t('confirmStop'))) return;
    var btn = $('stopBtn'); btn.disabled = true;
    api('POST', '/api/stop', { all: true }).then(function (r) {
      var stopped = (r && r.stopped) || [];
      steerMsg(stopped.length ? t('stopDone') + ': ' + stopped.join('; ') : t('stopNothing'));
    }).catch(function (e) { steerMsg(errText(e), true); }).then(function () { btn.disabled = false; });
  });
  $('steerText').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendSteer(); } });

  // ── missions ────────────────────────────────────────────────────────────────
  function hasAction(n) { return state.actions.indexOf(n) >= 0; }
  function missionsFrom(r) {
    if (Array.isArray(r)) return r;
    if (r && Array.isArray(r.missions)) return r.missions;
    return [];
  }
  function renderMissions() {
    var panel = $('missionsPanel');
    if (!hasAction('missions.list')) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    var list = $('missionList');
    list.textContent = '';
    var ms = state.missions || [];
    ms.forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      var row = el('div', 'mission'), body = el('div', 'body');
      body.appendChild(autoDir(el('div', 'goal', clip(m.goal || m.title || m.id, 240))));
      var sub = el('div', 'sub');
      var st = String(m.status || '');
      if (st) sub.appendChild(el('span', 'st-' + st, has('st_' + st) ? t('st_' + st) : st));
      if (m.id) sub.appendChild(el('span', '', clip(m.id, 24)));
      var steps = m.steps;
      if (Array.isArray(steps) && steps.length) {
        var done = steps.filter(function (s) { return s && (s.status === 'done' || s.status === 'skipped'); }).length;
        sub.appendChild(el('span', '', done + '/' + steps.length));
      } else if (typeof m.progress === 'number') {
        sub.appendChild(el('span', '', Math.round(m.progress <= 1 ? m.progress * 100 : m.progress) + '%'));
      } else if (m.progress) {
        sub.appendChild(el('span', '', clip(m.progress, 40)));
      }
      var upd = m.updatedAt || m.updated_at;
      if (upd) sub.appendChild(el('time', '', hhmmss(typeof upd === 'number' ? upd : Date.parse(upd))));
      body.appendChild(sub);
      row.appendChild(body);
      var acts = el('div', 'acts');
      var live = m.liveUrl || m.live_url;
      if (isHttp(live)) {
        var a = el('a', 'btn', t('open'));
        a.href = live; a.target = '_blank'; a.rel = 'noopener noreferrer';
        acts.appendChild(a);
      }
      if (hasAction('missions.cancel') && /^(planning|running|paused|awaiting_approval)$/.test(st)) {
        var c = el('button', 'btn no', t('cancel'));
        c.type = 'button';
        c.addEventListener('click', function () {
          if (!window.confirm(t('confirmCancel'))) return;
          c.disabled = true;
          api('POST', '/api/actions/missions.cancel', { id: m.id }).then(refreshMissions).catch(function (e) { c.disabled = false; window.alert(errText(e)); });
        });
        acts.appendChild(c);
      }
      row.appendChild(acts);
      list.appendChild(row);
    });
    if (!list.firstChild) list.appendChild(el('div', 'empty', t('noMissions')));
  }
  var missionsTimer = null;
  function refreshMissions() {
    // The missions integration went away: its approval cards can't be answered any more.
    if (!hasAction('missions.approvals') && Object.keys(state.missionApprovals).length) { state.missionApprovals = {}; renderApprovals(); }
    if (!hasAction('missions.list')) { renderMissions(); return Promise.resolve(); }
    var p1 = api('POST', '/api/actions/missions.list', { limit: 20 }).then(function (j) { state.missions = missionsFrom(j.result); renderMissions(); }).catch(function () {});
    var p2 = !hasAction('missions.approvals') ? Promise.resolve() : api('POST', '/api/actions/missions.approvals', {}).then(function (j) {
      var next = {};
      (Array.isArray(j.result) ? j.result : []).forEach(function (a) { if (a && a.id !== undefined && a.id !== null) next[String(a.id)] = a; });
      state.missionApprovals = next; renderApprovals();
    }).catch(function () {});
    return Promise.all([p1, p2]);
  }
  function scheduleMissions() { clearTimeout(missionsTimer); missionsTimer = setTimeout(refreshMissions, 400); }

  // ── activity ────────────────────────────────────────────────────────────────
  var FIELDS = ['title', 'summary', 'message', 'goal', 'tool', 'decision', 'category', 'status', 'url', 'note', 'text', 'error', 'reason'];
  function summarize(d) {
    if (d === undefined || d === null) return '';
    if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') return clip(d, 200);
    if (typeof d !== 'object') return '';
    var out = [];
    for (var i = 0; i < FIELDS.length && out.length < 3; i++) {
      var v = d[FIELDS[i]];
      if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') out.push(clip(v, 140));
    }
    return out.join(' · ');
  }
  function describe(ev) {
    var s;
    switch (ev.kind) {
      case 'approval.requested': return { chip: t('k_approval'), cls: 'k-approval', text: clip(ev.prompt, 240) };
      case 'approval.resolved': return { chip: t('k_approval'), cls: 'k-approval', text: t('answered') + ': ' + ev.answer + ' (' + t('by') + ' ' + ev.by + ')' };
      case 'mission': s = summarize(ev.data); return { chip: t('k_mission'), cls: 'k-mission', text: clip(ev.missionId, 16) + ' · ' + ev.type + (s ? ' · ' + s : '') };
      case 'browser': s = summarize(ev.data); return { chip: t('k_browser'), cls: 'k-browser', text: ev.type + (s ? ' · ' + s : '') };
      case 'sentinel': s = summarize(ev.data); return { chip: t('k_sentinel'), cls: 'k-sentinel', text: ev.type + (s ? ' · ' + s : '') };
      case 'notice': return { chip: t('k_notice'), cls: 'k-' + (ev.level || 'info'), text: clip(ev.message, 400) };
      case 'agent': s = summarize(ev.data); return { chip: ev.source ? clip(ev.source, 20) : t('k_agent'), cls: 'k-agent', text: ev.type + (s ? ' · ' + s : '') };
      default: return { chip: String(ev.kind || '?'), cls: '', text: ev.truncated ? clip(ev.preview, 200) : summarize(ev.data) };
    }
  }
  var activityTimer = null;
  function pushActivity(ev) {
    state.activity.push(ev);
    if (state.activity.length > 300) state.activity.splice(0, state.activity.length - 300);
    if (!activityTimer) activityTimer = setTimeout(function () { activityTimer = null; renderActivity(); }, 150);
  }
  function renderActivity() {
    var list = $('activityList');
    list.textContent = '';
    var frag = document.createDocumentFragment();
    for (var i = state.activity.length - 1, n = 0; i >= 0 && n < 200; i--, n++) {
      var ev = state.activity[i], d = describe(ev), li = el('li');
      li.appendChild(el('time', '', hhmmss(ev.ts)));
      li.appendChild(el('span', 'chip ' + d.cls, d.chip));
      li.appendChild(autoDir(el('span', 'txt', d.text)));
      frag.appendChild(li);
    }
    list.appendChild(frag);
    $('activityEmpty').classList.toggle('hidden', state.activity.length > 0);
  }
  function onBus(ev) {
    if (!ev || typeof ev !== 'object') return;
    pushActivity(ev);
    if (ev.kind === 'browser') {
      var d = ev.data && typeof ev.data === 'object' ? ev.data : {};
      if (ev.type === 'takeover') {
        var on = d.on !== undefined ? d.on : (d.takeover !== undefined ? d.takeover : d.active);
        if (typeof on === 'boolean') { state.takeover = on; if (state.browser) state.browser.takeover = on; renderTakeover(); }
      } else if (ev.type === 'navigated' && typeof d.url === 'string') {
        // Every tab reports its navigations: only the ACTIVE tab drives the URL bar.
        var act = activeTab(state.browser);
        if (!(act && act.id && d.tab && d.tab !== act.id)) {
          // Bus copies are secret-masked: a masked URL must not land in the URL bar;
          // the authoritative /api/state snapshot carries the real one.
          if (d.url.indexOf('***') >= 0) scheduleState();
          else {
            if (act) act.url = d.url;
            if (document.activeElement !== $('url')) $('url').value = d.url;
          }
        }
      }
      if (ev.type === 'launched' || ev.type === 'closed' || ev.type === 'tab') scheduleState();
    } else if (ev.kind === 'mission') {
      scheduleMissions();
    }
  }

  // ── event stream ────────────────────────────────────────────────────────────
  var eventsES = null, eventsRetry = null, backoff = 1000;
  function connectEvents() {
    if (eventsES) return;
    var es = new EventSource('/api/events');
    eventsES = es;
    es.addEventListener('hello', function (e) {
      var d = {}; try { d = JSON.parse(e.data); } catch (x) {}
      state.connected = true; backoff = 1000; setAuthLost(false);
      state.activity = [];
      state.actions = Array.isArray(d.actions) ? d.actions : [];
      if (d.browser !== undefined) setBrowser(d.browser);
      renderConn(); renderActivity(); renderMissions(); refreshMissions();
    });
    es.addEventListener('approvals', function (e) {
      var list = []; try { list = JSON.parse(e.data); } catch (x) {}
      state.approvals = {};
      (Array.isArray(list) ? list : []).forEach(function (a) { if (a && a.id) state.approvals[a.id] = a; });
      renderApprovals();
    });
    es.addEventListener('approval', function (e) {
      var a; try { a = JSON.parse(e.data); } catch (x) { return; }
      if (!a || !a.id) return;
      state.approvals[a.id] = a; renderApprovals();
      if (HO) scheduleState();
      try { if (navigator.vibrate) navigator.vibrate(150); } catch (x) {}
    });
    es.addEventListener('approval-retract', function (e) {
      var d; try { d = JSON.parse(e.data); } catch (x) { return; }
      if (d && d.id) { delete state.approvals[d.id]; renderApprovals(); if (HO) scheduleState(); }
    });
    es.addEventListener('actions', function (e) {
      var d = {}; try { d = JSON.parse(e.data); } catch (x) {}
      state.actions = Array.isArray(d.actions) ? d.actions : [];
      renderMissions(); refreshMissions();
    });
    es.addEventListener('bus', function (e) { var ev; try { ev = JSON.parse(e.data); } catch (x) { return; } onBus(ev); });
    es.onerror = function () {
      state.connected = false; renderConn();
      if (es.readyState === 2) {
        if (eventsES === es) eventsES = null;
        refreshState();
        clearTimeout(eventsRetry);
        eventsRetry = setTimeout(connectEvents, backoff);
        backoff = Math.min(15000, backoff * 2);
      }
    };
  }

  // ── periodic state refresh (authoritative snapshot) ─────────────────────────
  var stateTimer = null;
  function refreshState() {
    if (HO && HO.scoped && ho.ended) return Promise.resolve();
    return api('GET', '/api/state?recent=0' + (HO ? '&handoff=' + encodeURIComponent(HO.id) : '')).then(function (j) {
      setAuthLost(false);
      setBrowser(j.browser);
      if (HO && j.handoff) { ho.info = j.handoff; renderHandoff(); }
      var next = {};
      (Array.isArray(j.approvals) ? j.approvals : []).forEach(function (a) { if (a && a.id) next[a.id] = a; });
      state.approvals = next; renderApprovals();
      var acts = Array.isArray(j.actions) ? j.actions : [];
      var changed = acts.join(',') !== state.actions.join(',');
      state.actions = acts;
      if (j.missions !== undefined) { state.missions = missionsFrom(j.missions); renderMissions(); }
      else if (changed) { renderMissions(); refreshMissions(); }
    }).catch(function () {});
  }
  function scheduleState() { clearTimeout(stateTimer); stateTimer = setTimeout(refreshState, 300); }

  applyLang();
  if (HO) enterHandoff();
  // A hand-off link sees only the live view of its hand-off (no event stream).
  if (!(HO && HO.scoped)) connectEvents();
  openFrames();
  refreshState();
  setInterval(function () { if (!document.hidden) { refreshState(); if (hasAction('missions.approvals')) refreshMissions(); } }, 5000);
  setInterval(function () { if (HO && !ho.ended && !document.hidden) refreshState(); }, 1500);
})();
`;

/**
 * CSP source allowing exactly the dashboard's one executable inline script (its
 * sha256), so the server can drop 'unsafe-inline' for scripts: even if some text
 * ever slipped into the page as HTML, it could not run. The boot JSON block is a
 * data block (type="application/json") and is never executed.
 */
export const DASHBOARD_SCRIPT_CSP_SOURCE = `'sha256-${createHash('sha256').update(SCRIPT, 'utf8').digest('base64')}'`;

/**
 * Render the dashboard. The returned string is a complete HTML document; it embeds
 * the strings of BOTH languages so the viewer can switch without a reload.
 */
export function renderDashboard(opts: DashboardOptions = {}): string {
  const lang: DashboardLang = opts.lang === 'fa' ? 'fa' : 'en';
  const S = DASHBOARD_STRINGS[lang];
  const customTitle = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim().slice(0, 120) : '';
  const title = customTitle || S.title;
  const tx = (k: string) => escapeHtml(S[k] ?? DASHBOARD_STRINGS.en[k] ?? k);
  const ho = opts.handoff && typeof opts.handoff.id === 'string' && HANDOFF_BOOT_ID_RE.test(opts.handoff.id)
    ? { id: opts.handoff.id, scoped: !!opts.handoff.scoped }
    : null;
  const boot = { lang, title: customTitle || null, strings: DASHBOARD_STRINGS, handoff: ho };

  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'fa' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0f14">
<link rel="icon" href="data:,">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <span id="connDot" class="dot" aria-hidden="true"></span>
  <h1 id="appTitle">${escapeHtml(title)}</h1>
  <span id="approvalCount" class="badge count hidden" title="${tx('approvals')}">0</span>
  <span id="connText" class="conn">${tx('disconnected')}</span>
  <button id="stopBtn" class="btn danger" type="button" data-i18n="stopAll">${tx('stopAll')}</button>
  <button id="langBtn" class="btn" type="button">${lang === 'fa' ? 'English' : 'فارسی'}</button>
</header>
<div id="authBanner" class="banner" role="alert" data-i18n="authLost">${tx('authLost')}</div>
<main>
  <section id="livePanel" class="panel">
    <h2><span data-i18n="live">${tx('live')}</span><span id="browserInfo" class="badge"></span></h2>
    <div id="handoffBar" class="hobar hidden" role="region" aria-live="polite">
      <div id="hoTitle" class="hotitle" data-i18n="hoBanner">${tx('hoBanner')}</div>
      <div id="hoInfo" class="hoinfo" dir="auto"></div>
      <div class="hosub" data-i18n="hoSub">${tx('hoSub')}</div>
      <div id="hoStatus" class="hostatus" role="status"></div>
      <div class="opts">
        <button id="hoDoneBtn" class="btn ok big" type="button" data-i18n="hoDone">${tx('hoDone')}</button>
        <button id="hoCantBtn" class="btn no big" type="button" data-i18n="hoCant">${tx('hoCant')}</button>
        <button id="hoZoomBtn" class="btn" type="button">${tx('hoZoomOut')}</button>
        <button id="hoModeBtn" class="btn" type="button">${tx('hoModeHold')}</button>
        <button id="hoKbBtn" class="btn" type="button" data-i18n="hoKeyboard">${tx('hoKeyboard')}</button>
      </div>
      <div id="hoNote" class="hoinfo hidden" data-i18n="hoScopedNote">${tx('hoScopedNote')}</div>
    </div>
    <div class="toolbar">
      <button id="backBtn" class="btn icon" type="button" data-i18n-title="back" title="${tx('back')}" aria-label="${tx('back')}" disabled>&#8592;</button>
      <button id="fwdBtn" class="btn icon" type="button" data-i18n-title="forward" title="${tx('forward')}" aria-label="${tx('forward')}" disabled>&#8594;</button>
      <button id="reloadBtn" class="btn icon" type="button" data-i18n-title="reload" title="${tx('reload')}" aria-label="${tx('reload')}" disabled>&#8635;</button>
      <form id="urlForm" autocomplete="off">
        <input id="url" type="text" inputmode="url" spellcheck="false" data-i18n-ph="urlPh" placeholder="${tx('urlPh')}" disabled>
        <button id="goBtn" class="btn" type="submit" data-i18n="go" disabled>${tx('go')}</button>
      </form>
      <button id="takeBtn" class="btn primary" type="button">${tx('takeOver')}</button>
    </div>
    <p class="status"><span id="who" class="who">${tx('agentInControl')}</span></p>
    <div id="screen" tabindex="0" aria-label="${tx('live')}">
      <img id="frame" class="hidden" alt="">
      <div id="overlay"><div class="big" aria-hidden="true">&#128421;</div><div id="overlayText">${tx('starting')}</div><div id="overlayHint"></div></div>
    </div>
    <div class="typebar">
      <input id="typeBox" type="text" data-i18n-ph="typePh" placeholder="${tx('typePh')}" disabled>
      <button id="typeSend" class="btn" type="button" data-i18n="send" disabled>${tx('send')}</button>
      <button id="enterBtn" class="btn" type="button" data-i18n="enter" disabled>${tx('enter')}</button>
    </div>
    <div id="liveMsg" class="msg" role="status"></div>
  </section>
  <div id="side">
  <section id="approvalsPanel" class="panel">
    <h2 data-i18n="approvals">${tx('approvals')}</h2>
    <div id="approvalList"><div class="empty">${tx('noApprovals')}</div></div>
  </section>
  <section id="steerPanel" class="panel">
    <h2 data-i18n="steer">${tx('steer')}</h2>
    <textarea id="steerText" maxlength="4000" data-i18n-ph="steerPh" placeholder="${tx('steerPh')}"></textarea>
    <div class="row"><span id="steerMsg" class="msg" role="status"></span><button id="steerBtn" class="btn primary" type="button" data-i18n="send">${tx('send')}</button></div>
  </section>
  <section id="missionsPanel" class="panel hidden">
    <h2 data-i18n="missions">${tx('missions')}</h2>
    <div id="missionList"></div>
  </section>
  </div>
  <section id="activityPanel" class="panel">
    <h2 data-i18n="activity">${tx('activity')}</h2>
    <div id="activityEmpty" class="empty" data-i18n="noActivity">${tx('noActivity')}</div>
    <ul id="activityList"></ul>
  </section>
</main>
<footer data-i18n="warnShare">${tx('warnShare')}</footer>
<script id="qx-boot" type="application/json">${scriptJson(boot)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
