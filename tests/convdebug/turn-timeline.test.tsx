// tests/convdebug/turn-timeline.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { TurnTimeline } from '../../components/convdebug/TurnTimeline';
import type { TurnTrace } from '../../storage/traces';

const turn = (n: number, over?: Partial<TurnTrace>): TurnTrace => ({
  turn: n, startedAt: 0, endedAt: 2400, tabId: 1, mode: 'agent',
  context: { messageCount: 18, chars: 42000, hasSummary: false, summaryChars: 0, skillCount: 0, systemPromptChars: 500, pageUrl: 'https://x.com' },
  llm: { ms: 1900, firstTokenMs: 400, finishReason: 'stop', usage: { promptTokens: 1200, completionTokens: 340 }, textChars: 20, reasoningChars: 0 },
  tools: [], outcome: 'done',
  ...over,
});

describe('TurnTimeline', () => {
  afterEach(cleanup);

  it('空 trace 显示空态', () => {
    render(<TurnTimeline turns={[]} />);
    expect(screen.getByText(/还没有 loop 记录/)).toBeTruthy();
  });

  it('最近一轮默认展开，其余收起', () => {
    render(<TurnTimeline turns={[turn(1), turn(2)]} />);
    // #2 展开 → 它的工具表头可见；#1 收起 → 没有
    expect(screen.getAllByText('上下文').length).toBe(1);
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
  });

  it('点击折叠头切换展开态', () => {
    render(<TurnTimeline turns={[turn(1), turn(2)]} />);
    fireEvent.click(screen.getByText('#1'));
    expect(screen.getAllByText('上下文').length).toBe(2);
    fireEvent.click(screen.getByText('#2'));
    expect(screen.getAllByText('上下文').length).toBe(1);
  });

  it('折叠头展示耗时 / LLM 耗时 / token / 工具数 / outcome', () => {
    render(<TurnTimeline turns={[turn(3, { tools: [
      { name: 'click', callId: 'c1', argsBytes: 9, ms: 12, ok: true, summary: '成功' },
    ] })]} />);
    expect(screen.getByText('2.4s')).toBeTruthy();
    expect(screen.getByText('LLM 1.9s')).toBeTruthy();
    expect(screen.getByText('1.2k→340')).toBeTruthy();
    expect(screen.getByText('1 工具')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
  });

  it('展开体渲染上下文摘要、TTFT、工具明细与压缩', () => {
    render(<TurnTimeline turns={[turn(1, {
      compact: { ms: 800, ok: true, newPromptTokens: 400 },
      tools: [{ name: 'scroll', callId: 'c9', argsBytes: 20, ms: 30, ok: false, error: '元素不存在', summary: '元素不存在' }],
    })]} />);
    expect(screen.getByText(/18 条/)).toBeTruthy();
    expect(screen.getByText(/42.0k 字/)).toBeTruthy();
    expect(screen.getByText(/TTFT 400ms/)).toBeTruthy();
    expect(screen.getByText(/压缩后 400 tok/)).toBeTruthy();
    expect(screen.getByText('scroll')).toBeTruthy();
    expect(screen.getByText('元素不存在')).toBeTruthy();
  });

  it('熔断轮展示 guardReason', () => {
    render(<TurnTimeline turns={[turn(1, { outcome: 'paused', guardReason: '连续 3 次重复调用同一工具，可能卡住' })]} />);
    expect(screen.getByText(/重复调用同一工具/)).toBeTruthy();
    expect(screen.getByText('paused')).toBeTruthy();
  });

  it('outcome 落到修饰类名上', () => {
    const { container } = render(<TurnTimeline turns={[turn(1, { outcome: 'aborted' })]} />);
    expect(container.querySelector('.convdebug-turn--aborted')).toBeTruthy();
  });
});
