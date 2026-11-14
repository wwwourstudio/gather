/**
 * gather UI audit. It looks and records; it never changes app code.
 *
 *   node server.js &                         # or set GATHER_URL to a deployment
 *   node scripts/audit.ts                    # Node 22.18+ runs TypeScript directly
 *   tsc -p scripts --noEmit                  # strict typecheck (needs `npm i -D playwright typescript`)
 *
 * For each width (1440, 1024, 390) it signs up a throwaway host account, creates a studio and:
 *   - opens every rail panel, dialog, menu and dock tool, and clicks every interactive element in
 *     them (destructive actions such as "delete account" and "leave studio" are listed, not clicked)
 *   - answers file pickers with fixtures (PDF, MP4, PNG) so every upload path runs
 *   - records console errors, page errors, failed requests and HTTP 4xx/5xx
 *   - flags dead controls (a click that changes nothing: no DOM change, no state, no request, no dialog)
 *   - detects overlap by comparing the boxes of visible in-flow siblings in the same container,
 *     plus horizontal overflow, controls pushed off-screen, clipped text and small tap targets
 *   - screenshots every state into audit/screens/auto/<width>/
 * At 1440 it also runs functional checks: AI image maker, AI chat, AI voice, the AI producer,
 * video upload, PDF presenting, hiding the QR card, banner editing, the editor-only layer and the
 * guest view.
 * Output: AUDIT.md (table + missing features) and audit/findings.json.
 */
type Browser = import('playwright').Browser;
type BrowserContext = import('playwright').BrowserContext;
type Page = import('playwright').Page;
type Locator = import('playwright').Locator;
type FileChooser = import('playwright').FileChooser;

const { chromium } = require('playwright') as typeof import('playwright');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');

type Severity = 'P0' | 'P1' | 'P2';
interface Finding { area: string; issue: string; severity: Severity; fix: string; widths: number[]; evidence: string[] }
interface LayoutHit { kind: 'overlap' | 'overflow' | 'offscreen' | 'clipped' | 'tap' | 'hiddenfocus' | 'adhoc'; where: string; detail: string }
interface StageElement { type: string; id: string }
interface GatherState {
  studio: string | null; id: string | null; deck: string; lobby: unknown[]; aiStatus: string;
  state: { elements: StageElement[]; banner: { text: string; sub: string } | null; scene: string; layout: string; stage: string[]; ticker?: string; featured?: unknown; captions?: { on: boolean }; brand: Record<string, unknown> };
  local: { pres: { kind: string; page?: number } | null };
  ai: { items: { role: string; text: string; error?: boolean; done?: boolean }[] };
}
type GatherWindow = Window & { __gather: GatherState; __auditMut: number; __auditSpeak: string[] };

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.GATHER_URL || 'http://localhost:8080').replace(/\/$/, '');
const ALL_WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 768], [390, 844]];
/** AUDIT_WIDTHS=1440,390 limits the run (the feature checks run only at 1440). */
const WIDTHS = process.env.AUDIT_WIDTHS ? ALL_WIDTHS.filter(([w]) => process.env.AUDIT_WIDTHS?.split(',').includes(String(w))) : ALL_WIDTHS;
const SHOTS = path.join(ROOT, 'audit', 'screens', 'auto');
const FIX = path.join(__dirname, 'fixtures');
const PDF = path.join(FIX, 'deck.pdf'), MP4 = path.join(FIX, 'clip.mp4'), PNG = path.join(FIX, 'logo.png');

/** Never clicked: they end the session, destroy data, or leave the page. Listed in the report instead. */
const SKIP = /delete (my )?account|sign out|log ?out|leave studio|remove from studio|cancel stream|end stream|^delete$|^✕$/i;
const SKIP_IDS = new Set(['leaveBtn', 'acDelete', 'acLogout', 'acOut']);
/** Third-party hosts that the sandbox or a browser may block; noted as P2 environment issues, not app bugs. */
const EXTERNAL = /irc-ws\.chat\.twitch\.tv|fonts\.(googleapis|gstatic)\.com|api\.(anthropic|openai)\.com|generativelanguage|api\.x\.ai/;

/** Root causes confirmed by hand while triaging earlier runs: a matching finding gets this fix (and severity) instead of the generic one. */
const KNOWN: Array<{ match: RegExp; fix: string; severity?: Severity }> = [
  { match: /reading 'replace'/, fix: 'renderProps → elName(): ELABEL has no entry for the new “callin” element, so selecting a call-in card in Layouts throws and the properties panel stops rendering. Add ELABEL.callin = "Call-in card" and fall back to e.type.', severity: 'P0' },
  { match: /same canvas during multiple render/, fix: 'pdf.js: pres.go() starts a new render while the previous page is still drawing (fast Next/arrow presses). Keep the RenderTask, cancel() it (or await it) before rendering the next page.', severity: 'P1' },
  { match: /#presentMenu|Present menu/, fix: 'At ≤900px .dock-tools has overflow-x:auto, which clips the absolutely positioned Present menu, and the rail sits on top. Move #presentMenu out of .dock-tools (portal to body / position: fixed above the dock) with z-index over .rail.', severity: 'P0' },
  { match: /crew-thumb × .*crew-info/, fix: 'Deck people cards: the card is taller than the 112px deck row allows, so the grid squeezes and the name rides up under the thumbnail. Give .deck-body ~124px, or drop .crew-sub on deck cards, or shrink the thumbnail to aspect 16/8.' },
  { match: /h3\.sec × ul#helpPopular/, fix: 'Help: .sec heading has negative/zero bottom margin against the list; add margin-bottom: 8px to #helpPopWrap h3.sec.' },
  { match: /aria-hidden layer/, fix: 'Deck layers that slide away keep their buttons in the tab order. Set the inert attribute on .deck-layer:not(.on) in setDeck().' },
];
const findings = new Map<string, Finding>();
function add(area: string, issue: string, severity: Severity, fix: string, width: number, evidence = ''): void {
  const known = KNOWN.find((k) => k.match.test(`${issue} ${evidence}`));
  if (known) { fix = known.fix; severity = known.severity ?? severity; }
  const key = `${area}|${issue}`;
  const f = findings.get(key) ?? { area, issue, severity, fix, widths: [], evidence: [] };
  if (!f.widths.includes(width)) f.widths.push(width);
  if (evidence && f.evidence.length < 4 && !f.evidence.includes(evidence)) f.evidence.push(evidence);
  if (severity < f.severity) f.severity = severity; // 'P0' < 'P1'
  findings.set(key, f);
}
const passes: string[] = [];
const missing = new Map<string, string>();

// ------------------------------------------------------------------ page instrumentation
function instrument(): void {
  // Counts DOM changes, ignoring the level meters that move every frame.
  const w = window as unknown as GatherWindow;
  w.__auditMut = 0; w.__auditSpeak = [];
  const quiet = (n: Node | null): boolean => { const el = n instanceof Element ? n : n?.parentElement; return !!el?.closest('#meterFill, #pMeter, #presTime, #presSeek, .toasts, #stageMeta'); };
  new MutationObserver((list) => { for (const m of list) if (!quiet(m.target)) w.__auditMut++; })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  if ('speechSynthesis' in window) {
    const orig = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (u: SpeechSynthesisUtterance) => { w.__auditSpeak.push(u.text); try { orig(u); } catch { /* headless */ } setTimeout(() => u.dispatchEvent(new Event('end')), 50); };
  }
}

interface Session { page: Page; ctx: BrowserContext; width: number; apiCalls: number; shotN: number }
function attach(page: Page, width: number, label: string): Session {
  const s: Session = { page, ctx: page.context(), width, apiCalls: 0, shotN: 0 };
  page.on('pageerror', (e) => add(`${label}: runtime`, `Uncaught error: ${e.message.slice(0, 140)}`, /\/vendor\//.test(e.stack || '') ? 'P1' : 'P0', 'Fix the throwing code path; an uncaught error stops the handlers that follow it.', width, (e.stack || '').split('\n')[1]?.trim() ?? ''));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (EXTERNAL.test(t)) add(`${label}: network`, 'Third-party connection blocked (Twitch chat socket or web fonts)', 'P2', 'Environment only: allow the host, or show a quiet "can’t reach Twitch" state, which the Stream tab already does.', width, t.slice(0, 120));
    else if (/^Failed to load resource/.test(t)) return; // the response hook rates each failing request with its URL
    else add(`${label}: console`, `Console error: ${t.slice(0, 140)}`, 'P1', 'Handle the failing case and show a readable message instead of logging an error.', width);
  });
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (EXTERNAL.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return;
    if (/action=(poll|leave)/.test(u) && /abort/i.test(r.failure()?.errorText ?? '')) return; // aborted on page close
    add(`${label}: network`, `Request failed: ${new URL(u).pathname}`, 'P1', 'Find why the request fails and retry or explain it in the UI.', width, r.failure()?.errorText ?? '');
  });
  page.on('request', (r) => { if (r.url().includes('/api/') && !/action=poll/.test(r.url())) s.apiCalls++; });
  page.on('response', async (r) => {
    const u = r.url(), st = r.status();
    if (st < 400 || EXTERNAL.test(u)) return;
    const p = new URL(u); const action = p.searchParams.get('action') || p.pathname;
    let body = ''; try { body = (await r.text()).slice(0, 160); } catch { /* gone */ }
    const expected = (action === 'me' && st === 401) || st === 423 || /api\/ai/.test(u); // signed-out probe, lock knock, AI with a test key
    if (expected) return;
    add(`${label}: API`, `${st} from ${p.pathname}?action=${action}`, st >= 500 ? 'P0' : 'P1', st >= 500 ? 'Server error: fix the handler and add a test.' : 'Client sent a request the server rejects; fix the caller or the validation.', width, body);
  });
  page.on('dialog', (d) => { void d.dismiss(); });
  page.on('popup', (p) => { void p.close(); });
  page.on('filechooser', (fc: FileChooser) => { void answerChooser(fc); });
  return s;
}
async function answerChooser(fc: FileChooser): Promise<void> {
  const accept = (await fc.element().getAttribute('accept')) ?? '';
  const file = accept.includes('pdf') && !accept.includes('video') ? PDF : accept.startsWith('video') ? MP4 : accept.includes('image') && !accept.includes('pdf') ? PNG : PDF;
  try { await fc.setFiles(fc.isMultiple() ? [file] : file); } catch { /* element went away */ }
}

const slug = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'state';
async function shot(s: Session, name: string): Promise<void> {
  const dir = path.join(SHOTS, String(s.width));
  fs.mkdirSync(dir, { recursive: true });
  s.shotN++;
  await s.page.screenshot({ path: path.join(dir, `${String(s.shotN).padStart(3, '0')}-${slug(name)}.jpg`), type: 'jpeg', quality: 62 }).catch(() => undefined);
}

// ------------------------------------------------------------------ layout checks (run in the page)
function layoutScan(): LayoutHit[] {
  const hits: LayoutHit[] = [];
  const name = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const where = (el: Element): string => { const p = el.parentElement; return p ? `${name(p)} > ${name(el)}` : name(el); };
  const shown = (el: Element): boolean => {
    if (!(el instanceof HTMLElement) || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1;
  };
  const inFlow = (el: Element): boolean => !['absolute', 'fixed', 'sticky'].includes(getComputedStyle(el).position);
  const vw = document.documentElement.clientWidth;
  // 1 overlap between visible in-flow siblings
  for (const parent of Array.from(document.querySelectorAll('body *'))) {
    if (parent.closest('svg, canvas, video, select') || !shown(parent)) continue;
    const kids = Array.from(parent.children).filter((k) => shown(k) && inFlow(k));
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 2 && iy > 2 && ix * iy > 40) hits.push({ kind: 'overlap', where: `${name(parent)}: ${name(kids[i])} × ${name(kids[j])}`, detail: `${Math.round(ix)}×${Math.round(iy)}px` });
    }
  }
  // 2 page wider than the viewport
  const sw = document.scrollingElement?.scrollWidth ?? 0;
  if (sw > vw + 1) hits.push({ kind: 'overflow', where: 'document', detail: `scrollWidth ${sw} > viewport ${vw}` });
  const clipsX = (el: Element): boolean => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true; } return false; };
  for (const el of Array.from(document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=switch], [role=tab]'))) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    // 3 a control hangs off the side of the screen (and nothing scrolls it into view)
    if ((r.right > vw + 1 || r.left < -1) && !clipsX(el)) hits.push({ kind: 'offscreen', where: where(el), detail: `x ${Math.round(r.left)}–${Math.round(r.right)} of ${vw}` });
    // 5 tap targets (only reported on the phone width)
    // the real hit area of a control inside a <label> is the label
    const hit = (el.closest('label') ?? el).getBoundingClientRect();
    if (vw < 500 && (hit.width < 24 || hit.height < 24) && !el.closest('p, li.msg')) hits.push({ kind: 'tap', where: where(el), detail: `${Math.round(hit.width)}×${Math.round(hit.height)}px` });
  }
  // 6 controls inside a layer marked aria-hidden (or faded out) that keyboard users can still tab to
  for (const layer of Array.from(document.querySelectorAll('[aria-hidden="true"]'))) {
    if (layer.closest('[inert]') || (layer as HTMLElement).inert) continue;
    const focusable = layer.querySelector('button:not([disabled]), a[href], input:not([disabled]), select, [tabindex]:not([tabindex="-1"])');
    if (focusable && (layer as HTMLElement).checkVisibility()) hits.push({ kind: 'hiddenfocus', where: name(layer), detail: `${layer.querySelectorAll('button, a[href], input, select').length} focusable controls` });
  }
  // 7 controls that aren't built from a design-system primitive (tokens.css + ui.css)
  const PRIMITIVE = '.btn, .icon-btn, .tile, .menu-item, .pill, .toggle, .input, .seg > *, .swatches > *, .bgs > *, .avatar-pick, .more > summary';
  for (const el of Array.from(document.querySelectorAll('button, select, input:not([type=hidden]):not([type=file]), textarea, summary'))) {
    if (!shown(el) || el.matches(PRIMITIVE) || el.closest('.fld, .composer-row, .plat-body, .dest-grid') || ['range', 'color'].includes((el as HTMLInputElement).type)) continue;
    hits.push({ kind: 'adhoc', where: where(el), detail: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) });
  }
  // 4 text cut off with no ellipsis
  for (const el of Array.from(document.querySelectorAll('button, label, span, b, h2, h3, p, .sc-name, .crew-name'))) {
    if (!shown(el) || !(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible' && cs.overflowX === 'visible') continue;
    if (el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && (el.textContent || '').trim()) hits.push({ kind: 'clipped', where: where(el), detail: `"${(el.textContent || '').trim().slice(0, 30)}" needs ${el.scrollWidth}px, has ${el.clientWidth}px` });
  }
  return hits;
}
const norm = (t: string): string => t.replace(/#card-[a-z0-9]+/g, '#card-*').replace(/#pres-[a-z0-9]+/g, '#pres-*').replace(/\.on-stage/g, '');
async function checkLayout(s: Session, state: string): Promise<void> {
  const hits = await s.page.evaluate(layoutScan).catch(() => [] as LayoutHit[]);
  for (const h of hits) {
    const where = norm(h.where), ev = `${state}: ${h.detail}`;
    if (h.kind === 'overlap') add('Layout', `Overlapping elements ${where}`, 'P1', 'Give the container room (gap / min-width / wrap) or make the overlay explicitly absolute.', s.width, ev);
    if (h.kind === 'overflow') add('Layout', `Page scrolls sideways (${state})`, 'P1', 'Find the widest child at this width and let it wrap or shrink (min-width: 0).', s.width, h.detail);
    if (h.kind === 'offscreen') add('Layout', `Control off-screen: ${where}`, 'P1', 'Wrap the row or move the control into an overflow menu at this width.', s.width, ev);
    if (h.kind === 'clipped') add('Layout', `Text cut off: ${where}`, 'P2', 'Allow wrapping, shorten the label, or add text-overflow: ellipsis with a title.', s.width, ev);
    if (h.kind === 'tap') add('Layout: phone', `Tap target under 24px: ${where}`, 'P2', 'Raise the hit area to 32px+ (padding or an ::after hit box) without changing the visual size.', s.width, h.detail);
    if (h.kind === 'adhoc') add('Design system', `Control not built from a primitive: ${where}`, 'P2', 'Use Button / IconButton / SegmentedControl / Toggle / Pill / Tile / Input from ui.css instead of one-off styles.', s.width, ev);
    if (h.kind === 'hiddenfocus') add('Accessibility', `Controls in an aria-hidden layer are still focusable: ${where}`, 'P2', 'Use inert on hidden layers.', s.width, `${state}: ${h.detail}`);
  }
}

// ------------------------------------------------------------------ the click sweep
async function fingerprint(s: Session): Promise<string> {
  return s.page.evaluate(() => {
    const w = window as unknown as GatherWindow;
    return JSON.stringify([w.__auditMut, w.__gather?.state, w.__gather?.local?.pres?.kind, document.querySelectorAll('dialog[open]').length, document.querySelectorAll('.toast').length, localStorage.length]);
  }).catch(() => '');
}
async function labelOf(el: Locator): Promise<string> {
  return el.evaluate((n: Element) => {
    const t = (n.getAttribute('aria-label') || n.textContent || n.getAttribute('title') || n.id || n.getAttribute('data-tab') || n.tagName).replace(/\s+/g, ' ').trim();
    return t.slice(0, 48);
  }).catch(() => '?');
}
async function closeTransient(s: Session, area: string, depth: number): Promise<void> {
  const p = s.page;
  for (let guard = 0; guard < 3; guard++) {
    const open = await p.locator('dialog[open]').count().catch(() => 0);
    const menu = await p.locator('#presentMenu:not([hidden])').count().catch(() => 0);
    if (!open && !menu) return;
    if (open && depth === 0) {
      const id = (await p.locator('dialog[open]').last().getAttribute('id')) ?? 'dialog';
      await p.waitForTimeout(400);
      await shot(s, `${area}-${id}`); await checkLayout(s, `${area} → ${id}`);
      await sweep(s, `dialog#${id}[open]`, `${area} → ${id}`, depth + 1);
    }
    await p.keyboard.press('Escape').catch(() => undefined);
    await p.waitForTimeout(150);
    if (await p.locator('dialog[open]').count().catch(() => 0)) await p.locator('dialog[open] .modal-close').last().click({ timeout: 800 }).catch(() => undefined);
  }
}
const SWEEP = 'button, [role=switch], input[type=checkbox], select, summary, a[href^="#"]';
async function sweep(s: Session, scope: string, area: string, depth = 0): Promise<void> {
  const p = s.page;
  const seen = new Set<string>();
  for (let i = 0; i < 80; i++) {
    const all = p.locator(`${scope} :is(${SWEEP})`);
    const n = await all.count().catch(() => 0);
    if (i >= n) break;
    const el = all.nth(i);
    const reachable = await el.evaluate((n: Element) => (n as HTMLElement).checkVisibility({ opacityProperty: true, visibilityProperty: true }) && getComputedStyle(n).pointerEvents !== 'none' && !n.closest('[inert]')).catch(() => false);
    if (!reachable) continue;
    const label = await labelOf(el);
    const id = (await el.getAttribute('id').catch(() => null)) ?? '';
    const key = `${id}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (SKIP.test(label) || SKIP_IDS.has(id)) { passes.push(`${area}: “${label}” not clicked (destructive or leaves the page)`); continue; }
    if (await el.isDisabled().catch(() => false)) continue;
    const tag = await el.evaluate((n: Element) => n.tagName).catch(() => '');
    const before = await fingerprint(s), calls = s.apiCalls;
    try {
      if (tag === 'SELECT') {
        const opts = await el.locator('option').evaluateAll((os: Element[]) => os.map((o) => (o as HTMLOptionElement).value));
        const cur = await el.inputValue();
        const next = opts.find((o) => o !== cur);
        if (next === undefined) continue;
        await el.selectOption(next, { timeout: 1500 });
      } else await el.click({ timeout: 1500 }).catch(async () => { await p.waitForTimeout(400); await el.click({ timeout: 1500 }); });
    } catch {
      const cover = await el.evaluate((n: Element) => {
        n.scrollIntoView({ block: 'center' });
        const r = n.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (!top || top === n || n.contains(top)) return 'not covered (moving or animating)';
        const c = top.closest('[id]'); return `covered by ${top.tagName.toLowerCase()}${top.className && typeof top.className === 'string' ? '.' + top.className.split(' ')[0] : ''}${c ? ' in #' + c.id : ''}`;
      }).catch(() => 'detached');
      const inMenu = await el.evaluate((n: Element) => !!n.closest('#presentMenu')).catch(() => false);
      if (inMenu) add('Present menu', 'Present menu items can’t be reached (Share screen, Play a video, Present slides, Show an image, On-air AI)', 'P0', '', s.width, cover);
      else if (!/not covered/.test(cover)) add(area, `“${label}” can’t be clicked: ${cover}`, 'P1', 'Fix stacking or scrolling so the control is reachable at this width.', s.width, id);
      continue;
    }
    await p.waitForTimeout(350);
    const after = await fingerprint(s);
    if (after === before && s.apiCalls === calls) add(area, `“${label}” does nothing when clicked`, 'P1', 'Wire it up, disable it with a reason, or remove it.', s.width, id);
    await shot(s, `${area}-${label}`);
    await closeTransient(s, `${area}-${label}`, depth);
  }
}

// ------------------------------------------------------------------ flows
async function hostSession(browser: Browser, width: number, height: number): Promise<Session> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(instrument);
  const page = await ctx.newPage();
  return attach(page, width, 'Host');
}
async function signUpAndCreate(s: Session): Promise<string> {
  const p = s.page;
  await p.goto(BASE + '/'); await p.waitForTimeout(700);
  await shot(s, 'home'); await checkLayout(s, 'Home (signed out)');
  for (const banned of ['made with gather', 'Match system', 'A little space']) if (await p.getByText(banned, { exact: false }).count()) add('Home', `Removed copy is back: “${banned}”`, 'P1', 'Delete it again; it was removed at the owner’s request.', s.width);
  if (await p.locator('.stage-fs').count()) add('Stage', 'Fullscreen button is back', 'P2', 'Remove it; the owner asked for no fullscreen control.', s.width);
  await p.click('#userBtn'); await shot(s, 'account-dialog'); await checkLayout(s, 'Account dialog');
  await p.click('#acTabs [data-ac="up"]');
  await p.fill('#acName', 'Audit Host'); await p.fill('#acEmail', `audit${Date.now()}${s.width}@example.com`); await p.fill('#acPass', 'audit-pass-1234');
  await p.click('#acGo');
  await p.waitForFunction(() => document.getElementById('userLabel')?.textContent !== 'Sign in', null, { timeout: 8000 }).catch(() => add('Account', 'Sign-up did not complete', 'P0', 'Check /api/account signup and the store.', s.width));
  await shot(s, 'account-signed-in'); await checkLayout(s, 'Account (signed in)');
  await sweep(s, '#acctDlg', 'Account dialog', 1);
  await p.keyboard.press('Escape');
  await p.click('#enterStage'); await p.waitForTimeout(900);
  await shot(s, 'green-room'); await checkLayout(s, 'Step into the studio');
  await sweep(s, '#enterDlg', 'Step into the studio', 1);
  if (!(await p.locator('#enterDlg[open]').count())) await p.click('#enterStage');
  await p.click('#enterDlg [data-mode="create"]').catch(() => undefined);
  await p.fill('#enterName', 'Audit Host');
  await p.click('#enterGo');
  await p.waitForSelector('#inviteDlg[open]', { timeout: 12000 });
  await shot(s, 'invite'); await checkLayout(s, 'Invite dialog');
  const code = (await p.textContent('#inviteCode')) ?? '';
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  await shot(s, 'studio'); await checkLayout(s, 'Studio (host)');
  return code.trim();
}
async function sweepStudio(s: Session): Promise<void> {
  const p = s.page;
  // header + dock + deck
  await sweep(s, 'header.top', 'Header');
  await sweep(s, '.deck-head', 'Deck');
  for (const layer of ['scenes', 'people', 'lobby']) {
    const tab = p.locator(`.deck-tabs [data-deck="${layer}"]`);
    if (!(await tab.isVisible().catch(() => false))) continue;
    await tab.click(); await p.waitForTimeout(550);
    await shot(s, `deck-${layer}`); await checkLayout(s, `Deck: ${layer}`);
    await sweep(s, `.deck-layer[data-layer="${layer}"]`, `Deck: ${layer}`);
  }
  await p.mouse.move(300, 300);
  await sweep(s, '.dock', 'Dock');
  // rail panels
  for (const tab of ['chat', 'stream', 'ai', 'banners', 'layouts', 'brand', 'settings', 'help']) {
    await p.click(`.rail-btn[data-tab="${tab}"]`).catch(() => undefined);
    await p.waitForTimeout(300);
    await shot(s, `panel-${tab}`); await checkLayout(s, `Panel: ${tab}`);
    await sweep(s, `.panel[data-panel="${tab}"]`, `Panel: ${tab}`);
    if (await p.locator('#editLayer:not([hidden])').count()) await p.click('#editToggle').catch(() => undefined);
  }
  // on-stage controls
  await p.hover('#stage').catch(() => undefined);
  await sweep(s, '#stage', 'Stage');
  await checkLayout(s, 'Stage controls');
}

// ------------------------------------------------------------------ functional checks (1440 only)
async function lastToast(p: Page): Promise<string> { return (await p.locator('.toast').last().textContent().catch(() => '')) ?? ''; }

async function featureChecks(s: Session, browser: Browser, code: string): Promise<void> {
  const p = s.page, W = s.width;
  /** Click, and if something sits on top of the target, report what it is. */
  const clickOrExplain = async (loc: Locator, area: string): Promise<void> => {
    try { await loc.click({ timeout: 5000 }); }
    catch (err) {
      const cover = await loc.evaluate((n: Element) => { n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return t && t !== n && !n.contains(t) ? `${t.tagName.toLowerCase()}.${String(t.className).split(' ')[0]}` : 'nothing (moving)'; }).catch(() => 'detached');
      add(area, `Control blocked during the check: covered by ${cover}`, 'P1', 'Fix stacking so the control is reachable.', W);
      throw err;
    }
  };
  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); } catch (e) { add(`Feature: ${name}`, `Check crashed: ${(e as Error).message.split('\n')[0].slice(0, 120)}`, 'P1', 'Investigate; the flow did not reach its end state.', W); }
    await p.keyboard.press('Escape').catch(() => undefined);
  };

  await step('AI chat', async () => {
    await p.click('.rail-btn[data-tab="ai"]'); await p.click('#aiProv [data-prov="claude"]');
    await p.fill('#aiKey', ''); await p.locator('#aiKey').dispatchEvent('change');
    await p.fill('#aiInput', 'Who won the 1966 World Cup?'); await p.click('#aiAsk'); await p.waitForTimeout(500);
    const t = await lastToast(p);
    if (!/key/i.test(t)) add('Feature: AI chat', 'Asking with no key gives no clear “add your key” message', 'P1', 'Validate before sending and point at the key field.', W, t);
    else passes.push('AI chat: asking without a key explains what to do');
    await p.fill('#aiKey', 'sk-ant-audit-invalid'); await p.locator('#aiKey').dispatchEvent('change');
    await p.fill('#aiInput', 'Who won the 1966 World Cup?'); await p.click('#aiAsk');
    await p.waitForFunction(() => { const g = (window as unknown as GatherWindow).__gather; const it = g.ai.items[g.ai.items.length - 1]; return !!it && it.role === 'assistant' && it.done; }, null, { timeout: 25000 });
    const last = await p.evaluate(() => { const g = (window as unknown as GatherWindow).__gather; return g.ai.items[g.ai.items.length - 1]; });
    if (!last.error) add('Feature: AI chat', 'An invalid key did not produce an error state', 'P1', 'Surface provider auth errors as errors.', W, last.text.slice(0, 80));
    else if (/\{|\bundefined\b|stack/i.test(last.text)) add('Feature: AI chat', 'Invalid-key error is raw/technical', 'P2', 'Map provider 401s to “That key was rejected by Claude. Check it in the AI panel.”', W, last.text.slice(0, 100));
    else passes.push(`AI chat: invalid key → readable error (“${last.text.slice(0, 70)}”)`);
    await shot(s, 'feature-ai-chat');
  });

  await step('AI producer', async () => {
    await p.click('#cmdToggle'); await p.fill('#cmdInput', 'switch to solo'); await p.press('#cmdInput', 'Enter');
    await p.waitForFunction(() => (window as unknown as GatherWindow).__gather.aiStatus === 'idle', null, { timeout: 25000 });
    await shot(s, 'feature-ai-producer');
    const reply = (await p.textContent('#cmdReply')) ?? '';
    const t = await lastToast(p);
    if (!reply && !t) add('Feature: AI producer', 'A failed request leaves the on-stage bar silent', 'P1', 'Show the error inside the command bar, not only as a toast.', W);
    else if (!reply) add('Feature: AI producer', 'Errors appear only as a toast, not in the on-stage bar', 'P2', 'Write the error into #cmdReply so it stays next to the input.', W, t.slice(0, 90));
    else passes.push('AI producer: reply shown in the stage bar');
    await p.click('#cmdClose').catch(() => undefined);
  });

  await step('AI voice', async () => {
    await p.click('.rail-btn[data-tab="ai"]');
    await p.click('#aiVoiceSeg [data-voice="browser"]'); await p.click('#aiVoiceTest', { timeout: 1500 }).catch(() => undefined);
    await p.waitForTimeout(300);
    const spoke = await p.evaluate(() => (window as unknown as GatherWindow).__auditSpeak.length);
    const testVisible = await p.isVisible('#aiVoiceTest');
    if (!testVisible) add('Feature: AI voice', '“Test voice” is only visible for the Stream voice', 'P2', 'Show Test voice for every voice mode.', W);
    else if (!spoke) add('Feature: AI voice', 'Test voice (browser voice) did not speak', 'P1', 'Check speechSynthesis wiring.', W);
    else passes.push('AI voice: browser voice speaks');
    await p.click('#aiVoiceSeg [data-voice="openai"]'); await p.waitForTimeout(150);
    await p.click('#aiVoiceTest'); await p.waitForTimeout(800);
    const t = await lastToast(p);
    if (!/key|OpenAI|ChatGPT|voice/i.test(t)) add('Feature: AI voice', 'Stream voice without an OpenAI key gives no clear message', 'P1', 'Validate the key before calling TTS.', W, t);
    else passes.push(`AI voice: stream voice without key → “${t.slice(0, 60)}”`);
    const mic = await p.evaluate(() => 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
    if (!mic) missing.set('Voice input outside Chrome/Edge', 'Talking to the AI and the “Hey Sam” wake word rely on the Web Speech API, which Firefox and Safari lack. A server speech-to-text fallback (e.g. Whisper over the user’s key) would cover them.');
    await p.click('#aiVoiceSeg [data-voice="off"]');
  });

  await step('AI image maker', async () => {
    await p.click('.rail-btn[data-tab="stream"]'); await p.click('#wizOpen'); await p.waitForTimeout(400);
    await shot(s, 'feature-wizard');
    await p.click('#wizDlg [data-wmode="later"]');
    for (let i = 0; i < 4 && !(await p.isVisible('#wThumbTabs')); i++) { await p.fill('#wTitle', 'Audit episode').catch(() => undefined); await p.click('#wNext', { timeout: 3000 }); await p.waitForTimeout(300); }
    if (!(await p.isVisible('#wThumbTabs'))) { add('Feature: AI image maker', 'Could not reach the thumbnail step of the stream wizard', 'P1', 'Check wizard step validation.', W); return; }
    await p.click('#wThumbTabs [data-wt="ai"]');
    await p.fill('#wPrompt', 'neon studio desk, two microphones');
    await p.click('#wGen'); await p.waitForTimeout(600);
    const note1 = ((await p.textContent('#wGenNote')) ?? '') + (await lastToast(p));
    await shot(s, 'feature-ai-image');
    if (!note1.trim()) add('Feature: AI image maker', 'Generate gives no feedback without a key/after failure', 'P1', 'Show the reason in #wGenNote.', W);
    else passes.push(`AI image maker: feedback shown (“${note1.trim().slice(0, 70)}”)`);
    const outside = await p.evaluate(() => !!document.querySelector('[data-panel="brand"] #wGen, [data-panel="ai"] [id*="img"]'));
    if (!outside) missing.set('AI image maker outside the wizard', 'Image generation exists only inside “Start a stream → thumbnail”. It can’t make a stage background, overlay or sponsor image from the Brand panel, and the AI producer can’t generate an image on request.');
    await p.keyboard.press('Escape');
  });

  await step('Video upload', async () => {
    await p.click('#shareBtn'); await shot(s, 'feature-present-menu');
    await p.click('[data-present="video"]');
    await p.waitForFunction(() => (window as unknown as GatherWindow).__gather.local.pres?.kind === 'video', null, { timeout: 10000 });
    await p.waitForTimeout(800); await shot(s, 'feature-video');
    const bar = await p.isVisible('#presBar');
    passes.push(`Video upload: MP4 presents${bar ? ' with on-stage controls' : ''}`);
    if (!bar) add('Feature: video upload', 'Video presents but has no visible controls', 'P1', 'Show the presenter bar for video.', W);
    const seekable = await p.isVisible('#presSeek');
    if (!seekable) add('Feature: video upload', 'No seek control for video', 'P2', 'Show the seek bar.', W);
    await p.click('#presStop');
    // drop path
    const dt = await p.evaluateHandle(async (url: string) => { const b = await (await fetch(url)).blob(); const d = new DataTransfer(); d.items.add(new File([b], 'clip.mp4', { type: 'video/mp4' })); return d; }, 'data:video/mp4;base64,' + fs.readFileSync(MP4).toString('base64'));
    await p.dispatchEvent('#stage', 'drop', { dataTransfer: dt });
    const dropped = await p.waitForFunction(() => (window as unknown as GatherWindow).__gather.local.pres?.kind === 'video', null, { timeout: 8000 }).then(() => true, () => false);
    if (!dropped) add('Feature: video upload', 'Dropping a video on the stage does not present it', 'P0', 'Fix the stage drop handler for video files.', W);
    else passes.push('Video upload: drag and drop onto the stage presents it');
    await p.click('#presStop').catch(() => undefined);
    const lib = await p.evaluate(() => !!document.querySelector('#libPick'));
    if (lib) passes.push('Video upload: media library exists (browser-local)');
    missing.set('Media library sync', 'The media library lives in one browser (IndexedDB). It does not follow the account to another computer and guests can’t see it; uploads to storage (e.g. Vercel Blob) would fix that.');
  });

  await step('PDF presentations', async () => {
    await p.click('#shareBtn'); await p.click('[data-present="pdf"]');
    await p.waitForFunction(() => (window as unknown as GatherWindow).__gather.local.pres?.kind === 'pdf', null, { timeout: 12000 });
    await p.waitForTimeout(800); await shot(s, 'feature-pdf');
    const sc = await p.evaluate(() => (window as unknown as GatherWindow).__gather.state.scene);
    if (sc !== 'present-full') add('Feature: PDF', `Presenting switched to “${sc}”, not full-screen slides`, 'P1', 'autoPresentScene should pick present-full.', W);
    await p.click('#presNext');
    const pg = await p.evaluate(() => (window as unknown as GatherWindow).__gather.local.pres?.page ?? 0);
    if (pg !== 2) add('Feature: PDF', 'Next slide did not advance', 'P0', 'Check pres.go().', W);
    await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(250);
    const back = await p.evaluate(() => (window as unknown as GatherWindow).__gather.local.pres?.page ?? 0);
    if (back !== 1) add('Feature: PDF', 'Arrow keys don’t change slides', 'P2', 'Bind ←/→ while presenting a PDF (the button labels promise it).', W, `page after ← = ${back}`);
    else passes.push('PDF: full-screen slides, next/previous buttons and arrow keys work');
    const thumbs = await p.locator('.pres-bar img, .slide-thumbs').count();
    if (!thumbs) missing.set('Slide overview', 'No slide thumbnails or “go to slide N” for PDFs. Long decks need a grid to jump around, and presenter notes aren’t shown.');
    await p.click('#presStop');
  });

  await step('QR hide', async () => {
    await p.click('.rail-btn[data-tab="brand"]');
    await p.fill('[aria-label="PayPal link"]', 'gathershow');
    await clickOrExplain(p.locator('.tip-row', { hasText: 'PayPal' }).locator('button'), 'Feature: QR hide');
    await p.waitForFunction(() => (window as unknown as GatherWindow).__gather.state.elements.some((e) => e.type === 'tip'), null, { timeout: 5000 });
    await shot(s, 'feature-qr-card');
    const btn = (await p.locator('.tip-row', { hasText: 'PayPal' }).locator('button').textContent()) ?? '';
    const toggles = /hide|remove|off/i.test(btn);
    if (!toggles) add('Feature: QR hide', 'No way to hide a QR card where it was added: the Brand “On stage” button stays the same after it’s shown', 'P1', 'Make the button a toggle (“On stage” ↔ “Hide”), and add a hide control to the card in Layouts and on the stage editor.', W, `button reads “${btn}”`);
    // the only route today: Layouts → element list ✕
    await p.click('.rail-btn[data-tab="layouts"]');
    const row = p.locator('#elList li', { hasText: /support|paypal|tip|QR/i });
    if (await row.count()) {
      await row.first().locator('button[aria-label^="Hide"]').first().click();
      const gone = await p.waitForFunction(() => (window as unknown as GatherWindow).__gather.state.elements.some((e) => e.type === 'tip' && (e as StageElement & { hidden?: boolean }).hidden), null, { timeout: 4000 }).then(() => true, () => false);
      if (gone) passes.push('QR hide: one click on its eye in Layouts → Layers (a different panel from where it was added)');
      else add('Feature: QR hide', 'The eye toggle in Layers did not hide the QR card', 'P1', 'Check patchEl(hidden).', W);
    } else add('Feature: QR hide', 'QR card not listed in Layouts, so it can’t be removed at all', 'P0', 'List every element in #elList.', W);
    missing.set('Timed QR / support card', 'QR and call-in cards stay up until removed by hand. Show-for-N-seconds, or auto-show every N minutes like the sponsor rotation, would match how shows run donation calls.');
  });

  await step('Banner editing', async () => {
    await p.click('.rail-btn[data-tab="banners"]');
    await p.fill('#bannerText', 'Audit headline'); await p.fill('#bannerSub', 'first line'); await p.click('#bannerShow');
    await p.waitForFunction(() => (window as unknown as GatherWindow).__gather.state.banner?.text === 'Audit headline', null, { timeout: 4000 });
    await p.fill('#bannerText', 'Audit headline, edited'); await p.click('#bannerShow');
    const edited = await p.waitForFunction(() => (window as unknown as GatherWindow).__gather.state.banner?.text === 'Audit headline, edited', null, { timeout: 4000 }).then(() => true, () => false);
    if (!edited) add('Feature: banners', 'Editing a live banner does not update it', 'P0', 'Re-send state on Show.', W);
    await shot(s, 'feature-banner');
    await p.locator('#bannerText').pressSequentially('!'); await p.waitForTimeout(400);
    const followed = await p.evaluate(() => (window as unknown as GatherWindow).__gather.state.banner?.text.endsWith('!') ?? false);
    const flagged = await p.isVisible("#bannerEdited");
    if (flagged) passes.push("Banners: editing a live banner shows “Live · edited” and the button becomes “Update banner”");
    else if (!followed) add('Feature: banners', 'A live banner only changes after pressing “Show on stage” again; typing doesn’t update it and nothing says it’s out of date', 'P2', 'Mark the panel “Live, edited” with an Update button, or update live after a short pause.', W);
    await p.click('#bannerSave'); await p.waitForTimeout(200);
    const presetUse = p.locator('#bannerPresets .use').first();
    if (await presetUse.count()) { await presetUse.click(); passes.push('Banners: show, edit and show again, save preset, use preset all work'); }
    await p.click('#bannerHide');
    const hidden = await p.waitForFunction(() => !(window as unknown as GatherWindow).__gather.state.banner, null, { timeout: 4000 }).then(() => true, () => false);
    if (!hidden) add('Feature: banners', 'Hide banner does not clear it', 'P0', 'Fix setStage({ banner: null }).', W);
    const onStageEdit = await p.evaluate(() => !!document.querySelector('[data-edit="banner"], .banner-edit'));
    if (!onStageEdit) missing.set('Banner editing on stage', 'Banners can only be edited in the side panel: no click-to-edit on the stage, no per-banner colour/style override, no queue to step through a run of banners or tickers during a show.');
  });

  await step('Editor-only layer', async () => {
    // The program (what records and streams) must be identical whether or not the viewer is the host.
    // Locally (not synced): an empty solo stage, where the host sees an “Add someone to the stage” hint.
    await p.evaluate(() => { const g = (window as unknown as GatherWindow).__gather; g.state = { ...g.state, layout: 'solo', elements: [], banner: null, stage: [], ticker: '', featured: null }; });
    await p.waitForTimeout(300);
    const grab = (): Promise<{ data: number[]; editor: number; png: string }> => p.evaluate(() => {
      const c = document.getElementById('stageCanvas') as HTMLCanvasElement, e = document.getElementById('editorCanvas') as HTMLCanvasElement | null;
      const strip = (cv: HTMLCanvasElement): Uint8ClampedArray => cv.getContext('2d')?.getImageData(0, cv.height / 2 - 30, cv.width, 60).data ?? new Uint8ClampedArray();
      let editor = -1;
      if (e) { editor = 0; const d = strip(e); for (let i = 3; i < d.length; i += 4) if (d[i] > 0) editor++; }
      return { data: Array.from(strip(c)), editor, png: c.toDataURL('image/png') };
    });
    const asHost = await grab();
    const realHost = await p.evaluate(() => { const g = (window as unknown as GatherWindow & { __gather: { host: string } }).__gather; const h = g.host; g.host = 'audit-not-you'; return h; });
    await p.waitForTimeout(300);
    const asGuest = await grab();
    await p.evaluate((h: string) => { (window as unknown as GatherWindow & { __gather: { host: string } }).__gather.host = h; }, realHost);
    let diff = 0;
    for (let i = 0; i < asHost.data.length; i += 4) if (Math.abs(asHost.data[i] - asGuest.data[i]) + Math.abs(asHost.data[i + 1] - asGuest.data[i + 1]) + Math.abs(asHost.data[i + 2] - asGuest.data[i + 2]) > 60) diff++;
    const framePath = path.join(SHOTS, String(W), 'editor-only-program-frame.png');
    fs.writeFileSync(framePath, Buffer.from(asHost.png.split(',')[1], 'base64'));
    if (asHost.editor < 0) add('Stage: editor-only', 'No editor canvas: host hints would be recorded', 'P0', 'Restore #editorCanvas and editorOnly().', W);
    else if (asHost.editor === 0) add('Stage: editor-only', 'The empty-stage hint is not drawn anywhere for the host', 'P2', 'Check editorOnly() is flushed each frame.', W);
    else if (diff > 50) add('Stage: editor-only', 'Host-only drawing reaches the program output (host and guest program frames differ)', 'P0', 'Route host-only drawing through editorOnly().', W, `${diff} differing pixels; frame: ${path.relative(ROOT, framePath)}`);
    else passes.push(`Editor-only: program frame identical for host and guest (${diff} px differ); the hint is on the editor canvas only (${asHost.editor} px)`);
  });

  await step('Guest view', async () => {
    if (await p.isChecked('#lockSwitch').catch(() => false)) await p.click('#lockWrap');
    const gctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, permissions: ['camera', 'microphone'] });
    await gctx.addInitScript(instrument);
    const gp = await gctx.newPage(); const gs = attach(gp, 1440, 'Guest');
    await gp.goto(`${BASE}/s/${code}`); await gp.waitForSelector('#enterDlg[open]');
    await gp.fill('#enterName', 'Audit Guest'); await gp.click('#enterGo');
    await gp.waitForFunction(() => !!(window as unknown as GatherWindow).__gather.studio, null, { timeout: 12000 });
    await gp.waitForTimeout(800);
    await shot(gs, 'guest-studio'); await checkLayout(gs, 'Studio (guest)');
    const leaks = await gp.evaluate(() => Array.from(document.querySelectorAll('#recBtn, .rail-btn[data-tab="stream"], .rail-btn[data-tab="layouts"], .rail-btn[data-tab="brand"], .rail-btn[data-tab="banners"], #cmdToggle, #lockWrap, .crew-tools'))
      .filter((e) => (e as HTMLElement).checkVisibility()).map((e) => e.id || e.className));
    if (leaks.length) add('Guest view', `Host controls visible to guests: ${leaks.join(', ')}`, 'P0', 'Hide with the host-only flag in renderGuestView().', 1440);
    else passes.push('Guest view: no recording, stream, layout, brand, banner, AI producer, lock or people controls');
    await sweep(gs, '.dock', 'Guest dock');
    for (const tab of ['chat', 'ai', 'settings', 'help']) { await gp.click(`.rail-btn[data-tab="${tab}"]`).catch(() => undefined); await shot(gs, `guest-${tab}`); await checkLayout(gs, `Guest panel: ${tab}`); }
    await gctx.close();
  });
}

// ------------------------------------------------------------------ report
function writeReport(started: number): void {
  const list = [...findings.values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.area.localeCompare(b.area));
  const esc = (t: string): string => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const counts = (s: Severity): number => list.filter((f) => f.severity === s).length;
  const MISSING_KNOWN: Array<[string, string]> = [
    ['Restreaming to platforms', 'Going live on YouTube, Twitch, X, Kick, Rumble, TikTok or Facebook needs an RTMP relay (browsers can’t send RTMP). Today gather records locally and reads Twitch/Rumble chat; it does not push video to any platform.'],
    ['Cloud recording / save to Drive', 'Recordings download from the host’s browser only. No upload to Google Drive or Dropbox, no separate per-person ISO tracks, no cloud copy if the tab closes.'],
    ['Phone dial-in', 'The call-in line is a WebRTC link. Real phone numbers (PSTN) need a telephony provider (e.g. Twilio) bridged to the studio.'],
    ['YouTube / X / TikTok chat', 'Only Twitch and Rumble chat are connected. YouTube needs Google sign-in (OAuth); X needs a developer app; TikTok has no official chat API.'],
    ['Durable bans', 'Removing someone ends their session, but nothing stops them rejoining with the link except locking the studio.'],
    ['Production checks', 'No typecheck/lint/build pipeline exists (plain JS, no bundler), and the Playwright suites live outside the repo.'],
  ];
  for (const [k, v] of MISSING_KNOWN) if (!missing.has(k)) missing.set(k, v);
  const md: string[] = [
    '# gather UI audit',
    '',
    `Generated by \`scripts/audit.ts\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC against ${BASE}, at ${WIDTHS.map(([w]) => w).join(' / ')} px, in ${Math.round((Date.now() - started) / 1000)} s. Screenshots: \`audit/screens/auto/<width>/\`. Raw data: \`audit/findings.json\`.`,
    '',
    `**${counts('P0')} P0 · ${counts('P1')} P1 · ${counts('P2')} P2.** P0 breaks a core flow or leaks host UI into the stream; P1 is broken or confusing; P2 is polish.`,
    '',
    '| Area | Issue | Severity | Proposed fix | Widths | Evidence |',
    '|---|---|---|---|---|---|',
    ...list.map((f) => `| ${esc(f.area)} | ${esc(f.issue)} | ${f.severity} | ${esc(f.fix)} | ${f.widths.sort((a, b) => b - a).join(', ')} | ${esc(f.evidence.join('; ')).slice(0, 220)} |`),
    '',
    '## Missing features',
    '',
    ...[...missing.entries()].map(([k, v]) => `- **${k}.** ${v}`),
    '',
    '## Checked and working',
    '',
    ...[...new Set(passes)].filter((p) => !/not clicked/.test(p)).map((p) => `- ${p}`),
    '',
    '## Not clicked on purpose',
    '',
    ...[...new Set(passes.filter((p) => /not clicked/.test(p)))].map((p) => `- ${p}`),
    '',
  ];
  fs.writeFileSync(path.join(ROOT, 'AUDIT.md'), md.join('\n'));
  fs.mkdirSync(path.join(ROOT, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'audit', 'findings.json'), JSON.stringify({ base: BASE, findings: list, missing: Object.fromEntries(missing), passes }, null, 2));
}

async function main(): Promise<void> {
  const started = Date.now();
  fs.rmSync(SHOTS, { recursive: true, force: true });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  for (const [w, h] of WIDTHS) {
    const s = await hostSession(browser, w, h);
    console.log(`— ${w}px`);
    try {
      const code = await signUpAndCreate(s);
      await sweepStudio(s);
      if (w === 1440) await featureChecks(s, browser, code);
    } catch (e) { add(`Audit at ${w}px`, `Audit run stopped early: ${(e as Error).message.split('\n')[0].slice(0, 140)}`, 'P0', 'The flow above this point is broken at this width; see the last screenshot.', w); await shot(s, 'stopped'); }
    await s.ctx.close();
  }
  await browser.close();
  writeReport(started);
  console.log(`AUDIT.md: ${findings.size} findings, ${missing.size} missing features`);
}
void main();
