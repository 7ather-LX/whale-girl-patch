'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cc = require('../patch/cross-chat');

test('解析「在群名里发」', () => {
  const got = cc.parse('在「测试群」里发：今晚八点开会');
  assert.deepEqual(got, { target: '测试群', generic: false, message: '今晚八点开会' });
});

test('解析「给群名发一条」', () => {
  const got = cc.parse('帮我给『测试群』发一条：大家记得带伞');
  assert.deepEqual(got, { target: '测试群', generic: false, message: '大家记得带伞' });
});

test('没有目标群时不抢普通聊天', () => {
  assert.deepEqual(cc.parse('在群里发：大家好'), { target: '群里', generic: true, message: '大家好' });
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

test('同一群在聊天和联系人里的不同前缀只算一个', () => {
  const runtime = {
    store: { chatStore: { chats: new Map([
      ['wechat:g:123@chatroom', { chatId: 'wechat:g:123@chatroom', chatType: 'group', title: '奥林匹斯神人聚集地' }],
    ]) } },
    contacts: { items: [{ wxid: '123@chatroom', name: '奥林匹斯神人聚集地', isGroup: true }] },
  };
  const got = cc.resolveTarget(runtime, '奥林匹斯神人聚集地');
  assert.equal(got.chat.id, '123@chatroom');
  assert.equal(cc.resolveTarget(runtime, '群里', true).chat.id, '123@chatroom');
});

test('自然的「群里发」能解析，普通聊天不误触', () => {
  assert.equal(cc.parse('那你在群里发一个：最喜欢亲爱的了').message, '最喜欢亲爱的了');
  assert.equal(cc.parse('发到群里：大家好').target, '群里');
  assert.equal(cc.parse('发现了一个好玩的'), null);
});

