// tests/convdebug/conv-debug-app.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('切会话时时间线折叠态不串扰（key=convId 重挂载）', async () => {
    // 两个会话各自都有一轮 —— 轮次号都从 1 起，撞号是常态而非例外
    const a = await createConversation();
    await appendTurnTrace(a.id, turn(1));
    const b = await createConversation();
    await appendTurnTrace(b.id, turn(1));

    const { container } = render(<ConvDebugApp initialConvId={a.id} />);
    // 等 A 的时间线渲染出来（#1 默认展开 → 恰好一个展开体）
    await waitFor(() => expect(screen.getAllByText('上下文').length).toBe(1));

    // 手动收起 A 的第 1 轮
    fireEvent.click(screen.getByText('#1'));
    expect(screen.queryAllByText('上下文').length).toBe(0);

    // 切到 B：两个会话标题都是默认的「新会话」会撞多个，故按「非当前选中项」
    // 定位——index 按 updatedAt 倒序是实现的偶然，不该让用例依赖列表排序。
    const other = Array.from(container.querySelectorAll<HTMLButtonElement>('.convdebug-item')).find(
      (el) => !el.classList.contains('convdebug-item--active'),
    );
    expect(other).toBeTruthy();
    fireEvent.click(other!);

    // B 的 #1 必须仍是展开态——若 TurnTimeline 没按 convId 重挂载，toggled[1] 会带过来
    await waitFor(() => expect(screen.getAllByText('上下文').length).toBe(1));
  });

  it('切会话时消息视图折叠态不串扰（key=convId 重挂载）', async () => {
    // 两个会话各一条带 reasoning 的 assistant 消息——行 key 都是 `${i}-${role}`，
    // 同下标必然撞 key，这是常态而非例外
    const a = await createConversation();
    await appendMessage(a.id, { role: 'assistant', content: '甲', reasoning: '甲的思考' });
    const b = await createConversation();
    await appendMessage(b.id, { role: 'assistant', content: '乙', reasoning: '乙的思考' });

    const { container } = render(<ConvDebugApp initialConvId={a.id} />);
    // 切到「原始消息流」视图
    fireEvent.click(await screen.findByText('原始消息流'));
    await waitFor(() => expect(screen.getByText('甲的思考')).toBeTruthy());

    // 展开 A 的 reasoning 折叠块。断言用 details.open（真实 DOM 属性）而非类名/CSS——
    // open 正是会被 reconcile 复用节点带过去的那份非受控状态。
    const details = screen.getByText('reasoning').closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText('reasoning'));
    expect(details.open).toBe(true);

    // 切到 B：标题都是默认的「新会话」会撞名，故按「非当前选中项」定位——
    // 复用 Task 7 那条用例的稳定写法，不依赖列表排序（updatedAt 倒序是实现的偶然）。
    const other = Array.from(container.querySelectorAll<HTMLButtonElement>('.convdebug-item')).find(
      (el) => !el.classList.contains('convdebug-item--active'),
    );
    expect(other).toBeTruthy();
    fireEvent.click(other!);

    // B 的 reasoning 必须仍是闭合态——若 RawMessages 没按 convId 重挂载，
    // React 会复用 A 的 <details> 节点，把它的 open 带过来
    await waitFor(() => expect(screen.getByText('乙的思考')).toBeTruthy());
    expect(screen.getByText('reasoning').closest('details')!.open).toBe(false);
  });
});
