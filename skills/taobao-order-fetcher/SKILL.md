---
name: "taobao-order-fetcher"
description: "从淘宝千牛后台筛选待发货订单并导出Excel：连接Chrome CDP、设定付款时间、导出下载、移动到数据目录"
user-invocable: true
trigger: 当用户说"抓取淘宝待发货订单"、"拉取订单"、"导出千牛订单"、"下载待发货订单"等表达时触发
---

# 淘宝订单抓取

从淘宝千牛打单工具页面筛选待发货订单并导出 Excel。

## 执行流程

```
检测9222端口 → 有Chrome CDP则连接 / 无则启动Chromium
  │
  ├─→ 找到或打开千牛页面（qn-order/unshipped）
  │    新浏览器需等用户登录
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
```

| 参数 | 说明 | 格式 | 默认值 |
|------|------|------|--------|
| `--start` | 起始日期时间（必填） | `YYYY-MM-DD [HH:mm:ss]` | 时间默认 `00:00:00` |
| `--end` | 结束日期时间（可选） | `YYYY-MM-DD [HH:mm:ss]` | 当前时间（到秒） |
| `--port` | CDP 端口（可选） | 数字 | 9222 |

> 💡 引号规则：只写日期 `2026-06-10` 不用引号；带时间 `2026-06-10 08:00:00` 因为有空格，必须加双引号。

### 日期兼容

| 输入 | 解析结果 |
|------|----------|
| `2026-06-10` | `2026-06-10 00:00:00` |
| `2026-06-10 08:00` | `2026-06-10 08:00:00` |
| `2026-06-10 08:00:30` | `2026-06-10 08:00:30` |

## 浏览器行为

- 已有 Chrome CDP（9222端口）→ 直接连接，保留登录态
- 没有 → 自动启动 Chromium（headed），提示用户登录后继续

## 关键实现

1. **自动检测 CDP**：`fetch('http://127.0.0.1:9222/json/version')`
2. **无浏览器则启动**：`chromium.launch({ headless: false, args: ['--remote-debugging-port=9222'] })`
3. **下载不拦截**：`Browser.setDownloadBehavior({ behavior: 'allow', downloadPath })`
4. **日期输入**：placeholder `起始日期` / `结束日期`，填入 `YYYY-MM-DD HH:mm:ss`
5. **超时兜底**：60秒超时后额外等2秒再检查一次

## 常见问题

| 问题 | 原因/解决 |
|------|-----------|
| 需要登录 | 新浏览器无cookie，等登录后自动检测跳转 |
| 下载失败/空文件 | 检查 CDP download behavior 是否设置 |
| 搜索后无结果 | 检查日期范围 |
| 端口被占用 | 已有Chrome在用9222，直接复用 |
