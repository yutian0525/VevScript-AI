# take_snapshot 完整内容树改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `take_snapshot` 从「可交互元素清单」升级为「完整内容树」，让模型看得见页面主体内容并能点击任意可见节点，对齐 Chrome MCP 的信息密度。

**Architecture:** 遍历从 `children` 换成 `childNodes`（看见文本节点）；每个产出节点都编 uid（Element 映射自身，StaticText 映射父元素）；`computeName` 收窄为仅可见文本、name-from-content 角色才取名；新增 `computeDescription` 聚合隐藏子菜单、`computeExtras` 补 url/haspopup/autocomplete；根节点输出 `RootWebArea`；`maxNodes` 上限兜底大页面。`interact.ts`、`agent/context.ts` 不改。

**Tech Stack:** TypeScript、WXT content script、vitest + jsdom、DOM `childNodes` / `getComputedStyle` / `WeakRef`。

**Spec:** `docs/superpowers/specs/2026-09-01-snapshot-full-content-tree-design.md`

---

## File Structure

- `content/snapshot/visibility.ts` — 隐藏判定；新增导出 `isSkipTag`（供描述聚合跳过 script/style）。
- `content/snapshot/roles.ts` — role/name/states/description/extras 计算。改 `computeName`，新增 `visibleText`、`computeDescription`、`collectHiddenText`、`computeExtras`，扩展 `computeStates`。
- `content/snapshot/build.ts` — 遍历组装。重写 `walk`/`serialize`/`shouldEmit`，遍历 childNodes、产出 StaticText、RootWebArea 根、每节点编 uid、折叠纯布局、序列化新字段、截断标记。
- `agent/tools/schemas.ts` — `take_snapshot` 描述补充「返回完整内容树；uid 定位可点元素，不保证逐行唯一」。
- 测试：`tests/content/snapshot/roles.test.ts`、`tests/content/snapshot/build.test.ts` 扩充；`tests/content/interact.test.ts`、`tests/content/handler.test.ts` 作回归（不改）。

执行顺序：Task 1→2→3 改 `roles.ts`/`visibility.ts`（`build.ts` 全程可编译，因 `computeName` 签名不变），Task 4 重写 `build.ts` 消费新函数，Task 5 收尾。

---

### Task 1: `computeName` 收窄为「仅可见后代文本 + name-from-content 角色」

当前 `computeName` 用 `el.textContent` 会把隐藏子菜单吞入名字（`营销` 变一长串），且对 `generic` 也返回聚合文本。改为：只有 button/link/heading/tab 等 name-from-content 角色才从内容取名，且只聚合**可见**后代文本；`generic`/`navigation`/`list` 等返回空（文本改由 StaticText 行承载，见 Task 4）。

**Files:**
- Modify: `content/snapshot/roles.ts`（新增 `visibleText`、重写 `computeName` 的兜底分支）
- Test: `tests/content/snapshot/roles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/content/snapshot/roles.test.ts` 的 `describe('name 计算', ...)` 内追加：

```ts
it('generic（div）不从内容取名，返回空', () => {
  expect(computeName(el('<div>一些说明文字</div>'))).toBe('');
});
it('name-from-content 角色只取可见后代文本，忽略隐藏子树', () => {
  const d = document.createElement('div');
  d.innerHTML = '<a href="/m">营销<div style="display:none">潜客挖掘 AI营销 全维搜索</div></a>';
  document.body.appendChild(d);
  const link = d.querySelector('a')!;
  expect(computeName(link)).toBe('营销');
  d.remove();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- roles`
Expected: FAIL —「generic 返回空」得到 `'一些说明文字'`；「忽略隐藏子树」得到 `'营销潜客挖掘 AI营销 全维搜索'`。

- [ ] **Step 3: 实现**

在 `content/snapshot/roles.ts` 顶部 import 后新增 `visibleText`，并把 `computeName` 的 textContent 兜底换成 name-from-content 判定：

```ts
import { isHidden } from './visibility';

// name-from-content：这些角色的可访问名可从其（可见）后代文本推导。
const NAME_FROM_CONTENT = new Set([
  'button', 'link', 'heading', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch',
]);

/** 聚合可见后代文本；跳过 isHidden 的子树。 */
export function visibleText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? '';
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (!isHidden(child)) out += visibleText(child);
    }
  }
  return out;
}
```

把 `computeName` 结尾的：

```ts
  const text = el.textContent ?? '';
  return trunc(text);
```

替换为：

```ts
  const role = computeRole(el);
  if (NAME_FROM_CONTENT.has(role)) return trunc(visibleText(el));
  return '';
```

（`aria-label`/`labelledby`、input 的 label/placeholder、img 的 alt 等前置分支保持不变。）

- [ ] **Step 4: 运行测试确认通过（含既有 name 用例回归）**

Run: `npm run test -- roles`
Expected: PASS。既有「aria-label 最高优先」「placeholder 次之」「alt」「textContent 兜底并截断」（button 属 NAME_FROM_CONTENT）「无名返回空串」「label[for]」「包裹式 label」全绿。

- [ ] **Step 5: 提交**

```bash
git add content/snapshot/roles.ts tests/content/snapshot/roles.test.ts
git commit -m "feat(snapshot): computeName 收窄为仅可见文本+name-from-content 角色"
```

---

### Task 2: `computeDescription` 聚合隐藏后代文本（对齐 Chrome）

给 link/button/tab/generic 计算 `description`：优先 `aria-describedby`/`aria-description`，否则聚合**被 `isHidden` 判定为隐藏**的后代文本（悬停子菜单、tooltip）。遍历带预算上限（≤300 节点、≤200 字），跳过 script/style。

**Files:**
- Modify: `content/snapshot/visibility.ts`（导出 `isSkipTag`）
- Modify: `content/snapshot/roles.ts`（新增 `collectHiddenText`、`computeDescription`）
- Test: `tests/content/snapshot/roles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/content/snapshot/roles.test.ts` 追加：

```ts
import { computeDescription } from '../../../content/snapshot/roles';

describe('description 计算', () => {
  it('聚合隐藏子菜单文本', () => {
    const d = document.createElement('div');
    d.innerHTML = '<a href="/m">营销<div style="display:none">潜客挖掘 AI营销 全维搜索</div></a>';
    document.body.appendChild(d);
    const link = d.querySelector('a')!;
    expect(computeDescription(link)).toBe('潜客挖掘 AI营销 全维搜索');
    d.remove();
  });
  it('无隐藏内容时返回空，不含可见文本', () => {
    const d = document.createElement('div');
    d.innerHTML = '<a href="/m">营销<span>可见副标题</span></a>';
    document.body.appendChild(d);
    expect(computeDescription(d.querySelector('a')!)).toBe('');
    d.remove();
  });
  it('aria-describedby 优先', () => {
    const d = document.createElement('div');
    d.innerHTML = '<span id="d">帮助说明</span><button aria-describedby="d">保存</button>';
    document.body.appendChild(d);
    expect(computeDescription(d.querySelector('button')!)).toBe('帮助说明');
    d.remove();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- roles`
Expected: FAIL — `computeDescription is not a function`（未导出）。

- [ ] **Step 3: 实现**

在 `content/snapshot/visibility.ts` 末尾追加导出：

```ts
export function isSkipTag(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName);
}
```

在 `content/snapshot/roles.ts` 追加（`isHidden` 已在 Task 1 import，需补 `isSkipTag`）：

```ts
import { isHidden, isSkipTag } from './visibility';

const DESC_ROLES = new Set(['link', 'button', 'tab', 'generic']);

/** 聚合 el 后代中「隐藏」的文本；带节点/字数预算，跳过 script/style。 */
export function collectHiddenText(el: Element): string {
  const parts: string[] = [];
  let visited = 0;
  let chars = 0;
  const walk = (node: Element, insideHidden: boolean) => {
    if (visited >= 300 || chars >= 200) return;
    if (isSkipTag(node)) return;
    const hidden = insideHidden || isHidden(node);
    for (const child of Array.from(node.childNodes)) {
      if (visited >= 300 || chars >= 200) break;
      if (child.nodeType === Node.TEXT_NODE) {
        if (hidden) {
          const t = (child.textContent ?? '').trim();
          if (t) { parts.push(t); chars += t.length; }
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        visited += 1;
        walk(child as Element, hidden);
      }
    }
  };
  walk(el, false);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function computeDescription(el: Element): string {
  const describedby = el.getAttribute('aria-describedby');
  if (describedby) {
    const ref = el.ownerDocument.getElementById(describedby);
    if (ref?.textContent?.trim()) return ref.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
  }
  const ariaDesc = el.getAttribute('aria-description');
  if (ariaDesc?.trim()) return ariaDesc.trim().slice(0, 200);
  if (!DESC_ROLES.has(computeRole(el))) return '';
  return collectHiddenText(el);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- roles`
Expected: PASS（3 条新用例 + 既有全绿）。

- [ ] **Step 5: 提交**

```bash
git add content/snapshot/roles.ts content/snapshot/visibility.ts tests/content/snapshot/roles.test.ts
git commit -m "feat(snapshot): computeDescription 聚合隐藏子菜单文本"
```

---

### Task 3: `computeExtras`（url/haspopup/autocomplete）+ `computeStates` 补 selectable/原生 selected

补齐 Chrome 有而当前缺的键值字段与状态。`url`=link 的 href 绝对化；`haspopup`=aria-haspopup；`autocomplete`=input 的 autocomplete 或 aria-autocomplete。`selectable`（tab/option）与原生 `<option selected>` 并入 `computeStates`。

**Files:**
- Modify: `content/snapshot/roles.ts`（新增 `NodeExtras` 类型 + `computeExtras`；扩展 `computeStates`）
- Test: `tests/content/snapshot/roles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/content/snapshot/roles.test.ts` 追加：

```ts
import { computeExtras } from '../../../content/snapshot/roles';

describe('extras 计算', () => {
  it('link 输出绝对 url', () => {
    const a = el('<a href="/home">首页</a>');
    expect(computeExtras(a).url).toContain('/home');
    expect(computeExtras(a).url!.startsWith('http')).toBe(true);
  });
  it('aria-haspopup', () => {
    expect(computeExtras(el('<div role="combobox" aria-haspopup="listbox"></div>')).haspopup).toBe('listbox');
  });
  it('input autocomplete', () => {
    expect(computeExtras(el('<input aria-autocomplete="list">')).autocomplete).toBe('list');
  });
  it('无相关属性时字段为 undefined', () => {
    const e = computeExtras(el('<button>x</button>'));
    expect(e.url).toBeUndefined();
    expect(e.haspopup).toBeUndefined();
  });
});

describe('states 补充', () => {
  it('tab 角色带 selectable', () => {
    expect(computeStates(el('<div role="tab">模板</div>'))).toContain('selectable');
  });
  it('原生 option selected', () => {
    const d = document.createElement('div');
    d.innerHTML = '<select><option selected>A</option></select>';
    expect(computeStates(d.querySelector('option')!)).toContain('selected');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- roles`
Expected: FAIL — `computeExtras is not a function`；`states` 两条断言 selectable/selected 缺失。

- [ ] **Step 3: 实现**

在 `content/snapshot/roles.ts` 追加类型与函数：

```ts
export interface NodeExtras { url?: string; haspopup?: string; autocomplete?: string }

export function computeExtras(el: Element): NodeExtras {
  const extras: NodeExtras = {};
  const role = computeRole(el);
  if (role === 'link') {
    const href = el.getAttribute('href');
    if (href) { try { extras.url = new URL(href, el.ownerDocument.baseURI).href; } catch { extras.url = href; } }
  }
  const hp = el.getAttribute('aria-haspopup');
  if (hp && hp !== 'false') extras.haspopup = hp;
  const ac = el.getAttribute('autocomplete') ?? el.getAttribute('aria-autocomplete');
  if (ac) extras.autocomplete = ac;
  return extras;
}
```

把 `computeStates` 改为（在现有 4 个 push 后追加 selectable/原生 selected）：

```ts
export function computeStates(el: Element): string[] {
  const states: string[] = [];
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  if ((el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true') states.push('checked');
  if (el.getAttribute('aria-expanded') === 'true') states.push('expanded');
  const role = computeRole(el);
  if (role === 'tab' || role === 'option') states.push('selectable');
  if (el.getAttribute('aria-selected') === 'true' || (el as HTMLOptionElement).selected) states.push('selected');
  return states;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- roles`
Expected: PASS。既有 states 用例（disabled/checked/aria-expanded）仍绿。

- [ ] **Step 5: 提交**

```bash
git add content/snapshot/roles.ts tests/content/snapshot/roles.test.ts
git commit -m "feat(snapshot): computeExtras(url/haspopup/autocomplete) + states 补 selectable/selected"
```

---

### Task 4: 重写 `build.ts` — 完整内容树遍历与序列化

遍历 `childNodes` 产出 StaticText（uid 映射父元素）；每个输出节点都编 uid；根输出 `RootWebArea "title" url`；`shouldEmit` 放开（保留纯布局折叠）；序列化拼接 name/haspopup/autocomplete/states/description/url；`maxNodes` 默认 1200 + 截断标记。`resolveUid`/`resetUidMap` 语义与导出不变（interact 链路零改）。

**Files:**
- Modify: `content/snapshot/build.ts`（重写 `SnapNode`、`walk`、`serialize`、`shouldEmit`；删除 `NO_NAME_FROM_CONTENT`、`isInteractive` 引用）
- Test: `tests/content/snapshot/build.test.ts`（新增用例 + 既有断言微调）

- [ ] **Step 1: 写失败测试（新增行为 + 更新既有）**

把 `tests/content/snapshot/build.test.ts` 内 `describe('快照组装', ...)` 追加以下新用例：

```ts
it('文本内容产出 StaticText 行并带 uid', () => {
  document.body.innerHTML = '<div>供应商准入排查</div>';
  const { text } = buildSnapshot(document.body);
  expect(text).toMatch(/\[\d+\] StaticText "供应商准入排查"/);
});

it('StaticText 的 uid 解析回父元素', () => {
  document.body.innerHTML = '<div id="card">使用模板</div>';
  buildSnapshot(document.body);
  const card = document.getElementById('card')!;
  let uid = 0;
  for (let i = 1; i < 10000; i++) { if (resolveUid(i) === card) { uid = i; break; } }
  // StaticText 行也应解析到同一父元素
  expect(resolveUid(uid)).toBe(card);
});

it('根输出 RootWebArea，含标题', () => {
  document.title = '启信慧眼';
  document.body.innerHTML = '<button>x</button>';
  const { text } = buildSnapshot(document.body);
  expect(text.split('\n')[0]).toMatch(/RootWebArea "启信慧眼"/);
});

it('纯布局 generic 折叠，子节点上提（无空 generic 行）', () => {
  document.body.innerHTML = '<div><div><button>深层按钮</button></div></div>';
  const { text } = buildSnapshot(document.body);
  expect(text).not.toMatch(/^\s*generic\s*$/m);
  expect(text).toContain('button "深层按钮"');
});

it('generic 有 description 时保留成行', () => {
  document.body.innerHTML = '<div role="group" aria-describedby="h">菜单</div><span id="h">帮助</span>';
  const { text } = buildSnapshot(document.body);
  expect(text).toMatch(/description="帮助"/);
});

it('link 输出 url', () => {
  document.body.innerHTML = '<a href="/home">首页</a>';
  const { text } = buildSnapshot(document.body);
  expect(text).toMatch(/link "首页".*url="[^"]*\/home"/);
});

it('maxNodes 截断标记含「未显示」', () => {
  const many = Array.from({ length: 20 }, (_, i) => `<button>b${i}</button>`).join('');
  document.body.innerHTML = `<div>${many}</div>`;
  const { text } = buildSnapshot(document.body, { maxNodes: 3 });
  expect(text).toContain('未显示');
});
```

同时更新既有用例 `'可交互元素带 [uid]，纯文本节点无 uid'` 的标题与断言（现在纯文本也有 uid）：

```ts
it('可交互元素带 [uid]；文本产出带 uid 的 StaticText', () => {
  document.body.innerHTML = '<button>登录</button><p>说明文字</p>';
  const { text } = buildSnapshot(document.body);
  expect(text).toMatch(/\[\d+\] button "登录"/);
  expect(text).toMatch(/\[\d+\] StaticText "说明文字"/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- snapshot/build`
Expected: FAIL — 多条新断言（StaticText 行、RootWebArea、url、未显示）在旧实现下不成立。

- [ ] **Step 3: 重写 `content/snapshot/build.ts`（第 1 段：import + 类型 + uidMap）**

替换文件头部到 `SnapNode` 定义为：

```ts
// content/snapshot/build.ts
// 完整内容树组装：DFS 遍历 childNodes → 过滤隐藏 → 每节点编 uid（Text 映射父元素）
// → RootWebArea 根 → 折叠纯布局 → 缩进序列化 → open shadow DOM 递归。
import { computeRole, computeName, computeStates, computeDescription, computeExtras, type NodeExtras } from './roles';
import { isHidden } from './visibility';

export interface SnapshotOptions {
  maxChildrenPerLevel?: number;
  maxNodes?: number;
}

const DEFAULTS: Required<SnapshotOptions> = { maxChildrenPerLevel: 200, maxNodes: 1200 };

let uidMap = new Map<number, WeakRef<Element>>();
let uidCounter = 0;

export function resetUidMap(): void {
  uidMap = new Map();
  uidCounter = 0;
}

export function resolveUid(uid: number): Element | null {
  const ref = uidMap.get(uid);
  if (!ref) return null;
  const el = ref.deref();
  if (!el || !el.isConnected) return null;
  return el;
}

interface SnapNode {
  role: string;
  name: string;
  states: string[];
  description: string;
  extras: NodeExtras;
  uid?: number;
  isText?: boolean;
  children: SnapNode[];
}
```

- [ ] **Step 4: 重写 `build.ts`（第 2 段：buildSnapshot + walk）**

替换 `buildSnapshot` 函数（到 `walk` 结束、`const tree = walk(root)` 之前的旧逻辑）为：

```ts
export function buildSnapshot(root: Element, opts: SnapshotOptions = {}): { text: string } {
  const cfg = { ...DEFAULTS, ...opts };
  resetUidMap();
  let nodeCount = 0;
  let truncated = false;

  function assignUid(el: Element): number {
    uidCounter += 1;
    uidMap.set(uidCounter, new WeakRef(el));
    return uidCounter;
  }

  // 遍历 el 的 childNodes：Element 递归 walkElement，非空文本产出 StaticText（uid=父）。
  function walkChildren(el: Element, parentUid: number, out: SnapNode[]): void {
    const kids: ChildNode[] = [];
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) kids.push(...Array.from(shadow.childNodes));
    kids.push(...Array.from(el.childNodes));

    let emitted = 0;
    for (const node of kids) {
      if (emitted >= cfg.maxChildrenPerLevel) {
        out.push({ role: `… [${kids.length - emitted} more]`, name: '', states: [], description: '', extras: {}, children: [] });
        break;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent ?? '').trim();
        if (!t) continue;
        if (nodeCount >= cfg.maxNodes) { truncated = true; break; }
        nodeCount += 1;
        out.push({ role: 'StaticText', name: t.slice(0, 200), states: [], description: '', extras: {}, uid: parentUid, isText: true, children: [] });
        emitted += 1;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const child = walkElement(node as Element);
        if (child) { out.push(child); emitted += 1; }
      }
    }
  }

  function walkElement(elem: Element): SnapNode | null {
    if (isHidden(elem)) return null;
    if (nodeCount >= cfg.maxNodes) { truncated = true; return null; }
    nodeCount += 1;
    const uid = assignUid(elem);
    const node: SnapNode = {
      role: computeRole(elem),
      name: computeName(elem),
      states: computeStates(elem),
      description: computeDescription(elem),
      extras: computeExtras(elem),
      uid,
      children: [],
    };
    walkChildren(elem, uid, node.children);
    return node;
  }

  // 根：RootWebArea（承载 title/url），其 children 来自 root 的 childNodes。
  const rootUid = assignUid(root);
  nodeCount += 1;
  const view = root.ownerDocument.defaultView;
  const rootNode: SnapNode = {
    role: 'RootWebArea',
    name: root.ownerDocument.title ?? '',
    states: [],
    description: '',
    extras: { url: view?.location?.href },
    uid: rootUid,
    children: [],
  };
  walkChildren(root, rootUid, rootNode.children);

  const lines: string[] = [];
  serialize(rootNode, 0, lines);
  if (truncated) lines.push(`… [还有更多节点未显示，快照已达节点上限 ${cfg.maxNodes} 被截断]`);
  return { text: lines.join('\n') };
}
```

- [ ] **Step 5: 重写 `build.ts`（第 3 段：serialize + shouldEmit + renderLine）**

替换文件尾部 `serialize`/`shouldEmit`（含删除 `NO_NAME_FROM_CONTENT`）为：

```ts
function serialize(node: SnapNode, depth: number, lines: string[]): void {
  const emit = shouldEmit(node);
  if (emit) {
    lines.push('  '.repeat(depth) + renderLine(node));
  }
  const nextDepth = emit ? depth + 1 : depth;
  for (const c of node.children) serialize(c, nextDepth, lines);
}

function renderLine(node: SnapNode): string {
  if (node.role.startsWith('…')) return node.role;
  const uid = node.uid != null ? `[${node.uid}] ` : '';
  const safeName = node.name.replace(/"/g, '\\"');
  const name = node.name ? ` "${safeName}"` : '';
  const hp = node.extras.haspopup ? ` haspopup="${node.extras.haspopup}"` : '';
  const ac = node.extras.autocomplete ? ` autocomplete="${node.extras.autocomplete}"` : '';
  const states = node.states.length ? ` {${node.states.join(',')}}` : '';
  const desc = node.description ? ` description="${node.description.replace(/"/g, '\\"')}"` : '';
  const url = node.extras.url ? ` url="${node.extras.url}"` : '';
  return `${uid}${node.role}${name}${hp}${ac}${states}${desc}${url}`;
}

/** 产出条件：截断占位、StaticText、RootWebArea、非 generic 有语义、或 generic 但有名/有 description。
 *  纯布局 generic（无名无 description）折叠，子节点上提。 */
function shouldEmit(node: SnapNode): boolean {
  if (node.role.startsWith('…')) return true;
  if (node.isText) return true;
  if (node.role === 'RootWebArea') return true;
  if (node.role !== 'generic') return true;
  return node.name !== '' || node.description !== '';
}
```

- [ ] **Step 6: 运行测试确认通过（含既有全部回归）**

Run: `npm run test -- snapshot/build`
Expected: PASS。既有用例：「隐藏元素不出现」「重置 uid 映射」「resolveUid stale」「嵌套缩进」「open shadow DOM」「超节点上限折叠(more)」「nav 抑制 name-from-content」「button/link/heading 名称保留」「name 引号转义」全绿；新用例 7 条全绿。

- [ ] **Step 7: 类型检查 + 全量测试**

Run: `npm run compile && npm run test`
Expected: 0 TS 错误；全绿（含 `interact.test.ts`、`handler.test.ts` 回归——uid→Element 语义未变）。

- [ ] **Step 8: 提交**

```bash
git add content/snapshot/build.ts tests/content/snapshot/build.test.ts
git commit -m "feat(snapshot): 重写 build 为完整内容树(StaticText/RootWebArea/每节点编 uid/放开产出)"
```

---

### Task 5: 更新 take_snapshot schema 描述 + 全链路验证

`take_snapshot` 返回内容语义已变（完整内容树、StaticText 也带 uid、uid 不逐行唯一），schema 描述需同步，让模型正确理解。

**Files:**
- Modify: `agent/tools/schemas.ts`（`take_snapshot` 的 `description`）
- Test: 全量 `npm run test`，构建 `npm run build`

- [ ] **Step 1: 更新 schema 描述**

把 `agent/tools/schemas.ts` 中 `take_snapshot` 的 description 从：

```ts
        '获取当前页面的可访问性快照（带 [uid] 编号的元素树）。后续 click/fill 等操作用 uid 定位元素。页面变化后应重新调用。',
```

改为：

```ts
        '获取当前页面的完整内容树：根为 RootWebArea，含所有可见元素与文本（StaticText）行，每行带 [uid]。用 uid 做 click/fill/hover。注意 uid 定位到可点击元素，同一元素下多行文本可能共享同一 uid（非逐行唯一）。隐藏子菜单聚合在父节点的 description 里，要操作需先 hover 展开再重新 take_snapshot。页面变化后 uid 会失效，需重新调用。',
```

- [ ] **Step 2: 类型检查**

Run: `npm run compile`
Expected: 0 错误。

- [ ] **Step 3: 全量测试**

Run: `npm run test`
Expected: 全绿。重点确认 `tests/agent/tools/schemas.test.ts`（若断言了 description 文案则同步）、`tests/content/*` 全过。

- [ ] **Step 4: 生产构建**

Run: `npm run build`
Expected: 构建成功、无报错。

- [ ] **Step 5: 提交**

```bash
git add agent/tools/schemas.ts
git commit -m "docs(schema): take_snapshot 描述改为完整内容树 + uid 非逐行唯一说明"
```

---

## Self-Review

**Spec coverage：**
- 完整内容树（保留 StaticText/generic/url/description）→ Task 1（name 收窄）、Task 2（description）、Task 3（extras）、Task 4（遍历 childNodes、放开 shouldEmit、序列化）。✓
- 每节点编 uid、可点 → Task 4（`walkElement`/`walkChildren` 均 assignUid，StaticText 用父 uid）。✓
- 节点数上限 + 截断标记 → Task 4（maxNodes 1200 + 「未显示」标记）。✓
- 隐藏子菜单聚合成 description → Task 2（`collectHiddenText`/`computeDescription`）。✓
- RootWebArea 根 → Task 4。✓
- 不改 interact.ts / context.ts → 全程未列入 Files，Task 4 Step 7 以回归测试证明。✓
- 输出格式 `[uid] role "name" haspopup autocomplete {states} description url` → Task 4 `renderLine`。✓
- schema 说明 uid 非逐行唯一 → Task 5。✓

**Placeholder scan：** 无 TBD/TODO；每个改码步骤含完整代码块与确切命令。

**Type consistency：** `NodeExtras`（Task 3 定义）在 Task 4 import 并用于 `SnapNode.extras`；`computeDescription`/`computeExtras`/`visibleText`/`collectHiddenText`/`isSkipTag` 定义与调用处签名一致；`resolveUid`/`resetUidMap` 导出名不变（interact/handler/既有测试依赖）。

**已知取舍：** StaticText 复用父 uid → uid 非逐行唯一（spec 风险项，已在 Task 5 schema 说明）；description 聚合遍历带 300 节点/200 字预算防大页面退化（Task 2）。
