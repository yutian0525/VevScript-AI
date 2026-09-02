import { describe, it, expect, beforeEach } from 'vitest';
import { useChat } from '../../stores/chat';
import type { ChatMessage } from '../../agent/provider/types';

describe('chat store', () => {
  beforeEach(() => useChat.getState().reset());

  it('addUserMessage 追加用户消息', () => {
    useChat.getState().addUserMessage('你好');
    const msgs = useChat.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', text: '你好' });
  });

  it('text-delta 累积到当前 assistant 消息', () => {
    useChat.getState().applyEvent({ type: 'text-delta', text: '你' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '好' });
    const msgs = useChat.getState().messages;
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'assistant', text: '你好' });
  });

  it('tool-start 追加工具卡片（running）', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{"uid":1}', callId: 'c1' });
    const tool = useChat.getState().messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ name: 'click', status: 'running' });
  });

  it('tool-end 更新对应卡片状态', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'click', callId: 'c1', ok: true, summary: '成功' });
    const tool = useChat.getState().messages.find((m) => m.role === 'tool' && m.callId === 'c1');
    expect(tool).toMatchObject({ status: 'done', ok: true });
  });

  it('state 事件同步 status', () => {
    useChat.getState().applyEvent({ type: 'state', status: 'running', messageCount: 3 });
    expect(useChat.getState().status).toBe('running');
  });

  it('paused 设置 paused 状态与原因', () => {
    useChat.getState().applyEvent({ type: 'paused', reason: '连续重复' });
    expect(useChat.getState().status).toBe('paused');
    expect(useChat.getState().pauseReason).toBe('连续重复');
  });

  it('done 设 idle', () => {
    useChat.getState().setStatus('running');
    useChat.getState().applyEvent({ type: 'done', finalText: 'x' });
    expect(useChat.getState().status).toBe('idle');
  });

  it('error 追加错误卡片并设 idle', () => {
    useChat.getState().applyEvent({ type: 'error', message: 'HTTP 401' });
    const last = useChat.getState().messages.at(-1)!;
    expect(last.role).toBe('error');
    expect(useChat.getState().status).toBe('idle');
  });

  it('重复 tool-start（同 callId）幂等：只留一张卡片', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{"uid":1}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{"uid":1}', callId: 'c1' });
    const tools = useChat.getState().messages.filter((m) => m.role === 'tool' && m.callId === 'c1');
    expect(tools).toHaveLength(1);
  });

  it('重复 tool-start 后 tool-end 正常置 done（不残留 running）', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'click', callId: 'c1', ok: true, summary: '成功' });
    const tools = useChat.getState().messages.filter((m) => m.role === 'tool' && m.callId === 'c1');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('done');
  });

  it('reasoning-delta 累积到 assistant 项并标记 thinking', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '想' });
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '一下' });
    const last = useChat.getState().messages.at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', reasoning: '想一下', thinking: true });
    expect(last.text).toBeUndefined();
  });

  it('首个 text-delta 自动收起思考块（thinking→false）并累积正文', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '推理' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '正' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '文' });
    const last = useChat.getState().messages.at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', reasoning: '推理', thinking: false, text: '正文' });
    expect(useChat.getState().messages).toHaveLength(1);
  });

  it('出正文后再来 reasoning-delta 另起新思考项（不回灌已收起的项）', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '先想' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '答案' });
    // 正文已出、思考块已收起（thinking=false）；此时又来 reasoning-delta
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '再想' });
    const msgs = useChat.getState().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'assistant', reasoning: '先想', text: '答案', thinking: false });
    expect(msgs[1]).toMatchObject({ role: 'assistant', reasoning: '再想', thinking: true });
  });

  it('无 reasoning 时 text-delta 仍新建 assistant 项（回归保护）', () => {
    useChat.getState().applyEvent({ type: 'text-delta', text: '直接答' });
    const last = useChat.getState().messages.at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', text: '直接答' });
  });

  it('tool-end 带 output 存进对应卡片', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'take_snapshot', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'take_snapshot', callId: 'c1', ok: true, summary: '成功', output: '[1] button 全文' });
    const tool = useChat.getState().messages.find((m) => m.callId === 'c1')!;
    expect(tool).toMatchObject({ status: 'done', ok: true, output: '[1] button 全文' });
  });

  it('tool-end 带 image 时存进卡片', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'take_screenshot', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'take_screenshot', callId: 'c1', ok: true, summary: '已截图', image: 'data:image/jpeg;base64,ZZZ' });
    const card = useChat.getState().messages.find((m) => m.role === 'tool' && m.callId === 'c1');
    expect(card).toMatchObject({ status: 'done', image: 'data:image/jpeg;base64,ZZZ' });
  });

  it('toggleExpand 切换指定项 expanded', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{}', callId: 'c1' });
    useChat.getState().toggleExpand(0);
    expect(useChat.getState().messages[0]!.expanded).toBe(true);
    useChat.getState().toggleExpand(0);
    expect(useChat.getState().messages[0]!.expanded).toBe(false);
  });

  it('loadFromStorage 映射历史（含 reasoning + 工具卡片）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '看页面' },
      { role: 'assistant', content: '', reasoning: '要先截图', toolCalls: [{ id: 'c1', name: 'take_snapshot', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'take_snapshot', content: '[1] button' },
      { role: 'assistant', content: '看到了一个按钮', reasoning: '分析完毕' },
    ];
    useChat.getState().loadFromStorage(history);
    const items = useChat.getState().messages;
    expect(items[0]).toMatchObject({ role: 'user', text: '看页面' });
    expect(items.find((m) => m.reasoning === '要先截图')).toBeTruthy();
    const toolItem = items.find((m) => m.callId === 'c1')!;
    expect(toolItem).toMatchObject({ role: 'tool', name: 'take_snapshot', status: 'done', ok: true, output: '[1] button' });
    const finalAsst = items.at(-1)!;
    expect(finalAsst).toMatchObject({ role: 'assistant', text: '看到了一个按钮', reasoning: '分析完毕', thinking: false });
  });

  it('loadFromStorage 里失败的 tool 消息标记 ok=false', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'click', arguments: '{"uid":9}' }] },
      { role: 'tool', toolCallId: 'c9', name: 'click', content: '错误：stale uid' },
    ];
    useChat.getState().loadFromStorage(history);
    const toolItem = useChat.getState().messages.find((m) => m.callId === 'c9')!;
    expect(toolItem.ok).toBe(false);
  });

  it('loadFromStorage：注入的截图 user 消息回挂到 take_screenshot 卡片，不产生幽灵气泡', () => {
    const stored = [
      { role: 'user', content: '截个图' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'take_screenshot', arguments: '{}' }] },
      { role: 'tool', toolCallId: 't1', name: 'take_screenshot', content: '截图已捕获，见下一条消息' },
      { role: 'user', content: [{ type: 'text', text: '（take_screenshot 返回的页面截图）' }, { type: 'image_url', imageUrl: 'data:image/jpeg;base64,ZZZ' }] },
    ] as unknown as ChatMessage[];
    useChat.getState().loadFromStorage(stored);
    const items = useChat.getState().messages;
    // 截图卡片回挂了 image
    const shot = items.find((m) => m.role === 'tool' && m.name === 'take_screenshot');
    expect(shot?.image).toBe('data:image/jpeg;base64,ZZZ');
    // 没有把注入截图消息渲染成 user 气泡（user 气泡只有最初那条"截个图"）
    const userBubbles = items.filter((m) => m.role === 'user');
    expect(userBubbles).toHaveLength(1);
    expect(userBubbles[0]!.text).toBe('截个图');
  });

  it('思考后直接调用工具（无正文）时思考块收起，不残留"思考中"', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '要看页面' });
    useChat.getState().applyEvent({ type: 'tool-start', name: 'take_snapshot', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'take_snapshot', callId: 'c1', ok: true, summary: '成功', output: '[1] btn' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '看到了' });
    useChat.getState().applyEvent({ type: 'done', finalText: '看到了' });
    const msgs = useChat.getState().messages;
    const reasoningItem = msgs.find((m) => m.reasoning === '要看页面')!;
    expect(reasoningItem.thinking).toBe(false);
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', text: '看到了' });
  });

  it('done 收起仍在思考中的尾部助手项（思考后无正文直接结束）', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '想' });
    useChat.getState().applyEvent({ type: 'done', finalText: '' });
    expect(useChat.getState().messages.at(-1)).toMatchObject({ role: 'assistant', reasoning: '想', thinking: false });
  });
});

describe('chat store 新分支', () => {
  beforeEach(() => useChat.getState().reset());

  it('usage 事件：更新 promptTokens 且挂到最后一条 assistant 项', () => {
    const s = useChat.getState();
    s.applyEvent({ type: 'text-delta', text: '回答' });
    s.applyEvent({ type: 'usage', promptTokens: 8000, completionTokens: 120 });
    const st = useChat.getState();
    expect(st.promptTokens).toBe(8000);
    const last = st.messages[st.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.usage).toEqual({ prompt: 8000, completion: 120 });
  });

  it('compact-start / compact-done 切换 compacting 并回落 promptTokens', () => {
    const s = useChat.getState();
    s.applyEvent({ type: 'usage', promptTokens: 100000 });
    s.applyEvent({ type: 'compact-start' });
    expect(useChat.getState().compacting).toBe(true);
    s.applyEvent({ type: 'compact-done', newPromptTokens: 3000 });
    const st = useChat.getState();
    expect(st.compacting).toBe(false);
    expect(st.promptTokens).toBe(3000);
  });

  it('compact-done 无 newPromptTokens 时只关 compacting，不动 promptTokens', () => {
    const s = useChat.getState();
    s.applyEvent({ type: 'usage', promptTokens: 100000 });
    s.applyEvent({ type: 'compact-start' });
    s.applyEvent({ type: 'compact-done' });
    const st = useChat.getState();
    expect(st.compacting).toBe(false);
    expect(st.promptTokens).toBe(100000);
  });

  it('reset 清空 promptTokens/compacting', () => {
    const s = useChat.getState();
    s.applyEvent({ type: 'usage', promptTokens: 5000 });
    s.applyEvent({ type: 'compact-start' });
    s.reset();
    const st = useChat.getState();
    expect(st.promptTokens).toBeUndefined();
    expect(st.compacting).toBe(false);
    expect(st.messages).toEqual([]);
  });

  it('usage 无 assistant 项时不崩，仅更新 promptTokens', () => {
    useChat.getState().applyEvent({ type: 'usage', promptTokens: 500, completionTokens: 10 });
    expect(useChat.getState().promptTokens).toBe(500);
    expect(useChat.getState().messages).toEqual([]);
  });
});
