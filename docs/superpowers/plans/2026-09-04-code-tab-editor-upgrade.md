# 代码 Tab 编辑器升级实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按规格 `docs/superpowers/specs/2026-09-04-code-tab-editor-upgrade-design.md`——代码 Tab 升级为 CodeMirror 6 编辑器（行号/JS 高亮/自动缩进/Ctrl+S 保存），顶满高度不可 resize，工具栏重排（保存/导入/导出左侧，状态右侧），新增导入导出。

**Architecture:** 新建 `CodeEditor.tsx`（CM6 封装，useRef 转发回调防重建）→ 重写 `DetailCodeTab.tsx`（flex 列布局 + 工具栏重排 + 导入导出）→ styles.css 布局调整 → 测试（CM6 在 jsdom 可基础挂载；编辑器交互细节用文件级 vi.mock）。

**Tech Stack:** CodeMirror 6（codemirror@6.0.2 / lang-javascript / language / view / state）+ React 19 + vitest/jsdom。

**依赖已装**：`codemirror@^6.0.2`、`@codemirror/lang-javascript@^6.2.5`、`@codemirror/language@^6.12.4`、`@codemirror/view@^6.43.11`、`@codemirror/state@^6.7.2`（`@lezer/keymap` 不存在——keymap 类型由 `@codemirror/view` 导出）。

**关键背景（实现者必读）：**

- 样式全在 `entrypoints/sidepanel/styles.css`，CSS 变量 `:root`（`--sunken` 编辑区底、`--signal` 光标、`--signal-wash` 选区、`--line` 边框、`--ink-3` 行号），禁止硬编码色值，禁止 emoji 图标（lucide）。
- CM6 主题用 `EditorView.theme(..., { dark: false })` **写在组件内**（跟随 token），容器样式写 styles.css。
- `basicSetup` 已含行号/history/括号匹配/activeLine/折叠标尺/indentOnInput；Tab 缩进需显式加 `indentWithTab`（自 `@codemirror/commands`，codemirror 传递依赖，直接 import from '@codemirror/commands'——若包不可直接 import 则从 'codemirror' 无导出，需安装 `@codemirror/commands`）。
- 详情页独立标签页加载，CM6 体积不影响 sidepanel（Vite chunk 自动分离）。
- jsdom 下 CM6 可基础挂载（纯 DOM），但 `fireEvent.change` 对 contenteditable 无效——**既有 detail-app 用例与编辑器交互细节用例统一走文件级 mock**（mock 后 CodeEditor 渲染为受控 textarea）。
- 工具结果判别联合 `{ ok: true, data? } | { ok: false; error }`；`UserScript.text` 上限 280KB。

---

### Task 1: CodeEditor 组件（CM6 封装）+ mock 测试

**Files:**
- Create: `components/detail/CodeEditor.tsx`
- Test: `tests/detail/code-editor.test.tsx`

- [ ] **Step 1: 写失败测试（mock CM6，先测接口契约）**

`tests/detail/code-editor.test.tsx`：

```tsx
// tests/detail/code-editor.test.tsx
// CodeEditor 接口契约：mock 掉 CM6 内部（jsdom 无布局），渲染受控 textarea 透传行为。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { CodeEditor } from '../../components/detail/CodeEditor';

afterEach(cleanup);

// mock CM6 全家：CodeEditor 内部 import 的模块在 jsdom 无法真实布局，统一替换为空实现
vi.mock('codemirror', () => ({ basicSetup: [] }));
vi.mock('@codemirror/lang-javascript', () => ({ javascript: () => [] }));
vi.mock('@codemirror/language', () => ({ indentUnit: { of: () => [] } }));
vi.mock('@codemirror/view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/view')>();
  return {
    ...actual,
    EditorView: class {
      dom = document.createElement('div');
      constructor(_cfg?: unknown) {}
      dispatch() {}
      destroy() {}
      static theme() { return [] as unknown as never; }
    },
    keymap: { of: () => [] as unknown as never },
    drawSelection: () => [] as unknown as never,
  };
});
vi.mock('@codemirror/commands', () => ({ indentWithTab: { key: 'Tab', run: () => false } }));
vi.mock('@codemirror/state', () => ({ EditorState: { create: () => ({}) } }));

describe('CodeEditor（mock CM6 契约）', () => {
  it('渲染容器与初始 value（经 mock 的受控渲染路径）', () => {
    render(<CodeEditor value="let a = 1;" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />);
    expect(screen.getByLabelText('脚本源码')).toBeTruthy();
    expect((screen.getByLabelText('脚本源码') as HTMLTextAreaElement).value).toBe('let a = 1;');
  });

  it('change 触发 onChange（新值透传）', () => {
    let got = '';
    render(<CodeEditor value="old" onChange={(v) => { got = v; }} onSave={() => {}} ariaLabel="脚本源码" />);
    fireEvent.change(screen.getByLabelText('脚本源码'), { target: { value: 'new content' } });
    expect(got).toBe('new content');
  });

  it('Ctrl+S keydown 触发 onSave', () => {
    let saved = 0;
    render(<CodeEditor value="x" onChange={() => {}} onSave={() => { saved++; }} ariaLabel="脚本源码" />);
    fireEvent.keyDown(screen.getByLabelText('脚本源码'), { key: 's', ctrlKey: true });
    expect(saved).toBe(1);
  });
});
```

**mock 设计说明**：CodeEditor 实现为「props.value 同步到内部 CM6 doc + updateListener 回传 onChange」。mock 环境下 EditorView 是空壳，value→doc 同步链路不可用——所以 CodeEditor 的 mock 兼容路径：组件内部先渲染 `<textarea className="detail-code__textarea" aria-label>` 受控元素承载 value/onChange/onSave（**真实环境也保留此 textarea 作为 CM6 的 fallback？——不。决策：CodeEditor 单路径 CM6**，mock 里让假 EditorView.dom 挂 textarea。实现上让 mock 的 EditorView 构造器把一个真实 textarea 塞进 dom，CodeEditor 只管 `host.appendChild(view.dom)`。这样 mock/真实共用同一挂载代码路径，测试断言 textarea 即断言挂载点内容）。

> 实现约束重写：CodeEditor 组件结构 = `<div className="detail-code__editor-host-inner" aria-label={ariaLabel} ref={hostRef} />`，挂载后 `hostRef.current.appendChild(view.dom)`。mock 的 EditorView.dom 内含 textarea（mock 自建），因此 `getByLabelText` 命中。Ctrl+S 在 mock 下由 textarea keydown 透传（mock textarea 自带 keydown 监听调传入的 onSave？——mock 拿不到 onSave。**最终决策**：Ctrl+S 断言改为通过 `props.onSave` 在真实 keymap 里绑定、mock 无法覆盖——该行为不在 mock 层测，挪到 Task 3 手动核对 + 用例改为「组件挂载/卸载不抛错」与「value 变化后重新同步（view.dispatch 被调）」）。

**按上述约束修正后的测试文件**（替换上面 Step 1 的第三用例）：

```tsx
  it('props.value 变化时向 view.dispatch 同步新 doc', () => {
    const dispatched: unknown[] = [];
    vi.mocked // EditorView 是 mock class——用 spy 包装 dispatch
    const { rerender } = render(<CodeEditor value="v1" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />);
    // mock class 的实例方法在 host.appendChild 链路里已被使用；直接验证 rerender 不抛错 + 组件存活
    rerender(<CodeEditor value="v2" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />);
    expect(screen.getByLabelText('脚本源码')).toBeTruthy();
    void dispatched;
  });
```

（Ctrl+S 的 keymap 绑定行为放 Task 4 手动核对清单。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/detail/code-editor.test.tsx`
Expected: FAIL（`components/detail/CodeEditor.tsx` 不存在，无法 resolve import）。

- [ ] **Step 3: 实现 CodeEditor**

`components/detail/CodeEditor.tsx`：

```tsx
// components/detail/CodeEditor.tsx
// CodeMirror 6 封装（2026-09-04）：行号/JS 高亮/语法自动缩进/Ctrl+S 保存。
// 回调经 useRef 转发——extensions 数组只在挂载时构建一次，防 EditorView 随 render 重建。
import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { indentUnit } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  ariaLabel: string;
}

const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12.5px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { background: 'transparent', border: 'none', color: 'var(--ink-3)' },
    '.cm-activeLine': { background: 'var(--paper)' },
    '.cm-activeLineGutter': { background: 'transparent', color: 'var(--ink-2)' },
    '.cm-content': { caretColor: 'var(--signal)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--signal-wash)' },
    '.cm-cursor': { borderLeftColor: 'var(--signal)' },
  },
  { dark: false },
);

export function CodeEditor({ value, onChange, onSave, ariaLabel }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 最新回调放 ref：updateListener/keymap 闭包捕获 ref，不捕获过期 props
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // 挂载：创建 EditorView（一次）
  useEffect(() => {
    const view = new EditorView({
      state: {
        doc: '',
        selection: { anchor: 0 },
        extensions: [
          basicSetup,
          javascript(),
          EditorView.lineWrapping,
          indentUnit.of('  '),
          indentWithTab,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true; } },
          ]),
          EditorView.updateListener.of((v) => {
            if (v.docChanged) onChangeRef.current(v.state.doc.toString());
          }),
          editorTheme,
        ] as Extension[],
      },
      parent: hostRef.current!,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化（脚本切换/导入/保存回传）→ 全量替换 doc，光标收敛文件头
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: 0 },
      });
    }
  }, [value]);

  return <div ref={hostRef} className="detail-code__host" role="textbox" aria-label={ariaLabel} aria-multiline="true" />;
}
```

**注意**：`new EditorView({ state: {...} })` 这里传裸配置对象——CM6 的正规签名是 `EditorState.create({ doc, selection, extensions })` 再传 `state`。修正实现：直接用 `EditorState.create`：

```tsx
import { EditorState } from '@codemirror/state';
// useEffect 内：
const state = EditorState.create({
  doc: value,
  extensions: [ /* 同上 */ ],
});
const view = new EditorView({ state, parent: hostRef.current! });
```

（上面代码块的 `state: { doc:'', ... }` 写法作废，以这段为准；初始 doc 用首次的 `value`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/detail/code-editor.test.tsx`
Expected: PASS（mock 下：假 EditorView.dom 被 appendChild 进 host div；`getByLabelText` 命中 mock textarea？——**host div 自带 role=textbox + aria-label**，`getByLabelText` 命中的是 host div 本身而非 textarea。断言 `.value` 对 div 不成立——**最终修正测试断言**：

```tsx
  it('渲染容器（role=textbox + aria-label）', () => {
    render(<CodeEditor value="let a = 1;" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />);
    const host = screen.getByLabelText('脚本源码');
    expect(host).toBeTruthy();
    expect(host.getAttribute('role')).toBe('textbox');
  });

  it('value 变化 rerender 不抛错（mock 视图存活）', () => {
    const { rerender } = render(<CodeEditor value="v1" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />);
    rerender(<CodeEditor value="v2" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />);
    expect(screen.getByLabelText('脚本源码')).toBeTruthy();
  });
```

加上「onChange 经 updateListener 透传」在 mock 下不可行（updateListener 是真模块行为）——**删除 change 透传用例**，交互正确性由 Task 4 手动核对 + detail-app 集成用例（mock 同款）兜底。最终 3 用例：容器渲染、rerender 存活、卸载不抛错（新增：`unmount()` 后再 `screen.getByLabelText` 应为 null）。

）
Expected: 3 用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add components/detail/CodeEditor.tsx tests/detail/code-editor.test.tsx package.json package-lock.json
git commit -m "feat: CodeEditor 组件——CodeMirror 6 封装（行号/JS 高亮/自动缩进/Ctrl+S）"
```

---

### Task 2: DetailCodeTab 重写 + 布局顶满 + 样式

**Files:**
- Modify: `components/detail/DetailCodeTab.tsx`（重写）
- Modify: `entrypoints/sidepanel/styles.css`（`.detail-code` 区块）
- Test: `tests/detail/detail-app.test.tsx`

- [ ] **Step 1: 改写测试（先红）**

`tests/detail/detail-app.test.tsx` 顶部（import 之后、mkScript 之前）加文件级 mock（与 Task 1 同款 mock 块，复制过来——`vi.mock('codemirror', …)` 等 5 个模块 + EditorView 假类内含 textarea 以撑起既有「Tab 切换」「dirty 保存流」用例的 `getByRole('textbox')`/`fireEvent.change`）：

```tsx
// CM6 在 jsdom 无布局——mock 为受控 textarea，保住既有 textbox 语义用例
vi.mock('codemirror', () => ({ basicSetup: [] }));
vi.mock('@codemirror/lang-javascript', () => ({ javascript: () => [] }));
vi.mock('@codemirror/language', () => ({ indentUnit: { of: () => [] } }));
vi.mock('@codemirror/view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/view')>();
  const React = await import('react');
  return {
    ...actual,
    EditorView: class {
      dom = (() => {
        const wrap = document.createElement('div');
        const ta = document.createElement('textarea');
        wrap.appendChild(ta);
        return wrap;
      })();
      // @ts-expect-error 构造参数在 mock 中不使用
      constructor(_cfg?: unknown) {}
      dispatch() {}
      destroy() {}
      static theme() { return [] as unknown as never; }
    },
    keymap: { of: () => [] as unknown as never },
    drawSelection: () => [] as unknown as never,
  };
});
vi.mock('@codemirror/commands', () => ({ indentWithTab: { key: 'Tab', run: () => false } }));
vi.mock('@codemirror/state', () => ({ EditorState: { create: (cfg: { doc?: string }) => ({ doc: { toString: () => cfg.doc ?? '' }, extensions: cfg }) } }));
```

「dirty 保存流」用例改断言：mock 下 `fireEvent.change(textbox)` 打的是 host div（不是 textarea），**该用例改为对 mock textarea 定位**——mock textarea 无 aria-label，改为给 mock 的 textarea 复制 host 的 aria-label：

```tsx
// mock EditorView 类改为（构造时读 cfg.state?.doc 挂 textarea value）：
```

复杂度超限——**最终决策（简化）**：「dirty 保存流」与「Tab 切换」两个既有用例的编辑器交互，mock 层给 mock EditorView 加静态最后实例注册表，测试直接取 `EditorView.instances[0].dom.querySelector('textarea')` 操作。mock 类加 `static instances: any[] = []`，构造器里 `EditorView.instances.push(this)`，destroy 时移除。beforeEach 清空。

```tsx
// dirty 保存流用例改为：
  it('dirty 保存流：编辑源码 → 保存 → 顶栏显示新名字 + patch.text 正确（钉住 #2）', async () => {
    const newText = '// ==UserScript==\n// @name 新名字\n// @match *://*/*\n// ==/UserScript==\nconsole.log(2);';
    mockBackend(mkScript(), { updated: mkScript({ name: '新名字', text: newText, updatedAt: 2 }) });
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    const { EditorView } = await import('@codemirror/view');
    const ta = (EditorView as unknown as { instances: Array<{ dom: HTMLElement }> }).instances[0]!.dom.querySelector('textarea')!;
    fireEvent.change(ta, { target: { value: newText } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    expect(await screen.findByText('新名字')).toBeTruthy();
    const updateCalls = sendSpy.mock.calls.filter((c) => (c[0] as unknown as { type: string }).type === 'SCRIPTS_UPDATE');
    expect(updateCalls.length).toBeGreaterThan(0);
    expect((updateCalls[0]?.[0] as unknown as { patch: { text: string } }).patch.text).toBe(newText);
  });
```

> 但 mock 的假 EditorView.dispatch 是空函数、updateListener 不存在——`fireEvent.change(ta)` 不会触发 CodeEditor 的 onChange！**mock textarea 必须自带桥**：mock EditorView 构造器接收 cfg，把 `cfg.parent` 忽略、在 textarea 上挂 input 监听调 `cfg.state.extensions` 里找不到 updateListener——mock 拿到的是 EditorState.create 的产物（也是 mock 的）。**再简化（最终稿）**：mock 的 `EditorState.create` 把整个 cfg 存到返回值；mock EditorView 构造器从 `cfg.state.extensions` 无法解析——干脆 mock 层从 CodeEditor 组件协议入手：**让 CodeEditor 的 mock 不走组件内部，而是文件级 `vi.mock('../../components/detail/CodeEditor')`（对 detail-app.test.tsx 而言路径 `../../components/detail/CodeEditor`，直接 mock 组件本身）**：

```tsx
// detail-app.test.tsx 顶部：
vi.mock('../../components/detail/CodeEditor', () => ({
  CodeEditor: function MockCodeEditor(
    { value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel: string },
  ) {
    const React = require('react');
    return React.createElement('textarea', {
      'aria-label': ariaLabel,
      value,
      onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    });
  },
}));
```

> vi.mock 工厂里不能 require——用 `await vi.importActual` 或顶层 import React 后闭包引用。**最终稿**（vitest vi.mock 工厂提升限制——工厂内 import 用动态 importAsync 不行，工厂必须自包含；React 在文件顶部已 import，闭包可引用）：

```tsx
import React from 'react';
vi.mock('../../components/detail/CodeEditor', () => ({
  CodeEditor: (props: { value: string; onChange: (v: string) => void; ariaLabel: string }) =>
    React.createElement('textarea', {
      'aria-label': props.ariaLabel,
      value: props.value,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(e.target.value),
    }),
}));
```

> detail-app.test.tsx 目前 `import React from 'react'`？——无。需加。**此方案下 Task 1 的 code-editor.test.tsx 不再 mock CM6 模块，改为完全不 mock（真实挂 CM6 于 jsdom，只测容器挂载/卸载存活）**——jsdom 下 CM6 官方支持基础挂载（ViewTest 就在 jsdom 跑）。Task 1 测试改为真实挂载断言（host 有 `.cm-editor` 子节点）。Ctrl+S 手动核对。

（Task 1 Step 1 的 mock 块与用例相应简化，见 Task 1 修订标注。）

「Tab 切换」用例：`getByRole('textbox')` 命中 mock textarea（aria-label=脚本源码）→ 不变即过。

新增用例（detail-app.test.tsx）：

```tsx
  it('代码 Tab 工具栏：保存/导入/导出按钮在状态字左侧（DOM 顺序）', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    const bar = screen.getByText('已同步').parentElement!;
    const idxSave = Array.prototype.indexOf.call(bar.children, screen.getByRole('button', { name: /保存/ }));
    const idxImport = Array.prototype.indexOf.call(bar.children, screen.getByRole('button', { name: /导入/ }));
    const idxExport = Array.prototype.indexOf.call(bar.children, screen.getByRole('button', { name: /导出/ }));
    const idxStatus = Array.prototype.indexOf.call(bar.children, screen.getByText('已同步'));
    expect(idxSave).toBeLessThan(idxStatus);
    expect(idxImport).toBeLessThan(idxStatus);
    expect(idxExport).toBeLessThan(idxStatus);
  });

  it('导出：点击导出按钮触发 .user.js 下载', async () => {
    mockBackend(mkScript({ name: '我的脚本' }));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue();
    const clickSpy = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') {
        const a = realCreate('a');
        a.click = clickSpy;
        return a;
      }
      return realCreate(tag);
    });
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    const a = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(a.download).toBe('我的脚本.user.js');
    expect(revoke).toHaveBeenCalledWith('blob:mock');
  });

  it('导入：选文件替换内容并标记未保存', async () => {
    mockBackend(mkScript());
    const fileText = '// ==UserScript==\n// @name 导入的\n// @match *://*/*\n// ==/UserScript==\n';
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([fileText], 'imported.user.js', { type: 'text/javascript' });
    Object.defineProperty(file, 'text', { value: async () => fileText });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('● 未保存')).toBeTruthy();
  });

  it('导入超限：>280KB 报错且不替换内容', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new Array(280 * 1024 + 1).fill('a').join('');
    const file = new File([big], 'big.js', { type: 'text/javascript' });
    Object.defineProperty(file, 'text', { value: async () => big });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('文件过大（上限 280KB）')).toBeTruthy();
    expect(screen.getByText('已同步')).toBeTruthy(); // 未标记 dirty
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/detail/detail-app.test.tsx`
Expected: 新增 4 用例 FAIL（无导入/导出按钮、工具栏无顺序结构）。

- [ ] **Step 3: 重写 DetailCodeTab**

```tsx
// components/detail/DetailCodeTab.tsx
// 代码 Tab（2026-09-04 重写）：CM6 编辑器顶满 + 工具栏（保存/导入/导出 左，状态字 右）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Save, Upload } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { parseUserScript } from '../../shared/userscript-meta';
import type { UserScript } from '../../shared/types';
import { CodeEditor } from './CodeEditor';

const MAX_IMPORT_BYTES = 280 * 1024; // 与 UserScript.text 后端上限对齐

export function DetailCodeTab({ script, onSaved }: { script: UserScript; onSaved: (saved: UserScript) => Promise<void> | void }) {
  const [text, setText] = useState(script.text);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // 脚本切换/保存后同步基线
  useEffect(() => { setText(script.text); setDirty(false); }, [script.id, script.updatedAt]);

  // 实时解析预览（头部即配置，所见即所得——保存才落库重注册）
  const parsed = useMemo(() => parseUserScript(text), [text]);

  async function save(): Promise<void> {
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
      type: 'SCRIPTS_UPDATE', id: script.id, patch: { text },
    });
    if (resp.ok && resp.data) {
      setDirty(false);
      setMessage('已重新注册，刷新页面生效');
      await onSaved(resp.data.script);
    } else {
      setMessage(resp.error ?? '保存失败');
    }
  }

  function exportFile(): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(script.name || 'script').replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onImportFile(file: File): Promise<void> {
    const content = await file.text();
    if (content.length > MAX_IMPORT_BYTES) {
      setMessage('文件过大（上限 280KB）');
      return;
    }
    setMessage('');
    setText(content);
    setDirty(true);
  }

  const status = dirty ? '● 未保存' : parsed.warnings.length > 0 ? `${parsed.warnings.length} 条解析警告` : '已同步';

  return (
    <div className="detail-code">
      <div className="detail-code__bar">
        <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
          <Save size={14} /> 保存
        </Button>
        <Button variant="ghost" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> 导入
        </Button>
        <Button variant="ghost" onClick={exportFile}>
          <Download size={14} /> 导出
        </Button>
        <span className="detail-code__status mono">{status}</span>
      </div>
      {message && <div className="scripts-warnline" role="status">{message}</div>}
      {parsed.warnings.length > 0 && (
        <div className="scripts-warnline">
          {parsed.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      <div className="detail-code__editor-host">
        <CodeEditor
          value={text}
          onChange={(v) => { setText(v); setDirty(true); }}
          onSave={() => { if (dirty) void save(); }}
          ariaLabel="脚本源码"
        />
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".user.js,.js"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImportFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: 样式**

`entrypoints/sidepanel/styles.css`——`.detail-code` 区块（现 899-908 行附近）替换为：

```css
/* 代码 Tab：CM6 编辑器顶满剩余高度（不可拖拽 resize） */
.detail-code { display: flex; flex-direction: column; gap: 8px; height: 100%; width: 100%; }
.detail-code__bar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; width: 100%; }
.detail-code__status { margin-left: auto; font-size: 11px; color: var(--ink-3); flex-shrink: 0; }
.detail-code__editor-host {
  flex: 1; min-height: 0; overflow: hidden;
  background: var(--sunken); border: 1px solid var(--line); border-radius: var(--r-md);
}
.detail-code__editor-host .cm-editor { height: 100%; }
.detail-code__editor-host .cm-editor.cm-focused { outline: none; }
```

（删旧 `.detail-code__editor` 两行——textarea 已不存在。）

- [ ] **Step 5: 跑测试 + 编译确认通过**

Run: `npx vitest run tests/detail/detail-app.test.tsx tests/detail/code-editor.test.tsx && npm run compile`
Expected: 全 PASS、编译零错。

- [ ] **Step 6: Commit**

```bash
git add components/detail/DetailCodeTab.tsx entrypoints/sidepanel/styles.css tests/detail/detail-app.test.tsx
git commit -m "feat: 代码 Tab 重写——CM6 顶满+工具栏重排（保存/导入/导出左，状态右）+导入导出"
```

---

### Task 3: 全量回归 + 视觉核对

**Files:**
- Modify: 无（发现问题才改）

- [ ] **Step 1: 全量回归**

Run: `npm run compile && npm run test`
Expected: 编译零错、全部测试绿。失败先修。

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 构建成功（CM6 chunk 分离进详情页包）。

- [ ] **Step 3: 手动视觉核对（Chrome 加载 `.output/chrome-mv3`）**

清单：
- 代码 Tab：编辑器顶满窗口剩余高度、无 resize 手柄；行号列显示；JS 关键字/字符串/注释高亮；Enter 自动缩进（两空格）；Tab 键缩进；Ctrl+S 保存；Ctrl+Z 可撤销导入替换。
- 工具栏：保存/导入/导出左侧顶格；`● 未保存`/`N 条解析警告`/`已同步` 状态字右侧右对齐；dirty 时保存钮亮。
- 导出：下载 `{脚本名}.user.js` 内容 = 当前编辑器文本。
- 导入：选 .user.js 后内容替换、状态变未保存；>280KB 文件报错。
- 详情/设置/日志 Tab 不受影响（布局链未破坏）。

- [ ] **Step 4: 完成汇报**

改动文件清单、测试结果、已知取舍（CM6 体积 +~100KB gzip 仅详情页加载；高亮仅 JS；Tab 键在编辑器内缩进不移焦点）。
