// tests/stores/scripts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useScripts, filterSummaries, selectMenuCommands } from '../../stores/scripts';
import type { ScriptSummary } from '../../shared/types';

function mkSummary(over: Partial<ScriptSummary> = {}): ScriptSummary {
  return {
    id: 's1', name: '去广告', matches: ['https://a.com/*'], enabled: true,
    source: 'user', runAt: 'document_idle', world: 'USER_SCRIPT',
    updatedAt: 1, hasGrants: false, errorCount: 0, hasRequires: false,
    grantSupported: [], grantUnsupported: [], ...over,
  };
}

describe('filterSummaries', () => {
  const list = [
    mkSummary({ id: '1', name: '去广告助手', matches: ['https://a.com/*'] }),
    mkSummary({ id: '2', name: '自动展开', matches: ['https://forum.example.com/*'] }),
    mkSummary({ id: '3', name: '下载器', matches: ['https://dl.io/*'], source: 'import' as const }),
  ];
  it('空查询原样返回', () => expect(filterSummaries(list, '')).toHaveLength(3));
  it('按 name 子串（大小写不敏感）', () => {
    expect(filterSummaries(list, '广告').map((s) => s.id)).toEqual(['1']);
  });
  it('按 matches 子串', () => {
    expect(filterSummaries(list, 'FORUM').map((s) => s.id)).toEqual(['2']);
  });
});

describe('scripts store', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useScripts.setState({ summaries: [], runtimeEntries: {}, activeTabId: null, query: '', loading: false, engineWarning: null });
  });

  it('applyRuntimeEvent：按 tabId 落 runtimeEntries；activeTabId 过滤后可取到当前页运行集', () => {
    useScripts.getState().setActiveTab(1);
    useScripts.getState().applyRuntimeEvent({ type: 'SCRIPTS_RUNTIME', payload: { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] } });
    useScripts.getState().applyRuntimeEvent({ type: 'SCRIPTS_RUNTIME', payload: { tabId: 2, url: 'https://b.com/', scriptIds: [] } });
    expect(useScripts.getState().runtimeEntries[1]).toMatchObject({ scriptIds: ['s1'] });
    const s = useScripts.getState();
    expect(s.runtimeEntries[s.activeTabId ?? -1]?.scriptIds).toEqual(['s1']);
  });

  it('refresh：LIST + GET_RUNTIME + activeTabId 一次拉齐（fake onMessage 应答）', async () => {
    let activeId: number | undefined;
    // fake-browser reset 后没有聚焦窗口：tabs.query({ currentWindow }) 会因 windows.getCurrent()
    // 返回 undefined 而抛 TypeError。真实浏览器恒存在聚焦窗口，这里先建一个对齐语义。
    await fakeBrowser.windows.create({ focused: true });
    await fakeBrowser.tabs.create({ url: 'https://a.com/', active: true }).then((t) => { activeId = t.id; });
    // fake-browser 契约：监听器必须经 sendResponse 应答并 return true，sendMessage 才拿得到返回值
    // （直接 return 响应对象会被 @webext-core/fake-browser 丢弃，与真实 Firefox 语义不同）
    browser.runtime.onMessage.addListener((msg: { type: string }, _sender, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') {
        sendResponse({ ok: true, data: { scripts: [mkSummary()], engineAvailable: true } });
        return true;
      }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') {
        sendResponse({ ok: true, data: { entries: [{ tabId: activeId, url: 'https://a.com/', scriptIds: ['s1'] }] } });
        return true;
      }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') {
        sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } });
        return true;
      }
      sendResponse({ ok: false, error: 'unexpected' });
      return true;
    });

    await useScripts.getState().refresh();
    const s = useScripts.getState();
    expect(s.summaries).toHaveLength(1);
    expect(s.activeTabId).toBe(activeId);
    expect(s.runtimeEntries[activeId!]?.scriptIds).toEqual(['s1']);
    expect(s.engineWarning).toBeNull();
  });

  it('refresh：LIST 失败（引擎不可用 flag）→ engineWarning 置位', async () => {
    // 同上：sendResponse + return true 的 fake-browser 应答契约
    browser.runtime.onMessage.addListener((msg: { type: string }, _sender, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') {
        sendResponse({ ok: true, data: { scripts: [], engineAvailable: false } });
        return true;
      }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') {
        sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } });
        return true;
      }
      sendResponse({ ok: true, data: { entries: [] } });
      return true;
    });
    await useScripts.getState().refresh();
    expect(useScripts.getState().engineWarning).toContain('不可用');
  });

  it('refresh：复水 GM 状态（menus/errors/confirms 一并填充）', async () => {
    await fakeBrowser.windows.create({ focused: true });
    await fakeBrowser.tabs.create({ url: 'https://a.com/', active: true });
    browser.runtime.onMessage.addListener((msg: { type: string }, _sender, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') {
        sendResponse({ ok: true, data: { scripts: [], engineAvailable: true } });
        return true;
      }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') {
        sendResponse({ ok: true, data: { entries: [] } });
        return true;
      }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') {
        sendResponse({ ok: true, data: {
          menus: [{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }] }],
          errors: { s1: [{ at: 1, message: 'boom', line: 3 }] },
          confirms: [{ confirmId: 'c1', scriptId: 's1', host: 'ext.com', url: 'https://ext.com/x', createdAt: 1 }],
        } });
        return true;
      }
      sendResponse({ ok: false, error: 'unexpected' });
      return true;
    });

    await useScripts.getState().refresh();
    const s = useScripts.getState();
    expect(s.menus).toEqual([{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }] }]);
    expect(s.errors['s1']).toHaveLength(1);
    expect(s.errors['s1']![0]).toMatchObject({ message: 'boom', line: 3 });
    expect(s.confirms).toHaveLength(1);
    expect(s.confirms[0]).toMatchObject({ confirmId: 'c1', scriptId: 's1', host: 'ext.com' });
  });
});

describe('Phase 5：menus/errors/confirms', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useScripts.setState({ summaries: [], runtimeEntries: {}, activeTabId: null, query: '', loading: false, engineWarning: null, menus: [], errors: {}, confirms: [] });
  });

  it('applyMenusEvent 全量替换', () => {
    useScripts.getState().applyMenusEvent({ entries: [{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }] }] });
    expect(useScripts.getState().menus).toHaveLength(1);
  });

  it('applyErrorEvent 追加 + 环形上限 20', () => {
    for (let i = 0; i < 25; i++) useScripts.getState().applyErrorEvent({ scriptId: 's1', error: { at: i, message: `e${i}` } });
    const errs = useScripts.getState().errors['s1']!;
    expect(errs).toHaveLength(20);
    expect(errs[0]!.message).toBe('e5');
  });

  it('applyConfirmEvent 入列 / applyConfirmResolved 出列', () => {
    useScripts.getState().applyConfirmEvent({ confirm: { confirmId: 'c1', scriptId: 's1', host: 'x.com', url: 'https://x.com/', createdAt: 1 } });
    expect(useScripts.getState().confirms).toHaveLength(1);
    useScripts.getState().applyConfirmResolved('c1');
    expect(useScripts.getState().confirms).toHaveLength(0);
  });

  it('applyErrorCleared 清某脚本错误', () => {
    useScripts.getState().applyErrorEvent({ scriptId: 's1', error: { at: 1, message: 'e' } });
    useScripts.getState().applyErrorCleared('s1');
    expect(useScripts.getState().errors['s1']).toBeUndefined();
  });

  it('selectMenuCommands：仅展开当前 tab 运行集内脚本的命令', () => {
    const entry = { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] };
    const menus = [
      { scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }] },
      { scriptId: 's2', commands: [{ key: 'm2', name: '别的' }] },
    ];
    expect(selectMenuCommands(entry, menus)).toEqual([{ scriptId: 's1', key: 'm1', name: '抓取' }]);
    expect(selectMenuCommands(undefined, menus)).toEqual([]);
  });
});
