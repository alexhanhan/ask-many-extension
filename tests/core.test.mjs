import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenTree, searchBookmarks, rankFolders, validateSettings, permissionOrigin, parseRecommendations, recommend, callModel, normalizedUrl } from '../extension/core.js';

const tree = [{ id: '0', title: '', children: [
  { id: '1', parentId: '0', title: '书签栏', children: [
    { id: '10', parentId: '1', title: '前端开发', children: [{ id: '20', parentId: '10', title: 'React 文档', url: 'https://react.dev/learn', dateAdded: 100 }] },
    { id: '11', parentId: '1', title: '设计灵感', children: [] },
    { id: '12', parentId: '1', title: '受管理', unmodifiable: 'managed', children: [{ id: '13', parentId: '12', title: '子文件夹', children: [] }] }
  ] }
] }];
const settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'secret', model: 'test-model', configured: true };
const response = value => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: value } }] }) });

test('tree preserves complete paths and inherited managed state; root is excluded', () => {
  const data = flattenTree(tree);
  assert.equal(data.folders.length, 5);
  assert.equal(data.bookmarks[0].path, '书签栏 / 前端开发');
  assert.deepEqual(data.bookmarks[0].ancestorIds, ['1', '10']);
  assert.equal(data.folders.find(f => f.id === '13').managed, true);
});
test('search covers every bookmark and indexed body, supports multiple terms and descendant scope', () => {
  const { bookmarks } = flattenTree(tree);
  const metadata = { '20': { content: '仅存在于正文的状态管理 Hook' } };
  for (const query of ['React', 'react.dev', '前端开发', '状态管理 hook']) assert.equal(searchBookmarks(bookmarks, metadata, query).length, 1);
  assert.equal(searchBookmarks(bookmarks, metadata, 'React', '1').length, 1);
  assert.equal(searchBookmarks(bookmarks, metadata, 'React', '11').length, 0);
  assert.equal(searchBookmarks(bookmarks, metadata, 'React 不存在').length, 0);
});
test('local ranking prefers existing same-site folders and excludes managed folders', () => {
  const { folders, bookmarks } = flattenTree(tree);
  const result = rankFolders({ title: 'React reference', url: 'https://react.dev/reference' }, folders, bookmarks);
  assert.equal(result[0].folderId, '10');
  assert.equal(result.some(r => ['12', '13'].includes(r.folderId)), false);
});
test('configuration normalizes paths and restricts remote plaintext / malformed endpoint', () => {
  const valid = validateSettings({ ...settings, baseUrl: 'https://api.example.com/v1///' });
  assert.equal(valid.baseUrl, 'https://api.example.com/v1');
  assert.equal(permissionOrigin(valid.baseUrl), 'https://api.example.com/*');
  assert.doesNotThrow(() => validateSettings({ ...settings, baseUrl: 'http://127.0.0.1:11434/v1' }));
  for (const baseUrl of ['http://example.com/v1', 'file:///x', 'https://user:pass@example.com', 'https://api.example.com/v1/chat/completions', 'https://example.com/v1?key=secret']) assert.throws(() => validateSettings({ ...settings, baseUrl }));
});
test('a newly saved bookmark does not bias local ranking toward its current folder', () => {
  const { folders } = flattenTree(tree);
  const page = { title: 'Figma design', url: 'https://figma.com' };
  const bookmarks = [{ id: 'new', title: page.title, url: page.url, parentId: '10' }];
  assert.equal(rankFolders(page, folders, bookmarks)[0].folderId, '11');
});
test('model cannot invent folders or choose managed destinations, duplicates removed', () => {
  const { folders } = flattenTree(tree);
  const result = parseRecommendations('```json\n{"recommendations":[{"folderId":"10","reason":"适合开发"},{"folderId":"10"},{"folderId":"12"},{"folderId":"999"}]}\n```', folders);
  assert.equal(result.length, 1); assert.equal(result[0].folderId, '10');
  assert.throws(() => parseRecommendations('{"recommendations":[{"folderId":"999"}]}', folders));
});
test('model request sends short metadata only; secret stays in authorization header', async () => {
  let captured;
  const fetcher = async (url, options) => { captured = { url, ...options }; return response('{"recommendations":[{"folderId":"11","reason":"设计资源"}]}')(); };
  const result = await recommend({ title: 'Figma', url: 'https://figma.com', content: 'PRIVATE PAGE BODY' }, tree, settings, fetcher);
  assert.equal(result.source, 'ai'); assert.equal(result.items[0].folderId, '11');
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer secret');
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.body.includes('PRIVATE PAGE BODY'), false);
  assert.equal(captured.body.includes('secret'), false);
});
test('invalid JSON, unavailable API and empty outputs fall back to valid local recommendations', async () => {
  for (const fetcher of [response('invalid'), response('{"recommendations":[{"folderId":"999"}]}'), async () => ({ ok: false, status: 401 }), response('')]) {
    const result = await recommend({ title: 'React', url: 'https://react.dev' }, tree, settings, fetcher);
    assert.equal(result.source, 'local'); assert.equal(result.items[0].folderId, '10'); assert.ok(result.warning);
  }
});
test('unconfigured mode never contacts a model, empty directory tree remains safe', async () => {
  const result = await recommend({ title: 'React', url: 'https://react.dev' }, tree, { configured: false }, () => { throw Error('must not request'); });
  assert.equal(result.source, 'local');
  const empty = await recommend({}, [{ id: '0', children: [] }], settings);
  assert.deepEqual(empty.items, []);
});
test('API handles aborted requests and missing text without leaking server error details', async () => {
  await assert.rejects(callModel(settings, [], async () => { const err = new Error(); err.name = 'AbortError'; throw err; }), /超时/);
  await assert.rejects(callModel(settings, [], async () => ({ ok: false, status: 500, text: async () => 'secret' })), error => !error.message.includes('secret'));
});
test('DeepSeek V4 classification explicitly uses non-thinking mode without changing other providers', async () => {
  let payload;
  await callModel({ ...settings, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, [], async (url, options) => {
    payload = JSON.parse(options.body);
    return response('OK')();
  });
  assert.equal(payload.thinking.type, 'disabled');
  assert.equal(payload.model, 'deepseek-v4-pro');
});
test('duplicate matching ignores fragments and trailing slash', () => {
  assert.equal(normalizedUrl('https://react.dev/#hello'), normalizedUrl('https://react.dev'));
});
