'use strict';

/* 鲸鲸补丁管理页。纯原生 DOM，没有构建步骤，也没有外部 CDN（CSP 只允许同源脚本）。 */

const state = {
  config: null,
  chats: [],
  status: null,
  scopes: [],
  dirty: false,
  busy: false,
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'onclick') node.addEventListener('click', value);
    else if (key === 'onchange') node.addEventListener('change', value);
    else if (key === 'oninput') node.addEventListener('input', value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, kind = 'ok') {
  const box = $('toast');
  box.textContent = message;
  box.className = `toast ${kind}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { box.className = 'toast hidden'; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { data = { ok: false, error: `HTTP ${res.status}` }; }
  if (!res.ok || data.ok === false) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function fmtTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function chatText(chat) {
  const type = chat.chatType === 'group' ? '群聊' : '私聊';
  const parts = [type, `${chat.messages} 条消息`];
  if (chat.lastActiveAt) parts.push(fmtTime(chat.lastActiveAt));
  return parts.join(' · ');
}

function markDirty(value = true) {
  state.dirty = value;
  const badge = $('dirty-badge');
  if (badge) badge.classList.toggle('hidden', !value);
}

/* ------------------------------ 状态 ------------------------------ */

function renderStatus() {
  const chips = $('status-chips');
  chips.replaceChildren();
  const cfg = state.config;
  const diag = state.status && state.status.diagnostics;
  if (!cfg) return;

  const add = (label, value, on) => {
    chips.append(el('div', { class: `chip ${on === false ? 'off' : on === true ? 'on' : ''}` },
      el('span', { class: 'chip-label', text: label }),
      el('strong', { text: value })));
  };
  add('补丁版本', `v${(state.status && state.status.patch && state.status.patch.version) || '?'}`, true);
  add('跨聊天记忆', cfg.sharedMemory.enabled ? '开' : '关', cfg.sharedMemory.enabled);
  add('链接阅读', cfg.links.enabled ? '开' : '关', cfg.links.enabled);
  add('无头浏览器', diag && diag.browser ? diag.browser.name : '未找到', Boolean(diag && diag.browser));
  add('看图模型', diag && diag.vision && diag.vision.configured ? diag.vision.model : '未配置',
    Boolean(diag && diag.vision && diag.vision.configured));
  add('有记忆的聊天', String((diag && diag.chats) || 0), true);

  $('version').textContent = `v${(state.status && state.status.patch && state.status.patch.version) || '?'} · 补丁`;
  const err = $('status-error');
  const configError = state.status && state.status.patch && state.status.patch.configError;
  if (configError) {
    err.textContent = `补丁配置解析失败：${configError}（这次按默认值运行）`;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
}

function renderDiag() {
  const box = $('diag');
  box.replaceChildren();
  const diag = (state.status && state.status.diagnostics) || {};
  const rows = [
    ['补丁配置', (state.status && state.status.patch && state.status.patch.configFile) || ''],
    ['无头浏览器', diag.browser ? `${diag.browser.name} · ${diag.browser.path}` : '没有找到 Edge / Chrome'],
    ['看图模型', diag.vision && diag.vision.configured ? diag.vision.model : '未配置（链接阅读仍能用，只是不看视频画面）'],
    ['内置 Python', diag.python ? '可用（用于裁视频故事板）' : '未找到（只影响视频抽样画面）'],
    ['有记忆的聊天', String(diag.chats || 0)],
  ];
  for (const [label, value] of rows) {
    box.append(el('div', { class: 'diag-row' },
      el('span', { class: 'diag-label', text: label }),
      el('span', { class: 'mono', text: value })));
  }
  const file = $('config-path');
  if (file) file.textContent = (state.status && state.status.patch && state.status.patch.configFile) || '';
}

/* ------------------------------ 共享记忆 ------------------------------ */

function scopeChatsText(scope) {
  if (scope.match === 'group') return '全部群聊（自动）';
  if (scope.match === 'private') return '全部私聊（自动）';
  if (scope.chats.includes('*')) return '全部聊天';
  return `${scope.chats.length} 个聊天`;
}

function chatPicker(scope) {
  const wrap = el('div', { class: 'picker' });
  const allChecked = scope.chats.includes('*');

  const allLabel = el('label', { class: 'check all' },
    el('input', {
      type: 'checkbox',
      checked: allChecked,
      onchange: (e) => {
        if (e.target.checked) scope.chats = ['*'];
        else scope.chats = [];
        markDirty();
        renderScopes();
      },
    }),
    el('span', { text: '包含全部聊天（含以后新建的）' }));
  wrap.append(allLabel);

  if (allChecked) {
    wrap.append(el('p', { class: 'hint', text: '当前共享组已包含全部聊天。取消勾选后可以逐个选择。' }));
    return wrap;
  }

  if (!state.chats.length) {
    wrap.append(el('p', { class: 'hint', text: '还没有可选的聊天。先让鲸鲸在微信里收几条消息再回来。' }));
    return wrap;
  }

  const search = el('input', { type: 'text', class: 'search', placeholder: '搜索群名 / 私聊 / chat key' });
  const list = el('div', { class: 'chat-list' });

  const others = new Map();
  for (const s of state.scopes) {
    if (s.id === scope.id) continue;
    for (const key of s.chats) if (key !== '*') others.set(key, s.name);
  }

  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const items = state.chats.filter((c) => !q
      || String(c.title).toLowerCase().includes(q)
      || String(c.key).toLowerCase().includes(q));
    if (!items.length) {
      list.append(el('p', { class: 'hint', text: '没有匹配的聊天' }));
      return;
    }
    for (const chat of items.slice(0, 120)) {
      const checked = scope.chats.includes(chat.key);
      const label = el('label', { class: `chat ${checked ? 'checked' : ''}` },
        el('input', {
          type: 'checkbox',
          checked,
          onchange: (e) => {
            if (e.target.checked) {
              if (!scope.chats.includes(chat.key)) scope.chats.push(chat.key);
            } else {
              scope.chats = scope.chats.filter((k) => k !== chat.key);
            }
            e.target.closest('.chat').classList.toggle('checked', e.target.checked);
            markDirty();
            const summary = label.querySelector('.scope-summary');
            if (summary) summary.textContent = scopeChatsText(scope);
          },
        }),
        el('span', { class: 'chat-main' },
          el('span', { class: 'chat-title', text: chat.title }),
          el('span', { class: 'chat-meta', text: chatText(chat) }),
          others.has(chat.key) ? el('span', { class: 'badge', text: `已在「${others.get(chat.key)}」` }) : null));
      list.append(label);
    }
  };
  search.addEventListener('input', renderList);
  renderList();
  wrap.append(search, list);
  return wrap;
}

function renderScopes() {
  const box = $('scopes');
  box.replaceChildren();
  $('scopes-empty').classList.toggle('hidden', state.scopes.length > 0);

  for (const scope of state.scopes) {
    const card = el('div', { class: 'scope' });
    const head = el('div', { class: 'scope-head' },
      el('input', {
        type: 'text',
        class: 'scope-name',
        value: scope.name || '共享组',
        maxlength: 40,
        placeholder: '给这组起个名字，比如「家人」「游戏群」',
        oninput: (e) => { scope.name = e.target.value; markDirty(); },
      }),
      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox',
          checked: scope.enabled !== false,
          onchange: (e) => { scope.enabled = e.target.checked; markDirty(); },
        }),
        el('span', { text: '启用' })),
      el('button', {
        class: 'btn danger small',
        text: '删除',
        onclick: () => {
          state.scopes = state.scopes.filter((s) => s !== scope);
          markDirty();
          renderScopes();
        },
      }));

    const body = el('div', { class: 'scope-body' },
      el('div', { class: 'scope-row' },
        el('label', { class: 'field small' },
          el('span', { text: '范围' }),
          el('select', {
            onchange: (e) => {
              scope.match = e.target.value;
              if (scope.match !== 'any') scope.chats = ['*'];
              markDirty();
              renderScopes();
            },
          },
          el('option', { value: 'any', selected: (scope.match || 'any') === 'any' }, '自定义聊天'),
          el('option', { value: 'group', selected: scope.match === 'group' }, '全部群聊（自动）'),
          el('option', { value: 'private', selected: scope.match === 'private' }, '全部私聊（自动）'))),
        el('label', { class: 'field small' },
          el('span', { text: '共享方式' }),
          el('select', {
            onchange: (e) => { scope.mode = e.target.value; markDirty(); },
          },
          el('option', { value: 'both', selected: scope.mode === 'both' }, '摘要 + 相关原话'),
          el('option', { value: 'summary', selected: scope.mode === 'summary' }, '只用会话摘要'),
          el('option', { value: 'recent', selected: scope.mode === 'recent' }, '只用最近原话'))),
        el('label', { class: 'check' },
          el('input', {
            type: 'checkbox',
            checked: Boolean(scope.sharePeople),
            onchange: (e) => { scope.sharePeople = e.target.checked; markDirty(); },
          }),
          el('span', { text: '共享同一个人在这里说过的偏好（更贴近，但更隐私）' }))),
      (scope.match === 'group' || scope.match === 'private')
        ? el('p', {
          class: 'hint',
          text: scope.match === 'group'
            ? '自动包含所有群聊（以后新建的群也会加入）；不会读取任何私聊。'
            : '自动包含所有私聊（以后新建的私聊也会加入）；不会读取任何群聊。',
        })
        : el('details', { class: 'chat-details' },
          el('summary', {},
            el('span', { class: 'scope-summary', text: scopeChatsText(scope) }),
            el('span', { class: 'hint', text: ' 点开选择聊天' })),
          chatPicker(scope)));

    card.append(head, body);

    const selected = scope.match === 'group'
      ? state.chats.filter((c) => c.chatType === 'group')
      : scope.match === 'private'
        ? state.chats.filter((c) => c.chatType === 'private')
        : scope.chats.includes('*')
          ? state.chats
          : state.chats.filter((c) => scope.chats.includes(c.key));
    if (selected.some((c) => c.chatType === 'group') && selected.some((c) => c.chatType === 'private')) {
      card.append(el('p', {
        class: 'warnbox',
        text: '⚠️ 这个组同时包含群聊和私聊：私聊里的内容可能会出现在群聊回复里。确认你接受这个隐私风险再保存；不确定就把它们分开建组。',
      }));
    }
    box.append(card);
  }
}

function newScope() {
  const n = state.scopes.length + 1;
  state.scopes.push({
    id: `scope-${Date.now().toString(36)}`,
    name: `共享组 ${n}`,
    mode: 'both',
    enabled: true,
    sharePeople: false,
    chats: [],
  });
  markDirty();
  renderScopes();
}

function addScopeWithChats(name, chats, enabled = true, match = 'any') {
  if (!chats.length) return toast('没有符合条件的聊天', 'err');
  state.scopes.push({
    id: `scope-${Date.now().toString(36)}`,
    name,
    mode: 'both',
    match,
    enabled,
    sharePeople: false,
    chats: match === 'any' ? chats : ['*'],
  });
  markDirty();
  renderScopes();
  toast(`已新建「${name}」，记得点「保存记忆设置」`);
}

function fillSharedForm() {
  const sm = state.config.sharedMemory;
  $('shared-enabled').checked = Boolean(sm.enabled);
  $('shared-max-siblings').value = sm.maxSiblings;
  $('shared-max-lines').value = sm.maxRecentLines;
  $('shared-max-tokens').value = sm.maxTokens;
  state.scopes = JSON.parse(JSON.stringify(sm.scopes || []));
  renderScopes();
}

async function saveShared() {
  const payload = {
    sharedMemory: {
      enabled: $('shared-enabled').checked,
      maxSiblings: Number($('shared-max-siblings').value),
      maxRecentLines: Number($('shared-max-lines').value),
      maxTokens: Number($('shared-max-tokens').value),
      scopes: state.scopes,
    },
  };
  try {
    const res = await api('/api/patch/config', { method: 'POST', body: JSON.stringify(payload) });
    state.config = res.config;
    fillSharedForm();
    renderStatus();
    markDirty(false);
    toast('跨聊天记忆设置已保存，下一条消息生效');
  } catch (err) {
    toast('保存失败：' + err.message, 'err');
  }
}

async function previewShared() {
  const key = $('preview-chat').value;
  if (!key) return toast('先选一个聊天', 'err');
  const out = $('preview-out');
  out.classList.remove('hidden');
  out.textContent = '生成中…';
  try {
    const res = await api('/api/patch/preview-shared', {
      method: 'POST',
      body: JSON.stringify({ key, query: $('preview-query').value }),
    });
    if (!res.enabled) {
      out.textContent = '跨聊天记忆总开关是关的。';
      return;
    }
    if (!res.block) {
      out.textContent = '这个聊天还不在任何共享组里，或者组里其它聊天还没有记忆。';
      return;
    }
    out.textContent = `共享组：${res.scope ? res.scope.name : '?'} · 引用 ${res.siblings} 个聊天 · 约 ${res.tokens} token\n\n${res.block}`;
  } catch (err) {
    out.textContent = '预览失败：' + err.message;
  }
}

/* ------------------------------ 链接 ------------------------------ */

function fillLinksForm() {
  const lk = state.config.links;
  $('links-enabled').checked = Boolean(lk.enabled);
  $('links-browser').value = lk.browser === 'off' ? 'off' : 'auto';
  $('links-timeout').value = lk.timeoutMs;
  $('links-cache').value = lk.cacheMinutes;
  $('links-vision').value = lk.videoVision ? 'true' : 'false';
  $('links-vision-max').value = lk.maxVisionImages;
  $('links-browser-domains').value = (lk.browserDomains || []).join('\n');
  $('links-deny').value = (lk.denyDomains || []).join('\n');
  $('links-allow').value = (lk.allowDomains || []).join('\n');
}

async function saveLinks() {
  const payload = {
    links: {
      enabled: $('links-enabled').checked,
      browser: $('links-browser').value,
      timeoutMs: Number($('links-timeout').value),
      cacheMinutes: Number($('links-cache').value),
      videoVision: $('links-vision').value === 'true',
      maxVisionImages: Number($('links-vision-max').value),
      browserDomains: splitLines($('links-browser-domains').value),
      denyDomains: splitLines($('links-deny').value),
      allowDomains: splitLines($('links-allow').value),
    },
  };
  try {
    const res = await api('/api/patch/config', { method: 'POST', body: JSON.stringify(payload) });
    state.config = res.config;
    fillLinksForm();
    renderStatus();
    toast('链接设置已保存');
  } catch (err) {
    toast('保存失败：' + err.message, 'err');
  }
}

async function testLink() {
  const url = $('test-url').value.trim();
  if (!url) return toast('先填一个链接', 'err');
  const btn = $('test-run');
  const out = $('test-out');
  btn.disabled = true;
  btn.textContent = '读取中…';
  out.classList.remove('hidden');
  out.textContent = '正在打开链接…（小黑盒这类要执行 JS 的页面可能需要几秒）';
  $('test-meta').textContent = '';
  try {
    const res = await api('/api/patch/test-link', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    $('test-meta').textContent = `${res.ok ? '读取成功' : '读取失败'} · 耗时 ${res.ms} ms`
      + (res.info && res.info.site ? ` · ${res.info.site}` : '')
      + (res.info && res.info.error ? ` · ${res.info.error}` : '');
    out.textContent = (res.prompt || '（没有生成提示词）')
      + (res.info && res.info.visual ? `\n\n--- 模型看到的画面 ---\n${res.info.visual.join('\n')}` : '');
  } catch (err) {
    $('test-meta').textContent = '读取失败';
    out.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '读取';
  }
}

/* ------------------------------ 预览下拉 ------------------------------ */

function renderPreviewOptions() {
  const sel = $('preview-chat');
  const prev = sel.value;
  sel.replaceChildren();
  const sorted = [...state.chats].sort((a, b) => {
    const ga = a.chatType === 'group' ? 0 : 1;
    const gb = b.chatType === 'group' ? 0 : 1;
    return ga - gb || b.messages - a.messages;
  });
  for (const chat of sorted) {
    sel.append(el('option', { value: chat.key },
      `${chat.title}（${chat.chatType === 'group' ? '群聊' : '私聊'} · ${chat.messages} 条）`));
  }
  if (prev) sel.value = prev;
}

/* ------------------------------ 启动 ------------------------------ */

async function load() {
  try {
    const res = await api('/api/patch/status');
    state.status = res;
    state.config = res.config;
    state.chats = res.chats || [];
    fillSharedForm();
    fillLinksForm();
    renderPreviewOptions();
    renderStatus();
    renderDiag();
  } catch (err) {
    toast('读取状态失败：' + err.message, 'err');
    $('status-error').textContent = '读取补丁状态失败：' + err.message;
    $('status-error').classList.remove('hidden');
  }
}

function bind() {
  $('reload').addEventListener('click', (e) => { e.preventDefault(); load(); });
  $('shared-save').addEventListener('click', saveShared);
  $('scope-add').addEventListener('click', newScope);
  $('scope-groups').addEventListener('click', () => addScopeWithChats('全部群聊（自动）', ['*'], true, 'group'));
  $('scope-privates').addEventListener('click', () => addScopeWithChats('全部私聊（自动，确认隐私后启用）', ['*'], false, 'private'));
  $('preview-run').addEventListener('click', previewShared);
  $('links-save').addEventListener('click', saveLinks);
  $('test-run').addEventListener('click', testLink);
  $('cache-clear').addEventListener('click', async () => {
    try {
      await api('/api/patch/clear-cache', { method: 'POST', body: '{}' });
      toast('链接缓存已清空');
    } catch (err) {
      toast('清空失败：' + err.message, 'err');
    }
  });
  $('test-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') testLink(); });
  $('preview-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') previewShared(); });
}

function addDirtyBadge() {
  const head = document.querySelector('.scopes-head');
  if (!head || $('dirty-badge')) return;
  head.append(el('span', { id: 'dirty-badge', class: 'pill warn hidden', text: '有未保存的改动' }));
}

addDirtyBadge();
bind();
load();
