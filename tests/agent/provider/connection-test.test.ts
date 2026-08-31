// tests/agent/provider/connection-test.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testConnection } from '../../../agent/provider/connection-test';

describe('testConnection', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('成功时返回 ok 与模型响应', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 }),
    );
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(true);
    expect(r.data).toBe('pong');
  });

  it('401 时返回错误信息', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }),
    );
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'bad', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
  });

  it('网络错误返回错误', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('非 JSON 响应体不崩溃', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>gateway error</html>', { status: 502 }));
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('502');
  });

  it('请求体与 headers 正确（Bearer、model、非流式）', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 }),
    );
    await testConnection({ baseUrl: 'https://api.x.com/v1/', apiKey: 'sk-9', model: 'gpt-x' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.x.com/v1/chat/completions'); // 去尾斜杠
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('gpt-x');
    expect(body.stream).toBeUndefined(); // 非流式
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-9' });
  });

  it('fetch 以非 Error 拒绝时不崩溃', async () => {
    vi.mocked(fetch).mockRejectedValue(null);
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});
