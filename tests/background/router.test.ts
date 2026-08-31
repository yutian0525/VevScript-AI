// tests/background/router.test.ts
import { describe, it, expect } from 'vitest';
import { MessageRouter } from '../../background/router';

describe('MessageRouter', () => {
  it('已注册 type 分发到对应 handler', async () => {
    const router = new MessageRouter();
    router.on('PING', async () => ({ ok: true, data: { pong: 1 } }));
    const r = await router.dispatch({ type: 'PING' });
    expect(r).toEqual({ ok: true, data: { pong: 1 } });
  });

  it('未注册 type 返回结构化错误', async () => {
    const router = new MessageRouter();
    const r = (await router.dispatch({ type: 'NOPE' })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('NOPE');
  });

  it('handler 抛异常时返回结构化错误（不向外抛）', async () => {
    const router = new MessageRouter();
    router.on('BOOM', () => {
      throw new Error('handler crashed');
    });
    const r = (await router.dispatch({ type: 'BOOM' })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('handler crashed');
  });

  it('handler 以非 Error 抛出时不崩溃', async () => {
    const router = new MessageRouter();
    router.on('STR', () => {
      throw 'plain string'; // eslint-disable-line no-throw-literal
    });
    const r = (await router.dispatch({ type: 'STR' })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('plain string');
  });

  it('on 可覆盖同 type 的旧 handler', async () => {
    const router = new MessageRouter();
    router.on('X', () => ({ ok: true, data: 'first' }));
    router.on('X', () => ({ ok: true, data: 'second' }));
    const r = (await router.dispatch({ type: 'X' })) as { ok: boolean; data: string };
    expect(r.data).toBe('second');
  });
});
