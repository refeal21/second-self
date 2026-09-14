/** Browser plugin absent. Memory-only fake origin; all other requests abort. */
/* global process, URL, window, document */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(root, 'artifacts/qa/presales-v3/final-fixes');
if (!process.env.PLAYWRIGHT_MODULE_PATH) throw Error('Existing Playwright module path is required');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH);
const bundle = await build({ entryPoints: [resolve(root, 'apps/desktop/scripts/presales-v3-final-fix-entry.tsx')], bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', write: false, outdir: '/virtual' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--mute-audio'] });
const errors = []; let fulfilled = 0; let blocked = 0; let peakMountedOriginals = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const resources = { '/': ['text/html', '<!doctype html><html><head><meta charset="utf-8"><title>Final fix synthetic QA</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'], '/app.js': ['text/javascript', js], '/app.css': ['text/css', css] };
    if (url.origin === 'https://presales-final.invalid' && resources[url.pathname]) {
      fulfilled++; const [contentType, body] = resources[url.pathname]; await route.fulfill({ contentType, body });
    } else { blocked++; await route.abort(); }
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.goto('https://presales-final.invalid/');
  assert.equal(await page.title(), 'Final fix synthetic QA');
  await page.getByRole('heading', { name: '配对审核与长图库合成检查' }).waitFor();
  await page.getByRole('textbox', { name: '步骤 step-1 · 执行者' }).fill('Reviewed operator');
  await page.getByRole('button', { name: '补齐缺失的可见文字绑定' }).click();
  await page.waitForFunction(() => window.finalFixDesign.scene.steps[0].actor === 'Reviewed operator' && window.finalFixDesign.textBindings.some(binding => binding.path === '/shapes/1/text'));
  await page.getByRole('textbox', { name: '步骤 step-1 · 执行者' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'scene-desktop.png') });
  for (let index = 0; index < 40; index++) {
    await page.locator(`#image-${index}`).scrollIntoViewIfNeeded();
    await page.getByRole('img', { name: `image-${index}`, exact: true }).waitFor();
    const retained = await page.locator('[aria-label="40 张原图滚动检查"] img').count();
    peakMountedOriginals = Math.max(peakMountedOriginals, retained);
    assert(retained <= 10, `visited originals retained in DOM: ${retained}`);
  }
  assert.equal(await page.locator('#image-0 img').count(), 0);
  await page.screenshot({ path: resolve(output, 'long-deck-end.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('textbox', { name: '步骤 step-1 · 执行者' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'scene-mobile.png') });
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
  assert(bodyWidth <= 390, `mobile overflow ${bodyWidth}`);
  assert.deepEqual(errors, []);
  assert.equal(blocked, 0);
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify({ errors, fulfilled, blocked, peakMountedOriginals, visited: 40, bodyWidth, url: page.url() }, null, 2));
  process.stdout.write(`${JSON.stringify({ errors, fulfilled, blocked, peakMountedOriginals, bodyWidth })}\n`);
} finally { await browser.close(); }
