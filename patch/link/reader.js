'use strict';

/**
 * 链接读取总入口：把「群友发的一条链接」变成模型能理解的一段文字。
 *
 * 顺序：
 *   1) 安全策略（协议 / 端口 / 内网 / 黑白名单）
 *   2) 站点适配器（B 站走公开接口，最快也最准）
 *   3) 普通网页：直接抓 HTML → 抽标题 / 正文 / 评论
 *   4) 抓到的是空壳 SPA（小黑盒、微博…）→ 无头 Edge/Chrome 渲染一次
 *   5) 有看图模型且开关打开 → 把封面 / 视频故事板交给看图模型，补一句「看到了什么」
 *
 * 失败永远返回对象，不抛异常：链接读不到不该让整条回复消失。
 */

const fs = require('node:fs');
const policy = require('./policy');
const httpc = require('./http');
const extract = require('./extract');
const bilibili = require('./bilibili');
const browser = require('./browser');

let coreLinks = null;
function core() {
  if (coreLinks === null) {
    try { coreLinks = require('../../src/adapters/links'); } catch { coreLinks = false; }
  }
  return coreLinks || null;
}

let coreVision = null;
function visionModule() {
  if (coreVision === null) {
    try { coreVision = require('../../src/adapters/vision'); } catch { coreVision = false; }
  }
  return coreVision || null;
}

const cache = new Map();
const CACHE_MAX = 120;

function cacheGet(key, ttlMin) {
  const hit = cache.get(key);
  if (!hit) return null;
  const ttl = Number(hit.ttl) || Number(ttlMin) || 0;
  if (Date.now() - hit.at < ttl * 60 * 1000) return { ...hit.value, cached: true };
  cache.delete(key);
  return null;
}

function cacheSet(key, value, ttlMin) {
  cache.set(key, { at: Date.now(), value, ttl: Number(ttlMin) || 0 });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

function clip(s, max) {
  const arr = Array.from(String(s || '').replace(/\s+/g, ' ').trim());
  return arr.length > max ? arr.slice(0, max).join('') + '…' : arr.join('');
}

/** 保留换行的裁剪：正文/评论按行读才像人话 */
function clipLines(s, max) {
  const text = String(s || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  const arr = Array.from(text);
  if (arr.length <= max) return text;
  const cut = arr.slice(0, max).join('');
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > max * 0.55) return cut.slice(0, lastBreak).trim();
  return cut.trim() + '…';
}

/** 小黑盒分享链接的 query 里常带 redirect_data（标题/简介），不用渲染也能先拿到 */
function redirectData(url) {
  try {
    const u = new URL(url);
    const raw = u.searchParams.get('redirect_data');
    if (!raw) return null;
    const data = JSON.parse(raw);
    const link = data && data.link ? data.link : null;
    if (!link) return null;
    return {
      title: clip(link.title, 120),
      description: clip(link.description, 240),
      thumb: String(link.thumb || ''),
    };
  } catch {
    return null;
  }
}

function looksLikeXiaoheihe(host) {
  return /(^|\.)xiaoheihe\.cn$/i.test(host);
}

function genericPrompt(info) {
  if (!info) return '';
  if (!info.ok) {
    return `对方发了一个链接（${info.url}），但打不开（${info.error || '未知原因'}）。不要猜内容，问对方一句这是什么。`;
  }
  const lines = [`链接标题：${info.title || '（无标题）'}`];
  if (info.site) lines.push(`站点：${info.site}`);
  if (info.author) lines.push(`作者：${info.author}`);
  if (info.description) lines.push(`简介：${clip(info.description, 260)}`);
  if (info.article && info.article !== info.description) lines.push(`正文片段：\n${clipLines(info.article, 720)}`);
  if (info.comments) lines.push(`评论节选：\n${clipLines(info.comments, 380)}`);
  lines.push(info.partial
    ? '（只拿到了分享卡片上的标题和简介，正文没读到；不要装作看过全文。）'
    : info.kind === 'video'
      ? '（这是视频页，你只读到了文字信息，没有看完整视频画面；不要编造视频内容。）'
      : '（你点开读了网页文字。没读到图里的内容就不要描述图片。）');
  return clipLines(lines.join('\n'), 1150);
}

/** 从网页 HTML 里抽信息（普通文章 / 已经渲染好的 SPA） */
function parseHtml(html, finalUrl, fallback = {}) {
  const title = extract.titleOf(html) || fallback.title || '';
  const siteName = extract.meta(html, ['og:site_name', 'application-name']);
  let description = extract.meta(html, ['og:description', 'description', 'twitter:description']) || fallback.description || '';
  // 「小黑盒 - 玩家高能聚集地」这种站点 slogan 放进 prompt 只会干扰判断
  if (description && (
    (siteName && description === siteName)
    || /^小黑盒\s*[-_|]\s*玩家高能聚集地/.test(description)
    || /^(哔哩哔哩|bilibili|微博|知乎)\s*[-_|]/.test(description)
  )) {
    description = '';
  }
  const text = extract.htmlToText(html);
  const article = extract.extractArticle(text, { maxArticle: 1800, maxComments: 900 });
  const plain = text.replace(/@@ARTICLE@@/g, '').trim();
  return {
    title,
    description,
    article: article.article || clip(plain, 800),
    comments: article.comments,
    textLength: plain.length,
    startMarked: article.startMarked,
  };
}

async function visionText(appConfig, image, prompt, timeoutMs) {
  const vision = visionModule();
  if (!vision || typeof vision.describe !== 'function') return '';
  if (!appConfig) return '';
  try {
    if (typeof vision.status === 'function') {
      const st = vision.status(appConfig);
      if (!st || !st.configured) return '';
    }
    const call = vision.describe(appConfig, { imageBase64: image.base64, mime: image.mime, prompt });
    const result = await Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve(''), Math.max(1500, timeoutMs))),
    ]);
    return clip(result, 180);
  } catch {
    return '';
  }
}

/**
 * 有图就补视觉描述：封面 + 视频抽样画面。
 * 只对 B 站这类有明确画面的链接做；失败/没配 Key 都静默跳过。
 */
async function enrichVision(info, ctx) {
  if (!info || !info.ok || !ctx.linksCfg.videoVision) return info;
  const vision = visionModule();
  if (!vision || typeof vision.describe !== 'function') return info;
  if (!ctx.appConfig) return info;
  try {
    const st = vision.status(ctx.appConfig);
    if (!st || !st.configured) return info;
  } catch {
    return info;
  }

  const max = Math.min(5, Math.max(0, Number(ctx.linksCfg.maxVisionImages) || 0));
  if (!max) return info;

  const jobs = [];
  if (info.cover) jobs.push({ kind: 'remote', url: info.cover, label: '封面' });
  for (const img of info.images || []) {
    if (img && img.file) jobs.push({ kind: 'file', file: img.file, mime: img.mime, label: img.label || '画面' });
  }
  const picked = jobs.slice(0, max);
  if (!picked.length) return info;

  const deadline = Date.now() + Math.max(3000, Number(ctx.visionTimeoutMs) || 12000);
  const visual = await Promise.all(picked.map(async (job) => {
    const left = deadline - Date.now();
    if (left <= 500) return '';
    let image = null;
    if (job.kind === 'remote') {
      const r = await httpc.image(job.url, {
        cfg: ctx.linksCfg,
        allowPrivate: ctx.allowPrivate,
        allowPorts: ctx.allowPorts,
        timeoutMs: Math.min(left, 6000),
        maxBytes: 4 * 1024 * 1024,
        headers: { Referer: 'https://www.bilibili.com/' },
      });
      if (r.ok) image = { base64: r.base64, mime: r.mime };
    } else {
      try {
        image = { base64: fs.readFileSync(job.file).toString('base64'), mime: job.mime || 'image/png' };
      } catch { image = null; }
    }
    if (!image) return '';
    const text = await visionText(
      ctx.appConfig,
      image,
      `${job.label}：这是视频里的一个画面。用 60 字以内的中文，只说画面里能看到的主体、场景、动作和文字；看不清就说看不清，不要评价，不要编造歌词或剧情。`,
      Math.min(left, 8000)
    );
    return text ? `${job.label}：${text}` : '';
  }));

  const cleaned = visual.filter(Boolean);
  if (cleaned.length) info.visual = cleaned;
  return info;
}

function cleanupFrames(info) {
  if (!info || !info.frameDir) return;
  try {
    fs.rmSync(info.frameDir, { recursive: true, force: true, maxRetries: 1 });
  } catch { /* 下次启动 sweep 会清 */ }
  delete info.frameDir;
}

/**
 * 读一个链接。
 * @param {string} rawUrl
 * @param {{linksCfg?:object, appConfig?:object, root:string, timeoutMs?:number, cacheMinutes?:number,
 *   force?:boolean, allowPrivate?:boolean, allowPorts?:number[], visionTimeoutMs?:number}} opts
 */
async function describe(rawUrl, opts = {}) {
  const linksCfg = opts.linksCfg || {};
  const url = String(rawUrl || '').trim();
  const ttl = Math.max(1, Number(opts.cacheMinutes || linksCfg.cacheMinutes) || 60);
  if (!opts.force) {
    const hit = cacheGet(url, ttl);
    if (hit) return hit;
  }

  const timeoutMs = Math.max(2000, Number(opts.timeoutMs || linksCfg.timeoutMs) || 12000);
  const allowPrivate = Boolean(opts.allowPrivate);
  const allowPorts = Array.isArray(opts.allowPorts) ? opts.allowPorts : [];
  const cfg = linksCfg;

  const fail = (error, extra = {}) => {
    const value = {
      ok: false,
      url,
      kind: 'web',
      error,
      title: '',
      description: '',
      article: '',
      prompt: genericPrompt({ ok: false, url, error }),
      ...extra,
    };
    cacheSet(url, value, 5);
    return value;
  };

  const checked = policy.checkUrl(url, cfg, { allowPrivate, allowPorts });
  if (!checked.ok) return fail(checked.error);
  const host = checked.host;

  // 1) B 站：公开接口，优先
  if (bilibili.isBilibiliHost(host)) {
    try {
      const info = await bilibili.describe(checked.url, {
        linksCfg: cfg,
        root: opts.root,
        timeoutMs,
        allowPrivate,
        allowPorts,
        wantVision: Boolean(cfg.videoVision) && Number(cfg.maxVisionImages) > 0,
        maxVisionImages: Number(cfg.maxVisionImages) || 0,
      });
      if (info && info.ok) {
        await enrichVision(info, {
          linksCfg: cfg,
          appConfig: opts.appConfig,
          allowPrivate,
          allowPorts,
          visionTimeoutMs: opts.visionTimeoutMs,
        });
        cleanupFrames(info);
        info.prompt = bilibili.buildPrompt(info);
        info.kind = 'video';
        cacheSet(url, info, ttl);
        return info;
      }
      // 接口失败不直接放弃：回退到普通网页解析（至少能拿到标题/简介）
    } catch { /* fall through */ }
  }

  // 2) 普通网页
  let res = null;
  try {
    res = await httpc.text(checked.url, {
      cfg,
      allowPrivate,
      allowPorts,
      timeoutMs,
      maxBytes: Math.max(200 * 1024, Number(cfg.maxBytes) || 1200000),
      headers: host === 'mp.weixin.qq.com' ? { Referer: 'https://mp.weixin.qq.com/' } : {},
    });
  } catch {
    res = { ok: false, error: 'network' };
  }

  if (!res.ok) {
    const fb = redirectData(checked.url);
    if (fb && (fb.title || fb.description)) {
      const info = {
        ok: true,
        url: checked.url,
        site: looksLikeXiaoheihe(host) ? '小黑盒' : '',
        kind: 'web',
        title: fb.title,
        description: fb.description,
        article: '',
        comments: '',
        prompt: '',
        partial: true,
      };
      info.prompt = genericPrompt(info);
      cacheSet(url, info, ttl);
      return info;
    }
    return fail(res.error || 'network', { url: checked.url });
  }

  const contentType = String((res.headers && res.headers['content-type']) || '');
  if (contentType && !/text\/html|text\/plain|application\/xhtml|application\/json/i.test(contentType)) {
    return fail('unsupported_content', { url: checked.url });
  }

  let parsed = parseHtml(res.text, res.finalUrl, redirectData(checked.url) || {});
  const needsBrowser = extract.looksLikeSpa(res.text, parsed.article + parsed.comments)
    || (parsed.textLength < 160 && !parsed.description)
    || extract.isLoginWall(parsed.article + parsed.comments);

  // 短链（t.cn、xhslink…）跳转后的域名才是真正要渲染的站；用最终 host 判断白名单
  let finalHost = host;
  try { finalHost = new URL(res.finalUrl || checked.url).hostname.toLowerCase(); } catch { /* keep host */ }

  // 这些站的 HTML 外壳里也有几百字页脚，甚至带一个空的正文容器；只要域名命中就渲染一次，
  // 渲染成功就以浏览器 DOM 为准（验证码页会被下面的 blocked 识别）。
  const SPA_HOST = /(^|\.)(xiaoheihe\.cn|weibo\.(com|cn)|zhihu\.com|douyin\.com|xiaohongshu\.com|kuaishou\.com)$/i;
  const forceSpa = SPA_HOST.test(finalHost);

  if ((needsBrowser || forceSpa) && browser.allowedByConfig(finalHost, cfg) && String(cfg.browser || 'auto') !== 'off') {
    try {
      const rendered = await browser.render(res.finalUrl || checked.url, {
        root: opts.root,
        linksCfg: cfg,
        timeoutMs: Math.min(timeoutMs, 15000),
      });
      if (rendered.ok) {
        const again = parseHtml(rendered.html, rendered.finalUrl, redirectData(checked.url) || {});
        if (again.textLength >= 40) parsed = again;
      } else if (opts.logger && typeof opts.logger.warn === 'function') {
        opts.logger.warn(`链接渲染失败（${finalHost}）：${rendered.error || 'unknown'}`
          + (rendered.detail ? ` · ${String(rendered.detail).slice(0, 400)}` : ''));
      }
    } catch (err) {
      if (opts.logger && typeof opts.logger.warn === 'function') {
        opts.logger.warn(`链接渲染异常（${finalHost}）：${(err && err.message) || err}`);
      }
    }
  }

  const info = {
    ok: Boolean(parsed.title || parsed.description || parsed.article),
    url: checked.url,
    site: looksLikeXiaoheihe(host) ? '小黑盒' : '',
    kind: 'web',
    title: parsed.title,
    description: parsed.description,
    article: parsed.article,
    comments: parsed.comments,
    error: '',
  };

  // 反爬页不要当正文：小黑盒/微博被限流时会返回「尝试太多了 / 刷新验证码」
  if (extract.isBlockedPage(parsed.article) || extract.isBlockedPage(parsed.comments)) {
    const fb = redirectData(checked.url);
    info.ok = false;
    info.error = 'blocked';
    info.blocked = true;
    if (fb && fb.title) {
      info.title = fb.title;
      info.description = fb.description;
      info.prompt = `对方发了一个链接（${checked.url}），站点这次要求人机验证，只看到分享卡片上的标题「${fb.title}」。`
        + `${fb.description ? '简介：' + clip(fb.description, 160) + '。' : ''}`
        + '不要假装看过全文；可以就标题接一句，或者说「这链接我打不开，你截个图？」。';
    } else {
      info.prompt = `对方发了一个链接（${checked.url}），但站点要求人机验证，没读到内容。不要猜里面写了什么，问对方一句这是什么或让对方截图。`;
    }
    cacheSet(url, info, 5);
    return info;
  }

  if (!info.ok) {
    info.error = 'empty';
    info.prompt = genericPrompt(info);
    cacheSet(url, info, 5);
    return info;
  }

  // SPA 外壳：标题是站点 slogan、正文只有页脚。不能当文章喂给模型。
  const shellLike = !parsed.startMarked
    && String(parsed.article || '').length < 300
    && (/(^|\.)(xiaoheihe\.cn|weibo\.(com|cn)|zhihu\.com)$/i.test(finalHost)
      || /^小黑盒\s*[-—]/.test(parsed.title)
      || parsed.title.length < 8);
  if (shellLike) {
    const fb = redirectData(checked.url);
    if (fb && fb.title) {
      info.ok = true;
      info.partial = true;
      info.title = fb.title;
      info.description = fb.description;
      info.article = '';
      info.comments = '';
      info.prompt = `对方发了一个链接（${checked.url}），站点没给正文，你只看到分享卡片：`
        + `标题「${fb.title}」${fb.description ? '，简介「' + clip(fb.description, 200) + '」' : ''}。`
        + '不要假装看过全文；可以就标题接一句，或问对方「这讲的啥？截个图？」。';
    } else {
      info.ok = false;
      info.error = 'empty';
      info.prompt = `对方发了一个链接（${checked.url}），站点没给正文（可能要登录/被风控）。`
        + '不要猜里面写了什么，问对方一句这是什么或让对方截图。';
    }
    cacheSet(url, info, 5);
    return info;
  }
  info.prompt = genericPrompt(info);
  cacheSet(url, info, ttl);
  return info;
}

function formatForPrompt(info) {
  if (!info) return '';
  if (info.prompt) return info.prompt;
  return genericPrompt(info);
}

function clearCache() {
  cache.clear();
}

module.exports = {
  describe,
  formatForPrompt,
  genericPrompt,
  parseHtml,
  redirectData,
  enrichVision,
  cleanupFrames,
  clearCache,
  _internals: { clip },
};
