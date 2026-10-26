// node test/chatgpt-submit.cjs [linkedom 模块路径]
// 代表性 DOM 状态回归；不依赖账号，不发送真实消息。
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require(process.argv[2] || 'linkedom');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function harness(buttons, options = {}) {
  let now = 0;
  let acceptAt = Infinity;
  let clicks = 0;
  let enters = 0;
  let listener;
  const waits = [];
  const document = parseHTML(options.markup || `<main><form><textarea id="prompt-textarea"></textarea>${buttons}</form></main>`).document;
  const input = document.querySelector('[data-active-input]') || document.querySelector('#prompt-textarea');
  input.value = options.initialValue ?? 'test question';
  input.focus = () => {};
  const location = { hostname: 'chatgpt.com', pathname: options.pathname || '/c/current' };
  const accept = () => {
    acceptAt = options.acceptAt ?? now;
    if (acceptAt <= now) input.value = '';
    if (options.submittedPath) location.pathname = options.submittedPath;
  };
  for (const button of document.querySelectorAll('button')) {
    button.addEventListener('click', () => { clicks++; if (!options.ignoreSubmit) accept(); });
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { enters++; if (!options.ignoreSubmit) accept(); }
  });
  class Clock extends Date { static now() { return now; } }
  class KeyboardEvent extends document.defaultView.Event {
    constructor(type, props) { super(type, props); this.key = props.key; this.code = props.code; }
  }
  const top = {};
  const context = vm.createContext({ Date: Clock, document, location,
    window: { top, parent: top, self: {}, KeyboardEvent, Event: document.defaultView.Event,
      HTMLTextAreaElement: document.defaultView.HTMLTextAreaElement },
    setTimeout(callback, ms) {
      waits.push(ms); now += ms;
      options.onWait?.({ document, location, now });
      if (now >= acceptAt) input.value = '';
      callback();
    },
    console: { info() {}, warn() {} },
    chrome: { runtime: { sendMessage: async () => ({}), onMessage: { addListener(fn) { listener = fn; } } } },
  });
  vm.runInContext(read('adapters.js'), context);
  vm.runInContext(read('content.js'), context);
  const A = context.AskManyAdapters;
  const site = A.byId('chatgpt');
  return { A, site, document, input, location, waits, now: () => now,
    counts: () => ({ clicks, enters }), win: context.window,
    request: (type, extra = {}) => new Promise((resolve) => listener({ type, siteId: 'chatgpt', text: 'test question', ...extra }, {}, resolve)),
  };
}

(async () => {
  const currentComposer = '<main><form id="current"><textarea id="prompt-textarea" data-active-input></textarea>' +
    '<input type="file" id="current-file"><div data-testid="attachment-current"></div>' +
    '<button id="composer-submit-button" aria-label="发送提示">↑</button></form></main>';
  for (const hidden of ['hidden', 'aria-hidden="true"', 'inert', 'data-no-layout']) {
    const h = harness('', { initialValue: '', markup: '<html><body>' +
      `<section ${hidden}><form id="home"><div id="prompt-textarea" contenteditable="true">home draft</div>` +
      '<input type="file" id="home-file"><div data-testid="attachment-home"></div>' +
      '<button data-testid="send-button">home send</button></form></section>' + currentComposer + '</body></html>' });
    const home = h.document.querySelector('#home #prompt-textarea');
    if (hidden === 'data-no-layout') home.getClientRects = () => [];
    assert.equal(h.site.input(h.document), h.input);
    assert.equal(h.site.sendBtn(h.document).closest('form').id, 'current');
    assert.equal(h.site.fileInput(h.document).id, 'current-file');
    assert.equal(h.site.uploadedChips(h.document).length, 1);
    assert.equal(h.site.uploadedChips(h.document)[0].getAttribute('data-testid'), 'attachment-current');
    const prep = await h.request('prepare');
    assert.equal(prep.ok, true);
    assert.equal(h.input.value, 'test question');
    assert.equal(home.textContent, 'home draft', 'hidden new-chat draft must remain untouched');
    assert.equal((await h.request('fire', { preparationId: prep.preparationId })).ok, true);
    assert.deepEqual(h.counts(), { clicks: 1, enters: 0 });
    assert.equal(home.textContent, 'home draft');
  }
  const ambiguous = harness('', { markup: '<html><body><form><textarea id="prompt-textarea"></textarea>' +
    '<button data-testid="send-button">home send</button></form>' + currentComposer + '</body></html>' });
  assert.equal(ambiguous.site.input(ambiguous.document), null);
  assert.equal((await ambiguous.request('prepare')).ok, false);
  assert.equal((await ambiguous.request('fire')).ok, false);
  assert.deepEqual(ambiguous.counts(), { clicks: 0, enters: 0 });
  const scoped = harness('', { markup: '<html><body><form><button data-testid="send-button">unrelated</button></form>' +
    '<main><form><textarea id="prompt-textarea"></textarea><button aria-label="More tools">+</button></form></main></body></html>' });
  assert.equal(scoped.site.sendBtn(scoped.document), null, 'never fall back to another composer send control');
  assert.equal((await scoped.request('fire')).via, 'enter');
  assert.deepEqual(scoped.counts(), { clicks: 0, enters: 1 });
  const portal = harness('', { markup: '<html><body><form hidden><textarea id="prompt-textarea"></textarea>' +
    '<input type="file" id="old-file"></form><main><form><textarea id="prompt-textarea" data-active-input></textarea>' +
    '</form><input hidden type="file" id="portal-file"></main></body></html>' });
  assert.equal(portal.site.fileInput(portal.document).id, 'portal-file', 'support a unique file input mounted outside current form');
  console.log('PASS hidden/stale home composers are untouched; text/files/send share current composer; ambiguous editors fail safely');

  const changed = harness('<button data-testid="send-button">↑</button>');
  const beforeChange = await changed.request('prepare');
  changed.location.pathname = '/';
  const blocked = await changed.request('fire', { preparationId: beforeChange.preparationId });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /会话已切换/);
  assert.deepEqual(changed.counts(), { clicks: 0, enters: 0 });
  const preparing = harness('<button data-testid="send-button" disabled>↑</button>', {
    onWait: ({ location }) => { location.pathname = '/c/other'; },
  });
  const cancelled = await preparing.request('prepare');
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /会话已切换/);
  assert.deepEqual(preparing.counts(), { clicks: 0, enters: 0 });
  const reloaded = harness('<button data-testid="send-button">↑</button>');
  assert.equal((await reloaded.request('fire', { preparationId: beforeChange.preparationId })).ok, false);
  assert.deepEqual(reloaded.counts(), { clicks: 0, enters: 0 });
  const firstQuestion = harness('<button data-testid="send-button">↑</button>', {
    pathname: '/', submittedPath: '/c/created',
  });
  const homePrepared = await firstQuestion.request('prepare');
  assert.equal((await firstQuestion.request('fire', { preparationId: homePrepared.preparationId })).ok, true,
    'a new conversation URL created by our own submit must still confirm normally');
  const rebuilt = harness('<button data-testid="send-button">↑</button>');
  const bound = rebuilt.site.createSendContext(rebuilt.document, rebuilt.location);
  const replacement = rebuilt.input.cloneNode(true);
  rebuilt.input.replaceWith(replacement);
  assert.equal(bound.input(), replacement, 'same-conversation editor rebuilds remain supported');
  replacement.remove();
  const unrelated = rebuilt.document.createElement('form');
  unrelated.innerHTML = '<textarea id="prompt-textarea"></textarea>';
  rebuilt.document.documentElement.appendChild(unrelated);
  assert.equal(bound.input(), null);
  assert.equal(bound.input(), null, 'waiting for an editor rebuild must retain the original composer scope');
  console.log('PASS navigation during prepare/before fire and document reload cancel stale sends; first send and editor rebuild work');

  const rich = harness('', { markup: '<main><form><div id="prompt-textarea" contenteditable="true"></div></form></main>' });
  delete rich.input.value;
  let selectionTarget = null;
  const selection = { removeAllRanges() {}, addRange(range) { selectionTarget = range.target; } };
  rich.win.getSelection = () => selection;
  rich.document.createRange = () => ({ selectNodeContents(node) { this.target = node; } });
  rich.document.execCommand = () => { throw new Error('document-wide execCommand must not be used for selection'); };
  rich.win.DataTransfer = class { setData() {} };
  rich.win.ClipboardEvent = class extends rich.win.Event { constructor(type, props) { super(type, props); } };
  rich.input.addEventListener('paste', (event) => {
    assert.equal(selectionTarget, rich.input, 'selection must point inside target editor before paste');
    rich.input.textContent = 'test question';
    event.preventDefault();
  });
  assert.equal(await rich.A.fillInput(rich.site, rich.win, rich.document, 'test question'), true);
  assert.equal(rich.input.textContent, 'test question');
  rich.input.textContent = '';
  rich.input.replaceWith(rich.input.cloneNode(true));
  const richReplacement = rich.document.querySelector('#prompt-textarea');
  richReplacement.focus = () => {};
  richReplacement.addEventListener('paste', () => { selectionTarget = 'stale home selection'; });
  rich.document.execCommand = (command, _ui, value) => {
    assert.equal(command, 'insertText');
    assert.equal(selectionTarget, richReplacement, 'fallback must restore selection in the current editor');
    richReplacement.textContent = value;
    return true;
  };
  assert.equal(await rich.A.fillInput(rich.site, rich.win, rich.document, 'test question'), true);
  assert.equal(richReplacement.textContent, 'test question');
  console.log('PASS rich text selection is explicitly scoped to the target editor');

  const variants = [
    '<button data-testid="send-button" class="disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-black">send</button>',
    '<button id="composer-submit-button" aria-label="发送提示">↑</button>',
    '<button aria-label="发送消息">↑</button>',
    '<button aria-label="傳送提示">↑</button>',
    '<button aria-label="Send prompt">↑</button>',
    '<button aria-label="Send prompt" title="Send prompt (Enter)">↑</button>',
    '<div hidden><button data-testid="send-button">hidden</button></div><button id="composer-submit-button" aria-label="发送提示">↑</button>',
  ];
  for (const markup of variants) {
    const h = harness(markup);
    const prepared = await h.request('prepare', { dispatchToken: 1 });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.armed, true);
    assert.equal(h.now(), 0, 'enabled send control must not enter the 2.5s fallback');
    const fired = await h.request('fire');
    assert.equal(fired.ok, true);
    assert.equal(fired.verified, true);
    assert.equal(fired.via, 'button');
    assert.deepEqual(h.counts(), { clicks: 1, enters: 0 });
    assert.equal(h.now(), 0);
  }
  console.log('PASS legacy/new/Chinese/English buttons and Tailwind disabled variants submit immediately');

  for (const state of ['disabled', 'aria-disabled="true"', 'data-disabled="true"', 'class="is-disabled"', 'class="ant-btn-disabled"', 'class="Button_disabled__xyz"']) {
    const h = harness(`<button data-testid="send-button" ${state}>↑</button>`);
    assert.equal(h.A.sendable(h.site.sendBtn(h.document)), false, state);
    assert.equal(await h.A.waitSendable(h.site, h.document, 120, { allowEnterFallback: true }), false);
    assert.equal((await h.request('fire')).ok, false);
    assert.deepEqual(h.counts(), { clicks: 0, enters: 0 }, 'disabled controls cannot be bypassed with Enter');
  }
  console.log('PASS actual disabled attributes and state classes remain blocked');

  const unknown = harness('<button aria-label="More tools">+</button><button aria-label="Send feedback">feedback</button>');
  const prepared = await unknown.request('prepare', { dispatchToken: 2 });
  assert.equal(prepared.armed, true);
  assert.equal(unknown.now(), 0, 'plain text with an unknown button can use verified Enter immediately');
  const entered = await unknown.request('fire');
  assert.equal(entered.ok, true);
  assert.equal(entered.via, 'enter');
  assert.deepEqual(unknown.counts(), { clicks: 0, enters: 1 });

  const ignored = harness('<button id="composer-submit-button" aria-label="发送提示">↑</button>', { ignoreSubmit: true });
  const failed = await ignored.request('fire');
  assert.equal(failed.ok, false, 'an inert click must not be reported as sent');
  assert.equal(failed.attempts, 1);
  assert.equal(ignored.input.value, 'test question');
  assert.deepEqual(ignored.counts(), { clicks: 1, enters: 0 }, 'do not retry while the server may still accept the first submit');
  const delayed = harness('<button id="composer-submit-button" aria-label="发送提示">↑</button>', { acceptAt: 150 });
  assert.equal((await delayed.request('fire')).ok, true);
  assert.equal(delayed.now(), 150);
  assert.deepEqual(delayed.counts(), { clicks: 1, enters: 0 });
  console.log('PASS verified Enter fallback, delayed acceptance, ignored click failure, no repeated submit');

  const generating = harness('<button id="composer-submit-button" data-testid="stop-button" aria-label="停止生成">■</button>');
  assert.equal(generating.site.sendBtn(generating.document), null);
  assert.equal((await generating.request('prepare')).ok, false);
  assert.equal((await generating.request('fire')).ok, false);
  assert.deepEqual(generating.counts(), { clicks: 0, enters: 0 });
  const streaming = harness('<button id="composer-submit-button" aria-label="停止流式传输">■</button>');
  assert.equal((await streaming.request('prepare')).ok, false);
  assert.equal((await streaming.request('fire')).ok, false);
  const uploading = harness('<div role="progressbar"></div><button aria-label="More tools">+</button>');
  assert.equal(await uploading.A.waitSendable(uploading.site, uploading.document, 120, { allowEnterFallback: true }), false);
  const voice = harness('<button id="composer-submit-button" aria-label="Start voice mode">voice</button>');
  assert.equal(voice.site.sendBtn(voice.document), null);
  console.log('PASS stop/voice controls are not send buttons and pending uploads block fallback');
})().catch((error) => { console.error(error); process.exitCode = 1; });
