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
const baseline = { ok: true, signature: 'fresh', answerCount: 2 };

(async () => {
  const calls = [];
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const h = harness(async (id, msg) => {
    calls.push(`${id}:${msg.type}`);
    if (msg.type === 'prepare') return id === 'slow' ? slow : prepared;
    return msg.type === 'peek' ? baseline : { ok: true };
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
    if (msg.type === 'peek') return { ok: false, error: 'timeout' };
    return id === 'slow' ? { ok: false, error: 'submit failed' } : { ok: true };
  });
  await fireFailure.ask();
  assert.equal(fireFailure.state.currentRun.answerBaselines.fast, 'prepared');
  assert.deepEqual(Array.from(fireFailure.state.currentRun.firedIds), ['fast']);
  assert.match(fireFailure.meta.slow, /submit failed/);
  console.log('PASS failed peek preserves prepare baseline; failed fire excluded');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
