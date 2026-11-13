'use strict';

/**
 * B 站视频适配器。
 *
 * 原版只能读网页的 og:title/og:description，简介里还混着「相关视频」「播放量…」，
 * 而且完全不知道视频画面。这里改成走 B 站公开接口：
 *   - view       标题 / 简介 / UP 主 / 时长 / 播放点赞投币收藏
 *   - tags       标签
 *   - reply      按热度排序的前几条评论（比简介更能说明视频在讲什么）
 *   - videoshot  官方故事板（视频画面缩略图拼图），裁几帧交给看图模型
 *
 * 这些都是公开网页自己也在用的接口，不需要登录 Cookie；带 Referer + 桌面 UA 即可。
 * 接口挂了就返回失败，由 reader 回退到普通网页解析。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const httpc = require('./http');

const API = 'https://api.bilibili.com';
const REFERER = 'https://www.bilibili.com/';

function isBilibiliHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'b23.tv'
    || h === 'bili2233.cn'
    || /(^|\.)bilibili\.com$/.test(h)
    || /(^|\.)bilibili\.tv$/.test(h);
}

function parseRef(url) {
  const s = String(url || '');
  const bv = s.match(/\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/i) || s.match(/[?&]bvid=(BV[0-9A-Za-z]{10})/i);
  const av = s.match(/\/av(\d+)/i) || s.match(/[?&]aid=(\d+)/i);
  const page = (s.match(/[?&]p=(\d+)/) || [])[1];
  if (bv) return { bvid: bv[1], aid: 0, page: Number(page) || 1 };
  if (av) return { bvid: '', aid: Number(av[1]), page: Number(page) || 1 };
  return null;
}

function durationText(sec) {
  const n = Math.max(0, Number(sec) || 0);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function shortNumber(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
}

function cleanComment(s) {
  return String(s || '')
    .replace(/\[[^\]]{1,12}\]/g, '')   // B 站表情 [doge]
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePic(pic) {
  const s = String(pic || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  return s.replace(/^http:/, 'https:');
}

function findPython(root) {
  const bundled = path.join(root, 'runtime', 'python', 'python.exe');
  try {
    if (fs.existsSync(bundled)) return bundled;
  } catch { /* ignore */ }
  return 'python';
}

/** 用 Pillow 把故事板拼图裁成几张单独画面；不依赖 stdout（避免管道权限问题） */
function cropSprite(root, spriteFile, outDir, crops, timeoutMs) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'crop_frames.py');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'crop_script_missing' });
    fs.mkdirSync(outDir, { recursive: true });
    const spec = JSON.stringify(crops);
    let child;
    try {
      child = spawn(findPython(root), [script, spriteFile, outDir, spec], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ ok: false, error: (err && err.code) || 'spawn_failed' });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, Math.max(5000, timeoutMs));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: (err && err.code) || 'spawn_failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: 'crop_failed' });
      const files = crops.map((c) => path.join(outDir, c.name));
      if (!files.every((f) => fs.existsSync(f))) return resolve({ ok: false, error: 'crop_missing' });
      resolve({ ok: true, files });
    });
  });
}

function buildPrompt(info) {
  const lines = [];
  lines.push(`链接标题：${info.title || '（无标题）'}`);
  const metaLine = [];
  if (info.author) metaLine.push(`UP主：${info.author}`);
  if (info.duration) metaLine.push(`时长：${durationText(info.duration)}`);
  if (info.publishedAt) metaLine.push(`发布：${info.publishedAt}`);
  if (metaLine.length) lines.push(metaLine.join(' · '));
  if (info.statsText) lines.push(`数据：${info.statsText}`);
  if (info.description) lines.push(`简介：${info.description.slice(0, 500)}`);
  if (info.tags && info.tags.length) lines.push(`标签：${info.tags.join('、')}`);
  if (info.comments && info.comments.length) {
    lines.push('高赞评论：');
    info.comments.slice(0, 5).forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  }
  if (info.visual && info.visual.length) {
    lines.push('你点开后看了封面和几张视频画面，看到的是：');
    info.visual.forEach((v, i) => lines.push(`${i + 1}. ${v}`));
    lines.push('（画面只是抽样，你并没有完整看完视频；不要编造具体剧情、台词或歌词。）');
  } else {
    lines.push('（你只看到了标题、简介和评论，没有看视频画面；不要假装看完了。）');
  }
  return lines.join('\n');
}

/**
 * @param {string} url
 * @param {{linksCfg:object, root:string, timeoutMs:number, allowPrivate:boolean, allowPorts:number[],
 *   wantVision:boolean, maxVisionImages:number}} ctx
 */
async function describe(url, ctx) {
  const deadline = Date.now() + Math.max(2000, Number(ctx.timeoutMs) || 12000);
  const left = () => Math.max(1200, deadline - Date.now());
  const cfg = ctx.linksCfg || {};
  const net = (extra = {}) => ({
    cfg,
    allowPrivate: ctx.allowPrivate,
    allowPorts: ctx.allowPorts,
    maxBytes: 800 * 1024,
    ...extra,
  });

  let finalUrl = url;
  // b23.tv 短链：先让它自己跳一次，拿到真正的视频页
  let shortHost = '';
  try { shortHost = new URL(url).hostname; } catch { /* ignore */ }
  if (/^(?:b23\.tv|bili2233\.cn)$/i.test(shortHost)) {
    const r = await httpc.request(url, net({ timeoutMs: left(), maxBytes: 200 * 1024, headers: { Referer: REFERER } }));
    if (r.ok && r.finalUrl) finalUrl = r.finalUrl;
    else if (r.error) return { ok: false, url, site: 'bilibili', kind: 'video', error: r.error };
  }

  const ref = parseRef(finalUrl) || parseRef(url);
  if (!ref) return { ok: false, url, site: 'bilibili', kind: 'video', error: 'no_video_id' };

  const viewUrl = ref.bvid
    ? `${API}/x/web-interface/view?bvid=${encodeURIComponent(ref.bvid)}`
    : `${API}/x/web-interface/view?aid=${ref.aid}`;

  const headers = { Referer: REFERER, Origin: 'https://www.bilibili.com' };
  const view = await httpc.json(viewUrl, net({ timeoutMs: left(), headers }));
  if (!view.ok || !view.data) return { ok: false, url: finalUrl, site: 'bilibili', kind: 'video', error: view.error || 'api_failed' };
  const body = view.data;
  if (body.code !== 0 || !body.data) {
    return {
      ok: false,
      url: finalUrl,
      site: 'bilibili',
      kind: 'video',
      error: `api_${body.code}`,
      apiMessage: String(body.message || '').slice(0, 80),
    };
  }
  const v = body.data;
  const aid = v.aid;
  const bvid = v.bvid || ref.bvid;

  const [tagsRes, replyRes, shotRes] = await Promise.all([
    httpc.json(`${API}/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, net({ timeoutMs: Math.min(left(), 5000), headers })),
    httpc.json(`${API}/x/v2/reply?type=1&oid=${aid}&sort=2&ps=8&pn=1`, net({ timeoutMs: Math.min(left(), 6000), headers })),
    ctx.wantVision && v.cid
      ? httpc.json(`${API}/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&index=1`, net({ timeoutMs: Math.min(left(), 6000), headers }))
      : Promise.resolve({ ok: false }),
  ]);

  let tags = [];
  if (tagsRes.ok && tagsRes.data && tagsRes.data.code === 0 && Array.isArray(tagsRes.data.data)) {
    tags = tagsRes.data.data.map((t) => String(t.tag_name || '').trim()).filter(Boolean).slice(0, 8);
  }

  let comments = [];
  if (replyRes.ok && replyRes.data && replyRes.data.code === 0) {
    const list = (replyRes.data.data && replyRes.data.data.replies) || [];
    comments = list.map((r) => cleanComment(r && r.content && r.content.message)).filter((x) => x.length >= 4).slice(0, 6);
  }

  const stat = v.stat || {};
  const statsText = [
    stat.view ? `播放 ${shortNumber(stat.view)}` : '',
    stat.like ? `点赞 ${shortNumber(stat.like)}` : '',
    stat.danmaku ? `弹幕 ${shortNumber(stat.danmaku)}` : '',
    stat.reply ? `评论 ${shortNumber(stat.reply)}` : '',
    stat.favorite ? `收藏 ${shortNumber(stat.favorite)}` : '',
  ].filter(Boolean).join(' · ');

  const info = {
    ok: true,
    url: `https://www.bilibili.com/video/${bvid}${ref.page > 1 ? `?p=${ref.page}` : ''}`,
    site: 'bilibili',
    kind: 'video',
    title: String(v.title || '').trim().slice(0, 120),
    description: String(v.desc || '').trim().slice(0, 800),
    article: String(v.desc || '').trim().slice(0, 1200),
    author: String((v.owner && v.owner.name) || '').slice(0, 60),
    duration: Number(v.duration) || 0,
    publishedAt: v.pubdate ? new Date(Number(v.pubdate) * 1000).toISOString().slice(0, 10) : '',
    stats: stat,
    statsText,
    tags,
    comments,
    cover: normalizePic(v.pic),
    images: [],
  };

  // 故事板：官方拼图（10×10 张 160×90 画面），裁 3 张 → 看图模型
  if (ctx.wantVision && ctx.maxVisionImages > 1 && shotRes.ok && shotRes.data && shotRes.data.code === 0) {
    const shot = shotRes.data.data || {};
    const sprite = normalizePic((shot.image && shot.image[0]) || '');
    const xLen = Number(shot.img_x_len) || 10;
    const yLen = Number(shot.img_y_len) || 10;
    const w = Number(shot.img_x_size) || 160;
    const h = Number(shot.img_y_size) || 90;
    if (sprite && xLen > 0 && yLen > 0) {
      const img = await httpc.image(sprite, net({ timeoutMs: Math.min(left(), 8000), maxBytes: 5 * 1024 * 1024, headers: { Referer: REFERER } }));
      if (img.ok && img.buffer) {
        const tmp = path.join(ctx.root, 'data', 'whale-patch', 'frames', `${bvid}-${Date.now()}`);
        fs.mkdirSync(tmp, { recursive: true });
        const spriteFile = path.join(tmp, 'sprite.jpg');
        fs.writeFileSync(spriteFile, img.buffer);
        const total = Math.max(1, xLen * yLen);
        const picks = [0.12, 0.45, 0.78].map((p) => Math.min(total - 1, Math.max(0, Math.round(total * p))));
        const crops = picks.map((idx, n) => ({
          x: (idx % xLen) * w,
          y: Math.floor(idx / xLen) * h,
          w,
          h,
          name: `frame-${n + 1}.png`,
        }));
        const cropped = await cropSprite(ctx.root, spriteFile, tmp, crops, Math.min(left(), 8000));
        if (cropped.ok) {
          info.images = cropped.files.map((file, i) => ({
            file,
            mime: 'image/png',
            label: `视频画面 ${i + 1}`,
          }));
        }
        info.frameDir = tmp;
      }
    }
  }

  info.prompt = buildPrompt(info);
  return info;
}

module.exports = {
  isBilibiliHost,
  parseRef,
  describe,
  buildPrompt,
  formatPrompt: buildPrompt,
  durationText,
  shortNumber,
  findPython,
  _internals: { cleanComment, normalizePic },
};
