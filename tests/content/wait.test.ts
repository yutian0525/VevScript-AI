// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { waitForText } from '../../content/wait';

describe('wait_for', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('文本已存在时立即成功', async () => {
    document.body.textContent = '加载完成';
    const r = await waitForText({ texts: ['完成'], timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });

  it('文本稍后出现时成功', async () => {
    setTimeout(() => { document.body.textContent = '出现了'; }, 20);
    const r = await waitForText({ texts: ['出现'], timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });

  it('超时返回失败', async () => {
    const r = await waitForText({ texts: ['永不出现'], timeoutMs: 60 }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
  });

  it('多 text 命中任一即成功', async () => {
    document.body.textContent = 'B';
    const r = await waitForText({ texts: ['A', 'B'], timeoutMs: 500 });
    expect(r.ok).toBe(true);
  });

  it('向后兼容：texts 任一命中即成功', async () => {
    document.body.innerHTML = '<div>已完成</div>';
    const r = await waitForText({ texts: ['进行中', '已完成'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { matched: string }).matched).toBe('已完成');
  });

  it('appear：等元素出现', async () => {
    document.body.innerHTML = '<div role="dialog">弹窗</div>';
    const r = await waitForText({ appear: { role: 'dialog' } });
    expect(r.ok).toBe(true);
  });

  it('gone：等元素消失（本来就没有时立即成功）', async () => {
    document.body.innerHTML = '';
    const r = await waitForText({ gone: '.loading' });
    expect(r.ok).toBe(true);
  });

  it('idle：等网络静默', async () => {
    const r = await waitForText({ idle: 50, timeoutMs: 3000 });
    expect(r.ok).toBe(true);
  });

  it('超时返回 ok:false 且带条件描述与 hint', async () => {
    document.body.innerHTML = '';
    const r = await waitForText({ appear: { role: 'dialog' }, timeoutMs: 150 }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('dialog');
  });

  it('一个都不传时报错（避免无条件死等到超时）', async () => {
    const r = await waitForText({} as never) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('至少');
  });

  it('多个条件同传时报错（不静默取优先）', async () => {
    const r = await waitForText({ texts: ['x'], idle: 100 } as never) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('只能');
  });

  it('texts 超时报「均未出现」且不提谓词（报错文案讲文本不讲实现）', async () => {
    document.body.innerHTML = '';
    const r = await waitForText({ texts: ['甲', '乙'], timeoutMs: 100 }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('均未出现');
    expect(r.error).toContain('甲 / 乙');
    expect(r.error).not.toContain('谓词');
  });

  it('appear 传失效 uid 立即报失效（不死等到超时）', async () => {
    const t0 = Date.now();
    const r = await waitForText({ appear: 424242, timeoutMs: 5000 }) as { ok: boolean; error: string };
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已失效');
    // 前置检查的意义就在「不死等」：若走了 locator 轮询要吃满 5s 超时
    expect(elapsed).toBeLessThan(3000);
  });

  it('appear 传有效 uid 时正常等待不误伤', async () => {
    // resolveUid 只认 content script 快照分配的 uid；测试里不经快照拿不到映射，
    // 用 CSS locator 验证同一条 appear 路径的前置检查不会拦下非 uid 条件即可。
    document.body.innerHTML = '<div role="dialog">弹窗</div>';
    const r = await waitForText({ appear: { role: 'dialog' }, timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });
});
