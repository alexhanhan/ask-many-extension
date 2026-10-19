import test from 'node:test';
import assert from 'node:assert/strict';
import { openNativeReview } from '../extension/native-flow.js';

function mock(overrides = {}) {
  const calls = [];
  return { calls, runtime: { getURL: path => 'chrome-extension://test/' + path },
    tabs: { async query() { return [{ id: 5, windowId: 8, url: overrides.url || 'https://example.com/page', active: true }]; } },
    windows: { async get() { return { focused: overrides.focused !== false, type: 'normal' }; }, async create(value) { calls.push(['window', value]); } },
    action: { async setPopup(value) { calls.push(['set', value]); }, async openPopup(value) { calls.push(['open', value]); if (overrides.fail) throw Error('Cannot show popup'); } }
  };
}
test('native star flow opens the actual recommendation popup and restores normal toolbar action', async () => {
  const api = mock();
  const result = await openNativeReview(api, { id: '42', url: 'https://example.com/page#section' });
  assert.equal(result.surface, 'action');
  assert.deepEqual(api.calls[0], ['set', { tabId: 5, popup: 'collect.html?review=42' }]);
  assert.deepEqual(api.calls[1], ['open', { windowId: 8 }]);
  assert.deepEqual(api.calls[2], ['set', { tabId: 5, popup: 'popup.html' }]);
});
test('popup refusal falls back to a standalone extension window', async () => {
  const api = mock({ fail: true });
  const result = await openNativeReview(api, { id: '42', url: 'https://example.com/page' });
  assert.equal(result.surface, 'window');
  assert.equal(api.calls.find(c => c[0] === 'window')[1].url, 'chrome-extension://test/collect.html?review=42');
  assert.equal(api.calls.at(-1)[1].popup, 'popup.html');
});
test('sync/background imports and unfocused windows do not steal browser focus', async () => {
  for (const api of [mock({ url: 'https://other.example' }), mock({ focused: false })]) {
    assert.equal((await openNativeReview(api, { id: '42', url: 'https://example.com/page' })).opened, false);
    assert.deepEqual(api.calls, []);
  }
});
test('native bookmarks for extension/internal pages also get recommendations without content injection', async () => {
  const url = 'chrome-extension://test/manager.html';
  const api = mock({ url });
  assert.equal((await openNativeReview(api, { id: '42', url })).opened, true);
});
