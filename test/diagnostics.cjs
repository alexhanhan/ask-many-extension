// node test/diagnostics.cjs
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const panel = read('panel.js');
const calls = [];
const secret = 'PRIVATE QUESTION AND ANSWER';
const run = {
  judgeId: 'gemini', judgeAnswersQuestion: true, judgeIncludedInComparison: false,
  question: secret, askedIds: ['chatgpt', 'gemini'], waitIds: ['chatgpt', 'gemini'],
  comparisonIds: ['chatgpt'], answers: {
    chatgpt: { text: secret, signature: 'sig1' },
    gemini: { text: secret, signature: 'sig2', isJudge: true },
  },
};
const context = vm.createContext({
  console: { info() {} },
  state: {
    currentRun: run, judgeId: 'gemini', enabled: new Set(['chatgpt', 'gemini']),
    frames: new Map(), lockedSites: new Set(), judgePrompt: secret,
  },
  send: async (id, payload) => {
    calls.push([id, payload.type]);
    return { ok: true, length: 20, answerCount: 1, diagnosticVersion: 'send-20261014-1', text: secret };
  },
});
vm.runInContext(panel.slice(panel.indexOf('const DIAGNOSTIC_VERSION'), panel.indexOf('const STORE_KEY')), context);
vm.runInContext(panel.slice(panel.indexOf('globalThis.askManyDiagnostics ='), panel.indexOf('// --------------------------------------------------------------------- 排序与持久化')), context);
vm.runInContext(panel.slice(panel.indexOf('function comparisonEntries('), panel.indexOf('async function monitorAndSynthesize(')), context);

(async () => {
  const entries = context.comparisonEntries(run);
  assert.equal(entries.length, 1);
  const exported = await context.askManyDiagnostics();
  assert.equal(typeof exported, 'string');
  assert(!exported.includes(secret), 'diagnostics must not contain question/answer/prompt bodies');
  assert(exported.includes('不在本轮比对名单'));
  assert(exported.includes('send-20261014-1'));
  assert.deepEqual(calls, [['chatgpt', 'peek'], ['gemini', 'peek']]);
  console.log('PASS export includes excluded judge, selection reasons and version, without bodies');

  vm.runInContext('for (let i = 0; i < 400; i++) logDiagnostic("bounded", { i });', context);
  assert.equal((await context.askManyDiagnostics()).split('\n').length, 300);
  console.log('PASS bounded diagnostic history');

  let listener;
  const top = {};
  const site = { id: 'gemini', name: 'Gemini' };
  const content = vm.createContext({
    AskManyAdapters: {
      bySite: () => site, latestAnswer: () => secret, answerCount: () => 1,
      answerSnapshot: () => ({ text: secret, count: 1 }),
      answerDiagnostics: () => ({ nodeCount: 1, selectorMatches: [{ selector: 'message-content', count: 1 }] }),
    },
    document: {}, location: { hostname: 'gemini.google.com' },
    window: { top, parent: top, self: {} }, console: { info() {}, warn() {} },
    chrome: { runtime: {
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener(fn) { listener = fn; } },
    } },
  });
  vm.runInContext(read('content.js'), content);
  for (const type of ['peek', 'collect']) {
    let reply;
    listener({ siteId: 'gemini', type, immediate: true, diagnostics: true }, {}, (result) => { reply = result; });
    assert.equal(reply.diagnosticVersion, 'send-20261014-1');
    assert.equal(reply.diagnostics.nodeCount, 1);
    if (type === 'peek') assert(!JSON.stringify(reply).includes(secret));
    else assert.equal(reply.text, secret, 'collection still returns original answer');
  }
  console.log('PASS content peek/collect retain behavior and attach diagnostics');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
