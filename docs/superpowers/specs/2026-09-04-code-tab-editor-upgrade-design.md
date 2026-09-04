# 代码 Tab 编辑器升级设计（CM6 + 布局重排 + 导入导出）

日期：2026-09-04
状态：已确认（用户 ok）
分支：feat/script-ui-opt
前置：2026-09-04-script-detail-page-polish-design.md（已实现）

## 0. 背景与目标

代码 Tab 当前是裸 `<textarea>`（`min-height: calc(100vh - 200px)`、可拖拽 resize、零行号零高亮），工具栏「状态字在左 + 保存按钮在右」。目标：

1. 编辑器顶满页面剩余高度、不可拖拽调整。
2. 工具栏重排：保存 + 导入 + 导出按钮在左侧左对齐顶格；`已同步`/`未保存`/警告状态字在右侧右对齐。
3. 编辑器升级：行号、JS 语法高亮、自动缩进（用户选定 CodeMirror 6 方案）。

## 1. 澄清结论（用户已确认）

| 问题 | 结论 |
|---|---|
| 行号/高亮/自动缩进实现方式 | CodeMirror 6（引入 `codemirror` meta 包 + `@codemirror/lang-javascript`） |
| 导入行为 | 选文件后直接替换编辑器内容（标记 dirty，不弹确认；Ctrl+Z 可撤销） |
| 主题 | 不用外部主题包（one-dark 等与浅色仪表盘冲突），CM6 `EditorView.theme` 内联定制跟随项目 token |
| Q1 保存后光标 | CM6 异步保存不重置文档，天然保持 |
| Q2 导入尺寸限制 | 280KB（与 `UserScript.text` 后端上限对齐），超限报「文件过大（上限 280KB）」 |

## 2. 依赖变更

```
npm i codemirror @codemirror/lang-javascript @codemirror/language @codemirror/view @codemirror/state @lezer/keymap
```

- `codemirror`：meta 包（`basicSetup` = 行号 + history + 括号匹配 + activeLine + 折叠标尺等默认组合）。
- `@codemirror/lang-javascript`：JS 语法高亮 + 语法感知自动缩进。
- 不引入主题包；自动缩进基础 = `@codemirror/language`（codemirror 包的传递依赖，直接安装引用）的 `indentUnit.of("  ")`（两空格缩进单元）。

## 3. 组件结构

### 3.1 新建 `components/detail/CodeEditor.tsx`

CM6 封装组件，props：

```ts
interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;          // Ctrl+S / Mod-S 触发
  ariaLabel: string;           // 无障碍标签（沿用「脚本源码」）
}
```

- 挂载：`EditorView` 创建于 `div ref`，extensions = `[basicSetup, javascript(), EditorView.lineWrapping, indentUnit.of("  "), keymap.of([{ key: "Mod-s", run: () => { onSaveRef.current(); return true; } }, indentWithTab]), EditorView.updateListener.of(v => { if (v.docChanged) onChangeRef.current(v.state.doc.toString()); }), editorTheme]`。
- `onSave`/`onChange` 用 `useRef` 转发（避免 extensions 数组随每次 render 重建导致 EditorView 重建）。
- props.value 外部变化（脚本切换/导入替换/保存回传）时 `dispatch` 全量替换 doc 并保持光标在合理位置（替换后 `selection` 收敛到文件头，防越界）。
- 卸载 `view.destroy()`。
- `editorTheme` = `EditorView.theme({ '&': { height: '100%', fontSize: '12.5px' }, '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' }, '&.cm-focused': { outline: 'none' }, '.cm-gutters': { background: 'transparent', border: 'none', color: 'var(--ink-3)' }, '.cm-activeLine': { background: 'var(--paper)' }, '.cm-activeLineGutter': { background: 'transparent' }, '.cm-content': { caretColor: 'var(--signal)' }, '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--signal-wash)' } }, { dark: false })`。
- 容器样式（styles.css）：`.detail-code__editor-host { flex: 1; min-height: 0; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--sunken); overflow: hidden; }`，`.detail-code__editor-host .cm-editor { height: 100%; }`。

### 3.2 重写 `components/detail/DetailCodeTab.tsx`

```
<div className="detail-code">                    // flex 列布局顶满
  <div className="detail-code__bar">
    <Button variant="primary" disabled={!dirty} onClick={save}><Save 14/> 保存</Button>
    <Button variant="ghost" onClick={pickImport}><Upload 14/> 导入</Button>
    <Button variant="ghost" onClick={exportFile}><Download 14/> 导出</Button>
    <span className="detail-code__status">{statusText}</span>   // margin-left:auto 右对齐
  </div>
  {message && <div className="scripts-warnline">{message}</div>}
  {warnings.length > 0 && <div className="scripts-warnline">…</div>}
  <div className="detail-code__editor-host"><CodeEditor …/></div>
  <input type="file" hidden …/>
</div>
```

- 状态字三态不变：`● 未保存`（dirty）/ `N 条解析警告` / `已同步`；右对齐（`margin-left:auto; flex:none`）。
- `save()` 链路不变（`SCRIPTS_UPDATE` patch `{text}` → 成功后 `setDirty(false)` + message「已重新注册，刷新页面生效」+ `onSaved`）。
- 导出 `exportFile()`：`URL.createObjectURL(new Blob([text]))` + `a.download = ${name}.user.js`（非法字符 `[\\/:*?"<>|]` → `_`）+ revoke；名称取 `script.name || 'script'`。
- 导入 `onImportFile(file)`：`file.text()` → 超过 `280 * 1024` 字节则 `setMessage('文件过大（上限 280KB）')`；否则 `setText(content); setDirty(true)`，不弹确认。`fileRef` 隐藏 input，`accept=".user.js,.js"`，选择后 `e.target.value = ''` 复位。
- Ctrl+S 保存：CodeEditor `onSave` → `if (dirty) save()`。
- 原 textarea 的 Tab 键插两空格手写逻辑删除（CM6 `indentWithTab` 接管）。

### 3.3 布局链（顶满高度）

- `.detail` 已是 `flex-direction: column; height: 100vh`；`.detail__main` flex:1；`.detail__content` flex:1 + overflow auto。
- `.detail-code` 改 `display: flex; flex-direction: column; height: 100%; gap: 8px;`（去 max-width 破格保留：`max-width: none`），工具栏 `flex-shrink: 0`，`.detail-code__editor-host` `flex: 1; min-height: 0`。
- 工具栏取消 `max-width: 840px; margin: 0 auto`（顶格左对齐）。

## 4. 测试

### 4.1 CM6 在 jsdom 的处理

`vitest.config.ts` 或测试文件内 mock `codemirror` 相关模块——采用**测试文件级 `vi.mock`**：

- `tests/detail/code-editor.test.tsx` 顶部 `vi.mock('codemirror', …)` + `vi.mock('@codemirror/lang-javascript', …)` + `vi.mock('@codemirror/view', …)` 等，把 CodeEditor 内部替换为受控 `<textarea data-testid="cm-host">`：`value`/`onChange` 透传、`Ctrl+S` keydown 触发 `onSave`。
- DetailApp 级既有用例（`tests/detail/detail-app.test.tsx`「Tab 切换」「dirty 保存流」）不加 mock 会真实拉起 CM6——jsdom 下 CM6 能挂载（纯 DOM 操作，无 layout 断言），但为稳定与速度，在 `tests/setup` 层统一 mock？——**决策：不做全局 mock**，DetailApp 用例已在 jsdom 验证过 CM6 可挂载（CM6 官方支持 jsdom 基础渲染）；仅对「编辑器交互细节」用例用文件级 mock。若全量跑发现 CM6 在 jsdom 挂载报错，则回退为全局 mock（`tests/setup.ts` 不存在，改 `vitest.config.ts` `test.setupFiles` 新增）。

### 4.2 用例

- `tests/detail/code-editor.test.tsx`（新，mock CM6）：
  - 初始 value 渲染到 textarea；
  - change 触发 onChange 回调；
  - Ctrl+S（keydown `key='s' ctrlKey=true`）触发 onSave。
- `tests/detail/detail-app.test.tsx` 改/增：
  - 既有「Tab 切换」用例：`getByRole('textbox')` 在 CM6 真实挂载下仍成立（`contenteditable` 的 `contenteditable=true` role 是 textbox）——若失败改查 `.cm-content`；
  - 既有「dirty 保存流」：CM6 真实挂载下 `fireEvent.change` 对 contenteditable 无效——改为直接对 `.cm-content` 触发输入或用文件级 mock。**钉住方案：该用例改用 mock（文件级 vi.mock 放 detail-app.test.tsx 顶部，与 code-editor.test.tsx 同款），textarea 语义保留**；
  - 新增「导出：点击导出按钮触发 Blob 下载」（mock `URL.createObjectURL`/`revokeObjectURL`，断言 `a.download` 形如 `.user.js`）；
  - 新增「导入：选文件替换内容并标记 dirty（未保存态）」（mock `File.text()`，断言状态字变 `● 未保存` + 保存按钮 enabled）；
  - 新增「导入超限：>280KB 报错不替换」。

## 5. 已知取舍

- CM6 引入约 +300KB raw（gzip ~100KB），详情页为独立标签页按需加载（sidepanel 不受影响，chunk 分离）。
- 语法高亮仅 JS（`javascript()` 不开 jsx/ts 变体）——userscript 主体即 JS。
- 不做搜索面板（`search()` keymap 已在 basicSetup，Ctrl+F 浏览器原生搜索可用，不叠加 CM search panel UI）。
- CM6 在 jsdom 的渲染保真度有限（无真实布局），交互细节测试以 mock 层为准；真实行为靠 Task 手动核对兜底。
- `indentWithTab` 让 Tab 键在编辑器内缩进而非移动焦点——编辑器语义下可接受（Esc 可先跳出焦点再 Tab）。
