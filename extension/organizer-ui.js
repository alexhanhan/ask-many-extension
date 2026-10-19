export function createOrganizerUI({ el, button, icon, request, toast, dialog, onChanged, getLibrary }) {
  let root = null, data = null, loading = false, runner = false, generation = 0, action = null;
  let selected = new Set(), pageSize = 50, filter = 'all', query = '';
  let draft = { scopeId: '', engine: null, allowNew: false, rootId: '' };
  const eligible = row => ['suggested', 'failed'].includes(row.status) && (row.folderId || row.category);
  const statusText = { pending: '待分析', suggested: '待应用', unchanged: '无需移动', applied: '已应用', ignored: '已忽略', failed: '需检查' };
  function accept(next) {
    const oldId = data?.job?.id;
    data = next;
    if (next.job?.id !== oldId) {
      selected = new Set(next.job?.items.filter(eligible).map(b => b.id) || []);
      if (next.job) draft = { ...draft, ...next.job.options, scopeId: next.job.options.scopeId || '', rootId: next.job.options.rootId || draft.rootId };
    }
    else {
      for (const row of next.job?.items || []) {
        const old = root?._lastRows?.get(row.id);
        if (eligible(row) && old === 'pending') selected.add(row.id);
        if (!eligible(row)) selected.delete(row.id);
      }
    }
    draw();
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try { accept(await request('organizerGet')); } catch (error) { toast(error.message, true); }
    finally { loading = false; }
  }
  async function analyze() {
    if (runner || action) return;
    runner = true; const run = ++generation; draw();
    try {
      while (runner && run === generation && data?.job && data.job.cursor < data.job.items.length) {
        const next = await request('organizerStep', { jobId: data.job.id });
        if (run !== generation) break;
        accept(next);
      }
      if (run === generation && data?.job?.status === 'ready') toast('分析完成，请预览建议后再应用');
    } catch (error) { toast(error.message, true); }
    finally { if (run === generation) { runner = false; draw(); } }
  }
  async function pause() {
    runner = false; generation++;
    try { accept(await request('organizerPause', { jobId: data.job.id })); } catch (error) { toast(error.message, true); }
    draw();
  }
  async function start() {
    if (runner || action) return;
    const library = getLibrary();
    if (!draft.rootId) draft.rootId = library.folders.find(f => !f.managed)?.id || '';
    try {
      accept(await request('organizerStart', { ...draft, engine: draft.engine || (library.settings.apiReady ? 'ai' : 'local') }));
      await analyze();
    } catch (error) { toast(error.message, true); }
  }
  async function apply(ids) {
    if (runner || action || !ids.length) return;
    const jobId = data.job.id, run = ++generation;
    action = { type: 'apply', total: ids.length, done: 0, failed: 0, stop: false }; draw();
    try {
      for (const id of ids) {
        if (run !== generation || action.stop) break;
        const next = await request('organizerApply', { jobId, id });
        action.done++; if (next.job.items.find(b => b.id === id)?.status === 'failed') action.failed++;
        accept(next);
      }
      toast(`已处理 ${action.done} 项${action.failed ? `，${action.failed} 项需检查` : ''}`);
      await onChanged();
    } catch (error) { toast(error.message, true); }
    finally { action = null; draw(); }
  }
  async function undo() {
    const entries = data.history.filter(e => e.status === 'applied').slice().reverse();
    if (runner || action || !entries.length) return;
    const run = ++generation;
    action = { type: 'undo', total: entries.length, done: 0, failed: 0, stop: false }; draw();
    try {
      for (const entry of entries) {
        if (run !== generation || action.stop) break;
        const next = await request('organizerUndo', { id: entry.id });
        action.done++; if (next.history.find(e => e.id === entry.id)?.status !== 'undone') action.failed++;
        accept(next);
      }
      toast(`已处理 ${action.done} 条撤销记录${action.failed ? `，${action.failed} 条因位置变化等原因跳过` : ''}`);
      await onChanged();
    } catch (error) { toast(error.message, true); }
    finally { action = null; draw(); }
  }
  function confirmApply(ids) {
    const rows = data.job.items.filter(b => ids.includes(b.id) && eligible(b));
    if (!rows.length) return;
    const { modal, content } = dialog(`应用 ${rows.length} 条整理建议？`, '将移动已有书签，保留原来的标题和网址。移动前会保存原目录和位置，支持撤销。');
    const groups = new Map();
    for (const row of rows) groups.set(row.targetPath, (groups.get(row.targetPath) || 0) + 1);
    content.append(el('div', { class: 'organize-confirm' }, ...[...groups].map(([path, count]) => el('div', {}, el('span', {}, path), el('strong', {}, `${count} 个`)))));
    if (rows.some(b => b.category)) content.append(el('p', { class: 'notice' }, '选中的新分类会在指定保存目录下按层级创建；同名目录会复用。'));
    content.append(button(`确认应用 ${rows.length} 项`, 'check', () => { modal.close(); apply(rows.map(b => b.id)); }, 'button primary'));
  }
  function edit(row) {
    const library = getLibrary(), folders = library.folders.filter(f => !f.managed);
    const { modal, content } = dialog('调整这条分类建议', row.title);
    let newMode = !!row.category;
    const mode = el('select', { class: 'text-input', 'aria-label': '目标类型', onChange: event => { newMode = event.target.value === 'new'; fields(); } }, el('option', { value: 'existing' }, '使用已有目录'), data.job.options.allowNew ? el('option', { value: 'new' }, '新建分类路径') : null);
    mode.value = newMode ? 'new' : 'existing';
    const folder = el('select', { class: 'text-input', 'aria-label': '整理目标目录' }, ...folders.map(f => el('option', { value: f.id }, f.path)));
    folder.value = row.folderId || folders[0]?.id || '';
    const path = el('input', { class: 'text-input', 'aria-label': '新分类路径', placeholder: '例如：技术 / 前端 / 框架', value: row.category?.join(' / ') || '' });
    const destination = el('div');
    function fields() { destination.replaceChildren(el('label', { class: 'field' }, el('span', {}, newMode ? `相对于 ${data.job.options.rootPath}（最多三级）` : '选择已有目录'), newMode ? path : folder)); }
    fields();
    content.append(el('label', { class: 'field' }, el('span', {}, '目标类型'), mode), destination, button('保存建议', 'check', async event => {
      const btn = event.currentTarget; btn.disabled = true;
      try { const next = await request('organizerEdit', { jobId: data.job.id, id: row.id, target: newMode ? { category: path.value } : { folderId: folder.value } }); selected.add(row.id); accept(next); modal.close(); }
      catch (error) { toast(error.message, true); } finally { btn.disabled = false; }
    }, 'button primary'));
  }
  function draw() {
    if (!root?.isConnected) return;
    const library = getLibrary(), folders = library.folders.filter(f => !f.managed), job = data?.job;
    root._lastRows = new Map(job?.items.map(b => [b.id, b.status]) || []);
    if (!draft.engine) draft.engine = library.settings.apiReady ? 'ai' : 'local';
    if (!draft.rootId) draft.rootId = folders[0]?.id || '';
    const disabled = runner || !!action || job?.status === 'analyzing';
    const heading = el('div', { class: 'page-heading' }, el('div', {}, el('div', { class: 'eyebrow' }, 'A PLACE FOR EVERY BOOKMARK'), el('h1', {}, '批量整理书签'), el('p', { class: 'muted' }, '读懂整库收藏，先预览分类，再决定如何安放。')));
    const scope = el('select', { class: 'text-input', value: draft.scopeId, disabled, 'aria-label': '整理范围', onChange: e => { draft.scopeId = e.target.value; } }, el('option', { value: '' }, '全部书签'), ...folders.map(f => el('option', { value: f.id }, f.path)));
    scope.value = draft.scopeId;
    const engine = el('select', { class: 'text-input', disabled, 'aria-label': '分析方式', onChange: e => { draft.engine = e.target.value; } }, el('option', { value: 'ai' }, `大模型 · ${library.settings.model}`), el('option', { value: 'local' }, '本地规则 · 不调用 API')); engine.value = draft.engine;
    const allowNew = el('input', { type: 'checkbox', checked: draft.allowNew, disabled, onChange: e => { draft.allowNew = e.target.checked; draw(); } });
    const controls = el('section', { class: 'settings-card organize-controls' }, el('div', { class: 'organize-fields' }, el('label', { class: 'field' }, el('span', {}, '整理范围（包含子目录）'), scope), el('label', { class: 'field' }, el('span', {}, '分析方式'), engine)), el('label', { class: 'organize-checkbox' }, allowNew, '允许新建分类目录（最多三级，默认仅推荐已有目录）'));
    if (draft.allowNew) {
      const rootFolder = el('select', { class: 'text-input', disabled, 'aria-label': '新分类保存目录', onChange: e => { draft.rootId = e.target.value; } }, ...folders.map(f => el('option', { value: f.id }, f.path))); rootFolder.value = draft.rootId;
      controls.append(el('label', { class: 'field' }, el('span', {}, '新分类保存目录'), rootFolder));
    }
    controls.append(el('p', { class: 'organize-privacy' }, draft.engine === 'ai' ? '分析时每批最多 20 条；仅发送书签标题、网址和分类目录，不发送正文。生成建议不会移动书签。' : '本地分析使用目录关键词与同站点历史。依据不足时保留当前位置，不创建模型分类。'));
    const startButton = button(job ? '重新分析' : '开始分析', 'spark', () => {
      if (!job) return start();
      const { modal, content } = dialog('重新生成整理建议？', '当前建议会替换为新结果；已应用的移动记录仍可撤销。');
      content.append(button('确认重新分析', 'refresh', () => { modal.close(); start(); }, 'button primary'));
    }, 'button primary'); startButton.disabled = disabled;
    const startActions = el('div', { class: 'organize-start-actions' }, startButton);
    if (job && job.cursor < job.items.length) {
      const resume = button(runner || job.status === 'analyzing' ? '暂停分析' : '继续分析', runner ? 'x' : 'arrow', () => runner || job.status === 'analyzing' ? pause() : analyze(), 'button secondary'); resume.disabled = !!action; startActions.append(resume);
    }
    const undoCount = data?.history.filter(e => e.status === 'applied').length || 0;
    if (undoCount) { const btn = button(`撤销已应用的移动（${undoCount}）`, 'refresh', () => { const { modal, content } = dialog(`撤销 ${undoCount} 条移动记录？`, '按相反顺序还原书签目录和位置。被其他操作改动的书签会跳过；新建的分类文件夹会保留。'); content.append(button('确认撤销移动', 'refresh', () => { modal.close(); undo(); }, 'button primary')); }, 'button secondary'); btn.disabled = disabled; startActions.append(btn); }
    controls.append(startActions);
    const note = el('div', { class: 'organize-persistence' }, icon('check', 15), '结果和移动记录保存在本机。关闭页面后完成当前批次，重新打开可继续分析或应用。');
    root.replaceChildren(heading, controls, note);
    if (action) root.append(el('div', { class: 'organize-progress' }, el('strong', {}, `${action.type === 'undo' ? '正在撤销移动' : '正在应用建议'} · ${action.done} / ${action.total}`), button('停止后续处理', 'x', () => { action.stop = true; }, 'text-button')));
    if (!job) { root.append(el('div', { class: 'empty' }, el('span', { class: 'empty-icon' }, icon('spark', 30)), el('h3', {}, data ? '为已有收藏，整理一份新秩序' : '正在读取整理记录…'), el('p', {}, '选择范围开始分析，生成的建议会显示当前位置和推荐位置。'))); return; }
    const done = job.cursor, count = job.items.length, suggestions = job.items.filter(eligible), fallbacks = job.items.filter(b => b.source === 'local' && b.warning).length;
    const bar = el('progress', { max: count, value: done, 'aria-label': '书签分析进度' });
    root.append(el('section', { class: 'organize-progress' }, el('div', {}, el('strong', {}, job.status === 'ready' ? '分析完成 · 等待预览和应用' : runner || job.status === 'analyzing' ? '正在分批分析…' : '分析已暂停'), el('span', { class: 'muted' }, `已分析 ${done} / ${count} · 可应用 ${suggestions.length} · 本地回退 ${fallbacks}`), bar)));
    const errors = data.history.filter(e => e.status === 'conflict' && e.error).slice(-5);
    if (errors.length) root.append(el('div', { class: 'notice' }, ...errors.map(e => el('p', {}, `${e.title}：${e.error}`))));
    const toolbar = el('div', { class: 'organize-toolbar' });
    const search = el('input', { class: 'text-input', type: 'search', 'aria-label': '筛选整理建议', placeholder: '筛选书签、当前目录或建议目录…', value: query, onInput: e => { query = e.target.value; pageSize = 50; renderRows(); } });
    const select = el('select', { class: 'text-input', 'aria-label': '建议状态', onChange: e => { filter = e.target.value; pageSize = 50; renderRows(); } }, ...[['all', '全部建议'], ['suggested', '待应用'], ['unchanged', '无需移动'], ['applied', '已应用'], ['failed', '需检查'], ['ignored', '已忽略'], ['pending', '待分析']].map(([value, title]) => el('option', { value }, title))); select.value = filter;
    const applyButton = button('', 'check', () => confirmApply([...selected]), 'button primary');
    function updateApply() { applyButton.replaceChildren(icon('check', 16), `应用选中（${selected.size}）`); applyButton.disabled = disabled || !selected.size; }
    updateApply(); toolbar.append(search, select, applyButton); root.append(toolbar);
    const rowsRoot = el('div', { class: 'organize-results' }); root.append(rowsRoot);
    function renderRows() {
      const visible = job.items.filter(row => (filter === 'all' || row.status === filter || (filter === 'suggested' && eligible(row))) && `${row.title} ${row.url} ${row.currentPath} ${row.targetPath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      const selectable = visible.filter(eligible);
      const checkbox = el('input', { type: 'checkbox', 'aria-label': '选择当前筛选的全部建议', disabled, checked: !!selectable.length && selectable.every(b => selected.has(b.id)), onChange: e => { for (const row of selectable) e.target.checked ? selected.add(row.id) : selected.delete(row.id); updateApply(); renderRows(); } });
      rowsRoot.replaceChildren(el('div', { class: 'organize-list-heading' }, el('label', {}, checkbox, `当前筛选 ${visible.length} 项`), el('span', { class: 'muted' }, '当前位置 → 建议位置')));
      for (const row of visible.slice(0, pageSize)) {
        const canApply = eligible(row), checked = el('input', { type: 'checkbox', 'aria-label': `选择 ${row.title}`, checked: selected.has(row.id), disabled: disabled || !canApply, onChange: e => { e.target.checked ? selected.add(row.id) : selected.delete(row.id); updateApply(); } });
        const card = el('article', { class: 'organize-row', 'data-bookmark-id': row.id }, checked, el('div', { class: 'organize-row-body' }, el('div', { class: 'organize-row-title' }, el('strong', {}, row.title || row.url), el('span', { class: 'organize-status status-' + row.status }, statusText[row.status])), el('p', { class: 'organize-url', title: row.url }, row.url), el('div', { class: 'organize-paths' }, el('span', {}, icon('folder', 13), row.currentPath), icon('arrow', 15), el('span', { class: row.category ? 'new-category' : '' }, icon('folder', 13), row.targetPath || '等待分析', row.category ? el('small', {}, '将新建 / 复用') : null)), row.reason ? el('p', { class: 'organize-reason' }, `${row.source === 'ai' ? '模型建议' : row.source === 'manual' ? '手动调整' : '本地规则'} · ${row.reason}`) : null, row.warning ? el('p', { class: 'organize-warning' }, row.warning) : null));
        const actions = el('div', { class: 'organize-row-actions' });
        if (!['pending', 'applied'].includes(row.status)) {
          const editBtn = button('修改建议', 'folder', () => edit(row), 'text-button'); editBtn.disabled = disabled; actions.append(editBtn);
          if (canApply) { const applyBtn = button('应用', 'check', () => apply([row.id]), 'text-button'); applyBtn.disabled = disabled; actions.append(applyBtn); }
          if (row.status !== 'ignored') { const ignore = button('忽略', null, async () => { try { accept(await request('organizerEdit', { jobId: job.id, id: row.id, ignored: true })); } catch (error) { toast(error.message, true); } }, 'text-button muted'); ignore.disabled = disabled; actions.append(ignore); }
        }
        card.append(actions); rowsRoot.append(card);
      }
      if (!visible.length) rowsRoot.append(el('div', { class: 'empty' }, el('p', {}, '当前筛选没有整理建议。')));
      if (visible.length > pageSize) rowsRoot.append(button('加载更多建议', null, () => { pageSize += 50; renderRows(); }, 'button load-more'));
    }
    renderRows();
  }
  return {
    mount(target) { root = target; draw(); refresh(); }, refresh,
    detach() { if (runner && data?.job) { runner = false; generation++; request('organizerPause', { jobId: data.job.id }).catch(() => {}); } if (action) { action.stop = true; generation++; } root = null; }
  };
}
