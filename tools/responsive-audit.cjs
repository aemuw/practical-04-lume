/* Optional developer audit: npm install --no-save playwright, then node tools/responsive-audit.cjs.
   The website itself needs no packages. BROWSER_PATH can select an installed Chromium browser. */
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'evidence'));
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const name = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
  if (!name.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(name, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png' })[path.extname(name)] || 'application/octet-stream');
    res.end(data);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || undefined });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  const failures = [], checks = [], screenshots = [];
  const check = (name, ok, details) => { checks.push({ name, ok, details }); if (!ok) failures.push(name); };
  async function fit(label) {
    await page.evaluate(async () => { await Promise.all([...document.images].map(img => { img.loading = 'eager'; return img.decode().catch(() => {}); })); });
    const state = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      width: document.documentElement.scrollWidth,
      clipped: [...document.querySelectorAll('input, select, textarea, button, .button, img, fieldset')].filter(el => {
        const b = el.getBoundingClientRect(); return b.right > innerWidth + 1 || b.left < -1;
      }).map(el => el.id || el.className || el.tagName),
      brokenImages: [...document.images].filter(el => !el.complete || !el.naturalWidth).map(el => el.src)
    }));
    check(label, state.width <= state.viewport + 1 && !state.clipped.length && !state.brokenImages.length, state);
  }
  try {
    for (const file of ['index.html', 'login.html', 'register.html', 'product-form.html']) {
      for (const width of [320, 360, 390, 430, 640, 703, 704, 768, 900, 1151, 1152, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}/${file}`);
        await fit(`${file}: ${width}px`);
        if (file === 'index.html' && width === 768) {
          const pair = await page.locator('.hero > *').evaluateAll(els => els.map(e => ({ top: e.getBoundingClientRect().top, width: e.getBoundingClientRect().width })));
          check('Hero uses two usable columns at 768px', Math.abs(pair[0].top - pair[1].top) < 2 && pair.every(e => e.width >= 272), pair);
        }
        if (file === 'index.html' && width === 1280) {
          const cards = await page.locator('.collection-list > li').evaluateAll(els => els.map(e => e.getBoundingClientRect().top));
          check('Four catalogue cards fit in one row at 1280px', cards.every(v => Math.abs(v - cards[0]) < 2), cards);
        }
        if ([360, 768, 1280].includes(width)) {
          const name = `${file.replace('.html', '')}-${width}.png`;
          await page.screenshot({ path: path.join(out, name), fullPage: true }); screenshots.push(name);
        }
      }
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto(`${base}/${file}`);
      await page.evaluate(() => {
        document.querySelector('h1').textContent = 'LUME_' + 'VeryLongProductName'.repeat(12);
        const p = document.querySelector('main p'); p.textContent = 'https://example.test/' + 'unbrokentext'.repeat(40);
      });
      await fit(`${file}: long unbroken text at 320px`);
      // CSS zoom is a stress test, NOT browser UI zoom. Real Ctrl+200% is a manual check.
      await page.goto(`${base}/${file}`);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => { document.body.style.zoom = '2'; });
      await fit(`${file}: CSS zoom 200% stress test`);
      await page.goto(`${base}/${file}`);
      await page.setViewportSize({ width: 320, height: 900 });
      await page.keyboard.press('Tab');
      check(`${file}: first Tab reveals skip link`, await page.locator('.skip-link').evaluate(el => document.activeElement === el && el.getBoundingClientRect().top >= 0));
      await page.keyboard.press('Enter');
      check(`${file}: skip link focuses main`, await page.locator('main').evaluate(el => document.activeElement === el));
      await page.keyboard.press('Tab');
      check(`${file}: visible keyboard focus`, await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; }));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      check(`${file}: reduced motion disables transitions`, await page.locator('.button').first().evaluate(el => getComputedStyle(el).transitionDuration.split(',').every(v => parseFloat(v) === 0)));
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      if (file !== 'index.html') {
        await page.locator('button[type=submit]').click();
        check(`${file}: empty required form blocked`, new URL(page.url()).pathname.endsWith(file) && await page.locator(':invalid').count() > 0);
        await fit(`${file}: validation messages at 320px`);
      }
    }
    for (const count of [0, 24]) {
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto(`${base}/index.html`);
      await page.locator('.collection-list').evaluate((el, count) => { const item = el.firstElementChild.cloneNode(true); el.replaceChildren(...Array.from({ length: count }, () => item.cloneNode(true))); }, count);
      await fit(`Catalogue with ${count} cards at 320px`);
    }
    // Narrow content must not be trapped inside the desktop container's side padding.
    await page.goto(`${base}/index.html`);
    await page.setViewportSize({ width: 320, height: 900 });
    check('320px container leaves at least 280px for content', await page.locator('main').evaluate(el => { const s = getComputedStyle(el); return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) >= 280; }));
    // Image and text occupy equal tracks only when each has sufficient room.
    const result = { browser: await browser.version(), checkedAt: new Date().toISOString(), checks: checks.length, failures, results: checks, screenshots, limitations: ['CSS zoom is automated; actual browser UI zoom 200% remains a manual check.', 'No backend exists; successful POST persistence is outside this CSS project.'] };
    fs.writeFileSync(path.join(out, 'responsive-audit.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ checks: checks.length, failures, output: out }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
