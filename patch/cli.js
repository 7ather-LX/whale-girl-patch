'use strict';

/**
 * 补丁命令行工具（不启动服务器）：
 *   node whale-patch/cli.js doctor
 *   node whale-patch/cli.js status
 *   node whale-patch/cli.js test-link https://...
 *   node whale-patch/cli.js share-list
 *   node whale-patch/cli.js clear-cache   （只清内存缓存；进程退出后本来就会清）
 */

const fs = require('node:fs');
const path = require('node:path');
const configModule = require('./config');
const reader = require('./link/reader');
const browser = require('./link/browser');
const versionInfo = require('./version');

const root = path.resolve(__dirname, '..');

function ok(label, value) {
  console.log(`  ✅ ${label.padEnd(16)} ${value}`);
}

function bad(label, value) {
  console.log(`  ⚠️  ${label.padEnd(16)} ${value}`);
}

function doctor() {
  console.log(`\n🐋 WhaleGirl 补丁 v${versionInfo.version} · 自检\n`);
  const serverFile = path.join(root, 'server.js');
  const hasServer = fs.existsSync(serverFile);
  hasServer ? ok('server.js', serverFile) : bad('server.js', '找不到');
  if (hasServer) {
    const head = fs.readFileSync(serverFile, 'utf8').split(/\r?\n/).slice(0, 3).join('\n');
    head.includes("require('./whale-patch')")
      ? ok('启动挂钩', '已安装')
      : bad('启动挂钩', 'server.js 里没有 require(\'./whale-patch\')，补丁不会加载');
  }
  const state = configModule.load(root);
  ok('补丁配置', state.file + (state.error ? `（解析失败：${state.error}）` : ''));
  ok('共享记忆', state.config.sharedMemory.enabled
    ? `开 · ${state.config.sharedMemory.scopes.length} 个共享组`
    : '关（打开 /patch/ 配置）');
  ok('链接阅读', state.config.links.enabled ? '开' : '关');
  const b = browser.findBrowser(state.config.links);
  b ? ok('无头浏览器', `${b.name} · ${b.path}`) : bad('无头浏览器', '没有找到 Edge / Chrome（小黑盒这类页面读不了）');
  const py = path.join(root, 'runtime', 'python', 'python.exe');
  fs.existsSync(py) ? ok('内置 Python', py) : bad('内置 Python', '没有找到（只影响视频抽样画面）');
  try {
    const { loadConfig } = require('../src/infra/config');
    const appCfg = loadConfig({ root, env: process.env });
    const vision = require('../src/adapters/vision');
    const st = vision.status(appCfg);
    st.configured ? ok('看图模型', st.model) : bad('看图模型', '未配置（链接阅读仍可用，只是不看视频画面）');
  } catch (err) {
    bad('看图模型', (err && err.message) || String(err));
  }
  try {
    const dir = path.join(root, 'data', 'memory', 'chats');
    const chats = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^[0-9a-f]{16}$/.test(n)).length : 0;
    ok('有记忆的聊天', String(chats));
  } catch {
    ok('有记忆的聊天', '读不到（不影响补丁）');
  }
  console.log('');
}

function status() {
  const state = configModule.load(root);
  const cfg = state.config;
  console.log(JSON.stringify({
    version: versionInfo.version,
    configFile: state.file,
    configError: state.error,
    enabled: cfg.enabled,
    sharedMemory: {
      enabled: cfg.sharedMemory.enabled,
      scopes: cfg.sharedMemory.scopes.map((s) => ({ id: s.id, name: s.name, mode: s.mode, enabled: s.enabled, chats: s.chats.length })),
    },
    links: cfg.links,
    browser: browser.findBrowser(cfg.links),
  }, null, 2));
}

async function testLink(url) {
  if (!url) {
    console.error('用法：node whale-patch/cli.js test-link https://...');
    process.exit(2);
  }
  const state = configModule.load(root);
  let appConfig = null;
  try {
    const { loadConfig } = require('../src/infra/config');
    appConfig = loadConfig({ root, env: process.env });
  } catch { /* 没有 config.json 也能测链接，只是没有看图 */ }
  const started = Date.now();
  const info = await reader.describe(url, {
    linksCfg: state.config.links,
    appConfig,
    root,
    force: true,
    timeoutMs: state.config.links.timeoutMs,
  });
  console.log(`\n耗时 ${Date.now() - started}ms · ${info.ok ? '成功' : '失败'}${info.error ? ' · ' + info.error : ''}\n`);
  console.log(info.prompt || '(没有提示词)');
  if (info.visual && info.visual.length) {
    console.log('\n--- 看图模型看到的画面 ---');
    info.visual.forEach((line) => console.log(line));
  }
  console.log('');
}

function shareList() {
  const cfg = configModule.load(root).config;
  if (!cfg.sharedMemory.scopes.length) return console.log('（还没有共享组）');
  for (const s of cfg.sharedMemory.scopes) {
    const range = s.match === 'group' ? '全部群聊（自动）' : s.match === 'private' ? '全部私聊（自动）' : (s.chats.includes('*') ? '全部聊天' : s.chats.length + ' 个聊天');
    console.log(`- [${s.id}] ${s.name} · ${s.mode} · ${s.enabled ? '启用' : '停用'} · ${range}`);
    if (!s.match || s.match === 'any') for (const key of s.chats) console.log(`    ${key}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'doctor') return doctor();
  if (cmd === 'status') return status();
  if (cmd === 'test-link') return testLink(rest[0]);
  if (cmd === 'share-list') return shareList();
  if (cmd === 'clear-cache') {
    reader.clearCache();
    return console.log('链接缓存已清空（进程内）');
  }
  console.log('可用命令：doctor | status | test-link <url> | share-list | clear-cache');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
