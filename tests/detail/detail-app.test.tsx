// tests/detail/detail-app.test.tsx
// 全屏详情页：四 Tab 切换、header 外链/头像、详情 Tab 中文化/启停删除、代码 Tab 导入导出、不存在脚本空态。
// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DetailApp } from '../../components/detail/DetailApp';
import { useScripts } from '../../stores/scripts';
import type { GmErrorItem } from '../../stores/scripts';
import type { UserScript } from '../../shared/types';

// CM6 在 jsdom 无布局——CodeEditor mock 为受控 textarea，保住 textbox 语义与 change 交互用例
vi.mock('../../components/detail/CodeEditor', () => ({
  CodeEditor: (props: { value: string; onChange: (v: string) => void; ariaLabel: string }) =>
    React.createElement('textarea', {
      'aria-label': props.ariaLabel,
      value: props.value,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(e.target.value),
    }),
}));

afterEach(cleanup);

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1',
    text: '// ==UserScript==\n// @name 测试脚本\n// @match *://*/*\n// @grant GM_getValue\n// @grant NO_SUCH_API\n// ==/UserScript==\nconsole.log(1);',
    name: '测试脚本',
    enabled: true,
    matches: ['*://*/*'],
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    source: 'user',
    createdAt: 1,
    updatedAt: 1,
    meta: { grants: ['GM_getValue', 'NO_SUCH_API'] },
    ...over,
  } as UserScript;
}

/** updated：SCRIPTS_UPDATE 成功后回传的脚本（默认沿用原脚本）。
 *  gmErrors：SCRIPTS_GET_GM_STATE 回传的错误缓冲——挂载时 refresh() 会拉一次，
 *  echo 已 setState 的错误可避免 refresh 竞态把种子错误清空。 */
function mockBackend(
  script: UserScript | null,
  opts: { updated?: UserScript; gmErrors?: Record<string, GmErrorItem[]> } = {},
): void {
  browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
    if (msg.type === 'SCRIPTS_GET') {
      script
        ? sendResponse({ ok: true, data: { script } })
        : sendResponse({ ok: false, error: '脚本不存在' });
      return true;
    }
    if (msg.type === 'SCRIPTS_LIST') { sendResponse({ ok: true, data: { scripts: [], engineAvailable: true } }); return true; }
    if (msg.type === 'SCRIPTS_GET_RUNTIME') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
    if (msg.type === 'SCRIPTS_GET_PERMISSIONS') { sendResponse({ ok: true, data: { hosts: ['x.com'] } }); return true; }
    if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: opts.gmErrors ?? {}, confirms: [] } }); return true; }
    if (msg.type === 'SCRIPTS_SET_ENABLED') { sendResponse({ ok: true, data: { script: mkScript({ enabled: false }) } }); return true; }
    if (msg.type === 'SCRIPTS_UPDATE') { sendResponse({ ok: true, data: { script: opts.updated ?? script } }); return true; }
    if (msg.type === 'SCRIPTS_REVOKE_PERMISSION') { sendResponse({ ok: true }); return true; }
    if (msg.type === 'SCRIPTS_DELETE') { sendResponse({ ok: true }); return true; }
    sendResponse({ ok: false, error: 'unexpected' }); return true;
  });
}

describe('DetailApp', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // store 是模块单例，逐用例复位避免错误缓冲跨用例串台
    useScripts.setState({ summaries: [], runtimeEntries: {}, activeTabId: null, query: '', engineWarning: null, menus: [], errors: {} });
  });

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
    expect(screen.getByRole('button', { name: '禁用脚本' })).toBeTruthy(); // 默认 enabled → 显示反向操作
    expect(screen.getByRole('button', { name: '删除脚本' })).toBeTruthy();
  });

  it('详情 Tab：中文字段标签 + hover tooltip 显示原键名', async () => {
    mockBackend(mkScript({ meta: { version: '1.0', grants: ['GM_getValue'] } }));
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    expect(screen.getByText('版本')).toBeTruthy();
    expect(screen.getByText('匹配规则')).toBeTruthy();
    expect(screen.getByText('权限申请')).toBeTruthy();
    // 原键名从原生 title 迁移到自定义 Tooltip：hover 中文标签，气泡显示原键名
    fireEvent.mouseEnter(screen.getByText('版本'));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('version');
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

  it('详情 Tab 删除按钮：confirm 确认后调 SCRIPTS_DELETE 并关窗', async () => {
    mockBackend(mkScript());
    const close = vi.spyOn(window, 'close').mockReturnValue();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<DetailApp id="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: '删除脚本' }));
    await vi.waitFor(() => {
      const calls = sendSpy.mock.calls.filter((c) => (c[0] as unknown as { type: string }).type === 'SCRIPTS_DELETE');
      expect(calls.length).toBeGreaterThan(0);
      expect(close).toHaveBeenCalled();
    });
  });

  it('详情 Tab URL 字段渲染为链接按钮：namespace 可点击新标签打开', async () => {
    mockBackend(mkScript({ meta: { namespace: 'https://example.org/' } }));
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue(null as never);
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    const link = screen.getByRole('button', { name: 'https://example.org/' });
    fireEvent.click(link);
    expect(create).toHaveBeenCalledWith({ url: 'https://example.org/' });
  });

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

  it('Tab 切换：代码 Tab 显示编辑器；设置 Tab 显示 XHR 安全名单；日志 Tab 显示空态', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    expect(screen.getByRole('textbox')).toBeTruthy();
    fireEvent.click(screen.getByText('设置'));
    expect(await screen.findByText('x.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /撤销/ })).toBeTruthy();
    fireEvent.click(screen.getByText(/日志/));
    expect(screen.getByText('暂无错误')).toBeTruthy();
    expect(screen.getByText('脚本运行正常')).toBeTruthy();
  });

  it('脚本不存在时空态 + 关闭按钮', async () => {
    mockBackend(null);
    render(<DetailApp id="gone" />);
    expect(await screen.findByText('脚本不存在或已被删除')).toBeTruthy();
  });

  it('别处删除本脚本（SCRIPTS_CHANGED delete 广播）→ 跳「已删除」空态，不留 ghost', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fakeBrowser.runtime.onMessage.trigger({ type: 'SCRIPTS_CHANGED', reason: 'delete', ids: ['s1'] }, {} as never, () => {});
    expect(await screen.findByText('脚本不存在或已被删除')).toBeTruthy();
  });

  it('别处删除的是其它脚本（ids 不含本脚本）→ 详情页不受影响', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fakeBrowser.runtime.onMessage.trigger({ type: 'SCRIPTS_CHANGED', reason: 'delete', ids: ['other'] }, {} as never, () => {});
    expect(screen.getByText('测试脚本')).toBeTruthy();
    expect(screen.queryByText('脚本不存在或已被删除')).toBeNull();
  });

  it('代码 Tab 工具栏：保存/导入/导出按钮在状态字左侧（DOM 顺序）', async () => {
    // meta.grants 覆盖掉 fixture 默认值（NO_SUCH_API 会触发解析警告）→ 状态字为「已同步」
    mockBackend(mkScript({ text: '// ==UserScript==\n// @name 测试脚本\n// @match *://*/*\n// ==/UserScript==\nconsole.log(1);', meta: {} }));
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    const bar = screen.getByText('已同步').parentElement!;
    const idx = (el: Element) => Array.prototype.indexOf.call(bar.children, el);
    const idxSave = idx(screen.getByRole('button', { name: /保存/ }));
    const idxImport = idx(screen.getByRole('button', { name: /导入/ }));
    const idxExport = idx(screen.getByRole('button', { name: /导出/ }));
    const idxStatus = idx(screen.getByText('已同步'));
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
    await screen.findByText('我的脚本');
    fireEvent.click(screen.getByText('代码'));
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    const a = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(a.download).toBe('我的脚本.user.js');
    expect(revoke).toHaveBeenCalledWith('blob:mock');
    vi.restoreAllMocks();
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
    expect(screen.queryByText('● 未保存')).toBeNull(); // 未标记 dirty（fixture 有警告，状态字为「N 条解析警告」）
  });

  it('dirty 保存流：编辑源码 → 保存 → 顶栏显示新名字 + patch.text 正确（钉住 #2）', async () => {
    const newText = '// ==UserScript==\n// @name 新名字\n// @match *://*/*\n// ==/UserScript==\nconsole.log(2);';
    mockBackend(mkScript(), { updated: mkScript({ name: '新名字', text: newText, updatedAt: 2 }) });
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: newText } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    // 顶栏标题随保存后回传脚本同步（DetailApp 的 script state 更新）
    expect(await screen.findByText('新名字')).toBeTruthy();
    const updateCalls = sendSpy.mock.calls.filter((c) => (c[0] as unknown as { type: string }).type === 'SCRIPTS_UPDATE');
    expect(updateCalls.length).toBeGreaterThan(0);
    expect((updateCalls[0]?.[0] as unknown as { patch: { text: string } }).patch.text).toBe(newText);
  });

  it('撤销授权：设置 Tab 点撤销调 SCRIPTS_REVOKE_PERMISSION（host 正确）', async () => {
    mockBackend(mkScript());
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('设置'));
    fireEvent.click(await screen.findByRole('button', { name: /撤销/ }));
    await vi.waitFor(() => {
      const calls = sendSpy.mock.calls.filter((c) => (c[0] as unknown as { type: string }).type === 'SCRIPTS_REVOKE_PERMISSION');
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0]?.[0] as unknown as { host: string }).host).toBe('x.com');
    });
  });

  it('日志展开 stack：点行显示 stack + aria-expanded 切换', async () => {
    // gmErrors echo：refresh() 冷读会拉这份，避免竞态清空 setState 的种子
    const seeded: Record<string, GmErrorItem[]> = { s1: [{ at: 1, message: 'boom', stack: 'Error: boom\n at x' }] };
    mockBackend(mkScript(), { gmErrors: seeded });
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    useScripts.setState({ errors: seeded });
    fireEvent.click(screen.getByText(/日志/));
    const row = await screen.findByRole('button', { name: /boom/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/at x/)).toBeTruthy();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('设置 Tab：主标题「XHR 安全」+ 副题渲染；授权列表与撤销不受影响', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('设置'));
    expect(screen.getByRole('heading', { level: 2, name: 'XHR 安全' })).toBeTruthy();
    expect(screen.getByText(/这些域名已获得该脚本的跨域请求授权/)).toBeTruthy();
    expect(await screen.findByText('x.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /撤销/ })).toBeTruthy();
  });

  it('日志 Tab：标题「错误日志」+ 计数后缀；空态卡；清空按钮在工具行', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText(/日志/));
    expect(screen.getByRole('heading', { level: 2, name: /错误日志/ })).toBeTruthy();
    expect(screen.getByText('0 条')).toBeTruthy();
    expect(screen.getByText(/脚本运行抛错将记录在此/)).toBeTruthy();
    expect(screen.getByText('暂无错误')).toBeTruthy();
    expect(screen.getByText('脚本运行正常')).toBeTruthy();
    const clear = screen.getByRole('button', { name: '清空' });
    expect(clear.hasAttribute('disabled')).toBe(true); // 0 条时禁用（原语义保留）
  });
});
