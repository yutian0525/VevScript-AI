# 脚本详情页优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按规格 `docs/superpowers/specs/2026-09-04-script-detail-page-polish-design.md` 重构脚本详情页——header（头像+标题/副标题+外链 icon）、详情 Tab 中文化去卡片框（启停+删除操作区）、字体层级拉大。

**Architecture:** 数据层（`UserScriptMeta` 加 5 个展示性外链字段 + 解析/反拼）→ UI 层（`DetailApp` header 重构、`DetailInfoTab` 重写、`DetailSettingsTab`/`DetailLogsTab` 去卡片框）→ 样式（styles.css detail 区块调整）→ 测试同步改写。每步后 `npm run compile` + 相关测试绿再提交。

**Tech Stack:** WXT + React 19 + TypeScript 7 + vitest v4/jsdom + @testing-library/react + lucide-react。

**关键背景（实现者必读）：**

- 详情页是**独立浏览器标签页**（`script-detail.html?id=...`），不是侧边栏内路由——所以没有「关闭」按钮，删除成功后 `window.close()`。
- 样式全部在 `entrypoints/sidepanel/styles.css`（详情页也引这份），CSS 变量在 `:root`，**禁止硬编码色值**。
- 双声道排版：mono = 机器语言（match/grant/URL/run-at），sans = 人的语言（标签/说明）。**禁止 emoji 图标，用 lucide-react**。
- 工具结果判别联合 `{ ok: true, data? } | { ok: false; error }`。
- 测试环境 jsdom：`fakeBrowser.reset()` 复位 webextension polyfill；`browser.runtime.onMessage.addListener` 里 `sendResponse` 后 `return true`。
- `parseUserScript` 的警告顺序被测试钉住——新增键解析**不能产生新警告**。
- vite alias：项目内绝对导入如 `components/...`、`shared/...` 可用（wxt tsconfig paths）；测试里现有用例用相对路径，保持相对路径风格。

---

### Task 1: 数据层——meta 新增外链字段 + 解析/反拼（TDD）

**Files:**
- Modify: `shared/types.ts:27-41`（`UserScriptMeta`）
- Modify: `shared/userscript-meta.ts`（parse switch + stringify）
- Test: `tests/shared/userscript-meta.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/shared/userscript-meta.test.ts` 的 `describe('parseUserScript', ...)` 内追加：

```ts
  it('外链键解析进 meta：homepage/homepageURL 双键名、supportURL/icon/iconURL/downloadURL/updateURL', () => {
    const src = [
      '// ==UserScript==',
      '// @name        t',
      '// @match       https://a.com/*',
      '// @homepage    https://home.a.com/',
      '// @supportURL  https://support.a.com/',
      '// @icon        https://a.com/icon.png',
      '// @downloadURL https://a.com/s.user.js',
      '// @updateURL   https://a.com/u.meta.js',
      '// ==/UserScript==',
    ].join('\n');
    const { fields, warnings } = parseUserScript(src);
    expect(fields.meta).toMatchObject({
      homepage: 'https://home.a.com/',
      supportURL: 'https://support.a.com/',
      iconURL: 'https://a.com/icon.png',
      downloadURL: 'https://a.com/s.user.js',
      updateURL: 'https://a.com/u.meta.js',
    });
    // 新键不产生任何解析警告
    expect(warnings).toHaveLength(0);
  });

  it('@homepageURL 与 @iconURL 别名同字段，后写覆盖；不进 ignored 警告', () => {
    const src = [
      '// ==UserScript==',
      '// @match       https://a.com/*',
      '// @homepage    https://first.a.com/',
      '// @homepageURL https://second.a.com/',
      '// @iconURL     https://a.com/icon2.png',
      '// ==/UserScript==',
    ].join('\n');
    const { fields, warnings } = parseUserScript(src);
    expect(fields.meta.homepage).toBe('https://second.a.com/');
    expect(fields.meta.iconURL).toBe('https://a.com/icon2.png');
    expect(warnings.join('\n')).not.toContain('已忽略');
  });
```

在 `describe('stringifyUserScript / parse 往返', ...)` 内追加：

```ts
  it('外链 meta 往返无损（规范键名输出）', () => {
    const s: UserScript = {
      id: 's3', text: '', name: '外链', enabled: true, matches: ['https://a.com/*'],
      code: 'x();', runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user',
      meta: {
        homepage: 'https://home.a.com/',
        supportURL: 'https://support.a.com/',
        iconURL: 'https://a.com/icon.png',
        downloadURL: 'https://a.com/s.user.js',
        updateURL: 'https://a.com/u.meta.js',
      },
      createdAt: 0, updatedAt: 0,
    };
    const text = stringifyUserScript(s);
    expect(text).toContain('// @homepage     https://home.a.com/');
    expect(text).toContain('// @supportURL   https://support.a.com/');
    expect(text).toContain('// @iconURL      https://a.com/icon.png');
    expect(text).toContain('// @downloadURL  https://a.com/s.user.js');
    expect(text).toContain('// @updateURL    https://a.com/u.meta.js');
    const back = parseUserScript(text);
    expect(back.fields.meta).toEqual(s.meta);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/userscript-meta.test.ts`
Expected: 新增 3 用例 FAIL（`fields.meta.homepage` 为 undefined / `@icon` 进了 ignored 警告 / stringify 不含 `@homepage`）。

- [ ] **Step 3: 实现**

`shared/types.ts` 的 `UserScriptMeta`——在 `description?: string;` 之后插入：

```ts
  /** @homepage / @homepageURL（主页，TM 兼容双键名；纯展示不参与注入） */
  homepage?: string;
  /** @supportURL（反馈/支持页） */
  supportURL?: string;
  /** @icon / @iconURL（图标图片 URL，详情页头像） */
  iconURL?: string;
  /** @downloadURL（安装源） */
  downloadURL?: string;
  /** @updateURL（更新源） */
  updateURL?: string;
```

`shared/userscript-meta.ts` 的 `parseUserScript` switch——在 `case 'description'` 行后插入：

```ts
      case 'homepage': case 'homepageURL': if (value) meta.homepage = value; break;
      case 'supportURL': if (value) meta.supportURL = value; break;
      case 'icon': case 'iconURL': if (value) meta.iconURL = value; break;
      case 'downloadURL': if (value) meta.downloadURL = value; break;
      case 'updateURL': if (value) meta.updateURL = value; break;
```

`stringifyUserScript`——在 `if (meta.description) ...` 行后插入：

```ts
  if (meta.homepage) lines.push(`// @homepage     ${meta.homepage}`);
  if (meta.supportURL) lines.push(`// @supportURL   ${meta.supportURL}`);
  if (meta.iconURL) lines.push(`// @iconURL      ${meta.iconURL}`);
  if (meta.downloadURL) lines.push(`// @downloadURL  ${meta.downloadURL}`);
  if (meta.updateURL) lines.push(`// @updateURL    ${meta.updateURL}`);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/userscript-meta.test.ts`
Expected: 全部 PASS（含既有用例——「其它不支持的键汇总」用例里 `@icon a.png` 与 `@updateURL/@downloadURL` 现在会被解析，不再进 ignored 警告；该用例若因此挂掉，把 fixture 里的这三个键改成真正不支持的键如 `@foobar x`，断言结构不动）。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run compile && npm run test`
Expected: 编译零错、测试全绿。

```bash
git add shared/types.ts shared/userscript-meta.ts tests/shared/userscript-meta.test.ts
git commit -m "feat: UserScriptMeta 新增 homepage/supportURL/iconURL/downloadURL/updateURL 展示性外链字段"
```

---

### Task 2: Header 重构——头像 + 标题/副标题 + 外链 icon 组

**Files:**
- Modify: `components/detail/DetailApp.tsx`
- Modify: `entrypoints/sidepanel/styles.css`（`.detail__topbar` 区块）
- Test: `tests/detail/detail-app.test.tsx`（改写顶栏相关断言，新增外链/头像用例）

- [ ] **Step 1: 改写测试（先红）**

`tests/detail/detail-app.test.tsx`：

(a) `mkScript` 的 `meta` 补外链字段（覆盖 icon 加载与无 icon 回退两场景用参数控制）。

(b) 删除用例「顶栏 switch 启停调 SCRIPTS_SET_ENABLED」（Task 3 会以详情 Tab 按钮形式重建）。

(c) 改写用例「加载后默认展示详情 Tab」——去掉 `screen.getByRole('switch')` 断言，改为：

```tsx
  it('加载后默认展示详情 Tab：标题/副标题 + 左栏四导航', async () => {
    mockBackend(mkScript({ meta: { version: '1.0', author: '某人' } }));
    render(<DetailApp id="s1" />);
    expect(await screen.findByText('测试脚本')).toBeTruthy();
    expect(screen.getByText(/作者 某人/)).toBeTruthy();
    expect(screen.getByText('详情')).toBeTruthy();
    expect(screen.getByText('代码')).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
    expect(screen.getByText(/日志/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull(); // 顶栏无启停 switch
  });
```

(d) 新增外链 icon 用例：

```tsx
  it('有外链 meta 时 header 渲染对应 icon 按钮，点击 tabs.create 新标签打开', async () => {
    mockBackend(mkScript({ meta: { homepage: 'https://home.a.com/', supportURL: 'https://support.a.com/' } }));
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue(null as never);
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    const home = screen.getByRole('button', { name: '脚本主页' });
    screen.getByRole('button', { name: '反馈与支持' }); // supportURL 也有
    expect(screen.queryByRole('button', { name: '安装源' })).toBeNull(); // 无 downloadURL 不渲染
    fireEvent.click(home);
    expect(create).toHaveBeenCalledWith({ url: 'https://home.a.com/' });
  });

  it('无 iconURL 时头像显示名称首字', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    expect(screen.getByText('测')).toBeTruthy(); // 首字回退块
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/detail/detail-app.test.tsx`
Expected: 改写用例 FAIL（顶栏还是旧结构：有 switch、无外链按钮、无首字头像）。

- [ ] **Step 3: 实现 DetailApp header**

`components/detail/DetailApp.tsx` 重构为（imports 增加 `useEffect, useState` 与 lucide `Download, House, LifeBuoy, RefreshCw`；`X` 保留给空态关闭按钮）：

```tsx
// components/detail/DetailApp.tsx
// 全屏脚本详情页（2026-09-04 重设计）：header = 头像 + 标题/副标题 + 外链 icon 组；
// 左栏纯导航（详情/代码/设置/日志）；启停/删除在详情 Tab 内。
import { useEffect, useState } from 'react';
import { Download, House, LifeBuoy, RefreshCw, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import type { UserScript } from '../../shared/types';
import { useScriptDetail } from './useScriptDetail';
import { DetailInfoTab } from './DetailInfoTab';
import { DetailCodeTab } from './DetailCodeTab';
import { DetailSettingsTab } from './DetailSettingsTab';
import { DetailLogsTab } from './DetailLogsTab';

type TabKey = 'info' | 'code' | 'settings' | 'logs';

export function DetailApp({ id }: { id: string }) {
  const { script, setScript, errors, notFound, loading } = useScriptDetail(id);
  const [tab, setTab] = useState<TabKey>('info');
  const [message, setMessage] = useState('');
  const [iconFailed, setIconFailed] = useState(false);
  // 切换脚本时重置头像加载失败标记
  useEffect(() => { setIconFailed(false); }, [id]);

  function onScriptChanged(next: UserScript, note: string): void {
    setScript(next);
    setMessage(note);
  }

  async function remove(): Promise<void> {
    if (!script || !window.confirm(`删除脚本「${script.name}」？不可恢复。`)) return;
    const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_DELETE', id: script.id });
    if (resp.ok) window.close();
    else setMessage(resp.error ?? '删除失败');
  }

  if (loading) {
    return <div className="detail detail--empty">加载中…</div>;
  }
  if (notFound || !script) {
    return (
      <div className="detail detail--empty">
        <div className="chat__empty">脚本不存在或已被删除</div>
        <Button variant="ghost" onClick={() => window.close()}><X size={14} /> 关闭</Button>
      </div>
    );
  }

  const meta = script.meta ?? {};
  const avatarChar = script.name.trim()[0] || '未';
  const subtitleParts = [
    meta.author ? `作者 ${meta.author}` : '',
    meta.version ? `v${meta.version}` : '',
  ].filter(Boolean);
  const LINKS: Array<{ url?: string; label: string; icon: React.ReactNode }> = [
    { url: meta.homepage, label: '脚本主页', icon: <House size={15} /> },
    { url: meta.supportURL, label: '反馈与支持', icon: <LifeBuoy size={15} /> },
    { url: meta.downloadURL, label: '安装源', icon: <Download size={15} /> },
    { url: meta.updateURL, label: '更新源', icon: <RefreshCw size={15} /> },
  ];
  const links = LINKS.filter((l): l is { url: string; label: string; icon: React.ReactNode } => Boolean(l.url));

  const TABS: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'info', label: '详情' },
    { key: 'code', label: '代码' },
    { key: 'settings', label: '设置' },
    { key: 'logs', label: '日志', count: errors.length },
  ];

  return (
    <div className="detail">
      <header className="detail__topbar">
        {meta.iconURL && !iconFailed ? (
          <img className="detail__avatar" src={meta.iconURL} alt="" onError={() => setIconFailed(true)} />
        ) : (
          <span className="detail__avatar detail__avatar--fallback" aria-hidden>{avatarChar}</span>
        )}
        <div className="detail__headtext">
          <h1 className="detail__h1" title={script.name}>{script.name || '未命名脚本'}</h1>
          {subtitleParts.length > 0 && <div className="detail__subtitle">{subtitleParts.join(' · ')}</div>}
        </div>
        {links.length > 0 && (
          <div className="detail__links">
            {links.map((l) => (
              <Button
                key={l.label}
                variant="ghost"
                className="btn--icon"
                aria-label={l.label}
                title={`${l.label}：${l.url}`}
                onClick={() => void browser.tabs.create({ url: l.url })}
              >
                {l.icon}
              </Button>
            ))}
          </div>
        )}
      </header>
      <div className="detail__main">
        <nav className="detail__side" aria-label="详情页分区">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`detail__navitem${tab === t.key ? ' is-active' : ''}`}
              aria-current={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              <span>{t.label}</span>
              {t.count != null && <span className="detail__navcount mono">{t.count}</span>}
            </button>
          ))}
        </nav>
        <div className="detail__content">
          {message && <div className="scripts-warnline" role="status">{message}</div>}
          {tab === 'info' && <DetailInfoTab script={script} onChanged={onScriptChanged} onDelete={remove} />}
          {tab === 'code' && <DetailCodeTab script={script} onSaved={(s) => setScript(s)} />}
          {tab === 'settings' && <DetailSettingsTab id={script.id} />}
          {tab === 'logs' && <DetailLogsTab id={script.id} errors={errors} />}
        </div>
      </div>
    </div>
  );
}
```

注意：旧 `toggleEnabled` 从 DetailApp 删除（迁入 DetailInfoTab）；左栏删除按钮与 `.detail__side-spacer` 一并移除。

- [ ] **Step 4: 样式**

`entrypoints/sidepanel/styles.css`——`.detail__title` 行替换为 header 新类组（`.detail__topbar` 基础样式不动）：

```css
.detail__avatar {
  width: 40px; height: 40px; flex-shrink: 0; border-radius: var(--r-md);
  object-fit: cover; border: 1px solid var(--line);
}
.detail__avatar--fallback {
  display: flex; align-items: center; justify-content: center;
  background: var(--signal-wash); color: var(--signal-ink);
  font-size: 18px; font-weight: 600;
}
.detail__headtext { min-width: 0; }
.detail__h1 { font-size: 18px; font-weight: 600; margin: 0; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail__subtitle { font-size: 12px; color: var(--ink-2); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail__links { margin-left: auto; display: flex; gap: 4px; flex-shrink: 0; }
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `npx vitest run tests/detail/detail-app.test.tsx && npm run compile`
Expected: 新用例 PASS；旧用例中「Tab 切换」等仍 PASS（DetailInfoTab 尚未重构，此时它 props 未变会 TS 报错——**若 `DetailInfoTab` 还是旧签名（无 `onChanged`/`onDelete` props），本步先给 `DetailInfoTab` 加透传空实现**：

```tsx
// DetailInfoTab.tsx 签名临时改为（Task 3 全量重写）：
export function DetailInfoTab(
  { script, onChanged, onDelete }: { script: UserScript; onChanged: (next: UserScript, note: string) => void; onDelete: () => void | Promise<void> },
) {
```

旧 body 不动（未用 props 加下划线或直接留着——TS noUnusedParameters 若报错则参数前缀 `_`）。编译过、新用例 PASS 后提交）

```bash
git add components/detail/DetailApp.tsx components/detail/DetailInfoTab.tsx entrypoints/sidepanel/styles.css tests/detail/detail-app.test.tsx
git commit -m "feat: 详情页 header 重构——头像+标题/副标题+外链 icon 组，移除 eyebrow/switch/关闭钮与左栏删除"
```

---

### Task 3: 详情 Tab 重写——中文字段 + URL 链接 + 启停/删除操作区

**Files:**
- Modify: `components/detail/DetailInfoTab.tsx`（全量重写）
- Modify: `entrypoints/sidepanel/styles.css`（`.detail__inforow` 等）
- Test: `tests/detail/detail-app.test.tsx`

- [ ] **Step 1: 改写测试（先红）**

`tests/detail/detail-app.test.tsx`——删「有 http 标签时重载当前页可用」「无 http 标签时重载当前页禁用」两用例；「加载后默认展示」用例补操作区断言；新增：

```tsx
  it('详情 Tab：中文字段标签 + title tooltip 保留原键名', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    expect(screen.getByText('版本')).toBeTruthy();
    expect(screen.getByText('匹配规则')).toBeTruthy();
    expect(screen.getByText('权限申请')).toBeTruthy();
    expect(screen.getByTitle('version')).toBeTruthy();
    expect(screen.getByTitle('match')).toBeTruthy();
  });

  it('详情 Tab 操作区：启停按钮显示反向操作，点击调 SCRIPTS_SET_ENABLED', async () => {
    mockBackend(mkScript());
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<DetailApp id="s1" />);
    const btn = await screen.findByRole('button', { name: '禁用脚本' }); // 当前启用 → 显示禁用
    fireEvent.click(btn);
    await vi.waitFor(() => {
      const calls = sendSpy.mock.calls.filter((c) => (c[0] as unknown as { type: string }).type === 'SCRIPTS_SET_ENABLED');
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0]?.[0] as unknown as { enabled: boolean }).enabled).toBe(false);
    });
    // 成功后按钮文案切换（mock 返回 enabled=false 的脚本）
    expect(await screen.findByRole('button', { name: '启用脚本' })).toBeTruthy();
  });

  it('详情 Tab 删除按钮：confirm 确认后调 SCRIPTS_DELETE', async () => {
    mockBackend(mkScript());
    const close = vi.spyOn(window, 'close').mockReturnValue();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<DetailApp id="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: '删除脚本' }));
    await vi.waitFor(() => {
      const calls = sendSpy.mock.calls.filter((c) => (c[0] as unknown as { type: string }).type === 'SCRIPTS_DELETE');
      expect(calls.length).toBeGreaterThan(0);
    });
    expect(close).toHaveBeenCalled();
    void confirmSpy;
  });

  it('详情 Tab URL 字段渲染为链接按钮：namespace 可点击', async () => {
    mockBackend(mkScript({ meta: { namespace: 'https://example.org/' } }));
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue(null as never);
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    const link = screen.getByRole('button', { name: 'https://example.org/' });
    fireEvent.click(link);
    expect(create).toHaveBeenCalledWith({ url: 'https://example.org/' });
  });
```

注意「加载后默认展示」用例末尾补：

```tsx
    expect(screen.getByRole('button', { name: '禁用脚本' })).toBeTruthy(); // 默认 enabled
    expect(screen.getByRole('button', { name: '删除脚本' })).toBeTruthy();
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/detail/detail-app.test.tsx`
Expected: 新用例 FAIL（DetailInfoTab 还是英文 mono 键值 + 重载/导出按钮）。

- [ ] **Step 3: 全量重写 DetailInfoTab**

```tsx
// components/detail/DetailInfoTab.tsx
// 详情 Tab（2026-09-04 重写）：中文字段（title 保留原键名）+ URL 可点链接 + 底部操作区（启停/删除）。
// 双声道：标签 sans 人话；match/grant/run-at 等机器值 mono。
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { classifyGrants } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

interface Props {
  script: UserScript;
  /** 启停成功后回传新脚本 + 提示语（DetailApp 同步 header/横幅） */
  onChanged: (next: UserScript, note: string) => void;
  /** 删除（confirm 与 window.close 在 DetailApp） */
  onDelete: () => void | Promise<void>;
}

/** URL 形态值：渲染为可点链接（新标签打开），显示文本 = URL 本身 */
function UrlValue({ url }: { url: string }) {
  return (
    <Button variant="ghost" className="detail__link" title={url} onClick={() => void browser.tabs.create({ url })}>
      {url}
    </Button>
  );
}

export function DetailInfoTab({ script, onChanged, onDelete }: Props) {
  const meta = script.meta ?? {};
  const [busy, setBusy] = useState(false);

  async function toggleEnabled(): Promise<void> {
    setBusy(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
        type: 'SCRIPTS_SET_ENABLED', id: script.id, enabled: !script.enabled,
      });
      if (resp.ok && resp.data) {
        onChanged(resp.data.script, resp.data.script.enabled ? '已启用，刷新页面生效' : '已禁用，刷新页面生效');
      } else {
        onChanged(script, resp.error ?? '操作失败');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail__info">
      {meta.version && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="version">版本</span>
          <span>{meta.version}</span>
        </div>
      )}
      {meta.author && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="author">作者</span>
          <span>{meta.author}</span>
        </div>
      )}
      {meta.description && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="description">描述</span>
          <span>{meta.description}</span>
        </div>
      )}
      {meta.namespace && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="namespace">命名空间</span>
          <UrlValue url={meta.namespace} />
        </div>
      )}
      {meta.homepage && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="homepage">主页</span>
          <UrlValue url={meta.homepage} />
        </div>
      )}
      {meta.supportURL && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="supportURL">支持页</span>
          <UrlValue url={meta.supportURL} />
        </div>
      )}
      <div className="detail__inforow">
        <span className="detail__infokey" title="match">匹配规则</span>
        <span className="mono detail__infoval">{script.matches.length > 0 ? script.matches.join('  ') : '（无——脚本不会运行）'}</span>
      </div>
      <div className="detail__inforow">
        <span className="detail__infokey" title="run-at · world">注入时机 · 沙箱</span>
        <span className="mono detail__infoval">{script.runAt} · {script.world}</span>
      </div>
      {meta.grants && meta.grants.length > 0 && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="grant">权限申请</span>
          <span className="detail__grants">
            {meta.grants.map((g) => {
              const ok = classifyGrants([g]).supported.length > 0;
              return (
                <span key={g} className={`detail__grant mono${ok ? '' : ' detail__grant--bad'}`}>
                  {ok ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />} {g}
                </span>
              );
            })}
          </span>
        </div>
      )}
      <div className="detail__actions">
        <Button variant="signal" disabled={busy} onClick={() => void toggleEnabled()}>
          {script.enabled ? '禁用脚本' : '启用脚本'}
        </Button>
        <Button variant="danger" onClick={() => void onDelete()}>删除脚本</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 样式**

`entrypoints/sidepanel/styles.css`——`.detail__tabcard` 块整体删除，`.detail__inforow` 及相关替换为：

```css
.detail__info { max-width: 840px; margin: 0 auto; display: grid; gap: 10px; align-content: start; }
.detail__inforow { display: grid; grid-template-columns: 96px 1fr; gap: 10px; font-size: 13px; line-height: 1.6; align-items: baseline; }
.detail__infokey { font-size: 12px; color: var(--ink-3); }
.detail__infoval { word-break: break-all; }
.detail__link {
  justify-self: start; border: none; background: transparent; padding: 0;
  color: var(--signal-ink); cursor: pointer; font-size: 13px; font-family: var(--mono);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;
}
.detail__link:hover { text-decoration: underline; }
```

（`.detail__grants`/`.detail__grant`/`.detail__grant--bad`/`.detail__actions`/`.detail__hint`/`.detail__hostlist`/`.detail__hostrow`/`.detail__sectiontitle`/`.detail__logs`/`.detail__logrow`/`.detail__logmain`/`.detail__logstack` 保留不动。）

- [ ] **Step 5: 其余 Tab 去卡片框**

`DetailSettingsTab.tsx`：返回结构 `<div className="detail__tabcard">` → `<div className="detail__info">`；标题行：

```tsx
<div className="detail__sectiontitle">跨域授权名单</div>
```

（去 mono 类，中文化；hint 不动。）

`DetailLogsTab.tsx`：`<div className="detail__tabcard">` → `<div className="detail__info">`。

`.detail__sectiontitle` 样式改为 `font-size: 12px; color: var(--ink-2);`（去 mono 小字观感）。

- [ ] **Step 6: 全量回归 + 提交**

Run: `npm run compile && npm run test`
Expected: 编译零错、全部测试绿（`tests/ui/scripts-list.test.tsx` 不受影响——列表页没动）。

```bash
git add components/detail/DetailInfoTab.tsx components/detail/DetailSettingsTab.tsx components/detail/DetailLogsTab.tsx entrypoints/sidepanel/styles.css tests/detail/detail-app.test.tsx
git commit -m "feat: 详情 Tab 中文化去卡片框——中文字段+URL 链接+启停/删除操作区；设置/日志 Tab 同步去框"
```

---

### Task 4: 收尾——视觉核对 + 全量回归

**Files:**
- Modify: 无（发现问题才改）

- [ ] **Step 1: 构建 + 手动视觉核对**

Run: `npm run build`
Expected: 构建成功。

人工核对（Chrome 加载 `.output/chrome-mv3`，打开任一脚本详情页）：
- header：头像（或首字块）+ 18px 标题 + 副标题 `作者 X · vN`，外链 icon 只在有 meta 时出现，点击新标签打开。
- 详情 Tab：无卡片框，中文标签 + hover 出原键名 tooltip，URL 字段 mono 链接 hover 下划线，启停/删除按钮可用。
- 设置/日志 Tab：无卡片框。
- 整体字号层级：标题 > 字段值 > 标签。

- [ ] **Step 2: 全量回归**

Run: `npm run compile && npm run test`
Expected: 全绿。有失败先修再进下一步。

- [ ] **Step 3: 提交（如有微调）+ 完成汇报**

```bash
git status
# 有未提交微调则：
git add -A && git commit -m "fix: 详情页视觉核对微调"
```

汇报内容：改动文件清单、测试结果、已知取舍（@icon 裂图回退首字、导出走代码 Tab 复制）。
