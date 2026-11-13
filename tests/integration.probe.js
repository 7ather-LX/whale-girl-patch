'use strict';

/**
 * 集成探针（不参与 npm test）：在临时复制的鲸鲸目录里验证补丁。
 * 用法：node tests/integration.probe.js <appRoot>
 */

const path = require('node:path');
const http = require('node:http');

const appRoot = path.resolve(process.argv[2] || '');
if (!appRoot) {
  console.error('usage: node integration.probe.js <appRoot>');
  process.exit(2);
}

function req(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function assert(cond, label, extra) {
  if (cond) {
    console.log('  PASS', label);
    return true;
  }
  console.log('  FAIL', label, extra == null ? '' : extra);
  process.exitCode = 1;
  return false;
}

(async () => {
  const patch = require(path.join(appRoot, 'patch', 'index.js'));
  const info = patch.install({ root: appRoot });
  console.log('install:', JSON.stringify(info));
  const configModule = require(path.join(appRoot, 'patch', 'config.js'));
  const { startServer } = require(path.join(appRoot, 'server.js'));

  const cfg = configModule.load(appRoot).config;
  cfg.sharedMemory.enabled = true;
  cfg.sharedMemory.maxTokens = 500;
  cfg.sharedMemory.scopes = [{
    id: 'test-group',
    name: '测试共享组',
    mode: 'both',
    enabled: true,
    sharePeople: true,
    chats: ['wechat:g:111@chatroom', 'wechat:u:wxid_b'],
  }];
  configModule.save(appRoot, cfg);

  const instance = await startServer({
    root: appRoot,
    port: 0,
    env: { ...process.env, WHALE_LOG_FILE: '' },
  });
  const { runtime, port } = instance;
  runtime.config.websearch.enabled = false;
  console.log('server:', instance.url);

  const store = runtime.store;
  const now = Date.now();
  const groupKey = 'wechat:g:111@chatroom';
  const privateKey = 'wechat:u:wxid_b';
  store.ensureSession(groupKey, { platform: 'wechat', chatType: 'group', title: '游戏群' });
  store.appendMessage(groupKey, {
    role: 'user', uid: 'wxid_m', name: '小明',
    text: '我最近在玩艾尔登法环，已经打到女武神了', ts: now - 120000, msgId: 'g1',
  });
  store.setSummary(groupKey, '游戏群最近在聊艾尔登法环，小明说他已经打到女武神。', { upto: 1 });
  store.ensureSession(privateKey, { platform: 'wechat', chatType: 'private', title: '小红' });
  store.appendMessage(privateKey, {
    role: 'user', uid: 'wxid_h', name: '小红',
    text: '艾尔登法环那个女武神真的好难，卡了三个晚上', ts: now - 60000, msgId: 'p1',
  });

  console.log('\n[1] preview-shared');
  const preview = await req(port, 'POST', '/api/patch/preview-shared', { key: groupKey, query: '女武神怎么打' });
  console.log(JSON.stringify(preview.data).slice(0, 1200));
  assert(preview.status === 200 && preview.data.ok, 'preview http ok');
  assert(preview.data.block && preview.data.block.includes('小红'), 'shared block mentions sibling chat/user');
  assert(preview.data.tokens > 0 && preview.data.tokens <= 500, 'shared block within token budget');

  const previewPrivate = await req(port, 'POST', '/api/patch/preview-shared', { key: privateKey, query: '上次那个游戏' });
  assert(Boolean(previewPrivate.data.block && previewPrivate.data.block.includes('游戏群')), 'private chat sees group summary');

  console.log('\n[2] Store.buildContext injection');
  const mem = store.buildContext({ key: privateKey, uid: 'wxid_h', name: '小红', query: '女武神怎么打' });
  assert(typeof mem.block === 'string' && mem.block.includes('跨聊天记忆'), 'mem.block contains shared block');
  assert(mem.block.includes('游戏群'), 'mem.block sees group memory');
  assert(!mem.block.includes('只来自当前这个聊天'), 'old isolation notice replaced');
  assert(mem.sharedMemory && mem.sharedMemory.scope.id === 'test-group', 'sharedMemory meta attached');

  console.log('\n[3] bot.handle works with patch');
  const result = await runtime.bot.handle({
    platform: 'wechat',
    chatId: privateKey,
    chatType: 'private',
    senderId: 'wxid_h',
    senderName: '小红',
    text: '你还记得我上次说的那个游戏吗？',
    msgId: 'p2-' + Date.now(),
    ts: now,
  });
  console.log('  action=', result && result.action, 'reason=', result && result.reason);
  assert(Boolean(result && result.action), 'bot.handle returns a decision');

  console.log('\n[4] status endpoint');
  const status = await req(port, 'GET', '/api/patch/status');
  assert(status.status === 200 && status.data.ok, 'status ok');
  assert(status.data.chats.length >= 2, 'status lists chats');
  assert(status.data.diagnostics.browser && status.data.diagnostics.browser.name, 'browser detected');

  console.log('\n[5] patch page');
  const page = await req(port, 'GET', '/patch/');
  assert(page.status === 200 && typeof page.data === 'string' && page.data.includes('鲸鲸补丁'), 'admin page served');

  console.log('\n[6] bilibili link read');
  const link = await req(port, 'POST', '/api/patch/test-link', { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' });
  console.log('  ms=', link.data && link.data.ms, 'ok=', link.data && link.data.ok);
  assert(link.status === 200 && link.data.ok, 'bilibili link ok');
  assert(String(link.data.prompt || '').includes('Never Gonna Give You Up'), 'bilibili title in prompt');

  console.log('\n[7] blocked private link');
  const blocked = await req(port, 'POST', '/api/patch/test-link', { url: 'http://127.0.0.1:8787/api/config' });
  assert(blocked.status === 200 && blocked.data.ok === false, 'private host blocked');
  console.log('  error=', blocked.data.info && blocked.data.info.error);

  console.log('\n[7.1] xiaoheihe SPA via headless browser');
  const xhh = await req(port, 'POST', '/api/patch/test-link', {
    url: 'https://xiaoheihe.cn/app/bbs/link/a00670cf1375?h_camp=link&h_src=YXBwX3NoYXJl',
  });
  console.log('  ms=', xhh.data && xhh.data.ms, 'ok=', xhh.data && xhh.data.ok, 'title=', xhh.data && xhh.data.info && xhh.data.info.title);
  assert(xhh.status === 200 && xhh.data.ok, 'xiaoheihe rendered');
  assert(String(xhh.data.prompt || '').length > 300, 'xiaoheihe has article text');

  console.log('\n[8] api/chat with bridge token');
  const chat = await req(port, 'POST', '/api/chat', {
    sessionId: 'integration',
    mode: 'private',
    senderName: '小红',
    text: '在吗',
  }, { 'x-bot-token': String(runtime.config.gateway.wechat.inboundToken) });
  console.log('  status=', chat.status, 'body=', JSON.stringify(chat.data).slice(0, 200));
  assert(chat.status === 200, 'api/chat accepted');

  await instance.close();
  console.log('\nDONE', process.exitCode ? 'WITH FAILURES' : 'ALL PASS');
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error('PROBE ERROR', err && err.stack || err);
  process.exit(1);
});
