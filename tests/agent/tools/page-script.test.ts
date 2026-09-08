import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doRunPageScript } from '../../../agent/tools/page-script';
import { ingestConsole, resetStore } from '../../../background/observe-store';
// 压缩走 mock（jsdom 无 OffscreenCanvas，真实 compressDataUrl 必抛错）——
// 范式同 tests/agent/tools/screenshot.test.ts。
import * as screenshot from '../../../agent/tools/screenshot';

/** 桩 executeScript 返回 scriptRunner 的结果。 */
function stubExec(result: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(browser.scripting, 'executeScript').mockResolvedValue([{ result }] as never);
}

describe('run_page_script', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    resetStore();
    // doScreenshot 内部经 self.compressDataUrl 调用压缩，jsdom 无 OffscreenCanvas 必须 mock
    vi.spyOn(screenshot, 'compressDataUrl').mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,ZZZ',
      width: 800,
      height: 600,
    });
  });

  it('缺 script 参数返回错误', async () => {
    const r = await doRunPageScript(1, {} as never);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('script');
  });

  it('成功时透传 trace/logs/data 并带 pageErrors:0', async () => {
    stubExec({ ok: true, data: [1, 2], trace: [{ i: 1, op: '$' }], logs: ['x'], url: 'https://a.com', elapsed: 12 });
    const r = await doRunPageScript(1, { script: 'return 1' });
    expect(r.ok).toBe(true);
    const d = (r as { ok: true; data: Record<string, unknown> }).data;
    expect(d.data).toEqual([1, 2]);
    expect(d.trace).toEqual([{ i: 1, op: '$' }]);
    expect(d.pageErrors).toBe(0);
  });

  it('默认 world 为 ISOLATED', async () => {
    const spy = stubExec({ ok: true, url: 'https://a.com' });
    await doRunPageScript(1, { script: 'return 1' });
    expect((spy.mock.calls[0]![0] as { world: string }).world).toBe('ISOLATED');
  });

  it('world:"main" 转 MAIN 并在返回值里提示 uid 不可用', async () => {
    const spy = stubExec({ ok: true, url: 'https://a.com' });
    const r = await doRunPageScript(1, { script: 'return 1', world: 'main' });
    expect((spy.mock.calls[0]![0] as { world: string }).world).toBe('MAIN');
    expect(String((r as { ok: true; data: Record<string, unknown> }).data.worldNotice)).toContain('uid');
  });

  it('失败时透传 kind/failedAt/hint', async () => {
    stubExec({
      ok: false, kind: 'blocked', error: '点击被遮挡：…',
      failedAt: { i: 3, matched: 1 }, hint: '先关掉提示条', trace: [{ i: 1, op: '$' }], url: 'https://a.com',
    });
    const r = await doRunPageScript(1, { script: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('遮挡');
    const d = (r as unknown as { ok: false; data: Record<string, unknown> }).data;
    expect(d.kind).toBe('blocked');
    expect(d.failedAt).toMatchObject({ i: 3 });
    expect(d.hint).toBe('先关掉提示条');
    expect(d.trace).toHaveLength(1);
  });

  it('超时返回 timeout 且带 hint（不是空白）', async () => {
    vi.spyOn(browser.scripting, 'executeScript').mockImplementation(
      () => new Promise(() => { /* 永不 resolve */ }) as never,
    );
    // 20ms 低于下限 1000 会被 clamp；用 50s（在 [1s, 120s] 内）验证透传
    const r = await doRunPageScript(1, { script: 'x', timeoutMs: 50_000 });
    expect(r.ok).toBe(false);
    expect((r as unknown as { ok: false; data: Record<string, unknown> }).data.kind).toBe('timeout');
    expect((r as { error: string }).error).toContain('50');
    expect(String((r as unknown as { ok: false; data: Record<string, unknown> }).data.hint)).toContain('waitFor');
  }, 60_000);

  it('timeoutMs 上限 120s，超限取上限', async () => {
    stubExec({ ok: true, url: 'https://a.com' });
    const r = await doRunPageScript(1, { script: 'x', timeoutMs: 999_999 });
    expect(r.ok).toBe(true);
    expect((r as { ok: true; data: Record<string, unknown> }).data.timeoutMs).toBe(120_000);
  });

  it('executeScript 无返回（页面卸载）时给可读错误', async () => {
    vi.spyOn(browser.scripting, 'executeScript').mockResolvedValue([] as never);
    const r = await doRunPageScript(1, { script: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('无返回');
  });

  it('executeScript 抛错时归一化', async () => {
    vi.spyOn(browser.scripting, 'executeScript').mockRejectedValue(new Error('Cannot access contents'));
    const r = await doRunPageScript(1, { script: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Cannot access contents');
  });

  it('合并执行期间的页面 error（区分「我的脚本错了」与「触发了页面 bug」）', async () => {
    // stub 成功脚本但页面在执行窗口内抛错：成功时只给数字（spec §5.4）
    stubExec({ ok: true, url: 'https://a.com' });
    ingestConsole(1, [
      { id: 'n:1', level: 'error', text: 'Uncaught TypeError: x', ts: Date.now() },
      { id: 'n:2', level: 'error', text: '第二条', ts: Date.now() },
      { id: 'n:3', level: 'warn', text: '警告不计', ts: Date.now() },
    ]);
    const r = await doRunPageScript(1, { script: 'x' });
    const d = (r as { ok: true; data: Record<string, unknown> }).data;
    expect(d.pageErrors).toBe(2);
    expect(d.lastPageError).toBeUndefined(); // 成功时不附正文，只有计数
  });

  it('失败时附窗口内最后一条页面 error 正文', async () => {
    stubExec({ ok: false, kind: 'assert', error: '断言失败', url: 'https://a.com' });
    ingestConsole(1, [
      { id: 'm:1', level: 'error', text: 'Uncaught TypeError: x', ts: Date.now() },
      { id: 'm:2', level: 'error', text: '最后一条', ts: Date.now() },
    ]);
    const r = await doRunPageScript(1, { script: 'x' });
    expect(r.ok).toBe(false);
    const d = (r as unknown as { ok: false; data: Record<string, unknown> }).data;
    expect(d.pageErrors).toBe(2);
    expect(String(d.lastPageError)).toContain('最后一条');
  });

  it('执行窗口之前的页面 error 不计入', async () => {
    ingestConsole(1, [{ id: 'n:0', level: 'error', text: '很久以前', ts: Date.now() - 60_000 }]);
    stubExec({ ok: true, url: 'https://a.com' });
    const r = await doRunPageScript(1, { script: 'x' });
    expect((r as { ok: true; data: Record<string, unknown> }).data.pageErrors).toBe(0);
  });

  it('screenshot:"never"（默认）不截图', async () => {
    stubExec({ ok: false, kind: 'assert', error: '断言失败', url: 'https://a.com' });
    const shot = vi.spyOn(browser.tabs, 'captureVisibleTab');
    await doRunPageScript(1, { script: 'x' });
    expect(shot).not.toHaveBeenCalled();
  });

  it('screenshot:"on-failure" 失败时截图并带回 dataUrl', async () => {
    stubExec({ ok: false, kind: 'assert', error: '断言失败', url: 'https://a.com' });
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, windowId: 9, active: true, url: 'https://a.com' }) as never;
    vi.spyOn(browser.tabs, 'captureVisibleTab').mockResolvedValue('data:image/jpeg;base64,AAA' as never);
    const r = await doRunPageScript(1, { script: 'x', screenshot: 'on-failure' });
    expect(String((r as unknown as { ok: false; data: Record<string, unknown> }).data.screenshot)).toContain('data:image');
  });

  it('screenshot:"on-failure" 成功时不截图', async () => {
    stubExec({ ok: true, url: 'https://a.com' });
    const shot = vi.spyOn(browser.tabs, 'captureVisibleTab');
    await doRunPageScript(1, { script: 'x', screenshot: 'on-failure' });
    expect(shot).not.toHaveBeenCalled();
  });

  it('截图失败不影响主结果（只加一句说明）', async () => {
    stubExec({ ok: false, kind: 'assert', error: '断言失败', url: 'https://a.com' });
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, windowId: 9, active: true }) as never;
    vi.spyOn(browser.tabs, 'captureVisibleTab').mockRejectedValue(new Error('权限不足'));
    const r = await doRunPageScript(1, { script: 'x', screenshot: 'always' });
    expect(r.ok).toBe(false);
    expect(String((r as unknown as { ok: false; data: Record<string, unknown> }).data.screenshotError)).toContain('权限不足');
  });
});
