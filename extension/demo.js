import { flattenTree, recommend, DEFAULT_SETTINGS } from './core.js';
import { createOrganizerService } from './organizer.js';

// Used only by a regular web browser preview. Extension pages always use real Chrome APIs.
export function createDemo() {
  const now = Date.now();
  let nextId = 100;
  const descriptions = [
    '构建面向用户的现代界面。从组件到交互，在实践中探索更清晰的前端开发方式。',
    '发现设计师的灵感与日常，收藏让你眼前一亮的界面、色彩和创意。',
    '把想法变成现实。探索开源项目，与世界各地的开发者共同创造。',
    '在这里找到 AI 研究、产品与实践的最新进展，探索更多可能。',
    '一份关于 JavaScript 的完整学习指南，从语言基础到浏览器中的实际应用。',
    '让想法有处安放，让团队井然有序。连接笔记、文档与工作中的每一步。',
    '发现可复用的设计资源，与团队一起把下一个好想法变成真实的体验。',
    '用开源字体为你的下一个项目增添个性。为屏幕阅读寻找恰到好处的表达。',
    '从真实的代码和项目中学习 Vue，构建更轻盈、更有表现力的网页应用。'
  ];
  const entries = [
    ['React · 构建用户界面的库', 'https://react.dev', '11'],
    ['Dribbble — 发现好设计', 'https://dribbble.com', '12'],
    ['GitHub · 让我们一起创造', 'https://github.com', '11'],
    ['Hugging Face · AI 社区', 'https://huggingface.co', '13'],
    ['现代 JavaScript 教程', 'https://zh.javascript.info', '14'],
    ['Notion · 让工作与灵感相遇', 'https://notion.so', '15'],
    ['Figma Community · 设计资源', 'https://figma.com/community', '12'],
    ['Google Fonts · 为文字找到表情', 'https://fonts.google.com', '12'],
    ['Vue.js · 渐进式 JavaScript 框架', 'https://cn.vuejs.org', '11']
  ];
  const metadata = {};
  const folders = [['11', '开发与技术'], ['12', '设计与灵感'], ['13', '人工智能'], ['14', '学习与阅读'], ['15', '效率工具'], ['16', '生活与日常']].map(([id, title]) => ({ id, title, parentId: '1', children: [] }));
  for (let i = 0; i < entries.length; i++) {
    const [title, url, parentId] = entries[i], id = String(30 + i);
    folders.find(f => f.id === parentId).children.push({ id, title, url, parentId, dateAdded: now - i * 86400000 });
    metadata[id] = { description: descriptions[i], content: descriptions[i] + ' 交互设计 学习笔记' };
  }
  const tree = [{ id: '0', title: '', children: [{ id: '1', title: '书签栏', parentId: '0', children: folders }, { id: '2', title: '其他书签', parentId: '0', children: [] }] }];
  let settings = { ...DEFAULT_SETTINGS, configured: false, hasKey: false };
  const flat = () => flattenTree(tree);
  const pending = { '33': { id: '33', source: 'local', items: [{ folderId: '13', path: '书签栏 / 人工智能', reason: '页面主题与目录相近' }] } };
  const store = {};
  function find(id, nodes = tree) { for (const node of nodes) { if (node.id === id) return node; const child = find(id, node.children || []); if (child) return child; } }
  const api = { storage: { local: {
    async get(keys) { return structuredClone(Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]]))); },
    async set(value) { Object.assign(store, structuredClone(value)); }
  } }, bookmarks: {
    async getTree() { return structuredClone(tree); },
    async get(id) { const node = find(id); if (!node) throw Error('书签不存在'); return [{ ...structuredClone(node), index: find(node.parentId)?.children.findIndex(n => n.id === id) || 0 }]; },
    async getChildren(id) { return structuredClone(find(id)?.children || []); },
    async create(input) { const node = { ...input, id: String(nextId++), dateAdded: Date.now(), ...(!input.url ? { children: [] } : {}) }; find(input.parentId).children.push(node); return structuredClone(node); },
    async move(id, { parentId, index }) { const node = find(id), old = find(node.parentId), target = find(parentId); old.children = old.children.filter(b => b.id !== id); node.parentId = parentId; target.children.splice(index ?? target.children.length, 0, node); return structuredClone(node); }
  } };
  const organizer = createOrganizerService(api, async () => settings);
  const organizeHandlers = { organizerGet: () => organizer.snapshot(), organizerStart: v => organizer.start(v), organizerStep: v => organizer.step(v.jobId), organizerPause: v => organizer.pause(v.jobId), organizerEdit: v => organizer.edit(v), organizerApply: v => organizer.applyOne(v), organizerUndo: v => organizer.undoOne(v) };
  return { async request(type, payload) {
    if (organizeHandlers[type]) return organizeHandlers[type](payload);
    if (type === 'library') return structuredClone({ ...flat(), metadata, pending, settings, current: { url: 'https://react.dev', title: entries[0][0], supported: true, bookmarkId: '30' } });
    if (type === 'currentPage') return { title: 'React · 构建用户界面的库', url: 'https://react.dev', description: descriptions[0], content: descriptions[0] };
    if (type === 'recommend') return recommend(payload.page, tree, { ...settings, configured: false });
    if (type === 'savePreferences') { Object.assign(settings, payload.value); return settings; }
    if (type === 'saveSettings' || type === 'testConnection') throw new Error('当前是界面预览，请加载 Chrome 插件后配置并测试真实 API。');
    if (type === 'clearIndex') { for (const k of Object.keys(metadata)) delete metadata[k]; return {}; }
    if (type === 'refreshCurrentIndex') { metadata[payload.id] = { description: descriptions[0], content: descriptions[0] }; return { ok: true }; }
    if (type === 'dismiss') { delete pending[payload.id]; return {}; }
    if (type === 'move' || type === 'savePage') {
      let item = flat().bookmarks.find(b => type === 'move' ? b.id === payload.id : b.url === payload.page.url);
      const existed = !!item;
      if (item) await api.bookmarks.move(item.id, { parentId: payload.folderId });
      else item = await api.bookmarks.create({ ...payload.page, parentId: payload.folderId });
      delete pending[item.id]; return { id: item.id, existed };
    }
    throw new Error('Unknown preview action');
  } };
}
