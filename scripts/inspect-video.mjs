import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const file = process.argv[2];
if (!file) throw Error('Provide a local recording path');
const bytes = await readFile(file);
const output = path.resolve('artifacts/idle-recording');
await mkdir(output, { recursive: true });
const server = http.createServer((req, res) => {
  if (req.url === '/clip') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); res.end(bytes); }
  else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<body style="margin:0;background:#222"><video style="display:block;max-width:1280px" src="/clip" preload="auto" muted></video></body>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2, { timeout: 30000 });
  const info = await page.locator('video').evaluate(v => ({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }));
  console.log(JSON.stringify(info));
  await page.locator('video').evaluate(v => v.play());
  for (let second = 0; second < info.duration; second += 2) {
    await page.waitForFunction(time => document.querySelector('video').currentTime >= time, second);
    const frame = await page.locator('video').evaluate(v => { const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png').split(',')[1]; });
    await writeFile(path.join(output, `${String(second).padStart(3, '0')}.png`), Buffer.from(frame, 'base64'));
  }
  await writeFile(path.join(output, 'metadata.json'), JSON.stringify(info));
  console.log('Frames saved:', output);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
