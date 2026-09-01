// tests/agent/provider/openai-compat.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../../agent/provider/openai-compat';
import type { ChatParams, StreamEvent } from '../../../agent/provider/types';

// 构造 OpenAI chunk 格式的 SSE 流
function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l));
      controller.close();
    },
  });
}

const baseParams = (): ChatParams => ({
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
});

describe('OpenAICompatProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('请求体格式正确（model/messages/stream），空 tools 省略字段', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: {} }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-1', model: 'gpt-test' });
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        if (e.type === 'message-done') resolve();
      });
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.x.com/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('gpt-test');
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('user');
    // OpenAI 官方对 tools: [] 返回 400——无工具时整个字段必须省略
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-1' });
  });

  it('非空 tools 时请求体携带 tools 与 tool_choice=auto', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'gpt-test' });
    const tool = {
      type: 'function' as const,
      function: { name: 'take_snapshot', description: '截图', parameters: { type: 'object', properties: {} } },
    };
    await new Promise<void>((resolve) => {
      p.streamChat({ ...baseParams(), tools: [tool] }, (e) => {
        if (e.type === 'message-done') resolve();
      });
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toEqual([tool]);
    expect(body.tool_choice).toBe('auto');
  });

  it('文本增量归一化为 text-delta，usage 在 message-done', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { content: '你好' } }] },
          { choices: [{ delta: { content: '世界' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { usage: { prompt_tokens: 5, completion_tokens: 2 } },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('你好世界');
    // 契约锁定：message-done 恰好一次（消费者以其为终止信号）
    expect(events.filter((e) => e.type === 'message-done')).toHaveLength(1);
    const done = events.find((e) => e.type === 'message-done') as Extract<StreamEvent, { type: 'message-done' }>;
    expect(done.usage?.completionTokens).toBe(2);
    expect(done.finishReason).toBe('stop');
  });

  it('tool_calls 增量聚合', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'take_snapshot', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"verb' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ose":true}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const argEvents = events.filter((e) => e.type === 'tool-call-delta') as Extract<StreamEvent, { type: 'tool-call-delta' }>[];
    const args = argEvents.map((e) => e.argsDelta ?? '').join('');
    expect(args).toBe('{"verbose":true}');
    const nameEvent = argEvents[0]!;
    expect(nameEvent.id).toBe('call_1');
    expect(nameEvent.name).toBe('take_snapshot');
    const done = events.find((e) => e.type === 'message-done') as Extract<StreamEvent, { type: 'message-done' }>;
    expect(done.finishReason).toBe('tool_calls');
  });

  it('多工具并发调用（index 区分）', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'click', arguments: '{"uid":1' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', type: 'function', function: { name: 'fill', arguments: '{"uid":2' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ',"value":"x"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const argEvents = events.filter((e) => e.type === 'tool-call-delta') as Extract<StreamEvent, { type: 'tool-call-delta' }>[];
    const byIndex = new Map<number, string>();
    for (const e of argEvents) byIndex.set(e.index, (byIndex.get(e.index) ?? '') + (e.argsDelta ?? ''));
    expect(byIndex.get(0)).toBe('{"uid":1}');
    expect(byIndex.get(1)).toBe('{"uid":2,"value":"x"}');
  });

  it('HTTP 非 200 时发出 error 事件', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'error' || e.type === 'message-done') resolve();
      });
    });
    const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>;
    expect(err.error).toContain('401');
  });

  it('AbortSignal 传播：调用方 abort 时 fetch 收到的信号中断', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const ac = new AbortController();
    await new Promise<void>((resolve) => {
      p.streamChat({ ...baseParams(), signal: ac.signal }, (e) => {
        if (e.type === 'message-done') resolve();
      });
    });
    // provider 内部用自己的 AbortController（cancel() 需独立于调用方 signal 生效），
    // 因此不能断言 signal 身份相等，改为断言行为契约：调用方 abort 传播到 fetch 的信号。
    const fetchSignal = (fetchMock.mock.calls[0]![1] as RequestInit).signal as AbortSignal;
    expect(fetchSignal).toBeDefined();
    ac.abort();
    expect(fetchSignal.aborted).toBe(true);
  });

  it('cancel() 中止挂起流并发出恰好一次 message-done（无 error）', async () => {
    // 永不结束的流：enqueue 一个 chunk 后保持打开（不 close、不 enqueue 更多）
    const hangingStream = () => {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
        },
      });
    };
    vi.mocked(fetch).mockImplementation(async () => new Response(hangingStream(), { status: 200 }));
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    // 保存 streamChat 的返回值，用 handle.cancel() 取消
    const events: StreamEvent[] = [];
    const done = new Promise<void>((resolve) => {
      const handle = p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
      // 等流开始被读（首个 chunk 已消费），再主动取消
      setTimeout(() => handle.cancel(), 10);
    });
    await done;
    expect(events.filter((e) => e.type === 'message-done')).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'text-delta')).toBe(true); // 首个 chunk 已消费
  });

  it('reasoning_content 归一化为 reasoning-delta，先于 text-delta', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { reasoning_content: '让我' } }] },
          { choices: [{ delta: { reasoning_content: '想想' } }] },
          { choices: [{ delta: { content: '答案是 42' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'r1' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const reasoning = events.filter((e) => e.type === 'reasoning-delta').map((e) => (e as { text: string }).text);
    expect(reasoning.join('')).toBe('让我想想');
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('答案是 42');
  });

  it('reasoning 别名（无 _content 后缀）同样命中', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { reasoning: '思考中' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'o1' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    expect(events.some((e) => e.type === 'reasoning-delta' && (e as { text: string }).text === '思考中')).toBe(true);
  });

  it('非推理模型 chunk 不发 reasoning-delta', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { content: '直接回答' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'gpt' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    expect(events.some((e) => e.type === 'reasoning-delta')).toBe(false);
  });

  it('同一 chunk 内 reasoning-delta 先于 text-delta 发出', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { reasoning_content: '想', content: '答' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'r1' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const ri = events.findIndex((e) => e.type === 'reasoning-delta');
    const ti = events.findIndex((e) => e.type === 'text-delta');
    expect(ri).toBeGreaterThanOrEqual(0);
    expect(ti).toBeGreaterThan(ri);
  });
});
