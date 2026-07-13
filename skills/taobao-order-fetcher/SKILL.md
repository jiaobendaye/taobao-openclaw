---
name: "taobao-order-fetcher"
description: "从淘宝千牛抓取待发货订单并导出Excel；登录失败超过3次自动提醒联系管理员"
user-invocable: true
trigger: 当用户说"抓取淘宝待发货订单"、"拉取订单"、"导出千牛订单"、"下载待发货订单"、"抓取全部订单"、"导出所有订单"等表达时触发（"全部/所有/无时间范围"表示不设时间筛选，直接导出全部）
---

# 淘宝订单抓取

从淘宝千牛打单工具页面筛选待发货订单并导出 Excel。

## 执行流程

**导航采用「四步法」（2026-07-13 老板重设）**：先保证浏览器、再导航、再按需登录，最后才真正干活。

```
第一步：保证浏览器可用（CDP）
  │
  ├─ 检测 9222 端口
  │    ├─ 已运行 → 直接 chromium.connectOverCDP() 复用
  │    └─ 未运行 → 启动 Chromium（headed，shell spawn + CDP 连接）
  │         ├─ 优先：/snap/bin/chromium（snap，默认 profile，无需 --user-data-dir）
  │         ├─ 降级：~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
  │         ├─ 关键参数：--remote-debugging-port=9222 --no-sandbox --no-first-run
  │         └─ 等待 CDP 就绪 → connectOverCDP()
  │
第二步：导航到打单中心（如果已有则刷新）
  │
  ├─ 复用/打开一个 page（优先打单中心 > 工作台 > 千牛首页 > 新建）
  │
  └─ URL 检查：
       ├─ 当前已在 qn-order/unshipped → page.reload()（拿最新订单/避免过期）
       └─ 否则 → page.goto('https://myseller.taobao.com/home.htm/qn-order/unshipped')
               → 等 5s 让 SPA 首屏渲染完
  │
第三步：判断打单中心是否可用
  │
  ├─ 三条全部满足才算「可用」：
  │    1. URL 在 qn-order/unshipped
  │    2. URL 没跳到 login
  │    3. 页面 DOM 含「搜索」+「导出」按钮（关键 UI 存在）
  │
  └─ 判断结果：
       ├─ ✅ 可用 → 跳过登录，直接进导出流程
       └─ ❌ 不可用 → 触发登录流程 ↓
                   │
                   └─ loginmyseller.taobao.com 登录页
                      │
                      ├─ 登录表单在 iframe 内
                      │   iframe: havanalogin.taobao.com/mini_login.htm
                      │
                      ├─ 切到「密码登录」Tab
                      │
                      ├─ 密码登录表单（iframe内）：
                      │   ├─ 账号：#fm-login-id
                      │   ├─ 密码：#fm-login-password
                      │   ├─ 子账号格式：主账号:子账号名（英文冒号）
                      │   └─ 点击 button:has-text("登录")
                      │
                      └─ 失败重试策略（MAX_LOGIN_ATTEMPTS = 3）：
                          ├─ < 3 次 → 等 5s 后重试
                          └─ ≥ 3 次 → ❌ 当前 channel 发提醒 + exit 1
  │
第四步：再次判断打单中心是否可用
  │
  ├─ 登录成功后强制 page.goto(打单中心) 再等 5s
  │
  └─ 判断结果：
       ├─ ✅ 可用 → 进导出流程
       └─ ❌ 仍不可用 → 报错退出
                    → 可能原因：账号/密码错、Cookie 失效、风控拦截
                    → 由 main().catch() 捕获 → exit 1
  │
后续（导出流程）：
  ├─ 在打单中心页面操作：
  │    ├─ 默认在「待发货」Tab
  │    └─ 主要按钮：同步订单、搜索、导出、打快递单、发货、打印快递单
  │
  ├─ 设定付款时间范围（精度：秒）
  │    起始：必填，默认 00:00:00
  │    结束：默认当前时间
  │    （--all 模式：清空起始/结束，不点确定）
  │
  ├─ 点击「搜索」
  ├─ 点击「导出」→「按查询结果导出」
  ├─ 等下载完成（Chrome自己下载，不拦截）
  └─ 移动到 ~/lab/taobao/data/起始_to_结束/
```

## 使用方法

```bash
# 仅日期 — 不加引号（无空格）
node skills/taobao-order-fetcher/scripts/fetch-orders.mjs --start 2026-06-10

# 带时间 — 加引号（有空格的 shell 参数）
node skills/taobao-order-fetcher/scripts/fetch-orders.mjs --start "2026-06-10 08:00:00"

# 两端都带时间
node skills/taobao-order-fetcher/scripts/fetch-orders.mjs --start "2026-06-10 08:00:00" --end "2026-06-11 12:30:00"

# 全部订单（不设时间筛选，直接导出全部待发货订单）
node skills/taobao-order-fetcher/scripts/fetch-orders.mjs --all
```

| 参数 | 说明 | 格式 | 默认值 |
|------|------|------|--------|
| `--start` | 起始日期时间（与 `--all` 互斥） | `YYYY-MM-DD [HH:mm:ss]` | 时间默认 `00:00:00` |
| `--end` | 结束日期时间（可选） | `YYYY-MM-DD [HH:mm:ss]` | 当前时间（到秒） |
| `--all` | 全部订单模式：不设时间筛选，清空起始/结束输入框后导出全部 | flag | 关闭 |
| `--user` | 千牛登录账号（可选） | `主账号:子账号名` | 环境变量 TAOBAO_USER |
| `--pass` | 千牛登录密码（可选） | 密码原文 | 环境变量 TAOBAO_PASS |
| `--port` | CDP 端口（可选） | 数字 | 9222 |

> 💡 引号规则：只写日期 `2026-06-10` 不用引号；带时间 `2026-06-10 08:00:00` 因为有空格，必须加双引号。

## 模式说明

### 时间区间模式（默认）

传 `--start`（必填）和可选 `--end`，按付款时间区间筛选后导出。

输出目录：`~/lab/taobao/data/<YYYY-MM-DD>/<startHHmmss>_to_<endHHmmss>/`

### 全部订单模式

三种触发方式：
- 显式加 `--all` 标志
- 不传任何时间参数（既不传 `--start` 也不传 `--end`）
- 口语表达「全部/所有/无时间范围」时，自动按本模式处理

实现方式：
1. 展开「全部」筛选面板（让起始/结束输入框可见）
2. 依次清空「起始日期」「结束日期」两个输入框（点击 → Ctrl+A → Backspace → Esc，**不点确定**避免触发默认时间）
3. 点搜索 → 点导出 → 按查询结果导出

输出目录：`~/lab/taobao/data/<YYYY-MM-DD>/all_<HHMMSS>/`（HHMMSS 为导出时刻）

### 日期兼容

| 输入 | 解析结果 |
|------|----------|
| `2026-06-10` | `2026-06-10 00:00:00` |
| `2026-06-10 08:00` | `2026-06-10 08:00:00` |
| `2026-06-10 08:00:30` | `2026-06-10 08:00:30` |

## 浏览器启动

> **跨平台（2026-07-13 老板加 Windows 支持）**：脚本会自动检测当前平台，挑能用的 Chromium / Chrome / Edge。

### 自动查找顺序（按 `findChromeBin()`）

| 平台 | 查找顺序 |
|------|---------|
| **Linux** | 1. `/snap/bin/chromium`（默认 profile）→ 2. `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome` |
| **Windows** | 1. `%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win\chrome.exe` → 2. 系统 Chrome → 3. 系统 Edge（都用默认 profile） |
| **macOS** | 1. `~/Library/Caches/ms-playwright/chromium-1223/...` → 2. `/Applications/Google Chrome.app/...` |

找不到时脚本会**报错并给出对应平台的安装提示**（不会静默吞错）。

### 路径映射

| 用途 | Linux | Windows |
|------|-------|---------|
| 数据导出目录 | `~/lab/taobao/data/` | `C:\Users\<user>\lab\taobao\data\` |
| 浏览器 user-data-dir（Playwright bundled） | `~/.cache/chrome-cdp-profile/` | `%LOCALAPPDATA%\chrome-cdp-profile\` |
| HOME 来源 | `os.homedir()` → `/home/<user>` | `os.homedir()` → `C:\Users\<user>` |

### 手动启动（绕过脚本自动启动，先把浏览器跑起来）

```bash
# ===== Linux =====

# snap Chromium（推荐，默认 profile）
/snap/bin/chromium \
  --remote-debugging-port=9222 \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  "https://qn.taobao.com" &

# Playwright Chromium（降级，指定 profile）
~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  --remote-debugging-port=9222 \
  --no-sandbox \
  --disable-setuid-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --user-data-dir=$HOME/.cache/chrome-cdp-profile \
  "https://qn.taobao.com" &
```

```cmd
:: ===== Windows =====

:: Playwright Chromium（推荐，先 npx playwright install chromium 装好）
"%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --no-sandbox ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="%LOCALAPPDATA%\chrome-cdp-profile" ^
  "https://qn.taobao.com"

:: 系统 Chrome（默认 profile，无需 user-data-dir）
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 --no-sandbox ^
  "https://qn.taobao.com"

:: 系统 Edge（Win10/11 自带）
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 --no-sandbox ^
  "https://qn.taobao.com"
```

```bash
# ===== macOS =====
~/Library/Caches/ms-playwright/chromium-1223/chrome-mac/Chromium.app/Contents/MacOS/Chromium \
  --remote-debugging-port=9222 --no-sandbox --no-first-run \
  --user-data-dir=$HOME/.cache/chrome-cdp-profile \
  "https://qn.taobao.com" &
```

### Windows 跑前的准备

```cmd
:: 1. 安装 Node.js（≥18）
node --version

:: 2. 在项目目录装 playwright
npm init -y
npm install playwright

:: 3. 让 playwright 下载自带 chromium
npx playwright install chromium

:: 4. 跑脚本
node skills\taobao-order-fetcher\scripts\fetch-orders.mjs --start 2026-07-13
```

### 跨平台常见坑

| 坑 | 解决 |
|----|-----|
| Windows 路径有空格（`C:\Program Files\...`） | Node `spawn` 默认正确处理；不要设 `shell:true` |
| `--user-data-dir` Windows 上要不要带盘符 | 要，且用绝对路径：`%LOCALAPPDATA%\chrome-cdp-profile` |
| 路径分隔符 `/` vs `\` | 全程用 `path.join()`，Node 自动适配；不要硬编码 |
| `process.env.HOME` 在 Windows 上是 undefined | 用 `os.homedir()`，跨平台 |
| Windows spawn detached 行为 | `child.unref()` 仍然有效，浏览器可独立运行 |

## 千牛登录

### 登录页面

LoginSellers 登录页在 iframe 内渲染，iframe src 为 `havanalogin.taobao.com/mini_login.htm`。

三种登录Tab：
| Tab | 说明 | 自动化适用 |
|-----|------|-----------|
| 扫码登录 | 默认，二维码动态加载 | ❌ 需手机扫码 |
| 密码登录 | 账号密码 | ✅ 可自动化 |
| 短信登录 | 手机验证码 | ❌ 需收短信 |

### 子账号格式

格式：`主账号:子账号名`（英文半角冒号）

示例：`zyxchappy:凡二`

### 登录代码

```javascript
// 表单在 iframe 内，需要先获取 frame
const frame = loginPage.frames().find(f => f.url().includes('havanalogin'));

// 切到密码登录
await frame.click('text=密码登录');

// 填表
await frame.locator('#fm-login-id').fill('zyxchappy:凡二');
await frame.locator('#fm-login-password').fill('密码');

// 登录
await frame.locator('button:has-text("登录")').click();

// 等待跳转，检查是否还在登录页
await loginPage.waitForTimeout(10000);
const err = await frame.evaluate(() => {
  const el = document.querySelector('.error, [class*=error]');
  return el?.innerText || null;
});
if (err) throw new Error(`登录失败: ${err}`);
```

### 登录常见错误

| 错误提示 | 原因 |
|----------|------|
| `账密错误` | 账号名或密码不对，检查主账号拼写、冒号是否英文 |
| 路由不匹配 | URL不对，用 `https://qn.taobao.com` 首页进入 |

### 登录失败处理（重要）

**规则：单次抓取任务中，登录连续失败超过 3 次，立即停止重试并提醒老板联系管理员。**

- 用计数器 `loginAttempts` 跟踪本次任务中失败的登录尝试
- 每次点「登录」按钮后等待 10 秒，检查 `error` 元素
- 失败一次 → `loginAttempts++`
- `loginAttempts < 3` → 提示老板「登录失败，正在重试（第 N/3 次）」，等 5 秒后重试
- `loginAttempts ≥ 3` → ❌ **停止所有登录重试**，并在**当前对话 channel**（WebChat / QQBot / 微信）直接发提醒：

  > **千牛登录已连续失败超过 3 次，可能是账号/密码失效、Cookie 过期或被风控，请联系管理员处理。**

- 提醒后 `exit 1` 退出抓取任务，不重试、不自动恢复、不静默吞错
- 提醒消息必须走对话 channel（WebChat 走 stdout、QQBot/微信 走对应 messaging），不要只 `console.log`

> 为什么是 3 次：前两次是正常容错（输错、网抖、Cookie 残留），第 3 次仍失败基本可判定为账号/密码层面的硬问题，继续重试没意义还可能触发风控。

## 导航到打单中心（四步法）

打单中心 = 新版千牛的「打单工具」，路径：**交易 → 物流管理 → 打单工具**。

> **核心思想（2026-07-13 老板重设）**：先保证浏览器、再导航、再按需登录、最后才真正干活。**登录不再是前置步骤**，而是「打单中心不可用时的兜底」。

### 四步详解

**第一步：保证浏览器可用（CDP）**
- `ensureBrowser(port)`：先 `fetch('http://127.0.0.1:9222/json/version')`，已运行 → `chromium.connectOverCDP()`；未运行 → `spawn` 启 Chromium，等 CDP 就绪。

**第二步：导航到打单中心（已有则刷新）**
- `navigateToDadanCenter(browser)`：先 `findOrOpenPage` 找一个可用 page
  - 当前已在 `qn-order/unshipped` → `page.reload()`（拿最新订单/避免页面过期）
  - 否则 → `page.goto('https://myseller.taobao.com/home.htm/qn-order/unshipped')`
- 等 5s 让 SPA 首屏渲染完

**第三步：判断打单中心是否可用**
- `isDadanAvailable(page)`：三条全部满足才算可用：
  1. URL 含 `qn-order/unshipped`
  2. URL 不含 `login`（没被重定向到登录页）
  3. 页面 DOM 含 `搜索` + `导出` 按钮（关键 UI 存在）
- ✅ 可用 → 直接进导出流程
- ❌ 不可用 → 触发 `autoLoginWithRetry()` 走登录兜底

**第四步：再次判断（登录后）**
- 登录成功后强制 `page.goto(打单中心)`，再等 5s，再 `isDadanAvailable`
- ✅ 可用 → 进导出流程
- ❌ 仍不可用 → 抛错 `登录后打单中心仍不可用...`，由 `main().catch()` `exit 1` 退出

### 推荐用直接 URL goto

绕过引导遮罩等不稳定因素，最可靠：

```javascript
// 直接跳转 / 刷新
if (page.url().includes('qn-order/unshipped')) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
} else {
  await page.goto('https://myseller.taobao.com/home.htm/qn-order/unshipped', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
}
```

菜单导航（不推荐，可能被引导遮罩/自动跳转干扰）：

```javascript
// 1. 点击顶部导航「交易」
await page.click('a.navItem--uDJGIOeJ:has-text("交易")');
await page.waitForTimeout(2000);

// 2. 点击左侧子菜单「打单工具」
await page.click('a:has-text("打单工具")');
await page.waitForTimeout(5000);
```

左侧子菜单结构（交易菜单下）：

```
交易
├─ 订单管理
│   ├─ 已卖出宝贝
│   ├─ 退款管理
│   ├─ 售后任务
│   ├─ 评价管理
│   └─ 挽单助手
└─ 物流管理
    ├─ 物流数据
    ├─ 寄快递
    ├─ 发货
    ├─ 打单工具     ← 打单中心！
    ├─ 包裹中心
    └─ 物流服务
```

### 打单中心页面

- 标题：`打单工具`
- 默认Tab：`待发货`
- 其他Tab：已发货、异常订单（带数量徽标）、物流预警、手工订单、备货单、售后管理、更多功能、设置
- 功能按钮：同步订单、搜索、导出、打快递单、发货、打印快递单、打印发货单、生成备货单等

## 关键实现

1. **自动检测 CDP**：`fetch('http://127.0.0.1:9222/json/version')`
2. **无浏览器则 shell spawn**：`spawn(chromeBin, args, { detached: true })` → 等 CDP 就绪 → `chromium.connectOverCDP()`
3. **下载不拦截**：`Browser.setDownloadBehavior({ behavior: 'allow', downloadPath })`
4. **日期输入**：placeholder `起始日期` / `结束日期`，填入 `YYYY-MM-DD HH:mm:ss`
5. **超时兜底**：60秒超时后额外等2秒再检查一次
6. **凭据优先级**：`--user/--pass` 参数 > `TAOBAO_USER/TAOBAO_PASS` 环境变量
7. **页面复用**：优先复用打单中心 > 工作台 > 千牛首页已有 tab，避免重复开
8. **登录重试上限**：连续登录失败 ≥ 3 次自动停止重试，**当前 channel 发提醒老板联系管理员**并 `exit 1`
9. **四步法导航（2026-07-13）**：浏览器 → 导航+刷新 → 判断 → 登录兜底 → 再判断，登录改为「按需触发」而非「前置步骤」

## 区间语义

千牛付款时间搜索为 **闭区间 `[start, end]`** — 起始和结束都包含。

对去重的影响：
- 若用 `lastExportEnd` 直接作为下一次 `start`，边界秒的订单会重复
- 正确做法：`nextStart = lastExportEnd + 1秒`

> 经 2026-06-12 实测验证确认。

## 全部订单模式注意事项

| 场景 | 行为 |
|------|------|
| 输入框本来为空 | 清空操作是 no-op，仍然按空值搜索 |
| 输入框已填了「今天」/「近7天」等预设 | 清空后按无时间筛选搜索 |
| 清空后日期面板残留 | 用 `Escape` 关闭面板，不会写入默认时间 |
| 千牛搜索结果为空 | 脚本优雅退出（exit 0），不会报错 |

## 抓取后流程（默认行为）

**抓取完成后不自动处理订单**，而是向老板列出可用功能菜单，由老板明确选择后再执行。

可用功能（基于 phonecase-order-process skill）：

| 功能 | 命令 | 说明 |
|------|------|------|
| 筛选分类 | `phonecase-tools filter <Excel路径>` | 多件订单 / 疑难单 / 单独配件 / 正常手机壳 4 类分 sheet |
| 档口分配 | `phonecase-tools dangkou <Excel路径> [自设编码.xlsx]` | 按档口拆 sheet，生成打单文件 |
| 配件提取 | `phonecase-tools peijian <Excel路径> [配件编码.xlsx]` | 🆕 2026-06-30 升级：单命令搞定，提取 + 分配档口 + 出 4 sheet 汇总（旧 extract+merge 已废弃） |
| 重新抓取 | 调整时间范围或加 `--all` 重跑本脚本 | 重新导出 Excel |

快捷触发（口语化指令）：

| 老板说 | 我应该做的 |
|--------|-----------|
| 「处理订单」 | **没有默认动作**（2026-07-01 老板指定）：列出菜单让老板点单 |
| 「跑 filter」/「跑 dangkou」/「跑 peijian」/「跑 pizhi」 | 单跑对应命令（需提供对应配置表） |
| 「做配件提取」/「peijian」 | 单跑 `peijian` 命令（一步到位） |
| 「筛选分类」/「档口分配」/「皮质壳分配」 | 单跑对应那一步 |
| 「全部处理」 | 列出菜单让老板确认跑哪些（不自动全部跑） |
| 「重新抓」/「重抓」 | 问时间范围或跑 `--all` |

> 规则：**绝不**在抓完订单后擅自动手处理——必须由老板显式点名功能才执行。

## 常见问题

| 问题 | 原因/解决 |
|------|-----------|
| `FATAL: No usable sandbox` | Chromium 启动必须加 `--no-sandbox` |
| Chromium 找不到 | Playwright 装的是 `chrome-linux64/` 不是 `chrome-linux/` |
| 需要登录 | 新浏览器无cookie，按上述登录流程操作 |
| 登录报「账密错误」 | 检查主账号名拼写、冒号是否英文半角 |
| 登录表单找不到 | 表单在 `havanalogin` iframe 内，需 `frame.locator()` |
| 找不到「打单中心」 | 新版千牛叫「打单工具」，在交易→物流管理下 |
| 子菜单不出现 | 先点「交易」等2秒让子菜单展开 |
| 点击被 SVG 遮罩拦截 | 新手引导 `driver-overlay` 挡在前面，直接 goto URL 绕过 |
| 下载失败/空文件 | 检查 CDP download behavior 是否设置 |
| 搜索后无结果 | 检查日期范围 |
| 端口被占用 | 已有Chrome在用9222，直接复用 |
| 登录失败超过 3 次 | 脚本自动停止，当前 channel 提醒联系管理员（见「登录失败处理」节） |
