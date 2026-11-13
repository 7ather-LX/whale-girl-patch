'use strict';

/**
 * 无头浏览器渲染：给「必须执行 JS 才看得到内容」的站点用（小黑盒、微博、知乎……）。
 *
 * 为什么不用 Playwright/Puppeteer：鲸鲸是「零 npm 依赖」安装包，加一个 Node 依赖
 * 等于要求用户重新装环境。Windows 10/11 自带 Edge，直接调用它的 headless 模式最省事。
 *
 * 几个关键取舍：
 *   - **不通过管道读 stdout**：Chrome 的 --dump-dom 输出很大，管道在部分沙箱/杀软
 *     环境下会 EPERM。这里直接把 stdout/stderr 重定向到临时文件（fd），最稳。
 *   - 每次一个全新 user-data-dir：不共享 Cookie，一个站的登录态不会漏到另一个站。
 *   - 只对 browserDomains 里的域名启动浏览器，避免被任意链接牵着跑。
 *   - 同一时间只跑一个实例（串行队列），不把用户电脑拖死。
 *   - 鲸鲸可能由启动器以管理员权限启动，Chromium 的沙箱会直接退出；默认带
 *     --no-sandbox，并且 new/old/legacy 三种 headless 模式依次回退。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const policy = require('./policy');

const QUEUE_GAP_MS = 150;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return '';
}

/** @returns {{path:string,name:string}|null} */
function findBrowser(linksCfg = {}) {
  const pref = String(linksCfg.browser || 'auto').trim();
  if (pref === 'off') return null;

  if (pref && pref !== 'auto' && pref !== 'edge' && pref !== 'chrome') {
    if (fs.existsSync(pref)) return { path: pref, name: path.basename(pref) };
  }

  const envPath = String(process.env.WHALE_PATCH_BROWSER || '').trim();
  if (envPath && fs.existsSync(envPath)) return { path: envPath, name: path.basename(envPath) };

  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';

  const edge = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const chrome = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  const order = pref === 'chrome' ? [...chrome, ...edge] : [...edge, ...chrome];
  const found = firstExisting(order);
  if (!found) return null;
  return { path: found, name: path.basename(found, '.exe') };
}

function allowedByConfig(host, linksCfg) {
  return policy.matchDomain(host, linksCfg.browserDomains);
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
  } catch {
    /* 浏览器子进程可能还没退干净，留到下次启动再清 */
  }
}

/** 启动时清掉上次残留的临时目录（最多保留最近 3 个） */
function sweep(root, keep = 3) {
  const base = path.join(root, 'data', 'whale-patch', 'browser');
  let names = [];
  try {
    names = fs.readdirSync(base)
      .filter((n) => n.startsWith('run-'))
      .map((n) => ({ n, t: fs.statSync(path.join(base, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(keep)
      .map((x) => x.n);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    cleanupDir(path.join(base, n));
    removed += 1;
  }
  return removed;
}

function readTail(file, max = 1200) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.slice(-max).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** 一次尝试：指定 headless 模式，stdout/stderr 都写文件 */
function attempt(url, { base, budget, browser, headless, single = false }) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(base, 'run-'));
    const profile = path.join(dir, 'profile');
    const outFile = path.join(dir, 'dom.html');
    const errFile = path.join(dir, 'browser.log');
    fs.mkdirSync(profile, { recursive: true });

    const args = [
      headless,
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--metrics-recording-only',
      '--mute-audio',
      '--hide-scrollbars',
      '--window-size=1280,2000',
      `--user-data-dir=${profile}`,
      `--virtual-time-budget=${budget}`,
      '--dump-dom',
      url,
    ];
    if (single) {
      args.splice(1, 0,
        '--single-process',
        '--no-zygote',
        '--disable-crash-reporter',
        '--disable-breakpad');
    }

    let outFd = null;
    let errFd = null;
    let child = null;
    let finished = false;
    let timer = null;

    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try { if (outFd !== null) fs.closeSync(outFd); } catch { /* ignore */ }
      try { if (errFd !== null) fs.closeSync(errFd); } catch { /* ignore */ }
      cleanupDir(dir);
      resolve(value);
    };

    try {
      outFd = fs.openSync(outFile, 'w');
      errFd = fs.openSync(errFile, 'w');
      child = spawn(browser.path, args, {
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        cwd: os.tmpdir(),
      });
    } catch (err) {
      return finish({ ok: false, error: (err && err.code) || 'spawn_failed' });
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch { /* ignore */ }
    }, budget + 5000);

    child.on('error', (err) => {
      const detail = readTail(errFile, 300);
      finish({ ok: false, error: (err && err.code) || 'spawn_failed', detail });
    });
    child.on('close', (code) => {
      let html = '';
      try {
        const stat = fs.statSync(outFile);
        if (stat.size > MAX_HTML_BYTES) return finish({ ok: false, error: 'too_large', code });
        html = fs.readFileSync(outFile, 'utf8');
      } catch {
        return finish({ ok: false, error: 'empty', code, detail: readTail(errFile) });
      }
      if (!html || html.length < 200) {
        return finish({ ok: false, error: 'empty', code, detail: readTail(errFile) });
      }
      finish({ ok: true, html, finalUrl: url, browser: browser.name });
    });
  });
}

/** 依次尝试 new / old / legacy 三种 headless 参数（Edge 版本差异很大） */
async function renderOnce(url, opts) {
  const {
    root,
    timeoutMs = 12000,
    browser,
  } = opts;

  const base = path.join(root, 'data', 'whale-patch', 'browser');
  fs.mkdirSync(base, { recursive: true });

  const deadline = Date.now() + Math.max(2500, Math.min(20000, Number(timeoutMs) || 12000));
  const variants = [
    { headless: '--headless=new' },
    { headless: '--headless=old', single: true },
    { headless: '--headless', single: true },
  ];
  let last = { ok: false, error: 'empty' };

  for (const variant of variants) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    const budget = Math.max(1200, Math.min(8000, left - 500));
    const result = await attempt(url, { base, budget, browser, ...variant });
    if (result.ok) return result;
    last = result;
    // 参数不兼容通常 <1s 就退出；如果是超时，换参数意义不大
    if (result.error === 'timeout') break;
  }
  return last;
}

let tail = Promise.resolve();

/**
 * 渲染一个页面。串行执行，避免同时开多个无头浏览器。
 * @returns {Promise<{ok:boolean,html?:string,text?:string,error?:string,detail?:string,browser?:string}>}
 */
function render(url, opts = {}) {
  const linksCfg = opts.linksCfg || {};
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return Promise.resolve({ ok: false, error: 'bad_url' });
  }
  if (!allowedByConfig(host, linksCfg)) return Promise.resolve({ ok: false, error: 'browser_domain_not_allowed' });

  const browser = opts.browser || findBrowser(linksCfg);
  if (!browser) return Promise.resolve({ ok: false, error: 'browser_not_found' });

  const run = () => renderOnce(url, { ...opts, linksCfg, browser }).then((result) => {
    return new Promise((resolve) => setTimeout(() => resolve(result), QUEUE_GAP_MS));
  });

  const job = tail.then(run, run);
  tail = job.then(() => null, () => null);
  return job;
}

module.exports = { findBrowser, render, sweep, allowedByConfig, cleanupDir };
