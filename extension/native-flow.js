import { normalizedUrl } from './core.js';

// Chrome's bookmark bubble is browser UI. Never attempt to inject into it.
// Showing an extension popup first dismisses that bubble, so its pending edits
// are committed before the user applies our folder choice to the bookmark.
export async function openNativeReview(api, node) {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url || normalizedUrl(tab.url) !== normalizedUrl(node.url)) return { opened: false, reason: 'inactive' };
  const window = await api.windows.get(tab.windowId);
  if (!window.focused || window.type !== 'normal') return { opened: false, reason: 'inactive' };
  const popup = `collect.html?review=${encodeURIComponent(node.id)}`;
  try {
    await api.action.setPopup({ tabId: tab.id, popup });
    await api.action.openPopup({ windowId: tab.windowId });
    return { opened: true, surface: 'action' };
  } catch {
    // Supported fallback if the browser refuses an action popup at this moment.
    await api.windows.create({ url: api.runtime.getURL(popup), type: 'popup', width: 480, height: 670, focused: true });
    return { opened: true, surface: 'window' };
  } finally {
    await api.action.setPopup({ tabId: tab.id, popup: 'popup.html' }).catch(() => {});
  }
}
