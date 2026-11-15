'use strict';

/**
 * 跨聊天操作：主人在私聊里让鲸鲸去某个群发一条指定消息。
 *
 * 这是补丁，不改鲸鲸源码：
 *   - 在 Gateway.handleInbound 最前面识别「在 X 群发：...」；
 *   - 用鲸鲸自己的 ReminderService.enqueueNow 放进主动发送队列；
 *   - 桥接轮询 /api/reminders/due 时会把消息发到目标群。
 *
 * 只有绑定了 wxid 的主人才有权限，避免群里任何人靠改昵称冒充。
 */

const KEY = '__whaleCrossChatWrapped';
const RATE = new Map();

function baseModules() {
  return {
    ...require('../src/adapters/gateway'),
    ...require('../src/core/master'),
    ...require('../src/core/wechatSendPolicy'),
  };
}

function stripQuotes(s) {
  return String(s || '').replace(/^[\s「」『』“”"'‘’《》]+|[\s「」『』“”"'‘’《》]+$/g, '').trim();
}

function cleanTarget(s) {
  return stripQuotes(s)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function parse(text) {
  const s = String(text || '').replace(/\r/g, '').trim();
  if (!s || s.length > 1000) return null;
  // 在「群名」里发：内容 / 给 群名 发一条：内容 / 去群名群说：内容
  const m = s.match(
    /^(?:请|麻烦|帮我|帮忙)?\s*(?:在|去|到|给|向|让|叫|通知|告诉)\s*[「『“"']?(.{1,40}?)[」』”"']?\s*(?:那个|这个)?(?:群|群里|群里面|里|那边)?\s*(?:发一条|发个|发一句|发|说|通知|告诉|转告|转达|带话|带句话|喊)\s*[:：，,]?\s*([\s\S]+)$/
  );
  if (!m) return null;
  const target = cleanTarget(m[1]);
  const message = stripQuotes(m[2]).trim();
  if (!target || !message) return null;
  if (/^(?:群|群里|群里面|这里|这里群|本群|当前群|这个群|那个群)$/.test(target)) return null;
  return { target, message: message.slice(0, 800) };
}

function groupCandidates(runtime) {
  const out = [];
  const seen = new Set();
  try {
    const chats = runtime.store && runtime.store.chatStore && runtime.store.chatStore.chats;
    if (chats && typeof chats.values === 'function') {
      for (const chat of chats.values()) {
        if (!chat || chat.chatType !== 'group') continue;
        const id = String(chat.chatId || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, title: String(chat.title || id), isGroup: true });
      }
    }
  } catch { /* ignore */ }
  try {
    const items = (runtime.contacts && Array.isArray(runtime.contacts.items)) ? runtime.contacts.items : [];
    for (const item of items) {
      if (!item || !item.isGroup) continue;
      const id = String(item.wxid || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: String(item.name || item.remark || id), isGroup: true });
    }
  } catch { /* ignore */ }
  return out;
}

function resolveTarget(runtime, target) {
  const groups = groupCandidates(runtime);
  const want = target.toLowerCase();
  const exact = groups.filter((g) => g.id.toLowerCase() === want || g.title.toLowerCase() === want);
  if (exact.length === 1) return { chat: exact[0] };
  if (exact.length > 1) return { error: `「${target}」匹配到多个群，请说得更具体一点。`, candidates: exact.slice(0, 6) };

  const partial = groups.filter((g) => g.title.toLowerCase().includes(want) || want.includes(g.title.toLowerCase()));
  if (partial.length === 1) return { chat: partial[0] };
  if (partial.length > 1) {
    return {
      error: `「${target}」匹配到多个群：${partial.slice(0, 6).map((g) => `「${g.title}」`).join('、')}。请用更完整的群名。`,
      candidates: partial.slice(0, 6),
    };
  }
  return { error: `没找到群「${target}」。先在微信里打开那个群说句话，让我认识它，再试一次。` };
}

function rateOk(config, chatId) {
  const now = Date.now();
  const max = Number(config && config.crossChat && config.crossChat.maxPerHour) || 10;
  const rows = (RATE.get(chatId) || []).filter((t) => now - t < 3600 * 1000);
  if (rows.length >= max) return false;
  rows.push(now);
  RATE.set(chatId, rows);
  return true;
}

function handle(runtime, msg) {
  if (!runtime || !msg || msg.platform !== 'wechat') return null;
  if (msg.chatType !== 'private') return null;
  const parsed = parse(msg.text || msg.cleanText || '');
  if (!parsed) return null;

  const cfg = require('./config').load(runtime.config.root || process.cwd()).config;
  if (!cfg.enabled || !cfg.crossChat || cfg.crossChat.enabled !== true) return null;

  // 私聊里的主人判定：沿用鲸鲸的 matchMaster（绑定 wxid 优先，没配有效 wxid 时按主人昵称）。
  // 跨聊天只允许私聊触发，群里的人不能直接命令；私聊里如果连主人都不算，就不执行。
  const { matchMaster, sendDenial } = baseModules();
  const hit = matchMaster(runtime.config, msg);
  if (!hit.isMaster) {
    return { reply: '跨聊天发消息只有主人可以用。' };
  }
  if (hit.reason === 'nickname') {
    runtime.logger?.warn?.('[cross-chat] 按昵称识别主人（建议在启动器里补真正的 wxid）');
  }

  const denial = sendDenial(runtime.config, {
    id: msg.chatId,
    names: [msg.chatTitle],
    isGroup: false,
    platform: msg.platform,
  });
  if (denial) return { reply: denial };

  if (!rateOk(cfg, msg.chatId)) return { reply: '跨聊天发消息有点频繁，歇一会儿再试。' };

  const found = resolveTarget(runtime, parsed.target);
  if (!found.chat) return { reply: found.error };
  if (!runtime.reminders || typeof runtime.reminders.enqueueNow !== 'function') {
    return { reply: '这台机器上的主动发送队列还没准备好，等一下再试。' };
  }

  try {
    const item = runtime.reminders.enqueueNow({
      wxid: found.chat.id,
      name: found.chat.title,
      chatType: 'group',
      text: parsed.message,
      kind: 'crosschat',
    });
    runtime.logger?.info?.(`[cross-chat] queue id=${item.id} target=${found.chat.title} chars=${parsed.message.length}`);
    return {
      reply: `好，已经安排发到「${found.chat.title}」：\n${parsed.message}`,
      meta: { target: found.chat.id, targetTitle: found.chat.title, itemId: item.id },
    };
  } catch (err) {
    runtime.logger?.warn?.('[cross-chat] queue failed: ' + ((err && err.message) || err));
    return { reply: '消息没排进去：' + ((err && err.message) || '主动发送队列拒绝了这条任务') };
  }
}

function install(runtime) {
  if (!runtime) return;
  const { Gateway, normalizeInbound } = baseModules();
  if (Gateway.prototype[KEY]) return;
  const original = Gateway.prototype.handleInbound;
  Gateway.prototype.handleInbound = async function handleInboundWithCrossChat(payload, opts = {}) {
    try {
      if (opts && opts.local && this.platform === 'wechat') {
        const msg = normalizeInbound(payload, this.platform);
        const result = handle(runtime, msg);
        if (result && result.reply) {
          return {
            ok: true,
            action: 'reply',
            reply: result.reply,
            bubbles: [result.reply],
            crossChat: result.meta || true,
          };
        }
      }
    } catch (err) {
      runtime.logger?.warn?.('[cross-chat] hook failed: ' + ((err && err.message) || err));
    }
    return original.call(this, payload, opts);
  };
  Gateway.prototype[KEY] = true;
}

module.exports = { install, handle, parse, resolveTarget, cleanTarget, KEY };
