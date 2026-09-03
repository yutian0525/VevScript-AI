// tests/background/scripts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  computeRuntimeScriptIds, recomputeTab, recomputeAllTabs, dropTab, getRuntimeSnapshot,
  handleCreate, handleUpdate, handleDelete, handleSetEnabled, handleImport, handleGet, spliceLines,
  syncRegistrations, initScriptsModule, ENGINE_UNAVAILABLE_MSG,
} from '../../background/scripts';
import { listScripts, saveScript } from '../../storage/scripts';
// 注：new MessageRouter() 需要运行时值——type-only 导入会被擦除导致运行时 TypeError
import { MessageRouter } from '../../background/router';
import { setAlwaysAllow } from '../../background/gm-permissions';
import type { UserScript } from '../../shared/types';
import type { ScriptsRuntimeEntry } from '../../shared/messages';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name 测试\n// @match https://a.com/*\n// ==/UserScript==\nx();\n',
    name: '测试', enabled: true, matches: ['https://a.com/*'],
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

describe('CRUD 编排 + 注册同步（文本为源）', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    uninstallFakeUserScripts();
    vi.restoreAllMocks();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
  });

  /** 标准头 + 代码体；4 行头 + body 各行 */
  const mkText = (body: string, extraHeader = ''): string =>
    `// ==UserScript==\n// @name n\n// @match https://a.com/*${extraHeader}\n// ==/UserScript==\n${body}`;

  it('spliceLines：行区间替换 + 非法/越界报错', () => {
    expect(spliceLines('a\nb\nc', 2, 2, 'X')).toBe('a\nX\nc');
    expect(spliceLines('a\nb\nc', 1, 2, 'X\nY')).toBe('X\nY\nc');
    expect(spliceLines('a\nb\nc', 3, 3, 'X\nY')).toBe('a\nb\nX\nY');
    expect(() => spliceLines('a\nb\nc', 0, 2, 'X')).toThrow('非法行区间');
    expect(() => spliceLines('a\nb\nc', 3, 2, 'X')).toThrow('非法行区间');
    expect(() => spliceLines('a\nb\nc', 2, 9, 'X')).toThrow('越界');
  });

  it('handleCreate：解析投影落库 + register（code/matches/runAt/world）', async () => {
    const api = installFakeUserScripts();
    const { script, warnings } = await handleCreate({ text: mkText('c();') });
    expect(warnings).toEqual([]);
    expect(script).toMatchObject({
      name: 'n', matches: ['https://a.com/*'], code: 'c();',
      runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', enabled: true,
    });
    expect((await listScripts()).map((s) => s.id)).toEqual([script.id]);
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.register.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        id: script.id, matches: ['https://a.com/*'],
        js: [{ code: 'c();' }], runAt: 'document_idle', world: 'USER_SCRIPT',
      }),
    ]);
  });

  it('handleCreate：非法 @match 警告+跳过（保留合法条目），不整条失败；无匹配规则允许（matches 为空）', async () => {
    installFakeUserScripts();
    // TM 兼容（2026-09-02 决策）：非法 @match 降级为警告+跳过，合法的 https://a.com/* 仍保留并注册
    const { script, warnings } = await handleCreate({ text: mkText('c', '\n// @match https://bad') });
    expect(script.matches).toEqual(['https://a.com/*']);
    expect(warnings.some((w) => w.includes('@match') && w.includes('已忽略'))).toBe(true);
    const { script: s2 } = await handleCreate({ text: 'console.log(1);' });
    expect(s2.matches).toEqual([]);
  });

  it('handleCreate：头部有效但 body 空 → 拒绝（code 不能为空）；带 body 的新建模板可创建', async () => {
    installFakeUserScripts();
    // 回归护栏：仅头部（body 空）解析出 code='' → 校验拒绝。UI「新建」模板必须带非空 body 才可创建
    const headerOnly = '// ==UserScript==\n// @name 未命名\n// @match *://*/*\n// ==/UserScript==\n';
    await expect(handleCreate({ text: headerOnly })).rejects.toThrow('code 不能为空');
    const withBody = `${headerOnly}\nconsole.log('新脚本');\n`;
    const { script } = await handleCreate({ text: withBody });
    expect(script.matches).toEqual(['*://*/*']);
    expect(script.code.trim()).not.toBe('');
  });

  it('handleCreate：引擎不可用 → 照常落库 + warnings 带固定文案', async () => {
    // beforeEach 已卸载 userScripts 属性 → 引擎不可用路径
    const { warnings } = await handleCreate({ text: mkText('c') });
    expect(await listScripts()).toHaveLength(1);
    expect(warnings.some((w) => w.includes(ENGINE_UNAVAILABLE_MSG))).toBe(true);
  });

  it('handleUpdate：text 整文替换 → 整体重解析 + update 同步；enabled-only → unregister', async () => {
    const api = installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('v1') });
    // 模拟「已按 v1 注册」状态（mock 不记录先前 register，需显式喂 getScripts）
    api.getScripts.mockResolvedValue([
      { id: script.id, matches: ['https://a.com/*'], js: [{ code: 'v1' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    api.update.mockClear();
    await handleUpdate(script.id, { text: mkText('v2') });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ id: script.id, js: [{ code: 'v2' }] }),
    ]);
    await handleSetEnabled(script.id, false);
    expect(api.unregister).toHaveBeenCalledWith([script.id]);
  });

  it('handleUpdate：edit 行区间替换（含重解析）+ 非法/越界报错', async () => {
    installFakeUserScripts();
    const text = ['// ==UserScript==', '// @name n', '// @match https://a.com/*', '// ==/UserScript==', 'a();', 'b();', 'c();'].join('\n');
    const { script } = await handleCreate({ text });
    // 修正计划 fixture off-by-one：body 从 L5(a) 起，替换 L6(b) 一行为两行 → 净 +1 行，与期望输出 a,X,Y,c 一致
    const next = await handleUpdate(script.id, { edit: { startLine: 6, endLine: 6, text: 'X();\nY();' } });
    expect(next.code).toBe('a();\nX();\nY();\nc();');
    expect(next.name).toBe('n');
    await expect(handleUpdate(script.id, { edit: { startLine: 0, endLine: 2, text: 'z' } })).rejects.toThrow('非法行区间');
    await expect(handleUpdate(script.id, { edit: { startLine: 2, endLine: 99, text: 'z' } })).rejects.toThrow('越界');
  });

  it('handleUpdate：空 patch 报错', async () => {
    installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('c') });
    await expect(handleUpdate(script.id, {})).rejects.toThrow('patch 至少包含');
  });

  it('handleGet：全文 / 行区间切片 / 越界钳制；未知 id 报错', async () => {
    installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('h1\nh2\nh3') });
    const full = await handleGet(script.id);
    expect(full.totalLines).toBe(7);
    expect(full.startLine).toBe(1);
    expect(full.endLine).toBe(7);
    expect(full.script.text).toBe(script.text);

    const slice = await handleGet(script.id, 5, 2);
    expect(slice).toMatchObject({ totalLines: 7, startLine: 5, endLine: 6 });
    expect(slice.script.text).toBe('h1\nh2');

    const tail = await handleGet(script.id, 99);
    expect(tail).toMatchObject({ startLine: 7, endLine: 7 });
    expect(tail.script.text).toBe('h3');

    await expect(handleGet('nope')).rejects.toThrow('脚本不存在');
  });

  it('handleDelete：删库 + unregister', async () => {
    const api = installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('c') });
    api.getScripts.mockResolvedValue([
      { id: script.id, matches: ['https://a.com/*'], js: [{ code: 'c' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    await handleDelete(script.id);
    expect(await listScripts()).toEqual([]);
    expect(api.unregister).toHaveBeenCalledWith([script.id]);
  });

  it('update/delete/setEnabled 引擎不可用 → throw 固定文案', async () => {
    const { script } = await handleCreate({ text: mkText('c') });
    await expect(handleUpdate(script.id, { enabled: false })).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
    await expect(handleDelete(script.id)).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
    await expect(handleSetEnabled(script.id, false)).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
  });

  it('syncRegistrations：漂移自愈（库里已删的注销、code 漂移的更新）', async () => {
    const api = installFakeUserScripts();
    await handleCreate({ text: mkText('c1'), enabled: true });
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

  it('handleImport：原文存 text + TM 元数据解析 + unsupported grant 警告透传', async () => {
    installFakeUserScripts();
    const src = '// ==UserScript==\n// @name imp\n// @match https://i.com/*\n// @grant GM_log\n// @grant GM_download\n// ==/UserScript==\nlog();';
    const { script, warnings } = await handleImport(src, 'imp.user.js');
    expect(script.text).toBe(src);
    expect(script).toMatchObject({ name: 'imp', enabled: true, source: 'import', matches: ['https://i.com/*'] });
    expect(warnings.some((w) => w.includes('GM_download'))).toBe(true);
  });

  it('handleImport：@include pattern 形式并入 matches 生效', async () => {
    installFakeUserScripts();
    const src = '// ==UserScript==\n// @name inc\n// @include https://i.com/*\n// ==/UserScript==\nlog();';
    const { script } = await handleImport(src);
    expect(script.matches).toEqual(['https://i.com/*']);
  });

  it('initScriptsModule：挂 11 个 handler + tabs 监听 + 启动 sync', async () => {
    const api = installFakeUserScripts();
    const router = new MessageRouter();
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});

    initScriptsModule(router);
    // 空库时启动 sync 无缺失注册可补（register 不会被调）；getScripts 仅由启动自愈 sync 触达
    await vi.waitFor(() => expect(api.getScripts).toHaveBeenCalled());

    // 11 个 handler 全部有注册（未注册类型才会报 no handler；SCRIPTS_GET 无参走 handleGet throw → router 兜底 ok:false）
    for (const type of ['SCRIPTS_LIST', 'SCRIPTS_GET', 'SCRIPTS_CREATE', 'SCRIPTS_UPDATE', 'SCRIPTS_DELETE', 'SCRIPTS_SET_ENABLED', 'SCRIPTS_IMPORT', 'SCRIPTS_GET_RUNTIME', 'SCRIPTS_GET_RUNTIME_FOR_TAB', 'SCRIPTS_GET_PERMISSIONS', 'SCRIPTS_REVOKE_PERMISSION']) {
      const r = await router.dispatch({ type } as { type: string });
      expect(r).not.toMatchObject({ error: expect.stringContaining('no handler') });
    }
  });

  it('initScriptsModule：SCRIPTS_LIST 返回 engineAvailable + 摘要；GET 未知 id 报错；GET 区间透传', async () => {
    installFakeUserScripts();
    await handleCreate({ text: mkText('h1\nh2') });
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

    const all = await listScripts();
    const sliced = (await router.dispatch({ type: 'SCRIPTS_GET', id: all[0]!.id, offset: 5, limit: 1 })) as { ok: boolean; data?: { script: { text: string }; startLine: number; totalLines: number } };
    expect(sliced.ok).toBe(true);
    expect(sliced.data).toMatchObject({ startLine: 5, totalLines: 6 });
    expect(sliced.data!.script.text).toBe('h1');
  });
});

describe('wrapper 接线（Phase 5）', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    getRuntimeSnapshot().forEach((e) => dropTab(e.tabId));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
  });

  it('grant 脚本经 syncRegistrations 注册的是 wrapped code（含 preamble 标记）', async () => {
    const api = installFakeUserScripts();
    await saveScript(mkScript({ meta: { grants: ['GM_setValue'] }, code: 'userCode();' }));
    await syncRegistrations();
    const reg = api.register.mock.calls[0]![0] as Array<{ js: Array<{ code: string }> }>;
    expect(reg[0]!.js[0]!.code).toContain('__GM_PREAMBLE__');
  });

  it('无 grant 脚本注册裸 code（零开销）', async () => {
    const api = installFakeUserScripts();
    await saveScript(mkScript({ meta: undefined, code: 'x();' }));
    await syncRegistrations();
    const reg = api.register.mock.calls[0]![0] as Array<{ js: Array<{ code: string }> }>;
    expect(reg[0]!.js[0]!.code).toBe('x();');
  });

  it('drift 检测：无变化时不重复 update（wrapped code 与已注册一致）', async () => {
    const api = installFakeUserScripts();
    await saveScript(mkScript({ meta: { grants: ['GM_setValue'] }, code: 'userCode();' }));
    await syncRegistrations(); // 首次 register
    // 模拟已注册集 = 首次构建的产物
    const registered = api.register.mock.calls[0]![0] as Array<{ id: string; js: Array<{ code: string }>; matches: string[]; runAt: string; world: string }>;
    api.getScripts.mockResolvedValue(registered);
    api.update.mockClear();
    await syncRegistrations(); // 第二次：应无 drift
    expect(api.update).not.toHaveBeenCalled();
  });

  it('handleCreate 后预取 @require（fetch mock 落缓存，getResourceBundle 可取）', async () => {
    installFakeUserScripts();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Map(), text: async () => 'lib();' })));
    const src = '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_getValue\n// @require https://cdn/lib.js\n// ==/UserScript==\nx();';
    const { script } = await handleCreate({ text: src });
    expect(script.meta?.requires).toEqual(['https://cdn/lib.js']);
    const { getResourceBundle } = await import('../../background/gm-resources');
    const bundle = await getResourceBundle(script);
    expect(bundle.requireCodes).toEqual(['lib();']);
    vi.unstubAllGlobals();
  });

  it('handleDelete 清理值域（cleanupScriptState）', async () => {
    installFakeUserScripts();
    await saveScript(mkScript());
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem('local:script-values:s1', { k: 1 });
    await handleDelete('s1');
    expect(await storage.getItem('local:script-values:s1')).toBeNull();
  });
});

describe('permissions & popup runtime handlers', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    getRuntimeSnapshot().forEach((e) => dropTab(e.tabId));
  });

  it('SCRIPTS_GET_PERMISSIONS 返回该脚本授权 host；SCRIPTS_REVOKE_PERMISSION 撤销单条', async () => {
    installFakeUserScripts();
    const router = new MessageRouter();
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});
    initScriptsModule(router);
    await setAlwaysAllow('ps1', 'x.com');
    const got = await router.dispatch({ type: 'SCRIPTS_GET_PERMISSIONS', id: 'ps1' });
    expect(got).toEqual({ ok: true, data: { hosts: ['x.com'] } });
    await router.dispatch({ type: 'SCRIPTS_REVOKE_PERMISSION', id: 'ps1', host: 'x.com' });
    const after = await router.dispatch({ type: 'SCRIPTS_GET_PERMISSIONS', id: 'ps1' });
    expect(after).toEqual({ ok: true, data: { hosts: [] } });
  });

  it('SCRIPTS_GET_RUNTIME_FOR_TAB 只返回指定 tab 的运行条目', async () => {
    installFakeUserScripts();
    const router = new MessageRouter();
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});
    initScriptsModule(router);
    await saveScript(mkScript({ id: 'rt1', enabled: true, matches: ['*://a.com/*'] }));
    await recomputeTab(11, 'https://a.com/page');
    const got = (await router.dispatch({ type: 'SCRIPTS_GET_RUNTIME_FOR_TAB', tabId: 11 })) as {
      ok: boolean; data?: { entry: ScriptsRuntimeEntry | null };
    };
    expect(got.ok).toBe(true);
    expect(got.data?.entry?.scriptIds).toEqual(['rt1']);
    const none = (await router.dispatch({ type: 'SCRIPTS_GET_RUNTIME_FOR_TAB', tabId: 99 })) as {
      ok: boolean; data?: { entry: ScriptsRuntimeEntry | null };
    };
    expect(none.data?.entry).toBeNull();
  });
});
