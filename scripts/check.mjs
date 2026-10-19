import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const folder = path.join(root, 'extension');
const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw Error('Manifest must use MV3');
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://api.deepseek.com/*'])) throw Error('Only the configured DeepSeek API may have built-in host access');
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page.split('#')[0], ...Object.values(manifest.icons)]) await readFile(path.join(folder, file));
for (const name of await readdir(folder)) {
  if (name.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', path.join(folder, name)], { encoding: 'utf8' });
    if (result.status) throw Error(result.stderr);
  }
  if (name.endsWith('.html')) {
    const html = await readFile(path.join(folder, name), 'utf8');
    if (name === manifest.action.default_popup && (/<script\b/i.test(html) || /<link\b[^>]*\brel=["'](?:preload|stylesheet)["']/i.test(html))) throw Error('Toolbar shortcut popup must remain static, with no scripts or external styles');
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) || /\bonclick\s*=/i.test(html)) throw Error('Inline scripts are not allowed');
  }
}
console.log('Manifest, extension resources, CSP and JavaScript syntax checks passed.');
