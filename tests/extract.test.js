'use strict';

/** HTML 正文抽取：标题、正文、评论、空壳 SPA 判断。 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PATCH = path.resolve(process.env.WHALE_APP_ROOT || path.resolve(__dirname, '..'), 'patch');
const extract = require(path.join(PATCH, 'link', 'extract.js'));

const HTML = `<!doctype html><html><head>
<title>测试文章 - 小黑盒</title>
<meta property="og:title" content="测试文章">
<meta property="og:description" content="这是摘要">
</head><body>
<nav>首页 社区 登录 关注</nav>
<div class="image-text__content">
  <p>第一段正文，讲的是艾尔登法环的女武神怎么打。</p>
  <p>第二段正文，建议用出血流，带上骨灰。</p>
</div>
<div>全部评论</div>
<div class="comment">Lv.12</div>
<div class="comment">2026-11-01</div>
<div class="comment">我也卡了三个晚上，最后洗点过了。</div>
<div>相关社区</div>
</body></html>`;

test('标题去掉站点后缀', () => {
  assert.equal(extract.titleOf(HTML), '测试文章');
});

test('正文从 image-text 标记开始，评论单独拆出来', () => {
  const text = extract.htmlToText(HTML);
  const parsed = extract.extractArticle(text);
  assert.equal(parsed.startMarked, true);
  assert.match(parsed.article, /第一段正文/);
  assert.match(parsed.article, /出血流/);
  assert.doesNotMatch(parsed.article, /我也卡了三个晚上/);
  assert.match(parsed.comments, /洗点过了/);
  assert.doesNotMatch(parsed.comments, /Lv\.12/);
  assert.doesNotMatch(parsed.comments, /2026-11-01/);
});

test('导航行被清掉', () => {
  const text = extract.htmlToText(HTML);
  assert.doesNotMatch(text, /^首页/m);
  assert.doesNotMatch(text, /小黑盒加速器/);
});

test('空壳 SPA 能被识别', () => {
  const shell = '<html><head><title>小黑盒</title></head><body><div id="app"></div><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></body></html>';
  assert.equal(extract.looksLikeSpa(shell, ''), true);
  assert.equal(extract.looksLikeSpa(HTML, extract.htmlToText(HTML)), false);
});

test('登录墙能被识别', () => {
  assert.equal(extract.isLoginWall('请先登录后查看'), true);
  assert.equal(extract.isLoginWall('这是一篇正常文章，内容很长。'.repeat(30)), false);
});

test('反爬 / 人机验证页能被识别', () => {
  assert.equal(extract.isBlockedPage('尝试太多次\n2s后自动为您刷新验证码'), true);
  assert.equal(extract.isBlockedPage('Just a moment... Checking your browser'), true);
  assert.equal(extract.isBlockedPage('这是一篇讲验证码原理的技术文章，长度超过阈值。'.repeat(80)), false);
});
