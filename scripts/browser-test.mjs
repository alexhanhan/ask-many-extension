import { createRequire } from 'node:module';
import { mkdtemp, mkdir, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'bookmark-grove-test-'));
const publicExtension = path.join(profile, 'public-extension');
await cp(path.join(root, 'extension'), publicExtension, { recursive: true, filter: file => !path.basename(file).startsWith('local-settings.json') });
const context = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: process.env.BROWSER_PATH || undefined,
  args: [`--disable-extensions-except=${publicExtension}`, `--load-extension=${publicExtension}`],
  viewport: { width: 1440, height: 1040 },
});
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  console.log('Real Manifest V3 service worker loaded:', extensionId);
  const seeded = await worker.evaluate(async () => {
    await chrome.storage.local.set({ settings: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', monitorNative: false, indexContent: true, notifications: false } });
    const tree = await chrome.bookmarks.getTree();
    const parentId = tree[0].children.find(n => !n.unmodifiable).id;
    const dev = await chrome.bookmarks.create({ title: '开发与技术', parentId });
    const design = await chrome.bookmarks.create({ title: '设计与灵感', parentId });
    const ai = await chrome.bookmarks.create({ title: '人工智能', parentId });
    const data = [
      ['React · 构建用户界面的库', 'https://react.dev', dev.id, '组件驱动的现代前端开发方式，构建更清晰、更自然的交互体验。'],
      ['Dribbble — 发现好设计', 'https://dribbble.com', design.id, '发现界面、色彩与创意，收藏让你眼前一亮的设计灵感。'],
      ['GitHub · 与世界一起创造', 'https://github.com', dev.id, '发现开源项目，与世界各地的开发者共同创造。'],
      ['Hugging Face · AI 社区', 'https://huggingface.co', ai.id, '探索开源模型、数据集与实践，让每个想法拥有更多可能。'],
      ['Figma Community · 设计资源', 'https://figma.com/community', design.id, '寻找可复用的设计资源，与团队一起将想法变成真实的体验。'],
      ['Vue.js · 渐进式 JavaScript 框架', 'https://cn.vuejs.org', dev.id, '从真实的代码与项目中学习，构建轻盈而有表现力的网页。']
    ];
    const ids = [];
    for (const [title, url, parentId, description] of data) {
      const node = await chrome.bookmarks.create({ title, url, parentId }); ids.push(node.id);
      await chrome.storage.local.set({ ['page:' + node.id]: { description, content: description + ' only-body-needle', capturedAt: Date.now() } });
    }
    return { dev: dev.id, design: design.id, ai: ai.id, ids };
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await page.locator('.bookmark-card').first().waitFor();
  assert.equal(await page.locator('.bookmark-card').count(), 6);
  assert.equal(await page.locator('.demo-banner').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'manager.png'), fullPage: true });
  await page.getByRole('searchbox').fill('only-body-needle');
  await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 6 && !document.getElementById('results').textContent.includes('正在搜索已索引正文'));
  assert.equal(await page.locator('.bookmark-card').count(), 6);
  await page.getByRole('searchbox').fill('only-body-needle React');
  await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 1);
  assert.equal(await page.locator('.bookmark-card').count(), 1);
  await page.getByRole('searchbox').fill('<script>alert(1)</script>');
  await page.getByRole('heading', { name: '暂时没有找到相关书签' }).waitFor();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await page.getByRole('button', { name: '列表视图' }).click();
  assert.ok(await page.locator('.list-view').count());
  await page.getByRole('button', { name: '卡片视图' }).click();
  await page.getByRole('button', { name: '重新归类' }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByLabel('选择已有文件夹').selectOption(seeded.design);
  await page.getByRole('button', { name: '确认归类' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '模型与偏好设置' }).click();
  await page.getByLabel('收藏时保存正文索引').uncheck();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await page.locator('#toast').filter({ hasText: '收藏与搜索偏好已保存' }).waitFor();
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.indexContent), false);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(artifacts, 'settings.png'), fullPage: true });
  await page.getByRole('button', { name: '全部书签' }).click();
  await worker.evaluate(async ({ dev }) => {
    const data = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...data.settings, monitorNative: true } });
    await chrome.bookmarks.create({ title: '新收藏的 React 文档', url: 'https://react.dev/reference/react', parentId: dev });
  }, seeded);
  await page.getByRole('button', { name: '待归类' }).click();
  await page.getByRole('button', { name: '查看归类建议' }).waitFor();
  await page.getByRole('button', { name: '查看归类建议' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '确认归类' }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'recommendation.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '保留当前位置' }).click();
  await page.getByRole('heading', { name: '每一份收藏，都已安放妥当' }).waitFor();
  const popupPage = await context.newPage();
  await popupPage.setViewportSize({ width: 450, height: 600 });
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupPage.locator('#quick-popup').waitFor();
  assert.equal(await popupPage.locator('.bookmark-card').count(), 0);
  assert.equal(await popupPage.getByRole('searchbox').count(), 0);
  await popupPage.screenshot({ path: path.join(artifacts, 'popup.png') });
  assert.equal(await popupPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 790, height: 900 });
  await page.getByRole('button', { name: '全部书签' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const fixtureUrl = 'https://bookmark-test.example/saved';
  await context.route('https://bookmark-test.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>网页现在的标题</title><main>用于验证已收藏状态的正文</main>' }));
  const savedId = await worker.evaluate(async ({ url, parentId }) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, monitorNative: false } });
    return (await chrome.bookmarks.create({ title: '用户自定义的书签标题', url, parentId })).id;
  }, { url: fixtureUrl, parentId: seeded.dev });
  const webPage = await context.newPage();
  await webPage.goto(fixtureUrl);
  await popupPage.reload();
  await worker.evaluate(async url => { const [tab] = await chrome.tabs.query({ url }); await chrome.tabs.update(tab.id, { active: true }); }, fixtureUrl);
  const countBeforeAdjust = await worker.evaluate(async () => (await chrome.bookmarks.search({})).filter(b => b.url).length);
  // Dispatch from an already-open toolbar document without activating its test tab.
  await popupPage.getByRole('link', { name: '收藏 / 调整当前页', exact: true }).dispatchEvent('click');
  await popupPage.waitForURL(`chrome-extension://${extensionId}/collect.html`);
  await popupPage.getByRole('dialog').waitFor();
  await popupPage.getByRole('button', { name: '确认归类' }).waitFor();
  const saveBounds = await popupPage.getByRole('button', { name: '确认归类' }).boundingBox();
  assert.ok(saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 600, 'Popup confirmation must remain visible without scrolling');
  await popupPage.screenshot({ path: path.join(artifacts, 'popup-recommendation.png') });
  assert.equal(await popupPage.locator('dialog').evaluate(node => node.getBoundingClientRect().width <= 450), true);
  assert.equal(await popupPage.getByLabel('书签标题', { exact: true }).inputValue(), '用户自定义的书签标题');
  await popupPage.getByLabel('选择已有文件夹').selectOption(seeded.design);
  await popupPage.getByRole('button', { name: '确认归类' }).click();
  await popupPage.getByRole('dialog').waitFor({ state: 'detached' });
  const savedAfter = await worker.evaluate(async id => (await chrome.bookmarks.get(id))[0], savedId);
  assert.equal(savedAfter.parentId, seeded.design);
  assert.equal(savedAfter.title, '用户自定义的书签标题');
  assert.equal(savedAfter.url, fixtureUrl);
  assert.equal(await worker.evaluate(async () => (await chrome.bookmarks.search({})).filter(b => b.url).length), countBeforeAdjust);
  await webPage.goto('https://bookmark-test.example/unsaved');
  await webPage.bringToFront();
  await popupPage.getByRole('button', { name: '收藏当前页', exact: true }).waitFor();
  await popupPage.screenshot({ path: path.join(artifacts, 'current-page-unsaved.png') });
  await webPage.goto(fixtureUrl);
  await popupPage.getByRole('button', { name: '已收藏 · 调整分类', exact: true }).waitFor();
  await worker.evaluate(id => chrome.bookmarks.remove(id), savedId);
  await popupPage.getByRole('button', { name: '收藏当前页', exact: true }).waitFor();
  await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, monitorNative: true } }); });
  // An active internal page can also be bookmarked, matching the supplied screenshot.
  await page.bringToFront();
  const cdp = await context.newCDPSession(page);
  const nativeId = await worker.evaluate(async ({ dev, url }) => {
    return (await chrome.bookmarks.create({ title: '拾叶 · 书签空间', url, parentId: dev })).id;
  }, { dev: seeded.dev, url: page.url() });
  let nativeTarget;
  for (let attempt = 0; attempt < 100; attempt++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    nativeTarget = targetInfos.find(target => target.url.includes(`collect.html?review=${nativeId}`));
    if (nativeTarget) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(nativeTarget, 'Native bookmark event should automatically open a real extension popup target');
  console.log('Automatic review target opened:', nativeTarget.type);
  // Toolbar targets may not appear in Playwright's normal Page event stream.
  // Verify the identical review URL as a Page to exercise its real UI controls.
  const automatic = await context.newPage();
  await automatic.goto(nativeTarget.url);
  await automatic.getByRole('dialog').waitFor();
  await automatic.getByLabel('选择已有文件夹').selectOption(seeded.design);
  // AI arriving late must update reasons without overwriting the user's selection.
  await worker.evaluate(async ({ id, ai }) => {
    const { pending } = await chrome.storage.local.get('pending');
    pending[id] = { ...pending[id], source: 'ai', analyzing: false, items: [{ folderId: ai, path: '书签栏 / 人工智能', reason: '模型更新的分类建议' }] };
    await chrome.storage.local.set({ pending });
  }, { id: nativeId, ai: seeded.ai });
  await automatic.getByText('模型更新的分类建议', { exact: true }).waitFor();
  assert.equal(await automatic.getByLabel('选择已有文件夹').inputValue(), seeded.design);
  await automatic.screenshot({ path: path.join(artifacts, 'native-auto-review.png') });
  await automatic.getByRole('button', { name: '确认归类' }).click();
  await automatic.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await worker.evaluate(async id => (await chrome.bookmarks.get(id))[0].parentId, nativeId), seeded.design);
  // Clearing indexes must invalidate the lazily loaded search cache as well.
  await page.getByRole('button', { name: '全部书签' }).click();
  await page.getByRole('searchbox').fill('only-body-needle');
  await page.waitForFunction(() => document.querySelectorAll('.bookmark-card').length === 6 && !document.getElementById('results').textContent.includes('正在搜索已索引正文'));
  await page.getByRole('button', { name: '模型与偏好设置' }).click();
  await page.getByRole('button', { name: '清除正文索引', exact: true }).click();
  await page.getByRole('button', { name: '确认清除索引', exact: true }).click();
  await page.locator('#toast').filter({ hasText: '已清除本地正文索引' }).waitFor();
  await page.getByRole('button', { name: '全部书签' }).click();
  await page.getByRole('searchbox').fill('only-body-needle');
  await page.getByRole('heading', { name: '暂时没有找到相关书签' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: real Chrome APIs, saved/unsaved current-page button, live URL and deletion updates, no duplicate/title overwrite on adjust, search, move, native auto-popup, live AI result, manual selection preservation and responsive layout.');
  console.log('Screenshots saved in artifacts/. No personal browser profile or bookmarks were used.');
} finally { await context.close(); }
