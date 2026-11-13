'use strict';

/** 补丁配置的归一化 / 保存 / 共享组查找（不读真实记忆，不联网）。 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PATCH = path.resolve(process.env.WHALE_APP_ROOT || path.resolve(__dirname, '..'), 'patch');
const config = require(path.join(PATCH, 'config.js'));

test('默认值完整且共享记忆默认关闭', () => {
  const cfg = config.normalize({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.sharedMemory.enabled, false);
  assert.deepEqual(cfg.sharedMemory.scopes, []);
  assert.equal(cfg.links.enabled, true);
  assert.ok(Array.isArray(cfg.links.browserDomains));
});

test('数字/布尔值被夹在合理范围', () => {
  const cfg = config.normalize({
    sharedMemory: { maxTokens: 1, maxSiblings: 999, maxRecentLines: -3 },
    links: { timeoutMs: 1, maxBytes: 999999999, maxVisionImages: 99, videoVision: 'false' },
  });
  assert.equal(cfg.sharedMemory.maxTokens, 80);
  assert.equal(cfg.sharedMemory.maxSiblings, 12);
  assert.equal(cfg.sharedMemory.maxRecentLines, 0);
  assert.equal(cfg.links.timeoutMs, 3000);
  assert.equal(cfg.links.maxBytes, 3 * 1024 * 1024);
  assert.equal(cfg.links.maxVisionImages, 5);
  assert.equal(cfg.links.videoVision, false);
});

test('重复的共享组 id 会自动加后缀，避免互相覆盖', () => {
  const cfg = config.normalize({
    sharedMemory: {
      scopes: [
        { id: 'same', name: 'A', chats: ['k1'] },
        { id: 'same', name: 'B', chats: ['k2'] },
        { name: 'C', chats: ['*'] },
      ],
    },
  });
  const ids = cfg.sharedMemory.scopes.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(cfg.sharedMemory.scopes[0].id, 'same');
  assert.equal(cfg.sharedMemory.scopes[1].id, 'same-2');
});

test('域名清洗：URL、端口、通配前缀都归一', () => {
  assert.equal(config.cleanDomain('HTTPS://Example.com:443/path'), 'example.com');
  assert.equal(config.cleanDomain('*.example.com'), 'example.com');
  assert.equal(config.cleanDomain('.example.com'), 'example.com');
  assert.equal(config.cleanDomain('bad domain'), '');
  assert.deepEqual(config.cleanDomainList(['a.com', 'a.com', 'https://b.com/x']), ['a.com', 'b.com']);
});

test('scopeFor 优先返回启用且在列表里的共享组', () => {
  const cfg = config.normalize({
    sharedMemory: {
      enabled: true,
      scopes: [
        { id: 'off', name: '关掉的', enabled: false, chats: ['k1'] },
        { id: 'on', name: '开着的', chats: ['k1', 'k2'] },
        { id: 'all', name: '全部', chats: ['*'] },
      ],
    },
  });
  assert.equal(config.scopeFor(cfg, 'k1').id, 'on');
  assert.equal(config.scopeFor(cfg, 'k3').id, 'all');
});

test('match=group/private 自动按类型匹配，不依赖聊天列表', () => {
  const cfg = config.normalize({
    sharedMemory: {
      enabled: true,
      scopes: [
        { id: 'groups', name: '群聊', match: 'group', chats: ['ignored'] },
        { id: 'privs', name: '私聊', match: 'private', enabled: true, chats: [] },
      ],
    },
  });
  assert.equal(cfg.sharedMemory.scopes[0].match, 'group');
  assert.deepEqual(cfg.sharedMemory.scopes[0].chats, ['*']);
  assert.equal(config.scopeFor(cfg, 'any-group', 'group').id, 'groups');
  assert.equal(config.scopeFor(cfg, 'any-private', 'private').id, 'privs');
  assert.equal(config.scopeFor(cfg, 'unknown', ''), null);
});

test('保存到临时目录再读回，值一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-patch-config-'));
  try {
    const saved = config.save(dir, {
      enabled: true,
      sharedMemory: { enabled: true, scopes: [{ id: 'x', name: 'X', mode: 'summary', chats: ['k'] }] },
      links: { browser: 'off', denyDomains: ['bad.example'] },
    });
    const loaded = config.load(dir);
    assert.equal(loaded.error, '');
    assert.equal(loaded.config.sharedMemory.scopes[0].name, 'X');
    assert.equal(loaded.config.links.browser, 'off');
    assert.deepEqual(loaded.config.links.denyDomains, ['bad.example']);
    assert.equal(saved.file, path.join(dir, 'data', 'whale-patch.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
