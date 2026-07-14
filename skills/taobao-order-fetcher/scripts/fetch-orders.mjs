#!/usr/bin/env node
/**
 * 淘宝千牛待发货订单抓取
 *
 * 导航到打单中心采用「四步法」（2026-07-13 老板重设）：
 *   第一步：保证浏览器可用（CDP）
 *   第二步：导航到打单中心，如果已经有该界面则刷新
 *   第三步：判断打单中心是否可用；如果不可用 → 走登录流程
 *   第四步：再次判断打单中心是否可用；如果仍不可用 → 报错退出
 *
 * 自动检测/启动 Chrome CDP：
 *   - 先检查 9222 端口是否已有 Chrome CDP
 *   - 有 → 连接复用
 *   - 无 → 启动新 Chromium
 *
 * 登录失败处理（MAX_LOGIN_ATTEMPTS = 3）：
 *   - 凭据缺失 → 直接报错退出（提示传入 --user/--pass）
 *   - 累计失败 < 3 次 → 等待 5 秒后重试
 *   - 累计失败 ≥ 3 次 → 输出 ADMIN_ALERT marker + exit 1
 *     （agent / cron 见到 marker 后应把消息路由到当前对话 channel）
 *
 * 日期精度：秒
 *
 * 用法:
 *   node fetch-orders.mjs --start 2026-06-10              # end=现在，start=00:00:00
 *   node fetch-orders.mjs --start "2026-06-10 08:00:00"  # 带时分秒
 *   node fetch-orders.mjs --start 2026-06-10 --end "2026-06-11 12:30:00"
 *   node fetch-orders.mjs --all                          # 全部订单（清空时间筛选）
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';

const PLATFORM = process.platform;                              // 'linux' | 'win32' | 'darwin'
const HOME = os.homedir();                                      // 跨平台 home 目录

// 数据导出目录：
//   Linux/macOS: ~/lab/taobao/data
//   Windows:     D:\tools\orders  （2026-07-14 老板指定，独立盘符不挤系统盘）
const DATA_DIR = PLATFORM === 'win32'
  ? 'D:\\tools\\orders'
  : path.join(HOME, 'lab', 'taobao', 'data');

// 浏览器 user-data-dir：跨平台
//   Linux:   ~/.cache/chrome-cdp-profile
//   macOS:   ~/.cache/chrome-cdp-profile
//   Windows: %LOCALAPPDATA%\chrome-cdp-profile（避免 C:\ 根目录权限问题）
const USER_DATA_DIR = PLATFORM === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'chrome-cdp-profile')
  : path.join(HOME, '.cache', 'chrome-cdp-profile');

const DEFAULT_PORT = 9222;

// 登录失败最大尝试次数：超过会触发管理员提醒（见 autoLoginWithRetry / emitAdminAlert）
const MAX_LOGIN_ATTEMPTS = 3;

// 千牛页面 URL
const QN_HOME = 'https://qn.taobao.com';
const QN_WORKBENCH = 'https://myseller.taobao.com/home.htm/QnworkbenchHome/';
const DADAN_PAGE = 'https://myseller.taobao.com/home.htm/qn-order/unshipped';

// ---- 命令行参数 ----

function parseArgs() {
  const args = { start: null, end: null, port: DEFAULT_PORT, user: null, pass: null, all: false };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--start' && process.argv[i + 1]) args.start = process.argv[++i];
    if (process.argv[i] === '--end' && process.argv[i + 1]) args.end = process.argv[++i];
    if (process.argv[i] === '--port' && process.argv[i + 1]) args.port = parseInt(process.argv[++i]);
    if (process.argv[i] === '--user' && process.argv[i + 1]) args.user = process.argv[++i];
    if (process.argv[i] === '--pass' && process.argv[i + 1]) args.pass = process.argv[++i];
    if (process.argv[i] === '--all') args.all = true;
  }
  return args;
}

/**
 * 是否「全部订单」模式
 * 触发：显式 --all，或既不传 --start 也不传 --end
 */
function isAllMode(args) {
  return args.all || (!args.start && !args.end);
}

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}]`, msg); }

// ---- 日期处理 ----

// 获取当前时间 YYYY-MM-DD HH:mm:ss
function nowStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

// 解析日期：支持 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm:ss" 或 "YYYY-MM-DD HH:mm"
// 如果只有日期，补 00:00:00
function normalizeDate(val, isEnd) {
  if (!val) return null;
  
  val = val.trim();
  
  // 尝试匹配 YYYY-MM-DD HH:mm:ss
  let match = val.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    return `${match[1]} ${match[2]}:${match[3]}:${match[4]}`;
  }
  
  // 尝试匹配 YYYY-MM-DD HH:mm（补 :00）
  match = val.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);
  if (match) {
    return `${match[1]} ${match[2]}:${match[3]}:00`;
  }
  
  // 只有日期
  match = val.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (match) {
    if (isEnd) {
      return nowStr();
    }
    return `${match[1]} 00:00:00`;
  }
  
  return null;
}

// 子目录：YYYY-MM-DD/startHHmmss_to_endHHmmss/
function dateDirPath(start, end) {
  const [dateS, timeS] = start.split(' ');
  const [dateE, timeE] = end.split(' ');
  const timeDir = `${timeS.replace(/:/g, '')}_to_${timeE.replace(/:/g, '')}`;
  return path.join(dateS, timeDir);
}

// 全部订单模式子目录：YYYY-MM-DD/all_HHMMSS/（HHMMSS 为导出时刻）
function allDirPath() {
  const now = nowStr();                       // '2026-06-30 17:42:39'
  const [datePart, timePart] = now.split(' ');
  const timeStr = timePart.replace(/:/g, ''); // '174239'
  return path.join(datePart, `all_${timeStr}`);
}

// ---- CDP 检测与浏览器管理 ----

async function checkCDP(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ running: true, browser: json.Browser, wsUrl: json.webSocketDebuggerUrl });
        } catch { resolve({ running: false }); }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.setTimeout(2000, () => { req.destroy(); resolve({ running: false }); });
  });
}

/**
 * 跨平台查找可用的 Chromium / Chrome / Edge 二进制
 * 返回 { bin, label, needUserDataDir } 或 null（找不到时）
 *
 * Linux:   snap chromium  >  Playwright 缓存 chromium-1223
 * Windows: Playwright 缓存 chromium-1223  >  系统 Chrome  >  系统 Edge
 * macOS:   Playwright 缓存 chromium-1223
 *
 * needUserDataDir:
 *   - snap / 系统 Chrome/Edge：用各自默认 profile，无需指定 user-data-dir（保留登录态）
 *   - Playwright bundled：必须指定 user-data-dir，否则每次启动都是新 profile
 */
function findChromeBin() {
  if (PLATFORM === 'linux') {
    // 1. snap chromium（默认 profile，无需 user-data-dir）
    if (fs.existsSync('/snap/bin/chromium')) {
      return { bin: '/snap/bin/chromium', label: 'snap chromium (默认 profile)', needUserDataDir: false };
    }
    // 2. Playwright 缓存（chromium-1223 是当前脚本锁定版本）
    const bundled = path.join(HOME, '.cache', 'ms-playwright', 'chromium-1223', 'chrome-linux64', 'chrome');
    if (fs.existsSync(bundled)) {
      return { bin: bundled, label: 'Playwright bundled chromium-1223', needUserDataDir: true };
    }
    return null;
  }

  if (PLATFORM === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    // 1. Playwright 缓存（推荐，跟脚本逻辑完全兼容）
    const bundled = path.join(localAppData, 'ms-playwright', 'chromium-1223', 'chrome-win', 'chrome.exe');
    if (fs.existsSync(bundled)) {
      return { bin: bundled, label: 'Playwright bundled chromium-1223', needUserDataDir: true };
    }
    // 2. 系统装的 Chrome / Edge
    //    注意：必须用独立 profile 强制新进程！
    //    Windows 系统 Chrome/Edge 有单实例合并行为——
    //    当系统已有 Edge 在跑时，不带 --user-data-dir 启动 msedge.exe，
    //    命令行参数（含 --remote-debugging-port）会被丢弃，
    //    URL 转发到现有窗口的 tab，CDP 永远起不来。
    //    独立 profile 目录跟默认 profile 不冲突，强制出独立进程。
    //    代价：失去 Edge 默认 profile 的 cookies（脚本会自动登录兜底）
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const isEdge = c.toLowerCase().includes('edge');
        return { bin: c, label: `系统 ${isEdge ? 'Edge' : 'Chrome'} (独立 profile)`, needUserDataDir: true };
      }
    }
    return null;
  }

  if (PLATFORM === 'darwin') {
    // 1. Playwright 缓存
    const bundled = path.join(HOME, 'Library', 'Caches', 'ms-playwright', 'chromium-1223', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (fs.existsSync(bundled)) {
      return { bin: bundled, label: 'Playwright bundled chromium-1223', needUserDataDir: true };
    }
    // 2. 系统装的 Chrome
    const sysChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(sysChrome)) {
      return { bin: sysChrome, label: '系统 Chrome (默认 profile)', needUserDataDir: false };
    }
    return null;
  }

  return null;
}

async function ensureBrowser(port) {
  const cdp = await checkCDP(port);
  if (cdp.running) {
    log(`检测到已有浏览器: ${cdp.browser}`);
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  }

  log('未检测到浏览器，启动新的 Chromium...');

  // 跨平台查找浏览器二进制（snap / Playwright 缓存 / 系统 Chrome / Edge）
  const chromeInfo = findChromeBin();
  if (!chromeInfo) {
    const installHint = PLATFORM === 'win32'
      ? `请先安装：
  • npx playwright install chromium （推荐，下载 Playwright 自带版本）
  • 或安装 Chrome: https://www.google.com/chrome/
  • 或安装 Edge: Win10/11 自带，无需额外装`
      : PLATFORM === 'darwin'
      ? `请先安装：
  • npx playwright install chromium （推荐）
  • 或 brew install --cask google-chrome`
      : `请先安装：
  • sudo snap install chromium （推荐，默认 profile 持久化登录态）
  • 或 npx playwright install chromium`;
    throw new Error(`找不到可用的 Chromium / Chrome / Edge\n${installHint}`);
  }
  log(`使用浏览器: ${chromeInfo.bin}`);
  log(`  (${chromeInfo.label}, 平台: ${PLATFORM})`);

  // 确保 user-data-dir 存在（Playwright bundled 模式需要）
  if (chromeInfo.needUserDataDir) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  // 确保数据导出目录存在（Windows 上 D:\tools\orders 可能还没建）
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    throw new Error(`无法创建数据目录 ${DATA_DIR}: ${e.message}\n请检查路径权限或盘符是否存在`);
  }

  // headed 模式（老板要求）：不要 headless，浏览器窗口老板能看到
  // 2026-07-01 改：去掉 --headless=new 和 --disable-gpu，让 snap chromium 用 X11
  // 原因：headless 模式下阿里云盾 nc 滑块行为检测更严，登录卡死
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // Playwright bundled 需要显式 user-data-dir；snap / 系统浏览器用默认 profile
  if (chromeInfo.needUserDataDir) {
    chromeArgs.push(`--user-data-dir=${USER_DATA_DIR}`);
  }
  chromeArgs.push(QN_HOME);

  const { spawn } = await import('child_process');
  const spawnOpts = {
    detached: true,
    stdio: 'ignore',
    // Windows 上：默认 shell:false 即可，Node 会正确处理带空格的 .exe 路径
    // 不能设 shell:true（会把整个 cmd 字符串当成命令，破坏参数传递）
  };
  const child = spawn(chromeInfo.bin, chromeArgs, spawnOpts);
  child.unref();

  // 等 CDP 就绪
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const cdp = await checkCDP(port);
    if (cdp.running) {
      log(`Chromium 已启动 (CDP port: ${port}, profile: ${USER_DATA_DIR})`);
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    }
    if (i % 5 === 4) log(`  等待 CDP 就绪... (${(i + 1) * 1.5}s)`);
  }
  throw new Error('Chromium 启动超时（30秒）');
}

// ---- 页面操作 ----

/**
 * 查找或创建千牛工作台页面
 * 优先找已有页面，找不到则从千牛首页开始
 */
async function findOrOpenPage(browser) {
  // 1. 查找已有工作台/打单/千牛首页页面（优先打单中心 > 工作台 > 千牛首页）
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  for (const p of pages) {
    const url = p.url();
    if (url.includes('qn-order/unshipped')) {
      log(`复用已有打单中心页面`);
      return p;
    }
  }
  for (const p of pages) {
    const url = p.url();
    if (url.includes('myseller.taobao') && !url.includes('login')) {
      log(`复用已有工作台页面`);
      return p;
    }
  }
  for (const p of pages) {
    const url = p.url();
    if (url === QN_HOME || url.startsWith('https://qn.taobao.com/')) {
      log(`复用已有千牛首页`);
      return p;
    }
  }

  // 2. 没有则新建页面
  const page = await ctx.newPage();
  await page.goto(QN_HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
  log('已打开千牛首页');
  return page;
}

/**
 * 尝试用凭据自动登录（参数优先，其次环境变量）
 * 返回: { success, error }
 */
async function tryAutoLogin(browser, page, cmdArgs) {
  const user = cmdArgs?.user || process.env.TAOBAO_USER;
  const pass = cmdArgs?.pass || process.env.TAOBAO_PASS;

  if (!user || !pass) {
    return { success: false, error: '未设置凭据。请用 --user 和 --pass 参数或 TAOBAO_USER / TAOBAO_PASS 环境变量' };
  }

  log(`尝试自动登录 (${user})...`);

  // 获取所有页面，找登录页
  const pages = await browser.contexts()[0].pages();
  let loginPage = pages.find(p => p.url().includes('loginmyseller'));

  if (!loginPage) {
    // 在千牛首页，点击登录按钮
    log('点击「登录千牛」...');
    await page.click('text=登录千牛');
    await new Promise(r => setTimeout(r, 3000));
    const newPages = await browser.contexts()[0].pages();
    loginPage = newPages.find(p => p.url().includes('loginmyseller'));
    if (!loginPage) {
      return { success: false, error: '点击登录后未找到登录页' };
    }
  }

  await loginPage.bringToFront();

  // 登录表单在 iframe 内
  const frame = loginPage.frames().find(f => f.url().includes('havanalogin'));
  if (!frame) {
    return { success: false, error: '找不到登录 iframe (havanalogin)' };
  }

  // 切到密码登录
  await frame.click('text=密码登录');
  await new Promise(r => setTimeout(r, 1000));

  // 填表
  await frame.locator('#fm-login-id').fill(user);
  await frame.locator('#fm-login-password').fill(pass);

  // 登录
  await frame.locator('button:has-text("登录")').click();
  await new Promise(r => setTimeout(r, 8000));

  // 检查结果
  const errorText = await frame.evaluate(() => {
    const el = document.querySelector('.error, [class*=error]');
    return el?.innerText || null;
  }).catch(() => null);

  if (errorText) {
    return { success: false, error: `登录失败: ${errorText}` };
  }

  // 检查是否跳转成功
  const currentUrl = loginPage.url();
  if (currentUrl.includes('login')) {
    return { success: false, error: '登录后仍在登录页，可能凭据错误或需要验证' };
  }

  log('✅ 自动登录成功');
  return { success: true };
}

/**
 * 判断「打单中心是否可用」
 * 三条全部满足才算可用：
 *   1. URL 在打单中心页面（qn-order/unshipped）
 *   2. URL 没被重定向到登录页
 *   3. 页面已渲染出关键 UI（导出 / 搜索 按钮存在）
 *
 * 返回 true / false；任何评估异常都视为不可用（让上层走登录兜底）
 */
async function isDadanAvailable(page) {
  try {
    const url = page.url();
    if (!url.includes('qn-order/unshipped')) return false;
    if (url.includes('login')) return false;

    // 给 evaluate 套一层超时：打单中心有时首屏 DOM 还没渲染完
    const result = await Promise.race([
      page.evaluate(() => {
        const body = document.body?.innerText || '';
        // 关键 UI: 搜索 + 导出 都得在（导出是打单中心独有的按钮）
        return body.includes('搜索') && body.includes('导出');
      }),
      new Promise(resolve => setTimeout(() => resolve(false), 3000)),
    ]);
    return result === true;
  } catch (e) {
    log(`检查打单中心可用性失败: ${e.message}`);
    return false;
  }
}

/**
 * 自动登录（带重试 + 管理员提醒）
 *  - 凭据缺失 → 直接报错（不消耗重试次数）
 *  - 累计失败 < 3 次 → 等待 5 秒后重试
 *  - 累计失败 ≥ MAX_LOGIN_ATTEMPTS 次 → 输出 ADMIN_ALERT marker + exit 1
 *    agent / cron 见到 marker 后应把消息路由到当前对话 channel
 */
async function autoLoginWithRetry(browser, page, cmdArgs) {
  const user = cmdArgs?.user || process.env.TAOBAO_USER;
  const pass = cmdArgs?.pass || process.env.TAOBAO_PASS;

  // 没传凭据：直接报错，不走重试（避免无意义消耗 3 次）
  if (!user || !pass) {
    throw new Error(
      `无法登录千牛：未设置凭据\n` +
      `请传入凭据后重试：\n` +
      `  node fetch-orders.mjs --user "主账号:子账号" --pass "密码" --start "..."`
    );
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    log(`🔐 自动登录尝试 ${attempt}/${MAX_LOGIN_ATTEMPTS}...`);
    const result = await tryAutoLogin(browser, page, cmdArgs);

    if (result.success) {
      // 登录成功，跳转到打单中心
      await new Promise(r => setTimeout(r, 2000));
      try {
        await page.goto(DADAN_PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));
        if (page.url().includes('qn-order/unshipped')) {
          log('登录后已到达打单中心');
          return page;
        }
      } catch {}
      const finalPages = await browser.contexts()[0].pages();
      const wb = finalPages.find(p => p.url().includes('QnworkbenchHome'));
      return wb || page;
    }

    lastError = result.error;
    log(`❌ 第 ${attempt}/${MAX_LOGIN_ATTEMPTS} 次登录失败: ${result.error}`);

    if (attempt < MAX_LOGIN_ATTEMPTS) {
      log(`  等待 5 秒后重试...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 超过最大尝试次数 → 触发管理员提醒
  emitAdminAlert(lastError);
  process.exit(1);
}

/**
 * 输出管理员提醒 marker 到 stdout
 * 调用方（agent / cron）识别到 marker 后应把消息路由到当前对话 channel
 */
function emitAdminAlert(lastError) {
  const message =
    `千牛登录已连续失败 ${MAX_LOGIN_ATTEMPTS} 次\n` +
    `可能是账号/密码失效、Cookie 过期或被风控\n` +
    `请老板联系管理员处理！` +
    (lastError ? `\n（最后错误：${lastError}）` : '');

  console.log('\n' + '='.repeat(60));
  console.log('🚨 管理员提醒 / ADMIN ALERT');
  console.log('='.repeat(60));
  console.log(message);
  console.log('='.repeat(60) + '\n');
}

/**
 * 第二步：导航到打单中心
 * - 如果已有打单中心页面：刷新（拿最新订单/避免页面过期）
 * - 否则：直接 goto 打单中心 URL（绕过引导遮罩/菜单跳转等不稳定因素）
 *
 * 不在此处判断登录态 —— 登录交给第三步统一处理
 */
async function navigateToDadanCenter(browser) {
  const page = await findOrOpenPage(browser);
  const url = page.url();

  if (url.includes('qn-order/unshipped')) {
    log('第二步：已在打单中心，刷新页面...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  } else {
    log('第二步：导航到打单中心（直接URL）...');
    await page.goto(DADAN_PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }

  // 等页面渲染（千牛 SPA 首屏较慢）
  await new Promise(r => setTimeout(r, 5000));
  return page;
}

/**
 * 第三步 + 第四步：确保打单中心真正可用
 *   第三步：判断 → 不可用则走 autoLoginWithRetry
 *   第四步：登录后再次导航 + 再次判断 → 仍不可用则报错退出
 *
 * 错误统一由上层的 main().catch() 捕获并 exit 1
 */
async function ensureDadanAvailable(browser, page, cmdArgs) {
  // 第三步：首次判断（第二步只负责导航，不做可用性判断）
  if (await isDadanAvailable(page)) {
    log('✅ 第三步：打单中心可用，无需登录');
    return page;
  }

  log('⚠️ 第三步：打单中心不可用，触发登录流程...');
  page = await autoLoginWithRetry(browser, page, cmdArgs);

  // 第四步：登录成功 → 强制重新导航到打单中心，再判断一次
  log('第四步：登录后重新导航到打单中心...');
  try {
    await page.goto(DADAN_PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 5000));
  } catch (e) {
    log(`登录后导航到打单中心失败: ${e.message}`);
  }

  if (await isDadanAvailable(page)) {
    log('✅ 第四步：登录后打单中心可用');
    return page;
  }

  // 仍不可用：可能是登录失败 / 凭据错 / 风控拦截
  throw new Error(
    '登录后打单中心仍不可用。\n' +
    '可能原因：账号/密码错误、Cookie 失效、被风控拦截。\n' +
    '请检查 --user / --pass 或 TAOBAO_USER / TAOBAO_PASS 是否正确。'
  );
}

async function setDateRange(page, start, end) {
  log(`设置付款时间: ${start} ~ ${end}`);

  // 打单中心的日期筛选在「全部」折叠面板里，先判断是否需要展开
  const startInput = page.locator('input[placeholder="起始日期"]');
  const alreadyExpanded = await startInput.isVisible().catch(() => false);
  if (!alreadyExpanded) {
    try {
      const expandBtn = page.locator('button:has-text("全部")').first();
      if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expandBtn.click();
        await new Promise(r => setTimeout(r, 2000));
        log('已展开筛选面板');
      }
    } catch {}
  }

  // 千牛使用 Fusion DatePicker2 受控组件，必须 keyboard.type + 点确定
  // 加多重防护：等面板出现、清空旧值、验证结果、重试

  const setOne = async (placeholder, value, label) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      // 点输入框（打单中心的 datepicker 可能在 noborder 容器内，用 force 兜底）
      const input = page.locator(`input[placeholder="${placeholder}"]`);
      try {
        await input.click({ timeout: 5000 });
      } catch {
        log(`  ${label} 普通点击失败，尝试 force click...`);
        await input.click({ force: true, timeout: 3000 });
      }

      // 等日期面板出现
      try {
        await page.waitForSelector('.next-date-picker2-overlay', { state: 'visible', timeout: 3000 });
      } catch {
        // 面板可能已经开着，重试
        if (attempt < 2) { await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 300)); continue; }
      }

      // 清空旧值：全选 + 删除
      await page.keyboard.press('Control+A');
      await new Promise(r => setTimeout(r, 100));
      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, 200));

      // 逐字输入
      await page.keyboard.type(value, { delay: 30 });
      await new Promise(r => setTimeout(r, 400));

      // 等确定按钮可点
      try {
        await page.waitForSelector('.next-date-picker2-footer-ok:not([disabled])', { timeout: 3000 });
      } catch {}

      // 点确定
      await page.click('.next-date-picker2-footer-ok');
      await new Promise(r => setTimeout(r, 500));

      // 验证
      const actual = await page.$eval(`input[placeholder="${placeholder}"]`, el => el.value);
      if (actual === value) {
        log(`  ${label}: ${value} ✅`);
        return;
      }
      log(`  ${label} 设置失败 (${actual}), 重试...`);
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`${label} 设置失败，已重试3次`);
  };

  await setOne('起始日期', start, '起始');
  await setOne('结束日期', end, '结束');
}

/**
 * 清空时间筛选（全部订单模式）
 * 流程：展开「全部」筛选面板 → 清空起始/结束输入框 → 不点确定
 */
async function clearDateRange(page) {
  log('清空时间筛选（全部订单模式）...');

  // 打单中心的日期筛选在「全部」折叠面板里，先判断是否需要展开
  const startInput = page.locator('input[placeholder="起始日期"]');
  const alreadyExpanded = await startInput.isVisible().catch(() => false);
  if (!alreadyExpanded) {
    try {
      const expandBtn = page.locator('button:has-text("全部")').first();
      if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expandBtn.click();
        await new Promise(r => setTimeout(r, 2000));
        log('已展开筛选面板');
      }
    } catch {}
  }

  // 清空两个输入框（click → 全选 → 删除 → Esc，不点确定避免触发默认时间）
  for (const placeholder of ['起始日期', '结束日期']) {
    try {
      const input = page.locator(`input[placeholder="${placeholder}"]`);
      const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
      if (!visible) {
        log(`  ${placeholder} 不可见，跳过`);
        continue;
      }
      try {
        await input.click({ timeout: 5000 });
      } catch {
        await input.click({ force: true, timeout: 3000 });
      }
      // 等日期面板出现
      try {
        await page.waitForSelector('.next-date-picker2-overlay', { state: 'visible', timeout: 2000 });
      } catch {}
      await page.keyboard.press('Control+A');
      await new Promise(r => setTimeout(r, 100));
      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, 200));
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 300));

      const actual = await page.$eval(`input[placeholder="${placeholder}"]`, el => el.value).catch(() => '');
      log(`  ${placeholder}: 已清空${actual ? ` (残留 "${actual}")` : ''} ✅`);
    } catch (e) {
      log(`  ${placeholder} 清空失败: ${e.message}`);
    }
  }
}

async function searchOrders(page) {
  log('搜索订单...');
  await page.click('button:has-text("搜索")');
  await new Promise(r => setTimeout(r, 4000));

  // 直接数订单表格里的数据行（不是「全部」标签的总数）
  const count = await page.evaluate(() => {
    // 找订单表格的数据行：排除暂无数据、表头、loading等
    const tbody = document.querySelector('[class*="table"] tbody');
    if (!tbody) return 0;
    const rows = tbody.querySelectorAll('tr');
    // 过滤掉"暂无数据"行
    const dataRows = [...rows].filter(r => !r.textContent?.includes('暂无数据'));
    return dataRows.length;
  });
  return count;
}

async function exportOrders(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DATA_DIR
    });
  } catch (e) {
    log('警告: CDP下载行为设置失败: ' + e.message);
  }

  const beforeFiles = new Set(fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.xlsx')));

  log('触发导出...');
  await page.click('button:has-text("导出")');
  await new Promise(r => setTimeout(r, 800));
  await page.click('text=按查询结果导出');

  // 检测「导出时间过长」弹窗
  await new Promise(r => setTimeout(r, 2000));
  const isAsync = await page.evaluate(() => {
    const body = document.body.innerText;
    return body.includes('导出时间过长') || body.includes('导出记录里面进行查看');
  });

  if (isAsync) {
    log('检测到异步导出，关闭弹窗...');
    // 点确定或关闭按钮
    await page.click('button:has-text("确定")').catch(() => {});
    await page.click('[class*="dialog"] button:has-text("确定")').catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // 打开导出记录（在导出按钮的下拉菜单里）
    log('打开导出记录页面...');
    await page.click('button:has-text("导出")');
    await new Promise(r => setTimeout(r, 800));
    await page.click('text=导出记录');
    await new Promise(r => setTimeout(r, 3000));

    // 等导出完成并下载
    log('等待异步导出完成...');
    for (let i = 0; i < 120; i++) {
      // 尝试点下载按钮
      const downloadBtn = page.locator('text=下载').first();
      if (await downloadBtn.isVisible().catch(() => false)) {
        const rowText = await page.evaluate(() => {
          const rows = document.querySelectorAll('tr, [class*="row"]');
          return [...rows].slice(0, 5).map(r => r.textContent?.trim().slice(0, 100));
        });
        log('导出记录行: ' + JSON.stringify(rowText));
        await downloadBtn.click();
        await new Promise(r => setTimeout(r, 3000));
        break;
      }

      // 同时检查是否直接下载了
      const currentFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.xlsx') && !f.endsWith('.crdownload'));
      for (const f of currentFiles) {
        if (!beforeFiles.has(f)) {
          const p = path.join(DATA_DIR, f);
          try {
            const stat = fs.statSync(p);
            if (stat.size > 0) {
              log(`异步下载完成: ${f} (${(stat.size / 1024).toFixed(1)} KB)`);
              return { name: f, size: stat.size, path: p };
            }
          } catch {}
        }
      }

      await new Promise(r => setTimeout(r, 2000));
      if (i % 15 === 14) log(`  已等待 ${(i + 1) * 2} 秒...`);
    }
  }

  // 正常下载流程
  log('等待下载完成...');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const currentFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.xlsx'));
    for (const f of currentFiles) {
      if (beforeFiles.has(f)) continue;
      if (f.endsWith('.crdownload')) continue;
      const p = path.join(DATA_DIR, f);
      try {
        const stat = fs.statSync(p);
        if (stat.size > 0) {
          log(`下载完成: ${f} (${(stat.size / 1024).toFixed(1)} KB)`);
          return { name: f, size: stat.size, path: p };
        }
      } catch {}
    }
  }
  // 超时兜底：再检查一次，避免漏掉刚完成的下载
  await new Promise(r => setTimeout(r, 2000));
  const lateFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.xlsx'));
  for (const f of lateFiles) {
    if (beforeFiles.has(f)) continue;
    const p = path.join(DATA_DIR, f);
    try {
      const stat = fs.statSync(p);
      if (stat.size > 0) {
        log(`超时后找回: ${f} (${(stat.size / 1024).toFixed(1)} KB)`);
        return { name: f, size: stat.size, path: p };
      }
    } catch {}
  }
  throw new Error('下载超时（60秒）');
}

// ---- 主流程 ----

async function main() {
  const args = parseArgs();
  const isAll = isAllMode(args);

  // 日期处理
  let start = null, end = null;
  if (!isAll) {
    start = normalizeDate(args.start, false);
    end = normalizeDate(args.end || nowStr(), true);

    if (!start) {
      console.error('用法:');
      console.error('  node fetch-orders.mjs --start YYYY-MM-DD [--end "YYYY-MM-DD HH:mm"]');
      console.error('  node fetch-orders.mjs --all    # 全部订单（清空时间筛选）');
      console.error('提示：起始日期必填（除非用 --all），结束日期默认当前时间');
      process.exit(1);
    }

    log(`付款时间: ${start} ~ ${end}`);
  } else {
    log('📋 全部订单模式：不设时间筛选');
  }

  // 第一步：保证浏览器可用（CDP）
  const browser = await ensureBrowser(args.port);

  try {
    // 第二步：导航到打单中心，如果已经有该界面则刷新
    let page = await navigateToDadanCenter(browser);

    // 第三步 + 第四步：判断打单中心是否可用 → 不可用则登录 → 再次判断 → 仍不可用则报错
    page = await ensureDadanAvailable(browser, page, args);

    // 后续：正常导出流程
    if (isAll) {
      await clearDateRange(page);
    } else {
      await setDateRange(page, start, end);
    }

    // 搜索
    const count = await searchOrders(page);
    if (count === 0) {
      log(isAll ? '当前没有待发货订单' : '该时段没有订单');
      process.exit(0);
    }

    // 导出
    const file = await exportOrders(page);

    // 移动到日期子目录
    const subDir = path.join(
      DATA_DIR,
      isAll ? allDirPath() : dateDirPath(start, end)
    );
    fs.mkdirSync(subDir, { recursive: true });
    const destPath = path.join(subDir, file.name);
    fs.renameSync(file.path, destPath);
    log(`已移动至: ${destPath}`);

    log('✅ 完成');
    console.log(destPath);
    process.exit(0);
  } finally {
    // 不关闭浏览器
  }
}

main().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
