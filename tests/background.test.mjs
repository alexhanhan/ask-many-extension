import test from 'node:test';
import assert from 'node:assert/strict';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const local = {}, session = {}, reads = [];
function storage(data) { return {
  async get(keys) { if (data === local) reads.push(keys); if (keys == null) return structuredClone(data); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
  async set(value) { Object.assign(data, structuredClone(value)); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  async setAccessLevel() {}
}; }
const tree = [{ id: '0', children: [{ id: '1', title: '书签栏', parentId: '0', children: [{ id: '10', title: '开发技术', parentId: '1', children: [] }, { id: '11', title: '阅读', parentId: '1', children: [] }] }] }];
let counter = 100, permission = true, badgeText = '';
let activeUrl = 'https://react.dev';
function find(id, nodes = tree) { for (const node of nodes) { if (node.id === id) return node; const child = find(id, node.children || []); if (child) return child; } }
globalThis.chrome = {
  runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, onMessage: event(), onInstalled: event(), onStartup: event() },
  storage: { local: storage(local), session: storage(session) },
  permissions: { async contains() { return permission; } },
  action: { async setBadgeText({ text }) { badgeText = text; }, async setBadgeBackgroundColor() {} },
  notifications: { async clear() {}, async create() {}, onClicked: event(), onButtonClicked: event() },
  tabs: { async query() { return [{ id: 5, title: 'React', url: activeUrl }]; }, async create() {} },
  scripting: { async executeScript() { return [{ result: { title: 'React', content: 'private full-text keyword', description: 'React reference' } }]; } },
  bookmarks: {
    async getTree() { return structuredClone(tree); }, async get(id) { if (!find(id)) throw Error('Not found'); return [structuredClone(find(id))]; },
    async search({ query }) { const nodes = []; function visit(node) { if (node.url?.includes(query)) nodes.push(structuredClone(node)); for (const child of node.children || []) visit(child); } tree.forEach(visit); return nodes; },
    async create(value) { const node = { ...value, id: String(counter++), dateAdded: Date.now() }; find(value.parentId).children.push(node); this.onCreated.emit(node.id, node); return structuredClone(node); },
    async move(id, { parentId }) { const node = find(id); const from = find(node.parentId); from.children = from.children.filter(n => n.id !== id); node.parentId = parentId; find(parentId).children.push(node); return structuredClone(node); },
    async update(id, value) { Object.assign(find(id), value); return structuredClone(find(id)); },
    onCreated: event(), onRemoved: event(), onImportBegan: event(), onImportEnded: event()
  }
};
await import('../extension/background.js');
const sender = { id: 'test', url: 'chrome-extension://test/popup.html' };
function message(type, payload = {}, origin = sender) {
  return new Promise(resolve => { const keep = chrome.runtime.onMessage.listeners[0]({ type, payload }, origin, resolve); if (!keep) resolve(null); });
}
async function eventually(condition) { for (let i = 0; i < 40; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Timed out'); }

test('background integration with actual message handlers', async t => {
  await t.test('does not accept external or page-origin messages', async () => {
    assert.equal(await message('library', {}, { id: 'test', url: 'https://example.com' }), null);
    assert.equal(await message('library', {}, { id: 'other', url: 'chrome-extension://test/popup.html' }), null);
  });
  await t.test('current page captures title and body on an explicit extension action', async () => {
    const result = await message('currentPage');
    assert.equal(result.ok, true); assert.match(result.data.content, /full-text/);
  });
  let id;
  await t.test('current page initially reports unsaved without reading page content', async () => {
    const result = await message('library', { includeCurrent: true });
    assert.equal(result.data.current.bookmarkId, null);
    assert.equal(result.data.current.supported, true);
  });
  await t.test('extension save creates a bookmark and index without generating a pending native recommendation', async () => {
    const result = await message('savePage', { folderId: '10', page: { title: 'React', url: 'https://react.dev', content: 'full-text needle' } });
    assert.equal(result.ok, true); id = result.data.id;
    await new Promise(resolve => setTimeout(resolve, 40));
    const library = await message('library');
    assert.equal(library.data.bookmarks.length, 1); assert.equal(library.data.metadata[id].content, 'full-text needle'); assert.equal(Object.keys(library.data.pending).length, 0);
  });
  await t.test('duplicate save moves existing bookmark and refreshes index', async () => {
    const result = await message('savePage', { folderId: '11', page: { title: 'Updated React', url: 'https://react.dev/#hash', content: 'updated' } });
    assert.equal(result.data.existed, true); assert.equal(result.data.id, id); assert.equal(find(id).parentId, '11');
    assert.equal(local['page:' + id].content, 'updated');
  });
  await t.test('popup library reads only summaries, excluding full bodies and organizer records', async () => {
    local.organizerHistory = { large: 'private history '.repeat(1000) };
    const start = reads.length;
    const result = await message('library', { summary: true, includeCurrent: true });
    assert.equal(result.data.metadata[id].hasContent, true);
    assert.equal(result.data.metadata[id].content, undefined);
    assert.equal(result.data.organizerHistory, undefined);
    assert.equal(JSON.stringify(result).includes('private history'), false);
    assert.ok(reads.slice(start).every(keys => keys != null && !(Array.isArray(keys) && keys.some(key => key.startsWith('page:')))));
  });
  await t.test('legacy index migration is bounded and remembers bookmarks without body indexes', async () => {
    delete local.pageCatalog[id];
    assert.ok((await message('library', { summary: true })).data.missingSummaryIds.includes(id));
    const result = await message('pageSummaries', { ids: [id, 'no-index'] });
    assert.equal(result.data.metadata[id].hasContent, true);
    assert.equal(result.data.metadata[id].content, undefined);
    assert.equal(local.pageCatalog['no-index'], null);
    assert.ok(!(await message('library', { summary: true })).data.missingSummaryIds.includes(id));
    assert.equal((await message('pageSummaries', { ids: Array(21).fill(id) })).ok, false);
  });
  await t.test('body search loads only explicitly requested indexes in bounded batches', async () => {
    const result = await message('pageContents', { ids: [id] });
    assert.equal(result.data.metadata[id].content, 'updated');
    assert.deepEqual(Object.keys(result.data.metadata), [id]);
    assert.equal((await message('pageContents', { ids: Array(51).fill(id) })).ok, false);
  });
  await t.test('current page detects saved state across fragments and reports its real folder', async () => {
    activeUrl = 'https://react.dev/#section';
    const result = await message('library', { includeCurrent: true });
    assert.equal(result.data.current.bookmarkId, id);
    assert.equal(result.data.bookmarks.find(b => b.id === id).path, '书签栏 / 阅读');
    activeUrl = 'https://example.com/unsaved';
    assert.equal((await message('library', { includeCurrent: true })).data.current.bookmarkId, null);
    activeUrl = 'chrome://settings/';
    assert.equal((await message('library', { includeCurrent: true })).data.current.supported, false);
    activeUrl = 'https://react.dev';
  });
  await t.test('lightweight popup status preserves saved state without tree or storage reads', async () => {
    const original = chrome.bookmarks.getTree;
    chrome.bookmarks.getTree = async () => { throw Error('Full library must not be loaded'); };
    const start = reads.length;
    try {
      activeUrl = 'https://react.dev/#another-fragment';
      const result = await message('currentStatus');
      assert.equal(result.ok, true); assert.equal(result.data.current.bookmarkId, id);
      assert.equal(result.data.bookmark.path, '书签栏 / 阅读');
      assert.equal(result.data.bookmark.managed, false);
      assert.equal(result.data.bookmarks, undefined); assert.equal(result.data.metadata, undefined);
      activeUrl = 'https://example.com/unsaved';
      assert.equal((await message('currentStatus')).data.bookmark, null);
      activeUrl = 'chrome://settings/';
      assert.equal((await message('currentStatus')).data.current.supported, false);
      assert.equal(reads.length, start);
    } finally { chrome.bookmarks.getTree = original; activeUrl = 'https://react.dev'; }
  });
  await t.test('adjusting a saved page preserves its ID, URL, title and bookmark count', async () => {
    const before = (await message('library')).data.bookmarks.length;
    const old = structuredClone(find(id));
    assert.equal((await message('move', { id, folderId: '10' })).ok, true);
    assert.equal(find(id).title, old.title); assert.equal(find(id).url, old.url);
    assert.equal((await message('library')).data.bookmarks.length, before);
    assert.equal((await message('refreshCurrentIndex', { id })).ok, true);
    assert.match(local['page:' + id].content, /full-text/);
    assert.equal(find(id).title, old.title);
    activeUrl = 'https://example.com/another-page';
    assert.equal((await message('refreshCurrentIndex', { id })).ok, false);
    activeUrl = 'https://react.dev';
  });
  await t.test('saving to stale folder or unsupported URL does not mutate existing bookmarks', async () => {
    assert.equal((await message('savePage', { folderId: '404', page: { url: 'https://example.com' } })).ok, false);
    assert.equal((await message('savePage', { folderId: '10', page: { url: 'javascript:alert(1)' } })).ok, false);
  });
  await t.test('native create generates pending suggestion and badge; dismiss preserves original folder', async () => {
    const native = await chrome.bookmarks.create({ parentId: '10', title: 'Native bookmark', url: 'https://example.com/native' });
    await eventually(() => local.pending?.[native.id]?.items?.length > 0);
    assert.equal(badgeText, '1');
    await message('dismiss', { id: native.id });
    assert.equal(local.pending[native.id], undefined); assert.equal(find(native.id).parentId, '10'); assert.equal(badgeText, '');
  });
  await t.test('revoked API permission blocks configuration; API Key never appears in library responses', async () => {
    permission = false;
    const value = { baseUrl: 'https://api.example.com/v1', apiKey: 'sensitive-secret', model: 'model' };
    assert.equal((await message('saveSettings', { value })).ok, false);
    permission = true; assert.equal((await message('saveSettings', { value })).ok, true);
    const library = await message('library');
    assert.equal(JSON.stringify(library).includes('sensitive-secret'), false); assert.equal(library.data.settings.hasKey, true);
    await message('saveSettings', { value: { ...value, apiKey: '' } }); assert.equal(local.settings.apiKey, 'sensitive-secret');
  });
  await t.test('preferences persist locally without needing remote host permission', async () => {
    permission = false;
    const result = await message('savePreferences', { value: { indexContent: false, monitorNative: false, notifications: false } });
    assert.equal(result.ok, true); assert.equal(local.settings.indexContent, false); assert.equal(local.settings.apiKey, 'sensitive-secret');
    const result2 = await message('savePage', { folderId: '10', page: { title: 'No body', url: 'https://example.com/no-body', content: 'should not store' } });
    assert.equal(local['page:' + result2.data.id].content, '');
  });
  await t.test('revoked permission clearly reports local fallback and install setup preserves user settings', async () => {
    const result = await message('recommend', { page: { title: 'React', url: 'https://react.dev' } });
    assert.equal(result.data.source, 'local'); assert.match(result.data.warning, /授权已撤销/);
    assert.equal((await message('library')).data.settings.apiReady, false);
    chrome.runtime.onInstalled.emit();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(local.settings.apiKey, 'sensitive-secret');
  });
  await t.test('bulk import does not create suggestions and clear-index preserves bookmarks', async () => {
    await message('savePreferences', { value: { monitorNative: true } });
    chrome.bookmarks.onImportBegan.emit();
    const imported = await chrome.bookmarks.create({ parentId: '10', title: 'Imported', url: 'https://example.com/import' });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(local.pending?.[imported.id], undefined);
    chrome.bookmarks.onImportEnded.emit();
    const before = (await message('library')).data.bookmarks.length;
    await message('clearIndex');
    assert.equal(Object.keys((await message('library')).data.metadata).length, 0);
    assert.equal((await message('library')).data.bookmarks.length, before);
  });
});
