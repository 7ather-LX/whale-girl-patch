'use strict';

/**
 * 补丁专用的极简 HTTP 客户端（只用 Node 内置模块）。
 *
 * 和原版 links.fetchUrl 的区别：
 *   - 可以带自定义请求头（B 站 API 需要 Referer）；
 *   - 支持 JSON / 二进制（视频封面、故事板）；
 *   - 每一跳都重新过安全策略，并把 DNS 解析结果钉在请求上，防 DNS rebinding；
 *   - 默认不跟随到非 http(s)、带账号密码或内网地址。
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const policy = require('./policy');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeBody(buf, encoding, maxBytes) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (!enc || enc === 'identity') return buf;
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
    if (enc === 'deflate') return zlib.inflateSync(buf, { maxOutputLength: maxBytes });
    if (enc === 'br') return zlib.brotliDecompressSync(buf, { maxOutputLength: maxBytes });
  } catch {
    return null;
  }
  return buf;
}

function lookupPinned(address, family) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options && options.all) return callback(null, [{ address, family }]);
    return callback(null, address, family);
  };
}

/**
 * @returns {Promise<{ok:boolean,status?:number,headers?:object,buffer?:Buffer,text?:string,body?:string,
 *   finalUrl?:string,error?:string}>}
 */
function request(rawUrl, opts = {}) {
  const {
    timeoutMs = 12000,
    maxBytes = 1200000,
    maxRedirects = 4,
    method = 'GET',
    headers = {},
    cfg = {},
    allowPrivate = false,
    allowPorts = [],
  } = opts;

  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 12000);

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const hop = (url, left) => {
      if (Date.now() >= deadline) return done({ ok: false, error: 'timeout' });
      const checked = policy.checkUrl(url, cfg, { allowPrivate, allowPorts });
      if (!checked.ok) return done({ ok: false, error: checked.error });

      policy.resolveHost(checked.host, { allowPrivate }).then((resolved) => {
        if (settled) return;
        if (!resolved.ok) return done({ ok: false, error: resolved.error });
        if (Date.now() >= deadline) return done({ ok: false, error: 'timeout' });

        const isHttps = checked.protocol === 'https:';
        const transport = isHttps ? https : http;
        const reqHeaders = {
          'User-Agent': DEFAULT_UA,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
          ...headers,
        };
        const parsed = new URL(checked.url);
        const reqPath = parsed.pathname + parsed.search;
        const candidates = Array.isArray(resolved.addresses) && resolved.addresses.length
          ? resolved.addresses
          : [{ address: resolved.address, family: resolved.family }];

        const attempt = (index) => {
          if (settled) return;
          if (Date.now() >= deadline) return done({ ok: false, error: 'timeout' });
          const addr = candidates[index];
          if (!addr) return done({ ok: false, error: 'network' });
          const canRetry = index < candidates.length - 1;
          let req;
          try {
            req = transport.request(
              {
                protocol: checked.protocol,
                hostname: checked.host,
                port: checked.port,
                path: reqPath,
                method,
                headers: reqHeaders,
                servername: checked.host,
                lookup: lookupPinned(addr.address, addr.family),
              },
              (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location && left > 0) {
                  res.resume();
                  let next;
                  try {
                    next = new URL(res.headers.location, checked.url).toString();
                  } catch {
                    return done({ ok: false, error: 'bad_redirect', status });
                  }
                  return hop(next, left - 1);
                }
                const len = Number(res.headers['content-length'] || 0);
                if (len && len > maxBytes) {
                  res.destroy();
                  return done({ ok: false, error: 'too_large', status });
                }
                const chunks = [];
                let size = 0;
                res.on('data', (c) => {
                  size += c.length;
                  if (size > maxBytes) {
                    res.destroy();
                    done({ ok: false, error: 'too_large', status });
                    return;
                  }
                  chunks.push(c);
                });
                res.on('end', () => {
                  if (settled) return;
                  const raw = Buffer.concat(chunks);
                  const body = decodeBody(raw, res.headers['content-encoding'], maxBytes);
                  if (!body) return done({ ok: false, error: 'decode_error', status });
                  done({
                    ok: status >= 200 && status < 300,
                    status,
                    headers: res.headers,
                    buffer: body,
                    finalUrl: checked.url,
                    error: status >= 200 && status < 300 ? '' : `http_${status}`,
                  });
                });
                res.on('error', () => done({ ok: false, error: 'read_error', status }));
              }
            );
          } catch (err) {
            return done({ ok: false, error: (err && err.code) || 'request_error' });
          }

          let timedOut = false;
          req.setTimeout(Math.max(1000, Math.min(deadline - Date.now(), 8000)), () => {
            timedOut = true;
            req.destroy();
            // 某个 CDN 节点黑洞时换下一个地址再试；总预算不够才判超时
            if (canRetry && !settled && Date.now() < deadline - 800) attempt(index + 1);
            else done({ ok: false, error: 'timeout' });
          });
          req.on('error', (err) => {
            if (settled) return;
            const code = (err && err.code) || 'network';
            // 连接失败（IPv6 不可用、节点拒绝）快速换下一个地址
            if (canRetry && !timedOut) attempt(index + 1);
            else done({ ok: false, error: code });
          });
          req.end();
        };

        attempt(0);
      });
    };

    hop(String(rawUrl || ''), maxRedirects);
  });
}

async function text(url, opts = {}) {
  const r = await request(url, opts);
  if (!r.ok) return r;
  return { ...r, text: r.buffer.toString('utf8') };
}

async function json(url, opts = {}) {
  const r = await text(url, opts);
  if (!r.ok) return r;
  try {
    return { ...r, data: JSON.parse(r.text) };
  } catch {
    return { ...r, ok: false, error: 'bad_json' };
  }
}

async function image(url, opts = {}) {
  const r = await request(url, { ...opts, maxBytes: opts.maxBytes || 4 * 1024 * 1024 });
  if (!r.ok) return r;
  const type = String((r.headers && r.headers['content-type']) || '');
  if (type && !/^image\//i.test(type)) return { ...r, ok: false, error: 'not_image' };
  return { ...r, base64: r.buffer.toString('base64'), mime: type.split(';')[0] || 'image/jpeg' };
}

module.exports = { request, text, json, image, DEFAULT_UA };
