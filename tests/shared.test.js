'use strict';

/**
 * 跨聊天记忆：只读拼装、作用域、预算、隐私开关。
 * 用假 store，不碰真实记忆文件。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PATCH = path.resolve(process.env.WHALE_APP_ROOT || path.resolve(__dirname, '..'), 'patch');
const shared = require(path.join(PATCH, 'shared-memory.js'));

function fakeChat(id, { type = 'group', title = '', messages = [], summary = '' } = {}) {
  return {
    chatId: id,
    chatType: type,
    title,
    lastActiveAt: Date.now(),
    messages,
    summary: summary ? { text: summary, tokens: 10, coveredThroughSeq: 1 } : null,
    people: new Map(),
  };
}

function fakeStore(chats) {
  return { chatStore: { chats: new Map(chats.map((c) => [c.chatId, c])) } };
}

const NOW = Date.now();

test('不在共享组的聊天完全不生成块', () => {
  const store = fakeStore([
    fakeChat('wechat:g:a@chatroom', { title: 'A 群', summary: 'A 群在聊游戏' }),
    fakeChat('wechat:g:b@chatroom', { title: 'B 群', summary: 'B 群在聊吃饭' }),
  ]);
  const out = shared.build(store, {
    key: 'wechat:g:a@chatroom',
    sharedConfig: { enabled: true, scopes: [{ id: 'x', name: 'X', enabled: true, chats: ['wechat:g:c@chatroom'] }] },
  });
  assert.equal(out.block, '');
  assert.equal(out.siblings, 0);
});

test('摘要 + 相关原话都能带进来，且不包含当前聊天', () => {
  const store = fakeStore([
    fakeChat('wechat:g:a@chatroom', {
      title: '游戏群',
      messages: [{ role: 'user', name: '小明', text: '女武神用出血流好打', ts: NOW }],
      summary: '群里在聊艾尔登法环',
    }),
    fakeChat('wechat:u:wxid_b', {
      type: 'private', title: '小红',
      messages: [
        { role: 'user', name: '小红', text: '女武神真的好难，卡了三个晚上', ts: NOW - 1000 },
        { role: 'assistant', name: '鲸鲸', text: '要不要试试出血流', ts: NOW - 500 },
      ],
    }),
  ]);
  const out = shared.build(store, {
    key: 'wechat:u:wxid_b',
    query: '女武神怎么打',
    sharedConfig: { enabled: true, maxSiblings: 4, maxRecentLines: 6, maxTokens: 500, scopes: [{ id: 'x', name: '测试组', enabled: true, mode: 'both', chats: ['wechat:g:a@chatroom', 'wechat:u:wxid_b'] }] },
  });
  assert.ok(out.block.includes('游戏群'));
  assert.ok(out.block.includes('艾尔登法环'));
  assert.ok(!out.block.includes('卡了三个晚上'), 'current chat should not be quoted');
  assert.ok(out.tokens > 0 && out.tokens <= 500);
});

test('mode=summary 时不带原话，也不引用当前聊天', () => {
  const store = fakeStore([
    fakeChat('g1', { title: '一群', summary: '当前聊天摘要', messages: [{ role: 'user', name: '甲', text: '原话内容', ts: NOW }] }),
    fakeChat('g2', { title: '二群', summary: '二群摘要', messages: [{ role: 'user', name: '乙', text: '另一句', ts: NOW }] }),
  ]);
  const out = shared.build(store, {
    key: 'g1',
    sharedConfig: { enabled: true, scopes: [{ id: 's', name: 'S', mode: 'summary', chats: ['g1', 'g2'] }] },
  });
  assert.ok(out.block.includes('二群摘要'));
  assert.ok(!out.block.includes('另一句'));
  assert.ok(!out.block.includes('当前聊天摘要'));
});

test('token 预算生效', () => {
  const long = '这是一段很长很长的记忆内容，用来把预算顶满。'.repeat(20);
  const chats = [fakeChat('g1', { title: '目标群' })];
  for (let i = 2; i <= 6; i += 1) {
    chats.push(fakeChat(`g${i}`, { title: `群${i}`, summary: long }));
  }
  const out = shared.build(fakeStore(chats), {
    key: 'g1',
    sharedConfig: { enabled: true, maxTokens: 180, maxSiblings: 6, scopes: [{ id: 's', name: 'S', mode: 'summary', chats: chats.map((c) => c.chatId) }] },
  });
  assert.ok(out.tokens <= 220, `tokens=${out.tokens}`);
});

test('文件传输助手不会被当成共享对象', () => {
  const store = fakeStore([
    fakeChat('filehelper', { type: 'private', title: '文件传输助手', summary: '文件助手摘要' }),
    fakeChat('wechat:g:a@chatroom', { title: 'A 群' }),
  ]);
  const out = shared.build(store, {
    key: 'wechat:g:a@chatroom',
    sharedConfig: { enabled: true, scopes: [{ id: 's', name: 'S', mode: 'summary', chats: ['*'] }] },
  });
  assert.equal(out.block, '');
});

test('match=group 自动共享所有群聊，私聊不读也不进共享组', () => {
  const store = fakeStore([
    fakeChat('g1', { title: '群一', summary: '群一摘要', messages: [{ role: 'user', name: '甲', text: '群一的话', ts: NOW }] }),
    fakeChat('g2', { title: '群二', summary: '群二摘要', messages: [{ role: 'user', name: '乙', text: '群二的话', ts: NOW }] }),
    fakeChat('p1', { type: 'private', title: '私聊', summary: '私聊摘要', messages: [{ role: 'user', name: '丙', text: '私聊的话', ts: NOW }] }),
  ]);
  const cfg = {
    enabled: true,
    maxSiblings: 4,
    maxRecentLines: 6,
    maxTokens: 400,
    scopes: [{ id: 'g', name: '群聊', match: 'group', enabled: true, mode: 'summary', chats: ['*'] }],
  };
  const inGroup = shared.build(store, { key: 'g1', sharedConfig: cfg });
  assert.ok(inGroup.block.includes('群二摘要'));
  assert.ok(!inGroup.block.includes('私聊摘要'));

  const inPrivate = shared.build(store, { key: 'p1', sharedConfig: cfg });
  assert.equal(inPrivate.block, '');
});

test('原版隔离声明会被替换成共享语境', () => {
  const format = require(path.join(process.env.WHALE_APP_ROOT || path.resolve(__dirname, '..'), 'src', 'memory', 'format.js'));
  const text = `人物卡\n${format.MEMORY_SCOPE_NOTICE}`;
  const out = shared.patchScopeNotice(text);
  assert.ok(!out.includes(format.MEMORY_SCOPE_NOTICE));
  assert.ok(out.includes('允许共享'));
});
