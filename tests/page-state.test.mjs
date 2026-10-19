import test from 'node:test';
import assert from 'node:assert/strict';
import { queryCurrentStatus } from '../extension/page-state.js';

function api({ url = 'https://example.com/saved#section', managed = false } = {}) {
  return {
    runtime: { sendMessage() { throw Error('Worker unavailable'); } },
    tabs: { async query() { return [{ id: 7, url, title: 'Current page' }]; } },
    bookmarks: {
      async search({ query }) { return [{ id: '9', parentId: '2', title: 'Saved title', url: 'https://example.com/saved#old' }, { id: '10', url: 'https://example.com/saved/extra' }].filter(b => b.url.includes(query)); },
      async get(id) { return [{ id, ...(id === '2' ? { title: 'Articles', parentId: '1', unmodifiable: managed ? 'managed' : undefined } : id === '1' ? { title: 'Bookmarks', parentId: 'root' } : { title: '' }) }]; },
      getTree() { throw Error('Full library must not load'); }
    }
  };
}
test('current-page state works while worker is unavailable and preserves saved title/path across URL fragments', async () => {
  const result = await queryCurrentStatus(api());
  assert.equal(result.current.bookmarkId, '9');
  assert.equal(result.bookmark.title, 'Saved title');
  assert.equal(result.bookmark.path, 'Bookmarks / Articles');
});
test('current-page state excludes partial URL matches and inherits managed-folder restrictions', async () => {
  assert.equal((await queryCurrentStatus(api({ url: 'https://example.com/save' }))).bookmark, null);
  assert.equal((await queryCurrentStatus(api({ managed: true }))).bookmark.managed, true);
  assert.equal((await queryCurrentStatus(api({ url: 'chrome://settings/' }))).current.supported, false);
});
