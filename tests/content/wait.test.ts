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
});
