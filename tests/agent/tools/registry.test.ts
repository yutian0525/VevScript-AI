import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { executeTool, getToolSchemas } from '../../../agent/tools/registry';
import { saveScript } from '../../../storage/scripts';
import { saveSkill, newSkill } from '../../../storage/skills';

describe('工具 registry', () => {
  // 同时清 fakeBrowser 状态与 vitest spy：spyOn 的 mock 历史不随 fakeBrowser.reset 清除，
  // 否则前一个用例装到 tabs.sendMessage 的 spy 会带着调用记录泄漏进下一个用例。
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('getToolSchemas 返回全部 schema', () => {
    expect(getToolSchemas().length).toBe(37);
  });

  it('query_page 经 CS 通道分发', async () => {
    const sendMessage = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(
      { correlationId: 'x', type: 'QUERY', result: { ok: true, data: { matched: 1 } } } as never,
    );
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'https://x.com' }) as never;
    const r = await executeTool('query_page', { locator: { text: 'x' } },
      { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    expect((sendMessage.mock.calls[0]![1] as { type: string }).type).toBe('QUERY');
  });

  it('content script 类工具经 tabs.sendMessage 分发到主帧 frameId:0', async () => {
    const sendMessage = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(
      // sendMessage 的重载让 mock 返回类型推断为 void，这里 as never 只为过编译，不改变运行时
      { correlationId: 'x', type: 'CLICK', result: { ok: true } } as never,
    );
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'https://x.com' }) as never;
    const r = await executeTool('click', { uid: 5 }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalled();
    const call = sendMessage.mock.calls[0]!;
    const sent = call[1] as { type: string; payload: unknown };
    expect(sent.type).toBe('CLICK');
    expect(sent.payload).toMatchObject({ uid: 5 });
    // 第三参是 options，应含 frameId: 0
    expect(call[2]).toMatchObject({ frameId: 0 });
  });

  it('受限页面（chrome://）直接返回错误，不发消息', async () => {
    const sendMessage = vi.spyOn(browser.tabs, 'sendMessage');
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('take_snapshot', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('预期失败结果');
    expect(r.error).toContain('受限');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('navigate_page reload 调 tabs.reload 不发 cs 消息', async () => {
    const reload = vi.spyOn(browser.tabs, 'reload').mockResolvedValue();
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'https://x.com' }) as never;
    const r = await executeTool('navigate_page', { type: 'reload' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    expect(reload).toHaveBeenCalledWith(1);
  });

  it('未知工具返回错误', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'https://x.com' }) as never;
    const r = await executeTool('nonexistent', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
  });

  it('navigate_page 在当前页是受限页时仍可执行（豁免预检）', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://newtab' }) as never;
    const r = await executeTool('navigate_page', { type: 'url', url: 'https://x.com' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(1, { url: 'https://x.com' });
  });

  it('新版 Web Store 域名（chromewebstore.google.com）被拦截', async () => {
    const sendMessage = vi.spyOn(browser.tabs, 'sendMessage');
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'https://chromewebstore.google.com/detail/xyz' }) as never;
    const r = await executeTool('take_snapshot', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('受限');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('list_pages 豁免受限页预检（chrome:// 也能列表）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    fakeBrowser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: 'chrome://x', title: 'x', active: true }]) as never;
    const r = await executeTool('list_pages', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('http_request 豁免受限页预检', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'text/plain' }), text: () => Promise.resolve('ok') }));
    const r = await executeTool('http_request', { url: 'https://api.x.com' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('take_screenshot 受限页被阻断', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('take_screenshot', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('受限');
  });

  it('evaluate_script 受限页被阻断', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('evaluate_script', { function: '() => 1' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('受限');
  });

  it('new_page 透传 waitForReady', async () => {
    fakeBrowser.tabs.create = vi.fn().mockResolvedValue({ id: 88, url: 'https://x.com' }) as never;
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    const r = await executeTool('new_page', { url: 'https://x.com' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal, waitForReady });
    expect(r.ok).toBe(true);
    expect(waitForReady).toHaveBeenCalledWith(88);
  });

  it('list_console_messages 豁免受限页预检（chrome:// 也返回）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('list_console_messages', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('list_network_requests 豁免受限页预检', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('list_network_requests', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('get_network_request 豁免受限页预检（未知 id 走工具自身错误而非受限页错误）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('get_network_request', { requestId: 'x' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('预期失败结果'); // strict 收窄
    expect(r.error).toContain('未找到'); // 不是"受限"
  });

  it('load_skill 豁免受限页预检（未知 command 走工具自身错误而非受限页错误）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('load_skill', { command: 'nope' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('预期失败结果');
    expect(r.error).not.toContain('受限');
  });

  it('grep_script 走 storage 分支，不做受限页预检', async () => {
    await saveScript({
      id: 'g1', text: 'const box = 1;', name: 'g', enabled: true, matches: ['https://a.com/*'],
      code: 'const box = 1;', runAt: 'document_idle', world: 'USER_SCRIPT',
      source: 'user', createdAt: 1, updatedAt: 1,
    });
    // 目标 tab 是受限页：脚本工具豁免预检，仍应正常返回
    const r = await executeTool('grep_script', { pattern: 'box' }, {
      tabId: 1, sessionId: 'c1', signal: new AbortController().signal,
    });
    expect(r.ok).toBe(true);
  });

  it('技能池五工具豁免受限页预检（纯 storage，不碰页面）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://newtab' }) as never;
    await saveSkill(newSkill({
      name: '日报', command: 'daily-report', description: 'd',
      content: '正文占位够长正文占位够长正文占位够长正文占位够长。',
    }));
    const ctx = { tabId: 1, sessionId: 's', signal: new AbortController().signal };

    const list = await executeTool('list_skills', {}, ctx);
    expect(list.ok).toBe(true);

    const created = await executeTool('create_skill', {
      source: '---\nname: 周报\ndescription: d2\ncommand: weekly\n---\n正文占位够长正文占位够长正文占位够长正文占位够长。',
    }, ctx);
    expect(created.ok).toBe(true);
  });
});

describe('记忆工具分发', () => {
  beforeEach(() => fakeBrowser.reset());

  it('memory_write → 落库；memory_list → 读回；memory_delete → 删除', async () => {
    const ctx = { tabId: 1, sessionId: 'c1', signal: new AbortController().signal };
    const w = await executeTool('memory_write', { content: '偏好中文' }, ctx);
    expect(w.ok).toBe(true);
    const id = (w as { data: { id: string } }).data.id;

    const l = await executeTool('memory_list', {}, ctx);
    expect(l.ok).toBe(true);
    expect((l as { data: { total: number } }).data.total).toBe(1);

    const d = await executeTool('memory_delete', { id }, ctx);
    expect(d.ok).toBe(true);
    expect((await executeTool('memory_list', {}, ctx) as { data: { total: number } }).data.total).toBe(0);
  });

  it('记忆工具豁免受限页预检（受限页 URL 上仍能用）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const ctx = { tabId: 1, sessionId: 'c1', signal: new AbortController().signal };
    const r = await executeTool('memory_list', {}, ctx);
    expect(r.ok).toBe(true); // 记忆工具在 RESTRICTED 检查之前分发,受限页也放行
  });
});
