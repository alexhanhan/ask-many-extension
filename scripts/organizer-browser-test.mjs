import { createRequire } from 'node:module';
import { mkdtemp, mkdir, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(import.meta.dirname, '..'), artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'bookmark-grove-organizer-test-'));
const extension = path.join(profile, 'extension');
await cp(path.join(root, 'extension'), extension, { recursive: true, filter: file => !path.basename(file).startsWith('local-settings.json') });
const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.BROWSER_PATH || undefined, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1440, height: 1050 } });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(worker.url()).host;
  const seed = await worker.evaluate(async () => {
    await chrome.storage.local.set({ settings: { baseUrl: 'https://api.deepseek.com', apiKey: 'test-only-placeholder', model: 'synthetic-model', configured: true, monitorNative: false, notifications: false, indexContent: true } });
    const tree = await chrome.bookmarks.getTree(), root = tree[0].children.find(f => !f.unmodifiable).id;
    const inbox = await chrome.bookmarks.create({ parentId: root, title: '待整理' });
    const dev = await chrome.bookmarks.create({ parentId: root, title: '开发技术' });
    const design = await chrome.bookmarks.create({ parentId: root, title: '设计灵感' });
    const ids = [];
    for (let n = 0; n < 41; n++) ids.push((await chrome.bookmarks.create({ parentId: inbox.id, title: n % 2 ? `Figma 设计资源 ${n}` : `React 开发文档 ${n}`, url: `https://${n % 2 ? 'figma.com' : 'react.dev'}/test-${n}` })).id);
    const originalFetch = globalThis.fetch;
    globalThis.organizerTestBatches = []; globalThis.organizerTestHold = true;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions') return originalFetch(url, init);
      const payload = JSON.parse(init.body), batch = JSON.parse(payload.messages[1].content).bookmarks;
      globalThis.organizerTestBatches.push(batch.length);
      if (globalThis.organizerTestHold) await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      const suggestions = batch.map(b => ({ bookmarkId: b.id, folderId: b.title.includes('Figma') ? design.id : dev.id, reason: b.title.includes('Figma') ? '设计资源归入灵感目录' : '开发文档归入技术目录' }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    };
    return { root, inbox: inbox.id, dev: dev.id, design: design.id, ids };
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(`chrome-extension://${id}/manager.html#organize`);
  await page.getByRole('heading', { name: '批量整理书签', exact: true }).waitFor();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await page.getByRole('button', { name: '暂停分析', exact: true }).waitFor();
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  await page.getByRole('button', { name: '继续分析', exact: true }).waitFor();
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('organizerJob')).organizerJob.cursor), 0);
  await worker.evaluate(() => { globalThis.organizerTestHold = false; });
  await page.getByRole('button', { name: '继续分析', exact: true }).click();
  await page.getByText('分析完成 · 等待预览和应用', { exact: true }).waitFor();
  assert.equal(await page.locator('select[aria-label="整理范围"] option:checked').textContent(), '全部书签');
  assert.equal(await page.locator('.organize-row').count(), 41);
  assert.equal(await worker.evaluate(async id => (await chrome.bookmarks.getChildren(id)).length, seed.inbox), 41);
  await page.screenshot({ path: path.join(artifacts, 'organizer-preview.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('searchbox', { name: '筛选整理建议' }).fill('React');
  assert.equal(await page.locator('.organize-row').count(), 21);
  await page.getByRole('checkbox', { name: '选择当前筛选的全部建议' }).uncheck();
  await page.getByRole('button', { name: '应用选中（20）', exact: true }).click();
  await page.getByRole('button', { name: '确认应用 20 项', exact: true }).click();
  await page.getByRole('button', { name: '撤销已应用的移动（20）', exact: true }).waitFor();
  assert.equal(await worker.evaluate(async id => (await chrome.bookmarks.getChildren(id)).length, seed.design), 20);
  await page.getByLabel('整理范围').selectOption(seed.inbox);
  await page.getByLabel('允许新建分类目录', { exact: false }).check();
  await page.getByLabel('新分类保存目录').selectOption(seed.root);
  await page.getByRole('button', { name: '重新分析', exact: true }).click();
  await page.getByRole('button', { name: '确认重新分析', exact: true }).click();
  await page.getByText('已分析 21 / 21', { exact: false }).waitFor();
  for (const bookmarkId of [seed.ids[0], seed.ids[2]]) {
    const row = page.locator(`[data-bookmark-id="${bookmarkId}"]`);
    await row.getByRole('button', { name: '修改建议', exact: true }).click();
    await page.getByLabel('目标类型').selectOption('new');
    await page.getByLabel('新分类路径').fill('技术 / 前端 / 框架');
    await page.getByRole('button', { name: '保存建议', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await row.getByRole('button', { name: '应用', exact: true }).click();
    await row.getByText('已应用', { exact: true }).waitFor();
  }
  const pathCounts = await worker.evaluate(async rootId => {
    const first = (await chrome.bookmarks.getChildren(rootId)).filter(f => f.title === '技术');
    const second = await chrome.bookmarks.getChildren(first[0].id), third = await chrome.bookmarks.getChildren(second[0].id);
    return [first.length, second.length, third.length, (await chrome.bookmarks.getChildren(third[0].id)).length];
  }, seed.root);
  assert.deepEqual(pathCounts, [1, 1, 1, 2]);
  await page.reload();
  await page.getByText('已分析 21 / 21', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('整理范围').inputValue(), seed.inbox);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(artifacts, 'organizer-applied.png') });
  await page.getByRole('button', { name: '撤销已应用的移动（22）', exact: true }).click();
  await page.getByRole('button', { name: '确认撤销移动', exact: true }).click();
  await page.locator('#toast').filter({ hasText: '已处理 22 条撤销记录' }).waitFor();
  assert.equal(await worker.evaluate(async () => { const { organizerHistory } = await chrome.storage.local.get('organizerHistory'); return organizerHistory.length === 22 && organizerHistory.every(e => e.status === 'undone'); }), true);
  const restored = await worker.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(b => b.id), seed.inbox);
  if (restored.length !== seed.ids.length) console.log('Undo diagnostic:', await worker.evaluate(async () => {
    const { organizerHistory } = await chrome.storage.local.get('organizerHistory');
    return Promise.all(organizerHistory.map(async e => ({ id: e.bookmarkId, source: e.parentId, target: e.targetId, status: e.status, actual: (await chrome.bookmarks.get(e.bookmarkId))[0].parentId })));
  }));
  assert.deepEqual(restored, seed.ids);
  await page.setViewportSize({ width: 790, height: 950 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  if (process.env.BOOKMARK_PREVIEW_URL) {
    const preview = await context.newPage();
    await preview.goto(process.env.BOOKMARK_PREVIEW_URL);
    await preview.getByRole('button', { name: '开始分析', exact: true }).click();
    await preview.getByText('分析完成 · 等待预览和应用', { exact: true }).waitFor();
    assert.equal(await preview.locator('.organize-row').count(), 9);
    await preview.screenshot({ path: path.join(artifacts, 'organizer-demo.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: standalone browser preview uses marked sample data and completes local analysis.');
  }
  console.log('PASS: 41 real Chrome bookmarks, 20-item mocked AI batches, pause/resume, preview without moves, filtered multi-selection, bulk apply, editable three-level paths, folder reuse, persisted reload, exact undo order and responsive layout. No real user bookmarks or API key were used.');
} catch (error) {
  const page = context.pages().at(-1);
  if (page) await page.screenshot({ path: path.join(artifacts, 'organizer-test-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await context.close(); }
