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

  it('加载后默认展示详情 Tab：元信息 + 操作按钮 + 左栏四导航', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    expect(await screen.findByText('测试脚本')).toBeTruthy();
    expect(screen.getByText('详情')).toBeTruthy();
    expect(screen.getByText('代码')).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
    expect(screen.getByText(/日志/)).toBeTruthy();
    expect(screen.getByRole('switch')).toBeTruthy(); // 顶栏启停
    expect(screen.getByRole('button', { name: '重载当前页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出 .user.js' })).toBeTruthy();
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

  it('顶栏 switch 启停调 SCRIPTS_SET_ENABLED', async () => {
    mockBackend(mkScript());
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<DetailApp id="s1" />);
    const sw = await screen.findByRole('switch');
    fireEvent.click(sw);
    await vi.waitFor(() => {
      const calls = sendSpy.mock.calls.filter((c) => (c[0] as unknown as { type: string }).type === 'SCRIPTS_SET_ENABLED');
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0]?.[0] as unknown as { enabled: boolean }).enabled).toBe(false);
    });
  });

  it('有 http 标签时「重载当前页」可用，点击发 tabs.reload', async () => {
    mockBackend(mkScript());
    fakeBrowser.tabs.query = vi.fn().mockResolvedValue([{ id: 42, url: 'https://a.com', active: true, lastAccessed: 100 }]) as never;
    const reload = vi.spyOn(browser.tabs, 'reload').mockResolvedValue();
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    const btn = await screen.findByRole('button', { name: '重载当前页' });
    await vi.waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false));
    fireEvent.click(btn);
    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalled();
      expect(reload.mock.calls[0]?.[0]).toBe(42);
    });
  });

  it('无 http 标签时「重载当前页」禁用（降级路径）', async () => {
    mockBackend(mkScript());
    fakeBrowser.tabs.query = vi.fn().mockResolvedValue([]) as never; // 当前窗口 + 全量 http 查询都空
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    const btn = await screen.findByRole('button', { name: '重载当前页' });
    await vi.waitFor(() => expect(btn.hasAttribute('disabled')).toBe(true));
    expect(btn.getAttribute('title')).toBe('无可重载的网页');
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
});
