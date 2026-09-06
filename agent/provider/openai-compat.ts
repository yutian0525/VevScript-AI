// agent/provider/openai-compat.ts
// OpenAI 兼容协议 provider：/chat/completions + SSE 流式（设计 §4.2）。
// 事件语义：
// - text-delta / tool-call-delta 均为纯增量转发（聚合责任在消费者/agent loop）；
// - message-done 只在流结束时发一次，携带聚合的 usage 与 finishReason——
//   OpenAI 官方 stream_options.include_usage 的 usage 在 finish_reason 之后的
//   单独 chunk 里（choices 为空数组），提前发 message-done 会丢 usage；
// - 不变量：每次 streamChat 调用恰好终止于一个 message-done（可能前面有 error），
//   取消（abort/cancel）也不例外——消费者可安全地「await 到 message-done 为止」。
// 超时与重试（options.timeoutMs / options.maxRetries）：
// - 超时为「静默窗口」：连上后 / 流中途，超过 timeoutMs 没收到任何数据即判挂死 abort。
//   不做总时长上限——健康的长流（长回复/长思考）不应被误杀。
// - 重试只针对「一个增量都没吐出」的失败：网络错误、HTTP 429/5xx、静默超时。
//   已向 UI 流出内容后失败不重试（增量事件已发出，重试会造成输出重复/错乱）。
//   429/5xx 指数退避（1s 起，×2，封顶 10s），其余立即重试。
// - options.timeoutMs = 0 表示不限时，但仍有 300s 硬兜底（hardCapMs）防永久悬挂；
//   调用方 signal 的 abort 永远优先（不重试，直接收尾）。
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

/** 重试相关可调参数（测试注入用；默认 timeoutMs 不限时、不重试，保持旧行为） */
export interface ProviderOptions {
  /** 静默超时窗口（毫秒）：首字节与流增量间隙共用。0 = 不限时。 */
  timeoutMs?: number;
  /** 失败自动重试次数（仅未吐出任何增量的可重试失败）。0 = 不重试。 */
  maxRetries?: number;
  /** 首次退避时长（毫秒），仅测试注入用，默认 1000 */
  retryDelayMs?: number;
  /** timeoutMs=0（不限时）时的硬兜底静默窗（毫秒）。防「网关挂死 → Promise 永不 resolve
   *  → runningConvs 永久占位 → 面板永久 running」。默认 300s；仅测试注入更小值。 */
  hardCapMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 10_000;
const HARD_SILENT_CAP_MS = 300_000;

/** 单次尝试的失败：kind 决定可否重试 */
interface AttemptFailure {
  kind: 'network' | 'http' | 'timeout';
  status?: number; // http 时
  message: string;
}

/** 判断 HTTP 状态是否可重试（限流与服务端瞬时故障） */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class OpenAICompatProvider implements Provider {
  constructor(
    private config: ProviderConfig,
    private options: ProviderOptions = {},
  ) {}

  streamChat(
    params: ChatParams,
    onEvent: (event: StreamEvent) => void,
  ): { cancel: () => void } {
    // 调用方 signal 与重试循环解耦：外部 abort 视为「用户停止」，直接收尾不重试。
    const external = new AbortController();
    if (params.signal?.aborted) {
      external.abort();
    } else {
      params.signal?.addEventListener('abort', () => external.abort(), { once: true });
    }

    let settled = false;
    let cancelled = false; // cancel() 主动取消：同样不重试
    let cancelCurrentAttempt: () => void = () => {};
    const maxRetries = this.options.maxRetries ?? 0;

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;

    /** 构造请求体（每次尝试都从同一 params 重建，防可变对象被上次尝试污染） */
    const buildBody = (): string => {
      const body: Record<string, unknown> = {
        // 用户自定义参数先铺底；下面的核心字段随后覆盖，确保协议不被破坏（如误设 stream:false）
        ...this.config.extraBody,
        model: this.config.model,
        messages: toWireMessages(params.messages),
        // OpenAI 官方对 tools: [] 直接 400（empty array），无工具时整个字段省略
        ...(params.tools.length > 0 ? { tools: params.tools, tool_choice: 'auto' } : {}),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (params.maxTokens != null) body.max_tokens = params.maxTokens;
      return JSON.stringify(body);
    };

    /** 重试退避：第 n 次重试（从 1 计）前的等待时长 */
    const backoffMs = (retryNo: number): number => {
      const base = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
      return Math.min(base * 2 ** (retryNo - 1), this.options.retryDelayMs != null ? Infinity : MAX_RETRY_DELAY_MS);
    };

    const finish = (e: StreamEvent) => {
      if (settled) return;
      settled = true;
      onEvent(e);
    };

    const runAttempt = (attempt: number): void => {
      if (settled || cancelled) return;
      if (external.signal.aborted) {
        finish({ type: 'message-done' });
        return;
      }

      // 单次尝试独立的 AbortController：超时/重试中止本次，不影响调用方 signal
      const ac = new AbortController();
      cancelCurrentAttempt = () => {
        cancelled = true;
        ac.abort();
      };
      const abortCurrent = () => ac.abort();
      if (external.signal.aborted) abortCurrent();
      else external.signal.addEventListener('abort', abortCurrent, { once: true });

      // timeoutMs=0 表示用户关掉了超时保护——仍保留一个远大的硬兜底，避免永久悬挂
      const configured = this.options.timeoutMs ?? 0;
      const timeoutMs = configured > 0 ? configured : (this.options.hardCapMs ?? HARD_SILENT_CAP_MS);
      // 静默窗口定时器：必须覆盖三个阶段——连接（fetch 前武装）、响应头后（首字节）、
      // 每块数据后（增量间隙）。关键：fetch 本身挂死时 .then 永不执行，所以连接阶段的
      // 定时器必须在调用 fetch 之前武装，超时时主动 abort 让挂死的 fetch reject。
      // timeoutMs=0 时不启用。
      let silentTimer: ReturnType<typeof setTimeout> | undefined;
      let emittedDelta = false; // 本次尝试是否已吐出任何增量（决定失败可否重试）
      const armSilentTimer = () => {
        if (timeoutMs <= 0) return;
        clearTimeout(silentTimer);
        silentTimer = setTimeout(() => {
          ac.abort(); // 让挂死的 fetch / 读循环落地
          handleFailure({ kind: 'timeout', message: `超时：${Math.round(timeoutMs / 1000)}s 内无数据（连接或流可能已挂死）` }, emittedDelta);
        }, timeoutMs);
      };
      const disarmSilentTimer = () => clearTimeout(silentTimer);

      // 连接阶段静默窗口：先武装再发请求，覆盖 fetch 挂死
      armSilentTimer();

      console.log('[provider] fetch →', url, 'model=', this.config.model, 'msgs=', params.messages.length, 'attempt=', attempt);
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: buildBody(),
        signal: ac.signal,
      })
        .then(async (resp) => {
          console.log('[provider] 响应', resp.status, resp.ok, 'attempt=', attempt);
          if (!resp.ok || !resp.body) {
            const text = await resp.text().catch(() => '');
            let detail = text;
            try {
              const parsed = JSON.parse(text) as { error?: { message?: string } };
              detail = parsed?.error?.message ?? text;
            } catch { /* 非 JSON 错误体 */ }
            const failure: AttemptFailure = {
              kind: 'http',
              status: resp.status,
              message: `HTTP ${resp.status}: ${detail}`,
            };
            handleFailure(failure, emittedDelta);
            return;
          }
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let pendingUsage: { promptTokens?: number; completionTokens?: number } | undefined;
          let finishReason: string | undefined;

          // abort 时不依赖 fetch/undici 对 signal 的传播（浏览器扩展场景里
          // response.body 是普通流，signal 未必联动它）——cancel 时主动
          // reader.cancel() 让读循环立即结束。
          ac.signal.addEventListener('abort', () => {
            reader.cancel().catch(() => { /* 流已结束/已取消时忽略 */ });
          }, { once: true });

          // content 里若混着 <think>…</think>（部分中转/本地模型的思考写法），
          // 拆分器把标签内→reasoning、标签外→text；不含标签则整段透传为 text。
          const think = createThinkSplitter({
            reasoning: (t) => { emittedDelta = true; onEvent({ type: 'reasoning-delta', text: t }); },
            text: (t) => { emittedDelta = true; onEvent({ type: 'text-delta', text: t }); },
          });

          // 诊断：记录已见过的 delta 字段名，每个字段首次出现时打印一次（名+样例值），
          // 用于排查「思考未输出」——直接看网关到底在 delta 里发了什么字段。排查完可删。
          const seenDeltaKeys = new Set<string>();

          const parser = createSseParser((data) => {
            let chunk: {
              choices?: Array<{
                delta?: Record<string, unknown> & {
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
            if (choice?.delta) {
              for (const k of Object.keys(choice.delta)) {
                if (seenDeltaKeys.has(k)) continue;
                seenDeltaKeys.add(k);
                const v = (choice.delta as Record<string, unknown>)[k];
                const sample = typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60);
                console.log('[provider][diag] delta 字段:', k, '=', sample);
              }
            }
            const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
            if (reasoning) { emittedDelta = true; onEvent({ type: 'reasoning-delta', text: reasoning }); }
            if (choice?.delta?.content) {
              think.push(choice.delta.content); // 经拆分器：<think> 内转 reasoning，其余转 text
            }
            if (choice?.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0;
                const argsDelta = tc.function?.arguments ?? '';
                emittedDelta = true;
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

          // 收到响应头：重置静默窗口（此后读循环里每块数据再重置）
          armSilentTimer();

          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              armSilentTimer(); // 增量间隙窗口：每收到一块数据重置
              parser.push(decoder.decode(value, { stream: true }));
            }
            disarmSilentTimer();
            parser.flush();
            think.flush(); // 吐出拆分器里残留的半截/未闭合内容
          } catch (err) {
            disarmSilentTimer();
            // 取消是主动行为不是错误，AbortError 静默（但 message-done 仍在下方发出，
            // 维持「恰好一次终止事件」不变量）。fetch 可能 reject 非 Error 值
            // （中转站/polyfill），instanceof 防御避免二次抛出吞掉终止事件。
            const errName = err instanceof Error ? err.name : undefined;
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errName !== 'AbortError') {
              // 流中途错误：handleFailure 决定重试或收尾（已吐增量则不重试）
              handleFailure({ kind: 'network', message: `stream error: ${errMsg}` }, emittedDelta);
              return;
            }
            // 超时主动 abort 的 AbortError：定时器回调已 handleFailure，静默即可
          }
          disarmSilentTimer();
          finish({ type: 'message-done', usage: pendingUsage, finishReason });
        })
        .catch((err: unknown) => {
          disarmSilentTimer();
          // 响应头前 abort / 预先 aborted signal / 网络错误都走这里。
          // AbortError = 用户停止或超时主动中止：用户停止收尾不重试；超时在定时器回调里已处理。
          const errName = err instanceof Error ? err.name : undefined;
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errName === 'AbortError') {
            if (cancelled || external.signal.aborted) finish({ type: 'message-done' });
            // 超时触发的 abort：定时器回调已调 handleFailure，这里不再处理
            return;
          }
          handleFailure({ kind: 'network', message: `network error: ${errMsg}` }, emittedDelta);
        });

      /** 统一失败入口：可重试且未吐增量且未取消 → 调度重试；否则发 error + message-done 收尾 */
      const handleFailure = (failure: AttemptFailure, hasDelta: boolean): void => {
        if (settled || cancelled) { finish({ type: 'message-done' }); return; }
        if (external.signal.aborted) { finish({ type: 'message-done' }); return; }
        const canRetry = !hasDelta && (failure.kind !== 'http' || isRetryableStatus(failure.status ?? 0));
        if (canRetry && attempt <= maxRetries) {
          const delay = backoffMs(attempt);
          console.log('[provider] 重试', attempt, '/', maxRetries, 'after', delay, 'ms：', failure.message);
          setTimeout(() => runAttempt(attempt + 1), delay);
          return;
        }
        onEvent({ type: 'error', error: failure.message });
        finish({ type: 'message-done' });
      };
    };

    runAttempt(1);

    return {
      cancel: () => {
        cancelled = true;
        external.abort();
        cancelCurrentAttempt();
      },
    };
  }
}
