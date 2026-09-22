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

  it('loadFromStorage：拒绝落库文案（错误：前缀）渲染成失败而非成功', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'click', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'click', content: '错误：用户拒绝了该操作（click）。不要原样重试；向用户说明情况或提出替代方案。' },
    ];
    useChat.getState().loadFromStorage(history);
    const toolItem = useChat.getState().messages.find((m) => m.callId === 'c1')!;
    expect(toolItem).toMatchObject({ status: 'done', ok: false, summary: '失败' });
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

describe('chat store：输入框附件', () => {
  beforeEach(() => useChat.getState().reset());

  it('addUserMessage 带附件 → 挂到 user 项', () => {
    useChat.getState().addUserMessage('看这个', [{ kind: 'text', name: 'a.md', size: 3, text: 'abc' }]);
    const msg = useChat.getState().messages.at(-1)!;
    expect(msg).toMatchObject({ role: 'user', text: '看这个' });
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]).toMatchObject({ kind: 'text', name: 'a.md' });
  });

  it('addUserMessage 空附件数组不挂 attachments 字段', () => {
    useChat.getState().addUserMessage('你好', []);
    expect(useChat.getState().messages.at(-1)!.attachments).toBeUndefined();
  });

  it('loadFromStorage：用户上传图片消息渲染成 user 气泡（不被当截图回挂）', () => {
    const stored = [
      { role: 'user', content: [{ type: 'text', text: '这是我的图' }, { type: 'image_url', imageUrl: 'data:image/png;base64,I' }] },
    ] as unknown as ChatMessage[];
    useChat.getState().loadFromStorage(stored);
    const items = useChat.getState().messages;
    const userBubbles = items.filter((m) => m.role === 'user');
    expect(userBubbles).toHaveLength(1);
    expect(userBubbles[0]).toMatchObject({ text: '这是我的图' });
    expect(userBubbles[0]!.attachments![0]).toMatchObject({ kind: 'image', dataUrl: 'data:image/png;base64,I' });
  });

  it('loadFromStorage：文本附件消息还原出附件列表', () => {
    const stored = [
      { role: 'user', content: [{ type: 'text', text: '看代码' }, { type: 'text', text: '[附件文件：x.ts]\nconst a = 1' }] },
    ] as unknown as ChatMessage[];
    useChat.getState().loadFromStorage(stored);
    const u = useChat.getState().messages.find((m) => m.role === 'user')!;
    expect(u.text).toBe('看代码');
    expect(u.attachments![0]).toMatchObject({ kind: 'text', name: 'x.ts', text: 'const a = 1' });
  });

  it('loadFromStorage：截图注入仍回挂工具卡片（不受附件解析影响）', () => {
    const stored = [
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'take_screenshot', arguments: '{}' }] },
      { role: 'tool', toolCallId: 't1', name: 'take_screenshot', content: '截图已捕获，见下一条消息' },
      { role: 'user', content: [{ type: 'text', text: '（take_screenshot 返回的页面截图）' }, { type: 'image_url', imageUrl: 'data:image/jpeg;base64,ZZZ' }] },
    ] as unknown as ChatMessage[];
    useChat.getState().loadFromStorage(stored);
    const items = useChat.getState().messages;
    expect(items.find((m) => m.role === 'tool' && m.name === 'take_screenshot')!.image).toBe('data:image/jpeg;base64,ZZZ');
    expect(items.filter((m) => m.role === 'user')).toHaveLength(0);
  });
});

describe('chat store：行为模式', () => {
  beforeEach(() => useChat.getState().reset());

  it('默认 agent；setMode 即时改', () => {
    expect(useChat.getState().mode).toBe('agent');
    useChat.getState().setMode('ask');
    expect(useChat.getState().mode).toBe('ask');
  });

  it('mode 事件更新 mode', () => {
    useChat.getState().applyEvent({ type: 'mode', mode: 'ask' });
    expect(useChat.getState().mode).toBe('ask');
  });

  it('reset 回落 agent', () => {
    useChat.getState().setMode('ask');
    useChat.getState().reset();
    expect(useChat.getState().mode).toBe('agent');
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

describe('chat store：重挂载后接住流式尾巴', () => {
  beforeEach(() => useChat.getState().reset());

  it('历史 assistant 项被封存：补发的增量另起一条，不追加到历史尾巴上', () => {
    useChat.getState().loadFromStorage([{ role: 'assistant', content: '上一轮的结论' }]);
    useChat.getState().applyEvent({ type: 'text-delta', text: '这一轮' });
    const items = useChat.getState().messages;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ text: '上一轮的结论', sealed: true });
    expect(items[1]).toMatchObject({ role: 'assistant', text: '这一轮' });
  });

  it('封存同样拦 reasoning-delta：不会把新思考塞进历史的思考块', () => {
    useChat.getState().loadFromStorage([{ role: 'assistant', content: '', reasoning: '旧的思考' }]);
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '新的思考' });
    const items = useChat.getState().messages;
    expect(items).toHaveLength(2);
    expect(items[0]!.reasoning).toBe('旧的思考');
    expect(items[1]).toMatchObject({ reasoning: '新的思考', thinking: true });
  });

  it('补发的尾巴按 reasoning → text 顺序回放，合成一条完整 assistant 项', () => {
    useChat.getState().loadFromStorage([{ role: 'user', content: '问题' }]);
    // 后台 replayTail 的输出
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '想到一半' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '说到一半' });
    const items = useChat.getState().messages;
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ role: 'assistant', reasoning: '想到一半', text: '说到一半', thinking: false });
  });

  it('有调用无结果的 toolCall 载入为 running：切标签回来时该工具仍在执行', () => {
    useChat.getState().loadFromStorage([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'take_snapshot', arguments: '{}' }] },
    ]);
    const toolItem = useChat.getState().messages.find((m) => m.callId === 'c1')!;
    expect(toolItem).toMatchObject({ role: 'tool', name: 'take_snapshot', status: 'running' });
    expect(toolItem.ok).toBeUndefined();
  });

  it('running 卡片被随后到达的 tool-end 收口（callId 幂等，不产生第二张卡）', () => {
    useChat.getState().loadFromStorage([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'click', arguments: '{"uid":3}' }] },
    ]);
    useChat.getState().applyEvent({ type: 'tool-end', name: 'click', callId: 'c1', ok: true, summary: '成功', output: 'done' });
    const cards = useChat.getState().messages.filter((m) => m.callId === 'c1');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: 'done', ok: true, output: 'done' });
  });

  it('多个 toolCall 只回来一个结果时，另一个仍是 running', () => {
    useChat.getState().loadFromStorage([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'take_snapshot', arguments: '{}' },
          { id: 'c2', name: 'click', arguments: '{"uid":1}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', name: 'take_snapshot', content: '[1] button' },
    ]);
    const items = useChat.getState().messages;
    expect(items.find((m) => m.callId === 'c1')).toMatchObject({ status: 'done', ok: true });
    expect(items.find((m) => m.callId === 'c2')).toMatchObject({ status: 'running' });
  });
});

describe('chat store：工具确认卡', () => {
  beforeEach(() => useChat.getState().reset());

  it('tool-confirm 建确认卡（confirm 态 + 截止时间戳）', () => {
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c9', name: 'evaluate_script', args: '{"function":"1+1"}', until: 123456 });
    const tool = useChat.getState().messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ name: 'evaluate_script', status: 'confirm', confirmUntil: 123456, args: '{"function":"1+1"}' });
  });

  it('tool-confirm 幂等：翻转既有 running 卡而不建新卡（attach 回放场景）', () => {
    useChat.getState().loadFromStorage([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'click', arguments: '{}' }] },
    ] as ChatMessage[]);
    expect(useChat.getState().messages.find((m) => m.role === 'tool')?.status).toBe('running');
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c1', name: 'click', args: '{}', until: 1 });
    const tools = useChat.getState().messages.filter((m) => m.role === 'tool' && m.callId === 'c1');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('confirm');
  });

  it('tool-confirm 清空 argsProgress 并收起思考块', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '想' });
    useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'x', bytes: 10 });
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c1', name: 'x', args: '{}', until: 1 });
    expect(useChat.getState().argsProgress).toBeUndefined();
    expect(useChat.getState().messages[0]).toMatchObject({ thinking: false });
  });

  it('tool-start 把 confirm 卡翻回 running（用户批准放行）', () => {
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c1', name: 'x', args: '{}', until: 1 });
    useChat.getState().applyEvent({ type: 'tool-start', name: 'x', args: '{}', callId: 'c1' });
    expect(useChat.getState().messages.find((m) => m.role === 'tool')?.status).toBe('running');
  });

  it('tool-end 直接终结 confirm 卡（拒绝/超时路径，中间没有 tool-start）', () => {
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c1', name: 'x', args: '{}', until: 1 });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'x', callId: 'c1', ok: false, summary: '已拒绝' });
    const tool = useChat.getState().messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ status: 'done', ok: false, summary: '已拒绝' });
  });
});
