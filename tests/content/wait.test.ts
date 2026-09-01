// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { waitForText, waitForSettle } from '../../content/wait';

describe('waitForSettle', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('无变更时约在静默窗口后返回', async () => {
    const start = Date.now();
    await waitForSettle(40, 500);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(300);
  });

  it('DOM 持续变更时延后返回（每次变更重置静默计时）', async () => {
    const start = Date.now();
    const iv = setInterval(() => { document.body.appendChild(document.createElement('div')); }, 20);
    setTimeout(() => clearInterval(iv), 120);
    await waitForSettle(40, 2000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });

  it('持续变更触及 maxMs 硬顶也会返回', async () => {
    const iv = setInterval(() => { document.body.appendChild(document.createElement('div')); }, 15);
    const start = Date.now();
    await waitForSettle(100, 200);
    const elapsed = Date.now() - start;
    clearInterval(iv);
    expect(elapsed).toBeLessThan(500);
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });
});

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
});
