// tests/background/scripts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  computeRuntimeScriptIds, recomputeTab, recomputeAllTabs, dropTab, getRuntimeSnapshot,
  handleCreate, handleUpdate, handleDelete, handleSetEnabled, handleImport,
  syncRegistrations, initScriptsModule, ENGINE_UNAVAILABLE_MSG,
} from '../../background/scripts';
import { listScripts, saveScript } from '../../storage/scripts';
// 注：brief 写的是 import type，但用例里 new MessageRouter() 需要运行时值——type-only 导入会被擦除导致运行时 TypeError
import { MessageRouter } from '../../background/router';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', name: '测试', enabled: true, matches: ['https://a.com/*'],
    code: 'x();', runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('运行态跟踪（预期注入语义）', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // runtimeMap 是模块级状态，fakeBrowser.reset 不会清它——用公共导出清掉上一用例残留
    getRuntimeSnapshot().forEach((e) => dropTab(e.tabId));
  });

  it('computeRuntimeScriptIds：enabled + matchUrl 联合过滤', () => {
    const scripts = [
      mkScript({ id: 'a', matches: ['https://a.com/*'] }),
      mkScript({ id: 'b', enabled: false, matches: ['https://a.com/*'] }),
      mkScript({ id: 'c', matches: ['https://b.com/*'] }),
    ];
    expect(computeRuntimeScriptIds('https://a.com/x', scripts)).toEqual(['a']);
    expect(computeRuntimeScriptIds('chrome://extensions/', scripts)).toEqual([]);
    expect(computeRuntimeScriptIds('', scripts)).toEqual([]);
  });

  it('recomputeTab：运行集变化时广播 SCRIPTS_RUNTIME；不变不广播', async () => {
    await saveScript(mkScript());
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    await recomputeTab(1, 'https://a.com/');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      type: 'SCRIPTS_RUNTIME',
      payload: { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] },
    });

    spy.mockClear();
    await recomputeTab(1, 'https://a.com/'); // 同 url 同集合 → 不广播
    expect(spy).not.toHaveBeenCalled();
    expect(getRuntimeSnapshot()).toEqual([{ tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] }]);
  });

  it('recomputeAllTabs：按 tabs.query 全量重算', async () => {
    await saveScript(mkScript({ id: 's1', matches: ['https://a.com/*'] }));
    await saveScript(mkScript({ id: 's2', matches: ['https://b.com/*'] }));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await fakeBrowser.tabs.create({ url: 'https://a.com/' });
    await fakeBrowser.tabs.create({ url: 'https://b.com/' });

    await recomputeAllTabs();
    const snap = getRuntimeSnapshot();
    expect(snap).toHaveLength(2);
    const urls = snap.map((e) => e.url).sort();
    expect(urls).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('dropTab 移除条目', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await recomputeTab(7, 'https://a.com/');
    dropTab(7);
    expect(getRuntimeSnapshot()).toEqual([]);
  });
});

interface FakeUserScriptsApi {
  register: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  getScripts: ReturnType<typeof vi.fn>;
}

/** 往 fakeBrowser 挂 userScripts stub（WXT fakeBrowser 未内置该 API）。 */
function installFakeUserScripts(over: Partial<FakeUserScriptsApi> = {}): FakeUserScriptsApi {
  const api: FakeUserScriptsApi = {
    register: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => {}),
    getScripts: vi.fn(async () => [] as Array<Record<string, unknown>>),
    ...over,
  };
  (browser as unknown as Record<string, unknown>).userScripts = api;
  return api;
}

/** fakeBrowser.reset() 不一定清掉自定义属性——引擎不可用用例前显式移除，保证确定性。 */
function uninstallFakeUserScripts(): void {
  delete (browser as unknown as Record<string, unknown>).userScripts;
}

describe('CRUD 编排 + 注册同步', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    uninstallFakeUserScripts();
    vi.restoreAllMocks();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
  });

  it('handleCreate：落库 + register（code/matches/runAt/world/persistAcrossSessions）', async () => {
    const api = installFakeUserScripts();
    const { script, warnings } = await handleCreate({ name: 'n', code: 'c();', matches: ['https://a.com/*'] });
    expect(warnings).toEqual([]);
    expect((await listScripts()).map((s) => s.id)).toEqual([script.id]);
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.register.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        id: script.id, matches: ['https://a.com/*'],
        js: [{ code: 'c();' }], runAt: 'document_idle', world: 'USER_SCRIPT', persistAcrossSessions: true,
      }),
    ]);
  });

  it('handleCreate：非法 pattern 拒绝并列出条目；空 matches 允许（导入场景）', async () => {
    installFakeUserScripts();
    await expect(handleCreate({ name: 'n', code: 'c', matches: ['https://bad'] })).rejects.toThrow('非法 match pattern');
    const { script } = await handleCreate({ name: 'n', code: 'c', matches: [] });
    expect(script.matches).toEqual([]);
  });

  it('handleCreate：引擎不可用 → 照常落库 + warnings 带固定文案', async () => {
    // beforeEach 已卸载 userScripts 属性 → 引擎不可用路径
    const { warnings } = await handleCreate({ name: 'n', code: 'c', matches: [] });
    expect(await listScripts()).toHaveLength(1);
    expect(warnings[0]).toContain(ENGINE_UNAVAILABLE_MSG);
  });

  it('handleUpdate：code 变更 → update 同步；disable → unregister', async () => {
    const api = installFakeUserScripts();
    const { script } = await handleCreate({ name: 'n', code: 'v1', matches: ['https://a.com/*'] });
    // 模拟「已按 v1 注册」状态（mock 不记录先前 register，需显式喂 getScripts）
    api.getScripts.mockResolvedValue([
      { id: script.id, matches: ['https://a.com/*'], js: [{ code: 'v1' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    api.update.mockClear();
    await handleUpdate(script.id, { code: 'v2' });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ id: script.id, js: [{ code: 'v2' }] }),
    ]);
    await handleSetEnabled(script.id, false);
    expect(api.unregister).toHaveBeenCalledWith([script.id]);
  });

  it('handleDelete：删库 + unregister', async () => {
    const api = installFakeUserScripts();
    // 适配：mock 不记录先前 register，且空 matches 永不注册（spec §5.1）——需带 pattern 建脚本并显式喂「已注册」状态
    const { script } = await handleCreate({ name: 'n', code: 'c', matches: ['https://a.com/*'] });
    api.getScripts.mockResolvedValue([
      { id: script.id, matches: ['https://a.com/*'], js: [{ code: 'c' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    await handleDelete(script.id);
    expect(await listScripts()).toEqual([]);
    expect(api.unregister).toHaveBeenCalledWith([script.id]);
  });

  it('update/delete/setEnabled 引擎不可用 → throw 固定文案', async () => {
    const { script } = await handleCreate({ name: 'n', code: 'c', matches: [] });
    await expect(handleUpdate(script.id, { name: 'x' })).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
    await expect(handleDelete(script.id)).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
    await expect(handleSetEnabled(script.id, false)).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
  });

  it('syncRegistrations：漂移自愈（库里已删的注销、code 漂移的更新）', async () => {
    const api = installFakeUserScripts();
    await handleCreate({ name: 'keep', code: 'c1', matches: ['https://a.com/*'], enabled: true });
    const all = await listScripts();
    // mock 不反映先前 register——直接喂「已注册」状态：keep（code 陈旧）+ ghost（库里已不存在）
    api.getScripts.mockResolvedValue([
      { id: all[0]!.id, matches: ['https://a.com/*'], js: [{ code: 'stale' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
      { id: 'ghost', matches: ['<all_urls>'], js: [{ code: 'g' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    api.update.mockClear();
    api.unregister.mockClear();
    await syncRegistrations();
    expect(api.update).toHaveBeenCalledTimes(1); // keep: code 漂移 → update
    expect(api.update.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: all[0]!.id, js: [{ code: 'c1' }] })]);
    expect(api.unregister).toHaveBeenCalledWith(['ghost']); // 库里已无 → 注销
  });

  it('handleImport：解析 TM 元数据 + enabled 默认 true + warnings 透传', async () => {
    installFakeUserScripts();
    const src = '// ==UserScript==\n// @name imp\n// @match https://i.com/*\n// @grant GM_log\n// ==/UserScript==\nlog();';
    const { script, warnings } = await handleImport(src, 'imp.user.js');
    expect(script).toMatchObject({ name: 'imp', enabled: true, source: 'import', matches: ['https://i.com/*'] });
    expect(warnings.some((w) => w.includes('GM_*'))).toBe(true);
  });

  it('initScriptsModule：挂 8 个 handler + tabs 监听 + 启动 sync', async () => {
    const api = installFakeUserScripts();
    const router = new MessageRouter();
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});

    initScriptsModule(router);
    // 适配：空库时启动 sync 无缺失注册可补（register 不会被调）；getScripts 仅由启动自愈 sync 触达
    await vi.waitFor(() => expect(api.getScripts).toHaveBeenCalled()); // 启动自愈 sync（异步链）

    // 8 个 handler 全部有注册（未注册类型才会报 no handler）
    for (const type of ['SCRIPTS_LIST', 'SCRIPTS_GET', 'SCRIPTS_CREATE', 'SCRIPTS_UPDATE', 'SCRIPTS_DELETE', 'SCRIPTS_SET_ENABLED', 'SCRIPTS_IMPORT', 'SCRIPTS_GET_RUNTIME']) {
      const r = await router.dispatch({ type } as { type: string });
      expect(r).not.toMatchObject({ error: expect.stringContaining('no handler') });
    }
  });

  it('initScriptsModule：SCRIPTS_LIST 返回 engineAvailable + 摘要；GET 未知 id 报错', async () => {
    installFakeUserScripts();
    await handleCreate({ name: 'n', code: 'c', matches: ['https://a.com/*'] });
    const router = new MessageRouter();
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});
    initScriptsModule(router);

    const list = (await router.dispatch({ type: 'SCRIPTS_LIST' })) as { ok: boolean; data: { scripts: unknown[]; engineAvailable: boolean } };
    expect(list.ok).toBe(true);
    expect(list.data.scripts).toHaveLength(1);
    expect(list.data.scripts[0]).not.toHaveProperty('code');
    expect(list.data.engineAvailable).toBe(true);

    const get = await router.dispatch({ type: 'SCRIPTS_GET', id: 'nope' });
    expect(get).toMatchObject({ ok: false });
  });
});
