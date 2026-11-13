'use strict';

/**
 * 跨聊天记忆（共享组）。
 *
 * 鲸鲸原本的红线是「一个聊天只读自己的记忆」，所以它在这边刚聊过的事，
 * 换个群/私聊就完全不记得。这个模块让主人在配置里把**指定几个聊天**放进
 * 同一个共享组，组内可以互相看到：
 *   - 对方的会话摘要（chat.summary，压缩时已经生成好的 L2 记忆）
 *   - 和当前这句话相关的最近原话（关键词命中，最多几条）
 *   - 可选：同一个人（uid 相同）在别的聊天里说过的偏好
 *
 * 它只读，不复制、不合并记忆文件：
 *   - 原来每个聊天的记忆仍然独立落盘，清空某个聊天不会误删别的；
 *   - 关掉共享或删掉共享组，立刻回到「各聊各的」；
 *   - 不会像「镜像写一份」那样把同一条消息记两遍、摘要算两遍。
 */

const personCard = require('../src/memory/personCard');
const format = require('../src/memory/format');
const { estimateBudgetTokens } = require('../src/memory/tokens');

const MAX_LINE_CHARS = 90;
const MAX_SUMMARY_CHARS = 260;

const STOP_WORDS = new Set([
  '这个', '那个', '什么', '怎么', '就是', '不是', '可以', '我们', '你们', '他们',
  '一个', '一下', '现在', '真的', '觉得', '知道', '还是', '但是', '因为', '所以',
  '如果', '已经', '没有', '不是', '今天', '昨天', '明天', '哈哈', '哈哈哈',
]);

function clip(s, max) {
  const arr = Array.from(String(s || '').replace(/\s+/g, ' ').trim());
  return arr.length > max ? arr.slice(0, max).join('') + '…' : arr.join('');
}

function dateLabel(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return sameYear ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

/** 中文按二元组切，英文/数字按词切；用来给跨聊天原话打分 */
function keywords(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  const latin = s.match(/[a-z0-9_]{2,20}/g) || [];
  for (const w of latin) {
    if (!STOP_WORDS.has(w)) out.add(w);
  }
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    const chars = Array.from(seg);
    for (let i = 0; i < chars.length - 1; i += 1) {
      const bigram = chars[i] + chars[i + 1];
      if (!STOP_WORDS.has(bigram)) out.add(bigram);
    }
    if (chars.length === 1) out.add(chars[0]);
  }
  return [...out].slice(0, 40);
}

function chatLabel(chat) {
  const title = String((chat && chat.title) || '').trim();
  if (title) {
    const isGroup = chat && chat.chatType === 'group';
    return isGroup ? `群「${clip(title, 24)}」` : `和「${clip(title, 24)}」`;
  }
  // 私聊的 meta.title 经常是空的：退回到最近说话人的名字，别让模型看到一串 wxid
  if (chat && chat.chatType !== 'group' && Array.isArray(chat.messages)) {
    for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
      const m = chat.messages[i];
      if (m && m.role === 'user' && m.name) return `和「${clip(m.name, 16)}」`;
    }
  }
  return chat && chat.chatType === 'group' ? '一个群聊' : '一个私聊';
}

function summaryOf(chat) {
  const text = chat && chat.summary && chat.summary.text;
  if (!text) return '';
  return clip(text, MAX_SUMMARY_CHARS);
}

function recentLines(chat, { query, max, isCurrent }) {
  if (!chat || !Array.isArray(chat.messages)) return [];
  const qWords = keywords(query);
  const pool = chat.messages.slice(-160).filter((m) => {
    if (!m || !m.text) return false;
    const t = String(m.text).trim();
    if (t.length < 3 || t.length > 500) return false;
    if (/^\/|^#/.test(t)) return false;
    return true;
  });
  if (!pool.length) return [];

  const scored = pool.map((m, i) => {
    const text = String(m.text).trim();
    let score = 0;
    if (qWords.length) {
      const lower = text.toLowerCase();
      for (const w of qWords) if (lower.includes(w)) score += 1;
    }
    // 越新越优先；助手自己的话权重低一点（它可能是随口说的）
    score += (i / Math.max(1, pool.length - 1)) * 1.2;
    if (m.role === 'assistant') score -= 0.25;
    if (isCurrent) score -= 0.6;
    return { m, text, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const out = [];
  const seen = new Set();
  for (const item of scored) {
    const norm = item.text.replace(/\s+/g, '').slice(0, 40);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const who = item.m.role === 'assistant' ? '我' : (item.m.name || '某人');
    const when = dateLabel(item.m.ts);
    out.push(`[${chatLabel(chat)}${when ? '·' + when : ''}] ${who}：${clip(item.text, MAX_LINE_CHARS)}`);
    if (out.length >= max) break;
  }
  return out;
}

function scopeApplies(scope, key, chatType) {
  if (!scope || scope.enabled === false) return false;
  if (scope.match === 'group') return chatType === 'group';
  if (scope.match === 'private') return chatType === 'private';
  return scope.chats.includes('*') || scope.chats.includes(String(key || ''));
}

function scopeSiblings(store, scope, currentKey, maxSiblings) {
  const all = store && store.chatStore && store.chatStore.chats;
  if (!all) return [];
  const allOfType = scope.match === 'group' || scope.match === 'private';
  const wanted = allOfType || scope.chats.includes('*');
  const list = [];
  for (const chat of all.values()) {
    if (!chat || chat.chatId === currentKey) continue;
    if (scope.match === 'group' && chat.chatType !== 'group') continue;
    if (scope.match === 'private' && chat.chatType === 'group') continue;
    if (!wanted && !scope.chats.includes(chat.chatId)) continue;
    if (!Array.isArray(chat.messages) || !chat.messages.length) continue;
    // 「文件传输助手」/ 系统会话不是人和人的对话，放进来只会污染记忆块
    if (/filehelper/i.test(String(chat.chatId || ''))) continue;
    list.push(chat);
  }
  list.sort((a, b) => (Number(b.lastActiveAt) || 0) - (Number(a.lastActiveAt) || 0));
  return list.slice(0, Math.max(1, Number(maxSiblings) || 4));
}

function peopleLines(siblings, uid, scope) {
  if (!scope.sharePeople || !uid) return [];
  const lines = [];
  for (const chat of siblings) {
    let card = null;
    try {
      card = chat.people && chat.people.get(String(uid));
    } catch {
      card = null;
    }
    if (!card) continue;
    const notes = personCard.activePreferences(card)
      .map((p) => String(p.text || '').trim())
      .filter(Boolean)
      .slice(0, 2);
    if (!notes.length) continue;
    lines.push(`${chatLabel(chat)}里，TA 提过：${notes.map((n) => clip(n, 50)).join('；')}`);
    if (lines.length >= 2) break;
  }
  return lines;
}

/**
 * 生成共享记忆块。
 * @returns {{block:string, tokens:number, scope:object|null, siblings:number}}
 */
function build(store, {
  key, query = '', uid = '', sharedConfig = null,
} = {}) {
  const empty = { block: '', tokens: 0, scope: null, siblings: 0 };
  const cfg = sharedConfig;
  if (!cfg || cfg.enabled === false) return empty;
  const scopes = Array.isArray(cfg.scopes) ? cfg.scopes : [];
  const current = store && store.chatStore && store.chatStore.chats
    ? store.chatStore.chats.get(String(key || ''))
    : null;
  const currentType = current ? current.chatType : '';
  const scope = scopes.find((s) => scopeApplies(s, key, currentType));
  if (!scope) return empty;

  const siblings = scopeSiblings(store, scope, String(key || ''), cfg.maxSiblings);
  if (!siblings.length) return empty;

  const entries = [];

  if (scope.mode === 'summary' || scope.mode === 'both') {
    for (const chat of siblings) {
      const summary = summaryOf(chat);
      if (summary) entries.push(`${chatLabel(chat)}最近在聊：${summary}`);
    }
  }

  if (scope.mode === 'recent' || scope.mode === 'both') {
    const max = Math.max(0, Number(cfg.maxRecentLines) || 0);
    if (max > 0) {
      const lines = [];
      const perChat = Math.max(1, Math.ceil(max / Math.max(1, siblings.length)));
      for (const chat of siblings) {
        for (const line of recentLines(chat, { query, max: perChat })) lines.push(line);
        if (lines.length >= max * 2) break;
      }
      if (lines.length) entries.push(lines.slice(0, max + 2).join('\n'));
    }
  }

  const people = peopleLines(siblings, uid, scope);
  for (const line of people) entries.push(line);

  if (!entries.length) return empty;

  const header = [
    `【跨聊天记忆 · 共享组「${clip(scope.name || scope.id, 24)}」】`,
    '主人允许下面这些聊天互通记忆。你可以像自己本来就记得一样自然接话：',
  ].join('\n');
  const footer = '（这是你自己的记忆，不是刚刚听谁说的；别把 A 群的事说成 B 群刚发生的，也别主动抖出对方不该知道的隐私。）';

  let body = entries.join('\n');
  const budget = Math.max(120, Number(cfg.maxTokens) || 320);
  let block = `${header}\n${body}\n${footer}`;
  let tokens = estimateBudgetTokens(block);

  // 超预算：整段整段地从后往前丢（先丢共享人物偏好，再丢最近原话），头和尾永远保留
  while (tokens > budget && entries.length > 1) {
    entries.pop();
    body = entries.join('\n');
    block = `${header}\n${body}\n${footer}`;
    tokens = estimateBudgetTokens(block);
  }
  if (tokens > budget) {
    block = `${header}\n${clip(body, Math.max(60, Math.floor(budget * 1.4)))}\n${footer}`;
    tokens = estimateBudgetTokens(block);
  }

  return { block, tokens, scope, siblings: siblings.length };
}

/** 把原版「只来自当前这个聊天」的声明换成共享语境下的说法 */
function patchScopeNotice(memoryBlock) {
  if (!memoryBlock) return memoryBlock;
  if (!memoryBlock.includes(format.MEMORY_SCOPE_NOTICE)) return memoryBlock;
  const replacement = '（这些来自当前聊天，以及主人允许共享的其它聊天；别提没被共享的聊天，也不要把共享内容说成是偷看来的。）';
  return memoryBlock.split(format.MEMORY_SCOPE_NOTICE).join(replacement);
}

module.exports = {
  build,
  patchScopeNotice,
  chatLabel,
  keywords,
  _internals: { clip, summaryOf, recentLines, scopeSiblings },
};
