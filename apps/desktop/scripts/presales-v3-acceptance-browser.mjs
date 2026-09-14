/** No listener, profile or network. Real App receives captured native synthetic DTOs. */
/* global process, URL, window, document, scrollTo */
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.env.PRESALES_ACCEPTANCE_EVIDENCE_DIR ?? resolve(root, 'artifacts/qa/presales-v3'));
const runtime = process.env.PLAYWRIGHT_MODULE_PATH;
if (!runtime) throw Error('Set PLAYWRIGHT_MODULE_PATH to the installed Playwright module; no installation is attempted.');
const { chromium } = createRequire(import.meta.url)(runtime);
const state = JSON.parse(await readFile(resolve(output, 'concurrency-4-five-revisions.json'), 'utf8'));
assert.equal(state.project.project.pages.length, 5);
const bundled = await build({
  entryPoints: [resolve(root, 'apps/desktop/scripts/presales-v3-acceptance-entry.tsx')],
  bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', write: false, outdir: '/virtual',
  loader: { '.woff2': 'dataurl' },
});
const js = bundled.outputFiles.find(f => f.path.endsWith('.js')).text;
const css = bundled.outputFiles.find(f => f.path.endsWith('.css')).text;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--mute-audio'],
});
let fulfilled = 0, blocked = 0;
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(data => { window.acceptance = data; }, state);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const bodies = {
      '/': ['text/html; charset=utf-8', '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>售前五页合成验收</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'],
      '/app.js': ['text/javascript', js], '/app.css': ['text/css', css],
    };
    if (url.origin === 'https://presales-test.invalid' && bodies[url.pathname]) {
      fulfilled++;
      const [contentType, body] = bodies[url.pathname];
      await route.fulfill({ contentType, body });
    } else { blocked++; await route.abort(); }
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.goto('https://presales-test.invalid/#/workspace/presales-v3/frozen-project');
  try { await page.getByRole('heading', { name: state.project.project.summary.name, exact: true }).waitFor({ timeout: 10000 }); }
  catch (error) {
    await writeFile(resolve(output, 'browser-failure.txt'), JSON.stringify({ errors, body: await page.locator('body').innerText() }, null, 2));
    throw error;
  }
  assert.equal(await page.title(), '售前五页合成验收');
  const pages = state.project.project.pages;
  for (const [i, p] of pages.entries()) {
    await page.getByRole('button', { name: new RegExp(`第 ${i + 1} 页 ${p.spec.title}`) }).click();
    const stage = page.locator('.presales-gallery__stage');
    await stage.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('.presales-gallery__stage img')].some(i => i.complete && i.naturalWidth === 1600));
    await page.screenshot({ path: resolve(output, `page-${i + 1}-desktop.png`) });
  }
  await page.getByRole('button', { name: /第 2 页 感知与处置双模块总体架构/ }).click();
  await page.getByRole('button', { name: /查看初稿 修订 1/ }).click();
  assert.match(await page.getByRole('textbox', { name: '此版本反馈' }).inputValue(), /第1轮/);
  await page.getByRole('textbox', { name: '此版本反馈' }).fill('浏览器：保留双模块闭环关系');
  await page.getByRole('button', { name: '保存反馈', exact: true }).click();
  await page.waitForFunction(() => window.acceptanceCalls.some(c => c.name === 'saveFeedback'));
  await page.getByRole('button', { name: /查看版本 6 修订 6/ }).click();
  assert.equal(await page.getByRole('textbox', { name: '此版本反馈' }).inputValue(), '');
  await page.getByRole('button', { name: /查看初稿 修订 1/ }).click();
  assert.equal(await page.getByRole('textbox', { name: '此版本反馈' }).inputValue(), '浏览器：保留双模块闭环关系');
  await page.getByRole('button', { name: '导出可编辑 PPTX' }).click();
  await page.getByText(/暂不支持可编辑转换/).waitFor();
  const calls = await page.evaluate(() => window.acceptanceCalls);
  assert(!calls.some(c => c.name === 'adoptVersion'));
  const delivery = calls.find(c => c.name === 'delivery').input;
  assert.equal(delivery.pages[1].versionId, pages[1].currentVersionId);
  assert.notEqual(delivery.pages[1].versionId, pages[1].versions[0].versionId);
  await page.screenshot({ path: resolve(output, 'history-exact-delivery.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(output, 'mobile.png') });
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
  assert(bodyWidth <= 390);
  assert.deepEqual(errors, []);
  assert.equal(blocked, 0);
  const report = { title: await page.title(), route: page.url(), viewports: ['1440x1000', '390x844'],
    pages: pages.map(p => p.spec.title), nativeDtoSource: 'concurrency-4-five-revisions.json',
    historyDraftRestored: true, inspectionDidNotAdopt: true, exactDeliveryVersion: delivery.pages[1].versionId,
    editableConversion: 'unsupported', export: 'not_run', qa: 'not_run',
    bodyWidth, fulfilled, blocked, errors, browserPlugin: 'not available',
    imageSource: 'deterministic canvas previews from frozen native spec; overrides native synthetic solid PNGs only at preview adapter boundary',
    nativeAppLaunched: false, localServer: false, liveAccount: false, audio: 'muted' };
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  await context.close();
} finally { await browser.close(); }
