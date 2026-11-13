'use strict';

/** 链接安全策略：内网 / 账号密码 / 端口 / 黑白名单。 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PATCH = path.resolve(process.env.WHALE_APP_ROOT || path.resolve(__dirname, '..'), 'patch');
const policy = require(path.join(PATCH, 'link', 'policy.js'));

test('公网 https 放行', () => {
  const r = policy.checkUrl('https://www.bilibili.com/video/BV1GJ411x7h7', {});
  assert.equal(r.ok, true);
  assert.equal(r.host, 'www.bilibili.com');
});

test('本机 / 内网 / 元数据地址拒绝', () => {
  for (const url of [
    'http://127.0.0.1:8787/api/config',
    'http://localhost/',
    'http://192.168.1.1/',
    'http://10.0.0.8/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://0.0.0.0/',
  ]) {
    const r = policy.checkUrl(url, {});
    assert.equal(r.ok, false, url);
    assert.equal(r.error, 'private_host', url);
  }
});

test('带账号密码的 URL 拒绝（常见 SSRF 绕过）', () => {
  const r = policy.checkUrl('https://user:pass@example.com/', {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'credentials');
});

test('非 http(s) 与异常端口拒绝', () => {
  assert.equal(policy.checkUrl('file:///C:/Windows/win.ini', {}).error, 'bad_scheme');
  assert.equal(policy.checkUrl('javascript:alert(1)', {}).error, 'bad_scheme');
  assert.equal(policy.checkUrl('https://example.com:8080/', {}).error, 'bad_port');
});

test('白名单 / 黑名单 / 子域规则', () => {
  assert.equal(policy.checkUrl('https://bbs.example.com/x', { denyDomains: ['example.com'] }).error, 'denied_domain');
  assert.equal(policy.checkUrl('https://other.com/x', { allowDomains: ['example.com'] }).error, 'not_allowed');
  assert.equal(policy.checkUrl('https://www.example.com/x', { allowDomains: ['example.com'] }).ok, true);
});

test('matchDomain 只匹配子域时不吞根域', () => {
  assert.equal(policy.matchDomain('a.example.com', ['*.example.com']), true);
  assert.equal(policy.matchDomain('example.com', ['*.example.com']), false);
  assert.equal(policy.matchDomain('example.com', ['.example.com']), true);
  assert.equal(policy.matchDomain('notexample.com', ['example.com']), false);
});

test('allowPrivate + allowPorts 只给本地调试用', () => {
  const r = policy.checkUrl('http://127.0.0.1:5173/', {}, { allowPrivate: true, allowPorts: [5173] });
  assert.equal(r.ok, true);
});
