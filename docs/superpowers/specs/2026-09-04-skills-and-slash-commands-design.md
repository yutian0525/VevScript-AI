# Skill 系统 + 斜杠指令 设计文档

日期：2026-09-04
分支：`feat/better-script`（worktree `D:\workspace-mou8\ai-browser-extend\.claude\worktrees\feat+script-optimize`）

## 0. 需求与决策记录

需求：系统级 skill 管理（设置页二级页）+ skill 简述常驻注入会话上下文（AI 自主遵循）+ 输入框 `/` 斜杠指令（浮层搜索与调用，像 Claude Code）。

已确认决策：

| 决策点 | 结论 |
|---|---|
| Skill 形态 | 纯指令正文（name + description + content），无参数模板、无绑定脚本 |
| 简述注入 | 全部启用项常驻注入 system prompt |
| AI 自主调用 | **新增 `load_skill` 工具（工具数 25→26）：AI 按 command 拉正文并遵循**（2026-09-05 修订，原为「无新工具位、遵循式」——但那样 AI 拿不到正文，无法自主加载） |
| 调用语义 | **`/command 原文` 就是普通 user 文本（不再注入正文）；正文改由 AI 调 `load_skill` 拉取，结果作为 tool 消息常驻历史**（2026-09-05 修订，原为「正文仅注入触发那一轮、不落库」） |
| 斜杠交互 | 浮层菜单 + Enter/Tab/点击均「补全而非发送」 |
| 管理页 | 列表 + 详情（仅查看）+ 导入/导出 .md；**无新建、无编辑** |
| md 格式 | YAML frontmatter（name/description/command）+ 正文 |
| 调用名 | 独立 `command` 字段（kebab-case ASCII）；**缺失/非法时从 name → 文件名自动派生 + warning**（2026-09-05 修订，原为「不自动生成」） |
| 重复导入 | command 相同 → 覆盖更新（保留原 id 与 enabled） |
| 启停 | 每 skill 独立开关；启用的才注入/进浮层 |

## 1. 数据模型与存储

### 1.1 类型（`shared/types.ts` 新增）

```ts
export interface Skill {
  id: string;          // nanoid
  name: string;        // 显示名（可中文）
  command: string;     // 斜杠调用名，如 "translate"（唯一键，kebab-case ASCII）
  description: string; // 简述，注入上下文 + 浮层副标题（≤300 字符）
  content: string;     // Markdown 指令正文（≤64KB）
  enabled: boolean;    // 启停开关
  createdAt: number;
  updatedAt: number;
}

export interface SkillSummary {
  id: string; name: string; command: string;
  description: string; enabled: boolean; updatedAt: number;
}
```

### 1.2 存储（`storage/skills.ts`）

- 单键 `local:skills:index`（`Skill[]`），与 `storage/scripts.ts` 同构，个人量级全量读写。
- API：`listSkills / getSkill / saveSkill / deleteSkill / setSkillEnabled`。
- 保存时校验：`command` 唯一 + 格式 `/^[a-z0-9][a-z0-9-]{0,31}$/`；上限 100 条；正文 ≤64KB；description ≤300 字符。超限/撞名 throw（中文可读文案）。
- 删除不存在的 id：幂等成功。

### 1.3 `.md` 文件格式（`shared/skill-md.ts` 纯函数）

```markdown
---
name: 网页翻译
description: 把当前页翻译成中文
command: translate
---
（正文 = Markdown 指令内容）
```

- 解析：YAML frontmatter 手写最小解析（逐行 `key: value`），不引第三方 YAML 库；多余键忽略。
- 缺 `command` 或格式非法（不合 `/^[a-z0-9][a-z0-9-]{0,31}$/`）→ `deriveCommand` 自动派生（优先 name，再文件名兜底：小写化、非 `[a-z0-9]` 段折叠为连字符、去首尾连字符、截断 32）+ warning；**仅当 name 与文件名均派生不出合法值（纯中文/纯符号）才拒绝该文档**（2026-09-05 修订，原为直接拒绝不静默生成）。
- 缺 name → 文件名（去 .md）兜底 + warning；缺 description → 空串 + warning。
- 无 frontmatter → 拒绝。
- 序列化：`serializeSkillMd(skill)` 按上述格式写回；多文档串联以 `\n---\n\n` 分隔。
- 多文档解析：按分隔符拆分逐个解析，单文档失败不影响其余（返回各自错误行）。

## 2. 消息协议与上下文注入

### 2.1 消息（`shared/messages.ts`，走既有 MessageRouter，与脚本池同构）

```ts
export type SkillsRequest =
  | { type: 'SKILLS_LIST' }
  | { type: 'SKILLS_GET'; id: string }
  | { type: 'SKILLS_DELETE'; id: string }
  | { type: 'SKILLS_SET_ENABLED'; id: string; enabled: boolean }
  | { type: 'SKILLS_IMPORT'; text: string; filename?: string }
  | { type: 'SKILLS_EXPORT'; ids?: string[] };   // 缺省 = 全部
```

- 无 CREATE/UPDATE：skill 只能来自 `.md` 导入（覆盖更新也走 import 通道）。
- 导入走 background（写 storage）；**导出在面板侧生成文件**（Blob + a[download]），`SKILLS_EXPORT` 只取数据。
- 编排层 `background/skills.ts`：handler 注册进 `router.ts`，内部调 `storage/skills.ts` + `shared/skill-md.ts`。导入返回 `{ ok, data: { imported: number, overwritten: number, warnings: string[] } }`（单次调用内多文档聚合）。
- 多选文件导入：面板逐文件发 `SKILLS_IMPORT`，前端汇总各响应的 imported/overwritten/warnings 展示。
- 无新 Port 事件：skill 变更不影响运行中 loop（下轮 buildContext 现读现用）。

### 2.2 上下文注入（`agent/context.ts`）

```ts
export interface SkillBrief { name: string; command: string; description: string }

export function buildSkillsPrompt(briefs: SkillBrief[]): string {
  // 空 → ''
  // 非空 → 「以下是可用技能的简述（不含正文）。当用户以 /command 触发某技能，
  //          或任务与某技能明显匹配时，先调 load_skill(command) 取正文再遵循执行，
  //          并向用户说明在用哪个技能；不要凭简述臆测正文：
  //          - /translate 网页翻译：把当前页翻译成中文 …」
}
```

- `buildContext` 加第 5 个可选参 `skills?: SkillBrief[]`，非空时 `buildSkillsPrompt` 结果追加进 system prompt 末尾。

### 2.3 loop 接入（`agent/loop.ts` + `background/agent-port.ts`）

- `LoopDeps` 加 `getSkills?: () => Promise<SkillBrief[]>`；`makeDeps` 实现：读 `storage/skills.ts` 过滤 enabled → map 成 briefs。
- `drive()` 每轮 buildContext 时调用并传入。

### 2.4 技能正文加载（2026-09-05 重构：斜杠不注入 → 统一走 `load_skill` 工具）

**动机**：原「斜杠触发轮注入正文」方案下，AI 手里只有常驻简述、拿不到正文，无法自主加载技能（任务匹配时也只能等用户打斜杠）。改为给 AI 一个拉正文的工具，正文进上下文只剩一条路径，issue「AI 无法自己触发加载」「加载提示单行 + 持久化」一并解决。

- **`load_skill` 工具**（第 26 个，`agent/tools/skills-tool.ts`）：参数 `command`（不含 /）。读 `storage/skills.ts`，命中启用技能 → `{ ok:true, data:{ name, command, content } }`；未命中/停用/storage 故障 → `{ ok:false, error }`。纯 storage 读，`registry.ts` 豁免受限页预检。
- **loop 处理**（`agent/loop.ts`）：删掉旧的斜杠解析 + 正文 splice 注入。`load_skill` 成功特判（仿 take_screenshot）：工具卡摘要 `已加载「{name}」`，tool 消息 content = `【技能指令 /{command}】\n{content}`（喂给模型），**落库进历史**。
- **`/command` 就是普通 user 文本**：不再有斜杠特殊处理；模型看到系统提示的简述 + 用户消息里的 `/command`，自行决定调 `load_skill`。command 不存在/停用 → 工具返回错误，模型自然应对。
- **常驻历史**（与旧「仅注入单轮」相反，2026-09-05 决策）：tool 结果留在历史，后续每轮重发给模型 → AI 持续遵循、可审计；代价是长正文占上下文，有压缩兜底。
- 斜杠浮层（§3）保留作**输入补全辅助**，补全后作为普通消息发送。

## 3. 斜杠浮层 UI（`components/chat/SlashMenu.tsx`）

### 3.1 触发与过滤

- textarea `onChange` 检测：光标前文本匹配 `/^\/(\S*)$/`（整条输入以 `/` 开头且尚未出现空格）→ 弹浮层；`/` 后已有空格 → 浮层关闭（附加文本阶段）。
- 候选 = 启用 skill 中 command/name/description 对查询的子串匹配（大小写不敏感），最多 8 条，command 前缀匹配优先；无启用 skill 或输入为空查询时输入 `/` 也弹全量列表。空匹配显示「没有匹配的技能」。
- 候选行：`/command`（mono）+ name（sans）+ description（弱化色）。
- 过滤逻辑抽纯函数 `filterSkills(list, query)`（可测）。

### 3.2 键盘与鼠标

- `↑/↓` 移动高亮、`Enter` 选中、`Esc` 关闭、`Tab` 补全。
- **Enter/Tab/点击语义 = 补全而非发送**：输入框变为 `/translate `（尾随空格），浮层关闭，焦点回输入框继续打附加文本（Claude Code 行为模型）；真正发送由浮层关闭后的下一次 Enter 完成。
- 鼠标点击候选走补全；浮层在 textarea blur 时关闭（候选 `onMouseDown` preventDefault 防 blur 先于 click）。
- 键盘导航状态机抽纯函数（可测）。

### 3.3 发送与渲染

- `send()` 对 `/` 开头文本走现有 `agent:start` 原样发送，零新消息类型；loop 侧 §2.4 负责识别。
- 聊天渲染：`/` 开头的 user 消息前加 `/command` 徽标 chip（mono、信号色）——数据即消息原文前缀，不改 store。
- 运行中输入框禁用现状不变，斜杠自然不可用。

### 3.4 样式（`styles.css`）

- `.slash-menu` 绝对定位于 `.composer` 上方（bottom:100% 反向弹出），复用 `.setting-card` 视觉语言；高亮态 `--signal` 弱底色；动画走既有 keyframes + `prefers-reduced-motion` 兜底。

## 4. Skill 管理二级页

- 入口：`SettingsSub` 加 `'skills'`；`SettingsHome` ENTRIES 加卡（lucide `Sparkles`，标题「技能管理」，desc「导入 .md 技能，注入会话上下文，斜杠指令调用」）；`SettingsView` 壳加路由分支。
- `components/skills/SkillsPage.tsx`（新目录，内部 useState 二级路由：列表 ↔ 详情）：
  - **列表页**：搜索（name/command/description）+ 导入（`Upload`，file input `accept=".md,text/markdown"`，多选）+ 导出（`Download`：有勾选导勾选、否则导全部）+ 卡片列表（`/command` mono 芯片 + name + description 弱化单行截断 + switch 启停 + 删除按钮 `window.confirm`）+ 卡片点击进详情。
  - 导入结果：复用 `.scripts-warnline` 样式显示 `导入 N 个，覆盖 M 个` + warnings 逐行。
  - **详情页（仅查看）**：顶部 `/command` + name + 启停 switch；description 完整展示；content 以 `.well` 井内 pre-wrap 展示 Markdown 原文（不渲染 HTML——正文是给 AI 的指令文本）；元信息行（updatedAt）。返回按钮回列表。
  - **导出**：面板侧 `serializeSkillMd` 拼 `.md`；单文件名 `{command}.md`，多文件名 `skills-{date}.md`。
- store：`stores/skills.ts` 与 `stores/scripts.ts` 同构——zustand 持 `list`，`refresh()` 发 `SKILLS_LIST`，操作后 refresh。

## 5. 错误处理

- 导入：单文档失败跳过 + warnings 记原因，不整体失败（贴合脚本池 `@match` 容错先例）；数量上限/正文超限逐条校验，超限条目跳过 + warning。
- `SKILLS_GET` 不存在的 id：error 返回；删除不存在的 id：幂等成功。
- 斜杠 command 已删/停用：不注入正文，原样普通文本跑。
- 浮层空匹配：显示「没有匹配的技能」占位行。
- 全部错误文案中文可读，与项目现状一致。

## 6. 测试

- `tests/shared/skill-md.test.ts`：解析（正常/缺 command 拒绝/缺 name、desc 兜底/无 frontmatter 拒绝/多余键忽略）、序列化往返幂等、多文档串联解析。
- `tests/storage/skills.test.ts`：CRUD、command 唯一性、上限、启停。
- `tests/background/skills.test.ts`：handler 编排——导入覆盖（同 command 保留 enabled/id）、多文档部分失败 warnings、导出 ids 过滤。
- `tests/agent/skills-context.test.ts`：`buildSkillsPrompt` 空/非空、`buildContext` 追加位置、斜杠解析正则、正文仅注入单轮（假 provider 断言）。
- `filterSkills` / 浮层键盘导航：纯函数测试。
- UI 组件沿用项目「纯逻辑抽函数测、组件 className 化轻测」现状。

## 7. 明确不做（划界）

- ~~不新增 AI 工具位~~（2026-09-05 修订：新增 `load_skill`，见 §2.4——原决策导致 AI 拿不到正文无法自主加载，故推翻）；不做 skill 编辑/新建；不做 per-skill 匹配规则/权限；不动 `storage/settings.ts`、Port 协议、`loop-guards`、压缩流程。
- 导出不做 zip/多文件打包（多选合并单 .md）。
