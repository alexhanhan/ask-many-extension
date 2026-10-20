// node test/monitor-cost.cjs [linkedom 模块路径]
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require(process.argv[2] || 'linkedom');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const sandbox = {};
vm.runInNewContext(read('adapters.js'), sandbox);
const A = sandbox.AskManyAdapters;
const document = parseHTML('<main>' + Array.from({ length: 500 }, (_, i) =>
  `<article data-turn="assistant"><div class="markdown"><div class="markdown">answer ${i}</div></div></article>`
).join('') + '</main>').document;
const actual = A.byId('chatgpt');
let scans = 0;
let diagnostics = 0;
const site = { ...actual, answers(doc) { scans++; return actual.answers(doc); } };
let listener;
const top = {};
vm.runInNewContext(read('content.js'), {
  AskManyAdapters: { ...A, bySite: () => site, answerDiagnostics(...args) { diagnostics++; return A.answerDiagnostics(...args); } },
  document, location: { hostname: 'chatgpt.com' },
  window: { top, parent: top, self: {} }, console: { info() {}, warn() {} },
  chrome: { runtime: { sendMessage: async () => ({}), onMessage: { addListener(fn) { listener = fn; } } } },
});
function peek(extra = {}) {
  let reply;
  listener({ type: 'peek', siteId: site.id, ...extra }, {}, (result) => { reply = result; });
  return reply;
}
const first = peek();
assert.equal(scans, 1, 'ordinary monitoring scans the answer list once');
assert.equal(diagnostics, 0, 'ordinary monitoring does not run full DOM diagnostics');
assert.equal(first.answerCount, 500);
assert.equal(first.length, 'answer 499'.length);
assert(!('diagnostics' in first));
assert(!JSON.stringify(first).includes('answer 499'), 'peek must not transmit answer bodies');
document.querySelector('main').insertAdjacentHTML('beforeend', '<article data-turn="assistant"><div class="markdown"></div></article>');
const empty = peek();
assert.equal(empty.answerCount, 501);
assert.equal(empty.length, 0, 'a fresh empty answer must not read the old answer');
const last = document.querySelector('main').lastElementChild.querySelector('.markdown');
last.textContent = 'streaming answer';
const streaming = peek();
assert.equal(streaming.length, 'streaming answer'.length);
assert.notEqual(streaming.signature, first.signature);
assert.equal(scans, 3);
assert.equal(diagnostics, 0);
const debug = peek({ diagnostics: true });
assert.equal(diagnostics, 1);
assert.equal(debug.diagnostics.nodeCount, 501);
assert(!JSON.stringify(debug).includes('streaming answer'));
console.log('PASS long conversation, one scan per peek, diagnostics on demand, empty/streaming turns, no bodies');
