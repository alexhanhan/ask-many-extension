// Loaded only by the collection page after a shortcut click or a native review.
const live = !!globalThis.chrome?.runtime?.id;
const action = document.getElementById('collect-current');
const status = document.getElementById('startup-status');
const folder = document.getElementById('current-folder');
const retry = document.getElementById('startup-retry');
const reviewId = new URLSearchParams(location.search).get('review');
let statusVersion = 0, statusTimer, collectionPromise, statusModule, busy = false;

async function refreshStatus() {
  if (!live) { action.disabled = false; status.textContent = '界面预览 · 加载扩展后可收藏当前网页'; return; }
  const version = ++statusVersion;
  let timeout;
  try {
    const data = await Promise.race([
      (statusModule ||= import('./page-state.js')).then(module => module.queryCurrentStatus(chrome)),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('读取当前页状态超时，请重试')), 5000); })
    ]);
    if (version !== statusVersion) return;
    const { current, bookmark } = data;
    if (current.error) throw Error(current.error);
    action.textContent = bookmark ? bookmark.managed ? '已收藏 · 只读' : '已收藏 · 调整分类' : current.supported ? '收藏当前页' : '此页无法收藏';
    action.disabled = busy || (bookmark ? bookmark.managed : !current.supported);
    status.textContent = bookmark ? '这份内容已收藏，可调整所在目录。' : current.supported ? '为当前网页找到合适的已有目录。' : '请在普通网页上使用收藏功能。';
    folder.textContent = bookmark?.path || ''; folder.title = bookmark?.path || ''; folder.hidden = !bookmark;
    retry.hidden = true;
  } catch (error) {
    if (version !== statusVersion) return;
    status.textContent = error.message; retry.hidden = false;
    action.textContent = '收藏 / 调整当前页'; action.disabled = busy;
  } finally { clearTimeout(timeout); }
}
function refreshSoon() { clearTimeout(statusTimer); statusTimer = setTimeout(refreshStatus, 100); }
function collectionUI() {
  return collectionPromise ||= (async () => {
    // Load the existing styled recommendation dialog only when it is needed.
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'styles.css';
    const styled = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = () => { link.remove(); reject(Error('归类界面样式加载失败，请重试')); }; });
    document.head.append(link);
    const [module] = await Promise.all([import('./app.js'), styled]);
    return module;
  })().catch(error => { collectionPromise = null; throw error; });
}
async function collect(nativeReviewId = null) {
  if (busy) return;
  busy = true; action.disabled = true; action.setAttribute('aria-busy', 'true');
  status.textContent = '正在打开归类建议…';
  let failed = false;
  try { const ui = await collectionUI(); await ui.openPopupCollection(nativeReviewId); }
  catch (error) { failed = true; status.textContent = error.message; retry.hidden = false; }
  finally { busy = false; action.disabled = false; action.removeAttribute('aria-busy'); if (!failed) refreshSoon(); }
}
action.addEventListener('click', () => collect());
retry.addEventListener('click', refreshStatus);
window.addEventListener('bookmark-status-changed', refreshSoon);
if (live) {
  for (const event of ['onCreated', 'onChanged', 'onMoved', 'onRemoved']) chrome.bookmarks[event].addListener(refreshSoon);
  chrome.tabs.onActivated.addListener(refreshSoon);
  chrome.tabs.onUpdated.addListener((id, change) => { if (change.url) refreshSoon(); });
}
// Static controls paint before any background work is requested.
setTimeout(() => { refreshStatus(); if (reviewId) collect(reviewId); else if (document.body.dataset.autoCollect) collect(); }, 0);
