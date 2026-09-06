// tests/agent/tools/script-pool.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  doListScripts, doGetScript, doCreateScript, doUpdateScript, doDeleteScript, doToggleScript,
} from '../../../agent/tools/script-pool';
import { listScripts } from '../../../storage/scripts';
import { handleCreate, handleGet } from '../../../background/scripts';

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
    const created = (await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();\nb();') })) as { data: { id: string } };
    const id = created.data.id;
    // mkTm 7 行：4 头 + 空行 + 2 行 body

    const full = (await doGetScript({ id })) as { data: { script: { text: string; code: string }; totalLines: number; startLine: number; endLine: number } };
    expect(full.data.script.code).toBe('\na();\nb();'); // code 含头后空行 → 前导 \n
    expect(full.data).toMatchObject({ totalLines: 7, startLine: 1, endLine: 7 });
    expect(full.data.script.text).toContain('@name');
    // 工具层给 text 加了行号前缀（spec §4.4）；code 是解析投影、保持原文
    expect(full.data.script.text).toContain('| a();');

    const slice = (await doGetScript({ id, offset: 6, limit: 2 })) as { data: { script: { text: string }; startLine: number; endLine: number; totalLines: number } };
    // 行区间同样带行号前缀，且行号按真实行号（6/7）对齐，不是切片内重新从 1 数
    expect(slice.data.script.text).toBe('   6| a();\n   7| b();');
    expect(slice.data).toMatchObject({ startLine: 6, endLine: 7, totalLines: 7 });

    expect(await doGetScript({ id: 'nope' })).toMatchObject({ ok: false });
  });

  it('update_script：text 整文替换 + edit 行区间 + toggle/delete 全链路', async () => {
    installFakeUserScripts();
    const created = (await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'v1;') })) as { data: { id: string } };
    const id = created.data.id;

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
    const r = (await doCreateScript({ url: 'https://cdn.example.com/s.user.js' })) as { ok: boolean; data: { name: string; warnings: string[] } };
    expect(r.ok).toBe(true);
    expect(r.data.name).toBe('from-url');
    // 写操作返回已瘦身（spec §3.4）：不回灌 script 全文——来源/头部投影从存储读回验证
    const saved = (await listScripts())[0]!;
    expect(saved.source).toBe('agent');
    expect(saved.meta?.updateURL).toBe('https://cdn.example.com/s.user.js');
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
    const created = (await doCreateScript({ source: `// ==UserScript==\n// @name n\n// @version 1.0.0\n// @updateURL https://x/u\n// @match https://a.com/*\n// ==/UserScript==\nv1;` })) as { data: { id: string } };
    const id = created.data.id;
    const remote = `// ==UserScript==\n// @name n\n// @version 2.0.0\n// @updateURL https://x/u\n// @match https://a.com/*\n// ==/UserScript==\nv2;`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => remote })));
    const r = (await doUpdateScript({ id, patch: { applyUpdate: true } })) as { ok: boolean; data: Record<string, unknown> };
    expect(r.ok).toBe(true);
    // 返回已瘦身：版本信息从存储读回验证
    expect((await listScripts())[0]!.meta?.version).toBe('2.0.0');
    expect((await listScripts())[0]!.text).toContain('@version 2.0.0');
    vi.unstubAllGlobals();
  });

  it('update_script：applyUpdate 对无更新源脚本报错', async () => {
    installFakeUserScripts();
    const created = (await doCreateScript({ source: mkTm('n', 'https://a.com/*') })) as { data: { id: string } };
    const r = await doUpdateScript({ id: created.data.id, patch: { applyUpdate: true } });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('无更新源');
  });

  it('list_scripts：附加 update 字段（读后台检查缓存，available → hasUpdate=true；无缓存 → 缺省）', async () => {
    installFakeUserScripts();
    const c1 = (await doCreateScript({ source: mkTm('has-upd', 'https://a.com/*') })) as { data: { id: string } };
    await doCreateScript({ source: mkTm('no-upd', 'https://b.com/*') });
    // 预置一条 available 更新状态到缓存
    const { UPDATE_STATE_KEY } = await import('../../../shared/types');
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem(UPDATE_STATE_KEY, { [c1.data.id]: { remoteVersion: '3.0.0', checkedAt: 123, status: 'available' } });

    const all = (await doListScripts({})) as { data: { scripts: Array<{ id: string; update?: { hasUpdate: boolean; remoteVersion?: string } }> } };
    const withUpd = all.data.scripts.find((s) => s.id === c1.data.id)!;
    expect(withUpd.update).toMatchObject({ hasUpdate: true, remoteVersion: '3.0.0' });
    const without = all.data.scripts.find((s) => s.id !== c1.data.id)!;
    expect(without.update).toBeUndefined();
  });

  it('registry 分发：脚本工具豁免受限页预检（chrome:// 页上照常可用）', async () => {
    installFakeUserScripts();
    const tab = await fakeBrowser.tabs.create({ url: 'chrome://extensions/' });
    const { executeTool } = await import('../../../agent/tools/registry');
    const r = await executeTool('list_scripts', {}, { tabId: tab.id!, sessionId: 'test', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('create/update 返回瘦身：不含 text/code，带 lines/bytes/balance', async () => {
    installFakeUserScripts();
    const r = await doCreateScript({ source: mkTm('n', 'https://a.com/*', '(function () {') });
    expect(r.ok).toBe(true);
    const d = (r as { data: Record<string, unknown> }).data;
    // 回归断言：全文不得回灌（spec §3.4）
    expect(d).not.toHaveProperty('script');
    expect(JSON.stringify(d)).not.toContain('==UserScript==');
    expect(d).toMatchObject({ name: 'n', matches: ['https://a.com/*'], enabled: true });
    expect(typeof d.id).toBe('string');
    expect(typeof d.lines).toBe('number');
    expect(typeof d.bytes).toBe('number');
    // 骨架刻意不闭合 IIFE → 中间态 unclosed（不阻断）
    expect(d.balance).toBe('unclosed');
    expect(typeof d.balanceDetail).toBe('string');
  });

  it('update_script：append 后闭合 → balance 转 ok', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', '(function () {') });
    const id = (c as { data: { id: string } }).data.id;

    const mid = await doUpdateScript({ id, patch: { append: '  f();' } });
    expect((mid as { data: { balance: string } }).data.balance).toBe('unclosed');

    const done = await doUpdateScript({ id, patch: { append: '})();' } });
    const d = (done as { data: Record<string, unknown> }).data;
    expect(d.balance).toBe('ok');
    expect(d).not.toHaveProperty('balanceDetail');
    expect(d).not.toHaveProperty('script');
  });

  it('update_script：replace 分支可用，命中多处报错', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'f();\ng();') });
    const id = (c as { data: { id: string } }).data.id;

    const ok = await doUpdateScript({ id, patch: { replace: { old: 'g();', new: 'h();' } } });
    expect(ok.ok).toBe(true);

    const dup = await doUpdateScript({ id, patch: { replace: { old: '();', new: 'x' } } });
    expect(dup).toMatchObject({ ok: false });
    expect((dup as { error: string }).error).toContain('命中');
  });

  it('create_script 硬闸：超 200 行或 8192 字符报错，文案给分步指引', async () => {
    installFakeUserScripts();
    // 注意 mkTm 头部占 5 行（4 行头 + 1 空行）：body 195 行 → 恰好 200 行 → 通过
    const body200 = Array.from({ length: 195 }, (_, i) => `l${i}();`).join('\n');
    expect((await doCreateScript({ source: mkTm('n', 'https://a.com/*', body200) })).ok).toBe(true);

    // body 196 行 → 共 201 行 → 报错
    const body201 = Array.from({ length: 196 }, (_, i) => `l${i}();`).join('\n');
    const tooLong = await doCreateScript({ source: mkTm('n2', 'https://a.com/*', body201) });
    expect(tooLong).toMatchObject({ ok: false });
    const err = (tooLong as { error: string }).error;
    expect(err).toContain('过长');
    expect(err).toContain('append');   // 指引里必须提到分步原语
    expect(err).toContain('骨架');

    // 字符数超限（行数不超）→ 同样报错
    const fat = await doCreateScript({ source: mkTm('n3', 'https://a.com/*', 'x'.repeat(9000)) });
    expect(fat).toMatchObject({ ok: false });
    expect((fat as { error: string }).error).toContain('过长');
  });

  it('create_script 硬闸不管 url 导入分支', async () => {
    installFakeUserScripts();
    // url 分支不经 source 长度检查（不是模型在逐 token 吐字）；此处只断言未被硬闸拦下
    const r = await doCreateScript({ url: 'not-a-real-url' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).not.toContain('过长');
  });

  it('get_script：每行带右对齐行号前缀', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();\nb();') });
    const id = (c as { data: { id: string } }).data.id;

    const r = await doGetScript({ id });
    expect(r.ok).toBe(true);
    const text = (r as { data: { script: { text: string } } }).data.script.text;
    expect(text.split('\n')[0]).toBe('   1| // ==UserScript==');
    expect(text).toContain('| a();');
    // 行号是标注不是内容：原文本身不含它
    expect(text).not.toContain('|| ');
  });

  it('get_script：默认限量 200 行 + 超长提示；显式 offset/limit 仍生效', async () => {
    installFakeUserScripts();
    const body = Array.from({ length: 400 }, (_, i) => `l${i}();`).join('\n');
    // 走编排层直接落库，绕开 create 硬闸（模拟用户导入的长脚本）
    const created = await handleCreate({ text: mkTm('big', 'https://a.com/*', body) });
    const id = created.script.id;

    const def = await doGetScript({ id });
    const d = (def as { data: { script: { text: string }; startLine: number; endLine: number; notice?: string } }).data;
    expect(d.startLine).toBe(1);
    expect(d.endLine).toBe(200);
    expect(d.script.text.split('\n')).toHaveLength(200);
    expect(d.notice).toContain('offset=201');
    expect(d.notice).toContain('grep_script');

    const page2 = await doGetScript({ id, offset: 201, limit: 50 });
    const p = (page2 as { data: { startLine: number; endLine: number; script: { text: string } } }).data;
    expect(p.startLine).toBe(201);
    expect(p.endLine).toBe(250);
    expect(p.script.text.split('\n')[0]).toMatch(/^ 201\| /);
  });

  it('get_script：总行数不超 200 时不带 notice', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();') });
    const id = (c as { data: { id: string } }).data.id;
    const r = await doGetScript({ id });
    expect((r as { data: { notice?: string } }).data.notice).toBeUndefined();
  });

  it('回归：编排层 handleGet 不带行号（UI 拿干净原文）', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();') });
    const id = (c as { data: { id: string } }).data.id;
    const raw = await handleGet(id);
    expect(raw.script.text.startsWith('// ==UserScript==')).toBe(true);
    expect(raw.script.text).not.toContain('| ');
  });
});
