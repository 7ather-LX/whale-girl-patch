'use strict';

/** B 站链接解析与提示词（不联网）。 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PATCH = path.resolve(process.env.WHALE_APP_ROOT || path.resolve(__dirname, '..'), 'patch');
const bilibili = require(path.join(PATCH, 'link', 'bilibili.js'));
const reader = require(path.join(PATCH, 'link', 'reader.js'));

test('识别 B 站域名', () => {
  assert.equal(bilibili.isBilibiliHost('www.bilibili.com'), true);
  assert.equal(bilibili.isBilibiliHost('b23.tv'), true);
  assert.equal(bilibili.isBilibiliHost('evil-bilibili.com'), false);
});

test('解析 BV / av / 分 P', () => {
  assert.deepEqual(bilibili.parseRef('https://www.bilibili.com/video/BV1GJ411x7h7'), { bvid: 'BV1GJ411x7h7', aid: 0, page: 1 });
  assert.deepEqual(bilibili.parseRef('https://m.bilibili.com/video/av80433022?p=2'), { bvid: '', aid: 80433022, page: 2 });
  assert.equal(bilibili.parseRef('https://www.bilibili.com/'), null);
});

test('时长/播放量格式', () => {
  assert.equal(bilibili.durationText(213), '3:33');
  assert.equal(bilibili.durationText(3725), '1:02:05');
  assert.equal(bilibili.shortNumber(108446524), '1.1亿');
  assert.equal(bilibili.shortNumber(152000), '15.2万');
});

test('提示词包含视频画面说明与免责声明', () => {
  const prompt = bilibili.buildPrompt({
    title: '测试视频',
    author: 'UP 主',
    duration: 100,
    statsText: '播放 1 万',
    description: '简介',
    tags: ['游戏'],
    comments: ['好看'],
    visual: ['封面：一个人在打游戏', '视频画面 1：雨夜街道'],
  });
  assert.match(prompt, /测试视频/);
  assert.match(prompt, /视频画面 1/);
  assert.match(prompt, /没有完整看完/);
});

test('小黑盒分享 query 里的 redirect_data 能兜底', () => {
  const data = encodeURIComponent(JSON.stringify({ link: { title: '帖子标题', description: '帖子简介' } }));
  const info = reader.redirectData(`https://xiaoheihe.cn/app/bbs/link/abc?redirect_data=${data}`);
  assert.equal(info.title, '帖子标题');
  assert.equal(info.description, '帖子简介');
});
