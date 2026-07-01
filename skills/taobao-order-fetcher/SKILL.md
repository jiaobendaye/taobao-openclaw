---
name: "taobao-order-fetcher"
description: "从淘宝千牛抓取待发货订单并导出Excel；登录失败超过3次自动提醒联系管理员"
user-invocable: true
trigger: 当用户说"抓取淘宝待发货订单"、"拉取订单"、"导出千牛订单"、"下载待发货订单"、"抓取全部订单"、"导出所有订单"等表达时触发（"全部/所有/无时间范围"表示不设时间筛选，直接导出全部）
---

# 淘宝订单抓取

从淘宝千牛打单工具页面筛选待发货订单并导出 Excel。

## 执行流程

```
检测9222端口 CDP
  │
  ├─→ 已运行 → 直接连接复用
  │
  └─→ 未运行 → 启动 Chromium（headed，shell spawn + CDP 连接）
                │
                ├─ 优先：/snap/bin/chromium（snap，默认 profile，无需 --user-data-dir）
                ├─ 降级：~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
                ├─ 关键参数：--remote-debugging-port=9222 --no-sandbox --no-first-run
                ├─ 等待 CDP 就绪 → chromium.connectOverCDP()
                └─ 打开 https://qn.taobao.com
                       │
                       ├─ 已登录？→ 直接进入工作台
                       │
                       └─ 未登录 → 千牛首页 → 点击「登录千牛」
                                    │
                                    └─ 新窗口 loginmyseller.taobao.com
                                       │
                                       ├─ 登录表单在 iframe 内
                                       │   iframe: havanalogin.taobao.com/mini_login.htm
                                       │
                                       ├─ 三种方式Tab：扫码登录 / 密码登录 / 短信登录
                                       │   自动化用「密码登录」
                                       │
                                       ├─ 密码登录表单（iframe内）：
                                       │   ├─ 账号：#fm-login-id
                                       │   ├─ 密码：#fm-login-password
                                       │   ├─ 子账号格式：主账号:子账号名（英文冒号）
                                       │   ├─ 点击 button:has-text("登录")
                                       │   └─ 检查错误：
                                       │       ├─ 无错误 → 登录成功
                                       │       └─ 有错误 → loginAttempts++
                                       │           ├─ < 3 次 → 提示老板，等 5s 后重试
                                       │           └─ ≥ 3 次 → ❌ 停止重试
                                       │              → 当前 channel 发提醒
                                       │              → exit 1 退出抓取
                                       │
                                       └─ 登录成功 → myseller.taobao.com/home.htm/QnworkbenchHome/
  │
  ├─→ 导航到打单中心
  │     ├─ 策略1（优先）：直接 goto DADAN_PAGE
  │     │   → myseller.taobao.com/home.htm/qn-order/unshipped
  │     │   绕过可能存在的引导遮罩/自动跳转干扰
  │     │
  │     └─ 策略2（降级）：菜单导航
  │           ├─ 点击顶部「交易」→ a.navItem--uDJGIOeJ:has-text("交易")
  │           └─ 点击「打单工具」← 新版叫法，即打单中心
  │              注意：可能有新手引导 driver-overlay SVG 拦截点击
  │
  ├─→ 在打单中心（打单工具）页面操作：
  │     ├─ 默认在「待发货」Tab
  │     ├─ 页面Tab：待发货、已发货、异常订单、物流预警、手工订单、备货单、售后管理...
  │     └─ 主要按钮：同步订单、搜索、导出、打快递单、发货、打印快递单
  │
  ├─→ 设定付款时间范围
  │    精度：秒（格式 YYYY-MM-DD HH:mm:ss）
  │    起始：必填，默认 00:00:00
  │    结束：默认当前时间
  │
  ├─→ 点击「搜索」
  │
  ├─→ 点击「导出」→「按查询结果导出」
  │
  ├─→ 等下载完成（Chrome自己下载，不拦截）
  │
  └─→ 移动到 ~/lab/taobao/data/起始_to_结束/
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

**优先 snap Chromium**（`/snap/bin/chromium`），用 snap 默认 profile 保持登录态，无需 `--user-data-dir`。

**降级：Playwright 缓存 Chromium**（`~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`），需指定 `--user-data-dir=~/.cache/chrome-cdp-profile`。

```bash
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

## 导航到打单中心

打单中心=新版千牛的「打单工具」，路径：**交易 → 物流管理 → 打单工具**。

**推荐用直接 URL goto**（绕过引导遮罩等不稳定因素）：

```javascript
// 直接跳转（最可靠）
await page.goto('https://myseller.taobao.com/home.htm/qn-order/unshipped', {
  waitUntil: 'domcontentloaded', timeout: 20000
});
```

菜单导航（可能被引导遮罩/自动跳转干扰）：

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
