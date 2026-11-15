'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cc = require('../patch/cross-chat');

test('解析「在群名里发」', () => {
  const got = cc.parse('在「测试群」里发：今晚八点开会');
  assert.deepEqual(got, { target: '测试群', message: '今晚八点开会' });
});

test('解析「给群名发一条」', () => {
  const got = cc.parse('帮我给『测试群』发一条：大家记得带伞');
  assert.deepEqual(got, { target: '测试群', message: '大家记得带伞' });
});

test('没有目标群时不抢普通聊天', () => {
  assert.equal(cc.parse('在群里发：大家好'), null);
  assert.equal(cc.parse('今天吃什么'), null);
});

test('按群名找目标，重名时提示', () => {
  const runtime = {
    store: { chatStore: { chats: new Map([
      ['a@chatroom', { chatId: 'a@chatroom', chatType: 'group', title: '测试群' }],
      ['b@chatroom', { chatId: 'b@chatroom', chatType: 'group', title: '测试群2' }],
    ]) } },
    contacts: { items: [] },
  };
  assert.equal(cc.resolveTarget(runtime, '测试群').chat.id, 'a@chatroom');
  assert.match(cc.resolveTarget(runtime, '测试').error, /多个群/);
});
