'use strict';

/**
 * 补丁的管理页 + 本机 API。
 *
 * 页面地址：http://127.0.0.1:<鲸鲸端口>/patch/
 * 只允许本机访问；写操作走 JSON + 同源检查（由鲸鲸的 security 闸兜底）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { json, readBody } = require('../src/http/util');
const { isLoopbackRequest } = require('../src/http/security');
const configModule = require('./config');
const shared = require('./shared-memory');
const reader = require('./link/reader');
const browser = require('./link/browser');
const versionInfo = require('./version');

const STATIC = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
};

function loopbackOnly(req, res) {
  if (isLoopbackRequest(req)) return false;
  json(res, 403, { ok: false, error: '补丁管理页只允许在本机打开' });
  return true;
}

function chatList(runtime) {
  const chats = [];
  const store = runtime && runtime.store;
  const map = store && store.chatStore && store.chatStore.chats;
  if (!map) return chats;
  for (const chat of map.values()) {
    if (!chat) continue;
    const title = String(chat.title || '').trim();
    chats.push({
      key: chat.chatId,
      title: title || (chat.chatType === 'group' ? '（未命名群聊）' : '（私聊）'),
      hasTitle: Boolean(title),
      chatType: chat.chatType,
      platform: chat.platform,
      messages: Array.isArray(chat.messages) ? chat.messages.length : 0,
      people: chat.people ? chat.people.size : 0,
      lastActiveAt: Number(chat.lastActiveAt) || 0,
      summary: Boolean(chat.summary && chat.summary.text),
    });
  }
  chats.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return chats.slice(0, 200);
}

function diagnostics(runtime, cfg, root) {
  let vision = { configured: false, model: '' };
  try {
    const mod = require('../src/adapters/vision');
    const st = mod.status(runtime.config);
    vision = { configured: Boolean(st && st.configured), model: (st && st.model) || '' };
  } catch { /* ignore */ }
  let python = false;
  try {
    python = fs.existsSync(path.join(root, 'runtime', 'python', 'python.exe'));
  } catch { /* ignore */ }
  return {
    browser: browser.findBrowser(cfg.links),
    vision,
    python,
    chats: (runtime.store && runtime.store.chatStore && runtime.store.chatStore.chats.size) || 0,
  };
}

function sanitizeLink(info) {
  if (!info || typeof info !== 'object') return info;
  const out = { ...info };
  delete out.frameDir;
  delete out.images;
  delete out.cover;
  delete out.stats;
  return out;
}

function register(router, runtime, ctx) {
  const root = (ctx && ctx.root) || runtime.config.root || path.resolve(__dirname, '..');

  router.get('/patch', (rt, req, res) => {
    res.writeHead(302, { Location: '/patch/' });
    res.end();
  });

  router.get('/patch/', (rt, req, res) => {
    if (loopbackOnly(req, res)) return;
    try {
      const html = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8');
      res.writeHead(200, {
        'Content-Type': STATIC['index.html'],
        'Cache-Control': 'no-store',
      });
      res.end(html);
    } catch {
      json(res, 500, { ok: false, error: '补丁页面文件缺失，请重新安装补丁' });
    }
  });

  for (const name of ['app.js', 'style.css']) {
    router.get(`/patch/${name}`, (rt, req, res) => {
      if (loopbackOnly(req, res)) return;
      try {
        const body = fs.readFileSync(path.join(__dirname, 'web', name));
        res.writeHead(200, {
          'Content-Type': STATIC[name],
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch {
        json(res, 404, { ok: false, error: 'not found' });
      }
    });
  }

  router.get('/api/patch/status', (rt, req, res) => {
    if (loopbackOnly(req, res)) return;
    const state = configModule.load(root);
    const cfg = state.config;
    const chats = chatList(rt);
    const scopeOf = {};
    for (const scope of cfg.sharedMemory.scopes) {
      for (const key of scope.chats) scopeOf[key] = scope.id;
    }
    return json(res, 200, {
      ok: true,
      patch: { ...versionInfo, configFile: state.file, configError: state.error },
      config: cfg,
      diagnostics: diagnostics(rt, cfg, root),
      chats: chats.map((c) => ({ ...c, scopeId: scopeOf[c.key] || '' })),
    });
  });

  router.get('/api/patch/config', (rt, req, res) => {
    if (loopbackOnly(req, res)) return;
    const state = configModule.load(root);
    return json(res, 200, {
      ok: true,
      config: state.config,
      file: state.file,
      error: state.error,
    });
  });

  router.post('/api/patch/config', async (rt, req, res) => {
    if (loopbackOnly(req, res)) return;
    const body = await readBody(req);
    try {
      const partial = {};
      if (body && typeof body.enabled === 'boolean') partial.enabled = body.enabled;
      if (body && body.sharedMemory && typeof body.sharedMemory === 'object') partial.sharedMemory = body.sharedMemory;
      if (body && body.links && typeof body.links === 'object') partial.links = body.links;
      if (!Object.keys(partial).length) return json(res, 400, { ok: false, error: '没有要保存的内容' });
      const state = configModule.patch(root, partial);
      reader.clearCache();
      rt.logger && rt.logger.info('补丁配置已更新：' + state.file);
      return json(res, 200, { ok: true, config: state.config, file: state.file });
    } catch (err) {
      return json(res, 400, { ok: false, error: (err && err.message) || String(err) });
    }
  });

  router.post('/api/patch/test-link', async (rt, req, res) => {
    if (loopbackOnly(req, res)) return;
    const body = await readBody(req);
    const url = String((body && body.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return json(res, 400, { ok: false, error: '请填一个 http(s) 链接' });
    const cfg = configModule.load(root).config;
    const started = Date.now();
    let info;
    try {
      info = await reader.describe(url, {
        linksCfg: cfg.links,
        appConfig: rt.config,
        logger: rt.logger,
        root,
        force: true,
        timeoutMs: cfg.links.timeoutMs,
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err && err.message) || String(err) });
    }
    return json(res, 200, {
      ok: Boolean(info && info.ok),
      ms: Date.now() - started,
      info: sanitizeLink(info),
      prompt: String((info && info.prompt) || '').slice(0, 2000),
    });
  });

  router.post('/api/patch/preview-shared', async (rt, req, res) => {
    if (loopbackOnly(req, res)) return;
    const body = await readBody(req);
    const key = String((body && body.key) || '').trim();
    if (!key) return json(res, 400, { ok: false, error: '请选择一个聊天' });
    const cfg = configModule.load(root).config;
    if (!cfg.sharedMemory.enabled) return json(res, 200, { ok: true, enabled: false, block: '', tokens: 0 });
    let built;
    try {
      built = shared.build(rt.store, {
        key,
        query: String((body && body.query) || ''),
        uid: String((body && body.uid) || ''),
        name: String((body && body.name) || ''),
        sharedConfig: cfg.sharedMemory,
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err && err.message) || String(err) });
    }
    return json(res, 200, {
      ok: true,
      enabled: true,
      block: built.block,
      tokens: built.tokens,
      siblings: built.siblings,
      scope: built.scope ? { id: built.scope.id, name: built.scope.name, mode: built.scope.mode } : null,
    });
  });

  router.post('/api/patch/clear-cache', (rt, req, res) => {
    if (loopbackOnly(req, res)) return;
    reader.clearCache();
    return json(res, 200, { ok: true });
  });
}

module.exports = { register };
