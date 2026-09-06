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

  it('extraBody 合并进请求体，且不能覆盖核心字段', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({
      baseUrl: 'https://api.x.com/v1',
      apiKey: 'sk',
      model: 'real-model',
      // 混入一个自定义开关 + 一个企图覆盖核心字段的恶意值
      extraBody: { enable_thinking: true, stream: false, model: 'HIJACK' },
    });
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => { if (e.type === 'message-done') resolve(); });
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.enable_thinking).toBe(true);      // 自定义参数进入 body
    expect(body.stream).toBe(true);               // 核心字段不被覆盖
    expect(body.model).toBe('real-model');        // 核心字段不被覆盖
  });

  it('content 里的 <think>…</think>（跨 chunk）拆成 reasoning-delta + text-delta', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { content: '<thi' } }] },
          { choices: [{ delta: { content: 'nk>思考中' } }] },
          { choices: [{ delta: { content: '</think>答案' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'local-r1' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const reasoning = events.filter((e) => e.type === 'reasoning-delta').map((e) => (e as { text: string }).text).join('');
    const text = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');
    expect(reasoning).toBe('思考中');
    expect(text).toBe('答案');
  });

  it('toWireMessages 不含 reasoning（锁定：思考绝不回填 LLM）', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    await new Promise<void>((resolve) => {
      p.streamChat(
        {
          messages: [
            { role: 'user', content: '算一下' },
            { role: 'assistant', content: '答案 42', reasoning: '内部推理不该外泄' },
          ],
          tools: [],
        },
        (e) => { if (e.type === 'message-done') resolve(); },
      );
    });
    const body = (fetchMock.mock.calls[0]![1] as RequestInit).body as string;
    expect(body).not.toContain('内部推理不该外泄');
    const parsed = JSON.parse(body);
    expect(parsed.messages[1].reasoning).toBeUndefined();
    expect(parsed.messages[1].content).toBe('答案 42');
  });
});

describe('OpenAICompatProvider 超时与重试', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** 构造带超时/重试参数的 provider（retryDelayMs=1 让退避测试不等真实时钟） */
  const makeProvider = (opts: { timeoutMs?: number; maxRetries?: number; retryDelayMs?: number } = {}) =>
    new OpenAICompatProvider(
      { baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' },
      { timeoutMs: opts.timeoutMs ?? 120_000, maxRetries: opts.maxRetries ?? 2, retryDelayMs: opts.retryDelayMs ?? 1 },
    );

  const collect = (p: OpenAICompatProvider, params = baseParams()) => {
    const events: StreamEvent[] = [];
    const donePromise = new Promise<void>((resolve) => {
      p.streamChat(params, (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    return { events, donePromise };
  };

  it('默认构造（无 options）行为不变：成功流照常完成', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: { content: 'ok' } }, { delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const { events, donePromise } = collect(p);
    await donePromise;
    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('网络错误重试：第 2 次成功则正常完成（仅首次失败对外不可见）', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    fetchMock.mockResolvedValueOnce(
      new Response(sseStream([{ choices: [{ delta: { content: '好' } }, { delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = makeProvider();
    const { events, donePromise } = collect(p);
    await donePromise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('好');
  });

  it('HTTP 5xx 重试并指数退避；重试耗尽后发一次 error + message-done', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"overloaded"}}', { status: 503 }));
    const p = makeProvider({ maxRetries: 2 });
    const { events, donePromise } = collect(p);
    // 逐次推进退避时钟（1ms 基准 × 指数增长，兜底大等待避免死锁）
    for (let i = 0; i < 10 && !donePromiseSettled(donePromise); i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    await donePromise;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
    const errs = events.filter((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>[];
    expect(errs).toHaveLength(1);
    expect(errs[0]!.error).toContain('503');
    expect(events.filter((e) => e.type === 'message-done')).toHaveLength(1);
  });

  it('HTTP 429 重试：耗尽后 error 指明限流', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"rate limited"}}', { status: 429 }));
    const p = makeProvider({ maxRetries: 1 });
    const { events, donePromise } = collect(p);
    for (let i = 0; i < 10 && !donePromiseSettled(donePromise); i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    await donePromise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const errs = events.filter((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>[];
    expect(errs[0]!.error).toContain('429');
  });

  it('HTTP 401（不可重试类）不重试：一次失败立即 error', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    const p = makeProvider({ maxRetries: 2 });
    const { events, donePromise } = collect(p);
    await donePromise;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const errs = events.filter((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>[];
    expect(errs).toHaveLength(1);
  });

  it('已流出 token 后流中断：不重试（避免 UI 重复），报错收尾', async () => {
    const fetchMock = vi.mocked(fetch);
    // 中断流：真实定时下发出 content chunk 后报错（同步 enqueue+error 会吞掉首 chunk）
    const brokenStream = () => {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise((r) => setTimeout(r, 10));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"前半"}}]}\n\n'));
          await new Promise((r) => setTimeout(r, 10));
          controller.error(new Error('stream aborted mid-way'));
        },
      });
    };
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    fetchMock.mockResolvedValueOnce(new Response(brokenStream(), { status: 200 }));
    const p = makeProvider();
    const { events, donePromise } = collect(p);
    await donePromise;
    expect(fetchMock).toHaveBeenCalledTimes(2); // 首次网络错误重试了；流中断后不再重试
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('前半');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.filter((e) => e.type === 'message-done')).toHaveLength(1);
  });

  it('首字节超时：连接挂起超过 timeoutMs → 中止并重试；重试耗尽报超时错误', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    // 永不响应的 fetch（模拟网关挂起）
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const p = makeProvider({ timeoutMs: 5000, maxRetries: 1 });
    const { events, donePromise } = collect(p);
    // 5s 超时触发 → 退避（fake timers 下重试的 setTimeout 也被模拟）→ 第 2 次 5s 超时 → 耗尽
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(500);
      if (fetchMock.mock.calls.length >= 2 && events.some((e) => e.type === 'message-done')) break;
    }
    await donePromise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const errs = events.filter((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>[];
    expect(errs).toHaveLength(1);
    expect(errs[0]!.error).toContain('超时');
  });

  it('流增量间隙超时：流中途停顿超过 timeoutMs → 判为挂死（已出 token 不重试）', async () => {
    vi.useFakeTimers();
    // 缓慢流：发一个 chunk 后长时间沉默
    const stallStream = () => {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n'));
          // 不 close 也不再 enqueue
        },
      });
    };
    vi.mocked(fetch).mockResolvedValue(new Response(stallStream(), { status: 200 }));
    const p = makeProvider({ timeoutMs: 3000, maxRetries: 2 });
    const { events, donePromise } = collect(p);
    await vi.advanceTimersByTimeAsync(3000);
    for (let i = 0; i < 10 && !donePromiseSettled(donePromise); i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    await donePromise;
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // 已出 token，不重试
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('开头');
    const errs = events.filter((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>[];
    expect(errs[0]!.error).toContain('超时');
    expect(events.filter((e) => e.type === 'message-done')).toHaveLength(1);
  });

  it('timeoutMs=0 不设超时（挂流不误杀）', async () => {
    const hanging = () => new Promise<Response>(() => {});
    vi.mocked(fetch).mockImplementation(hanging);
    const p = makeProvider({ timeoutMs: 0, maxRetries: 0 });
    const { donePromise } = collect(p);
    let settled = false;
    donePromise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // 未被超时杀掉
  });

  it('maxRetries=0 不重试：网络错误一次即失败', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const p = makeProvider({ maxRetries: 0 });
    const { events, donePromise } = collect(p);
    await donePromise;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('调用方 signal 已 abort 时不发任何请求', async () => {
    const fetchMock = vi.mocked(fetch);
    const ac = new AbortController();
    ac.abort();
    const p = makeProvider();
    const { donePromise } = collect(p, { ...baseParams(), signal: ac.signal });
    await donePromise;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** donePromise 是否已 settle（轮询辅助，供 fake timers 循环推进用） */
function donePromiseSettled(p: Promise<void>): boolean {
  let s = false;
  // 已 settle 的 promise 同步判定：race 一个已 resolve 的占位
  Promise.race([p.then(() => true), Promise.resolve(false)]).then((v) => { s = v as boolean; });
  return s && s !== undefined;
}
