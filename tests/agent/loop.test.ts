import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import { getSession } from '../../storage/sessions';
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

const deps = (provider: Provider, exec: LoopDeps['executeTool']): LoopDeps => ({
  provider,
  executeTool: exec,
  getPageInfo: async () => ({ url: 'https://x.com', title: 'X' }),
  emit: vi.fn(),
});

describe('agent loop', () => {
  beforeEach(() => fakeBrowser.reset());

  it('无 tool_calls 时一轮即自然终止，保存最终回复', async () => {
    const provider = queuedProvider([[{ type: 'text-delta', text: '完成了' }, { type: 'message-done', finishReason: 'stop' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ tabId: 1, sessionId: 's', userMessage: '你好' }, deps(provider, exec));
    const session = await getSession(1);
    expect(exec).not.toHaveBeenCalled();
    const last = session.messages[session.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('完成了');
    expect(session.status).toBe('idle');
  });

  it('外部 signal 已 abort → 不调 provider，立即 idle + emit done', async () => {
    const stream = vi.fn();
    const provider: Provider = { streamChat: stream };
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    const ac = new AbortController();
    ac.abort();
    await runAgentLoop({ tabId: 40, sessionId: 's', userMessage: 'x' }, d, ac.signal);
    expect(stream).not.toHaveBeenCalled(); // 首个检查点即退出
    expect((await getSession(40)).status).toBe('idle');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('运行中 abort（流式输出后）→ 保留已输出助手文本，不进工具执行，emit done', async () => {
    // provider 第一轮流式输出一段文本 + 请求工具；但期间 signal 被 abort
    const ac = new AbortController();
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => {
          onEvent({ type: 'text-delta', text: '我正在处理' });
          ac.abort(); // 模拟用户在流式途中按停止
          onEvent({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":1}' });
          onEvent({ type: 'message-done', finishReason: 'tool_calls' });
        });
        return { cancel: vi.fn() };
      },
    };
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ tabId: 41, sessionId: 's', userMessage: 'x' }, d, ac.signal);
    const session = await getSession(41);
    expect(exec).not.toHaveBeenCalled(); // abort 后不执行工具
    // 已流式输出的助手文本被保留
    const asst = session.messages.find((m) => m.role === 'assistant');
    expect(asst?.content).toBe('我正在处理');
    expect(session.status).toBe('idle');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('纯文本被 length 截断时回复带截断提示', async () => {
    const provider = queuedProvider([[{ type: 'text-delta', text: '半截回复' }, { type: 'message-done', finishReason: 'length' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ tabId: 8, sessionId: 's', userMessage: 'x' }, deps(provider, exec));
    const session = await getSession(8);
    const last = session.messages[session.messages.length - 1]!;
    expect(String(last.content)).toContain('半截回复');
    expect(String(last.content)).toContain('截断');
    expect(session.status).toBe('idle');
  });

  it('一轮工具调用后再自然终止', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { text: '[1] button' } } as ToolResult);
    await runAgentLoop({ tabId: 2, sessionId: 's', userMessage: '看页面' }, deps(provider, exec));
    expect(exec).toHaveBeenCalledOnce();
    const session = await getSession(2);
    const roles = session.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('工具错误作为 tool result 喂回，不中断', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":9}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '换个方法' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: false, error: 'stale' });
    await runAgentLoop({ tabId: 3, sessionId: 's', userMessage: 'x' }, deps(provider, exec));
    const session = await getSession(3);
    const toolMsg = session.messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('stale');
  });

  it('length 截断时该轮 tool_calls 判失败喂回', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":' }, { type: 'message-done', finishReason: 'length' }],
      [{ type: 'text-delta', text: '重试' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ tabId: 4, sessionId: 's', userMessage: 'x' }, deps(provider, exec));
    expect(exec).not.toHaveBeenCalled();
    const session = await getSession(4);
    expect(session.messages.some((m) => m.role === 'tool' && String(m.content).includes('截断'))).toBe(true);
  });

  it('provider error 事件终止并保存错误', async () => {
    const provider = queuedProvider([[{ type: 'error', error: 'HTTP 401' }, { type: 'message-done' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ tabId: 5, sessionId: 's', userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('连续 length 截断触发熔断暂停（不无限循环）', async () => {
    const lengthTurn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'click', argsDelta: '{"uid":' },
      { type: 'message-done', finishReason: 'length' },
    ];
    // 提供足够多轮，若无熔断会无限循环；有熔断应在步数阀(50)前的连续错误阀(5)处停
    const provider = queuedProvider(Array.from({ length: 60 }, () => lengthTurn()));
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ tabId: 7, sessionId: 's', userMessage: 'x' }, d);
    const session = await getSession(7);
    expect(session.status).toBe('paused');
    expect(exec).not.toHaveBeenCalled(); // 截断的 call 从不执行
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
    await runAgentLoop({ tabId: 6, sessionId: 's', userMessage: 'x' }, d);
    const session = await getSession(6);
    expect(session.status).toBe('paused');
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
    await runAgentLoop({ tabId: 10, sessionId: 's', userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith({ type: 'reasoning-delta', text: '先想想' });
    const session = await getSession(10);
    const last = session.messages[session.messages.length - 1]!;
    expect(last.role).toBe('assistant');
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
    await runAgentLoop({ tabId: 11, sessionId: 's', userMessage: 'x' }, d);
    const session = await getSession(11);
    const asst = session.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length)!;
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
    await runAgentLoop({ tabId: 10, sessionId: 's', userMessage: 'x' }, deps(provider, exec));
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
    await runAgentLoop({ tabId: 20, sessionId: 's', userMessage: 'x' }, deps(provider, exec));
    expect(calls[2]).toBe(20);
  });

  it('take_screenshot 成功后注入 user 图片消息 + emit 带缩略图', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_screenshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { screenshot: 'data:image/jpeg;base64,ZZZ' } });
    const d = deps(provider, exec);
    await runAgentLoop({ tabId: 30, sessionId: 's', userMessage: 'x' }, d);
    const session = await getSession(30);
    const userImg = session.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(userImg).toBeDefined();
    const parts = userImg!.content as Array<{ type: string; imageUrl?: string }>;
    expect(parts.some((p) => p.type === 'image_url' && p.imageUrl === 'data:image/jpeg;base64,ZZZ')).toBe(true);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', image: 'data:image/jpeg;base64,ZZZ' }));
  });
});
