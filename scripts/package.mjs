import { readFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const stage = await mkdtemp(path.join(os.tmpdir(), 'bookmark-grove-release-'));
await mkdir(path.join(stage, 'extension/icons'), { recursive: true });
// Public allowlist: never copy a credentials/bootstrap file into a distribution.
const files = ['app.js', 'popup-bootstrap.js', 'page-state.js', 'background.js', 'core.js', 'native-flow.js', 'organizer-core.js', 'organizer.js', 'organizer-ui.js', 'demo.js', 'manager.html', 'popup.html', 'collect.html', 'styles.css', 'manifest.json', ...Object.values(manifest.icons)];
for (const file of files) await copyFile(path.join(root, 'extension', file), path.join(stage, 'extension', file));
await copyFile(path.join(root, 'README.md'), path.join(stage, 'README.md'));
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const zip = path.join(root, 'artifacts', `bookmark-grove-v${manifest.version}.zip`);
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath (Join-Path $env:BOOKMARK_STAGE "extension"),(Join-Path $env:BOOKMARK_STAGE "README.md") -DestinationPath $env:BOOKMARK_ZIP -Force'], { env: { ...process.env, BOOKMARK_STAGE: stage, BOOKMARK_ZIP: zip }, encoding: 'utf8' });
if (result.status !== 0) throw Error(result.stderr || 'Packaging failed');
console.log('Public package created:', zip);
