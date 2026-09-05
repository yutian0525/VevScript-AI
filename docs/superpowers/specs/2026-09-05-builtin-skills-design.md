# 内置技能（帮助 / 发现脚本 / 编写脚本）设计

- 日期：2026-09-05
- 状态：已实现（本文件为设计记录）
- 分支：feat/moren-skill

## 1. 目标

三个默认内置技能随扩展安装进入技能列表，无需导入即可用：

| command | 名称 | 职责 |
|---|---|---|
| `help` | 帮助 | 介绍扩展各项功能（AI 操控浏览器、脚本池、GM API、技能系统、设置调试台），引导用户提问 |
| `find-scripts` | 发现脚本 | 确认需求 → 导航脚本站搜索 → 推荐候选 → 安装并介绍用法 |
| `write-script` | 编写脚本 | 确认需求 → 探索页面结构 → 编写 `.user.js` 并安装 → 测试迭代 |

只新增「技能内容 + 投放机制 + builtin 保护」，不动技能加载（`load_skill`）/斜杠/上下文注入链路。

## 2. 投放机制

- 三个技能以**多文档 .md 资源文件**存放：`public/skills/builtin.md`（WXT 构建拷贝到扩展根 `skills/builtin.md`），文档间用 `shared/skill-md.ts` 既有分隔符 `\n---\n\n` 串联。
- `background/builtin-skills.ts` 的 `seedBuiltinSkills()`：
  1. `fetch(browser.runtime.getURL('/skills/builtin.md'))` 拉取原文；
  2. `parseSkillMdDocument` 解析（坏文档跳过；全坏或空 → throw）；
  3. 逐条按 command 合入技能池：
     - **已存在同 command**（含用户从 .md 导入的同名技能）→ 覆盖 name/description/content 并打 `builtin: true`，**保留用户 id/createdAt/enabled**（升级不重置启停状态）；
     - **不存在** → `newSkill()` + `builtin: true` 写入。
- 挂载点：`entrypoints/background.ts` 现有 `runtime.onInstalled`（install 与 update 都触发 → 升级即拿到新版内容）。失败仅 console.warn，不阻断启动。SW 平时启动不跑，无重复开销。

### 决策记录

| 问题 | 决策 | 理由 |
|---|---|---|
| 落库还是虚拟条目 | 安装时落库 | 贴合现有 skills:index 存储，导入/导出/斜杠/搜索全链路零改动 |
| 删除语义 | builtin 只可停用、不可删 | 用户明确要求「仅允许禁用不允许删除」 |
| 升级时同 command | 覆盖为扩展新版 | SkillsPage 无编辑功能，用户不可能有本地修改；保证技能持续修 bug |
| 内容载体 | .md 资源文件而非 TS 常量 | 编辑器友好、与导入/导出格式天然一致、免转义 |

## 3. builtin 保护（仅禁用、不可删）

- `Skill` / `SkillSummary` 加 `builtin?: boolean`（`shared/types.ts`），`toSkillSummary` 透传。
- `storage/skills.ts` 的 `deleteSkill` 对 builtin 抛「内置技能不可删除，如不需要可停用」——消息层（`SKILLS_DELETE`）同样拒删，保护不只在 UI。
- `components/skills/SkillsPage.tsx`：
  - 列表卡片：builtin 不渲染删除钮，名字旁显示「内置」token 徽标（title 提示「不可删除，可停用」）；
  - 详情页：显示「内置」徽标，启停开关保留。
- 导入覆盖（用户导入同 command 的 .md）不解除 builtin 标记（`importSkillsText` 保留原记录字段，seed 路径再补标）。

## 4. 技能正文与站点情报

`find-scripts` 正文嵌入了用 chrome-devtools MCP 实测验证过的站点结构（2026-09-05）：

- **Greasy Fork**（主站，无限流实测正常）：
  - 搜索 `https://greasyfork.org/zh-CN/scripts?q={词}&sort=total_installs`（`language=zh-CN` 筛中文、`&page=N` 翻页）；
  - 列表行 `ol.script-list > li` 带 `data-script-id/name/daily-installs/total-installs/rating-score/updated-date/code-url`，可 `evaluate_script` 一次性提取 `li.dataset`；**首行可能是 ethical-ads 广告位（无 data-script-id），跳过**；
  - .user.js 直链 `https://update.greasyfork.org/scripts/{id}/{名称}.user.js`（= 详情页「安装此脚本」按钮 href），实测 HEAD 200 `text/javascript`。
- **OpenUserJS**（副站，**实测严格限流：连续请求即 429，约 1 分钟解封**）：
  - 搜索 `https://openuserjs.org/?q={词}&orderBy=installs&orderDir=desc`；
  - 详情 `/scripts/{作者}/{名}`；安装直链 `/install/{作者}/{名}.user.js`（实测可下载全文）；
  - 遇 429 等 60s 或回退 Greasy Fork——正文已写明。
- 安装走 `create_script(url=直链)`：`background/scripts-update.ts` 的 `handleImportUrl` 下载解析、自动注入 @updateURL（日后可检查更新）、`source: 'agent'` 入池。下载失败降级为打开详情页引导手动安装。
- `write-script` 强调：`create_script` 的 source 解析后必须有 @match；本扩展 GM API 共 14 个（`GM_xmlhttpRequest`/`GM_setValue`/…），脚本写法限定在该范围内；测试闭环 = `navigate_page` 刷新注入 → `take_screenshot`/`evaluate_script` 验证 → `update_script`（text/edit）迭代。

## 5. 测试

- `tests/background/builtin-skills.test.ts`（8 用例）：
  - 内容契约：`?raw` 导入真实 `public/skills/builtin.md`，断言恰好 3 文档、command 合法唯一（help/find-scripts/write-script）、name/description/content 非空且合规——保证内容改动不会被解析器悄悄吞掉；
  - `seedBuiltinSkills`：资源 404 throw、全坏文档 throw、空池投放三条全 builtin、已有同 command（用户导入过并停用）覆盖保留 id/enabled 且打 builtin、模拟升级覆盖为 v2 内容、投放后拒删。
- `tests/storage/skills.test.ts` 增 2 用例：builtin 拒删（普通不受影响）、`toSkillSummary` 透传 builtin。
- `tests/ui/skills-page.test.tsx`（2 用例）：builtin 卡片无删除钮 + 「内置」徽标、普通卡片删除钮照常；详情页徽标 + 启停开关。
- 全量：`npm run compile` 0 错、`npm test` 85 文件 837 用例全绿、`npm run build` 产出 `.output/chrome-mv3/skills/builtin.md`。

## 6. 不做的事

技能编辑、内置技能分组/筛选、运行时热更新、`load_skill`/斜杠/注入链路改动、按用户删除状态选择性补投。

## 7. 已知边界

- 用户手动导入与 builtin 同 command 的 .md 会临时覆盖内容（builtin 标记保留），下次升级才恢复扩展版——与「升级时覆盖」决策一致。
- `public/skills/builtin.md` 的正文含 `---` 水平线时会被解析器并段（skill-md 既有取舍），本次正文无水平线，未来编辑需留意。
- WXT `PublicPath` 类型来自 `wxt/browser`（`.wxt/types/paths.d.ts` 由 `wxt prepare` 生成），新增 public 资源后需重跑 `npx wxt prepare` 刷新类型。
