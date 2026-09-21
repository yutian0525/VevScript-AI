// tests/background/cdp-bodies.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { shouldFetchBody, truncateBody, fetchBody, MAX_BODY } from '../../background/cdp/bodies';

function mockDebugger(sendCommand: (m: string, p?: Record<string, unknown>) => unknown) {
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    sendCommand: (async (_t: unknown, method: string, params?: Record<string, unknown>) => sendCommand(method, params)) as never,
  };
}

beforeEach(() => { fakeBrowser.reset(); });

describe('shouldFetchBody', () => {
  it('白名单内类型抓取', () => {
    expect(shouldFetchBody('XHR', 'application/json')).toBe(true);
    expect(shouldFetchBody('Fetch', 'application/json')).toBe(true);
    expect(shouldFetchBody('Document', 'text/html')).toBe(true);
  });

  it('白名单外类型跳过', () => {
    expect(shouldFetchBody('Image', 'image/png')).toBe(false);
    expect(shouldFetchBody('Script', 'text/javascript')).toBe(false);
  });

  it('非文本 mimeType 跳过', () => {
    expect(shouldFetchBody('Fetch', 'image/svg+xml')).toBe(false);
    expect(shouldFetchBody('Fetch', 'font/woff2')).toBe(false);
    expect(shouldFetchBody('Fetch', 'audio/mpeg')).toBe(false);
    expect(shouldFetchBody('Fetch', 'video/mp4')).toBe(false);
  });

  it('SSE 跳过（对齐原 hook 对 event-stream 的处理）', () => {
    expect(shouldFetchBody('Fetch', 'text/event-stream')).toBe(false);
  });

  it('mimeType 缺失时按类型放行', () => {
    expect(shouldFetchBody('XHR', undefined)).toBe(true);
  });
});

describe('truncateBody', () => {
  it('未超限原样返回', () => {
    expect(truncateBody('abc')).toEqual({ body: 'abc', truncated: false });
  });

  it('超限截断并标 truncated', () => {
    const r = truncateBody('x'.repeat(MAX_BODY + 10));
    expect(r.body).toHaveLength(MAX_BODY);
    expect(r.truncated).toBe(true);
  });
});

describe('fetchBody', () => {
  it('成功取到文本体', async () => {
    mockDebugger(() => ({ body: '{"ok":1}', base64Encoded: false }));
    await expect(fetchBody(1, undefined, 'r1')).resolves.toEqual({ body: '{"ok":1}', truncated: false });
  });

  it('base64Encoded 为真时不落库（二进制）', async () => {
    mockDebugger(() => ({ body: 'AAAA', base64Encoded: true }));
    await expect(fetchBody(1, undefined, 'r1')).resolves.toBeNull();
  });

  it('CDP 抛错时返回 null（best-effort，不阻断观测）', async () => {
    mockDebugger(() => { throw new Error('No resource with given identifier'); });
    await expect(fetchBody(1, undefined, 'r1')).resolves.toBeNull();
  });
});
