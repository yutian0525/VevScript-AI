import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import { getConversation } from '../../storage/conversations';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';
import type { ToolResult } from '../../shared/types';

function queuedProvider(scripts: StreamEvent[][]): Provider {
  let i = 0;
  return {
    streamChat(_p: ChatParams, onEvent: (e: StreamEvent) => void) {
      const script = scripts[i++] ?? [{ type: 'message-done', finishReason: 'stop' }];
      queueMicrotask(() => { for (const e of script) onEvent(e); });
      return { cancel: vi.fn() };
    },
  };
}

const deps = (provider: Provider, exec: LoopDeps['executeTool'], extra?: Partial<LoopDeps>): LoopDeps => ({
  provider,
  executeTool: exec,
  getPageInfo: async () => ({ url: 'https://x.com', title: 'X' }),
  emit: vi.fn(),
  ...extra,
});

describe('agent loop', () => {
  beforeEach(() => fakeBrowser.reset());

  it('无 tool_calls 时一轮即自然终止，保存最终回复', async () => {
    const provider = queuedProvider([[{ type: 'text-delta', text: '完成了' }, { type: 'message-done', finishReason: 'stop' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 'c1', tabId: 1, userMessage: '你好' }, deps(provider, exec));
    const conv = await getConversation('c1');
    expect(exec).not.toHaveBeenCalled();
    const last = conv.messages[conv.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('完成了');
    expect(conv.status).toBe('idle');
  });

  it('外部 signal 已 abort → 不调 provider，立即 idle + emit done', async () => {
    const stream = vi.fn();
    const provider: Provider = { streamChat: stream };
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    const ac = new AbortController();
    ac.abort();
    await runAgentLoop({ convId: 'c40', tabId: 40, userMessage: 'x' }, d, ac.signal);
    expect(stream).not.toHaveBeenCalled();
    expect((await getConversation('c40')).status).toBe('idle');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('运行中 abort（流式输出后）→ 保留已输出助手文本，不进工具执行，emit done', async () => {
    const ac = new AbortController();
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => {
          onEvent({ type: 'text-delta', text: '我正在处理' });
          ac.abort();
          onEvent({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":1}' });
          onEvent({ type: 'message-done', finishReason: 'tool_calls' });
        });
        return { cancel: vi.fn() };
      },
    };
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c41', tabId: 41, userMessage: 'x' }, d, ac.signal);
    const conv = await getConversation('c41');
    expect(exec).not.toHaveBeenCalled();
    const asst = conv.messages.find((m) => m.role === 'assistant');
    expect(asst?.content).toBe('我正在处理');
    expect(conv.status).toBe('idle');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('纯文本被 length 截断时回复带截断提示', async () => {
    const provider = queuedProvider([[{ type: 'text-delta', text: '半截回复' }, { type: 'message-done', finishReason: 'length' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 'c8', tabId: 8, userMessage: 'x' }, deps(provider, exec));
    const conv = await getConversation('c8');
    const last = conv.messages[conv.messages.length - 1]!;
    expect(String(last.content)).toContain('半截回复');
    expect(String(last.content)).toContain('截断');
    expect(conv.status).toBe('idle');
  });

  it('一轮工具调用后再自然终止', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { text: '[1] button' } } as ToolResult);
    await runAgentLoop({ convId: 'c2', tabId: 2, userMessage: '看页面' }, deps(provider, exec));
    expect(exec).toHaveBeenCalledOnce();
    const conv = await getConversation('c2');
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('工具错误作为 tool result 喂回，不中断', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":9}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '换个方法' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: false, error: 'stale' });
    await runAgentLoop({ convId: 'c3', tabId: 3, userMessage: 'x' }, deps(provider, exec));
    const conv = await getConversation('c3');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('stale');
  });

  it('工具失败但带 data 时，data 进 tool 消息（错误前置 + 换行接诊断详情）', async () => {
    // 个别工具的失败诊断（kind/hint 等）在 data 里——失败分支丢 data 的话诊断到不了模型。
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'wait_for', argsDelta: '{"idle":500}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看了诊断' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({
      ok: false, error: '定位失败', data: { kind: 'locator-miss', hint: '改定位符' },
    } as ToolResult);
    await runAgentLoop({ convId: 'c-data', tabId: 1, userMessage: 'x' }, deps(provider, exec));
    const conv = await getConversation('c-data');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    const content = String(toolMsg.content);
    expect(content.startsWith('错误：定位失败\n')).toBe(true);
    expect(content).toContain('"kind":"locator-miss"');
    expect(content).toContain('"hint":"改定位符"');
  });

  it('工具失败且无 data 时，tool 消息只有错误文本（旧行为不变）', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":9}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '换个方法' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: false, error: '受限页面' });
    await runAgentLoop({ convId: 'c-nodata', tabId: 1, userMessage: 'x' }, deps(provider, exec));
    const conv = await getConversation('c-nodata');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toBe('错误：受限页面');
  });

  it('length 截断时该轮 tool_calls 判失败喂回', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":' }, { type: 'message-done', finishReason: 'length' }],
      [{ type: 'text-delta', text: '重试' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 'c4', tabId: 4, userMessage: 'x' }, deps(provider, exec));
    expect(exec).not.toHaveBeenCalled();
    const conv = await getConversation('c4');
    expect(conv.messages.some((m) => m.role === 'tool' && String(m.content).includes('截断'))).toBe(true);
  });

  it('finishReason=length + toolCalls → tool 消息含分步指引（教学式纠正）', async () => {
    const provider = queuedProvider([[
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'create_script', argsDelta: '{"source":"//截断' },
      { type: 'message-done', finishReason: 'length' },
    ], [
      { type: 'text-delta', text: '改用分步' },
      { type: 'message-done', finishReason: 'stop' },
    ]]);
    await runAgentLoop({ convId: 'clen', tabId: 1, userMessage: 'x' }, deps(provider, vi.fn()));
    const conv = await getConversation('clen');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('截断');
    expect(toolMsg.content).toContain('append');
    expect(toolMsg.content).toContain('骨架');
  });

  it('provider error 事件终止并保存错误', async () => {
    const provider = queuedProvider([[{ type: 'error', error: 'HTTP 401' }, { type: 'message-done' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c5', tabId: 5, userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('连续 length 截断触发熔断暂停（不无限循环）', async () => {
    const lengthTurn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'click', argsDelta: '{"uid":' },
      { type: 'message-done', finishReason: 'length' },
    ];
    const provider = queuedProvider(Array.from({ length: 60 }, () => lengthTurn()));
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c7', tabId: 7, userMessage: 'x' }, d);
    const conv = await getConversation('c7');
    expect(conv.status).toBe('paused');
    expect(exec).not.toHaveBeenCalled();
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'paused' }));
  });

  it('打转触发暂停（status=paused）', async () => {
    const turn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'scroll', argsDelta: '{"direction":"down"}' },
      { type: 'message-done', finishReason: 'tool_calls' },
    ];
    const provider = queuedProvider([turn(), turn(), turn(), turn(), turn()]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true });
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c6', tabId: 6, userMessage: 'x' }, d);
    expect((await getConversation('c6')).status).toBe('paused');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'paused' }));
  });

  it('reasoning-delta 转发到 Port，且 reasoning 存进 assistant 消息', async () => {
    const provider = queuedProvider([[
      { type: 'reasoning-delta', text: '先想想' },
      { type: 'text-delta', text: '好的' },
      { type: 'message-done', finishReason: 'stop' },
    ]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c10', tabId: 10, userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith({ type: 'reasoning-delta', text: '先想想' });
    const conv = await getConversation('c10');
    const last = conv.messages[conv.messages.length - 1]!;
    expect(last.reasoning).toBe('先想想');
    expect(last.content).toBe('好的');
  });

  it('工具分支 assistant 消息也带 reasoning；tool-end 带完整 output', async () => {
    const provider = queuedProvider([
      [{ type: 'reasoning-delta', text: '需要看页面' }, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: '[1] button 完整快照文本' } as ToolResult);
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c11', tabId: 11, userMessage: 'x' }, d);
    const conv = await getConversation('c11');
    const asst = conv.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length)!;
    expect(asst.reasoning).toBe('需要看页面');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', callId: 'c1', ok: true, output: '[1] button 完整快照文本' }));
  });

  it('new_page 后 targetTab 更新，后续工具作用于新标签', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'new_page', argsDelta: '{"url":"https://n.com"}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call-delta', index: 0, id: 'c2', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '完成' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const calls: number[] = [];
    const exec = vi.fn<LoopDeps['executeTool']>().mockImplementation(async (name, _args, tabId) => {
      calls.push(tabId);
      if (name === 'new_page') return { ok: true, data: { targetTab: 555, url: 'https://n.com' } };
      return { ok: true, data: { text: 'snap' } };
    });
    await runAgentLoop({ convId: 'c-np', tabId: 10, userMessage: 'x' }, deps(provider, exec));
    expect(calls[0]).toBe(10);
    expect(calls[1]).toBe(555);
  });

  it('close_page 关掉 targetTab 后回落启动标签', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'select_page', argsDelta: '{"tabId":777}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call-delta', index: 0, id: 'c2', name: 'close_page', argsDelta: '{"tabId":777}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call-delta', index: 0, id: 'c3', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: 'ok' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const calls: number[] = [];
    const exec = vi.fn<LoopDeps['executeTool']>().mockImplementation(async (name, _args, tabId) => {
      calls.push(tabId);
      if (name === 'select_page') return { ok: true, data: { targetTab: 777, url: 'https://s.com' } };
      if (name === 'close_page') return { ok: true, data: { closed: 777 } };
      return { ok: true, data: { text: 'snap' } };
    });
    await runAgentLoop({ convId: 'c-cp', tabId: 20, userMessage: 'x' }, deps(provider, exec));
    expect(calls[2]).toBe(20);
  });

  it('click 打开新标签后 targetTab 跟随', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":3}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call-delta', index: 0, id: 'c2', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '完成' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const calls: number[] = [];
    const exec = vi.fn<LoopDeps['executeTool']>().mockImplementation(async (_n, _a, tabId) => { calls.push(tabId); return { ok: true, data: { text: 'snap' } }; });
    const resolveOpenedTab = vi.fn<NonNullable<LoopDeps['resolveOpenedTab']>>().mockImplementation(async (name) => (name === 'click' ? 888 : undefined));
    await runAgentLoop({ convId: 'c-ck', tabId: 50, userMessage: 'x' }, deps(provider, exec, { resolveOpenedTab }));
    expect(calls[0]).toBe(50);
    expect(calls[1]).toBe(888);
    expect(resolveOpenedTab).toHaveBeenCalledWith('click', 50, expect.any(AbortSignal));
  });

  it('take_screenshot 成功后注入 user 图片消息 + emit 带缩略图', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_screenshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { screenshot: 'data:image/jpeg;base64,ZZZ' } });
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c30', tabId: 30, userMessage: 'x' }, d);
    const conv = await getConversation('c30');
    const userImg = conv.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    const parts = userImg!.content as Array<{ type: string; imageUrl?: string }>;
    expect(parts.some((p) => p.type === 'image_url' && p.imageUrl === 'data:image/jpeg;base64,ZZZ')).toBe(true);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', image: 'data:image/jpeg;base64,ZZZ' }));
  });

  it('工具失败 data 里的 screenshot 也走图片通道（base64 永不进文本上下文）', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'wait_for', argsDelta: '{"idle":500}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看了诊断' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({
      ok: false, error: '等待超时', data: { kind: 'timeout', hint: '改条件', screenshot: 'data:image/jpeg;base64,EEE' },
    } as ToolResult);
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c-rps-fail', tabId: 1, userMessage: 'x' }, d);
    const conv = await getConversation('c-rps-fail');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    const content = String(toolMsg.content);
    // 错误 + 诊断详情保留，base64 绝不进文本通道
    expect(content.startsWith('错误：等待超时')).toBe(true);
    expect(content).toContain('"kind":"timeout"');
    expect(content).toContain('"hint":"改条件"');
    expect(content).not.toContain('data:image');
    const userImg = conv.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    const parts = userImg!.content as Array<{ type: string; imageUrl?: string }>;
    expect(parts.some((p) => p.type === 'image_url' && p.imageUrl === 'data:image/jpeg;base64,EEE')).toBe(true);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', name: 'wait_for', ok: false, image: 'data:image/jpeg;base64,EEE' }));
  });

  it('usage：provider 返回 promptTokens → emit usage 且存入 lastPromptTokens', async () => {
    const provider = queuedProvider([[
      { type: 'text-delta', text: 'ok' },
      { type: 'message-done', finishReason: 'stop', usage: { promptTokens: 12345, completionTokens: 67 } },
    ]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c-usage', tabId: 1, userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'usage', promptTokens: 12345, completionTokens: 67 }));
    expect((await getConversation('c-usage')).lastPromptTokens).toBe(12345);
  });

  it('自动压缩：上一轮 promptTokens 超 80% 窗口 → 下一轮前调 compact', async () => {
    // 第一轮请求工具（带高 usage），第二轮自然终止
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls', usage: { promptTokens: 120000 } }],
      [{ type: 'text-delta', text: '完成' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { text: 'snap' } } as ToolResult);
    const compact = vi.fn<NonNullable<LoopDeps['compact']>>().mockResolvedValue({ ok: true, newPromptTokens: 3000 });
    const getContextWindow = vi.fn<NonNullable<LoopDeps['getContextWindow']>>().mockResolvedValue(128000);
    const d = deps(provider, exec, { compact, getContextWindow });
    await runAgentLoop({ convId: 'c-auto', tabId: 1, userMessage: 'x' }, d);
    expect(compact).toHaveBeenCalledWith('c-auto');
    expect(d.emit).toHaveBeenCalledWith({ type: 'compact-start' });
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'compact-done', newPromptTokens: 3000 }));
  });

  it('未超阈值时不自动压缩', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls', usage: { promptTokens: 1000 } }],
      [{ type: 'text-delta', text: '完成' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { text: 'snap' } } as ToolResult);
    const compact = vi.fn<NonNullable<LoopDeps['compact']>>().mockResolvedValue({ ok: true, newPromptTokens: 1 });
    const getContextWindow = vi.fn<NonNullable<LoopDeps['getContextWindow']>>().mockResolvedValue(128000);
    await runAgentLoop({ convId: 'c-noauto', tabId: 1, userMessage: 'x' }, deps(provider, exec, { compact, getContextWindow }));
    expect(compact).not.toHaveBeenCalled();
  });

  it('mode: getMode 每轮重读——中途切换下一轮工具清单收窄', async () => {
    let mode: 'ask' | 'agent' = 'agent';
    const seenTools: Array<Array<string>> = [];
    const provider: Provider = {
      streamChat(p, onEvent) {
        seenTools.push(p.tools.map((t) => t.function.name));
        queueMicrotask(() => {
          if (p.tools.some((t) => t.function.name === 'click')) {
            onEvent({ type: 'tool-call-delta', index: 0, id: `c${seenTools.length}`, name: 'click', argsDelta: '{"uid":1}' });
            onEvent({ type: 'message-done', finishReason: 'tool_calls' });
          } else {
            // ask 模式下没有 click 可用 → 模型改用快照后结束
            onEvent({ type: 'tool-call-delta', index: 0, id: `c${seenTools.length}`, name: 'take_snapshot', argsDelta: '{}' });
            onEvent({ type: 'message-done', finishReason: 'tool_calls' });
          }
        });
        return { cancel: vi.fn() };
      },
    };
    const exec = vi.fn<LoopDeps['executeTool']>().mockImplementation(async (_name, _args, _tabId, signal) => {
      void signal;
      // 第一次工具执行完就切 ask：下一轮 getMode 返回 ask
      mode = 'ask';
      return { ok: true, data: { text: 'ok' } } as ToolResult;
    });
    const d = deps(provider, exec, { getMode: async () => mode });
    await runAgentLoop({ convId: 'c-mode', tabId: 1, userMessage: 'x' }, d);
    // 第 1 轮全量；第 2 轮 ask 收窄（无 click）；第 3 轮 take_snapshot 仍在但 click 不在
    expect(seenTools[0]).toContain('click');
    expect(seenTools[1]).not.toContain('click');
    expect(seenTools[1]).toContain('take_snapshot');
  });

  it('getMaxTokens 提供时透传给 provider 的 ChatParams.maxTokens', async () => {
    const seen: Array<number | undefined> = [];
    const provider: Provider = {
      streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
        seen.push(p.maxTokens);
        queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop({ convId: 'cmt', tabId: 1, userMessage: 'x' },
      deps(provider, vi.fn(), { getMaxTokens: async () => 4096 }));
    expect(seen).toEqual([4096]);
  });

  it('getMaxTokens 返回 0 → 不下发（maxTokens 为 undefined）', async () => {
    const seen: Array<number | undefined> = [];
    const provider: Provider = {
      streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
        seen.push(p.maxTokens);
        queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop({ convId: 'cmt0', tabId: 1, userMessage: 'x' },
      deps(provider, vi.fn(), { getMaxTokens: async () => 0 }));
    expect(seen).toEqual([undefined]);
  });

  it('tool-args-delta：节流后 emit（首次立即 + 每 1KB）', async () => {
    const big = 'x'.repeat(1200);
    const provider: Provider = {
      streamChat(_p: ChatParams, onEvent: (e: StreamEvent) => void) {
        queueMicrotask(() => {
          onEvent({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'create_script', argsDelta: '{}' });
          onEvent({ type: 'tool-call-delta', index: 0, argsDelta: big });
          onEvent({ type: 'message-done', finishReason: 'stop' });
        });
        return { cancel: vi.fn() };
      },
    };
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { text: 'snap' } } as ToolResult);
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'cad', tabId: 1, userMessage: 'x' }, d);
    const calls = vi.mocked(d.emit).mock.calls.map(([e]) => e).filter((e) => e.type === 'tool-args-delta');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toMatchObject({ type: 'tool-args-delta', name: 'create_script', bytes: 2 });
    expect(calls[calls.length - 1]).toMatchObject({ name: 'create_script', bytes: 1202 });
  });

  // ---- 三级确认闸门（spec §6）----

  const toolScript = (name: string, args: string): StreamEvent[][] => [[
    { type: 'tool-call-delta', index: 0, id: 'tc1', name, argsDelta: args },
    { type: 'message-done', finishReason: 'tool_calls' },
  ]];

  it('敏感工具先 emit tool-confirm，allow 后才 tool-start 并执行', async () => {
    const provider = queuedProvider([
      ...toolScript('evaluate_script', '{"function":"1+1"}'),
      [{ type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: {} } as ToolResult);
    const confirmToolCall = vi.fn().mockResolvedValue('allow');
    const d = deps(provider, exec, { confirmToolCall, getConfirmLevel: async () => 'sensitive' });
    await runAgentLoop({ convId: 'cf1', tabId: 1, userMessage: 'x' }, d);
    expect(confirmToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'tc1', name: 'evaluate_script' }),
      expect.any(AbortSignal),
    );
    const order = vi.mocked(d.emit).mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(order).toContain('tool-confirm');
    expect(order.indexOf('tool-confirm')).toBeLessThan(order.indexOf('tool-start'));
    expect(exec).toHaveBeenCalledOnce();
  });

  it('deny：不执行工具，tool 消息告知模型被拒，拒绝计入结果（熔断阀可见失败）', async () => {
    const provider = queuedProvider([
      ...toolScript('evaluate_script', '{}'),
      [{ type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    const d = deps(provider, exec, {
      confirmToolCall: async () => 'deny',
      getConfirmLevel: async () => 'sensitive',
    });
    await runAgentLoop({ convId: 'cf2', tabId: 2, userMessage: 'x' }, d);
    expect(exec).not.toHaveBeenCalled();
    const conv = await getConversation('cf2');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('拒绝');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', ok: false, summary: '已拒绝' }));
    expect(conv.status).toBe('idle'); // 循环继续到自然终止
  });

  it('timeout：文案不同（超时未确认）', async () => {
    const provider = queuedProvider([
      ...toolScript('http_request', '{}'),
      [{ type: 'message-done', finishReason: 'stop' }],
    ]);
    const d = deps(provider, vi.fn<LoopDeps['executeTool']>(), {
      confirmToolCall: async () => 'timeout',
      getConfirmLevel: async () => 'sensitive',
    });
    await runAgentLoop({ convId: 'cf3', tabId: 3, userMessage: 'x' }, d);
    const conv = await getConversation('cf3');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('超时');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', ok: false, summary: '确认超时' }));
  });

  it('allow-session：同工具第二发不再询问', async () => {
    const provider = queuedProvider([
      ...toolScript('evaluate_script', '{"n":1}'),
      ...toolScript('evaluate_script', '{"n":2}'),
      [{ type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    const d = deps(provider, exec, {
      confirmToolCall: async () => 'allow-session',
      getConfirmLevel: async () => 'sensitive',
    });
    await runAgentLoop({ convId: 'cf4', tabId: 4, userMessage: 'x' }, d);
    expect(vi.mocked(d.emit).mock.calls.filter((c) => (c[0] as { type: string }).type === 'tool-confirm')).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('sensitive 档微操不询问；all 档微操要问；confirmToolCall 缺省完全不问', async () => {
    // sensitive + click → 直接执行
    const p1 = queuedProvider([...toolScript('click', '{}'), [{ type: 'message-done', finishReason: 'stop' }]]);
    const confirmToolCall = vi.fn().mockResolvedValue('allow');
    const exec1 = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 'cf5', tabId: 5, userMessage: 'x' }, deps(p1, exec1, { confirmToolCall, getConfirmLevel: async () => 'sensitive' }));
    expect(confirmToolCall).not.toHaveBeenCalled();
    expect(exec1).toHaveBeenCalledOnce();
    // all + click → 要问
    const p2 = queuedProvider([...toolScript('click', '{}'), [{ type: 'message-done', finishReason: 'stop' }]]);
    const confirmToolCall2 = vi.fn().mockResolvedValue('allow');
    const exec2 = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 'cf6', tabId: 6, userMessage: 'x' }, deps(p2, exec2, { confirmToolCall: confirmToolCall2, getConfirmLevel: async () => 'all' }));
    expect(confirmToolCall2).toHaveBeenCalledOnce();
    // 旧行为：无 confirmToolCall 时不问
    const p3 = queuedProvider([...toolScript('evaluate_script', '{}'), [{ type: 'message-done', finishReason: 'stop' }]]);
    const exec3 = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 'cf7', tabId: 7, userMessage: 'x' }, deps(p3, exec3));
    expect(exec3).toHaveBeenCalledOnce();
  });

  it('confirm 等待中 abort → 拒绝落卡，loop 干净退出', async () => {
    const ac = new AbortController();
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => { for (const e of toolScript('evaluate_script', '{}')[0]!) onEvent(e); });
        return { cancel: vi.fn() };
      },
    };
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    const d = deps(provider, exec, {
      confirmToolCall: async (_req, sig) => { ac.abort(); await 0; return sig.aborted ? 'deny' : 'allow'; },
      getConfirmLevel: async () => 'sensitive',
    });
    await runAgentLoop({ convId: 'cf8', tabId: 8, userMessage: 'x' }, d, ac.signal);
    expect(exec).not.toHaveBeenCalled();
    expect((await getConversation('cf8')).status).toBe('idle');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });
});

describe('loop 注入自定义系统提示词', () => {
  beforeEach(() => fakeBrowser.reset());

  it('deps.getSystemPrompt 的返回值进 system 消息，每轮重读', async () => {
    const captured: ChatParams[] = [];
    const provider: Provider = {
      streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
        captured.push(p);
        queueMicrotask(() => onEvent({ type: 'text-delta', text: 'ok' }));
        queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop(
      { convId: 'c1', tabId: 1, userMessage: 'hi' },
      {
        provider,
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
        getSystemPrompt: async () => '【自定义】听我的',
      },
    );
    const sys = String(captured[0]!.messages[0]!.content);
    expect(sys).toContain('【自定义】听我的');
    expect(sys).not.toContain('你是「织雀AI脚本」');
  });

  it('不提供 getSystemPrompt → 用内置全文', async () => {
    const captured: ChatParams[] = [];
    const provider: Provider = {
      streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
        captured.push(p);
        queueMicrotask(() => onEvent({ type: 'text-delta', text: 'ok' }));
        queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop(
      { convId: 'c2', tabId: 1, userMessage: 'hi' },
      {
        provider,
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).toContain('你是「织雀AI脚本」');
  });
});

describe('loop 注入记忆', () => {
  beforeEach(() => fakeBrowser.reset());

  const capture = (captured: ChatParams[]): Provider => ({
    streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
      captured.push(p);
      queueMicrotask(() => onEvent({ type: 'text-delta', text: 'ok' }));
      queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
      return { cancel: vi.fn() };
    },
  });

  it('getMemoryState 的条目进末条易变块，且三个记忆工具在工具清单里', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'cm1', tabId: 1, userMessage: 'hi' },
      {
        provider: capture(captured),
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
        getMemoryState: async () => ({
          enabled: true, writable: true,
          entries: [{ id: 'g1', content: '偏好中文回复', matches: [], updatedAt: 1 }],
        }),
      },
    );
    const last = String(captured[0]!.messages[captured[0]!.messages.length - 1]!.content);
    expect(last).toContain('偏好中文回复');
    const names = (captured[0]!.tools ?? []).map((t) => t.function.name);
    expect(names).toContain('memory_write');
  });

  it('enabled:false → 无记忆块且不下发记忆工具', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'cm2', tabId: 1, userMessage: 'hi' },
      {
        provider: capture(captured),
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
        getMemoryState: async () => ({ enabled: false, writable: false, entries: [] }),
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).not.toContain('## 记忆');
    const names = (captured[0]!.tools ?? []).map((t) => t.function.name);
    expect(names).not.toContain('memory_list');
  });

  it('writable:false → 有记忆块但只下发 memory_list', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'cm3', tabId: 1, userMessage: 'hi' },
      {
        provider: capture(captured),
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
        getMemoryState: async () => ({
          enabled: true, writable: false,
          entries: [{ id: 'g1', content: '人工维护的记忆', matches: [], updatedAt: 1 }],
        }),
      },
    );
    const last = String(captured[0]!.messages[captured[0]!.messages.length - 1]!.content);
    expect(last).toContain('人工维护的记忆');
    const names = (captured[0]!.tools ?? []).map((t) => t.function.name);
    expect(names).toContain('memory_list');
    expect(names).not.toContain('memory_write');
  });

  it('不提供 getMemoryState → 无记忆块，工具清单仍含记忆工具（默认 full）', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'cm4', tabId: 1, userMessage: 'hi' },
      {
        provider: capture(captured),
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).not.toContain('## 记忆');
    expect((captured[0]!.tools ?? []).map((t) => t.function.name)).toContain('memory_list');
  });
});
