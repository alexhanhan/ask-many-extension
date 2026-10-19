import { flattenTree, callModel } from './core.js';
import { ORGANIZER_BATCH_SIZE, makePlan, batchCandidates, classificationMessages, parseBatch, localSuggestion, validateSuggestion } from './organizer-core.js';

export function createOrganizerService(api, getSettings, modelCall = callModel) {
  let queue = Promise.resolve(), busy = false, controller = null;
  const locked = fn => { const task = queue.then(fn, fn); queue = task.catch(() => {}); return task; };
  const uid = () => globalThis.crypto.randomUUID();
  async function read() { const data = await api.storage.local.get(['organizerJob', 'organizerHistory']); return { job: data.organizerJob || null, history: data.organizerHistory || [] }; }
  async function write(job, history) { await api.storage.local.set({ organizerJob: job, organizerHistory: history }); }
  function checkJob(job, id) { if (!job || job.id !== id) throw new Error('任务已被替换，请刷新整理页面'); }
  async function snapshot() {
    return locked(async () => {
      const { job, history } = await read();
      let changed = false;
      if (!busy && job?.status === 'analyzing') { job.status = 'paused'; changed = true; }
      // Reconcile a worker termination between preparing and completing a move.
      if (!busy) for (const entry of history.filter(e => e.status === 'prepared' || e.status === 'undoing')) {
        const undoing = entry.status === 'undoing';
        const [node] = await api.bookmarks.get(entry.bookmarkId).catch(() => []);
        if (node?.url === entry.url && node.parentId === (undoing ? entry.parentId : entry.targetId)) {
          entry.status = undoing ? 'undone' : 'applied';
          const row = job?.id === entry.jobId && job.items.find(b => b.id === entry.bookmarkId);
          if (row) row.status = undoing ? 'suggested' : 'applied';
        } else if (node?.url === entry.url && node.parentId === (undoing ? entry.targetId : entry.parentId)) entry.status = undoing ? 'applied' : 'aborted';
        else { entry.status = 'conflict'; entry.error = '书签位置已由其他操作改变，未覆盖'; }
        changed = true;
      }
      if (changed) await write(job, history);
      return { job, history };
    });
  }
  async function start(options) {
    if (busy) throw new Error('当前批次尚未完成，请先暂停或等待');
    const config = await getSettings();
    if (options.engine !== 'local' && !config.configured) throw new Error(config.unavailableReason || '请先配置并启用大模型，或选择本地规则');
    const plan = makePlan(await api.bookmarks.getTree(), options);
    return locked(async () => {
      if (busy) throw new Error('已有任务正在处理');
      const { history } = await read();
      const job = { id: uid(), ...plan, status: 'paused', cursor: 0, createdAt: Date.now(), updatedAt: Date.now(), model: options.engine === 'local' ? '' : config.model, token: null };
      await write(job, history); return { job, history };
    });
  }
  async function step(id) {
    if (busy) throw new Error('另一个页面正在处理当前批次，请稍后再试');
    busy = true; controller = new AbortController();
    try {
      const initial = await locked(async () => {
        const { job, history } = await read(); checkJob(job, id);
        if (job.cursor >= job.items.length) return null;
        job.status = 'analyzing'; job.token = uid();
        await write(job, history); return job;
      });
      if (!initial) return await read();
      const batch = initial.items.slice(initial.cursor, initial.cursor + ORGANIZER_BATCH_SIZE);
      const tree = await api.bookmarks.getTree();
      let results;
      if (initial.options.engine === 'local') results = batch.map(item => localSuggestion(item, tree));
      else {
        try {
          const config = await getSettings();
          if (!config.configured) throw new Error(config.unavailableReason || '大模型配置不可用');
          const folders = batchCandidates(batch, tree);
          const proposedCategories = [...new Set(initial.items.filter(b => b.category).map(b => JSON.stringify(b.category)))].slice(0, 100).map(value => JSON.parse(value));
          const content = await modelCall(config, classificationMessages(batch, folders, { ...initial.options, proposedCategories }), undefined, { maxTokens: 4096, signal: controller.signal });
          results = parseBatch(content, batch, folders, initial.options, tree);
        } catch (error) { results = batch.map(item => localSuggestion(item, tree, error.message)); }
      }
      return await locked(async () => {
        const { job, history } = await read(); checkJob(job, id);
        if (job.token !== initial.token || job.status !== 'analyzing') return { job, history };
        job.items.splice(initial.cursor, results.length, ...results);
        job.cursor += batch.length; job.updatedAt = Date.now(); job.status = job.cursor >= job.items.length ? 'ready' : 'paused'; job.token = null;
        await write(job, history); return { job, history };
      });
    } finally { busy = false; controller = null; }
  }
  async function pause(id) {
    controller?.abort();
    return locked(async () => { const { job, history } = await read(); checkJob(job, id); job.token = null; if (job.status === 'analyzing') job.status = 'paused'; await write(job, history); return { job, history }; });
  }
  async function edit({ jobId, id, target, ignored }) {
    if (busy) throw new Error('请先暂停当前处理');
    const { folders } = flattenTree(await api.bookmarks.getTree());
    return locked(async () => {
      if (busy) throw new Error('请先暂停当前处理');
      const { job, history } = await read(); checkJob(job, jobId);
      const item = job.items.find(b => b.id === id);
      if (!item || ['pending', 'applied'].includes(item.status)) throw new Error('此建议当前不可编辑');
      if (ignored) item.status = 'ignored';
      else { const value = validateSuggestion(item, target, folders, job.options); Object.assign(item, value, { source: 'manual', reason: '手动选择的分类' }); }
      await write(job, history); return { job, history };
    });
  }
  async function writable(id) {
    const { folders } = flattenTree(await api.bookmarks.getTree());
    const folder = folders.find(f => f.id === id && !f.managed);
    if (!folder) throw new Error('目标或原目录不存在，或由管理员管理');
    return folder;
  }
  async function resolveTarget(job, row) {
    if (row.folderId) { await writable(row.folderId); return row.folderId; }
    if (!job.options.allowNew || !row.category) throw new Error('目标目录无效');
    await writable(job.options.rootId);
    let parentId = job.options.rootId;
    for (const title of row.category) {
      const children = await api.bookmarks.getChildren(parentId);
      let folder = children.find(n => !n.url && n.title.toLocaleLowerCase() === title.toLocaleLowerCase());
      if (folder?.unmodifiable) throw new Error('同名目录由管理员管理');
      if (!folder) folder = await api.bookmarks.create({ parentId, title });
      await writable(folder.id);
      parentId = folder.id;
    }
    return parentId;
  }
  async function applyOne({ jobId, id }) {
    if (busy) throw new Error('已有批次正在处理');
    busy = true;
    try {
      const { job } = await read(); checkJob(job, jobId);
      const row = job.items.find(b => b.id === id);
      if (!row || !['suggested', 'failed'].includes(row.status) || (!row.folderId && !row.category)) throw new Error('这条建议当前不可应用');
      try {
        const [node] = await api.bookmarks.get(id);
        if (node.url !== row.url || node.title !== row.title || node.parentId !== row.parentId) throw new Error('书签已被编辑或移动，请重新分析');
        await writable(node.parentId);
        const targetId = await resolveTarget(job, row);
        if (targetId === node.parentId) {
          return await locked(async () => { const data = await read(); checkJob(data.job, jobId); data.job.items.find(b => b.id === id).status = 'unchanged'; await write(data.job, data.history); return data; });
        }
        const [latest] = await api.bookmarks.get(id);
        if (latest.url !== row.url || latest.title !== row.title || latest.parentId !== row.parentId) throw new Error('书签已被编辑或移动，请重新分析');
        const entry = { id: uid(), jobId, bookmarkId: id, title: latest.title, url: latest.url, parentId: latest.parentId, index: latest.index || 0, targetId, status: 'prepared', createdAt: Date.now() };
        await locked(async () => { const data = await read(); checkJob(data.job, jobId); data.history.push(entry); await write(data.job, data.history); });
        await api.bookmarks.move(id, { parentId: targetId });
        return await locked(async () => {
          const data = await read(); data.history.find(e => e.id === entry.id).status = 'applied';
          data.job.items.find(b => b.id === id).status = 'applied'; await write(data.job, data.history); return data;
        });
      } catch (error) {
        return await locked(async () => { const data = await read(); checkJob(data.job, jobId); const item = data.job.items.find(b => b.id === id); item.status = 'failed'; item.warning = error.message; await write(data.job, data.history); return data; });
      }
    } finally { busy = false; }
  }
  async function undoOne({ id }) {
    if (busy) throw new Error('已有批次正在处理');
    busy = true;
    try {
      const { history } = await read(); const entry = history.find(e => e.id === id && e.status === 'applied');
      if (!entry) throw new Error('这条移动记录不可撤销');
      try {
        const [node] = await api.bookmarks.get(entry.bookmarkId);
        if (node.url !== entry.url || node.parentId !== entry.targetId) throw new Error('书签已被其他操作改变，未覆盖当前位置');
        await writable(entry.parentId); await writable(node.parentId);
        await locked(async () => { const data = await read(); data.history.find(e => e.id === id).status = 'undoing'; await write(data.job, data.history); });
        const children = await api.bookmarks.getChildren(entry.parentId);
        await api.bookmarks.move(node.id, { parentId: entry.parentId, index: Math.min(entry.index, children.length) });
        return await locked(async () => { const data = await read(); data.history.find(e => e.id === id).status = 'undone'; const row = data.job?.id === entry.jobId && data.job.items.find(b => b.id === node.id); if (row) { row.status = 'suggested'; row.warning = ''; } await write(data.job, data.history); return data; });
      } catch (error) {
        return await locked(async () => { const data = await read(); const record = data.history.find(e => e.id === id); record.error = error.message; record.status = 'conflict'; await write(data.job, data.history); return data; });
      }
    } finally { busy = false; }
  }
  return { snapshot, start, step, pause, edit, applyOne, undoOne };
}
