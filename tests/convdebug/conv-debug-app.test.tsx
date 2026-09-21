// tests/convdebug/conv-debug-app.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ConvDebugApp } from '../../components/convdebug/ConvDebugApp';
import { createConversation, appendMessage } from '../../storage/conversations';
import { appendTurnTrace, type TurnTrace } from '../../storage/traces';

const turn = (n: number): TurnTrace => ({
  turn: n, startedAt: 1000, endedAt: 1400, tabId: 1, mode: 'agent',
  context: { messageCount: 2, chars: 100, hasSummary: false, summaryChars: 0, skillCount: 0, systemPromptChars: 50, pageUrl: 'https://x.com' },
  llm: { ms: 300, finishReason: 'stop', textChars: 2, reasoningChars: 0 },
  tools: [], outcome: 'done',
});

describe('ConvDebugApp', () => {
  beforeEach(() => fakeBrowser.reset());
  afterEach(cleanup);

  it('无会话时显示空态', async () => {
    render(<ConvDebugApp initialConvId="" />);
    await waitFor(() => expect(screen.getByText('还没有任何会话')).toBeTruthy());
  });

  it('initialConvId 命中时直接展示该会话详情', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '你好' });
    await appendTurnTrace(c.id, turn(1));

    render(<ConvDebugApp initialConvId={c.id} />);
    // 用 meta 行全文匹配：brief 原写的 /1 轮/ 会同时命中占位组件的「共 1 轮（时间线待实现）」
    // 导致 getByText 抛 multiple elements，故收紧到 meta 行的「N 消息 · N 轮」
    await waitFor(() => expect(screen.getByText(/1 消息 · 1 轮/)).toBeTruthy());
    // 标题同时出现在左栏条目与详情 h1，故用 getAllByText
    expect(screen.getAllByText('你好').length).toBeGreaterThan(0);
  });

  it('trace 被裁剪时给出降级提示', async () => {
    const c = await createConversation();
    // 直接写裸 driver key（wxt 把 'local:conv:x:trace' 映射成 chrome.storage.local 里的
    // 'conv:x:trace'），模拟「累计 5 轮、只剩最近 2 轮」的裁剪态
    await fakeBrowser.storage.local.set({ [`conv:${c.id}:trace`]: { seq: 5, turns: [turn(4), turn(5)] } });

    render(<ConvDebugApp initialConvId={c.id} />);
    await waitFor(() => expect(screen.getByText(/trace 仅保留最近/)).toBeTruthy());
  });

  it('initialConvId 指向不存在的会话 → 提示不存在', async () => {
    render(<ConvDebugApp initialConvId="ghost" />);
    await waitFor(() => expect(screen.getByText('会话不存在或已删除')).toBeTruthy());
  });
});
