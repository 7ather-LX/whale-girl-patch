'use strict';

/**
 * HTML → 文本 / 正文抽取（无依赖，正则 + 结构标记）。
 *
 * 目标不是「还原网页」，而是给模型一段能读懂的内容：
 *   标题、作者、正文、热评。宁可少一点，也不要把导航/广告/推荐位塞满 prompt。
 */

const BLOCK_END = /<\/(?:p|div|li|h[1-6]|blockquote|section|article|tr|dd|dt|figcaption|header|footer)>|<br\s*\/?>/gi;
const ARTICLE_MARK = '\n@@ARTICLE@@\n';

const ARTICLE_CLASS = /(?:image-text__content|post[-_]?content|article[-_]?content|rich[-_]?text|content[-_]?body|markdown[-_]?body|js_content)/i;
const END_MARK = /(全部评论|相关推荐|相关社区|猜你想搜|热门评论|评论区|为你推荐|猜你喜欢|更多精彩|延伸阅读)/;
const CHROME_LINE = /^(首页|社区|小黑盒加速器|黑盒语音|黑盒工坊|开放平台|加入我们|登录|注册|返回|关注|已关注|分享|收藏|点赞|评论|立即下载.*|下载APP.*|打开APP.*|查看全部.*|展开.*|收起.*|广告|上一篇|下一篇|相关阅读)$/;
const CHROME_INLINE = /(小黑盒加速器|黑盒语音|黑盒工坊|开放平台|加入我们|立即下载小黑盒APP|下载小黑盒APP|打开APP|扫码下载|安全中心|用户协议|隐私政策|儿童色情|网上有害信息|举报|营业执照|沪ICP备|增值电信业务)/g;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    });
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function meta(html, names) {
  const raw = String(html || '');
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([\\s\\S]*?)["']`, 'i');
    const m = raw.match(re);
    if (m && m[1] && stripTags(m[1])) return stripTags(m[1]);
    const re2 = new RegExp(`<meta[^>]+content=["']([\\s\\S]*?)["'][^>]*(?:property|name)=["']${esc}["']`, 'i');
    const m2 = raw.match(re2);
    if (m2 && m2[1] && stripTags(m2[1])) return stripTags(m2[1]);
  }
  return '';
}

function titleOf(html) {
  const raw = String(html || '');
  const og = meta(raw, ['og:title', 'twitter:title']);
  if (og) return cleanTitle(og);
  const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanTitle(stripTags(m[1])) : '';
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[-_|—]\s*(哔哩哔哩|bilibili|小黑盒|微博|知乎|抖音|小红书|快手|YouTube).*$/i, '')
    .replace(/^【(?:原创|转载|分享)】\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * 把 HTML 变成按行组织的纯文本。
 * 正文区如果有已知 class，会插入 @@ARTICLE@@ 标记，供 extractArticle 找起点。
 */
function htmlToText(html) {
  let raw = String(html || '');
  raw = raw.replace(/<!--[\s\S]*?-->/g, ' ');
  raw = raw.replace(/<(script|style|noscript|svg|canvas|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
  raw = raw.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');

  // 正文标记：只标记「第一个」命中，避免侧栏同样 class 抢占
  const classRe = /<(div|section|article|main)\b[^>]*class=["'][^"']*(?:image-text__content|post[-_]?content|article[-_]?content|rich[-_]?text|content[-_]?body|markdown[-_]?body|js_content)[^"']*["'][^>]*>/gi;
  const m = classRe.exec(raw);
  if (m) raw = raw.slice(0, m.index) + ARTICLE_MARK + raw.slice(m.index + m[0].length);

  // 保留段落边界
  raw = raw.replace(/<\/(p|div|li|h[1-6]|blockquote|section|article|tr|dd|dt|figcaption|header|footer)>/gi, '\n');
  raw = raw.replace(/<br\s*\/?>/gi, '\n');
  raw = raw.replace(/<[^>]+>/g, '');
  raw = decodeEntities(raw);

  const lines = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\u00a0/g, ' ').replace(/[ \t\f\v]+/g, ' ').trim();
    if (!line) continue;
    if (line === '@@ARTICLE@@') {
      lines.push('@@ARTICLE@@');
      continue;
    }
    if (CHROME_LINE.test(line)) continue;
    const cleaned = line.replace(CHROME_INLINE, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    if (lines[lines.length - 1] === cleaned) continue;
    lines.push(cleaned);
  }
  return lines.join('\n');
}

function clipText(s, max) {
  const arr = Array.from(String(s || '').trim());
  if (arr.length <= max) return arr.join('');
  const cut = arr.slice(0, max).join('');
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'));
  return (lastStop > max * 0.55 ? cut.slice(0, lastStop + 1) : cut + '…').trim();
}

/**
 * 从 htmlToText 的结果里拆出 正文 / 评论。
 * @returns {{text:string, article:string, comments:string, startMarked:boolean}}
 */
function extractArticle(text, { maxArticle = 1800, maxComments = 900 } = {}) {
  const lines = String(text || '').split('\n');
  let start = 0;
  const markIndex = lines.indexOf('@@ARTICLE@@');
  if (markIndex >= 0) {
    start = markIndex + 1;
  } else {
    // 没有标记：跳过前几行导航（通常 2~8 行）
    start = lines.length > 12 ? 3 : 0;
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (END_MARK.test(lines[i])) {
      end = i;
      break;
    }
  }
  const bodyLines = lines.slice(start, end);
  const rest = lines.slice(end)
    .filter((line) => !/^(?:Lv\.\d+|全部\s*\d+\s*条回复|作者赞过|·.+|\d{4}-\d{2}-\d{2}(?:·.+)?|\d{1,7})$/.test(line));
  const comments = clipText(rest.join('\n'), maxComments)
    .replace(/^全部评论\s*/i, '')
    .replace(/\n全部\s*\d+\s*条回复/g, '')
    .trim();

  return {
    article: clipText(bodyLines.join('\n'), maxArticle),
    comments,
    startMarked: markIndex >= 0,
  };
}

function looksLikeSpa(html, text) {
  const raw = String(html || '');
  const plain = String(text || '').replace(/@@ARTICLE@@/g, '').trim();
  if (plain.length >= 300) return false;
  const scripts = (raw.match(/<script\b/gi) || []).length;
  return scripts >= 3 || /<div[^>]+id=["'](?:app|root)["']/i.test(raw);
}

function isLoginWall(text) {
  const t = String(text || '');
  if (t.length > 600) return false;
  return /(登录后查看|请先登录|扫码登录|登录知乎|登录微博|安全验证|访问过于频繁|环境异常|完成验证)/.test(t);
}

/** 反爬 / 人机验证页：不能当成正文喂给模型，否则她会把验证码页当文章内容 */
function isBlockedPage(text) {
  const t = String(text || '');
  if (!t || t.length > 1200) return false;
  return /(尝试太多次|尝试太多了|刷新验证码|人机验证|安全验证|访问过于频繁|环境异常|请完成验证|滑动验证|拖动滑块|验证码|captcha|Just a moment|Checking your browser)/i.test(t);
}

module.exports = {
  decodeEntities,
  stripTags,
  meta,
  titleOf,
  cleanTitle,
  htmlToText,
  extractArticle,
  clipText,
  looksLikeSpa,
  isLoginWall,
  isBlockedPage,
  ARTICLE_CLASS,
  END_MARK,
};
