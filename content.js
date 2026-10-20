/*
 * 注入到每个 AI 站点（含 iframe 内）。只负责听面板的指令、操作本页 DOM、回报结果。
 * 所有 DOM 细节都在 adapters.js 里，这里不重复实现。
 */
(function () {
  'use strict';

  const A = globalThis.AskManyAdapters;
  if (!A) return;

  const site = A.bySite(location.hostname);
  if (!site) return;

  const diagnosticVersion = 'send-20261014-1';

  const answerSignature = (text) => {
    if (!text) return '';
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
  };

  async function waitForFreshStableAnswer(
    baselineSignature,
    baselineAnswerCount,
    maxWait = A.MAX_WAIT_MS
  ) {
    const deadline = Date.now() + maxWait;
    let started = false;
    let previousSignature = '';
    let previousText = '';
    let stableRounds = 0;

    while (Date.now() < deadline) {
      const snapshot = A.answerSnapshot(site, document);
      const text = snapshot.text || '';
      const signature = answerSignature(text);
      const count = snapshot.count;
      if (!started) {
        const hasNewNode = Number.isFinite(baselineAnswerCount) && count > baselineAnswerCount;
        if (!hasNewNode && signature === baselineSignature) {
          await A.sleep(A.POLL_MS);
          continue;
        }
        started = true;
      }

      if (text && signature === previousSignature) {
        stableRounds++;
        if (stableRounds >= A.STABLE_ROUNDS) return text;
      } else {
        stableRounds = 0;
        previousSignature = signature;
        previousText = text;
      }
      await A.sleep(A.POLL_MS);
    }

    return started ? previousText : null;
  }

  // 只接受面板直接创建的 AI iframe。普通站点标签页和 AI 页面内部的
  // 同源子 frame 也会命中 manifest；后者若上报相同 siteId，会覆盖正确
  // frameId，导致后续指令被投递到没有输入框的子 frame。
  const inFrame = window.top !== window.self;
  const isDirectChildFrame = inFrame && window.parent === window.top;
  if (!inFrame && site.accountChooserUrl) {
    // 后台只处理由工作台发起的账号选择页签；普通独立页签不会影响工作台。
    chrome.runtime.sendMessage({ type: 'gemini-account-ready' }).catch(() => {});
  }
  if (!isDirectChildFrame) return;

  if (site.accountEntry) {
    document.addEventListener('click', (event) => {
      if (!event.isTrusted || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (!site.accountEntry(target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      chrome.runtime.sendMessage({ type: 'open-gemini-account' })
        .then((result) => {
          if (!result?.ok) console.warn('[同问] 账号选择页打开失败', result?.error);
        })
        .catch((error) => console.warn('[同问] 账号选择页打开失败', error.message));
    }, true);
  }

  // 让面板知道"我在这个 frame 里，可以接指令了"。
  // iframe 内的 content script 无法直接被面板 postMessage 找到（跨源），
  // 所以走 runtime 消息由 background 按 frameId 投递。
  console.info(`[同问诊断][${diagnosticVersion}][${site.id}] 站点脚本已加载`);
  chrome.runtime.sendMessage({
    type: 'frame-ready', siteId: site.id, inFrame, diagnosticVersion,
  }).catch((error) => console.warn('[同问诊断] 站点注册失败', site.id, error.message));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.siteId !== site.id) return false;
    const respond = (result) => {
      const reply = { ...result, diagnosticVersion };
      if (msg.diagnostics === true) {
        try {
          reply.diagnostics = A.answerDiagnostics?.(site, document) ?? null;
        } catch (error) {
          reply.diagnostics = { error: error.message };
        }
      }
      sendResponse(reply);
    };

    if (msg.type === 'ping') {
      respond({ ok: true, siteId: site.id, hasInput: !!site.input(document) });
      return true;
    }

    /*
     * 发送拆成两阶段，每个站点独立准备并提交：
     *   prepare —— 填入文本、等自己的发送按钮变可用（各站点耗时差别很大）
     *   fire    —— 立即提交，不再有任何等待
     * 面板并发 prepare，本站点就绪后立即 fire，不等其他站点。
     */
    if (msg.type === 'prepare') {
      const prepareStartedAt = Date.now();
      const files = msg.files || [];
      const snapshot = A.answerSnapshot(site, document);
      const previousAnswer = snapshot.text;
      const answerBaselineLength = previousAnswer ? previousAnswer.length : 0;
      const answerBaselineSignature = answerSignature(previousAnswer);
      const answerBaselineCount = snapshot.count;

      /*
       * 先注入附件再填文字：注入后站点立刻开始上传，这段时间正好用来填文字，
       * 两段等待重叠而不是相加。注入失败不阻断纯文字发送 —— 附件是增强，
       * 不该让整条消息发不出去，所以只回报 fileError 由面板提示。
       */
      // 注入前先数一遍已有缩略图，之后靠"比基线多了"判断站点收下了文件。
      const baseline = files.length ? A.countChips(site, document) : 0;

      (async () => {
        let fileError = null;
        let attached = 0;
        let via = null;

        if (files.length) {
          const r = await A.attachFiles(site, window, document, files,
                                       { baseline, verifyMs: msg.verifyMs });
          if (r.ok) {
            attached = r.attached;
            via = r.via;
            if (r.unverified) fileError = '附件已投递但未能确认站点收下';
          } else {
            fileError = r.error;
          }
        }

        /*
         * 附件注入后才填文字：站点收下图片时会重建输入框（ChatGPT 贴图、
         * Claude 的 ProseMirror 都会），顺序反了刚填的文字会被这次重建吞掉，
         * 最后只发出图片。即便顺序对了也可能撞上重建，所以填完要回读确认。
         */
        const fillStartedAt = Date.now();
        const filled = await A.fillInputVerified(site, window, document, msg.text, 4, {
          readyEarly: !files.length,
        });
        const fillMs = Date.now() - fillStartedAt;
        if (!filled.ok) {
          return { ok: false, error: filled.error || '文字未能填入', siteId: site.id };
        }

        /*
         * 只有 attachFiles 确认过站点收下附件，再等上传完成才有意义。
         * 它没确认（unverified）时说明这个判断信号在本站点上就是不灵的，
         * 再等一遍等的是同一个信号，只会白卡满 uploadMs（表现为长时间"上传中"）。
         */
        const shouldWaitUpload = attached && via !== 'unverified';
        const armTimeout = files.length
          ? Math.max(msg.armMs || 2500, msg.uploadMs || 15000)
          : (msg.armMs || 2500);
        const readyStartedAt = Date.now();
        const [armed, uploaded] = await Promise.all([
          A.waitSendable(site, document, armTimeout),
          shouldWaitUpload
            ? A.waitForUploads(site, document, baseline, attached, msg.uploadMs)
            : Promise.resolve(true),
        ]);

        // 上传没等到确认也放行：可能只是选择器认不出缩略图，不代表真的失败。
        if (attached && !uploaded && !fileError) fileError = '未能确认附件上传完成';
        return {
          ok: true,
          armed,
          attached,
          via,
          fileError,
          answerBaselineLength,
          answerBaselineSignature,
          answerBaselineCount,
          timings: { fillMs, readyWaitMs: Date.now() - readyStartedAt, prepareMs: Date.now() - prepareStartedAt },
          siteId: site.id,
        };
      })()
        .then(respond)
        .catch((e) => respond({ ok: false, error: e.message, siteId: site.id }));
      return true;
    }

    if (msg.type === 'fire') {
      // 在本站点、点击提交之前同步刷新基线，不再为 peek 额外往返后台和面板。
      // 基线读取失败不阻止发送，面板可沿用 prepare 的基线。
      let baseline = {};
      try {
        const snapshot = A.answerSnapshot(site, document);
        baseline = {
          answerBaselineLength: snapshot.text?.length || 0,
          answerBaselineSignature: answerSignature(snapshot.text),
          answerBaselineCount: snapshot.count,
        };
      } catch (error) {
        baseline = { baselineError: error.message };
      }
      const respondFired = (result) => respond({ ...result, ...baseline, siteId: site.id });
      if (site.verifySubmit) {
        A.submitVerified(site, window, document, site.submitVerifyMs)
          .then(respondFired)
          .catch((e) => respondFired({ ok: false, error: e.message }));
        return true;
      }
      const r = A.submit(site, window, document);
      respondFired(r);
      return true;
    }

    if (msg.type === 'peek') {
      const startedAt = Date.now();
      const snapshot = A.answerSnapshot(site, document);
      const t = snapshot.text;
      respond({
        ok: true,
        siteId: site.id,
        length: t ? t.length : 0,
        signature: answerSignature(t),
        answerCount: snapshot.count,
        sampleMs: Date.now() - startedAt,
        diagnosticVersion,
      });
      return true;
    }

    if (msg.type === 'collect') {
      if (msg.immediate) {
        const text = A.latestAnswer(site, document);
        respond({
          ok: true,
          siteId: site.id,
          name: site.name,
          text: text || null,
          signature: answerSignature(text),
        });
        return true;
      }

      const answerPromise = typeof msg.baselineSignature === 'string'
        ? waitForFreshStableAnswer(
            msg.baselineSignature,
            msg.baselineAnswerCount,
            msg.maxWait
          )
        : A.waitForStableAnswer(site, document, null, msg.maxWait);
      answerPromise
        .then((text) =>
          respond({
            ok: true,
            siteId: site.id,
            name: site.name,
            text: text || null,
            signature: answerSignature(text),
          })
        )
        .catch((e) => respond({ ok: false, error: e.message, siteId: site.id }));
      return true;
    }

    return false;
  });
})();
