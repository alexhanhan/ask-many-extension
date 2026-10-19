import { readFile } from 'node:fs/promises';
import { validateSettings, callModel } from '../extension/core.js';
import { makePlan, batchCandidates, classificationMessages, parseBatch } from '../extension/organizer-core.js';
const settings = validateSettings(JSON.parse((await readFile(new URL('../extension/local-settings.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, '')));
const samples = [
  ['React 官方文档', 'https://react.dev'], ['Figma 社区设计资源', 'https://figma.com/community'],
  ['DeepSeek API 官方文档', 'https://api-docs.deepseek.com'], ['现代 JavaScript 教程', 'https://zh.javascript.info'], ['GitHub 开源项目', 'https://github.com']
];
const folders = ['待整理', '开发技术', '设计灵感', '人工智能', '学习阅读'].map((title, index) => ({ id: `folder-${index}`, parentId: 'bar', title, children: [] }));
folders[0].children = samples.map(([title, url], index) => ({ id: `sample-${index}`, title, url, parentId: 'folder-0' }));
const tree = [{ id: 'root', children: [{ id: 'bar', parentId: 'root', title: '书签栏', children: folders }] }];
try {
  const plan = makePlan(tree), candidates = batchCandidates(plan.items, tree);
  const content = await callModel(settings, classificationMessages(plan.items, candidates, plan.options), undefined, { maxTokens: 4096 });
  const results = parseBatch(content, plan.items, candidates, plan.options, tree);
  if (results.some(row => row.source !== 'ai')) throw Error('部分模型结果无效，触发了本地回退');
  console.log(JSON.stringify({ connected: true, model: settings.model, classifiedSamples: results.length, allValidExistingFolders: true, realUserBookmarksSent: false, pageBodySent: false }));
} catch (error) { console.log(JSON.stringify({ connected: false, error: error.message })); process.exitCode = 1; }
