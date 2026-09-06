// tests/agent/tools/script-pool.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  doListScripts, doGetScript, doCreateScript, doUpdateScript, doDeleteScript, doToggleScript,
} from '../../../agent/tools/script-pool';
import { listScripts } from '../../../storage/scripts';

function installFakeUserScripts(): void {
  (browser as unknown as Record<string, unknown>).userScripts = {
    register: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => {}),
    getScripts: vi.fn(async () => []),
  };
}

/** 标准 TM 头 + 代码体：4 行头 + 空行 + body 各行 */
const mkTm = (name: string, match: string, body = 'c();'): string =>
  `// ==UserScript==\n// @name ${name}\n// @match ${match}\n// ==/UserScript==\n\n${body}`;

describe('script-pool 工具执行器', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // sendMessage 的重载让 mock 返回类型推断为 void，这里 as never 只为过编译，不改变运行时（同 registry.test.ts）
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
  });

  it('create_script：文本化创建（source 参数）+ 强制 agent 来源；无匹配规则/缺 source 报错', async () => {
    installFakeUserScripts();
    const ok = await doCreateScript({ source: mkTm('n', 'https://a.com/*') });
    expect(ok.ok).toBe(true);
    const saved = (await listScripts())[0]!;
    expect(saved.source).toBe('agent');
    // code 保留头后全部内容：mkTm 头与 body 间的空行 → 前导 \n（同 Task 1 解析器契约）
    expect(saved).toMatchObject({ name: 'n', code: '\nc();', matches: ['https://a.com/*'] });

    const empty = await doCreateScript({ source: 'console.log(1);' });
    expect(empty).toMatchObject({ ok: false });
    expect((empty as { error: string }).error).toContain('@match');

    const missing = await doCreateScript({});
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toContain('source');
  });

  it('list_scripts：摘要无 code/text；enabled/urlContains 过滤', async () => {
    installFakeUserScripts();
    await doCreateScript({ source: mkTm('alpha', 'https://a.com/*') });
    await doCreateScript({ source: mkTm('beta', 'https://b.com/*'), enabled: false });

    const all = await doListScripts({});
    expect(all.ok).toBe(true);
    const scripts = (all as { data: { scripts: Array<Record<string, unknown>> } }).data.scripts;
    expect(scripts).toHaveLength(2);
    for (const s of scripts) {
      expect(s).not.toHaveProperty('code');
      expect(s).not.toHaveProperty('text');
    }

    expect(((await doListScripts({ enabled: true })) as { data: { scripts: unknown[] } }).data.scripts).toHaveLength(1);
    const filtered = (await doListScripts({ urlContains: 'b.com' })) as { data: { scripts: Array<{ name: string }> } };
    expect(filtered.data.scripts.map((s) => s.name)).toEqual(['beta']);
  });

  it('get_script：全文 + totalLines；行区间切片；未知 id 报错', async () => {
    installFakeUserScripts();
    const created = (await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();\nb();') })) as { data: { script: { id: string } } };
    const id = created.data.script.id;
    // mkTm 7 行：4 头 + 空行 + 2 行 body

    const full = (await doGetScript({ id })) as { data: { script: { text: string; code: string }; totalLines: number; startLine: number; endLine: number } };
    expect(full.data.script.code).toBe('\na();\nb();'); // code 含头后空行 → 前导 \n
    expect(full.data).toMatchObject({ totalLines: 7, startLine: 1, endLine: 7 });
    expect(full.data.script.text).toContain('@name');

    const slice = (await doGetScript({ id, offset: 6, limit: 2 })) as { data: { script: { text: string }; startLine: number; endLine: number; totalLines: number } };
    expect(slice.data.script.text).toBe('a();\nb();');
    expect(slice.data).toMatchObject({ startLine: 6, endLine: 7, totalLines: 7 });

    expect(await doGetScript({ id: 'nope' })).toMatchObject({ ok: false });
  });

  it('update_script：text 整文替换 + edit 行区间 + toggle/delete 全链路', async () => {
    installFakeUserScripts();
    const created = (await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'v1;') })) as { data: { script: { id: string } } };
    const id = created.data.script.id;

    expect((await doUpdateScript({ id, patch: { text: mkTm('n2', 'https://a.com/*', 'v2;') } })).ok).toBe(true);
    expect((await listScripts())[0]!.code).toBe('\nv2;'); // 头后含空行 → 前导 \n
    expect((await listScripts())[0]!.name).toBe('n2');

    // mkTm('n2',…,'v2;') 6 行：4 头 + 空行 + 第 6 行 v2;；替换 L6 后 code = 空行 + x(); → 前导 \n
    expect((await doUpdateScript({ id, patch: { edit: { startLine: 6, endLine: 6, text: 'x();' } } })).ok).toBe(true);
    expect((await listScripts())[0]!.code).toBe('\nx();');

    expect((await doToggleScript({ id, enabled: false })).ok).toBe(true);
    expect((await listScripts())[0]!.enabled).toBe(false);
    expect((await doDeleteScript({ id })).ok).toBe(true);
    expect(await listScripts()).toEqual([]);
  });

  it('create_script：url 分支从直链导入（来源 agent，注入 @updateURL）', async () => {
    installFakeUserScripts();
    const body = mkTm('from-url', 'https://a.com/*');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => body })));
    const r = (await doCreateScript({ url: 'https://cdn.example.com/s.user.js' })) as { ok: boolean; data: { script: { name: string; source: string; meta?: { updateURL?: string } } } };
    expect(r.ok).toBe(true);
    expect(r.data.script.name).toBe('from-url');
    expect(r.data.script.source).toBe('agent');
    expect(r.data.script.meta?.updateURL).toBe('https://cdn.example.com/s.user.js');
    vi.unstubAllGlobals();
  });

  it('create_script：url 下载到非脚本（无头）→ 报错', async () => {
    installFakeUserScripts();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html>404</html>' })));
    const r = await doCreateScript({ url: 'https://x/notascript' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('不是有效脚本');
    vi.unstubAllGlobals();
  });

  it('update_script：applyUpdate 分支从更新源拉取远端最新覆盖', async () => {
    installFakeUserScripts();
    const created = (await doCreateScript({ source: `// ==UserScript==\n// @name n\n// @version 1.0.0\n// @updateURL https://x/u\n// @match https://a.com/*\n// ==/UserScript==\nv1;` })) as { data: { script: { id: string } } };
    const id = created.data.script.id;
    const remote = `// ==UserScript==\n// @name n\n// @version 2.0.0\n// @updateURL https://x/u\n// @match https://a.com/*\n// ==/UserScript==\nv2;`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => remote })));
    const r = (await doUpdateScript({ id, patch: { applyUpdate: true } })) as { ok: boolean; data: { script: { meta?: { version?: string }; code: string } } };
    expect(r.ok).toBe(true);
    expect(r.data.script.meta?.version).toBe('2.0.0');
    expect((await listScripts())[0]!.meta?.version).toBe('2.0.0');
    vi.unstubAllGlobals();
  });

  it('update_script：applyUpdate 对无更新源脚本报错', async () => {
    installFakeUserScripts();
    const created = (await doCreateScript({ source: mkTm('n', 'https://a.com/*') })) as { data: { script: { id: string } } };
    const r = await doUpdateScript({ id: created.data.script.id, patch: { applyUpdate: true } });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('无更新源');
  });

  it('list_scripts：附加 update 字段（读后台检查缓存，available → hasUpdate=true；无缓存 → 缺省）', async () => {
    installFakeUserScripts();
    const c1 = (await doCreateScript({ source: mkTm('has-upd', 'https://a.com/*') })) as { data: { script: { id: string } } };
    await doCreateScript({ source: mkTm('no-upd', 'https://b.com/*') });
    // 预置一条 available 更新状态到缓存
    const { UPDATE_STATE_KEY } = await import('../../../shared/types');
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem(UPDATE_STATE_KEY, { [c1.data.script.id]: { remoteVersion: '3.0.0', checkedAt: 123, status: 'available' } });

    const all = (await doListScripts({})) as { data: { scripts: Array<{ id: string; update?: { hasUpdate: boolean; remoteVersion?: string } }> } };
    const withUpd = all.data.scripts.find((s) => s.id === c1.data.script.id)!;
    expect(withUpd.update).toMatchObject({ hasUpdate: true, remoteVersion: '3.0.0' });
    const without = all.data.scripts.find((s) => s.id !== c1.data.script.id)!;
    expect(without.update).toBeUndefined();
  });

  it('registry 分发：脚本工具豁免受限页预检（chrome:// 页上照常可用）', async () => {
    installFakeUserScripts();
    const tab = await fakeBrowser.tabs.create({ url: 'chrome://extensions/' });
    const { executeTool } = await import('../../../agent/tools/registry');
    const r = await executeTool('list_scripts', {}, { tabId: tab.id!, sessionId: 'test', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });
});
