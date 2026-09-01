// tests/agent/provider/think-splitter.test.ts
import { describe, it, expect } from 'vitest';
import { createThinkSplitter, type ThinkSink } from '../../../agent/provider/think-splitter';

function collect() {
  const reasoning: string[] = [];
  const text: string[] = [];
  const sink: ThinkSink = { reasoning: (t) => reasoning.push(t), text: (t) => text.push(t) };
  return { sink, reasoning, text, r: () => reasoning.join(''), t: () => text.join('') };
}

describe('createThinkSplitter', () => {
  it('无 think 标签：整段作为 text 透传', () => {
    const c = collect();
    const s = createThinkSplitter(c.sink);
    s.push('直接回答');
    s.push('没有思考');
    s.flush();
    expect(c.t()).toBe('直接回答没有思考');
    expect(c.r()).toBe('');
  });

  it('单 chunk 内完整 <think>…</think>：思考归 reasoning，正文归 text', () => {
    const c = collect();
    const s = createThinkSplitter(c.sink);
    s.push('<think>让我想想</think>答案是 42');
    s.flush();
    expect(c.r()).toBe('让我想想');
    expect(c.t()).toBe('答案是 42');
  });

  it('标签被切在不同 chunk（<thi + nk>）仍正确拆分', () => {
    const c = collect();
    const s = createThinkSplitter(c.sink);
    s.push('<thi');
    s.push('nk>思考');
    s.push('内容</thi');
    s.push('nk>正文');
    s.flush();
    expect(c.r()).toBe('思考内容');
    expect(c.t()).toBe('正文');
  });

  it('思考内容跨多个 chunk 累加', () => {
    const c = collect();
    const s = createThinkSplitter(c.sink);
    s.push('<think>第一步');
    s.push('第二步');
    s.push('</think>结论');
    s.flush();
    expect(c.r()).toBe('第一步第二步');
    expect(c.t()).toBe('结论');
  });

  it('未闭合 <think>：flush 时残留按思考区段吐出', () => {
    const c = collect();
    const s = createThinkSplitter(c.sink);
    s.push('<think>还在想');
    s.flush();
    expect(c.r()).toBe('还在想');
    expect(c.t()).toBe('');
  });

  it('正文里含 < 但非 think 标签：不误吞（held-back 回退）', () => {
    const c = collect();
    const s = createThinkSplitter(c.sink);
    s.push('a < b'); // '<' 后接 ' '，不是 <think> 前缀
    s.push(' 且 c < d');
    s.flush();
    expect(c.t()).toBe('a < b 且 c < d');
    expect(c.r()).toBe('');
  });

  it('以 < 结尾的 chunk 暂留半截，下个 chunk 证伪后完整吐出', () => {
    const c = collect();
    const s = createThinkSplitter(c.sink);
    s.push('结果 <'); // 可能是 <think> 前缀，暂留 '<'
    s.push('= 5');     // 证伪，'<' 不是 think 开头
    s.flush();
    expect(c.t()).toBe('结果 <= 5');
    expect(c.r()).toBe('');
  });

  it('先思考后正文再思考（多段交替）', () => {
    const c = collect();
    const s = createThinkSplitter(c.sink);
    s.push('<think>想A</think>正文A<think>想B</think>正文B');
    s.flush();
    expect(c.r()).toBe('想A想B');
    expect(c.t()).toBe('正文A正文B');
  });
});
