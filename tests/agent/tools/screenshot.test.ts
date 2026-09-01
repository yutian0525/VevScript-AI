import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import * as screenshot from '../../../agent/tools/screenshot';
import { saveSettings } from '../../../storage/settings';

describe('截图工具', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await saveSettings({ agent: { screenshotPolicy: 'on-demand', confirmGate: true } });
    // 压缩走 mock（jsdom 无 OffscreenCanvas）。
    // spyOn 在跨用例间复用同一 spy，mockClear 清掉上一用例残留的调用记录，
    // 使各用例的 mock.calls[0] 指向自身这一次调用。
    vi.spyOn(screenshot, 'compressDataUrl').mockClear().mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,ZZZ',
      width: 800,
      height: 600,
    });
  });

  it('捕获成功返回压缩后截图', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, windowId: 10, active: true }) as never;
    fakeBrowser.tabs.captureVisibleTab = vi.fn().mockResolvedValue('data:image/jpeg;base64,RAW') as never;
    const r = await screenshot.doScreenshot(1, {});
    expect(r.ok).toBe(true);
    expect((r as { data: { screenshot: string } }).data.screenshot).toBe('data:image/jpeg;base64,ZZZ');
  });

  it('目标标签非 active 时先激活', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 2, windowId: 10, active: false }) as never;
    const update = vi.fn().mockResolvedValue({ id: 2 });
    fakeBrowser.tabs.update = update as never;
    fakeBrowser.tabs.captureVisibleTab = vi.fn().mockResolvedValue('data:image/jpeg;base64,RAW') as never;
    await screenshot.doScreenshot(2, {});
    expect(update).toHaveBeenCalledWith(2, { active: true });
  });

  it('screenshotPolicy=never 时禁用', async () => {
    await saveSettings({ agent: { screenshotPolicy: 'never', confirmGate: true } });
    const r = await screenshot.doScreenshot(1, {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('设置');
  });

  it('captureVisibleTab 抛错时返回失败', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, windowId: 10, active: true }) as never;
    fakeBrowser.tabs.captureVisibleTab = vi.fn().mockRejectedValue(new Error('cannot capture')) as never;
    const r = await screenshot.doScreenshot(1, {});
    expect(r.ok).toBe(false);
  });

  it('format=png 时透传到 capture 与 compress', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, windowId: 10, active: true }) as never;
    const capture = vi.fn().mockResolvedValue('data:image/png;base64,RAW');
    fakeBrowser.tabs.captureVisibleTab = capture as never;
    await screenshot.doScreenshot(1, { format: 'png' });
    expect(capture.mock.calls[0]![1].format).toBe('png');
    const compressArgs = (screenshot.compressDataUrl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect((compressArgs[1] as { format?: string }).format).toBe('png');
  });
});
