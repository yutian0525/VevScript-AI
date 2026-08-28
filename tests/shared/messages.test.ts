// tests/shared/messages.test.ts
import { describe, it, expect } from 'vitest';
import {
  createRequest,
  isResponseFor,
  type BgToCsRequest,
  type CsResponse,
  type CsToBgNotification,
} from '../../shared/messages';

describe('消息协议', () => {
  it('createRequest 生成唯一 correlation id', () => {
    const a = createRequest('SNAPSHOT', {});
    const b = createRequest('SNAPSHOT', {});
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(a.type).toBe('SNAPSHOT');
  });

  it('isResponseFor 匹配 correlationId 与 type', () => {
    const req = createRequest('CLICK', { uid: 1 });
    const resp: CsResponse = {
      correlationId: req.correlationId,
      type: 'CLICK',
      result: { ok: true },
    };
    expect(isResponseFor(resp, req)).toBe(true);
    expect(isResponseFor({ ...resp, correlationId: '999' }, req)).toBe(false);
    expect(isResponseFor({ ...resp, type: 'SNAPSHOT' as const }, req)).toBe(false);
  });

  it('CsToBgNotification 类型可赋值（编译期契约）', () => {
    const msg: CsToBgNotification = { type: 'NETLOG_PUSH', payload: { entries: [] } };
    expect(msg.type).toBe('NETLOG_PUSH');
  });

  it('BgToCsRequest 类型可赋值（编译期契约）', () => {
    const msg: BgToCsRequest = { type: 'PAGE_META', correlationId: 'x', payload: {} };
    expect(msg.type).toBe('PAGE_META');
  });
});
