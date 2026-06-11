#!/usr/bin/env node
/**
 * 淘宝千牛待发货订单抓取
 * 
 * 自动检测/启动 Chrome CDP：
 *   1. 先检查 9222 端口是否已有 Chrome CDP
 *   2. 有 → 连接复用
 *   3. 无 → 启动新 Chromium
 * 
 * 日期精度：秒
 * 
 * 用法: 
 *   node fetch-orders.mjs --start 2026-06-10              # end=现在，start=00:00:00
 *   node fetch-orders.mjs --start "2026-06-10 08:00:00"  # 带时分秒
 *   node fetch-orders.mjs --start 2026-06-10 --end "2026-06-11 12:30:00"
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';

const DATA_DIR = path.join(process.env.HOME, 'lab/taobao/data');
const DEFAULT_PORT = 9222;
const QN_URL = 'https://myseller.taobao.com/home.htm/qn-order/unshipped';

// ---- 命令行参数 ----

function parseArgs() {
  const args = { start: null, end: null, port: DEFAULT_PORT };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--start' && process.argv[i + 1]) args.start = process.argv[++i];
    if (process.argv[i] === '--end' && process.argv[i + 1]) args.end = process.argv[++i];
    if (process.argv[i] === '--port' && process.argv[i + 1]) args.port = parseInt(process.argv[++i]);
  }
  return args;
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
  const browser = await chromium.launch({
    headless: false,
    args: [
      `--remote-debugging-port=${port}`,
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });
  log(`Chromium 已启动 (CDP port: ${port})`);
  return browser;
}

// ---- 页面操作 ----

async function findOrOpenPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('myseller.taobao') || p.url().includes('qn-order')) {
        log('找到已有千牛页面');
        return p;
      }
    }
  }

  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(QN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  log('已打开千牛订单页');
  return page;
}

async function waitForLogin(page, timeoutSec = 120) {
  const currentUrl = page.url();
  if (!currentUrl.includes('login')) return;

  log('需要登录千牛！请在浏览器中扫码/输入账号登录...');
  log(`等待登录（最多 ${timeoutSec} 秒）...`);

  for (let i = 0; i < timeoutSec; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const url = page.url();
      if (url.includes('qn-order') || url.includes('home.htm')) {
        log('✅ 登录成功');
        await new Promise(r => setTimeout(r, 2000));
        return;
      }
    } catch {}
    if (i % 10 === 9) log(`  已等待 ${i + 1} 秒...`);
  }
  throw new Error('登录超时');
}

async function setDateRange(page, start, end) {
  log(`设置付款时间: ${start} ~ ${end}`);

  // 千牛使用 Fusion DatePicker2 受控组件，必须 keyboard.type + 点确定
  // 加多重防护：等面板出现、清空旧值、验证结果、重试

  const setOne = async (placeholder, value, label) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      // 点输入框
      await page.click(`input[placeholder="${placeholder}"]`);
      await new Promise(r => setTimeout(r, 600));

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

async function searchOrders(page) {
  log('搜索订单...');
  await page.click('button:has-text("搜索")');
  await new Promise(r => setTimeout(r, 4000));

  const count = await page.evaluate(() => {
    const m = document.body.innerText.match(/全部\s*\n*(\d+)/);
    return m ? parseInt(m[1]) : 0;
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
  
  // 日期处理
  const start = normalizeDate(args.start, false);
  const end = normalizeDate(args.end || nowStr(), true);
  
  if (!start) {
    console.error('用法: node fetch-orders.mjs --start YYYY-MM-DD [--end "YYYY-MM-DD HH:mm"]');
    console.error('起始日期必填，结束日期默认当前时间');
    process.exit(1);
  }

  log(`付款时间: ${start} ~ ${end}`);

  // 1. 确保浏览器可用
  const browser = await ensureBrowser(args.port);

  try {
    // 2. 找到或打开页面
    const page = await findOrOpenPage(browser);

    // 3. 等待登录
    await waitForLogin(page);

    // 4. 设置日期
    await setDateRange(page, start, end);

    // 5. 搜索
    const count = await searchOrders(page);
    if (count === 0) {
      console.error('没有搜索到订单');
      process.exit(1);
    }

    // 6. 导出
    const file = await exportOrders(page);

    // 7. 移动到日期子目录
    const subDir = path.join(DATA_DIR, dateDirPath(start, end));
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
