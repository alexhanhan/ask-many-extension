import { searchBookmarks, hostname, safePageUrl, validateSettings, permissionOrigin } from './core.js';

const live = !!globalThis.chrome?.runtime?.id;
let demoPromise, organizerPromise, organizerUI;
const popup = document.body.classList.contains('popup');
const state = { view: location.hash.slice(1) || 'all', query: '', folder: null, data: null, layout: localStorage.getItem('layout') || 'grid', limit: 60 };
if (!['all', 'recent', 'pending', 'settings', 'organize'].includes(state.view)) state.view = 'all';
// Load the organizer when its manager view is opened.
function getOrganizer() {
  return organizerPromise ||= import('./organizer-ui.js').then(({ createOrganizerUI }) => {
    organizerUI = createOrganizerUI({ el, button, icon, request, toast, dialog, onChanged: load, getLibrary: () => state.data });
    return organizerUI;
  }).catch(error => { organizerPromise = null; throw error; });
}
const paths = {
  leaf: 'M20 4c-8-2-16 2-16 9a7 7 0 0 0 7 7c7 0 11-8 9-16ZM4 20l10-10M8 16v-5m0 5h5',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  inbox: 'm3 9 3-5h12l3 5v11H3ZM3 12h5l2 3h4l2-3h5',
  folder: 'M3 7V4h6l3 3h9v13H3Z',
  settings: 'm9 3-1 3-3 1-2 4 2 3 1 4 4 3 3-1 4 1 3-4-1-4 1-3-4-2-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-5-5 5 5-5 5',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  check: 'm5 12 4 4L19 6', spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3ZM20 2v4m-2-2h4',
  x: 'm6 6 12 12M6 18 18 6', list: 'M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1',
  key: 'M14 10a5 5 0 1 0-3 4l3 3h3v3h4v-4l-7-6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  book: 'M4 3h6l2 2 2-2h6v17h-6l-2 2-2-2H4ZM12 5v17',
  refresh: 'M20 7V2m0 5h-5M4 17v5m0-5h5M20 7a9 9 0 0 0-16 1m0 9a9 9 0 0 0 16-1'
};
function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', paths[name] || paths.book); svg.append(p); return svg;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (['checked', 'disabled', 'value', 'selected'].includes(k)) node[k] = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function button(text, name, fn, cls = 'button') { return el('button', { type: 'button', class: cls, onClick: fn }, name ? icon(name, 18) : null, text); }
function iconButton(name, label, fn, extra = '') { return el('button', { type: 'button', class: 'icon-button ' + extra, title: label, 'aria-label': label, onClick: fn }, icon(name, 18)); }
async function request(type, payload = {}) {
  if (type === 'library') payload = { summary: true, ...payload, ...(popup ? { includeCurrent: true } : {}) };
  if (!live) {
    const demo = await (demoPromise ||= import('./demo.js').then(({ createDemo }) => createDemo()));
    return demo.request(type, payload);
  }
  let timer;
  const response = await Promise.race([
    chrome.runtime.sendMessage({ type, payload }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取书签超时，请点击重试')), type === 'library' ? 8000 : 120000); })
  ]).finally(() => clearTimeout(timer));
  if (!response?.ok) throw new Error(response?.error || '插件后台未响应，请重新加载插件');
  return response.data;
}
let toastTimer;
function toast(message, error = false) {
  let node = document.getElementById('toast');
  if (!node) { node = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(node); }
  node.className = 'toast visible' + (error ? ' error' : ''); node.textContent = message;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('visible'), 5500);
}
async function run(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (error) { toast(error.message, true); } finally { btn.disabled = false; }
}
function navigate(view, folder = null) {
  state.view = view; state.folder = folder; state.query = ''; state.limit = 60;
  history.replaceState(null, '', '#' + view); render();
}
let loadVersion = 0;
let autoReviewHandled = false;
const contentCache = new Map();
let summariesPromise, contentsPromise, searchTimer, searchError = '';
let indexVersion = 0;
function acceptLibrary(data) {
  const ids = new Set(data.bookmarks.map(b => b.id));
  for (const [id, value] of contentCache) {
    if (!ids.has(id) || (data.metadata[id] && data.metadata[id].capturedAt !== value.capturedAt)) contentCache.delete(id);
    else data.metadata[id] = value;
  }
  state.data = data;
}
function refreshResults() {
  const indexed = document.getElementById('indexed-count');
  if (indexed) indexed.textContent = Object.values(state.data.metadata).filter(m => m.hasContent || m.content).length.toLocaleString();
  if (state.data && !['settings', 'organize'].includes(state.view)) renderResults();
}
function warmSummaries() {
  if (summariesPromise || !state.data?.missingSummaryIds?.length) return;
  const ids = [...state.data.missingSummaryIds];
  const version = indexVersion;
  summariesPromise = (async () => {
    // Legacy body indexes are migrated in small batches after the popup paints.
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      const { metadata } = await request('pageSummaries', { ids: batch });
      if (version !== indexVersion) break;
      for (const [id, value] of Object.entries(metadata)) if (!contentCache.has(id) && state.data.bookmarks.some(b => b.id === id)) state.data.metadata[id] = value;
      state.data.missingSummaryIds = state.data.missingSummaryIds.filter(id => !batch.includes(id));
      refreshResults();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  })().catch(error => { toast('部分索引摘要未加载：' + error.message, true); }).finally(() => { summariesPromise = null; });
}
function searchIncomplete() {
  return state.data.bookmarks.some(b => !contentCache.has(b.id) && (state.data.metadata[b.id]?.hasContent || state.data.missingSummaryIds?.includes(b.id)));
}
async function ensureSearchContents() {
  if (contentsPromise) return contentsPromise;
  searchError = '';
  const version = indexVersion;
  contentsPromise = (async () => {
    const ids = state.data.bookmarks.filter(b => !contentCache.has(b.id) && (state.data.metadata[b.id]?.hasContent || state.data.missingSummaryIds?.includes(b.id))).map(b => b.id);
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      const { metadata } = await request('pageContents', { ids: batch });
      if (version !== indexVersion) break;
      for (const id of batch) {
        const value = metadata[id] || { ...state.data.metadata[id], content: '' };
        contentCache.set(id, value); state.data.metadata[id] = value;
      }
      refreshResults();
    }
  })().catch(error => { searchError = error.message; }).finally(() => { contentsPromise = null; refreshResults(); });
  return contentsPromise;
}
function scheduleSearch() {
  clearTimeout(searchTimer);
  if (state.query.trim()) searchTimer = setTimeout(ensureSearchContents, 120);
}
async function load() {
  const version = ++loadVersion;
  const data = await request('library');
  if (version !== loadVersion) return;
  acceptLibrary(data);
  if (state.folder && !data.folders.some(f => f.id === state.folder)) state.folder = null;
  render();
  if (!popup) { warmSummaries(); scheduleSearch(); }
  const reviewId = new URLSearchParams(location.search).get('review');
  if (popup && reviewId && !autoReviewHandled) {
    autoReviewHandled = true;
    const bookmark = data.bookmarks.find(b => b.id === reviewId);
    const pending = data.pending[reviewId];
    if (bookmark && pending) await classify({ title: bookmark.title, url: bookmark.url }, bookmark, pending);
    else toast('这条书签的建议已处理或书签已被删除');
  }
}
function brand() { return el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, icon('leaf', 27)), el('div', {}, el('strong', {}, '拾叶'), el('span', {}, '让每次收藏，都有归处'))); }
function sidebar() {
  const data = state.data;
  const totalPending = Object.keys(data.pending).length;
  const aside = el('aside', { class: 'sidebar' }, brand(), el('div', { class: 'nav-label' }, '我的空间'));
  const nav = el('nav', { 'aria-label': '书签导航', class: 'main-nav' });
  for (const [view, name, glyph, count] of [['all', '全部书签', 'grid', data.bookmarks.length], ['recent', '最近收藏', 'clock'], ['organize', '批量整理', 'spark'], ['pending', '待归类', 'inbox', totalPending]]) {
    nav.append(button('', null, () => navigate(view), `nav-item ${state.view === view && !state.folder ? 'active' : ''}`));
    nav.lastChild.append(icon(glyph, 19), el('span', {}, name), count != null ? el('span', { class: 'nav-count' }, count) : '');
  }
  aside.append(nav, el('div', { class: 'nav-label folder-heading' }, '已有文件夹', el('span', {}, data.folders.length)));
  const folders = el('nav', { class: 'folder-nav', 'aria-label': '已有书签文件夹' });
  for (const folder of data.folders) {
    const count = data.bookmarks.filter(b => b.ancestorIds.includes(folder.id)).length;
    const item = button('', null, () => navigate('all', folder.id), 'nav-item folder-item ' + (state.folder === folder.id ? 'active' : ''));
    item.style.paddingLeft = `${16 + Math.min(folder.depth - 1, 4) * 13}px`;
    item.title = folder.path;
    item.append(icon('folder', 18), el('span', { class: 'folder-name' }, folder.title), el('small', {}, count)); folders.append(item);
  }
  if (!data.folders.length) folders.append(el('p', { class: 'muted pad' }, '在 Chrome 书签中创建文件夹后，这里会自动显示。'));
  aside.append(folders, el('div', { class: 'sidebar-bottom' }, el('div', { class: 'local-note' }, el('span', { class: 'status-dot' }), '与 Chrome 书签实时同步'), button('模型与偏好设置', 'settings', () => navigate('settings'), 'nav-item ' + (state.view === 'settings' ? 'active' : '')), el('span', { class: 'version' }, `拾叶 BOOKMARK GROVE  /  V${live ? chrome.runtime.getManifest().version : '1.2.3'}`)));
  return aside;
}
function topbar() {
  const search = el('input', { type: 'search', placeholder: '搜索全部书签、网址、目录和已索引正文…', 'aria-label': '搜索全部书签', value: state.query, id: 'global-search', onInput: event => {
    state.query = event.target.value; state.limit = 60;
    scheduleSearch();
    if (state.view === 'settings' || state.view === 'pending' || state.view === 'organize') { state.view = 'all'; render(); const input = document.getElementById('global-search'); input.focus(); input.setSelectionRange(state.query.length, state.query.length); }
    else renderResults();
  } });
  const bar = el('header', { class: 'topbar' }, el('div', { class: 'search-field' }, icon('search', 19), search, el('kbd', {}, '/')));
  if (popup) bar.prepend(brand());
  const actions = el('div', { class: 'top-actions' });
  if (popup) {
    actions.append(iconButton('spark', '批量整理书签', () => openManager('organize')), iconButton('external', '打开书签空间', () => openManager()), iconButton('settings', '模型设置', () => openManager('settings')));
  } else actions.append(el('span', { class: 'privacy-status' }, icon('check', 15), '本地书签空间'), iconButton('refresh', '刷新书签', event => run(event.currentTarget, load)));
  bar.append(actions); return bar;
}
function openManager(hash = 'all') { if (live) chrome.tabs.create({ url: chrome.runtime.getURL('manager.html#' + hash) }); else window.open('manager.html#' + hash, '_blank', 'noopener'); }
function currentPageAction() {
  const current = state.data.current;
  const bookmark = current?.bookmarkId ? state.data.bookmarks.find(b => b.id === current.bookmarkId) : null;
  const wrap = el('div', { class: 'current-page-action', id: 'current-page-action' });
  let label = '收藏当前页', glyph = 'plus', disabled = false, title = '收藏当前网页并选择目录';
  if (!current) { label = '读取收藏状态…'; disabled = true; }
  else if (current.error) { label = '重试读取状态'; glyph = 'refresh'; title = current.error; }
  else if (bookmark) { label = bookmark.managed ? '已收藏 · 只读' : '已收藏 · 调整分类'; glyph = 'check'; disabled = bookmark.managed; title = `已收藏于：${bookmark.path}${bookmark.managed ? '（由管理员管理）' : '，点击调整分类'}`; }
  else if (!current.supported) { label = '此页无法收藏'; disabled = true; title = '请在普通 HTTP(S) 网页上使用收藏功能'; }
  const action = button(label, glyph, event => run(event.currentTarget, () => current?.error ? load() : collectCurrent()), 'button ' + (bookmark ? 'secondary' : 'primary'));
  action.disabled = disabled; action.title = title;
  wrap.append(action);
  if (bookmark) wrap.append(el('span', { class: 'current-folder', title: bookmark.path }, icon('folder', 11), bookmark.path));
  return wrap;
}
function updateCurrentAction() { document.getElementById('current-page-action')?.replaceWith(currentPageAction()); }
function stats() {
  const { bookmarks, folders, metadata } = state.data;
  const week = Date.now() - 7 * 86400000;
  return el('div', { class: 'stats' }, ...[
    ['book', '全部收藏', bookmarks.length, '每一份好内容，都值得留下'],
    ['folder', '已有文件夹', folders.length, '沿用你熟悉的分类方式'],
    ['spark', '已索引正文', Object.values(metadata).filter(m => m.hasContent || m.content).length, '让内容也能被轻松找到'],
    ['clock', '近 7 天收藏', bookmarks.filter(b => b.dateAdded >= week).length, '灵感正在一点点生长']
  ].map(([glyph, label, count, subtitle]) => el('div', { class: 'stat' }, el('div', { class: 'stat-top' }, el('span', {}, label), icon(glyph, 18)), el('strong', glyph === 'spark' ? { id: 'indexed-count' } : {}, count.toLocaleString()), el('small', {}, subtitle))));
}
function hero() {
  const config = state.data.settings;
  const enabled = config.apiReady ?? config.configured;
  const box = el('section', { class: 'hero' }, el('div', { class: 'hero-copy' }, el('div', { class: 'eyebrow' }, icon('spark', 16), 'SMART COLLECTION'), el('h2', {}, '遇见好内容，', el('span', {}, '剩下的交给拾叶。')), el('p', {}, '读懂页面，推荐已有文件夹。让灵感井然有序。'), el('div', { class: 'hero-status' }, el('span', { class: 'status-dot' }), enabled ? `${config.model} · 大模型推荐已启用` : '本地推荐已就绪', !enabled ? button('连接大模型', 'arrow', () => popup ? openManager('settings') : navigate('settings'), 'text-button') : null)));
  const illustration = el('div', { class: 'hero-art', 'aria-hidden': 'true' }, el('div', { class: 'orbit orbit-one' }), el('div', { class: 'orbit orbit-two' }), el('div', { class: 'art-card art-back' }, icon('folder', 26), el('span', {}, '灵感收藏')), el('div', { class: 'art-card art-front' }, el('span', { class: 'mini-leaf' }, icon('leaf', 26)), el('div', {}, el('strong', {}, '恰好，放在这里'), el('small', {}, '为每一份灵感找到归处')), el('span', { class: 'art-check' }, icon('check', 13))), el('span', { class: 'art-spark' }, icon('spark', 28)));
  box.append(illustration); return box;
}
function render() {
  if (!state.data) return;
  if (popup) { window.dispatchEvent(new Event('bookmark-status-changed')); return; }
  if (state.view !== 'organize') organizerUI?.detach();
  const app = document.getElementById('app');
  const shell = el('div', { class: 'shell' });
  if (!popup) shell.append(sidebar());
  const main = el('main', { class: 'main' }, topbar());
  const body = el('div', { class: 'workspace' });
  if (!live) body.append(el('div', { class: 'demo-banner' }, '界面预览 · 当前为示例数据，加载 Chrome 插件后显示真实书签'));
  if (state.view === 'organize') body.append(el('section', { id: 'organizer-page' }));
  else if (state.view === 'settings') body.append(settingsPage());
  else {
    const selected = state.data.folders.find(f => f.id === state.folder);
    body.append(el('div', { class: 'page-heading' }, el('div', {}, el('div', { class: 'eyebrow muted' }, 'YOUR PERSONAL KNOWLEDGE GARDEN'), el('h1', {}, selected?.title || ({ all: '我的书签空间', recent: '最近收藏', pending: '为收藏找到归处' })[state.view]), el('p', { class: 'muted' }, selected?.path || '收集值得留下的内容，连接下一次灵感。')), popup ? currentPageAction() : button('收藏使用说明', 'plus', () => showInstructions(), 'button primary')));
    if (popup) {
      const tabs = el('nav', { class: 'popup-tabs', 'aria-label': '书签视图' });
      for (const [v, t] of [['all', '全部书签'], ['recent', '最近收藏'], ['pending', `待归类 ${Object.keys(state.data.pending).length || ''}`]]) tabs.append(button(t, null, () => navigate(v), 'tab ' + (v === state.view ? 'selected' : '')));
      body.append(tabs);
    }
    if (!popup && state.view === 'all' && !state.folder && !state.query) body.append(stats(), hero());
    body.append(el('section', { id: 'results', 'aria-label': '书签列表' }));
  }
  main.append(body);
  if (!popup) main.append(el('footer', { class: 'page-footer' }, '把信息收藏好，把注意力留给更重要的事。', el('span', {}, '拾叶 · 小小收藏，慢慢生长')));
  shell.append(main); app.replaceChildren(shell);
  if (state.view === 'organize') {
    const host = document.getElementById('organizer-page');
    host.append(el('p', { role: 'status' }, '正在打开批量整理…'));
    getOrganizer().then(ui => { if (host.isConnected) ui.mount(host); }).catch(error => { if (host.isConnected) host.replaceChildren(el('p', {}, error.message), button('重试加载', 'refresh', render)); });
  }
  else if (state.view !== 'settings') renderResults();
}
function renderResults() {
  const target = document.getElementById('results'); if (!target) return;
  const { bookmarks, metadata, pending } = state.data;
  let items = searchBookmarks(bookmarks, metadata, state.query, state.query ? null : state.folder);
  if (state.view === 'pending') items = items.filter(b => pending[b.id]);
  if (state.view === 'recent') items = items.filter(b => b.dateAdded >= Date.now() - 30 * 86400000);
  const title = state.query ? '搜索结果' : state.view === 'pending' ? '待确认的归类建议' : state.view === 'recent' ? '近 30 天的收藏' : state.folder ? '文件夹内的收藏' : '全部收藏';
  const count = el('span', { class: 'result-count', role: 'status' }, `${items.length} 个书签`);
  const controls = el('div', { class: 'view-controls' }, iconButton('grid', '卡片视图', () => changeLayout('grid'), state.layout === 'grid' ? 'active' : ''), iconButton('list', '列表视图', () => changeLayout('list'), state.layout === 'list' ? 'active' : ''));
  target.replaceChildren(el('div', { class: 'section-header' }, el('div', { class: 'section-title' }, el('h2', {}, title), count), el('div', { class: 'section-actions' }, el('span', { class: 'sort-note' }, '按收藏时间排序'), controls)));
  if (state.query && state.folder) target.append(el('div', { class: 'search-scope' }, '已在全部文件夹中搜索'));
  const searching = state.query.trim() && searchIncomplete();
  if (searching) target.append(el('p', { class: 'muted', role: 'status' }, searchError ? '正文搜索未完成：' + searchError : '正在搜索已索引正文…'), searchError ? button('重试正文搜索', 'refresh', ensureSearchContents, 'text-button') : null);
  if (!items.length) {
    if (searching) return;
    const empty = el('div', { class: 'empty' }, el('span', { class: 'empty-icon' }, icon(state.query ? 'search' : 'leaf', 32)), el('h3', {}, state.query ? '暂时没有找到相关书签' : state.view === 'pending' ? '每一份收藏，都已安放妥当' : '你的知识花园，从一次收藏开始'), el('p', {}, state.query ? '试试其他关键词，或使用空格组合搜索。' : state.view === 'pending' ? '新收藏的归类建议会出现在这里。' : '点击浏览器工具栏中的拾叶，收藏第一个网页。'));
    if (state.query) empty.append(button('清除搜索', 'x', () => { state.query = ''; render(); }, 'button secondary'));
    target.append(empty); return;
  }
  const grid = el('div', { class: 'bookmark-grid ' + (state.layout === 'list' ? 'list-view' : '') });
  for (const item of items.slice(0, state.limit)) grid.append(bookmarkCard(item, metadata[item.id] || {}, state.view === 'pending' ? pending[item.id] : null));
  target.append(grid);
  if (items.length > state.limit) target.append(button(`加载更多（还有 ${items.length - state.limit} 个）`, null, () => { state.limit += 60; renderResults(); }, 'button load-more'));
  target.append(el('div', { class: 'search-help' }, icon('search', 13), '搜索覆盖标题、网址、目录和已索引正文 · 通过插件收藏可建立正文索引'));
}
function changeLayout(layout) { state.layout = layout; localStorage.setItem('layout', layout); renderResults(); }
function bookmarkCard(item, meta, pending) {
  const host = hostname(item.url);
  const colors = ['mint', 'blue', 'purple', 'amber', 'rose'];
  const color = colors[[...host].reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length];
  const title = el('a', { class: 'bookmark-title', href: safePageUrl(item.url) ? item.url : '#', target: '_blank', rel: 'noopener noreferrer', title: item.title || item.url, onClick: event => { if (!safePageUrl(item.url)) { event.preventDefault(); toast('此链接使用特殊协议，请从 Chrome 原生书签中打开', true); } } }, item.title || item.url);
  const card = el('article', { class: 'bookmark-card' }, el('div', { class: 'card-top' }, el('span', { class: 'site-icon ' + color, 'aria-hidden': 'true' }, (host || item.title || 'B')[0].toUpperCase()), el('span', { class: 'site-host', title: item.url }, host || item.url), !popup ? icon('external', 14) : null), title, el('p', { class: 'bookmark-description' }, meta.description || (meta.content ? meta.content.slice(0, 120) : meta.hasContent ? '正文已索引，可输入关键词搜索。' : '尚未索引正文，可通过插件再次收藏此页面。')));
  card.append(el('div', { class: 'card-bottom' }, el('span', { class: 'folder-tag', title: item.path }, icon('folder', 13), item.path.split(' / ').slice(-2).join(' / ')), el('time', { datetime: new Date(item.dateAdded || 0).toISOString() }, formatDate(item.dateAdded))));
  if (pending) card.append(el('div', { class: 'pending-hint' }, icon('spark', 15), pending.items[0] ? `推荐：${pending.items[0].path}` : '选择一个已有目录'));
  card.append(el('div', { class: 'card-actions' }, button(pending ? '查看归类建议' : '重新归类', pending ? 'spark' : 'folder', event => run(event.currentTarget, () => classify({ title: item.title, url: item.url, ...meta }, item, pending)), 'text-button'), pending ? button('保留当前位置', null, event => run(event.currentTarget, async () => { await request('dismiss', { id: item.id }); await load(); toast('已保留原来的位置'); }), 'text-button muted') : (meta.hasContent || meta.content) ? el('span', { class: 'indexed-label' }, icon('check', 12), '正文已索引') : null));
  return card;
}
function formatDate(value) { if (!value) return ''; const d = new Date(value); return `${d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '/'}${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; }

function dialog(title, subtitle) {
  document.getElementById('main-dialog')?.close(); document.getElementById('main-dialog')?.remove();
  const modal = el('dialog', { id: 'main-dialog', 'aria-labelledby': 'dialog-title' });
  const content = el('div', { class: 'dialog-body' });
  modal.append(el('div', { class: 'dialog-heading' }, el('div', {}, el('span', { class: 'eyebrow' }, 'A LITTLE ORDER, A LITTLE JOY'), el('h2', { id: 'dialog-title' }, title)), iconButton('x', '关闭', () => modal.close())), el('p', { class: 'dialog-subtitle' }, subtitle), content);
  modal.addEventListener('close', () => modal.remove());
  document.body.append(modal); modal.showModal(); return { modal, content };
}
async function collectCurrent() {
  // Recheck at click time; a bookmark may have been added/removed since opening.
  const data = await request('library');
  acceptLibrary(data);
  const current = data.current;
  if (current?.error) throw new Error(current.error);
  const existing = current?.bookmarkId ? data.bookmarks.find(b => b.id === current.bookmarkId) : null;
  if (existing) {
    if (existing.managed) throw new Error('当前书签由管理员管理，无法调整分类');
    await classify({ title: existing.title, url: existing.url, ...data.metadata[existing.id] }, existing, data.pending[existing.id], true);
    return;
  }
  const page = await request('currentPage'); await classify(page);
}
// Imported by the lightweight popup only for an explicit collection or native review.
export async function openPopupCollection(reviewId) {
  if (reviewId) await load();
  else await collectCurrent();
}
async function classify(page, existing = null, pending = null, currentPageMode = false) {
  const { modal, content } = dialog(existing ? '给这份收藏，找个好位置' : '收藏这份新灵感', page.title || page.url);
  modal.classList.add('classification-dialog');
  const editableTitle = el('input', { class: 'text-input', value: page.title || '', maxlength: 1000, 'aria-label': '书签标题' });
  content.append(el('label', { class: 'field' }, el('span', {}, '书签标题'), editableTitle), el('div', { class: 'page-url' }, hostname(page.url)), el('div', { class: 'recommend-loading', role: 'status' }, el('span', { class: 'spinner' }), '正在为你寻找合适的已有目录…'));
  let result;
  try { result = pending || await request('recommend', { page, bookmarkId: existing?.id }); }
  catch (error) { result = { items: [], warning: error.message, source: 'local' }; }
  if (!modal.isConnected) return;
  content.querySelector('.recommend-loading').remove();
  if (page.captureWarning) content.append(el('div', { class: 'notice' }, page.captureWarning));
  if (currentPageMode && safePageUrl(page.url) && state.data.settings.indexContent) {
    content.append(button('更新当前页正文索引', 'refresh', event => run(event.currentTarget, async () => {
      await request('refreshCurrentIndex', { id: existing.id }); toast('当前页正文索引已更新，书签标题和位置保持不变');
    }), 'text-button'));
  }
  const recommendationLabel = el('div', { class: 'recommend-label', role: 'status' });
  const warning = el('div', { class: 'notice', role: 'status' });
  warning.hidden = !result.warning;
  content.append(recommendationLabel, warning);
  const choices = el('div', { class: 'recommendations' });
  const available = state.data.folders.filter(f => !f.managed);
  let selected = result.items.find(r => available.some(f => f.id === r.folderId))?.folderId || available.find(f => f.id === existing?.parentId)?.id || available[0]?.id || '';
  let manualChoice = false;
  const allFolders = el('select', { class: 'text-input', 'aria-label': '选择已有文件夹', onChange: event => { manualChoice = true; selected = event.target.value; updateSelection(); } });
  for (const folder of available) allFolders.append(el('option', { value: folder.id }, folder.path));
  const updateSelection = () => { allFolders.value = selected; for (const node of choices.children) { const active = node.dataset.id === selected; node.classList.toggle('selected', active); node.setAttribute('aria-pressed', String(active)); } };
  function updateResult(next) {
    result = next;
    recommendationLabel.replaceChildren(icon('spark', 16), next.analyzing ? '模型正在分析，先显示本地建议…' : next.source === 'ai' ? '大模型为你推荐' : '本地智能推荐', el('small', {}, '仅使用已有文件夹'));
    warning.hidden = !next.warning; warning.textContent = next.warning || '';
    if (!manualChoice) selected = next.items.find(r => available.some(f => f.id === r.folderId))?.folderId || selected;
    choices.replaceChildren();
    for (const item of next.items) {
      if (!available.some(f => f.id === item.folderId)) continue;
      const choice = button('', null, () => { manualChoice = true; selected = item.folderId; updateSelection(); }, 'recommendation'); choice.dataset.id = item.folderId;
      choice.append(icon('folder', 21), el('span', {}, el('strong', {}, item.path), el('small', {}, item.reason)), el('span', { class: 'choice-check' }, icon('check', 16))); choices.append(choice);
    }
    updateSelection();
  }
  updateResult(result);
  content.append(choices, el('label', { class: 'field' }, el('span', {}, '或手动选择其他目录'), allFolders));
  if (live && existing && pending) {
    const changed = (changes, area) => {
      const next = changes.pending?.newValue?.[existing.id];
      if (area === 'local' && next && modal.isConnected) updateResult(next);
    };
    chrome.storage.onChanged.addListener(changed);
    modal.addEventListener('close', () => chrome.storage.onChanged.removeListener(changed), { once: true });
    // Close the gap between the initial library read and installing the listener.
    request('library').then(data => { const next = data.pending[existing.id]; if (next && modal.isConnected) updateResult(next); }).catch(() => {});
  }
  const save = button(existing ? '确认归类' : '收藏到这里', 'check', event => run(event.currentTarget, async () => {
    const data = existing ? await request('move', { id: existing.id, folderId: selected }) : await request('savePage', { folderId: selected, page: { ...page, title: editableTitle.value.trim() || page.url } });
    modal.close(); await load(); toast(data.indexWarning || (existing ? '书签已移动到所选目录' : data.existed ? '已有书签的位置与正文索引已更新' : '收藏成功，灵感已妥善安放'));
  }), 'button primary');
  if (existing) { editableTitle.readOnly = true; editableTitle.title = '此处只调整目录，保留原书签标题'; }
  save.disabled = !selected;
  if (!available.length) content.append(el('p', { class: 'notice' }, '暂无可写入目录，请先在 Chrome 书签管理器中创建文件夹。'));
  const keep = existing && pending ? button('保留原目录', null, event => run(event.currentTarget, async () => { await request('dismiss', { id: existing.id }); modal.close(); await load(); toast('已保留原来的书签目录'); }), 'text-button muted') : null;
  modal.append(el('div', { class: 'dialog-footer' }, keep || el('span', { class: 'muted' }, existing ? '将更新 Chrome 中这条书签的文件夹' : '确认后保存到所选目录'), save));
}
function showInstructions() {
  const { content } = dialog('每一份灵感，一键收藏', '将拾叶固定到 Chrome 工具栏，随时收下值得留下的内容。');
  content.append(el('ol', { class: 'instructions' }, el('li', {}, '在 Chrome 工具栏点击拼图图标，将「拾叶」固定。'), el('li', {}, '打开想收藏的网页，点击拾叶，再点击「收藏 / 调整当前页」。'), el('li', {}, '选择推荐的已有目录，确认保存。也支持星标 / Ctrl+D 收藏后的归类提醒。')), el('p', { class: 'notice' }, 'Chrome 内部页面无法读取。已有书签支持标题、网址和目录搜索；通过插件收藏后可额外搜索当时保存的正文。'));
}

function settingsPage() {
  const config = state.data.settings;
  const page = el('section', { class: 'settings-page' }, el('div', { class: 'page-heading' }, el('div', {}, el('div', { class: 'eyebrow muted' }, 'MAKE IT YOUR OWN'), el('h1', {}, '模型与偏好设置'), el('p', { class: 'muted' }, '连接你自己的大模型，让分类更懂你的收藏习惯。'))));
  const form = el('form', { class: 'settings-card', onSubmit: event => { event.preventDefault(); run(save, () => persist(false)); } });
  form.append(el('div', { class: 'settings-card-title' }, el('span', { class: 'setting-glyph' }, icon('spark', 23)), el('div', {}, el('h2', {}, '大模型 API'), el('p', { class: 'muted' }, '支持 OpenAI Chat Completions 兼容接口与本地服务'))));
  const base = el('input', { id: 'base-url', class: 'text-input', type: 'url', required: true, value: config.baseUrl, placeholder: 'https://api.example.com/v1', autocomplete: 'off' });
  const key = el('input', { id: 'api-key', class: 'text-input', type: 'password', placeholder: config.hasKey ? '已保存密钥，留空则保持原值' : '输入 API Key，本地免密服务可留空', autocomplete: 'off', spellcheck: false });
  const show = iconButton('key', '显示或隐藏 API Key', () => { key.type = key.type === 'password' ? 'text' : 'password'; });
  const model = el('input', { id: 'model', class: 'text-input', required: true, value: config.model, placeholder: '填写服务商提供的模型名称', autocomplete: 'off', spellcheck: false });
  form.append(el('label', { class: 'field', for: 'base-url' }, el('span', {}, 'API 基础地址'), base, el('small', {}, '填写到 /v1 或服务商指定的基础路径；插件会追加 /chat/completions。')),
    el('label', { class: 'field', for: 'api-key' }, el('span', {}, 'API Key'), el('div', { class: 'password-field' }, key, show)),
    el('label', { class: 'field', for: 'model' }, el('span', {}, '模型名称'), model));
  const clearKey = el('input', { type: 'checkbox', id: 'clear-key' });
  if (config.hasKey) form.append(el('label', { class: 'clear-key' }, clearKey, '保存时删除已存储的 API Key（用于免密本地服务）'));
  form.append(el('div', { class: 'data-note' }, icon('key', 19), el('p', {}, '密钥仅保存在本机扩展存储中，不参与 Chrome 同步。启用 API 后，将发送待分类页面的标题、网址、简介及最多 60 个候选目录路径；网页正文保留在本地。')));
  const status = el('p', { class: 'connection-status', role: 'status', 'aria-live': 'polite' });
  const test = button('测试连接', 'refresh', event => run(event.currentTarget, () => persist(true)), 'button secondary');
  const save = el('button', { type: 'submit', class: 'button primary' }, icon('check', 17), '保存配置');
  const modelStatus = el('span', { class: 'local-status' }, el('span', { class: 'status-dot' }), config.configured && config.apiReady === false ? 'API 站点待授权' : config.configured ? '已启用模型推荐' : '当前使用本地推荐');
  form.append(status, el('div', { class: 'settings-actions' }, modelStatus, test, save));
  page.append(form);
  const prefs = el('section', { class: 'settings-card preferences' }, el('h2', {}, '收藏与搜索偏好'));
  const toggles = {};
  for (const [id, title, description] of [
    ['monitorNative', '为原生收藏推荐目录', '通过 Chrome 星标或 Ctrl+D 新增当前页书签后，自动弹出建议；确认后应用到真实书签目录。'],
    ['notifications', '显示归类通知', '新建议同时通过系统通知提醒；工具栏角标始终保留。'],
    ['indexContent', '收藏时保存正文索引', '通过插件收藏时，在本机保存最多 80,000 字符的正文，方便日后搜索。关闭后不再新增，已有索引仍可搜索。']
  ]) {
    const input = el('input', { type: 'checkbox', checked: config[id] !== false, id, role: 'switch' }); toggles[id] = input;
    prefs.append(el('label', { class: 'toggle-row', for: id }, el('span', {}, el('strong', {}, title), el('small', {}, description)), el('span', { class: 'toggle' }, input, el('span', { class: 'toggle-track' }))));
  }
  // Preference changes have a dedicated local save; no API permission is needed.
  prefs.append(button('保存偏好', 'check', event => run(event.currentTarget, async () => {
    const values = Object.fromEntries(Object.entries(toggles).map(([k, input]) => [k, input.checked]));
    await request('savePreferences', { value: values });
    state.data.settings = { ...state.data.settings, ...values }; toast('收藏与搜索偏好已保存');
  }), 'button secondary'));
  page.append(prefs, el('section', { class: 'settings-card index-card' }, el('div', {}, el('h2', {}, '本地正文索引'), el('p', { class: 'muted' }, '仅清除保存的简介和正文，不删除浏览器书签。')), button('清除正文索引', 'trash', () => {
    const { modal, content } = dialog('清除本地正文索引？', '已保存的页面简介和正文将被清除，浏览器书签会保留。');
    content.append(button('确认清除索引', 'trash', event => run(event.currentTarget, async () => { indexVersion++; await request('clearIndex'); contentCache.clear(); state.data.metadata = {}; modal.close(); toast('已清除本地正文索引'); }), 'button danger'));
  }, 'button secondary')));
  async function persist(onlyTest) {
    const value = validateSettings({ baseUrl: base.value, apiKey: key.value, model: model.value, ...Object.fromEntries(Object.entries(toggles).map(([k, input]) => [k, input.checked])) });
    value.clearKey = clearKey.checked;
    status.textContent = '等待站点授权…'; status.className = 'connection-status';
    test.disabled = true; save.disabled = true;
    try {
      // Called directly from the user gesture; do not await unrelated work before requesting permission.
      const granted = live ? await chrome.permissions.request({ origins: [permissionOrigin(value.baseUrl)] }) : true;
      if (!granted) throw new Error('未授予 API 站点访问权限，配置未保存');
      status.textContent = onlyTest ? '正在测试连接…' : '正在保存配置…';
      if (onlyTest) { await request('testConnection', { value }); status.textContent = '连接成功 · 模型已正常响应（尚未保存当前修改）'; }
      else { const result = await request('saveSettings', { value }); state.data.settings = result; key.value = ''; key.placeholder = result.hasKey ? '已保存密钥，留空则保持原值' : '本地免密服务可留空'; clearKey.checked = false; modelStatus.replaceChildren(el('span', { class: 'status-dot' }), '已启用模型推荐'); status.textContent = '配置已保存，下次收藏时将使用模型推荐'; }
      status.className = 'connection-status success';
    } catch (error) { status.textContent = error.message; status.className = 'connection-status error-text'; }
    finally { test.disabled = false; save.disabled = false; }
  }
  return page;
}

document.addEventListener('keydown', event => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (event.key === '/' && !typing && !document.querySelector('dialog[open]')) { event.preventDefault(); document.getElementById('global-search')?.focus(); }
});
let reloadTimer;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    if (state.view === 'settings' || document.querySelector('dialog[open]')) return;
    if (state.view === 'organize') { await organizerUI?.refresh(); return; }
    // Refresh results without replacing a focused search field.
    try { const data = await request('library'); acceptLibrary(data); if (document.activeElement?.id === 'global-search') { renderResults(); if (popup) updateCurrentAction(); } else render(); warmSummaries(); scheduleSearch(); } catch (error) { toast(error.message, true); }
  }, 300);
}
if (live && !popup) {
  for (const event of ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered']) chrome.bookmarks[event].addListener(reloadSoon);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const pageKeys = Object.keys(changes).filter(key => key.startsWith('page:'));
    if (pageKeys.length) indexVersion++;
    for (const key of pageKeys) contentCache.delete(key.slice(5));
    if (changes.pending || changes.settings || pageKeys.length || (state.view === 'organize' && (changes.organizerJob || changes.organizerHistory))) reloadSoon();
  });
  if (popup) {
    chrome.tabs.onActivated.addListener(reloadSoon);
    chrome.tabs.onUpdated.addListener((id, change) => { if (change.url) reloadSoon(); });
  }
}
if (!popup) {
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (['all', 'recent', 'pending', 'settings', 'organize'].includes(next)) navigate(next); });
if (!document.getElementById('app').children.length) document.getElementById('app').append(el('div', { class: 'initial-loading', role: 'status' }, icon('leaf', 32), '正在打开你的书签空间…'));
load().catch(error => {
  const status = document.getElementById('startup-status');
  if (status) { status.textContent = error.message; document.getElementById('startup-retry').hidden = false; }
  else document.getElementById('app').replaceChildren(el('div', { class: 'empty' }, el('h2', {}, '书签暂时无法加载'), el('p', {}, error.message), button('重新加载', 'refresh', () => location.reload(), 'button primary')));
});
}
