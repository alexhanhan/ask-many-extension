// node test/gemini-account.cjs [linkedom 模块路径]
// Chrome 消息和页签 API 的集成替身；不执行真实登录或修改用户账号。
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require(process.argv[2] || 'linkedom');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const sandbox = {};
vm.runInNewContext(read('adapters.js'), sandbox);
const A = sandbox.AskManyAdapters;
const gemini = A.byId('gemini');
const document = parseHTML(`<side-navigation>
  <button id="account" aria-label="Google 账号：示例"><img src="https://lh3.googleusercontent.com/avatar"></button>
  <button id="sidebar"><img src="https://lh3.googleusercontent.com/avatar"></button>
  <button id="settings" aria-label="设置">settings</button>
  <button id="upgrade">升级</button>
</side-navigation><button id="answer"><img src="https://lh3.googleusercontent.com/attachment"></button>`).document;
for (const id of ['account', 'sidebar']) assert(gemini.accountEntry(document.getElementById(id).firstElementChild));
for (const id of ['settings', 'upgrade', 'answer']) assert(!gemini.accountEntry(document.getElementById(id)));

let captureClick;
const requests = [];
document.addEventListener = (type, listener, capture) => {
  if (type === 'click') { assert.equal(capture, true); captureClick = listener; }
};
const top = {};
vm.runInNewContext(read('content.js'), {
  AskManyAdapters: A, document, location: { hostname: 'gemini.google.com' },
  window: { top, parent: top, self: {} }, console: { info() {}, warn() {} },
  chrome: { runtime: { sendMessage: async (msg) => { requests.push(msg.type); return { ok: true }; }, onMessage: { addListener() {} } } },
});
let intercepted = 0;
captureClick({ isTrusted: true, button: 0, target: document.getElementById('account').firstElementChild,
  preventDefault() { intercepted++; }, stopImmediatePropagation() { intercepted++; } });
captureClick({ isTrusted: true, button: 0, target: document.getElementById('settings'),
  preventDefault() { throw new Error('settings must be left to Gemini'); } });
captureClick({ isTrusted: false, button: 0, target: document.getElementById('account') });
assert.equal(intercepted, 2);
assert.deepEqual(requests, ['frame-ready', 'open-gemini-account']);

const panelUrl = 'chrome-extension://test/panel.html';
const session = {};
const local = {};
const tabs = new Map([[10, { id: 10, url: panelUrl }]]);
const notifications = [];
const writes = [];
let backgroundListener;
let nextId = 20;
const store = (values) => ({
  get: async (key) => ({ [key]: values[key] }),
  set: async (update) => { Object.assign(values, update); },
  remove: async (key) => { delete values[key]; },
});
const chrome = {
  storage: { session: store(session), local: store(local) },
  tabs: {
    get: async (id) => { if (!tabs.has(id)) throw new Error('no tab'); return tabs.get(id); },
    create: async (args) => { const tab = { id: nextId++, ...args }; tabs.set(tab.id, tab); writes.push('create'); return tab; },
    update: async (id, args) => { assert(session[`askmany:account-switch:${id}`], 'must track before navigating'); Object.assign(tabs.get(id), args); return tabs.get(id); },
    onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
  },
  runtime: {
    getURL: () => panelUrl,
    sendMessage: async (msg) => { notifications.push(msg); return { ok: true }; },
    onMessage: { addListener(fn) { backgroundListener = fn; } },
  },
  action: { onClicked: { addListener() {} } },
};

// 验证后台通知经过真实 panel.js 监听器，确实重载对应窗口并清除旧基线。
const panelDocument = parseHTML('<main id="main"></main><div id="status"></div>').document;
const panelState = {
  tabId: 10, frames: new Map([['gemini', { tabId: 10, frameId: 3 }]]),
  judgeId: null, collapsed: new Set(), maximized: null,
  currentRun: { question: 'old question' }, judgePrompt: 'old prompt',
  lockedSites: new Set(['gemini']), geminiUrl: null,
};
let panelListener;
const panelContext = vm.createContext({
  A, state: panelState, document: panelDocument, SITE_THEMES: {},
  DIAGNOSTIC_VERSION: 'send-20261014-1',
  activeSynthesisToken: 0, logDiagnostic() {}, paintDots() {}, setTimeout() {},
  $: (selector) => panelDocument.querySelector(selector),
  el: (tag, props = {}) => {
    const node = panelDocument.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'style') node.setAttribute('style', value);
      else node[key] = value;
    }
    return node;
  },
  setMeta(id, text) { panelDocument.getElementById(`meta-${id}`).textContent = text; },
  chrome: { runtime: { id: 'test', onMessage: { addListener(fn) { panelListener = fn; } } } },
});
const panelSource = read('panel.js');
vm.runInContext(panelSource.slice(panelSource.indexOf('chrome.runtime.onMessage.addListener'), panelSource.indexOf('function send(')), panelContext);
vm.runInContext(panelSource.slice(panelSource.indexOf('function makeCol('), panelSource.indexOf('const setMeta')), panelContext);
panelDocument.getElementById('main').append(panelContext.makeCol(gemini));
assert.equal(panelDocument.getElementById('btn-account-gemini').textContent, '切换账号');
chrome.runtime.sendMessage = async (msg) => {
  notifications.push(msg);
  let reply;
  panelListener(msg, { id: 'test' }, (result) => { reply = result; });
  return reply;
};
function restartWorker() {
  const ctx = vm.createContext({ chrome, URL, console });
  vm.runInContext(read('background.js'), ctx);
  return ctx;
}
let ctx = restartWorker();
function request(msg, sender) {
  return new Promise((resolve) => backgroundListener(msg, sender, resolve));
}
(async () => {
  const invalid = await request({ type: 'open-gemini-account' }, { url: 'https://gemini.google.com/app', frameId: 0, tab: { id: 10 } });
  assert.equal(invalid.ok, false, 'ordinary Gemini tabs cannot start a workbench switch');
  assert.equal(writes.length, 0);
  const opened = await request({ type: 'open-gemini-account' }, { url: 'https://gemini.google.com/u/0/app', frameId: 3, tab: { id: 10 } });
  assert.equal(opened.ok, true);
  assert.equal(tabs.get(20).url, gemini.accountChooserUrl);
  assert.equal(session['askmany:account-switch:20'].panelTabId, 10);
  ctx = restartWorker(); // MV3 worker 休眠后仍能处理返回结果。
  const unsolicited = await request({ type: 'gemini-account-ready' }, { url: 'https://gemini.google.com/u/2/app', frameId: 0, tab: { id: 99 } });
  assert.equal(unsolicited.ok, false);
  assert.equal(Object.keys(local).length, 0);
  const nested = await request({ type: 'gemini-account-ready' }, { url: 'https://gemini.google.com/u/2/app', frameId: 4, tab: { id: 20 } });
  assert.equal(nested.ok, false);
  const selected = await request({ type: 'gemini-account-ready' }, { url: 'https://gemini.google.com/u/2/app/conversation?foo=private', frameId: 0, tab: { id: 20 } });
  assert.equal(selected.ok, true);
  assert.equal(local['askmany:gemini_url'], 'https://gemini.google.com/u/2/app');
  assert(!session['askmany:account-switch:20']);
  assert.equal(notifications[1].url, 'https://gemini.google.com/u/2/app');
  assert.equal(panelDocument.getElementById('if-gemini').src, 'https://gemini.google.com/u/2/app');
  assert.equal(panelState.currentRun, null);
  assert.equal(panelState.frames.has('gemini'), false);
  assert.equal(panelState.lockedSites.has('gemini'), false);
  assert.equal(panelState.judgePrompt, '');
  assert.equal(panelContext.activeSynthesisToken, 1);
  panelListener({ type: 'frame-ready', siteId: 'gemini' }, { tab: { id: 10 }, frameId: 5 });
  assert.equal(panelState.frames.get('gemini').frameId, 5);
  assert.equal(panelState.geminiReloadPending, false);
  assert.equal(panelDocument.getElementById('meta-gemini').textContent, '账号已切换，已连接');
  const normalize = ctx.geminiAccountUrl;
  assert.equal(normalize('https://gemini.google.com/app?authuser=3&foo=private'), 'https://gemini.google.com/app?authuser=3');
  assert.equal(normalize('https://gemini.google.com.evil.example/u/3/app'), null);
  assert.equal(normalize('https://gemini.google.com/settings'), null);
  const fromPanel = await request({ type: 'open-gemini-account', panelTabId: 10 }, { url: panelUrl, frameId: 0 });
  assert.equal(fromPanel.ok, true, 'extension page sender need not include sender.tab');
  tabs.delete(10);
  const closed = await request({ type: 'gemini-account-ready' }, { url: 'https://gemini.google.com/u/4/app', frameId: 0, tab: { id: 21 } });
  assert.equal(closed.ok, false);
  assert.equal(local['askmany:gemini_url'], 'https://gemini.google.com/u/2/app');
  console.log('PASS avatar interception, unrelated controls, chooser, worker restart, account URL, ordinary tabs, closed panel');
})().catch((error) => { console.error(error); process.exitCode = 1; });
