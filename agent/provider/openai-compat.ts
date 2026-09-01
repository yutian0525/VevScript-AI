// agent/provider/openai-compat.ts
// OpenAI 兼容协议 provider：/chat/completions + SSE 流式（设计 §4.2）。
// 事件语义：
// - text-delta / tool-call-delta 均为纯增量转发（聚合责任在消费者/agent loop）；
// - message-done 只在流结束时发一次，携带聚合的 usage 与 finishReason——
//   OpenAI 官方 stream_options.include_usage 的 usage 在 finish_reason 之后的
//   单独 chunk 里（choices 为空数组），提前发 message-done 会丢 usage；
// - 不变量：每次 streamChat 调用恰好终止于一个 message-done（可能前面有 error），
//   取消（abort/cancel）也不例外——消费者可安全地「await 到 message-done 为止」。
import { createSseParser } from './sse';
import { createThinkSplitter } from './think-splitter';
import type {
  ChatMessage,
  ChatParams,
  ContentPart,
  Provider,
  ProviderConfig,
  StreamEvent,
} from './types';

/** 内部统一消息 → OpenAI wire 格式 */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    const content = typeof m.content === 'string' ? m.content : toWireContent(m.content);
    return { role: m.role, content };
  });
}

function toWireContent(parts: ContentPart[]): unknown[] {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: p.imageUrl } },
  );
}

export class OpenAICompatProvider implements Provider {
  constructor(private config: ProviderConfig) {}

  streamChat(
    params: ChatParams,
    onEvent: (event: StreamEvent) => void,
  ): { cancel: () => void } {
    const ac = new AbortController();
    if (params.signal?.aborted) {
      ac.abort();
    } else {
      params.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    }
    let onAbort: (() => void) | undefined;
    ac.signal.addEventListener(
      'abort',
      () => {
        onAbort?.();
      },
      { once: true },
    );

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toWireMessages(params.messages),
      // OpenAI 官方对 tools: [] 直接 400（empty array），无工具时整个字段省略
      ...(params.tools.length > 0 ? { tools: params.tools, tool_choice: 'auto' } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (params.maxTokens != null) body.max_tokens = params.maxTokens;

    console.log('[provider] fetch →', url, 'model=', this.config.model, 'msgs=', params.messages.length);
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
      .then(async (resp) => {
        console.log('[provider] 响应', resp.status, resp.ok);
        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => '');
          let detail = text;
          try {
            const parsed = JSON.parse(text) as { error?: { message?: string } };
            detail = parsed?.error?.message ?? text;
          } catch { /* 非 JSON 错误体 */ }
          onEvent({ type: 'error', error: `HTTP ${resp.status}: ${detail}` });
          onEvent({ type: 'message-done' });
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let pendingUsage: { promptTokens?: number; completionTokens?: number } | undefined;
        let finishReason: string | undefined;
        // abort 时不依赖 fetch/undici 对 signal 的传播（浏览器扩展场景里
        // response.body 是普通流，signal 未必联动它）——cancel 时主动
        // reader.cancel() 让读循环立即结束。
        onAbort = () => {
          reader.cancel().catch(() => { /* 流已结束/已取消时忽略 */ });
        };

        // content 里若混着 <think>…</think>（部分中转/本地模型的思考写法），
        // 拆分器把标签内→reasoning、标签外→text；不含标签则整段透传为 text。
        const think = createThinkSplitter({
          reasoning: (t) => onEvent({ type: 'reasoning-delta', text: t }),
          text: (t) => onEvent({ type: 'text-delta', text: t }),
        });

        const parser = createSseParser((data) => {
          let chunk: {
            choices?: Array<{
              delta?: {
                content?: string | null;
                reasoning_content?: string | null;
                reasoning?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            return; // 跳过无法解析的行（某些中转站夹带非标准行）
          }
          const choice = chunk.choices?.[0];
          const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
          if (reasoning) onEvent({ type: 'reasoning-delta', text: reasoning });
          if (choice?.delta?.content) {
            think.push(choice.delta.content); // 经拆分器：<think> 内转 reasoning，其余转 text
          }
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
              const argsDelta = tc.function?.arguments ?? '';
              onEvent({
                type: 'tool-call-delta',
                index: idx,
                id: tc.id,
                name: tc.function?.name,
                argsDelta: argsDelta || undefined,
              });
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            pendingUsage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            };
          }
        });

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
          parser.flush();
          think.flush(); // 吐出拆分器里残留的半截/未闭合内容
        } catch (err) {
          // 取消是主动行为不是错误，AbortError 静默（但 message-done 仍在下方发出，
          // 维持「恰好一次终止事件」不变量）。fetch 可能 reject 非 Error 值
          // （中转站/polyfill），instanceof 防御避免二次抛出吞掉终止事件。
          const errName = err instanceof Error ? err.name : undefined;
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errName !== 'AbortError') {
            onEvent({ type: 'error', error: `stream error: ${errMsg}` });
          }
        }
        onEvent({ type: 'message-done', usage: pendingUsage, finishReason });
      })
      .catch((err: unknown) => {
        // 响应头前 abort / 预先 aborted signal / 网络错误都走这里。
        // 无论哪种情况都补发 message-done——否则消费者的
        // 「await 到 message-done」Promise 永久挂起。
        const errName = err instanceof Error ? err.name : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName !== 'AbortError') {
          onEvent({ type: 'error', error: `network error: ${errMsg}` });
        }
        onEvent({ type: 'message-done' });
      });

    return {
      cancel: () => ac.abort(),
    };
  }
}
