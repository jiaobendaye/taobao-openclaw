---
name: "phonecase-order-process"
description: "手机壳订单处理：filter筛选、dangkou档口分配、peijian配件提取、pizhi皮质壳分配"
trigger: "当用户明确说跑某个命令（filter/dangkou/peijian/pizhi）时触发"
---

# phonecase-tools 订单处理技能

## 概述

`phonecase-tools` 是 Go 编译的淘宝手机壳订单处理工具（v2026-07-01）。
**四个独立命令**（filter / dangkou / peijian / pizhi），**没有默认动作**（2026-07-01 老板指定），老板必须明确点名跑哪个才执行。

- **binary**: `/home/jiaobendaye/lab/taobao/order-process/build/bin/phonecase-tools`
- **wrapper 脚本**: `~/.openclaw/workspace/skills/phonecase-order-process/scripts/phonecase-tools`
- **源码**: `~/lab/taobao/order-process/`（作者权威 SKILL.md 在 `phonecase-tools-skill/SKILL.md`）

### 先构建（修改源码后）
```bash
cd ~/lab/taobao/order-process && make linux
```

### 触发规则（2026-07-01 老板指定）

- **没有默认动作**：说「处理订单」不自动跑任何命令，我只是列出菜单让老板点单
- 老板说「跑 filter」「跑 dangkou」「跑 peijian」「跑 pizhi」等具体命令时才执行
- 说「全部处理」表示 4 个都跑，但**也要先列出菜单让老板确认**（因为还是"全部"还是某几个）
- 描述时勿用「联动 / 联跑」（命令技术独立，没有默认组合）

### ⚠️ 配置表规则（2026-07-01）

除 filter 外，**dangkou / peijian / pizhi 都需要一个配置表**：

| 命令 | 配置表 |
|------|--------|
| dangkou | `自设编码.xlsx` |
| peijian | `配件编码.xlsx` |
| pizhi | `皮质壳配置表.xlsx` |

**圣杯目录**（固定路径）：`~/.openclaw/workspace/order-configs/`
- 老板需要哪份配置，就把文件放到这个目录（或以同名重命名）
- 我跑处理时按表名顺序检查，存在则用，不存在则问老板提供

**文件名不限**，按**关键字**匹配（老坂原话 2026-07-01）：

| 命令 | 匹配关键字 |
|------|------------|
| dangkou | `自设` / `自设编码` |
| peijian | `配件` / `配件编码` / `peijian` |
| pizhi | `皮质` / `皮` / `pizhi` |

**边界情况**：
- 多个文件匹配关键字 → 问老板选哪个
- 一个都不匹配 → 主动问老板提供
- 文件名不含关键字（例如 `xgcode.xlsx`）→ 也会匹配不上，问老板

**跑处理前的标准步骤**（检查圣杯目录）：
1. 检查圣杯目录里需要的配置在不在
2. **不存在** → **主动让老板提供路径**（问文件路径或问老板上传），拿到后放到圣杯目录
3. **存在** → 显示 mtime（最后修改时间）+ 行数/sheet数预览，问老板确认
   - 老板说"用" → 开跑
   - 老板说"等"或"换" → 暂停
4. >7 天没更新的文件标 ⚠️，提醒老板考虑更新

**禁止**：
- 不模拟下载 / 不调 WPS API（老板明确指定，2026-07-01）
- 不读 `build/bin/*_config.json`（CLI 不依赖）
- 不用缓存的旧路径（即使文件还在那）

## 命令

### 1. filter — 订单筛选

```bash
phonecase-tools filter <Excel文件路径>
```

**输入**：订单 Excel。必需列：`店铺名称`, `订单编号`, `子订单编号`, `付款时间`, `买家留言`, `卖家备注`, `商品商家编码`, `商品规格`, `商品数量`

**输出**：`<原文件名>_output/筛选结果.xlsx`，4 个 sheet：

| Sheet | 内容 |
|-------|------|
| 多件订单 | SubOrderID ≠ OrderID，按 OrderID 排序，同订单按付款时间排序 |
| 疑难单 | 有买家留言/卖家备注/含疑难关键词，按编码再按付款时间排序 |
| 单独配件 | 规格含配件关键词且不含 `+`，按编码再按付款时间排序 |
| 正常手机壳 | 其余订单，按编码分组（不同编码间空行隔开），同编码按付款时间排序 |

**CLI 输出示例**：
```
已生成 /path/to/xxx_output/筛选结果.xlsx
  多件订单: 5条
  疑难单: 3条
  正常手机壳: 20条
  单独配件: 2条
  总计: 30条
```

**配置**：`keywords.json`（filter 关键词）
```json
{
  "doubtKeywords": ["其他", "咨询客服", "备注", "diy"],
  "accessoryKeywords": ["支架", "绳", "链", "吸盘", "串珠", "相机", "纽扣", "腕带", "贴纸", "卡包"]
}
```
直接编辑 `build/bin/keywords.json`，或用 GUI 齿轮按钮。

### 2. dangkou — 档口分配

```bash
phonecase-tools dangkou <订单Excel文件> <自设编码.xlsx>
```

**输入**：
- 订单 Excel（必须有 `商品ID` 和 `商品规格` 列）
- `自设编码.xlsx`：档口配置 **（必需，CLI 不读 dangkou_config.json）**

**自设编码 Excel 格式**：
- Sheet 1：`商品ID | SKU名称 | 自设编码` 三列映射表
- Sheet 2+：每列头为一个自设编码，下方行是该编码支持的手机型号（空格会被去除）

**输出**：`<原文件名>_output/档口分配.xlsx`：

| Sheet | 内容 |
|-------|------|
| 汇总 | 列头=档口名，每列下方=订单编号列表（第一个 sheet） |
| 档口名（多个） | 匹配到该档口的完整订单 |
| 未分配档口 | 有自设编码但无匹配档口的订单 |
| 无匹配自设编码 | 商品ID+SKU名称找不到对应自设编码的订单 |

**配置**：`dangkou_config.json` **CLI 不读**（仅 GUI 内部使用）
```json
{"path": "/path/to/自设编码.xlsx"}
```

### 3. peijian — 配件提取

```bash
phonecase-tools peijian <订单Excel文件> <配件编码.xlsx>
```

**输入**：
- 订单 Excel（必须有 `商品id` 和 `商品规格` 列）
- `配件编码.xlsx`：配件→档口配置 **（必需，CLI 不读 peijian_config.json）**

**配件编码 Excel 格式**：

- **Sheet 1（支架-自设编码）**：`商品ID | SKU名称 | 编码1 | 编码2 | ... | 编码5`
  - `+` 前为手机壳（忽略），`+` 后每段为一个配件，按位置对应编码列
  - 无 `+` 时整个 SKU 为配件名，对应编码 1

- **Sheet 2（档口分配）**：列式布局 — Row 0 为档口名，下方行为该档口的自设编码

**输出**：`<原文件名>_output/配件分配.xlsx`：

| Sheet | 内容 |
|-------|------|
| **汇总** | 列头=档口名，每列下方=`配件名称 x数量` 按数量降序（第一个 sheet） |
| 档口名（多个） | 分配至该档口的配件详情（店铺名称/订单编号/商品ID/商品规格/配件名称/商品数量） |
| **未分配档口** | 有自设编码但不在任何档口的订单 |
| **无匹配自设编码** | SKU 未匹配到自设编码的订单 |

**配置**：`peijian_config.json` **CLI 不读**（仅 GUI 内部使用）
```json
{"path": "/path/to/配件编码.xlsx"}
```

> ⚠️ 配件编码文件至少需要 2 个 Sheet（缺一个会报错）
> ⚠️ **编码个数校验**：SKU 中的配件个数必须等于编码列数，否则报错：
> ```
> 第 N 行 SKU「xxx」有 2 个配件，但编码列有 3 个编码，数量不一致
> ```
> 例如：`手机壳+支架+挂绳` 必须填 2 个编码列（不是 3 个、不是 1 个）。

### 4. pizhi — 皮质壳分配 🆕 v2026-07-01

```bash
phonecase-tools pizhi <订单Excel文件> <皮质壳配置表.xlsx>
```

**输入**：
- 订单 Excel
- `皮质壳配置表.xlsx`：皮质壳档口配置 **（必需，CLI 不读 pizhi_config.json）**

**皮质壳配置表 Excel 格式**：
- 每个 Sheet 一个档口（**Sheet 名 = 档口名**）
- 每行 3 列：`(商品ID, SKU名称, 图片)` — 图片嵌入 C 列单元格

**匹配规则**：按 `(商品ID, SKU名称, 手机型号)` 聚合后分配到对应档口

**输出**：`<原文件名>_output/皮质壳分配.xlsx`，按档口分 sheet

**配置**：`pizhi_config.json` **CLI 不读**（仅 GUI 内部使用）
```json
{"path": "/path/to/皮质壳配置表.xlsx"}
```

## 配置文件位置

### CLI 圣杯目录（推荐路径）
`~/.openclaw/workspace/order-configs/` — 老板手动管理，每次更新覆盖同名文件即可

**文件名不限**，按关键字智能匹配（见上面 "配置文件规则" 表）。老板可以叫 `自设编码.xlsx`、`自设编码(完善中）.xlsx`、`xgcode_0712.xlsx` 等等都可以。

### GUI 内部缓存（仅 GUI 使用，CLI 不读）
```
build/bin/
├── phonecase-tools          # binary
├── keywords.json            # filter 关键词（CLI 读）
├── dangkou_config.json      # 自设编码.xlsx 路径（**仅 GUI 使用，CLI 不读**）
├── peijian_config.json      # 配件编码.xlsx 路径（**仅 GUI 使用，CLI 不读**）
├── pizhi_config.json        # 皮质壳配置表.xlsx 路径（**仅 GUI 使用，CLI 不读**）
└── phonecase-tools.log      # 运行日志
```

> **🆕 v2026-07-01 binary 升级**：CLI 必须显式传配置文件（`<自设编码.xlsx>` 等），不再读取上面这些 `_config.json`。
> CLI 推荐从圣杯目录 `~/.openclaw/workspace/order-configs/` 读取，老板上覆盖更新，我跑前显示 mtime 让老板确认。

## 更新配置

### CLI 圣杯目录（推荐）
老板直接在 `~/.openclaw/workspace/order-configs/` 覆盖文件即可：
- `自设编码.xlsx` → 老板用 WPS / Excel 改完下载下来，放/覆盖这个路径
- `配件编码.xlsx` → 同上
- `皮质壳配置表.xlsx` → 同上

我跑处理前自动检查这个目录，缺失则问老板提供。

### GUI 配置（仅 GUI 内部用）
```bash
# filter 关键词（CLI 读）
cat > ~/lab/taobao/order-process/build/bin/keywords.json << 'EOF'
{
  "doubtKeywords": ["其他", "咨询客服", "备注", "diy"],
  "accessoryKeywords": ["支架", "绳", "链", "吸盘", "串珠", "相机", "纽扣", "腕带", "贴纸", "卡包"]
}
EOF

# dangkou / peijian / pizhi config（仅 GUI 使用）
cat > ~/lab/taobao/order-process/build/bin/dangkou_config.json << 'EOF'
{"path": "/absolute/path/to/自设编码.xlsx"}
EOF
cat > ~/lab/taobao/order-process/build/bin/peijian_config.json << 'EOF'
{"path": "/absolute/path/to/配件编码.xlsx"}
EOF
cat > ~/lab/taobao/order-process/build/bin/pizhi_config.json << 'EOF'
{"path": "/absolute/path/to/皮质壳配置表.xlsx"}
EOF
```

## 重要规则

1. **用绝对路径**调用（wrapper 脚本已处理）
2. **永远不要无参运行** `phonecase-tools`（会启动 GUI 桌面应用）
3. **重建**：`cd ~/lab/taobao/order-process && make linux`
4. **没有默认动作**（2026-07-01 老板指定）：老板必须明确点名跑哪个命令才执行；说「处理订单」我只是列菜单
5. **配件编码校验**：SKU 中的配件个数必须等于编码列数，错了会直接报错
6. **配置文件同步**：binary 更新后，可能配置 JSON 路径或命名变了，跑前看一眼 `build/bin/` 目录

## 出错排查

| Exit Code | 含义 |
|-----------|------|
| 0 | 成功 |
| 1 | 错误（stderr 看详情） |

| 错误信息 | 原因 |
|----------|------|
| `用法: phonecase-tools dangkou <订单Excel文件> <自设编码.xlsx>` | 缺配置参数（v2026-07-01 后必需） |
| `用法: phonecase-tools peijian <订单Excel文件> <配件编码.xlsx>` | 缺配置参数（v2026-07-01 后必需） |
| `用法: phonecase-tools pizhi <订单Excel文件> <皮质壳配置表.xlsx>` | 缺配置参数（v2026-07-01 后必需） |
| `数据行不足` | Excel 只有表头 |
| `未找到「xxx」列` | 缺少必需列（看上面各命令的"必需列"） |
| `打开配置文件失败` | 自设编码.xlsx / 配件编码.xlsx / 皮质壳配置表.xlsx 找不到或损坏 |
| `打开订单文件失败` | 输入文件不存在或不是 xlsx |
| `配件编码文件至少需要 2 个 Sheet` | 配件编码.xlsx 缺「自设编码」或「档口分配」sheet |
| `SKU「xxx」有 N 个配件，但编码列有 M 个编码` | 配件个数 ≠ 编码列数，修正「配件编码.xlsx」的编码列数量 |

## 测试命令

```bash
# 重新编译
cd ~/lab/taobao/order-process && make linux

# filter 测试
./build/bin/phonecase-tools filter "data/发货单20260605150646共计11条.xlsx"

# dangkou 测试
./build/bin/phonecase-tools dangkou \
  "data/发货单20260605150646共计11条.xlsx" \
  "data/自设编码(完善中）(1).xlsx"

# peijian 测试
./build/bin/phonecase-tools peijian \
  "data/发货单20260620094852共计237条.xlsx" \
  "data/配件编码测试.xlsx"

# pizhi 测试
./build/bin/phonecase-tools pizhi \
  "data/xxx.xlsx" \
  "data/皮质壳配置表.xlsx"
```

## 相关能力

老板还开发了 **Web 版本**（`build/bin/phonecase-tools.html`，9.3 MB）：
- 单 HTML 部署，浏览器双击打开即用
- 数据完全本地处理，不上传
- 4 个 tab：订单筛选 / 档口分配 / 配件提取 / 皮质壳分配
- 如果老板不想走命令行，可推荐 web 版（老板主动要求时再介绍）
