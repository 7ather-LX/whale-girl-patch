'use strict';

/**
 * 补丁自己的配置：data/whale-patch.json
 *
 * 为什么不直接写 config.json？
 *   - 启动器保存设置时会按它认识的字段重写 config.json，补丁字段虽然一般能留下，
 *     但「恢复默认」和以后版本的字段迁移都可能把它们抹掉；
 *   - 补丁要能一键卸载，配置跟着补丁走更干净。
 *
 * 读取带 mtime 缓存：管理页保存后下一轮聊天立即生效，不用重启服务。
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'whale-patch.json';

const DEFAULTS = Object.freeze({
  version: 1,
  enabled: true,
  sharedMemory: {
    enabled: false,
    maxTokens: 320,
    maxSiblings: 4,
    maxRecentLines: 6,
    scopes: [],
  },
  links: {
    enabled: true,
    timeoutMs: 12000,
    cacheMinutes: 60,
    // auto = 找 Edge / Chrome；off = 完全不启动浏览器；也可填绝对路径
    browser: 'auto',
    // 只有这些域名允许启动浏览器渲染（SPA 页面需要执行 JS）
    browserDomains: [
      'xiaoheihe.cn',
      'weibo.com',
      'weibo.cn',
      't.cn',
      'zhihu.com',
      'douyin.com',
      'xiaohongshu.com',
      'xhslink.com',
      'kuaishou.com',
    ],
    // 非空时变成白名单：只读这些域名
    allowDomains: [],
    denyDomains: [],
    // 视频：读封面/故事板截图交给看图模型（需要已配置看图 Key）
    videoVision: true,
    maxVisionImages: 3,
    maxBytes: 1200000,
  },
});

const MODES = new Set(['summary', 'recent', 'both']);

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function copy(v) {
  return JSON.parse(JSON.stringify(v));
}

function bool(v, fallback) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}

function intIn(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function text(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 域名规则：example.com 命中自身和子域；.example.com / *.example.com 只写一种即可 */
function cleanDomain(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^\./, '');
  if (!/^[a-z0-9.-]+$/.test(s) || s.length > 120 || s.includes('..')) return '';
  return s;
}

function cleanDomainList(list, max = 100) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, max * 2)) {
    const d = cleanDomain(item);
    if (d && !out.includes(d)) out.push(d);
    if (out.length >= max) break;
  }
  return out;
}

function cleanChatKey(raw) {
  const s = String(raw == null ? '' : raw).trim().slice(0, 240);
  if (!s) return '';
  // 群 / 私聊 / 通配都允许；只挡控制字符
  return s.replace(/[\u0000-\u001f\u007f]/g, '');
}

function slugify(raw, fallback) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || fallback;
}

function normalizeScope(raw, index, used) {
  if (!isPlainObject(raw)) return null;
  const name = text(raw.name, 40);
  const mode = MODES.has(raw.mode) ? raw.mode : 'both';
  const match = ['any', 'group', 'private'].includes(raw.match) ? raw.match : 'any';
  const chats = [];
  if (Array.isArray(raw.chats)) {
    for (const item of raw.chats.slice(0, 120)) {
      const key = cleanChatKey(item);
      if (key && !chats.includes(key)) chats.push(key);
    }
  }
  const scope = {
    id: slugify(raw.id, `scope-${index + 1}`),
    name: name || `共享组 ${index + 1}`,
    mode,
    // any = 按 chats 列表；group/private = 自动包含该类型的全部聊天（含以后新建的）
    match,
    enabled: bool(raw.enabled, true),
    sharePeople: bool(raw.sharePeople, false),
    chats: match === 'any' ? chats : ['*'],
  };
  let id = scope.id;
  let n = 2;
  while (used.has(id)) {
    id = `${scope.id}-${n}`;
    n += 1;
  }
  scope.id = id;
  used.add(id);
  return scope;
}

function normalize(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = copy(DEFAULTS);
  out.version = 1;
  out.enabled = bool(src.enabled, true);

  const sm = isPlainObject(src.sharedMemory) ? src.sharedMemory : {};
  out.sharedMemory.enabled = bool(sm.enabled, false);
  out.sharedMemory.maxTokens = intIn(sm.maxTokens, 80, 1200, 320);
  out.sharedMemory.maxSiblings = intIn(sm.maxSiblings, 1, 12, 4);
  out.sharedMemory.maxRecentLines = intIn(sm.maxRecentLines, 0, 20, 6);
  const used = new Set();
  out.sharedMemory.scopes = Array.isArray(sm.scopes)
    ? sm.scopes.slice(0, 50).map((scope, i) => normalizeScope(scope, i, used)).filter(Boolean)
    : [];

  const lk = isPlainObject(src.links) ? src.links : {};
  out.links.enabled = bool(lk.enabled, true);
  out.links.timeoutMs = intIn(lk.timeoutMs, 3000, 25000, 12000);
  out.links.cacheMinutes = intIn(lk.cacheMinutes, 1, 1440, 60);
  out.links.browser = ['auto', 'off'].includes(lk.browser) || typeof lk.browser === 'string'
    ? String(lk.browser || 'auto').slice(0, 260)
    : 'auto';
  out.links.browserDomains = cleanDomainList(lk.browserDomains, 100);
  out.links.allowDomains = cleanDomainList(lk.allowDomains, 100);
  out.links.denyDomains = cleanDomainList(lk.denyDomains, 100);
  out.links.videoVision = bool(lk.videoVision, true);
  out.links.maxVisionImages = intIn(lk.maxVisionImages, 0, 5, 3);
  out.links.maxBytes = intIn(lk.maxBytes, 100 * 1024, 3 * 1024 * 1024, 1200000);
  return out;
}

function fileOf(root) {
  return path.join(root, 'data', FILE_NAME);
}

const cache = new Map();

/**
 * 读配置。文件不存在时返回默认值（不会自动写盘，写盘由 ensure/save 负责）。
 * @returns {{config:object, file:string, exists:boolean, error:string, mtimeMs:number}}
 */
function load(root) {
  const file = fileOf(root);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { config: normalize(DEFAULTS), file, exists: false, error: '', mtimeMs: 0 };
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.state;
  let state;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = { config: normalize(raw), file, exists: true, error: '', mtimeMs: stat.mtimeMs };
  } catch (err) {
    state = {
      config: normalize(DEFAULTS),
      file,
      exists: true,
      error: (err && err.message) || String(err),
      mtimeMs: stat.mtimeMs,
    };
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, state });
  return state;
}

function ensure(root) {
  const file = fileOf(root);
  if (fs.existsSync(file)) return load(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(normalize(DEFAULTS), null, 2) + '\n', 'utf8');
  } catch {
    /* 数据目录不可写时继续用内存默认值 */
  }
  return load(root);
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 上目标文件被杀毒/索引短暂占用时 rename 会 EPERM，退回复制
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** 保存：先 normalize，再落盘；返回 {config,file} */
function save(root, next) {
  const config = normalize(next);
  const file = fileOf(root);
  writeAtomic(file, JSON.stringify(config, null, 2) + '\n');
  const stat = fs.statSync(file);
  const state = { config, file, exists: true, error: '', mtimeMs: stat.mtimeMs };
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, state });
  return state;
}

/** 局部合并保存：用来只改 sharedMemory 或 links，避免管理页覆盖另一块的并发修改 */
function patch(root, partial) {
  const cur = load(root).config;
  const next = { ...cur };
  if (isPlainObject(partial)) {
    if (Object.prototype.hasOwnProperty.call(partial, 'enabled')) next.enabled = partial.enabled;
    if (isPlainObject(partial.sharedMemory)) next.sharedMemory = { ...cur.sharedMemory, ...partial.sharedMemory };
    if (isPlainObject(partial.links)) next.links = { ...cur.links, ...partial.links };
  }
  return save(root, next);
}

/** 一个聊天是否落在这个共享组里（match=group/private 时忽略 chats 列表） */
function scopeApplies(scope, chatKey, chatType = '') {
  if (!scope || scope.enabled === false) return false;
  if (scope.match === 'group') return chatType === 'group';
  if (scope.match === 'private') return chatType === 'private';
  return scope.chats.includes('*') || scope.chats.includes(String(chatKey || ''));
}

/** 找到某个 chat 所属的共享组（多个时返回第一个启用的） */
function scopeFor(config, chatKey, chatType = '') {
  const scopes = (config && config.sharedMemory && config.sharedMemory.scopes) || [];
  for (const scope of scopes) {
    if (scopeApplies(scope, chatKey, chatType)) return scope;
  }
  return null;
}

module.exports = {
  FILE_NAME,
  DEFAULTS,
  MODES,
  load,
  ensure,
  save,
  patch,
  normalize,
  scopeFor,
  scopeApplies,
  fileOf,
  cleanDomain,
  cleanDomainList,
  _internals: { bool, intIn, slugify, cleanChatKey },
};
