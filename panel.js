/*
 * 面板：并排嵌入各家 AI，向每个 iframe 派发指令，收集回答后拼对比 prompt。
 *
 * 通信路径：panel → background(relay, 按 frameId) → 目标 iframe 里的 content script。
 * 不能用 postMessage 直接跟 iframe 说话 —— 跨源，拿不到里面的 window 也收不到回应。
 */

const A = globalThis.AskManyAdapters;
const $ = (s) => document.querySelector(s);
const el = (t, p = {}) => Object.assign(document.createElement(t), p);

const STORE_KEY = 'askmany:enabled';
const STORE_ORDER_KEY = 'askmany:order';
const STORE_LAYOUT_KEY = 'askmany:layout';
const STORE_JUDGE_KEY = 'askmany:judge';
const STORE_AUTO_JUDGE_KEY = 'askmany:auto_judge';
const STORE_JUDGE_ASK_KEY = 'askmany:judge_ask';
const STORE_JUDGE_COMPARE_KEY = 'askmany:judge_compare';
const STORE_SIDEBAR_COLLAPSED_KEY = 'askmany:sidebar_collapsed';
const STORE_INPUT_HEIGHT_KEY = 'askmany:input_height';
const STORE_COL_RATIOS_KEY = 'askmany:col_ratios';
const state = {
  enabled: new Set(),
  order: [], // siteId[] 自定义排序数组
  frames: new Map(), // siteId -> {tabId, frameId}
  busy: false,
  attachments: [], // {name, type, size, data(base64), url(预览用)}
  layout: 'grid', // 'grid' | 'scroll' | 'col-2' | 'col-3'
  collapsed: new Set(), // siteId[]
  maximized: null, // siteId | null
  sidebarCollapsed: false, // 侧边栏是否收起
  judgeId: null, // siteId 担任对比裁判
  autoJudge: true, // 其他模型完成后自动派发给裁判
  judgeAnswersQuestion: false, // 裁判是否参与第一轮同问
  judgeIncludedInComparison: false, // 是否将裁判第一轮回答纳入对比
  judgePrompt: '', // 最近一次生成的对比提示词
  judgePromptJudgeId: null, // 最近一次对比提示词绑定的裁判，避免切换裁判后错派
  currentRun: null, // 当前一轮提问的参与快照与已收集回答
  lockedSites: new Set(), // 正在生成裁决的站点，避免新一轮并发写入同一 iframe
  inputHeight: null, // 底部输入框高度（px）
  colRatios: {}, // { [siteId]: number } 各列的相对 flex 比例或宽度
};

function startPointerDrag(e, { bodyClass, activeElement, onMove, onEnd }) {
  if (e.pointerType === 'mouse' && e.button !== 0) return false;

  const target = e.currentTarget;
  const pointerId = e.pointerId;
  let active = true;
  let pendingEvent = null;
  let animationFrame = 0;

  const flushMove = () => {
    animationFrame = 0;
    if (!pendingEvent) return;
    const nextEvent = pendingEvent;
    pendingEvent = null;
    onMove(nextEvent);
  };

  const handleMove = (ev) => {
    if (!active || ev.pointerId !== pointerId) return;
    pendingEvent = ev;
    if (!animationFrame) animationFrame = requestAnimationFrame(flushMove);
  };

  const finish = (ev) => {
    if (!active || (ev?.pointerId != null && ev.pointerId !== pointerId)) return;
    active = false;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (pendingEvent) onMove(pendingEvent);
    pendingEvent = null;
    animationFrame = 0;

    target.removeEventListener('pointermove', handleMove);
    target.removeEventListener('pointerup', finish);
    target.removeEventListener('pointercancel', finish);
    target.removeEventListener('lostpointercapture', finish);
    window.removeEventListener('blur', finish);
    document.body.classList.remove(bodyClass);
    activeElement?.classList.remove('is-active');

    try {
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch (_) {
      // Pointer capture may already be gone after cancellation or window blur.
    }
    onEnd?.();
  };

  e.preventDefault();
  target.addEventListener('pointermove', handleMove);
  target.addEventListener('pointerup', finish);
  target.addEventListener('pointercancel', finish);
  target.addEventListener('lostpointercapture', finish);
  window.addEventListener('blur', finish);
  document.body.classList.add(bodyClass);
  activeElement?.classList.add('is-active');
  target.setPointerCapture(pointerId);
  return true;
}

/*
 * 附件走 base64 经 sendMessage 传给 content script（File 对象无法序列化）。
 * base64 比原文件大约 1.33 倍，单文件设上限避免消息通道被撑爆。
 */
const MAX_FILE_MB = 20;
const MAX_TOTAL_MB = 40;
const mb = (n) => n / 1024 / 1024;

const fmtSize = (n) =>
  n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)}KB` : `${mb(n).toFixed(1)}MB`;

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    fr.onload = () => {
      // dataURL 形如 data:<mime>;base64,xxxx —— 只要逗号后面那段
      const s = String(fr.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  const incoming = [...fileList];
  if (!incoming.length) return;

  const errs = [];
  let total = state.attachments.reduce((s, a) => s + a.size, 0);

  for (const f of incoming) {
    if (mb(f.size) > MAX_FILE_MB) {
      errs.push(`${f.name} 超过 ${MAX_FILE_MB}MB`);
      continue;
    }
    if (mb(total + f.size) > MAX_TOTAL_MB) {
      errs.push(`总大小超过 ${MAX_TOTAL_MB}MB，${f.name} 未添加`);
      continue;
    }
    try {
      const data = await readAsBase64(f);
      state.attachments.push({
        name: f.name,
        type: f.type,
        size: f.size,
        data,
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      });
      total += f.size;
    } catch (e) {
      errs.push(e.message);
    }
  }

  renderChips();
  $('#fileHint').textContent = errs.length ? errs.join('；') : '';
}

function removeAttachment(i) {
  const a = state.attachments[i];
  if (a?.url) URL.revokeObjectURL(a.url); // 不撤销会一直占着内存
  state.attachments.splice(i, 1);
  renderChips();
}

function clearAttachments() {
  for (const a of state.attachments) if (a.url) URL.revokeObjectURL(a.url);
  state.attachments = [];
  renderChips();
  $('#fileHint').textContent = '';
}

function renderChips() {
  const box = $('#chips');
  box.textContent = '';
  state.attachments.forEach((a, i) => {
    const chip = el('div', { className: 'chip', title: `${a.name} (${fmtSize(a.size)})` });
    if (a.url) chip.append(el('img', { src: a.url, alt: a.name }));
    else chip.append(el('span', { className: 'ficon', textContent: '📄' }));
    chip.append(
      el('span', { className: 'fname', textContent: a.name }),
      el('span', { className: 'fsize', textContent: fmtSize(a.size) })
    );
    const del = el('button', { className: 'del', textContent: '×', title: '移除' });
    del.onclick = () => removeAttachment(i);
    chip.append(del);
    box.append(chip);
  });

  // 有附件时提示哪些模型不支持，避免用户以为发过去了
  const unsupported = state.order
    .filter((id) => state.enabled.has(id))
    .map((id) => A.byId(id))
    .filter((s) => s && !s.supportsFiles)
    .map((s) => s.name);
  if (state.attachments.length && unsupported.length) {
    $('#fileHint').textContent = `${unsupported.join('、')} 不支持附件，将只发文字`;
  }
}

// ------------------------------------------------------------------ frame 发现
// content script 启动时会发 frame-ready；面板据此知道每个站点落在哪个 frameId。
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'frame-ready' && sender.tab && sender.frameId != null) {
    state.frames.set(msg.siteId, { tabId: sender.tab.id, frameId: sender.frameId });
    paintDots();
  }
});

function send(siteId, payload, timeoutMs = 200000) {
  const f = state.frames.get(siteId);
  if (!f) return Promise.resolve({ ok: false, error: 'frame 未就绪' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: '超时' }), timeoutMs);
    chrome.runtime.sendMessage(
      { type: 'relay', tabId: f.tabId, frameId: f.frameId, payload: { ...payload, siteId } },
      (res) => {
        clearTimeout(timer);
        resolve(res ?? { ok: false, error: chrome.runtime.lastError?.message ?? '无响应' });
      }
    );
  });
}

// --------------------------------------------------------------------- 排序与持久化
async function saveOrder() {
  await chrome.storage.local.set({ [STORE_ORDER_KEY]: state.order });
}

function applyOrder() {
  const main = $('#cols');
  const visible = state.order.filter((id) => state.enabled.has(id));

  // 1. 设置当前可见列的 CSS order，偶数位给 col，奇数位留给 resizer
  // 注意：绝对不能调用 main.appendChild(col)！在 DOM 中移动包含 iframe 的节点会导致浏览器重载 iframe 并刷新页面！
  // Flex 容器内通过 CSS order 即可控制视觉排列，完全无需变动 DOM 树。
  visible.forEach((id, idx) => {
    const col = document.getElementById(`col-${id}`);
    if (col && main) {
      col.style.order = String(idx * 2);
    }
  });

  // 2. 根据当前启用（可见）的列更新左移/右移按钮的禁用状态
  visible.forEach((id, idx) => {
    const leftBtn = document.getElementById(`btn-left-${id}`);
    const rightBtn = document.getElementById(`btn-right-${id}`);
    if (leftBtn) leftBtn.disabled = (idx === 0);
    if (rightBtn) rightBtn.disabled = (idx === visible.length - 1);
  });

  // 3. 设置侧栏项的 CSS order
  state.order.forEach((id, idx) => {
    const item = document.getElementById(`item-${id}`);
    if (item) item.style.order = String(idx);
  });

  // 4. 应用已保存的列宽比例
  applyColRatios();

  // 5. 插入并绑定相邻列之间的拖拽分割器
  syncColResizers();
}

function applyColRatios() {
  const visible = state.order.filter((id) => state.enabled.has(id));
  if (state.layout === 'scroll') {
    for (const id of visible) {
      const col = document.getElementById(`col-${id}`);
      if (!col) continue;
      const w = state.colRatios[id];
      if (typeof w === 'number' && w >= 220) {
        col.style.flex = `0 0 ${w}px`;
        col.style.width = `${w}px`;
      } else {
        col.style.flex = '';
        col.style.width = '';
      }
    }
  } else {
    for (const id of visible) {
      const col = document.getElementById(`col-${id}`);
      if (!col) continue;
      const r = state.colRatios[id];
      if (typeof r === 'number' && r > 0) {
        col.style.flex = `${r.toFixed(4)} ${r.toFixed(4)} 0px`;
        col.style.width = '';
      } else {
        col.style.flex = '';
        col.style.width = '';
      }
    }
  }
}

function syncColResizers() {
  const main = $('#cols');
  if (!main) return;

  // 1. 移除旧的 resizer
  main.querySelectorAll('.col-resizer').forEach((r) => r.remove());

  // 2. 如果全屏聚焦单列，不显示 resizer
  if (state.maximized) return;

  // 3. 获取当前启用的可见列（按 order 顺序）
  const visibleIds = state.order.filter((id) => state.enabled.has(id));
  if (visibleIds.length <= 1) return;

  // 4. 在相邻列之间插入 resizer（通过 CSS order 置于两列之间，无需移动列 DOM）
  for (let i = 0; i < visibleIds.length - 1; i++) {
    const leftId = visibleIds[i];
    const rightId = visibleIds[i + 1];
    const leftCol = document.getElementById(`col-${leftId}`);
    const rightCol = document.getElementById(`col-${rightId}`);
    if (!leftCol || !rightCol) continue;

    const resizer = el('div', {
      className: 'col-resizer',
      title: '按住左右拖拽调节列宽，双击恢复等宽',
    });
    resizer.tabIndex = 0;
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', `调整 ${A.byId(leftId)?.name || leftId} 与 ${A.byId(rightId)?.name || rightId} 的宽度`);
    resizer.setAttribute('aria-valuemin', '0');
    resizer.setAttribute('aria-valuemax', '100');
    resizer.setAttribute('aria-valuenow', '50');
    resizer.style.order = String(i * 2 + 1);
    resizer.dataset.left = leftId;
    resizer.dataset.right = rightId;

    const isCollapsed = state.collapsed.has(leftId) || state.collapsed.has(rightId);
    if (isCollapsed) {
      resizer.classList.add('is-collapsed-adjacent');
      resizer.tabIndex = -1;
      resizer.setAttribute('aria-disabled', 'true');
    } else {
      resizer.setAttribute('aria-disabled', 'false');
    }

    main.appendChild(resizer);
    bindColResizer(resizer, leftCol, rightCol, leftId, rightId);
  }
}

function bindColResizer(resizer, leftCol, rightCol, leftId, rightId) {
  const getColRatio = (col, id) => {
    if (typeof state.colRatios[id] === 'number' && state.colRatios[id] > 0) {
      return state.colRatios[id];
    }
    const ratio = Number.parseFloat(getComputedStyle(col).flexGrow);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  };

  const getMinWidth = (col) => {
    const minWidth = Number.parseFloat(getComputedStyle(col).minWidth);
    return Number.isFinite(minWidth) && minWidth > 0 ? minWidth : 0;
  };

  const syncAriaValue = () => {
    const leftW = leftCol.getBoundingClientRect().width;
    const rightW = rightCol.getBoundingClientRect().width;
    const totalW = leftW + rightW;
    if (!totalW) return;
    const minLeft = Math.min(getMinWidth(leftCol), totalW / 2);
    const minRight = Math.min(getMinWidth(rightCol), totalW / 2);
    resizer.setAttribute('aria-valuemin', String(Math.round((minLeft / totalW) * 100)));
    resizer.setAttribute('aria-valuemax', String(Math.round(((totalW - minRight) / totalW) * 100)));
    resizer.setAttribute('aria-valuenow', String(Math.round((leftW / totalW) * 100)));
  };

  const applyPairWidths = (newLeftW, newRightW, totalRatio) => {
    const totalW = newLeftW + newRightW;
    if (state.layout === 'scroll') {
      const leftW = Math.round(newLeftW);
      const rightW = Math.round(newRightW);
      leftCol.style.flex = `0 0 ${leftW}px`;
      leftCol.style.width = `${leftW}px`;
      rightCol.style.flex = `0 0 ${rightW}px`;
      rightCol.style.width = `${rightW}px`;
      state.colRatios[leftId] = leftW;
      state.colRatios[rightId] = rightW;
    } else {
      const leftRatio = (newLeftW / totalW) * totalRatio;
      const rightRatio = totalRatio - leftRatio;
      leftCol.style.flex = `${leftRatio.toFixed(4)} 1 0px`;
      rightCol.style.flex = `${rightRatio.toFixed(4)} 1 0px`;
      state.colRatios[leftId] = Number(leftRatio.toFixed(4));
      state.colRatios[rightId] = Number(rightRatio.toFixed(4));
    }
    syncAriaValue();
  };

  const resizeBy = (dx) => {
    const startLeftW = leftCol.getBoundingClientRect().width;
    const startRightW = rightCol.getBoundingClientRect().width;
    const totalW = startLeftW + startRightW;
    const minLeft = Math.min(getMinWidth(leftCol), totalW / 2);
    const minRight = Math.min(getMinWidth(rightCol), totalW / 2);
    const newLeftW = Math.max(minLeft, Math.min(totalW - minRight, startLeftW + dx));
    const totalRatio = getColRatio(leftCol, leftId) + getColRatio(rightCol, rightId);
    applyPairWidths(newLeftW, totalW - newLeftW, totalRatio);
  };

  resizer.addEventListener('pointerdown', (e) => {
    if (state.collapsed.has(leftId) || state.collapsed.has(rightId)) return;
    const startX = e.clientX;

    const leftRect = leftCol.getBoundingClientRect();
    const rightRect = rightCol.getBoundingClientRect();
    const startLeftW = leftRect.width;
    const startRightW = rightRect.width;
    const totalW = startLeftW + startRightW;

    const ratioLeftStart = getColRatio(leftCol, leftId);
    const ratioRightStart = getColRatio(rightCol, rightId);
    const totalRatio = ratioLeftStart + ratioRightStart;
    const minLeft = Math.min(getMinWidth(leftCol), totalW / 2);
    const minRight = Math.min(getMinWidth(rightCol), totalW / 2);

    startPointerDrag(e, {
      bodyClass: 'is-resizing-cols',
      activeElement: resizer,
      onMove: (ev) => {
        const dx = ev.clientX - startX;
        const newLeftW = Math.max(minLeft, Math.min(totalW - minRight, startLeftW + dx));
        applyPairWidths(newLeftW, totalW - newLeftW, totalRatio);
      },
      onEnd: () => chrome.storage.local.set({ [STORE_COL_RATIOS_KEY]: state.colRatios }),
    });
  });

  resizer.addEventListener('keydown', (e) => {
    if (state.collapsed.has(leftId) || state.collapsed.has(rightId)) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    resizeBy((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 40 : 12));
    chrome.storage.local.set({ [STORE_COL_RATIOS_KEY]: state.colRatios });
  });

  resizer.addEventListener('dblclick', () => {
    if (state.collapsed.has(leftId) || state.collapsed.has(rightId)) return;
    delete state.colRatios[leftId];
    delete state.colRatios[rightId];
    leftCol.style.flex = '';
    leftCol.style.width = '';
    rightCol.style.flex = '';
    rightCol.style.width = '';
    chrome.storage.local.set({ [STORE_COL_RATIOS_KEY]: state.colRatios });
    requestAnimationFrame(syncAriaValue);
  });

  requestAnimationFrame(syncAriaValue);
}

async function moveModel(siteId, delta) {
  const visible = state.order.filter((id) => state.enabled.has(id));
  const currIdx = visible.indexOf(siteId);
  if (currIdx === -1) return;
  const targetIdx = currIdx + delta;
  if (targetIdx < 0 || targetIdx >= visible.length) return;

  const targetId = visible[targetIdx];
  const idxA = state.order.indexOf(siteId);
  const idxB = state.order.indexOf(targetId);
  if (idxA === -1 || idxB === -1) return;

  // 交换顺序
  const temp = state.order[idxA];
  state.order[idxA] = state.order[idxB];
  state.order[idxB] = temp;

  await saveOrder();
  applyOrder();
}

// --------------------------------------------------------------------- 渲染
function paintDots() {
  for (const a of A.ADAPTERS) {
    const dot = document.getElementById(`dot-${a.id}`);
    if (!dot) continue;
    const on = state.enabled.has(a.id);
    const ready = state.frames.has(a.id);
    dot.className = 'dot' + (on ? (ready ? ' live' : ' warn') : '');
    dot.title = !on ? '未启用' : ready ? '已就绪' : '加载中或被拦截';
  }
}

const SITE_THEMES = {
  chatgpt: { color: '#10a37f', badge: 'GPT' },
  deepseek: { color: '#4d6bfe', badge: 'DS' },
  claude: { color: '#d97706', badge: 'CL' },
  gemini: { color: '#8b5cf6', badge: 'GEM' },
  qwen: { color: '#6366f1', badge: 'QW' },
  yuanbao: { color: '#f97316', badge: 'YB' },
  kimi: { color: '#00a3ff', badge: 'KM' },
  doubao: { color: '#2563eb', badge: 'DB' },
  chatglm: { color: '#4f46e5', badge: 'GLM' },
  grok: { color: '#111827', badge: 'GROK' },
  perplexity: { color: '#22b8cf', badge: 'PPLX' },
  mimo: { color: '#ff6900', badge: 'MIMO' },
};

let draggedId = null;

function buildHeader() {
  const box = $('#sites');
  box.textContent = '';
  for (const a of A.ADAPTERS) {
    const item = el('div', { className: 'model-item', id: `item-${a.id}` });
    item.draggable = true;

    const handle = el('span', { className: 'drag-handle', textContent: '⋮⋮', title: '按住拖拽排序' });

    const cb = el('input', { type: 'checkbox', id: `chk-${a.id}` });
    cb.checked = state.enabled.has(a.id);
    if (cb.checked) item.classList.add('active');

    cb.onchange = () => {
      if (cb.checked) {
        state.enabled.add(a.id);
        item.classList.add('active');
      } else {
        state.enabled.delete(a.id);
        item.classList.remove('active');
        if (state.judgeId === a.id) {
          setJudge(null);
        }
      }
      chrome.storage.local.set({ [STORE_KEY]: [...state.enabled] });
      buildCols();
      updateCount();
      populateJudgeSelect();
    };

    const theme = SITE_THEMES[a.id] || { color: '#64748b', badge: a.name.slice(0, 2).toUpperCase() };
    const badge = el('span', {
      className: 'model-badge',
      textContent: theme.badge,
      style: `background: ${theme.color}22; color: ${theme.color}; border: 1px solid ${theme.color}44;`,
    });

    const isJudge = state.judgeId === a.id;
    if (isJudge) item.classList.add('is-judge');

    const judgeCrownBtn = el('button', {
      className: 'judge-crown-btn' + (isJudge ? ' active' : ''),
      id: `crown-${a.id}`,
      title: isJudge ? '取消设为裁判' : '设为对比裁判（可在裁判列顶部设置参与范围）',
      textContent: '👑',
    });
    judgeCrownBtn.onclick = (e) => {
      e.stopPropagation();
      if (!state.enabled.has(a.id)) {
        state.enabled.add(a.id);
        cb.checked = true;
        item.classList.add('active');
        chrome.storage.local.set({ [STORE_KEY]: [...state.enabled] });
        buildCols();
        updateCount();
      }
      setJudge(state.judgeId === a.id ? null : a.id);
    };

    const lab = el('label', { htmlFor: `chk-${a.id}`, className: 'model-name', textContent: a.name });
    const dot = el('span', { className: 'model-dot', id: `dot-${a.id}` });

    item.addEventListener('dragstart', (e) => {
      draggedId = a.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', a.id);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedId = null;
      document.querySelectorAll('.model-item').forEach((el) => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (draggedId && draggedId !== a.id) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!draggedId || draggedId === a.id) return;

      const fromIdx = state.order.indexOf(draggedId);
      const toIdx = state.order.indexOf(a.id);
      if (fromIdx === -1 || toIdx === -1) return;

      state.order.splice(fromIdx, 1);
      state.order.splice(toIdx, 0, draggedId);

      await saveOrder();
      applyOrder();
    });

    item.append(handle, cb, badge, lab, judgeCrownBtn, dot);
    box.append(item);
  }
}

function buildCols() {
  const main = $('#cols');

  // 已存在的列只切换显示/隐藏（打开/关闭），严禁重建或从 DOM 中移除，以保护 iframe 实例不被刷新
  for (const a of A.ADAPTERS) {
    const existing = document.getElementById(`col-${a.id}`);
    const on = state.enabled.has(a.id);
    if (on) {
      if (!existing) {
        main.append(makeCol(a));
      } else {
        existing.classList.remove('col-closed');
        existing.style.display = '';
      }
    } else if (existing) {
      existing.classList.add('col-closed');
      existing.style.display = 'none';
      if (state.maximized === a.id) {
        toggleMaximize(a.id);
      }
      if (state.judgeId === a.id) {
        setJudge(null);
      }
    }
  }
  paintDots();
  applyOrder();
  updateCount();
  populateJudgeSelect();
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

function updateCount() {
  const countEl = $('#enabledCount');
  if (countEl) {
    countEl.textContent = `已选 ${state.enabled.size} / ${A.ADAPTERS.length} 个模型`;
  }
}

// --------------------------------------------------------------------- 裁判模型管理
function syncJudgeParticipationControls() {
  for (const a of A.ADAPTERS) {
    const isJudge = state.judgeId === a.id;
    const bar = document.getElementById(`judge-participation-${a.id}`);
    const askToggle = document.getElementById(`judge-ask-${a.id}`);
    const compareToggle = document.getElementById(`judge-compare-${a.id}`);

    if (bar) bar.hidden = !isJudge;
    if (askToggle) askToggle.checked = state.judgeAnswersQuestion;
    if (compareToggle) {
      compareToggle.checked = state.judgeAnswersQuestion && state.judgeIncludedInComparison;
      compareToggle.disabled = !state.judgeAnswersQuestion;
      compareToggle.setAttribute(
        'aria-label',
        state.judgeAnswersQuestion
          ? '是否参与比对'
          : '是否参与比对（需先开启是否参与问题）'
      );
    }
  }
}

function setJudgeParticipation({ answersQuestion, includedInComparison }) {
  state.judgeAnswersQuestion = Boolean(answersQuestion);
  state.judgeIncludedInComparison = state.judgeAnswersQuestion && Boolean(includedInComparison);
  syncJudgeParticipationControls();
  chrome.storage.local.set({
    [STORE_JUDGE_ASK_KEY]: state.judgeAnswersQuestion,
    [STORE_JUDGE_COMPARE_KEY]: state.judgeIncludedInComparison,
  });
}

function setJudge(siteId) {
  const nextJudgeId = siteId || null;
  if (state.judgeId !== nextJudgeId) {
    // 切换裁判后旧监控不得把上一轮提示词派发到新裁判。
    activeSynthesisToken++;
    state.judgePrompt = '';
    state.judgePromptJudgeId = null;
  }
  state.judgeId = nextJudgeId;
  chrome.storage.local.set({ [STORE_JUDGE_KEY]: state.judgeId });

  // 1. 同步更新下拉框
  const judgeSel = $('#judgeSelect');
  if (judgeSel && judgeSel.value !== (state.judgeId || '')) {
    judgeSel.value = state.judgeId || '';
  }

  // 2. 同步侧边栏皇冠状态
  for (const a of A.ADAPTERS) {
    const item = document.getElementById(`item-${a.id}`);
    const crown = document.getElementById(`crown-${a.id}`);
    const isThis = state.judgeId === a.id;
    if (item) item.classList.toggle('is-judge', isThis);
    if (crown) {
      crown.classList.toggle('active', isThis);
      crown.title = isThis ? '取消设为裁判' : '设为对比裁判（可在裁判列顶部设置参与范围）';
    }
  }

  // 3. 同步列头裁判徽章与按钮
  for (const a of A.ADAPTERS) {
    const col = document.getElementById(`col-${a.id}`);
    const judgeTag = document.getElementById(`judge-badge-${a.id}`);
    const judgeBtn = document.getElementById(`btn-judge-${a.id}`);
    const meta = document.getElementById(`meta-${a.id}`);
    const isThis = state.judgeId === a.id;
    if (col) {
      col.classList.toggle('is-judge', isThis);
      if (judgeTag) judgeTag.style.display = isThis ? 'inline-flex' : 'none';
      if (judgeBtn) {
        judgeBtn.classList.toggle('active', isThis);
        judgeBtn.title = isThis ? '取消设为裁判' : '设为对比裁判';
      }
      if (isThis) {
        const curMeta = meta?.textContent || '';
        if (!curMeta || curMeta === '已发送' || curMeta.includes('✓')) {
          setMeta(a.id, '👑 对比裁判就位');
        }
      } else {
        const curMeta = meta?.textContent || '';
        if (curMeta.startsWith('👑')) {
          setMeta(a.id, '');
        }
      }
    }
  }

  syncJudgeParticipationControls();
  updateDlgJudgeButton();
}

function populateJudgeSelect() {
  const sel = $('#judgeSelect');
  if (!sel) return;
  const current = state.judgeId;
  sel.innerHTML = '<option value="">(不设裁判，全员作答)</option>';

  const enabledList = state.order.filter((id) => state.enabled.has(id));
  enabledList.forEach((id) => {
    const a = A.byId(id);
    if (a) {
      const opt = el('option', { value: id, textContent: a.name });
      sel.append(opt);
    }
  });

  if (current && enabledList.includes(current)) {
    sel.value = current;
  } else if (current) {
    setJudge(null);
  }
}

function updateDlgJudgeButton() {
  const btn = $('#dlgSendJudge');
  const goBtn = $('#dlgGoJudge');
  if (!btn) return;
  const targetJudgeId = state.judgePromptJudgeId || state.judgeId;
  if (targetJudgeId && A.byId(targetJudgeId)) {
    const name = A.byId(targetJudgeId).name;
    const promptRun = state.currentRun?.judgeId === targetJudgeId
      ? state.currentRun
      : null;
    const dispatching = Boolean(promptRun?.dispatchInFlight);
    const dispatched = Boolean(promptRun?.comparisonDispatched);
    btn.innerHTML = `<span>${dispatching ? '⏳' : '👑'} ${dispatched ? '已派发' : dispatching ? '正在派发给' : '派发给'} [${name}]${dispatched ? '' : ' 对比分析'}</span>`;
    btn.style.display = 'inline-flex';
    btn.disabled = dispatching || dispatched;
    btn.onclick = () => {
      $('#dlg').close();
      if (state.judgePrompt && !dispatching && !dispatched) {
        if (promptRun) dispatchRunToJudge(promptRun, state.judgePrompt);
        else dispatchToJudge(targetJudgeId, state.judgePrompt);
      }
    };
    if (goBtn) {
      goBtn.style.display = 'inline-flex';
      goBtn.innerHTML = `<span>🔍 前往 [${name}] 窗口</span>`;
      goBtn.onclick = () => focusJudgeColumn(targetJudgeId);
    }
  } else {
    btn.style.display = 'none';
    btn.disabled = false;
    if (goBtn) goBtn.style.display = 'none';
  }
}

function focusJudgeColumn(judgeId) {
  if (!judgeId) return;
  const col = document.getElementById(`col-${judgeId}`);
  if (!col) return;
  $('#dlg')?.close();
  if (state.collapsed.has(judgeId)) {
    toggleCollapse(judgeId);
  }
  col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  col.classList.remove('judge-highlight-pulse');
  void col.offsetWidth; // 触发回流执行动画
  col.classList.add('judge-highlight-pulse');
}

function renderCompareDialog(question, entries, prompt, judgeId, { duel = false } = {}) {
  // 1. 设置对比问题
  const qEl = $('#dlgQuestion');
  if (qEl) qEl.textContent = question || '(未记录原问题)';

  // 2. 渲染参评模型小标签
  const tagsWrap = $('#dlgModelsTags');
  if (tagsWrap) {
    tagsWrap.innerHTML = '';
    for (const e of entries) {
      const badge = el('span', { className: 'dlg-model-badge' });
      badge.textContent = `${e.name} (${e.text.length}字)`;
      tagsWrap.appendChild(badge);
    }
  }

  // 3. 裁判模型状态信息
  const judgeRow = $('#dlgJudgeRow');
  const judgeNameEl = $('#dlgJudgeName');
  const judgeStatusText = $('#judgeStatusText');
  const btnFocusJudgeCol = $('#btnFocusJudgeCol');
  const dlgGoJudge = $('#dlgGoJudge');

  if (judgeId && A.byId(judgeId)) {
    const jName = A.byId(judgeId).name;
    if (judgeRow) judgeRow.style.display = 'flex';
    if (judgeNameEl) judgeNameEl.textContent = `👑 ${jName}`;
    if (judgeStatusText) {
      if (duel && entries.length === 1) {
        judgeStatusText.textContent = `⚡ 当前为 1v1 单挑切磋模式：[${jName}] 将针对原问题给出独立解答，并与 [${entries[0].name}] 的回答深度对比与融合采纳！`;
      } else {
        judgeStatusText.textContent = `⚡ 当前由 [${jName}] 担任终极裁判。标准：直观打分 ➔ 亮点与不足 ➔ 详细整理采纳方案！`;
      }
    }
    if (btnFocusJudgeCol) {
      btnFocusJudgeCol.style.display = 'inline-flex';
      btnFocusJudgeCol.onclick = () => focusJudgeColumn(judgeId);
    }
    if (dlgGoJudge) {
      dlgGoJudge.style.display = 'inline-flex';
      dlgGoJudge.innerHTML = `<span>🔍 前往 [${jName}] 窗口</span>`;
      dlgGoJudge.onclick = () => focusJudgeColumn(judgeId);
    }
  } else {
    if (judgeRow) judgeRow.style.display = 'none';
    if (judgeStatusText) {
      judgeStatusText.textContent = '💡 提示：在底部指定一个模型作为对比裁判，作答完成后可自动生成结构化裁决报告。';
    }
    if (btnFocusJudgeCol) btnFocusJudgeCol.style.display = 'none';
    if (dlgGoJudge) dlgGoJudge.style.display = 'none';
  }

  // 4. 渲染各模型回答的折叠卡片列表
  const cardsList = $('#answersCardsList');
  if (cardsList) {
    cardsList.innerHTML = '';
    entries.forEach((e, idx) => {
      const card = el('div', { className: 'answer-card' + (idx === 0 ? ' open' : '') });
      const cardHeader = el('div', { className: 'answer-card-header' });
      const left = el('div', { className: 'answer-card-left' });
      const title = el('span', { textContent: e.name });
      const count = el('span', { className: 'answer-card-badge', textContent: `(${e.text.length} 字)` });
      left.append(title, count);

      const right = el('div', { style: 'display:flex;align-items:center;gap:6px' });
      const copyBtn = el('button', { className: 'btn-copy-card', textContent: '复制回答' });
      copyBtn.onclick = async (evt) => {
        evt.stopPropagation();
        await navigator.clipboard.writeText(e.text);
        copyBtn.textContent = '已复制';
        setTimeout(() => (copyBtn.textContent = '复制回答'), 1500);
      };
      const arrow = el('span', { textContent: idx === 0 ? '▼' : '▶', style: 'font-size:10px;color:#94a3b8' });
      right.append(copyBtn, arrow);

      cardHeader.append(left, right);
      cardHeader.onclick = () => {
        const isOpen = card.classList.toggle('open');
        arrow.textContent = isOpen ? '▼' : '▶';
      };

      const cardBody = el('div', { className: 'answer-card-body', textContent: e.text });
      card.append(cardHeader, cardBody);
      cardsList.appendChild(card);
    });
  }

  // 5. 设置完整提示词内容与字数
  const textEl = $('#dlgText');
  if (textEl) textEl.textContent = prompt;
  const metaEl = $('#dlgMeta');
  if (metaEl) metaEl.textContent = `${entries.length} 份回答 · ${prompt.length} 字`;

  // 更新 Tab 按钮数字
  const btnTabAnswers = $('#btnTabAnswers');
  if (btnTabAnswers) btnTabAnswers.textContent = `📦 各模型作答 (${entries.length})`;

  updateDlgJudgeButton();
}

function toggleMaximize(id) {
  const col = document.getElementById(`col-${id}`);
  const btn = document.getElementById(`btn-max-${id}`);
  if (state.maximized === id) {
    state.maximized = null;
    col?.classList.remove('maximized');
    if (btn) {
      btn.textContent = '⛶';
      btn.title = '全屏聚焦';
    }
  } else {
    if (state.maximized) {
      const prevCol = document.getElementById(`col-${state.maximized}`);
      const prevBtn = document.getElementById(`btn-max-${state.maximized}`);
      prevCol?.classList.remove('maximized');
      if (prevBtn) {
        prevBtn.textContent = '⛶';
        prevBtn.title = '全屏聚焦';
      }
    }
    if (state.collapsed.has(id)) {
      state.collapsed.delete(id);
      col?.classList.remove('collapsed');
    }
    state.maximized = id;
    col?.classList.add('maximized');
    if (btn) {
      btn.textContent = '↙';
      btn.title = '还原视图';
    }
  }
  syncColResizers();
}

function toggleCollapse(id) {
  const col = document.getElementById(`col-${id}`);
  if (!col) return;
  if (state.maximized === id) {
    toggleMaximize(id);
  }
  if (state.collapsed.has(id)) {
    state.collapsed.delete(id);
    col.classList.remove('collapsed');
  } else {
    state.collapsed.add(id);
    col.classList.add('collapsed');
  }
  syncColResizers();
}

function toggleSidebar(forceState) {
  const willCollapse = typeof forceState === 'boolean' ? forceState : !state.sidebarCollapsed;
  state.sidebarCollapsed = willCollapse;

  const aside = $('aside');
  if (aside) {
    aside.classList.toggle('collapsed', willCollapse);
  }

  const toggleBtn = $('#btnToggleSidebar');
  if (toggleBtn) {
    toggleBtn.classList.toggle('sidebar-is-collapsed', willCollapse);
    toggleBtn.title = willCollapse ? '展开侧边栏 (Ctrl+B)' : '收起侧边栏 (Ctrl+B)';
  }

  chrome.storage.local.set({ [STORE_SIDEBAR_COLLAPSED_KEY]: willCollapse });
}

function setLayoutMode(mode) {
  const validModes = ['grid', 'scroll', 'col-2', 'col-3'];
  if (!validModes.includes(mode)) mode = 'grid';
  state.layout = mode;

  const main = $('#cols');
  if (main) {
    validModes.forEach((m) => main.classList.remove(`mode-${m}`));
    main.classList.add(`mode-${mode}`);
  }

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const scrollNav = $('#scrollNav');
  if (scrollNav) {
    scrollNav.classList.toggle('visible', mode === 'scroll');
  }

  applyColRatios();
  syncColResizers();

  chrome.storage.local.set({ [STORE_LAYOUT_KEY]: mode });
}

async function setEnabledModels(newSet) {
  state.enabled = new Set(newSet);
  if (state.judgeId && !state.enabled.has(state.judgeId)) {
    setJudge(null);
  }
  for (const a of A.ADAPTERS) {
    const cb = document.getElementById(`chk-${a.id}`);
    const item = document.getElementById(`item-${a.id}`);
    if (cb) cb.checked = state.enabled.has(a.id);
    if (item) {
      if (state.enabled.has(a.id)) item.classList.add('active');
      else item.classList.remove('active');
    }
  }
  await chrome.storage.local.set({ [STORE_KEY]: [...state.enabled] });
  buildCols();
}

function selectAllModels() {
  setEnabledModels(A.ADAPTERS.map((a) => a.id));
}

function clearAllModels() {
  setEnabledModels([]);
}

const PRESET_DOMESTIC = ['deepseek', 'yuanbao', 'kimi', 'doubao', 'qwen', 'mimo', 'chatglm'];
const PRESET_GLOBAL = ['chatgpt', 'claude', 'gemini', 'grok', 'perplexity'];

function applyPreset(presetIds) {
  const valid = presetIds.filter((id) => A.byId(id));
  setEnabledModels(valid);
}

function makeCol(a) {
  const isJudge = state.judgeId === a.id;
  const col = el('div', { className: 'col' + (isJudge ? ' is-judge' : ''), id: `col-${a.id}` });
  if (state.maximized === a.id) col.classList.add('maximized');
  if (state.collapsed.has(a.id)) col.classList.add('collapsed');

  const h = el('h2');
  const theme = SITE_THEMES[a.id] || { color: '#64748b', badge: a.name.slice(0, 2).toUpperCase() };

  const brandDot = el('span', {
    className: 'col-brand-dot',
    style: `background: ${theme.color}; box-shadow: 0 0 8px ${theme.color}88;`,
  });
  const nameSpan = el('span', { className: 'name', textContent: a.name });
  const judgeBadge = el('span', {
    className: 'col-judge-badge',
    id: `judge-badge-${a.id}`,
    textContent: '👑 裁判',
    style: isJudge ? 'display: inline-flex;' : 'display: none;',
  });
  const metaSpan = el('span', { className: 'meta', id: `meta-${a.id}` });

  const actions = el('div', { className: 'col-actions' });
  const leftBtn = el('button', {
    className: 'col-btn',
    id: `btn-left-${a.id}`,
    title: '向左移动',
    textContent: '◀',
  });
  leftBtn.onclick = (e) => { e.stopPropagation(); moveModel(a.id, -1); };

  const rightBtn = el('button', {
    className: 'col-btn',
    id: `btn-right-${a.id}`,
    title: '向右移动',
    textContent: '▶',
  });
  rightBtn.onclick = (e) => { e.stopPropagation(); moveModel(a.id, 1); };

  const judgeBtn = el('button', {
    className: 'col-btn btn-judge' + (isJudge ? ' active' : ''),
    id: `btn-judge-${a.id}`,
    title: isJudge ? '取消设为裁判' : '设为对比裁判（可在裁判列顶部设置参与范围）',
    textContent: '👑',
  });
  judgeBtn.onclick = (e) => { e.stopPropagation(); setJudge(state.judgeId === a.id ? null : a.id); };

  const maxBtn = el('button', {
    className: 'col-btn',
    id: `btn-max-${a.id}`,
    title: state.maximized === a.id ? '还原视图' : '全屏聚焦',
    textContent: state.maximized === a.id ? '↙' : '⛶',
  });
  maxBtn.onclick = (e) => { e.stopPropagation(); toggleMaximize(a.id); };

  const colBtn = el('button', {
    className: 'col-btn',
    id: `btn-col-${a.id}`,
    title: '折叠',
    textContent: '−',
  });
  colBtn.onclick = (e) => { e.stopPropagation(); toggleCollapse(a.id); };

  actions.append(leftBtn, rightBtn, judgeBtn, maxBtn, colBtn);
  h.append(brandDot, nameSpan, judgeBadge, metaSpan, actions);

  // 折叠时点击标题栏展开
  h.onclick = () => {
    if (state.collapsed.has(a.id)) {
      toggleCollapse(a.id);
    }
  };

  const participationBar = el('div', {
    className: 'judge-participation-bar',
    id: `judge-participation-${a.id}`,
    hidden: !isJudge,
  });
  const makeParticipationToggle = (kind, labelText, checked, disabled, title) => {
    const label = el('label', { className: 'judge-participation-toggle', title });
    const input = el('input', {
      type: 'checkbox',
      id: `judge-${kind}-${a.id}`,
      checked,
      disabled,
    });
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', labelText);
    label.append(
      el('span', { className: 'judge-participation-label', textContent: labelText }),
      input,
      el('span', { className: 'judge-switch-track', ariaHidden: 'true' })
    );
    return { label, input };
  };

  const askParticipation = makeParticipationToggle(
    'ask',
    '是否参与问题',
    state.judgeAnswersQuestion,
    false,
    '开启后，裁判也会收到第一轮原问题并独立作答'
  );
  const compareParticipation = makeParticipationToggle(
    'compare',
    '是否参与比对',
    state.judgeAnswersQuestion && state.judgeIncludedInComparison,
    !state.judgeAnswersQuestion,
    '开启后，将裁判的第一轮回答也纳入横向对比；必须先参与问题'
  );

  askParticipation.input.addEventListener('change', () => {
    setJudgeParticipation({
      answersQuestion: askParticipation.input.checked,
      includedInComparison: askParticipation.input.checked && compareParticipation.input.checked,
    });
  });
  compareParticipation.input.addEventListener('change', () => {
    setJudgeParticipation({
      answersQuestion: askParticipation.input.checked,
      includedInComparison: compareParticipation.input.checked,
    });
  });
  participationBar.append(askParticipation.label, compareParticipation.label);

  const frame = el('iframe', { src: a.url, id: `if-${a.id}` });

  const fb = el('div', { className: 'fallback' });
  fb.append(
    el('div', { textContent: `${a.name} 未能嵌入。` }),
    el('div', { textContent: '可能是未登录、需要人机验证，或该站点新增了嵌套限制。' }),
    (() => { const link = el('a', { textContent: '在新标签页打开 →', href: a.url });
             link.target = '_blank'; return link; })()
  );

  col.append(h, participationBar, frame, fb);

  // iframe 被网络层拦掉时不会触发 error，只能靠"迟迟没有 frame-ready"判断。
  setTimeout(() => {
    if (!state.frames.has(a.id)) col.classList.add('blocked');
  }, 12000);

  return col;
}

const setMeta = (siteId, text) => {
  const m = document.getElementById(`meta-${siteId}`);
  if (m) m.textContent = text;
};

// --------------------------------------------------------------------- 动作
let lastQuestion = '';
let activeSynthesisToken = 0;

async function ask() {
  const text = $('#q').value.replace(/\r\n/g, '\n').trim();
  const files = state.attachments;
  // 只有附件没有文字也允许发（发图问"这是什么"是常见用法）
  if ((!text && !files.length) || state.busy) return;
  const targets = state.order.filter((id) => state.enabled.has(id));
  if (!targets.length) { $('#status').textContent = '先勾选至少一个模型'; return; }

  // 每次发送都冻结本轮参与规则；之后切换开关只影响下一轮。
  activeSynthesisToken++;
  state.judgePrompt = '';
  state.judgePromptJudgeId = null;
  const judgeId = state.judgeId && state.enabled.has(state.judgeId) ? state.judgeId : null;
  const judgeAnswersQuestion = Boolean(judgeId && state.judgeAnswersQuestion);
  const judgeIncludedInComparison = Boolean(
    judgeAnswersQuestion && state.judgeIncludedInComparison
  );
  const askTargets = targets.filter((id) => id !== judgeId || judgeAnswersQuestion);

  if (judgeId && !judgeAnswersQuestion && !askTargets.length) {
    $('#status').textContent = '当前只选择了裁判；请开启“是否参与问题”或再勾选一个作答模型';
    return;
  }

  const requiredSites = new Set(askTargets);
  if (judgeId && state.autoJudge) requiredSites.add(judgeId);
  const lockedId = [...requiredSites].find((id) => state.lockedSites.has(id));
  if (lockedId) {
    const lockedName = A.byId(lockedId)?.name || lockedId;
    $('#status').textContent = `[${lockedName}] 正在生成上一轮裁决，请完成后再开始新一轮`;
    return;
  }

  const run = {
    question: text,
    judgeId,
    judgeAnswersQuestion,
    judgeIncludedInComparison,
    askedIds: [...askTargets],
    preparedIds: [],
    firedIds: [],
    waitIds: [],
    plannedComparisonIds: askTargets.filter(
      (id) => id !== judgeId || judgeIncludedInComparison
    ),
    comparisonIds: [],
    answerBaselines: {},
    answerBaselineCounts: {},
    answers: {},
    comparisonDispatched: false,
    dispatchInFlight: false,
    dispatchPromise: null,
  };
  state.currentRun = run;

  state.busy = true;
  $('#go').disabled = true;
  lastQuestion = text;

  const judgeName = judgeId && A.byId(judgeId) ? A.byId(judgeId).name : '';
  const judgeSuffix = judgeId
    ? judgeAnswersQuestion
      ? `（👑 ${judgeName} 同步作答）`
      : `（👑 ${judgeName} 候审中）`
    : '';
  $('#status').textContent = files.length
    ? `发送到 ${askTargets.length} 个模型${judgeSuffix}（含 ${files.length} 个附件，上传可能较慢）…`
    : `发送到 ${askTargets.length} 个模型${judgeSuffix}…`;

  askTargets.forEach((id) => setMeta(id, files.length ? '上传中' : '发送中'));
  if (judgeId) {
    if (judgeAnswersQuestion) {
      setMeta(judgeId, '👑 裁判参与回答中…');
    } else if (askTargets.length === 1) {
      setMeta(judgeId, `👑 裁判就位 (单挑模式: 待会我来解答并裁决)`);
    } else {
      setMeta(judgeId, `👑 裁判就位 (等待 ${askTargets.length} 家模型作答…)`);
    }
  }

  const autoSend = $('#autosend').checked;

  // 附件只发给支持的站点；不支持的照常发文字，避免整条消息卡住
  const payloadFiles = files.map(({ name, type, data }) => ({ name, type, data }));
  const filesFor = (id) => (A.byId(id)?.supportsFiles ? payloadFiles : []);

  /*
   * 上传等待要短。之前给 150 秒，结果站点已经收下图了但缩略图选择器认不出，
   * 就白等满两分半 —— 卡住不发比附件没跟上糟得多。25 秒足够本地文件进预览，
   * 而按钮型站点还有 waitSendable 兜着（上传中发送键是 disabled 的）。
   */
  const uploadMs = files.length ? 25000 : 0;
  const prepareTimeout = files.length ? 45000 : 20000;

  /*
   * 注入后确认站点收下附件的窗口。必须显式给，否则 attachFiles 用它自己的
   * 默认值，两条注入路径合起来能白等好几秒，界面就一直停在"上传中"。
   */
  const verifyMs = files.length ? 2500 : 0;

  /*
   * 两阶段派发，这样各站点是真的"同时"提交：
   *   1. prepare 并发下发 —— 各站点填入文本并等自己的发送按钮就绪。
   *      这一步耗时因站点而异（ChatGPT 的按钮几乎立刻可用，有些站点要等上一两秒）。
   *   2. 全部就绪后再并发 fire —— 提交环节不含任何等待，各家几乎在同一瞬间发出。
   */
  const prepared = await Promise.all(
    askTargets.map((id) =>
      send(id, { type: 'prepare', text, files: filesFor(id), armMs: 2500, uploadMs, verifyMs },
           prepareTimeout)
        .then((r) => {
          const p = { id, ...r };
          if (!p.ok) setMeta(p.id, `失败: ${p.error}`);
          else {
            const base = autoSend ? '待发送' : '已填入';
            setMeta(p.id, p.fileError ? `${base}（附件: ${p.fileError}）`
                                      : p.attached ? `${base}（${p.attached} 附件）` : base);
          }
          return p;
        }))
  );

  const ready = prepared.filter((p) => p.ok).map((p) => p.id);
  for (const p of prepared) {
    if (!p.ok) continue;
    run.answerBaselines[p.id] = p.answerBaselineSignature ?? null;
    run.answerBaselineCounts[p.id] = Number.isFinite(p.answerBaselineCount)
      ? p.answerBaselineCount
      : null;
  }
  run.preparedIds = [...ready];
  run.waitIds = [...ready];
  run.comparisonIds = ready.filter(
    (id) => id !== judgeId || judgeIncludedInComparison
  );
  if (!autoSend) {
    $('#status').textContent = `${ready.length}/${askTargets.length} 已填入（未自动发送，请在各栏手动发）`;
    state.busy = false;
    $('#go').disabled = false;
    return;
  }

  // prepare 可能持续数秒；在真正 fire 前重取一次基线，避免把期间仍在增长的旧回答
  // 当成本轮的新回答。
  const baselineResults = await Promise.all(
    ready.map((id) => send(id, { type: 'peek' }, 3000).then((r) => ({ id, ...r })))
  );
  for (const baseline of baselineResults) {
    if (!baseline.ok) continue;
    run.answerBaselines[baseline.id] = baseline.signature || `length:${baseline.length || 0}`;
    run.answerBaselineCounts[baseline.id] = Number.isFinite(baseline.answerCount)
      ? baseline.answerCount
      : null;
  }

  const fired = await Promise.all(
    ready.map((id) => send(id, { type: 'fire' }, 15000).then((r) => ({ id, ...r })))
  );

  for (const f of fired) setMeta(f.id, f.ok ? '已发送' : `发送失败: ${f.error}`);
  const sentIds = fired.filter((f) => f.ok).map((f) => f.id);
  run.firedIds = [...sentIds];
  run.waitIds = [...sentIds];
  run.comparisonIds = sentIds.filter(
    (id) => id !== judgeId || judgeIncludedInComparison
  );
  const good = sentIds.length;
  const failed = prepared.filter((p) => !p.ok).length;
  $('#status').textContent =
    `${good}/${askTargets.length} 已发送` + (failed ? `，${failed} 个填入失败` : '') + judgeSuffix;

  // 发送成功后清空输入框和附件，并重新聚焦（fillInput 会让 iframe 获得焦点）
  if (good > 0) {
    const q = $('#q');
    q.value = '';
    clearAttachments();
    q.focus();

    // 如果开启了裁判与自动派发，启动后台监控并在作答完毕后自动派发给裁判
    const hasNonJudgeAnswer = run.comparisonIds.some((id) => id !== judgeId);
    if (judgeId && state.judgeId === judgeId && state.autoJudge && hasNonJudgeAnswer) {
      monitorAndSynthesize(run);
    } else if (judgeId && !hasNonJudgeAnswer && judgeAnswersQuestion) {
      setMeta(judgeId, '👑 已参与回答（无其他回答可比对）');
    }
  }

  state.busy = false;
  $('#go').disabled = false;
}

// --------------------------------------------------------------------- 裁判派发与监控
async function dispatchToJudge(judgeId, prompt, run = null) {
  if (!judgeId || !prompt) return { ok: false, error: '缺少裁判或对比提示词' };
  const judgeCol = document.getElementById(`col-${judgeId}`);
  if (judgeCol && state.collapsed.has(judgeId)) {
    toggleCollapse(judgeId);
  }
  const judgeAdapter = A.byId(judgeId);
  const judgeName = judgeAdapter ? judgeAdapter.name : judgeId;

  if (!state.frames.has(judgeId)) {
    setMeta(judgeId, '👑 裁判 frame 未就绪');
    $('#status').textContent = `裁判 [${judgeName}] 尚未就绪，无法派发`;
    return { ok: false, error: '裁判 frame 未就绪' };
  }

  if (state.lockedSites.has(judgeId)) {
    setMeta(judgeId, '👑 裁判正在处理上一轮任务');
    return { ok: false, error: '裁判正在处理上一轮任务' };
  }
  state.lockedSites.add(judgeId);
  const releaseJudgeLock = () => state.lockedSites.delete(judgeId);

  // 裁判若参加了首轮，第二轮刚提交时 latestAnswer 仍可能是首轮旧回答。
  // 记录基线长度，只有检测到新回答后才开始计算“稳定完成”。
  const baseline = await send(judgeId, { type: 'peek' }, 4000);
  const baselineLength = baseline.ok ? (baseline.length || 0) : 0;
  const baselineSignature = baseline.ok
    ? (baseline.signature || `length:${baselineLength}`)
    : '';

  setMeta(judgeId, '👑 注入对比提示词…');
  $('#status').textContent = `正在将对比分析任务派发给裁判 [${judgeName}]…`;

  // 两阶段提交对比提示词到裁判窗口
  const prep = await send(judgeId, {
    type: 'prepare',
    text: prompt,
    files: [],
    armMs: 2500,
    uploadMs: 0,
    verifyMs: 0,
  }, 30000);

  if (!prep.ok) {
    releaseJudgeLock();
    setMeta(judgeId, `👑 派发失败: ${prep.error}`);
    $('#status').textContent = `派发给裁判 [${judgeName}] 失败: ${prep.error}`;
    return { ok: false, error: prep.error };
  }

  setMeta(judgeId, '👑 触发裁判作答…');
  const fired = await send(judgeId, { type: 'fire' }, 15000);
  if (!fired.ok) {
    releaseJudgeLock();
    setMeta(judgeId, `👑 提交失败: ${fired.error}`);
    $('#status').textContent = `裁判 [${judgeName}] 提交失败: ${fired.error}`;
    return { ok: false, error: fired.error };
  }

  setMeta(judgeId, '👑 裁判生成对比中…');
  judgeCol?.classList.add('judge-analyzing');
  $('#status').textContent = `👑 裁判 [${judgeName}] 正在分析各家作答并进行终极裁决…`;

  // 轮询裁判生成进度
  let lastLen = 0;
  let stableCount = 0;
  let responseStarted = false;
  const pollStart = Date.now();
  const maxPoll = 180000;
  let judgePollInFlight = false;
  let judgeFinished = false;
  const ownsCurrentUi = () => !run ||
    (state.currentRun === run && state.judgeId === judgeId);

  const judgeTicker = setInterval(async () => {
    if (judgePollInFlight || judgeFinished) return;
    judgePollInFlight = true;
    try {
      if (Date.now() - pollStart > maxPoll) {
        judgeFinished = true;
        clearInterval(judgeTicker);
        releaseJudgeLock();
        judgeCol?.classList.remove('judge-analyzing');
        if (ownsCurrentUi()) {
          setMeta(judgeId, '👑 裁判对比完成 (已达最大等待)');
          judgeCol?.classList.add('judge-finished');
        }
        return;
      }
      const r = await send(judgeId, { type: 'peek' }, 4000);
      if (r.ok) {
        const curLen = r.length || 0;
        const curSignature = r.signature || `length:${curLen}`;
        if (!responseStarted) {
          if (curSignature === baselineSignature) {
            if (ownsCurrentUi()) setMeta(judgeId, '👑 已提交，等待裁判开始新回答…');
            return;
          }
          responseStarted = true;
          lastLen = curLen;
          stableCount = 0;
          if (ownsCurrentUi()) setMeta(judgeId, `👑 裁判分析中 (${curLen} 字)`);
          return;
        }
        if (ownsCurrentUi()) setMeta(judgeId, `👑 裁判分析中 (${curLen} 字)`);
        if (curLen > 60 && curLen === lastLen) {
          stableCount++;
          if (stableCount >= 2) {
            judgeFinished = true;
            clearInterval(judgeTicker);
            releaseJudgeLock();
            judgeCol?.classList.remove('judge-analyzing');
            if (ownsCurrentUi()) {
              setMeta(judgeId, `👑 对比完成 (${curLen} 字) ✓`);
              judgeCol?.classList.add('judge-finished');
              $('#status').innerHTML = `👑 裁判 [<b>${judgeName}</b>] 最终裁决已出炉！<a href="#" id="linkFocusJudge" style="color:#d97706;font-weight:700;margin-left:8px;text-decoration:underline;cursor:pointer">点击直达查看</a>`;
              document.getElementById('linkFocusJudge')?.addEventListener('click', (e) => {
                e.preventDefault();
                focusJudgeColumn(judgeId);
              });
            }
          }
        } else {
          lastLen = curLen;
          stableCount = 0;
        }
      }
    } finally {
      judgePollInFlight = false;
    }
  }, 2500);

  return { ok: true };
}

function dispatchRunToJudge(run, prompt) {
  if (!run) return dispatchToJudge(state.judgePromptJudgeId || state.judgeId, prompt);
  if (run.comparisonDispatched) {
    return Promise.resolve({ ok: true, alreadyDispatched: true });
  }
  if (run.dispatchPromise) return run.dispatchPromise;

  run.dispatchInFlight = true;
  updateDlgJudgeButton();
  const attempt = dispatchToJudge(run.judgeId, prompt, run)
    .then((result) => {
      run.dispatchInFlight = false;
      if (result?.ok) {
        run.comparisonDispatched = true;
      } else {
        run.dispatchPromise = null;
      }
      updateDlgJudgeButton();
      return result;
    })
    .catch((error) => {
      state.lockedSites.delete(run.judgeId);
      run.dispatchInFlight = false;
      run.dispatchPromise = null;
      $('#status').textContent = `裁判派发异常: ${error?.message || error}`;
      updateDlgJudgeButton();
      return { ok: false, error: error?.message || String(error) };
    });
  run.dispatchPromise = attempt;
  return attempt;
}

function isDuelRun(run) {
  if (!run?.judgeId || run.judgeAnswersQuestion) return false;
  const plannedIds = run.plannedComparisonIds || run.comparisonIds;
  return plannedIds.filter((id) => id !== run.judgeId).length === 1;
}

function cacheRunAnswers(run, results) {
  if (!run.answers) run.answers = {};
  for (const result of results) {
    if (!result.ok || !result.text) continue;
    const adapter = A.byId(result.id);
    run.answers[result.id] = {
      id: result.id,
      name: result.name || adapter?.name || result.id,
      text: result.text,
      signature: result.signature || null,
      isJudge: result.id === run.judgeId,
    };
  }
}

function comparisonEntries(run) {
  return run.comparisonIds
    .map((id) => run.answers?.[id])
    .filter(Boolean);
}

async function monitorAndSynthesize(run) {
  const { waitIds, judgeId, question } = run;
  if (state.currentRun !== run || state.judgeId !== judgeId || !state.autoJudge) return;
  const token = ++activeSynthesisToken;

  if (isDuelRun(run)) {
    setMeta(judgeId, `👑 裁判就位 (单挑模式: 等待作答后亲自解答并裁决…)`);
  } else if (run.judgeAnswersQuestion) {
    setMeta(judgeId, `👑 首轮回答中 (等待 ${waitIds.length} 家完成…)`);
  } else {
    setMeta(judgeId, `👑 裁判就位 (等待 ${waitIds.length} 家模型作答…)`);
  }

  const pollInterval = 1200; // 轮询周期缩短至 1.2 秒，大幅提升感知敏捷度
  const maxWaitMs = 150000;
  const startTime = Date.now();
  const lastSignatures = new Map();
  const stableRounds = new Map();
  const answerStarted = new Map();
  const inFlightCollects = new Set(); // 正在渐进式预提取回答的模型 ID
  let pollInFlight = false;

  // 延迟 1.8 秒后再开始检查，给各模型初次响应留出必要时间
  await new Promise((resolve) => setTimeout(resolve, 1800));
  if (token !== activeSynthesisToken || state.currentRun !== run) return;

  const timer = setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      if (token !== activeSynthesisToken || state.currentRun !== run) {
        clearInterval(timer);
        return;
      }

      if (Date.now() - startTime > maxWaitMs) {
        clearInterval(timer);
        if (token === activeSynthesisToken) {
          triggerAutoSynthesis(run, token);
        }
        return;
      }

      let allStable = true;
      let anyAnswered = false;
      let answeredCount = 0;

      for (const id of waitIds) {
        const r = await send(id, { type: 'peek' }, 2500);
        if (r.ok) {
          const len = r.length || 0;
          const signature = r.signature || `length:${len}`;
          const baseline = run.answerBaselines?.[id];
          const baselineCount = run.answerBaselineCounts?.[id];
          const hasNewNode = Number.isFinite(baselineCount) &&
            Number.isFinite(r.answerCount) && r.answerCount > baselineCount;
          let started = answerStarted.get(id);
          if (started === undefined) {
            started = baseline == null || hasNewNode || signature !== baseline;
            answerStarted.set(id, started);
          } else if (!started && (hasNewNode || signature !== baseline)) {
            started = true;
            answerStarted.set(id, true);
          }

          if (!started) {
            allStable = false;
            continue;
          }
          if (len > 0) {
            anyAnswered = true;
            answeredCount++;
          }
          const prev = lastSignatures.get(id);
          if (len > 0 && signature === prev) {
            const rounds = (stableRounds.get(id) || 0) + 1;
            stableRounds.set(id, rounds);
            if (rounds < 2) {
              allStable = false;
            } else {
              // 关键优化：先答完的模型先提取（渐进式提前提取）
              // 某个模型连续 2 轮无变化即判定回答完成，无需等待其他模型一起答完
              if (!run.answers?.[id] && !inFlightCollects.has(id)) {
                inFlightCollects.add(id);
                send(id, { type: 'collect', immediate: true }, 8000).then((collectRes) => {
                  inFlightCollects.delete(id);
                  if (collectRes?.ok && collectRes?.text && state.currentRun === run) {
                    cacheRunAnswers(run, [{
                      id,
                      text: collectRes.text,
                      name: collectRes.name,
                      signature,
                      ok: true,
                    }]);
                    setMeta(id, `${collectRes.text.length} 字 ✓`);
                    updateProgressMeta();
                  }
                }).catch(() => inFlightCollects.delete(id));
              }
            }
          } else {
            // 文本仍在持续增长（或网络短暂波动后继续输出）
            lastSignatures.set(id, signature);
            stableRounds.set(id, 0);
            allStable = false;
            // 若内容继续增长，清除旧缓存以保证最终回答完整
            if (run.answers?.[id] && run.answers[id].signature !== signature) {
              delete run.answers[id];
            }
          }
        } else {
          // frame 无响应或异常，不卡死流程
          stableRounds.set(id, 99);
        }
      }

      function updateProgressMeta() {
        const collectedCount = waitIds.filter((id) => Boolean(run.answers?.[id])).length;
        const prefix = run.judgeAnswersQuestion ? '👑 首轮回答中' : '👑 裁判就位';
        if (collectedCount > 0 && collectedCount === waitIds.length) {
          setMeta(judgeId, `${prefix} (全员已收集，准备裁决…)`);
        } else if (collectedCount > 0) {
          setMeta(judgeId, `${prefix} (已提取: ${collectedCount}/${waitIds.length} 家)`);
        } else if (answeredCount > 0) {
          setMeta(judgeId, `${prefix} (已作答: ${answeredCount}/${waitIds.length} 家)`);
        }
      }

      updateProgressMeta();

      // 检查所有参与模型是否均已稳定且在途预提取均已就绪
      const allRoundsComplete = waitIds.every((id) => {
        const rounds = stableRounds.get(id) || 0;
        return rounds >= 2 || rounds === 99;
      });

      if (anyAnswered && allStable && allRoundsComplete && inFlightCollects.size === 0) {
        clearInterval(timer);
        if (token === activeSynthesisToken) {
          triggerAutoSynthesis(run, token);
        }
      }
    } finally {
      pollInFlight = false;
    }
  }, pollInterval);
}

async function triggerAutoSynthesis(run, token) {
  if ((token && token !== activeSynthesisToken) || state.currentRun !== run ||
      state.judgeId !== run.judgeId || !state.autoJudge) return;
  const { waitIds, judgeId, question } = run;
  const judgeAdapter = A.byId(judgeId);
  const judgeName = judgeAdapter ? judgeAdapter.name : judgeId;

  // 检查是否有尚未完成提取的模型（如最后刚答完的模型）
  const missingIds = waitIds.filter((id) => !run.answers?.[id]);
  if (missingIds.length > 0) {
    setMeta(judgeId, '👑 秒级提取剩余作答…');
    const results = await Promise.all(
      missingIds.map((id) =>
        send(id, {
          type: 'collect',
          immediate: true, // 关键：immediate 模式直读当前文本，跳过所有多余的 2 秒睡眠轮询！
          maxWait: 8000,
          ...(typeof run.answerBaselines?.[id] === 'string'
            ? {
                baselineSignature: run.answerBaselines[id],
                baselineAnswerCount: run.answerBaselineCounts?.[id],
              }
            : {}),
        }, 12000).then((r) => ({ id, ...r }))
      )
    );

    if ((token && token !== activeSynthesisToken) || state.currentRun !== run ||
        state.judgeId !== run.judgeId || !state.autoJudge) return;

    cacheRunAnswers(run, results);
    for (const r of results) {
      if (r.ok && r.text) setMeta(r.id, `${r.text.length} 字 ✓`);
    }
  }

  const entries = comparisonEntries(run);

  if (run.judgeIncludedInComparison && !run.answers?.[judgeId]) {
    setMeta(judgeId, '👑 未抓到裁判首轮回答，已停止自动评测');
    $('#status').textContent = '裁判已设置参与比对，但未抓到它的首轮回答；本轮未自动派发裁决';
    return;
  }

  if (!entries.some((entry) => entry.id !== judgeId)) {
    setMeta(judgeId, '👑 未抓到有效回答');
    return;
  }

  const duel = isDuelRun(run);
  const prompt = A.buildComparePrompt(question, entries, { mode: duel ? 'duel' : 'review' });
  state.judgePrompt = prompt;
  state.judgePromptJudgeId = judgeId;
  updateDlgJudgeButton();

  // 更新对话框内容预备
  renderCompareDialog(question, entries, prompt, judgeId, { duel });

  await dispatchRunToJudge(run, prompt);
}

// --------------------------------------------------------------------- 收集对比
async function collect() {
  if (state.busy) return;

  let run = state.currentRun;
  if (!run) {
    const judgeId = state.judgeId && state.enabled.has(state.judgeId) ? state.judgeId : null;
    const judgeAnswersQuestion = Boolean(judgeId && state.judgeAnswersQuestion);
    const judgeIncludedInComparison = Boolean(
      judgeAnswersQuestion && state.judgeIncludedInComparison
    );
    const waitIds = state.order.filter(
      (id) => state.enabled.has(id) && state.frames.has(id) &&
        (id !== judgeId || judgeAnswersQuestion)
    );
    run = {
      question: lastQuestion,
      judgeId,
      judgeAnswersQuestion,
      judgeIncludedInComparison,
      askedIds: [...waitIds],
      preparedIds: [],
      firedIds: [],
      waitIds,
      plannedComparisonIds: waitIds.filter(
        (id) => id !== judgeId || judgeIncludedInComparison
      ),
      comparisonIds: waitIds.filter(
        (id) => id !== judgeId || judgeIncludedInComparison
      ),
      answerBaselines: {},
      answerBaselineCounts: {},
      answers: {},
      comparisonDispatched: false,
      dispatchInFlight: false,
      dispatchPromise: null,
    };
    state.currentRun = run;
  }

  if (!run.waitIds.length) {
    $('#status').textContent = '本轮没有成功填入或发送的模型，无法收集回答';
    return;
  }

  const { judgeId } = run;
  const waitIds = run.waitIds.filter((id) => state.frames.has(id));
  if (!waitIds.length) {
    $('#status').textContent = '没有本轮已就绪的模型可收集';
    return;
  }

  // 停止后台自动监控，用户主动触发了收集
  activeSynthesisToken++;

  state.busy = true;
  $('#collect').disabled = true;
  $('#status').textContent = '等待各模型生成完毕…';

  // 已派发裁决后绝不重新抓裁判，避免把最终报告误当成首轮回答。
  const pendingIds = waitIds.filter(
    (id) => !run.answers?.[id] && !(run.comparisonDispatched && id === judgeId)
  );

  // 轮询各栏字数，让用户看到进度而不是干等。
  const ticker = pendingIds.length ? setInterval(async () => {
    for (const id of pendingIds) {
      const r = await send(id, { type: 'peek' }, 4000);
      if (r.ok) setMeta(id, `${r.length} 字`);
    }
  }, 1500) : null;

  const results = await Promise.all(
    pendingIds.map((id) =>
      send(id, {
        type: 'collect',
        maxWait: A.MAX_WAIT_MS,
        ...(typeof run.answerBaselines?.[id] === 'string'
          ? {
              baselineSignature: run.answerBaselines[id],
              baselineAnswerCount: run.answerBaselineCounts?.[id],
            }
          : {}),
      }, A.MAX_WAIT_MS + 10000)
        .then((r) => ({ id, ...r })))
  );
  if (ticker) clearInterval(ticker);

  cacheRunAnswers(run, results);
  const entries = comparisonEntries(run);
  for (const r of results) setMeta(r.id, r.ok && r.text ? `${r.text.length} 字 ✓` : '未抓到');

  if (run.judgeIncludedInComparison && !run.answers?.[judgeId]) {
    $('#status').textContent = '裁判已设置参与比对，但未抓到它的首轮回答；请确认回答完成后重试';
  } else if (!entries.length) {
    $('#status').textContent = '没抓到任何回答';
  } else {
    const duel = isDuelRun(run);
    const prompt = A.buildComparePrompt(
      run.question || lastQuestion,
      entries,
      { mode: duel ? 'duel' : 'review' }
    );
    state.judgePrompt = prompt;
    state.judgePromptJudgeId = judgeId;
    renderCompareDialog(run.question || lastQuestion, entries, prompt, judgeId, { duel });
    $('#dlg').showModal();
    $('#status').textContent = duel
      ? `已收集 ${entries[0].name} 的回答，已生成 1v1 切磋提示词`
      : entries.length === 1
        ? '只抓到 1 份回答，已按单份评审模式生成提示词'
      : `已收集 ${entries.length} 份回答`;

    // 如果开启了自动评测，且裁判就绪，立即派发给裁判
    if (judgeId && state.autoJudge && state.judgeId === judgeId &&
        state.frames.has(judgeId) && !run.comparisonDispatched && !run.dispatchInFlight &&
        entries.some((entry) => entry.id !== judgeId)) {
      dispatchRunToJudge(run, prompt);
    }
  }

  state.busy = false;
  $('#collect').disabled = false;
}

// --------------------------------------------------------------------- 绑定
function insertNewline(ta) {
  // 优先 execCommand：它保留撤销历史，手动改 value 会把 Ctrl+Z 记录冲掉。
  if (!document.execCommand('insertText', false, '\n')) {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    ta.value = value.slice(0, s) + '\n' + value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + 1;
  }
  ta.scrollTop = ta.scrollHeight;
}

$('#go').onclick = ask;
$('#collect').onclick = collect;

// ---- 附件入口：按钮选择、粘贴截图、拖拽 ----
$('#pickFile').onclick = () => $('#fileInput').click();
$('#pickImage').onclick = () => $('#imageInput').click();

for (const id of ['#fileInput', '#imageInput']) {
  $(id).addEventListener('change', async (e) => {
    await addFiles(e.target.files);
    e.target.value = ''; // 清空才能重复选同一个文件
  });
}

// 粘贴截图是最常用的路径（Win+Shift+S 后直接 Ctrl+V）
$('#q').addEventListener('paste', async (e) => {
  const items = [...(e.clipboardData?.items ?? [])];
  const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return; // 纯文本粘贴走默认行为
  e.preventDefault();
  await addFiles(files);
});

// 拖拽到底部输入区
const dropZone = $('.input-wrapper');
for (const t of ['dragover', 'dragenter']) {
  dropZone.addEventListener(t, (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const t of ['dragleave', 'drop']) {
  dropZone.addEventListener(t, () => dropZone.classList.remove('dragging'));
}
dropZone.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  await addFiles(e.dataTransfer.files);
});

$('#q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;

  /*
   * 中文输入法选字时也会发出 Enter。此时 isComposing 为 true（部分环境只给
   * keyCode 229），必须放过，否则打一句中文中途就被发出去了。
   */
  if (e.isComposing || e.keyCode === 229) return;

  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    insertNewline(e.target);
    return;
  }
  if (e.shiftKey || e.altKey) return; // Shift+Enter 保留浏览器默认换行
  e.preventDefault();
  ask();
});
$('#dlgClose').onclick = () => $('#dlg').close();
$('#dlgCopy').onclick = async () => {
  await navigator.clipboard.writeText($('#dlgText').textContent);
  $('#dlgCopy').textContent = '已复制';
  setTimeout(() => ($('#dlgCopy').textContent = '复制对比提示词'), 1500);
};

// 弹窗 Tab 切换监听
const dlgTabs = document.querySelectorAll('.dlg-tab');
dlgTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    dlgTabs.forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.dlg-tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    const targetId = tab.getAttribute('data-tab');
    if (targetId) {
      document.getElementById(targetId)?.classList.add('active');
    }
  });
});

// --------------------------------------------------------------------- 底部输入框高度调整
function getFooterMaxHeight() {
  const q = $('#q');
  const footer = $('#inputArea');
  const layoutBar = $('.layout-bar');
  if (!q) return 500;
  const fixedFooterHeight = footer
    ? footer.getBoundingClientRect().height - q.getBoundingClientRect().height
    : 0;
  const available = window.innerHeight - (layoutBar?.getBoundingClientRect().height || 0)
    - fixedFooterHeight - 160;
  return Math.max(38, Math.min(500, Math.round(window.innerHeight * 0.6), Math.round(available)));
}

function syncFooterResizerAria() {
  const q = $('#q');
  const resizer = $('#footerResizer');
  if (!q || !resizer) return;
  resizer.setAttribute('aria-valuemin', '38');
  resizer.setAttribute('aria-valuemax', String(getFooterMaxHeight()));
  resizer.setAttribute('aria-valuenow', String(Math.round(q.getBoundingClientRect().height)));
}

function applyInputHeight(h, save = true) {
  const q = $('#q');
  const btn = $('#expandInputBtn');
  if (!q) return;

  if (h && h >= 38) {
    const nextHeight = Math.max(38, Math.min(getFooterMaxHeight(), Math.round(h)));
    q.style.height = `${nextHeight}px`;
    state.inputHeight = nextHeight;
    if (btn) {
      const isExpanded = nextHeight >= 130;
      const iconExpand = btn.querySelector('.icon-expand');
      const iconCollapse = btn.querySelector('.icon-collapse');
      const span = btn.querySelector('span');
      if (iconExpand) iconExpand.style.display = isExpanded ? 'none' : '';
      if (iconCollapse) iconCollapse.style.display = isExpanded ? '' : 'none';
      if (span) span.textContent = isExpanded ? '收起' : '展开';
    }
    if (save) chrome.storage.local.set({ [STORE_INPUT_HEIGHT_KEY]: nextHeight });
  } else {
    q.style.height = '';
    state.inputHeight = null;
    if (btn) {
      const iconExpand = btn.querySelector('.icon-expand');
      const iconCollapse = btn.querySelector('.icon-collapse');
      const span = btn.querySelector('span');
      if (iconExpand) iconExpand.style.display = '';
      if (iconCollapse) iconCollapse.style.display = 'none';
      if (span) span.textContent = '展开';
    }
    if (save) chrome.storage.local.remove(STORE_INPUT_HEIGHT_KEY);
  }
  syncFooterResizerAria();
}

function initFooterResize() {
  const resizer = $('#footerResizer');
  const q = $('#q');
  const expandBtn = $('#expandInputBtn');
  if (!resizer || !q) return;

  resizer.addEventListener('pointerdown', (e) => {
    const startY = e.clientY;
    const startHeight = q.getBoundingClientRect().height;

    startPointerDrag(e, {
      bodyClass: 'is-resizing-footer',
      activeElement: resizer,
      onMove: (ev) => {
        const deltaY = startY - ev.clientY; // 向上拖拽为增大高度
        const newH = Math.max(38, Math.min(getFooterMaxHeight(), Math.round(startHeight + deltaY)));
        applyInputHeight(newH, false);
      },
      onEnd: () => applyInputHeight(Math.round(q.getBoundingClientRect().height), true),
    });
  });

  // 双击顶部手柄快速恢复默认高度
  resizer.addEventListener('dblclick', () => {
    applyInputHeight(null, true);
  });

  resizer.addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Home') {
      applyInputHeight(null, true);
      return;
    }
    const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 40 : 16);
    const newH = Math.max(38, Math.min(getFooterMaxHeight(), Math.round(q.getBoundingClientRect().height + delta)));
    applyInputHeight(newH, true);
  });

  window.addEventListener('resize', syncFooterResizerAria);
  syncFooterResizerAria();

  // 展开/收起快捷按钮
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const currentH = q.getBoundingClientRect().height;
      if (currentH < 130) {
        applyInputHeight(220, true);
      } else {
        applyInputHeight(null, true);
      }
    });
  }

  // 监听 textarea 原生缩放并自动记录持久化
  if (window.ResizeObserver) {
    let roTimer = null;
    const ro = new ResizeObserver((entries) => {
      if (document.body.classList.contains('is-resizing-footer')) return;
      for (const entry of entries) {
        const h = Math.round(entry.contentRect.height);
        if (h > 0) {
          clearTimeout(roTimer);
          roTimer = setTimeout(() => {
            applyInputHeight(h, true);
          }, 300);
        }
      }
    });
    ro.observe(q);
  }
}

(async () => {
  const saved = await chrome.storage.local.get([
    STORE_KEY,
    STORE_ORDER_KEY,
    STORE_LAYOUT_KEY,
    STORE_JUDGE_KEY,
    STORE_AUTO_JUDGE_KEY,
    STORE_JUDGE_ASK_KEY,
    STORE_JUDGE_COMPARE_KEY,
    STORE_SIDEBAR_COLLAPSED_KEY,
    STORE_INPUT_HEIGHT_KEY,
    STORE_COL_RATIOS_KEY,
  ]);
  const ids = saved[STORE_KEY];
  state.enabled = new Set(
    Array.isArray(ids) && ids.length ? ids : ['chatgpt', 'deepseek']
  );

  const savedRatios = saved[STORE_COL_RATIOS_KEY];
  if (savedRatios && typeof savedRatios === 'object') {
    state.colRatios = { ...savedRatios };
  }

  const savedOrder = saved[STORE_ORDER_KEY];
  const allIds = A.ADAPTERS.map((a) => a.id);
  if (Array.isArray(savedOrder) && savedOrder.length) {
    state.order = [
      ...savedOrder.filter((id) => allIds.includes(id)),
      ...allIds.filter((id) => !savedOrder.includes(id)),
    ];
  } else {
    state.order = [...allIds];
  }

  // 恢复裁判模型与自动派发设置
  const savedJudge = saved[STORE_JUDGE_KEY];
  if (savedJudge && state.enabled.has(savedJudge)) {
    state.judgeId = savedJudge;
  } else {
    state.judgeId = null;
  }
  if (saved[STORE_AUTO_JUDGE_KEY] !== undefined) {
    state.autoJudge = Boolean(saved[STORE_AUTO_JUDGE_KEY]);
  } else {
    state.autoJudge = true;
  }
  state.judgeAnswersQuestion = Boolean(saved[STORE_JUDGE_ASK_KEY]);
  state.judgeIncludedInComparison = Boolean(
    state.judgeAnswersQuestion && saved[STORE_JUDGE_COMPARE_KEY]
  );

  // 绑定底部裁判选择器与自动派发勾选框
  const judgeSel = $('#judgeSelect');
  if (judgeSel) {
    judgeSel.addEventListener('change', (e) => {
      setJudge(e.target.value || null);
    });
  }

  const autoJudgeChk = $('#autoJudge');
  if (autoJudgeChk) {
    autoJudgeChk.checked = state.autoJudge;
    autoJudgeChk.addEventListener('change', (e) => {
      state.autoJudge = e.target.checked;
      if (!state.autoJudge) activeSynthesisToken++;
      chrome.storage.local.set({ [STORE_AUTO_JUDGE_KEY]: state.autoJudge });
    });
  }

  // 绑定布局切换按钮
  $('#btnModeGrid')?.addEventListener('click', () => setLayoutMode('grid'));
  $('#btnModeScroll')?.addEventListener('click', () => setLayoutMode('scroll'));
  $('#btnModeCol2')?.addEventListener('click', () => setLayoutMode('col-2'));
  $('#btnModeCol3')?.addEventListener('click', () => setLayoutMode('col-3'));

  // 横向画廊滚动导航
  $('#scrollLeft')?.addEventListener('click', () => {
    $('#cols')?.scrollBy({ left: -460, behavior: 'smooth' });
  });
  $('#scrollRight')?.addEventListener('click', () => {
    $('#cols')?.scrollBy({ left: 460, behavior: 'smooth' });
  });

  // 在横向画廊模式下，鼠标滚轮竖向滚动自动映射为横向滚动
  $('#cols')?.addEventListener('wheel', (e) => {
    if (state.layout === 'scroll' && e.deltaY && !e.shiftKey) {
      e.preventDefault();
      $('#cols').scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // 侧边栏折叠与展开
  $('#btnToggleSidebar')?.addEventListener('click', () => toggleSidebar());
  $('#btnCollapseSidebar')?.addEventListener('click', () => toggleSidebar(true));

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      if (e.isComposing) return;
      e.preventDefault();
      toggleSidebar();
    }
  });

  // 侧边栏批量选择与常用预设
  $('#btnSelectAll')?.addEventListener('click', selectAllModels);
  $('#btnClearAll')?.addEventListener('click', clearAllModels);
  $('#presetDomestic')?.addEventListener('click', () => applyPreset(PRESET_DOMESTIC));
  $('#presetGlobal')?.addEventListener('click', () => applyPreset(PRESET_GLOBAL));

  buildHeader();
  buildCols();
  applyOrder();
  setJudge(state.judgeId);
  populateJudgeSelect();

  if (saved[STORE_SIDEBAR_COLLAPSED_KEY]) {
    toggleSidebar(true);
  }

  const savedLayout = saved[STORE_LAYOUT_KEY] || 'grid';
  setLayoutMode(savedLayout);
  updateCount();

  const savedHeight = saved[STORE_INPUT_HEIGHT_KEY];
  if (savedHeight && savedHeight >= 38) {
    applyInputHeight(savedHeight, false);
  }
  initFooterResize();

  await chrome.runtime.sendMessage({ type: 'ensure-framing' }).catch(() => {});
})();
