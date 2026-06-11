---
name: "phonecase-order-process"
description: "手机壳订单处理：filter筛选、dangkou档口分配、peijian配件提取汇总"
---

# phonecase-tools 订单处理技能

## 概述

`phonecase-tools` 是一个 Go 编写的淘宝手机壳订单处理工具。

通过 skill `scripts/` 目录下的包装脚本调用：
- **wrapper 脚本**: `~/.openclaw/workspace/skills/phonecase-order-process/scripts/phonecase-tools`

### 先构建（如果修改了源码）
```bash
cd ~/lab/taobao/order-process && make linux
```

## 四个独立命令

filter、dangkou、peijian extract、peijian merge 是**独立功能**，不存在先后依赖关系。

但实践中有一些**常见搭配**（见后面的工作流模式）。

### 1. filter — 订单筛选分类

```bash
phonecase-tools filter <Excel文件路径>
```

将订单分为 4 类输出到 Excel（4 个 sheet）：
- **多件订单**：有多个子订单的记录
- **疑难单**：含买家留言/卖家备注/疑难关键词
- **单独配件**：规格含配件关键词且不含 `+`
- **正常手机壳**：其余订单，按编码分组（不同编码间空行隔开）

输出：`<原文件名>_output/筛选结果.xlsx`

### 2. dangkou — 档口分配

```bash
phonecase-tools dangkou <订单Excel文件> [自设编码.xlsx路径]
```

根据 `商品ID`/`商品规格`/`自设编码` 匹配订单到档口。
输出：`<原文件名>_output/档口分配.xlsx`（每个档口一个 sheet）

### 3. peijian extract — 配件提取

```bash
phonecase-tools peijian extract <Excel文件>
```

从订单规格中提取配件信息。
输出：`<原文件名>_output/pending.xlsx`（3 个 sheet：简单订单/待处理/无配件）

### 4. peijian merge — 配件汇总

```bash
phonecase-tools peijian merge <pending.xlsx路径>
```

汇总配件统计，按数量降序排列。
输出：同目录下 `result.xlsx`

## 常见工作流模式

### 模式 A：只需筛选分类
```bash
phonecase-tools filter 原始订单.xlsx
```

### 模式 B：只需档口分配
```bash
phonecase-tools dangkou 原始订单.xlsx 自设编码.xlsx
```

### 模式 C：只需配件提取 + 汇总
```bash
# 提取配件
phonecase-tools peijian extract 原始订单.xlsx
# 人工审核 pending.xlsx 后
phonecase-tools peijian merge ..._output/pending.xlsx
```

### 模式 D：筛选后给档口分配和人工处理
```bash
# 1. 先筛选分类
phonecase-tools filter 原始订单.xlsx
# 2. 正常手机壳 → 档口分配
phonecase-tools dangkou ..._output/筛选结果.xlsx 自设编码.xlsx
# 3. 疑难单/单独配件/多件订单 → 人工处理
```

## 配置管理

配置文件在 `build/bin/` 目录：
- `keywords.json` — filter 关键词（doubtKeywords/accessoryKeywords）
- `parts.json` — peijian 配件关键词列表
- `columns.json` — peijian 列名映射
- `dangkou_config.json` — 自设编码.xlsx 路径
- `phonecase-tools.log` — 运行日志

更新配置：
```bash
cat > /home/jiaobendaye/lab/taobao/order-process/build/bin/parts.json << 'EOF'
{"accessories":["支架","吸盘","串珠","腕带"]}
EOF
```

## 重要规则

1. **用绝对路径**调用（wrapper 脚本已处理）
2. **peijian 不能跳过人工审核**：extract → merge 之间需要人工检查 pending 表
3. **永远不要无参运行**（会启动 GUI 桌面应用）
4. **重建**：`cd ~/lab/taobao/order-process && make linux`

## 出错排查

| 错误 | 原因 |
|------|------|
| 数据行不足 | Excel 只有表头 |
| 未找到「xxx」列 | 缺少必需列 |
| 打开配置文件失败 | 自设编码.xlsx 找不到/损坏 |
| 打开订单文件失败 | 输入文件不存在或不是 xlsx |
