#!/usr/bin/env node
/**
 * 淘宝千牛待发货订单抓取
 * 
 * 自动检测/启动 Chrome CDP：
 *   1. 先检查 9222 端口是否已有 Chrome CDP
 *   2. 有 → 连接复用
 *   3. 无 → 启动新 Chromium
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

const DATA_DIR = path.join(process.env.HOME, 'lab/taobao/data');
const USER_DATA_DIR = path.join(process.env.HOME, '.cache/chrome-cdp-profile');
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

async function ensureBrowser(port) {
  const cdp = await checkCDP(port);
  if (cdp.running) {
    log(`检测到已有浏览器: ${cdp.browser}`);
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  }

  log('未检测到浏览器，启动新的 Chromium...');
  // 确保 user-data-dir 存在
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  // 优先 snap Chromium（用默认 profile，无需 --user-data-dir）
  // fallback: Playwright 缓存的 Chromium
  let chromeBin = '/snap/bin/chromium';
  let isSnap = true;
  if (!fs.existsSync(chromeBin)) {
    chromeBin = path.join(process.env.HOME, '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
    isSnap = false;
  }
  log(`使用浏览器: ${chromeBin}${isSnap ? ' (snap, 默认profile)' : ''}`);

  // headed 模式（老板要求）：不要 headless，浏览器窗口在 DISPLAY=:0 上老板能看到
  // 2026-07-01 改：去掉 --headless=new 和 --disable-gpu，让 snap chromium 用 X11
  // 原因：headless 模式下阿里云盾 nc 滑块行为检测更严，登录卡死
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // snap 用默认 profile，不传 --user-data-dir；非 snap 需要指定
  if (!isSnap) {
    chromeArgs.push(`--user-data-dir=${USER_DATA_DIR}`);
  }
  chromeArgs.push(QN_HOME);
  const { spawn } = await import('child_process');
  const child = spawn(chromeBin, chromeArgs, { detached: true, stdio: 'ignore' });
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
 * 检测登录状态
 * 返回: { needsLogin, reason, loginPage }
 */
async function detectLoginState(page) {
  const url = page.url();

  // 已在工作台或订单页 → 已登录
  if ((url.includes('myseller.taobao') || url.includes('qn-order')) && !url.includes('login')) {
    return { needsLogin: false };
  }

  // 在千牛首页 → 需要点「登录千牛」
  if (url === QN_HOME || url.startsWith(QN_HOME)) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 200));
    if (bodyText.includes('登录千牛') || bodyText.includes('欢迎登录')) {
      log('检测到千牛首页，需要登录');
      return { needsLogin: true, reason: '在千牛首页，需要点击登录' };
    }
  }

  // 在 loginmyseller 登录页
  if (url.includes('loginmyseller') || url.includes('login')) {
    return { needsLogin: true, reason: '在登录页面' };
  }

  // 未知状态，假定已登录
  return { needsLogin: false };
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
 * 确保已登录：三层策略
 * 1. 已有 session（user-data-dir 持久化）→ 直接过
 * 2. 有环境变量凭据 → 自动填表登录
 * 3. 什么都没有 → 报错退出
 */
async function ensureLoggedIn(browser, cmdArgs) {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();

  // 查找工作台页面
  let workbenchPage = pages.find(p =>
    p.url().includes('myseller.taobao') && !p.url().includes('login')
  );

  if (workbenchPage) {
    log('✅ 检测到已有登录态，跳过登录');
    return workbenchPage;
  }

  // 找一个页面来检测状态
  let page = pages.find(p => !p.url().startsWith('chrome-extension'));
  if (!page) {
    const newCtx = browser.contexts()[0];
    page = await newCtx.newPage();
    await page.goto(QN_HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }

  const state = await detectLoginState(page);

  if (!state.needsLogin) {
    // 看似已登录，实际验证一下：跳转到工作台
    log('看似已登录，验证中...');
    try {
      await page.goto(DADAN_PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));
      if (page.url().includes('qn-order/unshipped')) {
        log('✅ 登录态验证通过');
        return page;
      }
      if (page.url().includes('login')) {
        log('⚠️ 被重定向到登录页，登录态已过期');
      }
    } catch (e) {
      log(`验证跳转失败: ${e.message}`);
    }
    // 验证失败，继续走登录流程
  }

  if (state.needsLogin) {
    log(`需要登录: ${state.reason}`);
  } else {
    log('登录态验证失败，执行重新登录...');
  }

  // 尝试自动登录（最多 MAX_LOGIN_ATTEMPTS 次，失败超限触发管理员提醒）
  return await autoLoginWithRetry(browser, page, cmdArgs);
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
 * 从千牛工作台导航到打单中心（打单工具）
 * 优先直接 URL goto（稳定），菜单导航作为降级（可能有引导遮罩/自动跳转干扰）
 */
async function navigateToDadan(page) {
  const url = page.url();

  // 已在打单中心，直接返回
  if (url.includes('qn-order/unshipped')) {
    log('已在打单中心页面');
    return page;
  }

  // 策略1：直接 goto（最可靠，绕过引导遮罩等问题）
  // 无论当前在哪个页面，都先尝试直接跳转
  log('导航到打单中心（直接URL）...');
  await page.goto(DADAN_PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 5000));

  // 检查是否被重定向到登录页
  const currentUrl = page.url();
  if (currentUrl.includes('login')) {
    log('⚠️ 跳转到登录页，登录态可能已过期');
    throw new Error('登录态过期，需要重新登录');
  }

  if (currentUrl.includes('qn-order/unshipped')) {
    log('已到达打单中心（打单工具）');
    return page;
  }

  // 策略2：菜单导航（交易 → 打单工具），可能被引导遮罩/自动跳转干扰
  log('直接URL未成功，尝试菜单导航...');
  try {
    await page.click('a.navItem--uDJGIOeJ:has-text("交易")');
    await new Promise(r => setTimeout(r, 2000));
    await page.click('a:has-text("打单工具")');
    await new Promise(r => setTimeout(r, 5000));
  } catch (e) {
    log(`菜单导航失败: ${e.message}`);
  }

  if (page.url().includes('qn-order/unshipped')) {
    log('已到达打单中心');
    return page;
  }

  // 最后的兜底
  log('再次尝试直接跳转...');
  await page.goto(DADAN_PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  return page;
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
  log(`搜索结果: ${count} 条订单`);
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

  // 1. 确保浏览器可用
  const browser = await ensureBrowser(args.port);

  try {
    // 2. 查找已有页面或打开千牛首页
    let page = await findOrOpenPage(browser);

    // 3. 确保已登录（三层策略）
    page = await ensureLoggedIn(browser, args);

    // 4. 导航到打单中心
    page = await navigateToDadan(page);

    // 5. 设置日期 或 清空日期
    if (isAll) {
      await clearDateRange(page);
    } else {
      await setDateRange(page, start, end);
    }

    // 6. 搜索
    const count = await searchOrders(page);
    if (count === 0) {
      log(isAll ? '当前没有待发货订单' : '该时段没有订单');
      process.exit(0);
    }

    // 7. 导出
    const file = await exportOrders(page);

    // 8. 移动到日期子目录
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
