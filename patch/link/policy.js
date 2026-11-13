'use strict';

/**
 * 链接安全策略：在真正发请求之前先把 URL 过一遍。
 *
 * 补丁会替用户「点开」群友发的链接，所以这里比原版的 links.js 更严一点：
 *   - 只允许 http / https，且默认只允许 80 / 443；
 *   - 带账号密码的 URL 一律拒绝（http://user:pass@host/ 常被拿来做钓鱼/绕 SSRF 检查）；
 *   - 本机 / 内网 / 链路本地 / CGNAT / 云元数据地址一律拒绝；
 *   - 支持白名单（只读这些站）和黑名单（永不打开）。
 *
 * 这里不依赖 src/ 下的模块，方便单测；运行时优先复用鲸鲸自己的 isPrivateHost。
 */

const dns = require('node:dns');

let coreLinks = null;
function core() {
  if (coreLinks === null) {
    try {
      coreLinks = require('../../src/adapters/links');
    } catch {
      coreLinks = false;
    }
  }
  return coreLinks || null;
}

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** 自己维护一份兜底判断：src/adapters/links 不存在时（单测/独立使用）也能工作 */
function isPrivateHostFallback(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true;
  // IPv4-mapped IPv6：::ffff:127.0.0.1
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4 = mapped ? mapped[1] : (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : '');
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // 组播 / 保留
    return false;
  }
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  return false;
}

function isPrivateHost(hostname) {
  const helper = core();
  if (helper && typeof helper.isPrivateHost === 'function') return helper.isPrivateHost(hostname);
  return isPrivateHostFallback(hostname);
}

/**
 * 域名规则匹配：
 *   example.com        → example.com 和任何子域
 *   .example.com       → 同上（写起来更直观）
 *   *.example.com      → 只匹配子域
 *   sub.example.com    → 只匹配它自己
 */
function matchDomain(hostname, patterns) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  for (const raw of patterns || []) {
    let p = String(raw || '').trim().toLowerCase();
    if (!p) continue;
    const onlySub = p.startsWith('*.');
    p = p.replace(/^\*\./, '').replace(/^\./, '');
    if (!p) continue;
    if (onlySub) {
      if (host.endsWith('.' + p)) return true;
    } else if (host === p || host.endsWith('.' + p)) {
      return true;
    }
  }
  return false;
}

function checkUrl(raw, cfg = {}, options = {}) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) return { ok: false, error: 'empty' };
  if (input.length > 2000) return { ok: false, error: 'too_long' };

  let u;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: 'bad_url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'bad_scheme' };
  if (u.username || u.password) return { ok: false, error: 'credentials' };

  const host = normalizeHost(u.hostname);
  if (!host) return { ok: false, error: 'bad_host' };
  if (isPrivateHost(host) && !options.allowPrivate) return { ok: false, error: 'private_host' };

  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  const allowPorts = Array.isArray(options.allowPorts) ? options.allowPorts.map(Number) : [];
  const defaultPorts = [80, 443];
  if (!defaultPorts.includes(port) && !allowPorts.includes(port) && !options.allowPrivate) {
    return { ok: false, error: 'bad_port' };
  }

  if (matchDomain(host, cfg.denyDomains)) return { ok: false, error: 'denied_domain' };
  if (Array.isArray(cfg.allowDomains) && cfg.allowDomains.length && !matchDomain(host, cfg.allowDomains)) {
    return { ok: false, error: 'not_allowed' };
  }

  return { ok: true, url: u.toString(), host, port, protocol: u.protocol };
}

/**
 * DNS 检查 + 选一个公网地址。
 * 这样「域名解析到内网」的绕过也会被挡住；请求时再把解析结果钉死（防 DNS rebinding）。
 */
async function resolveHost(hostname, options = {}) {
  if (options.allowPrivate) {
    try {
      const r = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      const list = r.length ? r : [];
      const first = list[0] || { address: hostname, family: 4 };
      return { ok: true, address: first.address, family: first.family, addresses: list };
    } catch (err) {
      return { ok: false, error: (err && err.code) || 'dns_error' };
    }
  }
  let list = [];
  try {
    list = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'dns_error' };
  }
  if (!list.length) return { ok: false, error: 'dns_empty' };
  for (const item of list) {
    if (isPrivateHost(item.address)) return { ok: false, error: 'private_host' };
  }
  // 保留系统解析顺序（通常 IPv6 优先）。有些 CDN 的某个 IPv4 会黑洞，
  // http.js 会按这个列表逐个重试，而不是死磕第一个地址。
  const addresses = list.slice(0, 4);
  const prefer = addresses[0];
  return { ok: true, address: prefer.address, family: prefer.family, addresses };
}

module.exports = {
  checkUrl,
  resolveHost,
  matchDomain,
  isPrivateHost,
  isPrivateHostFallback,
  normalizeHost,
};
