/*
 * 后台职责：
 *  1. 打开/聚焦面板标签页
 *  2. 面板打开期间，动态加一条「仅对该标签页生效」的规则，剥掉 iframe 拦截头
 *  3. 中继站点指令，并将独立页签选择的 Gemini 账号同步回面板
 *
 * 为什么不用静态规则：静态规则对所有页面生效，等于任何网站都能把 ChatGPT
 * 嵌进自己的 iframe 里 —— 那是给点击劫持开口子。这里用 session 规则 +
 * tabIds 条件，作用域收窄到面板这一个标签页，面板关闭立刻撤销。
 */

const RULE_ID = 8801;
const GEMINI_ACCOUNT_KEY = 'askmany:gemini_url';
const ACCOUNT_SWITCH_PREFIX = 'askmany:account-switch:';
const GEMINI_ACCOUNT_CHOOSER = 'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fgemini.google.com%2Fapp';

// 这些响应头是浏览器在网络层拦 iframe 的依据，必须去掉才能并排嵌入。
const STRIP_HEADERS = [
  { header: 'x-frame-options', operation: 'remove' },
  { header: 'content-security-policy', operation: 'remove' },
  { header: 'content-security-policy-report-only', operation: 'remove' },
  { header: 'cross-origin-opener-policy', operation: 'remove' },
  { header: 'cross-origin-embedder-policy', operation: 'remove' },
];

const TARGET_DOMAINS = [
  'chatgpt.com',
  'chat.openai.com',
  'chat.deepseek.com',
  'claude.ai',
  'gemini.google.com',
  'chat.qwen.ai',
  'tongyi.aliyun.com',
  'yuanbao.tencent.com',
  'kimi.moonshot.cn',
  'kimi.ai',
  'doubao.com',
  'chatglm.cn',
  'grok.com',
  'perplexity.ai',
  'aistudio.xiaomimimo.com',
  'mimo.mi.com',
  'xiaomimimo.com',
];

const panelUrl = () => chrome.runtime.getURL('panel.html');

function geminiAccountUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://gemini.google.com') return null;
    const match = url.pathname.match(/^\/(?:u\/(\d+)\/)?app(?:\/|$)/);
    if (!match) return null;
    // 只同步账号身份和首页，不保存独立页签里的对话地址。
    if (match[1]) return `https://gemini.google.com/u/${match[1]}/app`;
    const account = url.searchParams.get('authuser');
    if (account && account.length <= 128) {
      return `https://gemini.google.com/app?authuser=${encodeURIComponent(account)}`;
    }
    return 'https://gemini.google.com/app';
  } catch {
    return null;
  }
}

async function openGeminiAccount(msg, sender) {
  const fromPanel = sender.url === panelUrl();
  const fromGemini = sender.frameId > 0 && geminiAccountUrl(sender.url);
  if (!fromPanel && !fromGemini) throw new Error('账号切换只能从工作台发起');
  const panelTabId = sender.tab?.id ?? (fromPanel ? msg.panelTabId : null);
  if (!Number.isInteger(panelTabId)) throw new Error('未找到工作台页签');
  const panel = await chrome.tabs.get(panelTabId);
  if (panel.url !== panelUrl()) throw new Error('工作台已关闭');

  // 先登记再导航，避免登录页快速重定向后丢失账号同步消息。
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  const key = `${ACCOUNT_SWITCH_PREFIX}${tab.id}`;
  try {
    await chrome.storage.session.set({ [key]: { panelTabId, startedAt: Date.now() } });
    await chrome.tabs.update(tab.id, { url: GEMINI_ACCOUNT_CHOOSER });
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
  await chrome.runtime.sendMessage({ type: 'gemini-account-opened', panelTabId }).catch(() => {});
  return { ok: true };
}

async function finishGeminiAccountSwitch(sender) {
  if (sender.frameId !== 0 || !sender.tab) return { ok: false };
  const url = geminiAccountUrl(sender.url);
  if (!url) return { ok: false };
  const key = `${ACCOUNT_SWITCH_PREFIX}${sender.tab.id}`;
  const saved = await chrome.storage.session.get(key);
  const pending = saved[key];
  if (!pending) return { ok: false };
  const panel = await chrome.tabs.get(pending.panelTabId).catch(() => null);
  if (!panel || panel.url !== panelUrl() || Date.now() - pending.startedAt > 15 * 60 * 1000) {
    await chrome.storage.session.remove(key);
    return { ok: false };
  }
  const result = await chrome.runtime.sendMessage({
    type: 'gemini-account-changed', panelTabId: pending.panelTabId, url,
  }).catch(() => null);
  if (!result?.ok) return { ok: false };
  await chrome.storage.local.set({ [GEMINI_ACCOUNT_KEY]: url });
  await chrome.storage.session.remove(key);
  return { ok: true };
}

async function enableFraming(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: STRIP_HEADERS },
        condition: {
          requestDomains: TARGET_DOMAINS,
          resourceTypes: ['sub_frame'],
          tabIds: [tabId], // 关键：只在面板标签页里放行
        },
      },
    ],
  });
}

async function disableFraming() {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
}

async function openPanel() {
  const url = panelUrl();
  const existing = await chrome.tabs.query({ url });
  const tab = existing.length
    ? await chrome.tabs.update(existing[0].id, { active: true })
    : await chrome.tabs.create({ url });
  await enableFraming(tab.id);
  return tab;
}

chrome.action.onClicked.addListener(() => {
  openPanel().catch((e) => console.error('[同问] 打开面板失败', e));
});

// 面板关掉或导航离开就撤销规则，不留敞口。
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove(`${ACCOUNT_SWITCH_PREFIX}${tabId}`);
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = rules.find((r) => r.id === RULE_ID);
  if (rule && rule.condition.tabIds?.includes(tabId)) await disableFraming();
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = rules.find((r) => r.id === RULE_ID);
  if (!rule || !rule.condition.tabIds?.includes(tabId)) return;
  if (!info.url.startsWith(panelUrl())) await disableFraming();
});

// 面板向各 iframe 转发指令：iframe 里跑的是 content script，
// 用 frameId 精确投递，避免广播到无关 frame。
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'open-gemini-account') {
    openGeminiAccount(msg, sender)
      .then(respond)
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (msg?.type === 'gemini-account-ready') {
    finishGeminiAccountSwitch(sender)
      .then(respond)
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (msg?.type === 'ensure-framing' && sender.tab) {
    enableFraming(sender.tab.id).then(() => respond({ ok: true }));
    return true;
  }
  if (msg?.type === 'relay') {
    chrome.tabs.sendMessage(
      msg.tabId,
      msg.payload,
      { frameId: msg.frameId },
      (res) => respond(res ?? { ok: false, error: chrome.runtime.lastError?.message })
    );
    return true;
  }
  return false;
});
