// Works directly in an extension page; no service-worker message or storage read.
function normalize(url) { try { const u = new URL(url); u.hash = ''; return u.href.replace(/\/$/, ''); } catch { return url; } }
export async function queryCurrentStatus(api) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return { current: { error: '暂时无法读取当前页，请重试' }, bookmark: null };
  const url = normalize(tab.url);
  const match = (await api.bookmarks.search({ query: url })).find(node => node.url && normalize(node.url) === url);
  let bookmark = null;
  if (match) {
    const names = [], visited = new Set();
    let parentId = match.parentId, managed = !!match.unmodifiable;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const [folder] = await api.bookmarks.get(parentId);
      if (!folder) break;
      managed ||= !!folder.unmodifiable || folder.folderType === 'managed';
      if (folder.parentId) names.unshift(folder.title || '未命名文件夹');
      parentId = folder.parentId;
    }
    bookmark = { id: match.id, title: match.title, url: match.url, path: names.join(' / '), managed };
  }
  let supported = false;
  try { supported = ['http:', 'https:'].includes(new URL(tab.url).protocol); } catch { /* Restricted or invalid page. */ }
  return { current: { tabId: tab.id, title: tab.title || tab.url, url: tab.url, supported, bookmarkId: bookmark?.id || null }, bookmark };
}
