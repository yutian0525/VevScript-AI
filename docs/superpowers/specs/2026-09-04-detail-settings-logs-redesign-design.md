# 脚本详情页 设置/日志 Tab 排版重设计

日期：2026-09-04
分支：feat/script-optimize（worktree feat+script-optimize）
状态：已经用户逐项确认

## 0. 背景与问题

全屏脚本详情页的「设置」「日志」两个 Tab 排版存在三类问题：

1. **标题层级不明**：节标题 `.detail__sectiontitle` 是 11px mono 小字（与 eyebrow 同级观感），说明文字 12px 灰字，主副不分、正文淹没；
2. **对齐失控**：日志页头 `.detail-code__bar`（借用代码 Tab 的工具条类）`justify-content: space-between` 把「0 条记录」和「清空」撑到两端，宽屏下相隔半屏；设置页空态复用 `.chat__empty`（`margin: auto 0`）垂直居中、水平不受控；
3. **空态复用聊天语义**：`.chat__empty` 是聊天页居中空态，跨页复用导致两页空态孤立居中、与左对齐内容脱节。

目标：两 Tab 统一为「明显主标题 + 灰副题 + 正文左对齐」的层级，空态改为左对齐空态卡。**非目标**：不动详情/代码两 Tab；不动撤销/清空/错误展示的行为逻辑与消息协议；不动 840px 内容限宽与 `--r-lg` 卡片容器。

## 1. 已确认决策

| 问题 | 决策 |
|---|---|
| 改造范围 | 设置 + 日志两 Tab（详情/代码不动） |
| 标题风格 | 大标题（15px/600 sans `--ink`）+ 灰副题（12px `--ink-3`），无分隔线，全左对齐 |
| 空态 | 左对齐空态卡（浅底圆角卡：图标 + 主文案 + 副文案），不再用 `.chat__empty` |
| 日志主标题 | 「错误日志」（缓冲只收错误，命名诚实）；计数作 mono 弱化后缀 |
| 设置副题 | 原「总是允许名单」语义并入副题，不单列 mono 小字 |

## 2. 组件

新建（`components/detail/`）：

- **`DetailTabHeader.tsx`**：`{ title: string; suffix?: string; hint: string }`
  - `<h2>` 主标题 15px/600 `--ink`；`suffix` 有值时跟在标题右侧（mono 11px `--ink-3`，基线对齐）；
  - `<p>` 副题 12px `--ink-3`，`line-height: 1.6`。
- **`DetailEmptyCard.tsx`**：`{ icon: LucideIcon; title: string; hint: string }`
  - 浅底圆角卡（`background: var(--paper)`、1px `--line` 边、`--r-md`），内 padding 14px 16px；
  - 图标行（lucide 16px `--ink-3`）+ 主文案（13px `--ink-2`/500）+ 副文案（12px `--ink-3`），纵向排布全左对齐。

两 Tab 内容容器仍为 `.detail__tabcard`。

## 3. 两 Tab 结构

### 设置 Tab

```
┌────────────────────────────────────────┐
│ XHR 安全                                │  ← DetailTabHeader
│ 这些域名已获得该脚本的跨域请求授权……重新弹确认 │
│ （撤销失败 warnline，条件渲染，位置不变）   │
│ ┌────────────────────────────────────┐ │
│ │ 🛡 无已授权域名                      │ │  ← DetailEmptyCard(ShieldOff)
│ │ 脚本请求跨域时将逐次询问              │ │
│ └────────────────────────────────────┘ │
│ （有授权时：hostlist 行列表，不变）       │
└────────────────────────────────────────┘
```

- 主标题「XHR 安全」；副题：「这些域名已获得该脚本的跨域请求授权（在确认卡点「总是允许」时记录）；撤销后，脚本再请求这些域名会重新弹确认。」
- 空态卡：图标 `ShieldOff`，主文案「无已授权域名」，副文案「脚本请求跨域时将逐次询问」。
- `hostlist`/`hostrow`/撤销按钮/`scripts-warnline` 全部不动。

### 日志 Tab

```
┌────────────────────────────────────────┐
│ 错误日志 · 0                            │  ← DetailTabHeader（suffix = 计数）
│ 脚本运行抛错将记录在此（环形缓冲，最近 20 条） │
│ [清空]                                  │  ← 左对齐工具行（不再 space-between）
│ ┌────────────────────────────────────┐ │
│ │ ✓ 暂无错误                          │ │  ← DetailEmptyCard(CircleCheck)
│ │ 脚本运行正常                         │ │
│ └────────────────────────────────────┘ │
│ （有错时：.well 井列表，不变）            │
└────────────────────────────────────────┘
```

- 主标题「错误日志」+ suffix `${errors.length} 条`；副题：「脚本运行抛错将记录在此（环形缓冲，最近 20 条）。」
- 清空按钮移到标题区下方的左对齐工具行（新类 `.detail__toolbar`，flex 左对齐 gap 8px），不再借用 `.detail-code__bar`；无错误时禁用逻辑不变。
- `.well`/`detail__logrow`/`logmain`/`logstack` 展开逻辑不动。

## 4. 样式（styles.css）

新增类（全 tokens，禁硬编码色值）：

```css
.detail__thead { display: grid; gap: 4px; }
.detail__title { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); display: flex; align-items: baseline; gap: 8px; }
.detail__suffix { font-family: var(--mono); font-size: 11px; font-weight: 400; color: var(--ink-3); }
.detail__hint { margin: 0; font-size: 12px; color: var(--ink-3); line-height: 1.6; }  /* 重定义现有类 */
.detail__toolbar { display: flex; gap: 8px; }
.detail__empty {
  display: grid; gap: 3px; padding: 14px 16px;
  background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md);
}
.detail__empty-icon { color: var(--ink-3); }
.detail__empty-title { font-size: 13px; font-weight: 500; color: var(--ink-2); }
.detail__empty-hint { font-size: 12px; color: var(--ink-3); }
```

删除：`.detail__sectiontitle`（唯一使用方即本次两 Tab）、日志页对 `.detail-code__bar` 的借用。`.chat__empty` 不再被两 Tab 引用（聊天页仍用）。

## 5. 测试

- **`DetailTabHeader` / `DetailEmptyCard`** 渲染测试：标题/后缀/副题层级（h2 + p）、空态卡图标 + 两行文案；`suffix` 缺省不渲染。
- **设置 Tab**：主标题「XHR 安全」+ 副题渲染；空态卡两行文案；授权列表行 + 撤销按钮（迁移现有断言）；撤销失败 warnline 仍在。
- **日志 Tab**：标题「错误日志」+ 计数后缀随 errors 数变化；空态卡；清空按钮存在于工具行且无错误时禁用（迁移现有断言）。
- 现有 detail 测试若断言 `.detail__sectiontitle` / 居中空态文案，同步迁移。

## 6. 错误处理

无新错误路径：撤销失败仍走 `scripts-warnline`（副题与内容区之间），日志清空为 fire-and-forget 广播。加载态（设置 Tab `loading`）维持现有「加载中…」占位，不进本次范围。
