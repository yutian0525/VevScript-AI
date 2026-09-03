// tests/detail/detail-app.test.tsx
// 全屏详情页：四 Tab 切换、顶栏 switch 启停、不存在脚本空态。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DetailApp } from '../../components/detail/DetailApp';
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

function mockBackend(script: UserScript | null): void {
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
    if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
    if (msg.type === 'SCRIPTS_SET_ENABLED') { sendResponse({ ok: true, data: { script: mkScript({ enabled: false }) } }); return true; }
    sendResponse({ ok: false, error: 'unexpected' }); return true;
  });
}

describe('DetailApp', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
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
});
