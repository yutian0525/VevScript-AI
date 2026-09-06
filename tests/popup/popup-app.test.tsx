// tests/popup/popup-app.test.tsx
// popup 三区：导航按钮（开侧边栏/脚本管理直达）+ 当前页运行中脚本（菜单触发/编辑跳转）。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { PopupApp } from '../../components/popup/PopupApp';

afterEach(cleanup);

function mockBackend(opts: {
  entry?: { tabId: number; url: string; scriptIds: string[] } | null;
  commands?: Array<{ scriptId: string; commands: Array<{ key: string; name: string }> }>;
} = {}): void {
  browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
    if (msg.type === 'SCRIPTS_GET_RUNTIME_FOR_TAB') {
      sendResponse({ ok: true, data: { entry: opts.entry ?? null } });
      return true;
    }
    if (msg.type === 'SCRIPTS_GET_GM_STATE') {
      sendResponse({ ok: true, data: { menus: opts.commands ?? [], errors: {}, confirms: [] } });
      return true;
    }
    if (msg.type === 'SCRIPTS_LIST') {
      sendResponse({ ok: true, data: { scripts: opts.entry?.scriptIds.map((id) => ({ id, name: `脚本${id}`, enabled: true })) ?? [], engineAvailable: true } });
      return true;
    }
    if (msg.type === 'SCRIPTS_MENU_INVOKE') { sendResponse({ ok: true }); return true; }
    if (msg.type === 'SCRIPTS_SET_ENABLED') {
      const enabled = (msg as { enabled?: boolean }).enabled ?? true;
      const ids = opts.entry?.scriptIds ?? [];
      sendResponse({ ok: true, data: { script: { id: ids[0] ?? 'r1', enabled } } });
      return true;
    }
    sendResponse({ ok: false, error: 'unexpected' }); return true;
  });
}

describe('PopupApp', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('渲染两导航按钮 + RUNNING 计数头 + 空态', async () => {
    mockBackend({ entry: null });
    render(<PopupApp />);
    expect(screen.getByRole('button', { name: /打开侧边栏/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /脚本管理/ })).toBeTruthy();
    expect(await screen.findByText(/无脚本在此页运行/)).toBeTruthy();
  });

  it('打开侧边栏按钮：调 sidePanel.open({tabId})', async () => {
    mockBackend({ entry: null });
    (browser.tabs as unknown as { query: () => Promise<Array<{ id: number }>> }).query = vi.fn().mockResolvedValue([{ id: 9 }]);
    const openSpy = vi.spyOn(browser.sidePanel, 'open').mockResolvedValue(undefined);
    render(<PopupApp />);
    fireEvent.click(screen.getByRole('button', { name: /打开侧边栏/ }));
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledWith({ tabId: 9 }));
  });

  it('运行中脚本行渲染名称；编辑按钮常驻，调 tabs.create 开详情页且不关窗', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] } });
    const createSpy = vi.fn().mockResolvedValue({});
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<PopupApp />);
    expect(await screen.findByText('脚本r1')).toBeTruthy();
    const edit = screen.getByRole('button', { name: /编辑 脚本r1/ });
    // 常驻：不依赖 hover，无 opacity 隐藏
    expect(getComputedStyle(edit).opacity).toBe('1');
    fireEvent.click(edit);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('script-detail.html?id=r1') }));
    expect(closeSpy).not.toHaveBeenCalled(); // 编辑跳转不关浮窗（仅菜单触发路径关）
  });

  it('单菜单命令：点行直触 MENU_INVOKE 后 window.close', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] }, commands: [{ scriptId: 'r1', commands: [{ key: 'k1', name: '命令一' }] }] });
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<PopupApp />);
    const row = await screen.findByText('脚本r1');
    fireEvent.click(row);
    await vi.waitFor(() => {
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  it('多菜单命令：点行展开命令列表，点命令触发后关闭', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] }, commands: [{ scriptId: 'r1', commands: [{ key: 'k1', name: '命令一' }, { key: 'k2', name: '命令二' }] }] });
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<PopupApp />);
    const row = await screen.findByText('脚本r1');
    fireEvent.click(row);
    const cmd = await screen.findByText('命令二');
    fireEvent.click(cmd);
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
  });

  it('多菜单命令：展开后再点行收起命令列表', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] }, commands: [{ scriptId: 'r1', commands: [{ key: 'k1', name: '命令一' }, { key: 'k2', name: '命令二' }] }] });
    render(<PopupApp />);
    const row = await screen.findByText('脚本r1');
    fireEvent.click(row);
    expect(await screen.findByText('命令二')).toBeTruthy(); // 已展开
    fireEvent.click(row);
    await vi.waitFor(() => expect(screen.queryByText('命令二')).toBeNull()); // 再点行收起
  });

  it('零菜单命令：行可正常 hover 进详情，点击行本体不触发不关闭（无禁用观感）', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] }, commands: [] });
    const createSpy = vi.fn().mockResolvedValue({});
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<PopupApp />);
    const row = await screen.findByText('脚本r1');
    expect(row.closest('[aria-disabled="true"]')).toBeNull();
    fireEvent.click(row);
    expect(closeSpy).not.toHaveBeenCalled();
    // 行内启停开关仍可用，且不触发卡片导航
    fireEvent.click(screen.getByRole('switch', { name: /脚本r1/ }));
    await vi.waitFor(() => {
      expect(closeSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  it('运行中脚本行内启停开关：调 SET_ENABLED 且不触发卡片导航不关窗', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] } });
    const createSpy = vi.fn().mockResolvedValue({});
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<PopupApp />);
    const sw = await screen.findByRole('switch', { name: /脚本r1/ });
    fireEvent.click(sw);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'SCRIPTS_SET_ENABLED', id: 'r1', enabled: false }));
    await vi.waitFor(() => {
      expect(createSpy).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();
    });
  });

  it('运行行控件次序：编辑按钮在开关左侧', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] } });
    render(<PopupApp />);
    const sw = await screen.findByRole('switch', { name: /脚本r1/ });
    const edit = screen.getByRole('button', { name: /编辑 脚本r1/ });
    // sw→edit 返回 PRECEDING(2) ⇔ edit 位于 sw 之前（换位后：编辑在左、开关在右）
    expect(sw.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('脚本管理按钮：写 pendingView + 发 UI_NAV + 调 sidePanel.open', async () => {
    mockBackend({ entry: null });
    (browser.tabs as unknown as { query: () => Promise<Array<{ id: number }>> }).query = vi.fn().mockResolvedValue([{ id: 7 }]);
    const openSpy = vi.spyOn(browser.sidePanel, 'open').mockResolvedValue(undefined);
    const sessionSet = vi.spyOn(browser.storage.session, 'set');
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<PopupApp />);
    fireEvent.click(screen.getByRole('button', { name: /脚本管理/ }));
    await vi.waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith({ tabId: 7 });
      // pendingView 落 storage.session：key 'session:ui:pendingView'、值 'scripts'（WXT storage 去前缀存裸 key）
      expect(sessionSet).toHaveBeenCalledWith(expect.objectContaining({ 'ui:pendingView': 'scripts' }));
      // 实时广播 UI_NAV（侧边栏已开时立即切换）
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'UI_NAV', view: 'scripts' }));
    });
  });
});
