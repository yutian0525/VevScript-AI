# 存储管理页设计（用量统计 + 可再生数据清理 + 全量备份导出/导入）

日期：2026-09-22　分支：`feat/auto-update`（沿用）

## 0. 目标与范围

三个用户故事：

1. **用量统计**：设置二级页按数据域列出 `chrome.storage.local` 各组的条目数与字节数、占比条与总计，看得见谁在吃空间。
2. **清理可再生数据**：GM 资源缓存与 Agent 调用记录（trace）提供清理；脚本/技能/记忆/会话本体只统计不清理——它们不是缓存，删数据的入口在各自管理界面，不设双入口。
3. **全量备份导出/导入**：一键导出全部持久存储为 JSON 文件；导入**全量替换**（先自动留存当前数据再覆盖），支持跨设备迁移。

已确认的三个语义决策：导入 = 全量替换；API Key 是否入导出文件由勾选决定（默认不勾）；清理只给可再生数据。

不做（YAGNI）：按域合并导入、增量备份、定时自动备份、配额显示（MV3 `chrome.storage.local` 默认 10MB，本项目未申请 `unlimitedStorage`，现状统计够用）、导入文件的可视化预览挑选。

## 1. 数据域划分（统计分组依据）

存储全景（下表 key 为 WXT storage 写法，带 `local:` 区域前缀；**裸 `browser.storage.local` 的物理键无此前缀**，如 `scripts:index`、`conv:{id}:trace`。全量 dump/clear 只能用裸 API，故分组函数按物理键分类）：

| 数据域 | key（可多条） | 形态 |
|---|---|---|
| 会话本体 | `local:conv-index` + `local:conv:{id}` | index 单键 + per-conv |
| Agent 调用记录 | `local:conv:{id}:trace` | per-conv，隐藏大头 |
| 脚本池 | `local:scripts:index` | 单键 `UserScript[]`（≤200 条） |
| 技能 | `local:skills:index` | 单键 `Skill[]`（≤100 条） |
| 记忆 | `local:memory:index` | 单键 `MemoryEntry[]`（≤100 条） |
| 设置 | `local:settings` | 单键，**含 `provider.apiKey`**（嵌套在 provider 配置内） |
| GM 资源缓存 | `local:gm:resources` | 单键 map，7 天 TTL |
| GM 授权 | `local:gm:permissions` + `local:gm:seed` | 单键 |
| GM 脚本值 | `local:script-values:{scriptId}` | per-script |
| 更新状态 | `local:scripts:update-state`、`local:scripts:last-update-check`、`local:ext-update:state`、`local:ext-update:last-check` | 单键杂项 |
| 其它 | 未匹配前缀 | 兜底组 |

分组规则纯函数（可测）：key → 域 key。`conv:{id}` 与 `conv:{id}:trace` 按 `:trace` 后缀区分归属。条目数：per-key 域 = key 数；单键数组域 = 数组长度；其余不显示。

## 2. 消息协议（`shared/messages.ts`）

```ts
export type StorageManagerRequest =
  | { type: 'STORAGE_USAGE_GET' }
  | { type: 'STORAGE_CLEAN'; scope: { kind: 'gm-resources' } | { kind: 'trace'; convIds?: string[] } } // convIds 缺省 = 全清
  | { type: 'STORAGE_EXPORT'; includeApiKey: boolean }   // 返回 { filename, dataUrl }
  | { type: 'STORAGE_IMPORT'; payload: string };          // JSON 文本，返回导入结果
```

响应 data 形状：

```ts
// STORAGE_USAGE_GET
interface StorageUsage {
  totalBytes: number;
  groups: Array<{ group: string; bytes: number; items?: number }>;
  traces: Array<{ convId: string; title?: string; bytes: number }>;  // 清理列表（有 trace 的会话，按字节降序）
  gmResources: { bytes: number; count: number };
}
// STORAGE_IMPORT
interface StorageImportResult { apiKeyMissing: boolean }  // 导入后 settings.apiKey 为空 → UI 提示重填
```

## 3. 后台模块 `background/storage-manager.ts`

`initStorageManagerModule(router)` 注册四条消息。导出纯函数（分组、字节计算、备份文件拼装/校验）供测试直调。

### 3.1 统计

`browser.storage.local.get(null)` 全量拉取 → 按域分组 → `TextEncoder().encode(JSON.stringify(v)).length` 计字节（精确 UTF-8）。trace 域附带按会话明细（拼 conv-index 的标题）。

### 3.2 清理

- `gm-resources`：整键删除（下次用到重新预取，7 天 TTL 原语义）。
- `trace`：按 convIds 删 `local:conv:{id}:trace`；缺省删全部 trace 键。会话本体不动，conv-debug 页对应记录消失（确认卡写明）。

### 3.3 导出

1. `get(null)` 全量 → `includeApiKey=false` 时把物理键 `settings` 下 `provider.apiKey` 置空串（深路径精确处理，settings 其余字段保留）。
2. 文件体：`{ meta: { app: 'vevscript-ai', kind: 'full-backup', exportedAt, extVersion, includesApiKey }, data: {…} }`，`JSON.stringify(…, null, 2)`。
3. 文件名 `vevscript-ai-backup-v{extVersion}-{YYYYMMDD}.json`。
4. 下载：data: URL（base64，MV3 SW 无 `URL.createObjectURL`）。备份通常 <10MB 无虞；若未来 trace 巨大导致内存压力，退路是走现有 offscreen 先例建 blob URL（不在本期）。
5. 返回 `{ filename, dataUrl }`，**下载动作由 UI 侧 `browser.downloads.download` 发起**（与 AboutPage 下载惯例一致）。

### 3.4 导入（全量替换）

流程（bg 端 `handleImport`，原子性尽量保住）：

1. 校验：`JSON.parse` → `meta.app === 'vevscript-ai'` 且 `meta.kind === 'full-backup'` 且 `data` 为对象；否则抛中文可读错误，**不碰现有数据**。
2. 留存：把当前数据走 §3.3 导出管线（固定 `includeApiKey: true`——留存是给自己看的，必须完整）**先下载成功**（`chrome.downloads.download` resolve）再继续；下载发起失败则中止导入。
3. 替换：`browser.storage.local.clear()` → 一次性写入 `data`。
4. 检测：导入 data 的 `settings.provider.apiKey` 为空且**导入前本地原有 Key**（即导入时未勾含 Key）→ `apiKeyMissing: true`；本地本就没有则不提示。
5. 返回结果后由 **UI 调 `browser.runtime.reload()`**——数据整体变更后 SW/脚本引擎/菜单/会话状态全部重挂最干净；reload 前用结果文案告知「导入完成，即将重载」。

## 4. UI

### 4.1 入口

- `SettingsSub` 加 `'storage'`；GROUPS 新增「数据」组（置于「开发者工具」与「关于」之间），卡片「存储管理」desc「各域占用 / 清理缓存 / 导出导入备份」。
- `SettingsView` 加路由分支 → `components/settings/StoragePage.tsx`。

### 4.2 StoragePage 三区块（PageShell 复用）

1. **用量总览**：总计行（mono 字节）+ 各域行（名称 / 条目数 / 字节 mono / 迷你占比条，新增 `.stor__bar` 样式——现有 `.gauge` 是胶囊芯片不是进度条，不复用）+「刷新」按钮。占比条以最大域为 100% 基准（比以总计更有分辨力）。
2. **清理**：GM 资源缓存行（count + bytes + 清空）；Agent 调用记录区（按会话勾选 + 全清）。危险按钮用**行内二次确认**（首次点击按钮文案变「确认清理？」，5 秒内再点执行，超时还原），文案写明后果，完成后刷新统计。
3. **备份**：导出行（「包含模型 API Key」checkbox 默认不勾 + 导出按钮）；导入行（`<input type="file" accept=".json">` → 选中后确认卡「将覆盖当前全部数据；当前数据会先自动留存在下载目录」→ 确认后发 `STORAGE_IMPORT` → 成功提示 + `apiKeyMissing` 提示去模型设置重填 → `runtime.reload()`；失败行内报错不动数据）。

## 5. 测试 `tests/background/storage-manager.test.ts`

- 分组纯函数：各类 key 正确归组（含 `:trace` 后缀区分、未知 key 兜底）。
- 统计：伪造 storage 内容 → bytes/items 正确、trace 按会话降序。
- 清理：gm-resources 整键删除；trace 按 convIds / 全清；会话本体不受影响。
- 导出：`includeApiKey=false` 剔除 apiKey 且 settings 其余字段保留；文件名/meta 正确。
- 导入：坏 JSON / 缺 meta / kind 不符 → 抛错且不写库；合法 payload → clear+写入；留存下载失败 → 中止且原数据完好；`apiKeyMissing` 判定。

## 6. 已知边界

- 导入的「留存先行」依赖下载 API：用户环境下载被策略拦死时导入中止（fail-safe，不静默丢数据）。
- data: URL 导出对超大备份（>数十 MB）有内存压力，本期接受，退路见 §3.3。
- `runtime.reload()` 后侧边栏整页重载，属导入替换的预期行为。
- trace 明细需拼会话标题：已删会话的残留 trace（若有）title 置空仍可清理。
