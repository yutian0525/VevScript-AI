import { describe, it, expect } from 'vitest';
import { initGuardState, recordTurn, checkGuards, DEFAULT_GUARD_CONFIG } from '../../agent/loop-guards';
import type { ToolCall } from '../../agent/provider/types';
import type { ToolResult } from '../../shared/types';

const tc = (name: string, args: string): ToolCall => ({ id: Math.random().toString(), name, arguments: args });
const ok: ToolResult = { ok: true };
const bad: ToolResult = { ok: false, error: 'x' };

describe('熔断阀', () => {
  it('初始状态无暂停', () => {
    const s = initGuardState();
    expect(checkGuards(s, DEFAULT_GUARD_CONFIG).stop).toBe(false);
  });

  it('连续 3 次同工具同参数 → 打转暂停', () => {
    let s = initGuardState();
    for (let i = 0; i < 3; i++) s = recordTurn(s, [tc('click', '{"uid":1}')], [ok]);
    expect(checkGuards(s, DEFAULT_GUARD_CONFIG)).toMatchObject({ stop: true, reason: expect.stringContaining('重复') });
  });

  it('不同参数不算打转', () => {
    let s = initGuardState();
    s = recordTurn(s, [tc('click', '{"uid":1}')], [ok]);
    s = recordTurn(s, [tc('click', '{"uid":2}')], [ok]);
    s = recordTurn(s, [tc('click', '{"uid":3}')], [ok]);
    expect(checkGuards(s, DEFAULT_GUARD_CONFIG).stop).toBe(false);
  });

  it('连续 5 次全失败 → 错误熔断', () => {
    let s = initGuardState();
    for (let i = 0; i < 5; i++) s = recordTurn(s, [tc('click', `{"uid":${i}}`)], [bad]);
    expect(checkGuards(s, DEFAULT_GUARD_CONFIG)).toMatchObject({ stop: true, reason: expect.stringContaining('失败') });
  });

  it('中途成功重置错误计数', () => {
    let s = initGuardState();
    for (let i = 0; i < 4; i++) s = recordTurn(s, [tc('click', `{"uid":${i}}`)], [bad]);
    s = recordTurn(s, [tc('click', '{"uid":99}')], [ok]);
    expect(checkGuards(s, DEFAULT_GUARD_CONFIG).stop).toBe(false);
  });

  it('无步数上限：大量不同的成功调用不触发暂停', () => {
    let s = initGuardState();
    // 100 轮各不相同、均成功的调用——不打转、不报错，就不应因"步数"被暂停
    for (let i = 0; i < 100; i++) s = recordTurn(s, [tc('scroll', `{"amount":${i}}`)], [ok]);
    expect(checkGuards(s, DEFAULT_GUARD_CONFIG).stop).toBe(false);
  });

  it('无 token 预算：长任务（大量不同成功调用）不因累计 token 被暂停', () => {
    let s = initGuardState();
    // 曾有 150k token 软预算，现已移除——只要不打转/不连错，长任务不应被熔断
    for (let i = 0; i < 500; i++) s = recordTurn(s, [tc('scroll', `{"amount":${i}}`)], [ok]);
    expect(checkGuards(s, DEFAULT_GUARD_CONFIG).stop).toBe(false);
  });
});
