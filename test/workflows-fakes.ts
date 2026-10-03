/**
 * Test doubles for the workflow suites: a tiny fake DOM (elements with role /
 * name / text / label / selectors), a Playwright-like Page + Locator over it, and
 * a BrowserManager that records every call. Not a test file itself (no
 * `.test.ts` suffix) — imported by test/workflows-*.test.ts.
 */

import type {
  BrowserActionRecord,
  BrowserManager,
  BrowserStatus,
  ElementInfo,
  HumanInputEvent,
  LaunchOverrides,
  ScreencastFrame,
  TabInfo,
} from '../src/tools/browser/types.js';

export interface FakeEl {
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  selectors?: string[];
  visible?: boolean;
  value?: string;
  checked?: boolean;
  /** Called when the element is clicked (e.g. navigate). */
  onClick?: (page: FakePage) => void;
}

function match(actual: string | undefined, want: string, exact?: boolean): boolean {
  if (actual === undefined) return false;
  return exact ? actual === want : actual.toLowerCase().includes(want.toLowerCase());
}

export class FakeLocator {
  constructor(public page: FakePage, public els: FakeEl[], public _selector: string) {}
  async count(): Promise<number> { return this.els.length; }
  nth(i: number): FakeLocator { return new FakeLocator(this.page, this.els[i] ? [this.els[i]!] : [], `${this._selector} >> nth=${i}`); }
  first(): FakeLocator { return this.nth(0); }
  async isVisible(): Promise<boolean> { return !!this.els[0] && this.els[0].visible !== false; }
  private one(action: string): FakeEl {
    const el = this.els[0];
    if (!el) throw new Error(`locator.${action}: Timeout 100ms exceeded.\nCall log: waiting for ${this._selector}`);
    if (el.visible === false) throw new Error(`locator.${action}: element is not visible`);
    return el;
  }
  async click(opts: any = {}): Promise<void> {
    const el = this.one('click');
    this.page.log.push(`click ${el.name ?? el.text ?? el.tag}${opts?.clickCount === 2 ? ' x2' : ''}`);
    el.onClick?.(this.page);
  }
  async hover(): Promise<void> { const el = this.one('hover'); this.page.log.push(`hover ${el.name ?? el.tag}`); }
  async fill(v: string): Promise<void> { const el = this.one('fill'); el.value = v; this.page.log.push(`fill ${el.name ?? el.label ?? el.tag}=${v}`); }
  async pressSequentially(v: string): Promise<void> { const el = this.one('type'); el.value = (el.value ?? '') + v; this.page.log.push(`type ${el.name ?? el.tag}=${v}`); }
  async press(k: string): Promise<void> { const el = this.one('press'); this.page.log.push(`press ${k} on ${el.name ?? el.tag}`); if (k === 'Enter') el.onClick?.(this.page); }
  async selectOption(v: string[] | string): Promise<void> { const el = this.one('selectOption'); el.value = Array.isArray(v) ? v.join(',') : v; this.page.log.push(`select ${el.name ?? el.tag}=${el.value}`); }
  async setChecked(b: boolean): Promise<void> { const el = this.one('setChecked'); el.checked = b; this.page.log.push(`check ${el.name ?? el.tag}=${b}`); }
  async setInputFiles(p: string[]): Promise<void> { const el = this.one('setInputFiles'); this.page.log.push(`upload ${el.name ?? el.tag}=${p.length}`); }
  async scrollIntoViewIfNeeded(): Promise<void> { const el = this.one('scroll'); this.page.log.push(`scrollIntoView ${el.name ?? el.tag}`); }
  async innerText(): Promise<string> { return this.one('innerText').text ?? ''; }
  async waitFor(): Promise<void> { this.one('waitFor'); }
  async evaluate(fn: (el: any) => unknown): Promise<unknown> {
    const el = this.one('evaluate');
    return fn({ tagName: el.tag.toUpperCase(), type: el.type ?? '' });
  }
}

export class FakePage {
  log: string[] = [];
  currentUrl = 'about:blank';
  pageTitle = 'Fake';
  bodyText = '';
  constructor(public els: FakeEl[] = []) {}
  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return this.pageTitle; }
  async goto(url: string): Promise<void> { this.log.push(`goto ${url}`); this.currentUrl = url; }
  async goBack(): Promise<void> { this.log.push('back'); }
  async goForward(): Promise<void> { this.log.push('forward'); }
  async reload(): Promise<void> { this.log.push('reload'); }
  async waitForLoadState(): Promise<void> {}
  async evaluate(expr: unknown): Promise<unknown> { return typeof expr === 'string' && expr.includes('innerText') ? this.bodyText : undefined; }
  async waitForEvent(): Promise<any> { return { setFiles: async (p: string[]) => { this.log.push(`chooser ${p.length}`); } }; }
  keyboard = {
    press: async (k: string) => { this.log.push(`key ${k}`); },
    type: async (t: string) => { this.log.push(`keyboard ${t}`); },
  };
  mouse = { wheel: async (dx: number, dy: number) => { this.log.push(`wheel ${dx},${dy}`); } };
  getByRole(role: string, opts: { name?: string; exact?: boolean } = {}): FakeLocator {
    return new FakeLocator(this, this.els.filter(e => e.role === role && (opts.name === undefined || match(e.name, opts.name, opts.exact))), `role=${role}[${opts.name ?? ''}]`);
  }
  getByText(t: string, opts: { exact?: boolean } = {}): FakeLocator {
    return new FakeLocator(this, this.els.filter(e => match(e.text ?? e.name, t, opts.exact)), `text=${t}`);
  }
  getByLabel(t: string, opts: { exact?: boolean } = {}): FakeLocator {
    return new FakeLocator(this, this.els.filter(e => match(e.label, t, opts.exact)), `label=${t}`);
  }
  locator(selector: string): FakeLocator {
    return new FakeLocator(this, this.els.filter(e => (e.selectors ?? []).includes(selector)), selector);
  }
}

export class FakeManager implements BrowserManager {
  page: FakePage;
  running = true;
  takeover = false;
  actions: BrowserActionRecord[] = [];
  listeners = new Set<(r: BrowserActionRecord) => void>();
  refs = new Map<string, ElementInfo>();
  tabList: TabInfo[] = [{ index: 0, id: 't0', url: 'about:blank', title: '', active: true }];
  calls: string[] = [];
  private takeoverWaiters: Array<() => void> = [];
  ctx: any = null;

  constructor(page = new FakePage()) {
    this.page = page;
  }
  async ensure(_o?: LaunchOverrides): Promise<void> { this.running = true; this.calls.push('ensure'); }
  isRunning(): boolean { return this.running; }
  status(): BrowserStatus {
    return { running: this.running, mode: 'launch', headless: true, profile: 'test', tabs: this.tabList, takeover: this.takeover, downloadsDir: '/tmp' };
  }
  async activePage(): Promise<any> { this.running = true; return this.page; }
  context(): any { return this.ctx; }
  tabs(): TabInfo[] { return this.tabList; }
  async newTab(url?: string): Promise<TabInfo> {
    this.calls.push(`newTab ${url ?? ''}`);
    const t = { index: this.tabList.length, id: `t${this.tabList.length}`, url: url ?? 'about:blank', title: '', active: true };
    this.tabList.push(t);
    if (url) this.page.currentUrl = url;
    return t;
  }
  async switchTab(index: number): Promise<TabInfo> { this.calls.push(`switchTab ${index}`); return this.tabList[index] ?? this.tabList[0]!; }
  async closeTab(index?: number): Promise<void> { this.calls.push(`closeTab ${index ?? ''}`); }
  async close(): Promise<void> { this.running = false; this.calls.push('close'); }
  async restart(o?: LaunchOverrides): Promise<void> { this.calls.push(`restart ${JSON.stringify(o ?? {})}`); this.running = true; }
  async startScreencast(_f: (f: ScreencastFrame) => void): Promise<() => Promise<void>> { return async () => {}; }
  async screenshotJpeg(): Promise<Buffer> { return Buffer.alloc(0); }
  setTakeover(on: boolean): void {
    this.takeover = on;
    if (!on) for (const w of this.takeoverWaiters.splice(0)) w();
  }
  isTakeover(): boolean { return this.takeover; }
  waitForTakeoverEnd(signal?: AbortSignal): Promise<void> {
    if (!this.takeover) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.takeoverWaiters.push(resolve);
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
  async dispatchInput(_ev: HumanInputEvent): Promise<void> {}
  async locator(t: { ref?: string; selector?: string }): Promise<any> {
    if (t.ref) throw new Error(`[STALE_REF] ref ${t.ref} not found — call browser_snapshot again`);
    return this.page.locator(t.selector ?? '');
  }
  activeUrl(): string { return this.running ? this.page.currentUrl : ''; }
  async describeRef(ref: string): Promise<ElementInfo | null> { return this.refs.get(ref) ?? null; }
  async describeSelector(_s: string): Promise<ElementInfo | null> { return null; }
  onAction(listener: (rec: BrowserActionRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  recordAction(rec: Omit<BrowserActionRecord, 'ts'> & { ts?: number }): void {
    const full = { ...rec, ts: rec.ts ?? Date.now() } as BrowserActionRecord;
    this.actions.push(full);
    for (const l of this.listeners) l(full);
  }
}
