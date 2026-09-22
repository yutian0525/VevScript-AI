// tests/agent/context-prefix-stability.test.ts
// 核心不变量（spec §10）：tools+system+history 是逐字节稳定的缓存前缀，
// 页面/记忆的变化只允许出现在末条易变块里。这条测试是整次优化的验收标准——
// 它挂了就说明前缀缓存白做。
import { describe, it, expect } from 'vitest';
import { buildContext } from '../../agent/context';
import type { ChatMessage } from '../../agent/provider/types';

const u = (c: string): ChatMessage => ({ role: 'user', content: c });
const page = { url: 'https://a.com/x', title: 'A' };
const mem = (content: string) => ({
  enabled: true, writable: true,
  entries: [{ id: 'g1', content, matches: [], updatedAt: 1 }],
});

/** 去掉末条易变块（【环境】…）后的消息数组。 */
const stablePart = (msgs: ChatMessage[]): ChatMessage[] => {
  const last = msgs[msgs.length - 1]!;
  const isVolatile = last.role === 'user'
    && typeof last.content === 'string' && last.content.startsWith('【环境】');
  return isVolatile ? msgs.slice(0, -1) : msgs;
};

describe('前缀稳定性', () => {
  it('连续两轮：第二轮的稳定前缀以第一轮的稳定前缀开头（逐字节）', () => {
    const t1 = buildContext([u('第一句')], page, { memory: mem('偏好中文') });
    const t2 = buildContext([u('第一句'), u('第二句')], page, { memory: mem('偏好中文') });
    const p1 = stablePart(t1), p2 = stablePart(t2);
    expect(JSON.stringify(p2.slice(0, p1.length))).toBe(JSON.stringify(p1));
  });

  it('页面 URL/标题变了，稳定前缀仍逐字节相同', () => {
    const a = buildContext([u('x')], { url: 'https://a.com/1', title: '标题1' }, { memory: mem('m') });
    const b = buildContext([u('x')], { url: 'https://a.com/2', title: '标题2' }, { memory: mem('m') });
    expect(JSON.stringify(stablePart(a))).toBe(JSON.stringify(stablePart(b)));
    // 差异确实存在，只是被关在尾部块里
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('记忆条目变了，稳定前缀仍逐字节相同', () => {
    const a = buildContext([u('x')], page, { memory: mem('旧记忆') });
    const b = buildContext([u('x')], page, { memory: mem('新记忆') });
    expect(JSON.stringify(stablePart(a))).toBe(JSON.stringify(stablePart(b)));
  });

  it('技能清单变了，稳定前缀跟着变（技能块留在前缀里是刻意的）', () => {
    const a = buildContext([u('x')], page, { skills: [{ name: 'N', command: 'c', description: 'd', createdAt: 1 }] });
    const b = buildContext([u('x')], page, { skills: [] });
    expect(JSON.stringify(stablePart(a))).not.toBe(JSON.stringify(stablePart(b)));
  });
});

describe('易变块内容与位置', () => {
  it('页面信息与记忆条目都进末条易变块，system 里不再有它们', () => {
    const msgs = buildContext([u('x')], page, { memory: mem('偏好中文') });
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe('user');
    const text = String(last.content);
    expect(text).toContain('【环境】');
    expect(text).toContain('非用户发言');
    expect(text).toContain('https://a.com/x');
    expect(text).toContain('偏好中文');

    const sys = String(msgs[0]!.content);
    expect(sys).not.toContain('https://a.com/x');
    expect(sys).not.toContain('偏好中文');
    expect(sys).toContain('## 记忆'); // 说明与用法仍在 system
  });

  it('页面为空且记忆易变为空 → 不追加易变块', () => {
    const msgs = buildContext([u('x')], { url: '', title: '' });
    expect(msgs).toHaveLength(2);
    expect(msgs[msgs.length - 1]!.content).toBe('x');
  });

  it('只有记忆易变内容、页面为空 → 仍追加，只带记忆段', () => {
    const msgs = buildContext([u('x')], { url: '', title: '' }, { memory: mem('偏好中文') });
    const text = String(msgs[msgs.length - 1]!.content);
    expect(text).toContain('偏好中文');
    // 用带冒号的段落头判定「无页面段」：块首行文案本身含「当前页面」四字，裸子串会误伤
    expect(text).not.toContain('当前页面：');
  });

  it('summary 分支：易变块仍在最末，摘要位置不变', () => {
    const msgs = buildContext([u('m0'), u('m1')], page, { summary: { text: 'S', coversUpTo: 0 } });
    expect(String(msgs[1]!.content)).toContain('S');
    expect(String(msgs[msgs.length - 1]!.content)).toContain('【环境】');
  });

  it('首轮是两条连续 user（system + 用户话 + 易变块）', () => {
    const msgs = buildContext([u('你好')], page);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  it('ask 模式：记忆按只读渲染，不宣传 memory_write', () => {
    const msgs = buildContext([u('x')], page, { mode: 'ask', memory: mem('m') });
    const sys = String(msgs[0]!.content);
    expect(sys).not.toContain('memory_write');
    expect(sys).not.toContain('memory_delete');
    expect(sys).toContain('memory_list');
  });

  it('agent 模式：记忆仍按可写渲染', () => {
    const sys = String(buildContext([u('x')], page, { mode: 'agent', memory: mem('m') })[0]!.content);
    expect(sys).toContain('memory_write');
  });
});
