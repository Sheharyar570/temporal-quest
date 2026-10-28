/* Real-browser smoke test (Chrome via playwright-core): every route at desktop and mobile widths in light and dark,
 * deep-dive pages, language toggle, copy button, quizzes and badges, widgets, mobile menu, persistence.
 *   setup:  npm i playwright-core   (uses your installed Google Chrome)
 *   run:    (cd /path/to/temporal-quest && python3 -m http.server 8765 &)  then  node scripts/browser-test.js
 */
const { chromium } = require('playwright-core');
const BASE = 'http://127.0.0.1:8765/index.html';
const OUT = require('os').tmpdir() + '/temporal-quest-shots';
require('fs').mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 800 }, colorScheme: opts.scheme || 'light', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => errs.push('requestfailed: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });
  return { ctx, page, errs };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  console.log('browser', browser.version());
  const { ctx, page, errs } = await newPage(browser);
  await page.goto(BASE);
  const modules = await page.evaluate(() => MODULES.map((m) => ({ id: m.id, deep: !!DEEP[m.id] })));
  const deeps = modules.filter((m) => m.deep).map((m) => m.id);
  check('home loads, 10 modules, 7 deep dives', modules.length === 10 && deeps.length === 7, `${modules.length} modules, deep: ${deeps.join(',')}`);

  // ---- every route, desktop and mobile
  const routes = ['#/', '#/badges', ...modules.map((m) => '#/m/' + m.id), ...deeps.map((d) => '#/m/' + d + '/deep')];
  for (const [label, vp] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const scheme of ['light', 'dark']) {
      const c = await newPage(browser, { viewport: vp, scheme });
      await c.page.goto(BASE);
      const bad = [];
      for (const r of routes) {
        await c.page.evaluate((h) => { location.hash = h; }, r);
        await c.page.waitForTimeout(120);
        const info = await c.page.evaluate(() => {
          const main = document.getElementById('main');
          const de = document.documentElement;
          return { len: main.innerText.length, overflow: de.scrollWidth - innerWidth, h1: main.querySelectorAll('h1').length, bg: getComputedStyle(document.body).backgroundColor };
        });
        if (info.len < 200) bad.push(r + ' empty');
        if (info.overflow > 1) bad.push(`${r} horizontal overflow ${info.overflow}px`);
        if (info.h1 !== 1) bad.push(`${r} has ${info.h1} h1`);
        const junk = await c.page.evaluate(() => { const k = document.body.cloneNode(true); k.querySelectorAll('pre,code,.opt').forEach((e) => e.remove()); k.style.cssText = 'position:absolute;left:-99999px'; document.body.append(k); const t = k.innerText; k.remove(); return (t.match(/\b(null|undefined|NaN|\[object Object\])\b/g) || []).length; });
        if (junk) bad.push(`${r} shows ${junk} stray null/undefined/NaN/[object Object]`);
      }
      const bg = await c.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check(`all ${routes.length} routes render without overflow (${label}, ${scheme})`, bad.length === 0 && c.errs.length === 0, bad.concat(c.errs).slice(0, 6).join(' | ') + ` bg=${bg}`);
      await c.ctx.close();
    }
  }

  // ---- direct deep link in a fresh context
  {
    const c = await newPage(browser);
    await c.page.goto(BASE + '#/m/schedules/deep');
    await c.page.waitForSelector('.case');
    const n = await c.page.locator('.case').count();
    check('deep link loads directly in a fresh browser', n === 3 && c.errs.length === 0, c.errs.join(' | '));
    await c.ctx.close();
  }

  // ---- deep pages: details, code language toggle, copy, quiz + badge persistence
  for (const d of deeps) {
    const c = await newPage(browser);
    const p = c.page;
    await p.goto(BASE + '#/m/' + d + '/deep');
    await p.waitForSelector('.case');
    const cases = p.locator('details.case');
    const nCases = await cases.count();
    // open the first case with a real click on its summary
    if (!(await cases.first().evaluate((el) => el.open))) await cases.first().locator('summary').click();
    const open = await cases.first().evaluate((el) => el.open);
    const tsVisible = await p.locator('details.case pre.ts').first().isVisible();
    await p.click('.langs button[data-l="py"]');
    await p.waitForTimeout(100);
    const pyVisible = await p.locator('details.case pre.py').first().isVisible();
    const tsHidden = !(await p.locator('details.case pre.ts').first().isVisible());
    const pyText = await p.locator('details.case pre.py').first().innerText();
    const langOk = tsVisible && pyVisible && tsHidden && /\b(def|import|class)\b/.test(pyText);
    await p.click('.langs button[data-l="ts"]');
    // copy button
    await p.locator('.code .bar button').first().click();
    await p.waitForTimeout(200);
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    const copyOk = clip.length > 100;
    // highlight tokens present
    const tokens = await p.locator('#main pre span').count();
    // open all cases and verify code blocks exist in each
    for (let i = 0; i < nCases; i++) { const el = cases.nth(i); if (!(await el.evaluate((e) => e.open))) await el.locator('summary').click(); }
    const codeBlocks = await p.locator('details.case .code').count();
    // quiz
    const answers = await p.evaluate((id) => DEEP[id].quiz.map((q) => q.a), d);
    const qs = p.locator('.q');
    const nq = await qs.count();
    for (let i = 0; i < nq; i++) await qs.nth(i).locator('.opt').nth(answers[i]).click();
    await p.waitForTimeout(300);
    const badge = await p.evaluate((id) => Game.s.badges[DEEP[id].badge], d);
    await p.reload();
    await p.waitForSelector('.case');
    const persisted = await p.evaluate((id) => !!Game.s.badges[DEEP[id].badge], d);
    const tick = await p.locator('nav a.sub .tick').count();
    await p.screenshot({ path: `${OUT}/${d}-deep.png`, fullPage: false });
    check(`deep:${d}`, nCases === 3 && open && langOk && copyOk && tokens > 20 && codeBlocks === 3 && nq === 5 && badge && persisted && tick >= 1 && c.errs.length === 0,
      `cases=${nCases} open=${open} lang=${langOk} copy=${copyOk} tokens=${tokens} code=${codeBlocks} quiz=${nq} badge=${!!badge} persisted=${persisted} ticks=${tick} errs=${c.errs.join(';')}`);
    await c.ctx.close();
  }

  // ---- widgets with real clicks
  {
    const c = await newPage(browser);
    const p = c.page;
    await p.goto(BASE + '#/m/why');
    const click = async (t) => { const b = p.locator('button', { hasText: t }).first(); if (await b.count() && await b.isEnabled()) { await b.click(); return true; } return false; };
    const seq = ['Start workflow', 'Run next activity', 'Kill the worker', 'Start a new worker', 'Run next activity', 'Run next activity', 'Run next activity'];
    for (const s of seq) await click(s);
    await p.waitForTimeout(300);
    const survivor = await p.evaluate(() => !!Game.s.badges.survivor);
    check('widget: durable-execution crash demo awards Survivor badge', survivor);
    for (const m of ['signals', 'queries', 'updates']) {
      await p.evaluate((h) => { location.hash = h; }, '#/m/' + m);
      await p.waitForTimeout(150);
      await p.locator('.widget input[type=text]').first().fill('pen');
      await click(m === 'signals' ? 'Send signal addItem' : m === 'queries' ? 'Add item' : 'Send update');
      await click('Query getItems');
      await p.locator('.widget input[type=text]').first().fill('');
      await click(m === 'updates' ? 'Send update' : 'Query getItems');
    }
    const lab = await p.evaluate(() => ['signal', 'query', 'update'].map((b) => !!Game.s.badges[b]));
    check('widgets: signal/query/update labs award badges', lab.every(Boolean), JSON.stringify(lab));
    await p.evaluate(() => { location.hash = '#/m/schedules'; });
    await p.waitForTimeout(150);
    const sel = p.locator('.widget select').first();
    for (const v of ['SKIP', 'BUFFER_ONE', 'BUFFER_ALL', 'CANCEL_OTHER', 'TERMINATE_OTHER', 'ALLOW_ALL']) await sel.selectOption(v);
    const gantt = await p.locator('.gt').count();
    check('widget: schedule overlap lab renders gantt rows', gantt > 0, `rows=${gantt}`);
    await p.screenshot({ path: `${OUT}/schedules-module.png` });
    await p.evaluate(() => { location.hash = '#/m/workers'; });
    await p.waitForTimeout(150);
    await click('Start 5'); await click('Add worker');
    await p.evaluate(() => { location.hash = '#/m/patterns'; });
    await p.waitForTimeout(150);
    await click('Run saga');
    await p.evaluate(() => { location.hash = '#/m/boss'; });
    await p.waitForTimeout(150);
    await click('Workflow');
    check('widgets: workers/saga/boss interactions without errors', c.errs.length === 0, c.errs.join(' | '));
    await c.ctx.close();
  }

  // ---- mobile menu, theme, nav
  {
    const c = await newPage(browser, { viewport: { width: 390, height: 844 } });
    const p = c.page;
    await p.goto(BASE);
    const navBefore = ((await p.locator('#nav').boundingBox()).x + (await p.locator('#nav').boundingBox()).width) > 0;
    await p.click('#menu');
    await p.waitForTimeout(400);
    const navAfter = ((await p.locator('#nav').boundingBox()).x + (await p.locator('#nav').boundingBox()).width) > 0;
    await p.screenshot({ path: `${OUT}/mobile-menu.png` });
    check('mobile: menu button toggles navigation', !navBefore && navAfter, `onscreen before=${navBefore} after=${navAfter}`);
    if (navAfter) { await p.locator('#nav a.sub').first().click(); await p.waitForTimeout(250); }
    check('mobile: deep link from nav navigates', /deep$/.test(await p.evaluate(() => location.hash)));
    await p.screenshot({ path: `${OUT}/mobile-deep.png` });
    await p.goBack();
    check('browser back works', !(await p.evaluate(() => location.hash)).endsWith('/deep'));
    await c.ctx.close();
  }

  // ---- progress persistence across reload and XP/level display
  {
    const c = await newPage(browser);
    const p = c.page;
    await p.goto(BASE + '#/m/workflows');
    const answers = await p.evaluate(() => MODULES.find((m) => m.id === 'workflows').sections.find((s) => s.type === 'quiz').questions.map((q) => q.a));
    const qs = p.locator('.q');
    for (let i = 0; i < answers.length; i++) await qs.nth(i).locator('.opt').nth(answers[i]).click();
    await p.waitForTimeout(300);
    const xp1 = await p.evaluate(() => Game.s.xp);
    await p.reload();
    const xp2 = await p.evaluate(() => Game.s.xp);
    const txt = await p.locator('#xptext').innerText();
    check('progress: XP persists across reload and shows in header', xp1 > 0 && xp1 === xp2, `xp=${xp1}/${xp2} header="${txt}"`);
    await p.screenshot({ path: `${OUT}/home.png` });
    await c.ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
