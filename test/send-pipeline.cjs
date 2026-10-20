// node test/send-pipeline.cjs
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8');
const start = source.indexOf('async function ask() {');
const end = source.indexOf('// --------------------------------------------------------------------- 裁判派发与监控', start);
assert(start >= 0 && end > start);

function harness(send, autoSend = true) {
  const elements = {
    '#q': { value: 'test question', focus() {} },
    '#autosend': { checked: autoSend },
    '#go': { disabled: false },
    '#status': { textContent: '' },
  };
  const state = {
    attachments: [], busy: false, order: ['fast', 'slow'],
    enabled: new Set(['fast', 'slow']), lockedSites: new Set(), judgeId: null,
  };
  const meta = {};
  const context = vm.createContext({
    state, send, activeSynthesisToken: 0, lastQuestion: '',
    $: (selector) => elements[selector],
    A: { byId: (id) => ({ name: id, supportsFiles: true }) },
    logDiagnostic() {}, setMeta(id, value) { meta[id] = value; },
    clearAttachments() {},
    monitorAndSynthesize() { throw new Error('unexpected judge monitor'); },
  });
  vm.runInContext(source.slice(start, end), context);
  return { ask: context.ask, state, elements, meta };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const prepared = { ok: true, answerBaselineSignature: 'prepared', answerBaselineCount: 1 };
const baseline = { ok: true, answerBaselineSignature: 'fresh', answerBaselineCount: 2 };

(async () => {
  const calls = [];
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const h = harness(async (id, msg) => {
    calls.push(`${id}:${msg.type}`);
    if (msg.type === 'prepare') return id === 'slow' ? slow : prepared;
    assert.notEqual(msg.type, 'peek', 'submission must not wait for an extra peek round trip');
    return baseline;
  });
  const pending = h.ask();
  await flush();
  assert(calls.includes('fast:fire'), 'fast site must submit while slow prepare is pending');
  assert(!calls.includes('slow:fire'));
  assert.equal(h.meta.fast, '已发送');
  assert.equal(h.state.currentRun.answerBaselines.fast, 'fresh');
  assert.equal(h.state.currentRun.answerBaselineCounts.fast, 2);
  releaseSlow(prepared);
  await pending;
  assert.deepEqual(Array.from(h.state.currentRun.firedIds), ['fast', 'slow']);
  assert.equal(h.state.busy, false);
  console.log('PASS slow prepare does not block another site; fresh per-site baseline retained');

  let releaseFire;
  const slowFire = new Promise((resolve) => { releaseFire = resolve; });
  const fireCalls = [];
  const independentFire = harness(async (id, msg) => {
    fireCalls.push(`${id}:${msg.type}`);
    if (msg.type === 'prepare') return prepared;
    if (msg.type === 'peek') throw new Error('unexpected peek');
    return id === 'slow' ? slowFire : baseline;
  });
  const firing = independentFire.ask();
  await flush();
  assert(fireCalls.includes('fast:fire'));
  assert(fireCalls.includes('slow:fire'));
  assert.equal(independentFire.meta.fast, '已发送', 'slow fire confirmation must not delay fast site');
  releaseFire(baseline);
  await firing;
  console.log('PASS slow fire confirmation does not block another site');

  const onlyFill = [];
  const fill = harness(async (id, msg) => {
    onlyFill.push(msg.type);
    return prepared;
  }, false);
  await fill.ask();
  assert.deepEqual(onlyFill, ['prepare', 'prepare']);
  assert.equal(fill.elements['#q'].value, 'test question');
  assert.equal(fill.state.busy, false);
  console.log('PASS fill-only mode never submits');

  const failures = [];
  const failed = harness(async (id, msg) => {
    failures.push(`${id}:${msg.type}`);
    if (id === 'slow') return { ok: false, error: 'input missing' };
    return msg.type === 'prepare' ? prepared : { ok: true };
  });
  await failed.ask();
  assert(!failures.includes('slow:fire'));
  assert.deepEqual(Array.from(failed.state.currentRun.firedIds), ['fast']);
  assert.match(failed.meta.slow, /input missing/);
  console.log('PASS prepare failure excludes only that site');

  const fireFailure = harness(async (id, msg) => {
    if (msg.type === 'prepare') return prepared;
    assert.notEqual(msg.type, 'peek');
    return id === 'slow' ? { ok: false, error: 'submit failed' } : { ok: true };
  });
  await fireFailure.ask();
  assert.equal(fireFailure.state.currentRun.answerBaselines.fast, 'prepared');
  assert.deepEqual(Array.from(fireFailure.state.currentRun.firedIds), ['fast']);
  assert.match(fireFailure.meta.slow, /submit failed/);
  console.log('PASS missing fire baseline preserves prepare baseline; failed fire excluded');

  let releasePrepare;
  const pausedPrepare = new Promise((resolve) => { releasePrepare = resolve; });
  const cancelledCalls = [];
  const cancelled = harness(async (id, msg) => {
    cancelledCalls.push(msg.type);
    return msg.type === 'prepare' ? pausedPrepare : { ok: true };
  });
  const sending = cancelled.ask();
  await flush();
  cancelled.state.currentRun = null; // 账号切换取消旧轮次。
  releasePrepare(prepared);
  await sending;
  assert(!cancelledCalls.includes('fire'), 'old prepared text must not submit into a new account');
  assert.equal(cancelled.elements['#q'].value, 'test question');
  assert.equal(cancelled.state.busy, false);
  console.log('PASS account switch cancels pending submission and preserves unsent input');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
