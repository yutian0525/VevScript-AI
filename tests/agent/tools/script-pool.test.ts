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

describe('script-pool 工具执行器', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // sendMessage 的重载让 mock 返回类型推断为 void，这里 as never 只为过编译，不改变运行时（同 registry.test.ts）
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
  });

  it('create_script：成功注册 + source 强制 agent；matches 为空报错', async () => {
    installFakeUserScripts();
    const ok = await doCreateScript({ name: 'n', code: 'c;', matches: ['https://a.com/*'] });
    expect(ok.ok).toBe(true);
    const saved = (await listScripts())[0]!;
    expect(saved.source).toBe('agent');

    const empty = await doCreateScript({ name: 'n', code: 'c;', matches: [] });
    expect(empty).toMatchObject({ ok: false });
    expect((empty as { error: string }).error).toContain('matches');
  });

  it('list_scripts：摘要无 code；enabled/urlContains 过滤', async () => {
    installFakeUserScripts();
    await doCreateScript({ name: 'alpha', code: 'c;', matches: ['https://a.com/*'] });
    await doCreateScript({ name: 'beta', code: 'c;', matches: ['https://b.com/*'], enabled: false });

    const all = await doListScripts({});
    expect(all.ok).toBe(true);
    const scripts = (all as { data: { scripts: Array<Record<string, unknown>> } }).data.scripts;
    expect(scripts).toHaveLength(2);
    for (const s of scripts) expect(s).not.toHaveProperty('code');

    expect(((await doListScripts({ enabled: true })) as { data: { scripts: unknown[] } }).data.scripts).toHaveLength(1);
    const filtered = (await doListScripts({ urlContains: 'b.com' })) as { data: { scripts: Array<{ name: string }> } };
    expect(filtered.data.scripts.map((s) => s.name)).toEqual(['beta']);
  });

  it('get_script：全文含 code；未知 id 报错', async () => {
    installFakeUserScripts();
    const { data } = (await doCreateScript({ name: 'n', code: 'CODE;', matches: ['https://a.com/*'] })) as { data: { script: { id: string } } };
    const got = await doGetScript({ id: data.script.id });
    expect((got as { data: { script: { code: string } } }).data.script.code).toBe('CODE;');
    expect(await doGetScript({ id: 'nope' })).toMatchObject({ ok: false });
  });

  it('update/toggle/delete 全链路', async () => {
    installFakeUserScripts();
    const { data } = (await doCreateScript({ name: 'n', code: 'c;', matches: ['https://a.com/*'] })) as { data: { script: { id: string } } };
    expect((await doUpdateScript({ id: data.script.id, patch: { code: 'v2' } })).ok).toBe(true);
    expect((await doToggleScript({ id: data.script.id, enabled: false })).ok).toBe(true);
    expect((await listScripts())[0]!.enabled).toBe(false);
    expect((await doDeleteScript({ id: data.script.id })).ok).toBe(true);
    expect(await listScripts()).toEqual([]);
  });

  it('registry 分发：脚本工具豁免受限页预检（chrome:// 页上照常可用）', async () => {
    installFakeUserScripts();
    const tab = await fakeBrowser.tabs.create({ url: 'chrome://extensions/' });
    const { executeTool } = await import('../../../agent/tools/registry');
    const r = await executeTool('list_scripts', {}, { tabId: tab.id!, sessionId: 'test', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });
});
