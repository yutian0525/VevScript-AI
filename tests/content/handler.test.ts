// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { handleCsRequest } from '../../entrypoints/content';
import { createRequest } from '../../shared/messages';
import { resolveUid } from '../../content/snapshot/build';

describe('content 消息处理器', () => {
  beforeEach(() => { document.body.innerHTML = '<button>登录</button>'; });

  it('SNAPSHOT 返回快照文本', async () => {
    const resp = await handleCsRequest(createRequest('SNAPSHOT', {}));
    expect(resp.type).toBe('SNAPSHOT');
    expect(resp.result.ok).toBe(true);
    // ToolResult 是判别联合，ok=false 分支无 data；断言成功后按成功分支取 data。
    expect((resp.result as { ok: true; data: { text: string } }).data.text).toContain('登录');
  });

  it('PAGE_META 返回 url/title/readyState', async () => {
    const resp = await handleCsRequest(createRequest('PAGE_META', {}));
    expect(resp.result.ok).toBe(true);
    expect((resp.result as { ok: true; data: unknown }).data).toHaveProperty('url');
  });

  it('CLICK 未知 uid 返回 stale（result.ok=false，但响应本身成功）', async () => {
    const resp = await handleCsRequest(createRequest('CLICK', { uid: 999 }));
    expect(resp.type).toBe('CLICK');
    expect(resp.result.ok).toBe(false);
  });

  it('CLICK 命中 uid 时成功（不再附带快照）', async () => {
    await handleCsRequest(createRequest('SNAPSHOT', {}));
    let uid = 0;
    for (let i = 1; i < 100; i++) if (resolveUid(i)?.textContent === '登录') { uid = i; break; }
    const resp = await handleCsRequest(createRequest('CLICK', { uid }));
    expect(resp.result.ok).toBe(true);
    // 点击不再返回快照——查看页面变化需另行 take_snapshot
    expect((resp.result as { ok: true; data?: { snapshot?: string } }).data?.snapshot).toBeUndefined();
  });

  it('correlationId 透传', async () => {
    const req = createRequest('SNAPSHOT', {});
    const resp = await handleCsRequest(req);
    expect(resp.correlationId).toBe(req.correlationId);
  });
});
