// node test/send-readiness.cjs
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function adapterHarness(readyAt = 0, unreliable = false, valueReadyAt = 0) {
  let now = 0;
  const waits = [];
  class Clock extends Date { static now() { return now; } }
  const context = {
    Date: Clock,
    setTimeout(fn, ms) { waits.push(ms); now += ms; fn(); },
  };
  vm.runInNewContext(read('adapters.js'), context);
  class Textarea {
    constructor() { this.tagName = 'TEXTAREA'; this._value = ''; }
    dispatchEvent() { return true; }
    get value() { return now >= valueReadyAt ? this._value : ''; }
    set value(value) { this._value = value; }
  }
  const editor = new Textarea();
  const button = { get disabled() { return now < readyAt; }, getAttribute() { return null; }, className: '' };
  const site = { input: () => editor, sendBtn: () => button, inputSettleMs: 250, sendStateUnreliable: unreliable };
  const win = { HTMLTextAreaElement: Textarea, Event: class {} };
  return { A: context.AskManyAdapters, site, editor, win, waits, now: () => now };
}

function contentHarness(verify = false) {
  let listener;
  let snapshot = { text: 'old answer', count: 1 };
  let snapshotError = false;
  const events = [];
  const top = {};
  const context = {
    AskManyAdapters: {
      bySite: () => ({ id: 'test', verifySubmit: verify }),
      answerSnapshot: () => { events.push('snapshot'); if (snapshotError) throw new Error('read failed'); return snapshot; },
      fillInputVerified: async (...args) => { assert.equal(args[5].readyEarly, true); return { ok: true }; },
      waitSendable: async () => true,
      submit: () => { events.push('submit'); return { ok: true, via: 'button' }; },
      submitVerified: async () => { events.push('submitVerified'); return { ok: true, verified: true }; },
    },
    document: {}, location: { hostname: 'test' },
    window: { top, parent: top, self: {} }, console: { info() {}, warn() {} },
    chrome: { runtime: { sendMessage: async () => ({}), onMessage: { addListener(fn) { listener = fn; } } } },
  };
  vm.runInNewContext(read('content.js'), context);
  return {
    request: (type) => new Promise((resolve) => listener({ siteId: 'test', type, text: 'question' }, {}, resolve)),
    change: (value) => { snapshot = value; }, failSnapshot: () => { snapshotError = true; }, events,
  };
}

(async () => {
  const ready = adapterHarness();
  const result = await ready.A.fillInputVerified(ready.site, ready.win, {}, 'question', 4, { readyEarly: true });
  assert.equal(result.ok, true);
  assert.equal(ready.editor.value, 'question');
  assert.deepEqual(ready.waits, [], 'ready plain text must not wait a fixed settle delay');
  assert.equal(await ready.A.waitSendable(ready.site, {}, 2500), true);
  assert.deepEqual(ready.waits, []);

  const becomingReady = adapterHarness(60);
  await becomingReady.A.fillInputVerified(becomingReady.site, becomingReady.win, {}, 'question', 4, { readyEarly: true });
  assert.equal(becomingReady.now(), 60, 'stop waiting as soon as this site becomes ready');
  const delayedInput = adapterHarness(0, false, 40);
  await delayedInput.A.fillInputVerified(delayedInput.site, delayedInput.win, {}, 'question', 4, { readyEarly: true });
  assert.equal(delayedInput.now(), 40, 'stop waiting as soon as an asynchronous editor reflects the text');
  const attachments = adapterHarness();
  await attachments.A.fillInputVerified(attachments.site, attachments.win, {}, 'question', 4, { readyEarly: false });
  assert.deepEqual(attachments.waits, [250], 'attachment editor stabilization must remain');
  const unreliable = adapterHarness(0, true);
  await unreliable.A.fillInputVerified(unreliable.site, unreliable.win, {}, 'question', 4, { readyEarly: true });
  assert.deepEqual(unreliable.waits, [250]);
  console.log('PASS ready text has no fixed delay, delayed readiness returns early, attachment/unreliable safeguards remain');

  for (const verified of [false, true]) {
    const h = contentHarness(verified);
    const prep = await h.request('prepare');
    assert.equal(prep.answerBaselineCount, 1);
    assert.equal(typeof prep.timings.readyWaitMs, 'number');
    h.change({ text: 'old answer finished while preparing', count: 2 });
    h.events.length = 0;
    const fired = await h.request('fire');
    assert.equal(fired.ok, true);
    assert.equal(fired.answerBaselineCount, 2);
    assert.equal(fired.answerBaselineLength, 'old answer finished while preparing'.length);
    assert.notEqual(fired.answerBaselineSignature, prep.answerBaselineSignature);
    assert.deepEqual(h.events, ['snapshot', verified ? 'submitVerified' : 'submit']);
    h.failSnapshot();
    const fallback = await h.request('fire');
    assert.equal(fallback.ok, true, 'baseline failure must not suppress submission');
    assert.equal(fallback.baselineError, 'read failed');
  }
  console.log('PASS fire refreshes baseline immediately before regular/verified submit, read failure does not block');
})().catch((error) => { console.error(error); process.exitCode = 1; });
