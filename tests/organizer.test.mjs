import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenTree } from '../extension/core.js';
import { makePlan, categoryParts, parseBatch, batchCandidates, classificationMessages } from '../extension/organizer-core.js';
import { createOrganizerService } from '../extension/organizer.js';

function fixture(count = 4) {
  const store = {}, moves = [], creations = [];
  let counter = 500;
  const tree = [{ id: 'root', title: '', children: [{ id: 'bar-42', parentId: 'root', title: '书签栏', children: [
    { id: 'inbox', parentId: 'bar-42', title: '待整理', children: Array.from({ length: count }, (_, i) => ({ id: `b${i}`, parentId: 'inbox', title: i % 2 ? `Figma 设计 ${i}` : `React 开发 ${i}`, url: `https://${i % 2 ? 'figma.com' : 'react.dev'}/page-${i}` })) },
    { id: 'dev', parentId: 'bar-42', title: '前端开发', children: [] },
    { id: 'design', parentId: 'bar-42', title: '设计灵感', children: [] },
    { id: 'managed', parentId: 'bar-42', title: '管理配置', unmodifiable: 'managed', children: [{ id: 'managed-child', parentId: 'managed', title: '受控子目录', children: [{ id: 'managed-bookmark', parentId: 'managed-child', title: '受控书签', url: 'https://example.com' }] }] }
  ] }] }];
  function find(id, nodes = tree) { for (const node of nodes) { if (node.id === id) return node; const result = find(id, node.children || []); if (result) return result; } }
  const api = { storage: { local: {
    async get(keys) { return structuredClone(Object.fromEntries(keys.filter(key => key in store).map(key => [key, store[key]]))); },
    async set(value) { Object.assign(store, structuredClone(value)); }
  } }, bookmarks: {
    async getTree() { return structuredClone(tree); },
    async get(id) { const node = find(id); if (!node) throw Error('Not found'); return [{ ...structuredClone(node), index: find(node.parentId)?.children.findIndex(n => n.id === id) || 0 }]; },
    async getChildren(id) { const node = find(id); if (!node?.children) throw Error('Not a folder'); return structuredClone(node.children); },
    async create(value) { const node = { id: String(counter++), ...value, children: [] }; find(value.parentId).children.push(node); creations.push(node.id); return structuredClone(node); },
    async move(id, { parentId, index }) { const node = find(id), from = find(node.parentId), to = find(parentId); if (!to?.children) throw Error('Missing folder'); from.children = from.children.filter(b => b.id !== id); node.parentId = parentId; to.children.splice(index ?? to.children.length, 0, node); moves.push({ id, parentId }); return structuredClone(node); }
  } };
  const settings = async () => ({ configured: true, baseUrl: 'https://api.example.com/v1', apiKey: 'never-store-this-secret', model: 'test-model' });
  return { api, tree, store, moves, creations, find, settings };
}
const ai = async (config, messages) => {
  const data = JSON.parse(messages[1].content);
  return JSON.stringify({ suggestions: data.bookmarks.map(b => ({ bookmarkId: b.id, folderId: b.title.includes('Figma') ? 'design' : 'dev', reason: '与主题相符' })) });
};

test('plan handles full tree, descendant scope and managed exclusions without fixed root IDs', () => {
  const f = fixture();
  assert.equal(makePlan(f.tree).items.length, 4);
  assert.equal(makePlan(f.tree, { scopeId: 'inbox' }).items.length, 4);
  assert.throws(() => makePlan(f.tree, { scopeId: 'managed' }));
  assert.throws(() => makePlan(f.tree, { scopeId: 'dev' }), /没有可整理/);
  assert.throws(() => makePlan(f.tree, { allowNew: true, rootId: 'missing' }));
  assert.equal(makePlan(f.tree, { allowNew: true, rootId: 'bar-42' }).options.rootPath, '书签栏');
});
test('new category validation enforces three levels and safe relative segments', () => {
  assert.deepEqual(categoryParts('技术 / 前端 / 框架'), ['技术', '前端', '框架']);
  for (const value of ['', 'a//b', '../abc', ['a', 'b', 'c', 'd'], ['x/y'], ['x\\y'], ['a\n'], ['a', 42]]) assert.throws(() => categoryParts(value));
});
test('batch parser validates IDs and destinations, explicitly falls back for missing or invalid rows', () => {
  const f = fixture(), plan = makePlan(f.tree), folders = batchCandidates(plan.items, f.tree);
  const result = parseBatch(JSON.stringify({ suggestions: [{ bookmarkId: 'b0', folderId: 'dev' }, { bookmarkId: 'b0', folderId: 'design' }, { bookmarkId: 'b1', folderId: 'managed-child' }, { bookmarkId: 'unknown', folderId: 'dev' }, { bookmarkId: 'b2', category: ['未经允许的新目录'] }] }), plan.items, folders, plan.options, f.tree);
  assert.equal(result[0].folderId, 'dev');
  assert.equal(result[0].source, 'ai');
  for (const row of result.slice(1)) { assert.equal(row.source, 'local'); assert.ok(row.warning); assert.notEqual(row.folderId, 'managed-child'); }
  assert.throws(() => parseBatch('{}', plan.items, folders, plan.options, f.tree));
  const messages = classificationMessages(plan.items, folders, plan.options);
  assert.equal(messages[1].content.includes('never-store-this-secret'), false);
});
test('analysis uses 20-item batches, persists progress across services and never moves during preview', async () => {
  const f = fixture(43), calls = [];
  const model = async (...args) => { calls.push(JSON.parse(args[1][1].content).bookmarks.length); assert.equal(args[3].maxTokens, 4096); return ai(...args); };
  let service = createOrganizerService(f.api, f.settings, model);
  let result = await service.start({ engine: 'ai', scopeId: 'inbox' });
  const id = result.job.id;
  result = await service.step(id); assert.equal(result.job.cursor, 20); assert.equal(result.job.status, 'paused');
  service = createOrganizerService(f.api, f.settings, model);
  result = await service.step(id); result = await service.step(id);
  assert.deepEqual(calls, [20, 20, 3]); assert.equal(result.job.status, 'ready');
  assert.equal(result.job.items.filter(b => b.status === 'suggested').length, 43);
  assert.equal(f.moves.length, 0); assert.equal(f.creations.length, 0);
  assert.equal(JSON.stringify(result).includes('never-store-this-secret'), false);
});
test('batch API failure remains visible and does not discard later successful batches', async () => {
  const f = fixture(22); let calls = 0;
  const service = createOrganizerService(f.api, f.settings, async (...args) => { if (!calls++) throw Error('模拟 API 429'); return ai(...args); });
  const { job } = await service.start({ engine: 'ai' });
  await service.step(job.id); const result = await service.step(job.id);
  assert.equal(result.job.items.filter(b => b.source === 'local' && b.warning.includes('429')).length, 20);
  assert.equal(result.job.items.filter(b => b.source === 'ai').length, 2);
  assert.equal(result.job.status, 'ready');
});
test('pause aborts an in-flight batch, preserves cursor and prevents concurrent execution', async () => {
  const f = fixture(); let started;
  const signalReady = new Promise(resolve => { started = resolve; });
  const service = createOrganizerService(f.api, f.settings, async (settings, messages, fetcher, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); started(); }));
  const { job } = await service.start({ engine: 'ai' });
  const first = service.step(job.id); await signalReady;
  await assert.rejects(service.step(job.id), /正在处理/);
  await service.pause(job.id); await first;
  const data = await service.snapshot(); assert.equal(data.job.cursor, 0); assert.equal(data.job.status, 'paused');
  const restarted = createOrganizerService(f.api, f.settings, ai);
  assert.equal((await restarted.step(job.id)).job.cursor, 4);
});
test('applying a preview preserves IDs/title/URL, creates only approved paths, reuses directories and can undo exact order', async () => {
  const f = fixture(), before = f.find('inbox').children.map(b => b.id);
  const service = createOrganizerService(f.api, f.settings, async (settings, messages) => JSON.stringify({ suggestions: JSON.parse(messages[1].content).bookmarks.map(b => ({ bookmarkId: b.id, category: ['技术', '前端', '框架'] })) }));
  const { job } = await service.start({ engine: 'ai', allowNew: true, rootId: 'bar-42' });
  await service.step(job.id); assert.equal(f.creations.length, 0);
  for (const id of before) await service.applyOne({ jobId: job.id, id });
  assert.equal(f.creations.length, 3); assert.equal(f.moves.length, 4);
  assert.equal(f.find('b0').title, 'React 开发 0'); assert.equal(f.find('b0').url, 'https://react.dev/page-0');
  let data = await service.snapshot();
  for (const entry of data.history.slice().reverse()) await service.undoOne({ id: entry.id });
  assert.deepEqual(f.find('inbox').children.map(b => b.id), before);
  assert.equal(flattenTree(await f.api.bookmarks.getTree()).bookmarks.length, 5);
  assert.equal(f.creations.length, 3);
  data = await service.snapshot(); assert.ok(data.history.every(e => e.status === 'undone'));
});
test('stale source, managed/deleted destinations and external changes are not overwritten', async () => {
  const f = fixture(), service = createOrganizerService(f.api, f.settings, ai);
  const { job } = await service.start({ engine: 'ai' }); await service.step(job.id);
  f.find('b0').title = '用户后来改名';
  assert.equal((await service.applyOne({ jobId: job.id, id: 'b0' })).job.items[0].status, 'failed');
  await assert.rejects(service.edit({ jobId: job.id, id: 'b1', target: { folderId: 'managed-child' } }));
  await service.applyOne({ jobId: job.id, id: 'b1' });
  const entry = (await service.snapshot()).history[0];
  await f.api.bookmarks.move('b1', { parentId: 'dev' });
  const result = await service.undoOne({ id: entry.id });
  assert.equal(result.history[0].status, 'conflict'); assert.equal(f.find('b1').parentId, 'dev');
});
test('editing/ignoring suggestions affects only the plan; old journal survives a new analysis', async () => {
  const f = fixture(), service = createOrganizerService(f.api, f.settings, ai);
  const { job } = await service.start({ engine: 'local' }); await service.step(job.id);
  await service.edit({ jobId: job.id, id: 'b0', target: { folderId: 'design' } });
  await service.edit({ jobId: job.id, id: 'b1', ignored: true });
  assert.equal(f.moves.length, 0);
  await assert.rejects(service.applyOne({ jobId: job.id, id: 'b1' }));
  await service.applyOne({ jobId: job.id, id: 'b0' });
  const next = await service.start({ engine: 'local' });
  assert.equal(next.history.length, 1); assert.notEqual(next.job.id, job.id);
});
test('a worker restart reconciles prepared and partially undone moves from the actual tree', async () => {
  const f = fixture(), service = createOrganizerService(f.api, f.settings, ai);
  const { job } = await service.start({ engine: 'ai' }); await service.step(job.id); await service.applyOne({ jobId: job.id, id: 'b0' });
  f.store.organizerHistory[0].status = 'prepared'; f.store.organizerJob.items[0].status = 'suggested';
  let result = await createOrganizerService(f.api, f.settings, ai).snapshot();
  assert.equal(result.history[0].status, 'applied'); assert.equal(result.job.items[0].status, 'applied');
  f.store.organizerHistory[0].status = 'undoing';
  await f.api.bookmarks.move('b0', { parentId: 'inbox', index: 0 });
  result = await createOrganizerService(f.api, f.settings, ai).snapshot();
  assert.equal(result.history[0].status, 'undone'); assert.equal(result.job.items[0].status, 'suggested');
});
test('a source changed while a new destination is being created is checked again before moving', async () => {
  const f = fixture(), original = f.api.bookmarks.create;
  f.api.bookmarks.create = async value => { const folder = await original(value); f.find('b0').title = '在分析后手动改名'; return folder; };
  const service = createOrganizerService(f.api, f.settings, async () => JSON.stringify({ suggestions: [{ bookmarkId: 'b0', category: ['新分类'] }] }));
  const { job } = await service.start({ engine: 'ai', allowNew: true, rootId: 'bar-42' });
  await service.step(job.id); const result = await service.applyOne({ jobId: job.id, id: 'b0' });
  assert.equal(result.job.items[0].status, 'failed'); assert.equal(f.find('b0').parentId, 'inbox'); assert.equal(f.moves.length, 0);
});
