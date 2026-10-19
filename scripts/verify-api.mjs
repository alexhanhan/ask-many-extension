import { readFile } from 'node:fs/promises';
import { callModel, validateSettings } from '../extension/core.js';
const config = JSON.parse((await readFile(new URL('../extension/local-settings.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const settings = validateSettings(config);
try {
  const answer = await callModel(settings, [{ role: 'user', content: 'Reply only with OK.' }]);
  console.log(JSON.stringify({ connected: true, endpoint: settings.baseUrl, model: settings.model, receivedText: !!answer.trim() }));
} catch (error) {
  console.log(JSON.stringify({ connected: false, endpoint: settings.baseUrl, model: settings.model, error: error.message }));
  process.exitCode = 1;
}
