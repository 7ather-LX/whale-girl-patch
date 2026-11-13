'use strict';

/**
 * 鲸鲸补丁入口。
 *
 * 设计原则：**不改鲸鲸的业务源码**。
 *   - 安装器只在 server.js 第一行插一句 require('./whale-patch').install()；
 *   - 其余全部在运行时包一层：Store.buildContext / links.describeLink / createRouter / createRuntime；
 *   - 卸载 = 删掉补丁目录 + 去掉那一行，鲸鲸本身没有任何残留改动。
 *
 * 包一层而不是复制整个函数的好处：鲸鲸以后升级内部实现，只要这些方法还在，
 * 补丁就还能用；坏处是依赖内部方法签名，所以 README 里写清兼容的 4.0.x 范围，
 * 并且每个包装点都自己 try/catch —— 补丁出错绝不能把正常聊天带崩。
 */

const path = require('node:path');
const versionInfo = require('./version');
const configModule = require('./config');
const shared = require('./shared-memory');
const reader = require('./link/reader');
const browser = require('./link/browser');

const STATE_KEY = '__WHALE_GIRL_PATCH__';

let installed = false;
let runtimeRef = null;
let rootRef = '';
let installInfo = null;
let lastErrorAt = 0;
let lastErrorText = '';

function log(level, text) {
  const logger = runtimeRef && runtimeRef.logger;
  try {
    if (logger && typeof logger[level] === 'function') logger[level](text);
    else if (level === 'error' || level === 'warn') console.error(text);
    else console.log(text);
  } catch {
    /* 日志失败不影响聊天 */
  }
}

function logOnce(text) {
  const now = Date.now();
  if (text === lastErrorText && now - lastErrorAt < 10 * 60 * 1000) return;
  lastErrorAt = now;
  lastErrorText = text;
  log('warn', text);
}

function patchStore(root) {
  const { Store } = require('../src/memory/store');
  const { estimateBudgetTokens } = require('../src/memory/tokens');
  if (Store.prototype.__whalePatchWrapped) return;
  const original = Store.prototype.buildContext;

  Store.prototype.buildContext = function buildContextWithSharedMemory(opts = {}) {
    const mem = original.call(this, opts);
    try {
      if (!mem || typeof mem !== 'object') return mem;
      const state = configModule.load(root);
      const cfg = state.config;
      if (!cfg.enabled || !cfg.sharedMemory.enabled) return mem;
      const built = shared.build(this, {
        key: opts.key,
        query: opts.query,
        uid: opts.uid,
        name: opts.name,
        sharedConfig: cfg.sharedMemory,
      });
      if (!built || !built.block) return mem;
      const base = shared.patchScopeNotice(String(mem.block || ''));
      mem.block = [base, built.block].filter(Boolean).join('\n\n');
      mem.memoryTokens = estimateBudgetTokens(mem.block);
      mem.sharedMemory = {
        scope: built.scope ? { id: built.scope.id, name: built.scope.name } : null,
        tokens: built.tokens,
        siblings: built.siblings,
      };
    } catch (err) {
      logOnce('跨聊天记忆生成失败（本轮照常用本聊天的记忆）：' + ((err && err.message) || err));
    }
    return mem;
  };
  Store.prototype.__whalePatchWrapped = true;
}

function patchLinks(root) {
  const links = require('../src/adapters/links');
  if (links.__whalePatchWrapped) return;
  const originalDescribe = links.describeLink;
  const originalFormat = links.formatForPrompt;

  links.describeLink = async function describeLinkWithReader(url, opts = {}) {
    let cfg;
    try {
      cfg = configModule.load(root).config;
    } catch {
      return originalDescribe(url, opts);
    }
    // 鲸鲸本体也有一个 links.enabled（聊天里「能力 链接 关」改的就是它）。
    // 两个开关是「与」的关系：本体关掉时补丁不再抢着读。
    const appLinksEnabled = !(runtimeRef && runtimeRef.config && runtimeRef.config.links
      && runtimeRef.config.links.enabled === false);
    if (!cfg.enabled || !cfg.links.enabled || !appLinksEnabled) return originalDescribe(url, opts);
    try {
      const info = await reader.describe(url, {
        linksCfg: cfg.links,
        appConfig: runtimeRef ? runtimeRef.config : null,
        logger: runtimeRef ? runtimeRef.logger : null,
        root,
        timeoutMs: opts.timeoutMs || cfg.links.timeoutMs,
        cacheMinutes: opts.cacheMinutes,
        force: opts.force === true,
      });
      if (info && info.prompt) return info;
      if (info && info.ok) return info;
      // 补丁读失败就退回原版：至少它的标题/摘要偶尔还能用
      return await originalDescribe(url, opts);
    } catch (err) {
      logOnce('链接读取补丁失败，改用原版逻辑：' + ((err && err.message) || err));
      return originalDescribe(url, opts);
    }
  };

  links.formatForPrompt = function formatForPromptWithReader(info) {
    try {
      const text = reader.formatForPrompt(info);
      if (text) return text;
    } catch {
      /* fall through */
    }
    return originalFormat(info);
  };

  links.__whalePatchWrapped = true;
}

function registerRoutes(root) {
  const routes = require('../src/http/routes');
  if (routes.__whalePatchWrapped) return;
  const originalCreate = routes.createRouter;
  routes.createRouter = function createRouterWithPatch(runtime) {
    const router = originalCreate(runtime);
    try {
      require('./routes').register(router, runtime, { root });
    } catch (err) {
      logOnce('补丁管理接口注册失败（不影响聊天）：' + ((err && err.message) || err));
    }
    return router;
  };
  routes.__whalePatchWrapped = true;
}

function patchRuntime(root) {
  const app = require('../src/app');
  if (app.__whalePatchWrapped) return;
  const originalCreate = app.createRuntime;
  app.createRuntime = function createRuntimeWithPatch(opts = {}) {
    const runtime = originalCreate(opts);
    try {
      runtimeRef = runtime;
      if (!rootRef) {
        rootRef = opts && opts.root ? path.resolve(opts.root) : path.resolve(__dirname, '..');
      }
      const state = configModule.load(rootRef);
      if (state.error) {
        log('warn', `补丁配置 ${state.file} 解析失败（${state.error}），本次按默认值运行。`);
      }
      const browserInfo = browser.findBrowser(state.config.links);
      log('info', `🐋 补丁 ${versionInfo.version} 已加载：共享记忆${state.config.sharedMemory.enabled ? '开' : '关'}`
        + ` · 链接阅读${state.config.links.enabled ? '开' : '关'}`
        + ` · 无头浏览器${browserInfo ? '：' + browserInfo.name : '不可用'}`);
      try {
        const removed = browser.sweep(rootRef, 3);
        if (removed) log('info', `补丁清理了 ${removed} 个旧的浏览器临时目录`);
      } catch { /* ignore */ }
    } catch (err) {
      logOnce('补丁初始化失败（不影响鲸鲸本体）：' + ((err && err.message) || err));
    }
    return runtime;
  };
  app.__whalePatchWrapped = true;
}

/**
 * 安装补丁（幂等）。
 * @param {{root?:string}} opts
 */
function install(opts = {}) {
  if (installed || global[STATE_KEY]) return global[STATE_KEY] || null;
  const root = path.resolve(opts.root || path.resolve(__dirname, '..'));
  rootRef = root;

  let state;
  try {
    state = configModule.ensure(root);
  } catch {
    state = configModule.load(root);
  }
  if (!state.config.enabled) {
    installed = true;
    global[STATE_KEY] = { installed: true, disabled: true, version: versionInfo.version, root };
    return global[STATE_KEY];
  }

  try {
    patchStore(root);
    patchLinks(root);
    registerRoutes(root);
    patchRuntime(root);
  } catch (err) {
    // 任何一个包装点失败都不阻断服务器启动
    log('error', '补丁安装失败（鲸鲸会按原样运行）：' + ((err && err.stack) || err));
    installed = true;
    global[STATE_KEY] = { installed: false, error: (err && err.message) || String(err), version: versionInfo.version, root };
    return global[STATE_KEY];
  }

  installed = true;
  installInfo = {
    installed: true,
    version: versionInfo.version,
    name: versionInfo.name,
    target: versionInfo.target,
    root,
    configFile: state.file,
    installedAt: new Date().toISOString(),
  };
  global[STATE_KEY] = installInfo;
  return installInfo;
}

function getInfo() {
  return {
    ...(installInfo || {}),
    runtime: Boolean(runtimeRef),
    root: rootRef,
    version: versionInfo.version,
  };
}

function getRuntime() {
  return runtimeRef;
}

module.exports = {
  install,
  getInfo,
  getRuntime,
  versionInfo,
  config: configModule,
  reader,
  browser,
  shared,
  STATE_KEY,
};
