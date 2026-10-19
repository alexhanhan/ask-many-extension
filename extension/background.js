import { DEFAULT_SETTINGS, flattenTree, safePageUrl, normalizedUrl, validateSettings, permissionOrigin, callModel, recommend } from './core.js';
import { openNativeReview } from './native-flow.js';
import { createOrganizerService } from './organizer.js';
import { queryCurrentStatus } from './page-state.js';

// Optional, ignored, unpacked-development-only credentials. Release packaging
// excludes this file. Import once; future UI configuration always takes priority.
async function importLocalSettings() {
  const { localConfigImported } = await chrome.storage.local.get('localConfigImported');
  if (localConfigImported) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(chrome.runtime.getURL('local-settings.json'), { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return;
    const input = await response.json();
    const value = validateSettings({ ...DEFAULT_SETTINGS, ...input });
    if (new URL(value.baseUrl).origin !== 'https://api.deepseek.com') return;
    await chrome.storage.local.set({ settings: { ...value, configured: true }, localConfigImported: true });
  } catch { /* Release distributions intentionally contain no private file. */ }
  finally { clearTimeout(timeout); }
}
const ready = importLocalSettings();

let writes = Promise.resolve();
function serialize(fn) { const next = writes.then(fn, fn); writes = next.catch(() => {}); return next; }
async function settings({ waitForImport = true } = {}) { if (waitForImport) await ready; const data = await chrome.storage.local.get('settings'); return { ...DEFAULT_SETTINGS, ...data.settings }; }
async function publicSettings(options) {
  const value = await settings(options);
  const { apiKey, ...safe } = value;
  const permitted = await chrome.permissions.contains({ origins: [permissionOrigin(value.baseUrl)] });
  return { ...safe, hasKey: !!apiKey, apiReady: !!value.configured && permitted };
}
async function effectiveSettings() {
  const value = await settings();
  const permitted = await chrome.permissions.contains({ origins: [permissionOrigin(value.baseUrl)] });
  return { ...value, configured: !!value.configured && permitted, unavailableReason: value.configured && !permitted ? 'API 站点授权已撤销，当前使用本地推荐；可在设置中重新保存并授权' : '' };
}
async function badge() {
  const { pending = {} } = await chrome.storage.local.get('pending');
  const count = Object.keys(pending).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#247465' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}
async function mutatePending(fn) {
  return serialize(async () => {
    const { pending = {} } = await chrome.storage.local.get('pending');
    fn(pending);
    await chrome.storage.local.set({ pending });
    await badge();
  });
}
async function resolvePending(id) {
  await mutatePending(pending => { delete pending[id]; });
  await chrome.notifications.clear(`bookmark-${id}`);
}
function pageSummary(value) { return value ? { description: value.description || '', hasContent: !!value.content, capturedAt: value.capturedAt || 0 } : null; }
async function writePageIndex(id, value) {
  return serialize(async () => {
    const { pageCatalog = {} } = await chrome.storage.local.get('pageCatalog');
    pageCatalog[id] = pageSummary(value);
    await chrome.storage.local.set({ ['page:' + id]: value, pageCatalog });
  });
}
async function pageSummaries({ ids }) {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string')) throw new Error('索引摘要批次无效');
  return serialize(async () => {
    const { pageCatalog = {} } = await chrome.storage.local.get('pageCatalog');
    const missing = ids.filter(id => !(id in pageCatalog));
    const pages = missing.length ? await chrome.storage.local.get(missing.map(id => 'page:' + id)) : {};
    const metadata = {};
    for (const id of ids) {
      if (!(id in pageCatalog)) pageCatalog[id] = pageSummary(pages['page:' + id]);
      if (pageCatalog[id]) metadata[id] = pageCatalog[id];
    }
    if (missing.length) await chrome.storage.local.set({ pageCatalog });
    return { metadata };
  });
}
async function getPageContents({ ids }) {
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string')) throw new Error('正文搜索批次无效');
  const values = await chrome.storage.local.get(ids.map(id => 'page:' + id));
  return { metadata: Object.fromEntries(ids.filter(id => values['page:' + id]).map(id => [id, values['page:' + id]])) };
}
async function getLibrary({ includeCurrent = false, summary = false } = {}) {
  const [tree, data, config, tabs] = await Promise.all([
    chrome.bookmarks.getTree(), chrome.storage.local.get(['pending', 'pageCatalog']), publicSettings({ waitForImport: false }),
    includeCurrent ? chrome.tabs.query({ active: true, currentWindow: true }).catch(() => null) : null
  ]);
  const library = flattenTree(tree);
  let current = null;
  if (includeCurrent) {
    const tab = tabs?.[0];
    if (!tab?.url) current = { error: '暂时无法读取当前页，请重试' };
    else {
      const bookmark = library.bookmarks.find(b => normalizedUrl(b.url) === normalizedUrl(tab.url));
      current = { tabId: tab.id, url: tab.url, title: tab.title || tab.url, supported: safePageUrl(tab.url), bookmarkId: bookmark?.id || null };
    }
  }
  const metadata = {};
  if (summary) { for (const bookmark of library.bookmarks) if (data.pageCatalog?.[bookmark.id]) metadata[bookmark.id] = data.pageCatalog[bookmark.id]; }
  else {
    const pages = await chrome.storage.local.get(library.bookmarks.map(b => 'page:' + b.id));
    for (const bookmark of library.bookmarks) if (pages['page:' + bookmark.id]) metadata[bookmark.id] = pages['page:' + bookmark.id];
  }
  return { ...library, metadata, missingSummaryIds: library.bookmarks.filter(b => !(b.id in (data.pageCatalog || {}))).map(b => b.id), pending: data.pending || {}, settings: config, current };
}
async function targetFolder(id) {
  const { folders } = flattenTree(await chrome.bookmarks.getTree());
  const folder = folders.find(f => f.id === id && !f.managed);
  if (!folder) throw new Error('目录已删除或不可写入，请重新选择');
  return folder;
}
async function getCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !safePageUrl(tab.url)) throw new Error('请在普通 HTTP(S) 网页上点击插件收藏；Chrome 内部页面无法读取');
  const page = { title: tab.title || tab.url, url: tab.url, description: '', content: '' };
  const config = await settings();
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (capture) => ({
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content?.slice(0, 1000) || '',
        content: capture ? (document.querySelector('article, main') || document.body)?.innerText?.slice(0, 80000) || '' : ''
      }), args: [config.indexContent]
    });
    Object.assign(page, result?.result || {});
  } catch { page.captureWarning = '此页面不允许读取正文，仍可收藏和搜索标题、网址'; }
  return page;
}
async function savePage(payload) {
  const { page, folderId } = payload;
  if (!page || !safePageUrl(page.url)) throw new Error('仅支持收藏 HTTP(S) 网页');
  await targetFolder(folderId);
  const { bookmarks } = flattenTree(await chrome.bookmarks.getTree());
  let bookmark = bookmarks.find(b => normalizedUrl(b.url) === normalizedUrl(page.url));
  if (bookmark?.managed) throw new Error('该书签由管理员管理，无法移动');
  const existed = !!bookmark;
  if (bookmark) {
    await chrome.bookmarks.move(bookmark.id, { parentId: folderId });
    bookmark = await chrome.bookmarks.update(bookmark.id, { title: String(page.title || page.url).slice(0, 1000) });
  } else {
    // Persist suppression before create so onCreated also works across worker suspension.
    await chrome.storage.session.set({ ['own:' + page.url]: Date.now() });
    try { bookmark = await chrome.bookmarks.create({ title: String(page.title || page.url).slice(0, 1000), url: page.url, parentId: folderId }); }
    catch (error) { await chrome.storage.session.remove('own:' + page.url); throw error; }
  }
  const config = await settings();
  let indexWarning = '';
  try {
    await writePageIndex(bookmark.id, { description: String(page.description || '').slice(0, 1000), content: config.indexContent ? String(page.content || '').slice(0, 80000) : '', capturedAt: Date.now() });
  } catch { indexWarning = '书签已保存，但正文索引写入失败'; }
  await resolvePending(bookmark.id);
  return { id: bookmark.id, existed, indexWarning };
}
async function handleCreated(id, node) {
  if (!node.url || node.unmodifiable) return;
  const session = await chrome.storage.session.get(['importing', 'own:' + node.url]);
  const own = session['own:' + node.url];
  if (own && Date.now() - own < 15000) { await chrome.storage.session.remove('own:' + node.url); return; }
  if (session.importing) return;
  const config = await effectiveSettings();
  if (!config.monitorNative) return;
  const tree = await chrome.bookmarks.getTree();
  const bm = flattenTree(tree).bookmarks.find(b => b.id === id);
  if (!bm || bm.managed) return;
  const local = await recommend(node, tree, { ...config, configured: false });
  await mutatePending(pending => { pending[id] = { id, title: node.title, url: node.url, parentId: node.parentId, createdAt: Date.now(), analyzing: config.configured, ...local }; });
  // Open immediately with local results, then update the same UI when AI returns.
  const presentation = openNativeReview(chrome, node).catch(() => ({ opened: false }));
  const result = config.configured ? await recommend(node, tree, config) : local;
  let remains = false;
  await mutatePending(pending => { if (pending[id]) { pending[id] = { ...pending[id], analyzing: false, ...result }; remains = true; } });
  const surface = await presentation;
  if (remains && !surface.opened && config.notifications) {
    try { await chrome.notifications.create(`bookmark-${id}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: '拾叶 · 为新书签找个位置', message: `${node.title.slice(0, 90)}\n推荐：${result.items[0]?.path || '请手动选择已有目录'}`, buttons: [{ title: '查看归类建议' }] }); } catch { /* Badge remains available if system notifications are disabled. */ }
  }
}
const organizer = createOrganizerService(chrome, effectiveSettings);
const handlers = {
  pageSummaries,
  pageContents: getPageContents,
  organizerGet: () => organizer.snapshot(),
  organizerStart: value => organizer.start(value),
  organizerStep: ({ jobId }) => organizer.step(jobId),
  organizerPause: ({ jobId }) => organizer.pause(jobId),
  organizerEdit: value => organizer.edit(value),
  organizerApply: value => organizer.applyOne(value),
  organizerUndo: value => organizer.undoOne(value),
  library: getLibrary,
  currentStatus: () => queryCurrentStatus(chrome),
  currentPage: getCurrentPage,
  recommend: async ({ page, bookmarkId }) => {
    if (!page) throw new Error('无法识别网页地址');
    if (!safePageUrl(page.url)) {
      const [bookmark] = bookmarkId ? await chrome.bookmarks.get(bookmarkId) : [];
      if (!bookmark?.url || normalizedUrl(bookmark.url) !== normalizedUrl(page.url)) throw new Error('无法识别网页地址');
    }
    return recommend(page, await chrome.bookmarks.getTree(), await effectiveSettings());
  },
  savePage,
  refreshCurrentIndex: async ({ id }) => {
    const config = await settings();
    if (!config.indexContent) throw new Error('正文索引已关闭，请先在设置中开启');
    const [bookmark] = await chrome.bookmarks.get(id);
    if (!bookmark?.url) throw new Error('书签已不存在，请重新打开插件');
    const page = await getCurrentPage();
    if (normalizedUrl(bookmark.url) !== normalizedUrl(page.url)) throw new Error('当前页已改变，请返回该书签对应的网页后重试');
    if (page.captureWarning) throw new Error(page.captureWarning);
    await writePageIndex(id, { description: String(page.description || '').slice(0, 1000), content: String(page.content || '').slice(0, 80000), capturedAt: Date.now() });
    return { ok: true };
  },
  move: async ({ id, folderId }) => {
    await targetFolder(folderId);
    const [node] = await chrome.bookmarks.get(id);
    if (!node?.url || node.unmodifiable) throw new Error('该书签无法移动');
    await chrome.bookmarks.move(id, { parentId: folderId });
    await resolvePending(id);
    return { ok: true };
  },
  dismiss: async ({ id }) => { await resolvePending(id); return { ok: true }; },
  savePreferences: async ({ value }) => {
    const old = await settings();
    for (const key of ['monitorNative', 'notifications', 'indexContent']) if (typeof value[key] === 'boolean') old[key] = value[key];
    await chrome.storage.local.set({ settings: old });
    return publicSettings();
  },
  saveSettings: async ({ value }) => {
    const old = await settings();
    const valid = validateSettings({ ...value, apiKey: value.clearKey ? '' : value.apiKey || old.apiKey });
    const permitted = await chrome.permissions.contains({ origins: [permissionOrigin(valid.baseUrl)] });
    if (!permitted) throw new Error('未获得 API 站点授权，配置未保存');
    await chrome.storage.local.set({ settings: { ...valid, configured: true } });
    return publicSettings();
  },
  testConnection: async ({ value }) => {
    const old = await settings();
    const valid = validateSettings({ ...value, apiKey: value.clearKey ? '' : value.apiKey || old.apiKey });
    if (!await chrome.permissions.contains({ origins: [permissionOrigin(valid.baseUrl)] })) throw new Error('请先授权 API 站点访问');
    await callModel(valid, [{ role: 'user', content: 'Reply only with OK.' }]);
    return { ok: true };
  },
  clearIndex: () => serialize(async () => {
    const data = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(data).filter(key => key.startsWith('page:')));
    await chrome.storage.local.set({ pageCatalog: {} });
    return { ok: true };
  })
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || !handlers[message?.type]) return false;
  Promise.resolve().then(() => handlers[message.type](message.payload || {})).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || '操作失败，请重试' }));
  return true;
});
chrome.bookmarks.onCreated.addListener((id, node) => { handleCreated(id, node).catch(error => console.warn('Recommendation failed:', error.message)); });
chrome.bookmarks.onRemoved.addListener((id, info) => {
  const ids = [];
  function collect(node) { if (!node) return; ids.push(node.id); for (const child of node.children || []) collect(child); }
  collect(info.node);
  if (!ids.includes(id)) ids.push(id);
  chrome.storage.local.remove(ids.map(value => 'page:' + value)).catch(() => {});
  serialize(async () => { const { pageCatalog = {} } = await chrome.storage.local.get('pageCatalog'); for (const value of ids) delete pageCatalog[value]; await chrome.storage.local.set({ pageCatalog }); }).catch(() => {});
  mutatePending(pending => { for (const value of ids) delete pending[value]; }).catch(() => {});
});
chrome.bookmarks.onImportBegan.addListener(() => { chrome.storage.session.set({ importing: true }); });
chrome.bookmarks.onImportEnded.addListener(() => { chrome.storage.session.remove('importing'); });
function openPending(notificationId) {
  if (notificationId.startsWith('bookmark-')) chrome.tabs.create({ url: chrome.runtime.getURL('manager.html#pending') });
}
chrome.notifications.onClicked.addListener(openPending);
chrome.notifications.onButtonClicked.addListener(openPending);
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await badge();
});
chrome.runtime.onStartup.addListener(() => { badge().catch(() => {}); });
