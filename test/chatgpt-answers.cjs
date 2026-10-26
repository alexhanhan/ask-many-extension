// node test/chatgpt-answers.cjs [linkedom 模块路径]
// 使用 DOM 解析器验证 CSS 选择器；不依赖 ChatGPT 账号，不发送真实消息。
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require(process.argv[2] || 'linkedom');

const source = fs.readFileSync(path.join(__dirname, '..', 'adapters.js'), 'utf8');
const sandbox = {};
vm.runInNewContext(source, sandbox);
const A = sandbox.AskManyAdapters;
const site = A.byId('chatgpt');
const dom = (html) => parseHTML(`<html><body>${html}</body></html>`).document;
let passed = 0;
function check(label, html, text, count) {
  const document = dom(html);
  assert.equal(A.latestAnswer(site, document), text, label);
  assert.equal(A.answerCount(site, document), count, `${label}: count`);
  console.log(`PASS ${label}`);
  passed++;
  return document;
}

check('legacy role', '<main><div data-message-author-role="assistant">旧版正文</div></main>', '旧版正文', 1);
check('turn role', '<main><article data-turn="assistant"><h6>ChatGPT</h6><div class="markdown">新版正文</div><button>复制</button></article></main>', '新版正文', 1);
const document = check('missing legacy role, markdown fallback', '<main><article data-testid="conversation-turn-2"><div class="markdown">星期一</div><button>复制</button></article></main>', '星期一', 1);
assert.equal(document.querySelectorAll('[data-message-author-role="assistant"]').length, 0);
check('plain markdown wrapper', '<main><section><div class="markdown">正文</div></section></main>', '正文', 1);
check('mixed versions select newest', '<main><article><div data-message-author-role="assistant">旧回答</div></article><article data-turn="assistant"><div class="markdown">新回答</div></article></main>', '新回答', 2);
check('multiple blocks in same turn', '<main><article data-turn="assistant" data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown">第一段</div><div class="markdown">第二段</div></div></article></main>', '第一段\n\n第二段', 1);
check('nested markdown is not duplicated', '<main><article><div class="markdown"><div class="markdown">正文</div></div></article></main>', '正文', 1);
check('user and editor are not answers', '<main><article data-turn="user"><div class="markdown">用户提问</div></article><div data-message-author-role="user"><div class="markdown">用户消息</div></div><form><div class="markdown">输入草稿</div></form><div contenteditable="true"><div class="markdown">草稿</div></div></main>', null, 0);
check('latest empty turn does not return old answer', '<main><article data-turn="assistant"><div class="markdown">旧回答</div></article><article data-turn="assistant"><div class="markdown"></div></article></main>', null, 2);
check('no answer', '<main><p>输入问题</p></main>', null, 0);

const realHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'chatgpt-search-units.html'), 'utf8');
const expectedRealAnswer = '今天是 2026年9月28日，星期一（周一）。';
const realDocument = check('actual captured search-unit structure', realHtml, expectedRealAnswer, 1);
check('new user markers exclude markdown', '<main><div data-content-search-unit-key="turn:0:user"><div class="markdown">用户消息</div></div><div data-user-message-bubble="true"><div class="markdown">用户消息</div></div></main>', null, 0);
check('new answer has multiple body blocks', '<div data-content-search-unit-key="turn:1:assistant"><h4>ChatGPT 说：</h4><div data-markdown-text-style="assistant-message">第一段</div><div data-markdown-text-style="assistant-message">第二段</div></div>', '第一段\n\n第二段', 1);
check('new latest empty answer does not collect old text', realHtml + '<div data-content-search-unit-key="turn:3:assistant"><h4>ChatGPT 说：</h4><div data-markdown-text-style="assistant-message"></div></div>', null, 2);
check('standalone new body', '<div data-markdown-text-style="assistant-message">新正文</div>', '新正文', 1);
check('new turn only has role heading before body mounts', realHtml + '<div data-content-search-unit-key="turn:3:assistant"><h4 data-conversation-role="assistant">ChatGPT 说：</h4></div>', null, 2);

// 同一份新结构通过实际 content.js 的 peek/collect 消息链路。
let listener;
const top = {};
const context = vm.createContext({
  AskManyAdapters: A, document, location: { hostname: 'chatgpt.com' },
  window: { top, parent: top, self: {} }, console: { info() {}, warn() {} },
  chrome: { runtime: {
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener(fn) { listener = fn; } },
  } },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'), context);
let peek, collected;
listener({ type: 'peek', siteId: 'chatgpt', diagnostics: true }, {}, (r) => { peek = r; });
listener({ type: 'collect', siteId: 'chatgpt', immediate: true }, {}, (r) => { collected = r; });
assert.equal(peek.answerCount, 1);
assert.equal(peek.length, 3);
assert.equal(peek.diagnosticVersion, 'send-20261020-2');
assert(peek.diagnostics.selectorMatches.some((match) => match.count > 0));
assert.equal(collected.text, '星期一');
assert.equal(collected.signature, peek.signature);

context.document = realDocument;
listener({ type: 'peek', siteId: 'chatgpt' }, {}, (r) => { peek = r; });
listener({ type: 'collect', siteId: 'chatgpt', immediate: true }, {}, (r) => { collected = r; });
assert.equal(peek.answerCount, 1);
assert.equal(peek.length, expectedRealAnswer.length);
assert.equal(collected.text, expectedRealAnswer);
assert.equal(collected.signature, peek.signature);
console.log(`PASS ${passed} DOM scenarios + content peek/collect integration`);
