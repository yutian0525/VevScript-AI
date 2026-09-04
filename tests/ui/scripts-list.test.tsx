// tests/ui/scripts-list.test.tsx
// 侧边栏脚本列表：卡片渲染 + switch 启停（冒泡阻断）+ 页眉 icon 按钮。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ScriptsListView } from '../../components/scripts/ScriptsListView';
import { useScripts } from '../../stores/scripts';
import type { ScriptSummary } from '../../shared/types';

afterEach(cleanup);

function mkSummary(over: Partial<ScriptSummary> = {}): ScriptSummary {
  return {
    id: 's1', name: '脚本一', enabled: true, matches: ['*://a.com/*'],
    description: undefined, runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', errorCount: 0, hasGrants: true, hasRequires: false,
    grantSupported: ['GM_getValue'], grantUnsupported: [],
    updatedAt: 1, ...over,
  } as ScriptSummary;
}

describe('ScriptsListView', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useScripts.setState({
      summaries: [mkSummary()],
      runtimeEntries: {}, activeTabId: null, query: '',
      engineWarning: null, menus: [], errors: {}, confirms: [],
    });
  });

  it('渲染脚本卡片：名称、匹配规则、switch；无 RUNNING/MENU 区、无来源徽标', async () => {
    const summaries = [
      mkSummary(),
      mkSummary({ id: 's2', name: 'AI 建的脚本', source: 'agent' as const }),
      mkSummary({ id: 's3', name: 'TM 导入脚本', source: 'import' as const, grantSupported: ['GM_xmlhttpRequest'], grantUnsupported: ['GM_cookie'] }),
    ];
    useScripts.setState({ summaries });
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') { sendResponse({ ok: true, data: { scripts: summaries, engineAvailable: true } }); return true; }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
    render(<ScriptsListView />);
    expect(await screen.findByText('脚本一')).toBeTruthy();
    expect(screen.getAllByRole('switch')).toHaveLength(3);
    expect(screen.queryByText(/RUNNING/)).toBeNull();
    expect(screen.queryByText(/MENU ·/)).toBeNull();
    expect(screen.getByRole('button', { name: '新建脚本' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导入脚本' })).toBeTruthy();
    // 来源徽标（user/agent/TM）不再渲染——来源对列表信息量低，窄栏挤空间
    expect(screen.queryByText(/^user$/)).toBeNull();
    expect(screen.queryByText(/^agent$/)).toBeNull();
    expect(screen.queryByText(/^TM$/)).toBeNull();
  });

  it('点击 switch 调 SCRIPTS_SET_ENABLED 且不触发卡片导航；tabs.create 未被调', async () => {
    const createSpy = vi.fn();
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') { sendResponse({ ok: true, data: { scripts: [mkSummary()], engineAvailable: true } }); return true; }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
      if (msg.type === 'SCRIPTS_SET_ENABLED') { sendResponse({ ok: true, data: { script: mkSummary({ enabled: false }) } }); return true; }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
    render(<ScriptsListView />);
    const sw = await screen.findByRole('switch');
    fireEvent.click(sw);
    expect(createSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SCRIPTS_SET_ENABLED', enabled: false }),
    );
  });

  it('键盘焦点在 switch 上按 Enter 不冒泡触发卡片导航', async () => {
    const createSpy = vi.fn().mockResolvedValue({});
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') { sendResponse({ ok: true, data: { scripts: [mkSummary()], engineAvailable: true } }); return true; }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
      if (msg.type === 'SCRIPTS_SET_ENABLED') { sendResponse({ ok: true, data: { script: mkSummary({ enabled: false }) } }); return true; }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
    render(<ScriptsListView />);
    const sw = await screen.findByRole('switch');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('点击卡片主体调 tabs.create 开全屏详情页', async () => {
    const createSpy = vi.fn().mockResolvedValue({});
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') { sendResponse({ ok: true, data: { scripts: [mkSummary()], engineAvailable: true } }); return true; }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
    render(<ScriptsListView />);
    const card = await screen.findByText('脚本一');
    fireEvent.click(card);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('script-detail.html?id=s1') }),
    );
  });
});
