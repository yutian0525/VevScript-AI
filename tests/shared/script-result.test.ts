import { describe, it, expect } from 'vitest';
import {
  SCRIPT_KINDS, DATA_CHAR_CAP, TRACE_CAP, TRACE_KEEP, LOG_CAP, LOG_CHAR_CAP,
  SERIALIZE_DEPTH_CAP, SERIALIZE_ARRAY_CAP,
} from '../../shared/script-result';
import type { ScriptKind, TraceEntry } from '../../shared/script-result';

describe('script-result', () => {
  it('kind 八分类齐全且顺序固定（schema 文案与文档按此顺序列出）', () => {
    expect([...SCRIPT_KINDS]).toEqual([
      'locator-miss', 'locator-ambiguous', 'blocked', 'state',
      'timeout', 'assert', 'script-error', 'page-error',
    ]);
  });

  it('上限常量与 spec §5.5 一致（scriptRunner 的内联值须与此相同）', () => {
    expect(DATA_CHAR_CAP).toBe(8192);
    expect(TRACE_CAP).toBe(50);
    expect(TRACE_KEEP).toBe(15);
    expect(LOG_CAP).toBe(30);
    expect(LOG_CHAR_CAP).toBe(500);
    expect(SERIALIZE_DEPTH_CAP).toBe(6);
    expect(SERIALIZE_ARRAY_CAP).toBe(200);
  });

  it('ScriptKind 类型可作字面量联合使用（编译期检查，运行时只验证长度）', () => {
    const kinds: readonly string[] = SCRIPT_KINDS;
    expect(kinds.length).toBe(8);
    // 编译期：每个成员都收窄为 ScriptKind 字面量
    const first: ScriptKind = SCRIPT_KINDS[0];
    const last: ScriptKind = SCRIPT_KINDS[7];
    expect(first).toBe('locator-miss');
    expect(last).toBe('page-error');
  });

  it('TraceEntry 判别联合：成功步与折叠标记都能赋值，消费方用 in 收窄（Task 18 用法探针）', () => {
    const entries: TraceEntry[] = [
      { i: 1, op: 'click', selector: '#btn', on: 'found' },
      { i: 2, op: 'fill', value: 'x', key: 'Enter', cond: 'visible', waited: 120, matched: 1 },
      { collapsed: 20 },
      { i: 23, op: 'expect', cond: 'text' },
    ];
    let steps = 0;
    let collapsedTotal = 0;
    for (const entry of entries) {
      // 注意：TraceStep 的索引签名 [k: string]: unknown 会让裸 `in` 收窄后
      // entry.collapsed 仍为 unknown（TS 将该分支收窄为 TraceStep & Record<'collapsed', unknown>）。
      // Task 18 的消费方须用 in + typeof 双保险（或显式标注），此处即探针示范。
      if ('collapsed' in entry && typeof entry.collapsed === 'number') collapsedTotal += entry.collapsed;
      else steps += 1;
    }
    expect(steps).toBe(3);
    expect(collapsedTotal).toBe(20);
  });
});
