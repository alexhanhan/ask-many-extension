import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const extension = path.join(root, 'extension');
const profile = await mkdtemp(path.join(os.tmpdir(), 'bookmark-grove-private-test-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: process.env.BROWSER_PATH || undefined,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 1440, height: 1040 }
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(`chrome-extension://${id}/manager.html#settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByPlaceholder('已保存密钥，留空则保持原值').waitFor();
  assert.equal(await page.locator('#base-url').inputValue(), 'https://api.deepseek.com');
  assert.equal(await page.locator('#model').inputValue(), 'deepseek-v4-pro');
  const imported = await worker.evaluate(async () => (await chrome.storage.local.get('localConfigImported')).localConfigImported);
  assert.equal(imported, true);
  console.log('Private configuration import verified; testing connection.');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  console.log('Connection test submitted.');
  await page.locator('.connection-status').filter({ hasText: '连接成功' }).waitFor({ timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(root, 'artifacts/deepseek-configured.png'), fullPage: true });
  console.log('PASS: private configuration imported into real extension storage; DeepSeek V4 Pro connection tested from the extension settings UI. Key not displayed.');
} catch (error) {
  const page = context.pages().at(-1);
  console.log('Configuration test failed:', error.message.split('\n')[0]);
  if (page) console.log('Visible connection status:', await page.locator('.connection-status').textContent().catch(() => 'Not available'));
  throw error;
} finally { await context.close(); }
