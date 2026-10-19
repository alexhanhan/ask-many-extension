import { createRequire } from 'node:module';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const profile = await mkdtemp(path.join(os.tmpdir(), 'bookmark-cold-popup-'));
const extension = path.join(profile, 'extension');
await cp(path.resolve('extension'), extension, { recursive: true, filter: file => !path.basename(file).startsWith('local-settings.json') });
const delay = Number(process.env.COLD_WORKER_DELAY_MS || 0);
if (delay) {
  const file = path.join(extension, 'background.js');
  await writeFile(file, `{ const until = performance.now() + ${delay}; while (performance.now() < until) {} }\n` + await readFile(file, 'utf8'));
}
const context = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: process.env.BROWSER_PATH || undefined,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'], viewport: { width: 1280, height: 900 }
});
try {
  const page = context.pages()[0] || await context.newPage();
  await context.route('https://cold-popup-test.example/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Cold popup fixture</title><main>Isolated cold-start test</main>' }));
  await page.goto('https://cold-popup-test.example/');
  const pageCdp = await context.newCDPSession(page);
  const cdp = await context.browser().newBrowserCDPSession();
  const version = await cdp.send('Browser.getVersion');
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  const worker = context.serviceWorkers().find(w => w.url().includes(id)) || await context.waitForEvent('serviceworker', { timeout: 30000 });
  await worker.evaluate(async () => chrome.storage.local.set({ localConfigImported: true, settings: { configured: false, monitorNative: false, notifications: false } }));
  console.log('Browser:', version.product, 'worker delay:', delay, 'ms');
  await pageCdp.send('ServiceWorker.enable');
  const tabTarget = (await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] })).targetInfos.find(t => t.url === page.url()).targetId;
  const samples = [];
  for (let attempt = 0; attempt < Number(process.env.COLD_POPUP_ATTEMPTS || 1); attempt++) {
    await pageCdp.send('ServiceWorker.stopAllWorkers');
    for (let i = 0; i < 100; i++) {
      const targets = (await cdp.send('Target.getTargets')).targetInfos;
      if (!targets.some(t => t.type === 'service_worker' && t.url.includes(id))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(!(await cdp.send('Target.getTargets')).targetInfos.some(t => t.type === 'service_worker' && t.url.includes(id)), 'Worker must be stopped before triggering the action');
    const start = performance.now();
    const action = cdp.send('Extensions.triggerAction', { id, targetId: tabTarget });
    let popup;
    for (let i = 0; i < 1500; i++) {
      popup = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${id}/popup.html`);
      if (popup) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(popup, 'Toolbar action must create a popup target');
    const targetMs = Math.round(performance.now() - start);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: false });
    let sequence = 0;
    function command(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++sequence;
        const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(Error('Popup target stopped responding')); }, 5000);
        const listener = event => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id !== requestId) return;
          clearTimeout(timer);
          cdp.off('Target.receivedMessageFromTarget', listener);
          if (message.error) reject(Error(message.error.message)); else resolve(message.result);
        };
        cdp.on('Target.receivedMessageFromTarget', listener);
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: requestId, method, params }) }).catch(reject);
      });
    }
    let dom;
    for (let i = 0; i < 400; i++) {
      dom = (await command('Runtime.evaluate', { expression: `({ready:!!document.getElementById('quick-popup'),status:document.getElementById('startup-status')?.textContent})`, returnByValue: true })).result.value;
      if (dom?.ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const readyMs = Math.round(performance.now() - start);
    assert.equal(dom?.ready, true);
    await action;
    for (let i = 0; i < 1500; i++) {
      const text = (await command('Runtime.evaluate', { expression: `document.getElementById('startup-status')?.textContent`, returnByValue: true })).result.value || '';
      if (!text.includes('正在读取')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const statusReadyMs = Math.round(performance.now() - start);
    const workerRestarted = (await cdp.send('Target.getTargets')).targetInfos.some(t => t.type === 'service_worker' && t.url.includes(id));
    assert.equal(workerRestarted, false, 'Opening the ordinary popup must not restart the worker');
    samples.push({ attempt: attempt + 1, targetMs, readyMs, statusReadyMs, workerRestarted });
    console.log('Cold sample:', JSON.stringify(samples.at(-1)));
    await cdp.send('Target.closeTarget', { targetId: popup.targetId });
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const report = { browser: version.product, workerDelayMs: delay, samples };
  await mkdir('artifacts', { recursive: true });
  await writeFile(`artifacts/cold-popup-${delay}.json`, JSON.stringify(report, null, 2));
  console.log('PASS: worker stopped before every real toolbar action; no extension tab or private configuration used.');
} finally { await context.close(); }
