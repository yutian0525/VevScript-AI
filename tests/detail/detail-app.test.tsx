// tests/detail/detail-app.test.tsx
// 全屏详情页：四 Tab 切换、顶栏 switch 启停、不存在脚本空态。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DetailApp } from '../../components/detail/DetailApp';
import { useScripts } from '../../stores/scripts';
import type { GmErrorItem } from '../../stores/scripts';
import type { UserScript } from '../../shared/types';

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
    useScripts.setState({ summaries: [], runtimeEntries: {}, activeTabId: null, query: '', engineWarning: null, menus: [], errors: {}, confirms: [] });
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

  it('详情 Tab：中文字段标签 + title tooltip 保留原键名', async () => {
    mockBackend(mkScript({ meta: { version: '1.0', grants: ['GM_getValue'] } }));
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
    expect(screen.getByText(/暂无错误/)).toBeTruthy();
  });

  it('脚本不存在时空态 + 关闭按钮', async () => {
    mockBackend(null);
    render(<DetailApp id="gone" />);
    expect(await screen.findByText('脚本不存在或已被删除')).toBeTruthy();
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
});
