import { describe, it, expect, vi, afterEach } from 'vitest';
import { doHttpRequest } from '../../../agent/tools/http';

function mockFetch(status: number, headers: Record<string, string>, body: string) {
  return vi.fn().mockResolvedValue({
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('http_request', () => {
  it('GET 成功返回 status/headers 子集/body', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' }, '{"a":1}'));
    const r = await doHttpRequest({ url: 'https://api.x.com/d' });
    expect(r.ok).toBe(true);
    const d = (r as { data: { status: number; headers: Record<string, string>; body: string } }).data;
    expect(d.status).toBe(200);
    expect(d.headers['content-type']).toBe('application/json');
    expect(d.headers['set-cookie']).toBeUndefined(); // 非白名单不回
    expect(d.body).toContain('"a":1');
  });

  it('带凭证发送', async () => {
    const f = mockFetch(200, { 'content-type': 'text/plain' }, 'ok');
    vi.stubGlobal('fetch', f);
    await doHttpRequest({ url: 'https://x.com', method: 'POST', body: 'hi', headers: { 'X-T': '1' } });
    const opts = f.mock.calls[0]![1] as { credentials: string; method: string };
    expect(opts.credentials).toBe('include');
    expect(opts.method).toBe('POST');
  });

  it('body 超 64KB 截断标注', async () => {
    const big = 'x'.repeat(70_000);
    vi.stubGlobal('fetch', mockFetch(200, { 'content-type': 'text/plain' }, big));
    const r = await doHttpRequest({ url: 'https://x.com' });
    const d = (r as { data: { body: string; truncated?: boolean } }).data;
    expect(d.body.length).toBe(65_536);
    expect(d.truncated).toBe(true);
  });

  it('非文本 content-type 省略 body', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { 'content-type': 'image/png' }, 'binarygarbage'));
    const r = await doHttpRequest({ url: 'https://x.com/img.png' });
    const d = (r as { data: { body: string } }).data;
    expect(d.body).toContain('非文本');
  });

  it('url 缺失报错', async () => {
    const r = await doHttpRequest({ url: '' });
    expect(r.ok).toBe(false);
  });

  it('网络错误返回失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await doHttpRequest({ url: 'https://x.com' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('ECONNREFUSED');
  });

  it('外部 signal 已 abort 时中止', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_u, opts) => {
      return new Promise((_res, rej) => {
        (opts.signal as AbortSignal).addEventListener('abort', () => rej(new Error('aborted')));
      });
    }));
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await doHttpRequest({ url: 'https://x.com' }, ctrl.signal);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('中止');
  });
});
