import { createRequire } from 'node:module';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const profile = await mkdtemp(path.join(os.tmpdir(), 'bookmark-startup-test-'));
const extension = path.join(profile, 'extension');
await cp(path.join(root, 'extension'), extension, { recursive: true, filter: file => !path.basename(file).startsWith('local-settings.json') });
// Instrument only the isolated extension copy. Never use a personal Chrome profile.
const background = path.join(extension, 'background.js');
const source = await readFile(background, 'utf8');
await writeFile(background, source.replace('const ready = importLocalSettings();', `
globalThis.__reads = []; globalThis.__requests = []; globalThis.__holdStatus = false;
globalThis.__denyTree = false; globalThis.__treeCalls = 0;
chrome.runtime.onMessage.addListener(message => { globalThis.__requests.push(message.type); });
const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
chrome.storage.local.get = keys => { globalThis.__reads.push(keys ?? null); return originalGet(keys); };
const originalTree = chrome.bookmarks.getTree.bind(chrome.bookmarks);
chrome.bookmarks.getTree = async () => {
  globalThis.__treeCalls++;
  if (globalThis.__denyTree) throw Error('Popup must not load the library');
  return originalTree();
};
const originalSearch = chrome.bookmarks.search.bind(chrome.bookmarks);
chrome.bookmarks.search = async query => {
  while (globalThis.__holdStatus) await new Promise(resolve => setTimeout(resolve, 20));
  return originalSearch(query);
};
const ready = importLocalSettings();`));
const context = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: process.env.BROWSER_PATH || undefined,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 450, height: 600 }
});
const errors = [];
const preloadWarnings = [];
context.on('page', page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/preloaded.*not used|not used.*preload/i.test(message.text())) preloadWarnings.push(message.text()); });
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ localConfigImported: true, settings: { configured: false, monitorNative: false, notifications: false } });
    const tree = await chrome.bookmarks.getTree();
    const folder = await chrome.bookmarks.create({ parentId: tree[0].children[0].id, title: '启动性能测试' });
    const values = { organizerHistory: { fixture: 'large history '.repeat(100000) } };
    for (let i = 0; i < 165; i++) {
      const bookmark = await chrome.bookmarks.create({ parentId: folder.id, title: '性能样例 ' + i, url: 'https://startup-test.example/' + i });
      values['page:' + bookmark.id] = { description: '索引摘要 ' + i, content: ('正文内容 '.repeat(16000) + (i === 164 ? ' unique-body-needle' : '')).slice(-80000), capturedAt: 1000 + i };
    }
    await chrome.storage.local.set(values);
    globalThis.__reads = []; globalThis.__requests = []; globalThis.__treeCalls = 0;
    globalThis.__denyTree = true; globalThis.__holdStatus = true;
  });
  const page = await context.newPage();
  const resources = [];
  page.on('request', request => resources.push(request.url()));
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('#quick-popup').waitFor();
  assert.equal(await page.getByRole('link', { name: '收藏 / 调整当前页' }).isVisible(), true);
  assert.equal(await page.locator('.bookmark-card, #results, #global-search').count(), 0);
  assert.equal(await page.getByRole('link', { name: '打开书签空间' }).isVisible(), true);
  assert.equal(await page.getByRole('link', { name: '批量整理书签' }).isVisible(), true);
  const firstPaintMs = await page.evaluate(() => Math.round(performance.now()));
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts/popup-startup-loading.png') });
  assert.equal(await page.locator('script, link[rel="stylesheet"], link[rel="preload"]').count(), 0, 'First popup must be completely static');
  await page.screenshot({ path: path.join(root, 'artifacts/popup-startup-ready.png') });
  const trace = await worker.evaluate(() => ({ reads: globalThis.__reads, requests: globalThis.__requests, trees: globalThis.__treeCalls }));
  assert.equal(trace.trees, 0, 'Popup must not load the bookmark tree');
  assert.deepEqual(trace.requests, [], 'Opening the popup must not send worker messages');
  assert.ok(trace.reads.every(keys => keys != null && !(Array.isArray(keys) && keys.some(key => key.startsWith('page:') || key === 'pageCatalog' || key.startsWith('organizer')))));
  assert.ok(resources.every(url => !['app.js', 'core.js', 'styles.css', 'organizer-ui.js', 'demo.js'].some(file => url.endsWith('/' + file))), 'Ordinary popup must not load full UI, global CSS or demo code');
  assert.ok(resources.every(url => !url.endsWith('.js') && !url.endsWith('.css')), 'First display must not depend on any script or stylesheet request');
  const cdp = await context.newCDPSession(page);
  const before = new Set((await cdp.send('Target.getTargets')).targetInfos.map(target => target.targetId));
  await worker.evaluate(() => chrome.action.openPopup());
  let popupTarget;
  for (let i = 0; i < 100; i++) {
    popupTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => !before.has(target.targetId) && target.url.endsWith('/popup.html'));
    if (popupTarget) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(popupTarget, 'A real toolbar popup target must open');
  // Full browsing and body search remain available in the separate manager.
  await worker.evaluate(() => { globalThis.__denyTree = false; });
  const opened = page.waitForEvent('popup');
  await page.getByRole('link', { name: '打开书签空间' }).click();
  const manager = await opened;
  await manager.setViewportSize({ width: 1440, height: 1000 });
  await manager.waitForURL(`chrome-extension://${id}/manager.html`);
  await manager.locator('.bookmark-card').first().waitFor();
  await manager.getByRole('searchbox').fill('unique-body-needle');
  await manager.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 1 && !document.getElementById('results').textContent.includes('正在搜索已索引正文'));
  assert.match(await manager.locator('.bookmark-title').textContent(), /164/);
  assert.deepEqual(errors, []);
  assert.deepEqual(preloadWarnings, [], 'Fresh popup and manager must not warn about unused preloaded resources');
  const report = { bookmarks: 165, bodyCharactersPerBookmark: 80000, observedFirstPaintMs: firstPaintMs, popupLibraryRequests: 0, popupBodyReads: 0, popupTreeReads: 0, popupScripts: 0, realToolbarPopupOpened: true, managerFullTextSearchPassed: true };
  await writeFile(path.join(root, 'artifacts/popup-startup-result.json'), JSON.stringify(report, null, 2));
  console.log('PASS:', JSON.stringify(report));
  console.log('Isolated Chromium only; no personal Chrome profile or bookmarks used.');
} finally { await context.close(); }
