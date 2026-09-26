// agent/mcp/sse.ts
// SSE（text/event-stream）帧解析。两种 MCP HTTP 传输都依赖它：
//   - streamable：POST 的响应可能是 text/event-stream（服务端按需选择）
//   - sse（旧版）：GET 长流本身就是 SSE，请求响应靠 id 在流上匹配回来
// 纯函数、无 browser 依赖 —— 便于对粘包/半包做单测。
import type { JsonRpcError } from '../../shared/mcp';

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** 空行的三种写法（LF / CRLF / 老式 CR）。取最先出现的那个作为事件边界。 */
const BLANKS: Array<[string, number]> = [['\r\n\r\n', 4], ['\n\n', 2], ['\r\r', 2]];

function findBlank(s: string): { start: number; len: number } | null {
  let best = -1;
  let bestLen = 0;
  for (const [pat, len] of BLANKS) {
    const i = s.indexOf(pat);
    if (i >= 0 && (best < 0 || i < best)) { best = i; bestLen = len; }
  }
  return best < 0 ? null : { start: best, len: bestLen };
}

/**
 * 解析一个 chunk：吐出其中完整的事件，未闭合的尾巴原样留在 rest（下一次接着喂）。
 * 字段语义按 WHATWG SSE 规范：冒号后**一个**空格属分隔符；data 多行用 \n 拼接；
 * `:` 开头是注释（心跳）；不写 event 时事件名为 message。
 */
export function parseSseChunk(chunk: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = chunk;
  for (;;) {
    const blank = findBlank(rest);
    if (!blank) break;
    const block = rest.slice(0, blank.start);
    rest = rest.slice(blank.start + blank.len);
    const ev = parseBlock(block);
    if (ev) events.push(ev);
  }
  return { events, rest };
}

function parseBlock(block: string): SseEvent | null {
  let event = '';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === '') continue;
    if (line.startsWith(':')) continue; // 注释 / 心跳
    const colon = line.indexOf(':');
    if (colon < 0) { dataLines.push(line); continue; } // 无冒号整行当 data（宽容）
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
    // 其余字段（retry 等）忽略
  }
  if (dataLines.length === 0) return null; // 空块不产出事件
  return { event: event || 'message', data: dataLines.join('\n'), ...(id != null ? { id } : {}) };
}

export interface JsonRpcPayload {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

/**
 * 从一批事件里取第一个 JSON-RPC 响应（带 result 或 error 的那个）。
 * 跳过 endpoint（sse 传输的握手事件）与解析失败的噪音帧——流里混进非 JSON 不该判死整条流。
 */
export function firstJsonRpcResponse(events: SseEvent[]): JsonRpcPayload | undefined {
  for (const ev of events) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    const hasResult = 'result' in obj;
    const hasError = 'error' in obj;
    if (!hasResult && !hasError) continue;
    return {
      ...(obj.id != null ? { id: obj.id as number | string } : {}),
      ...(hasResult ? { result: obj.result as Record<string, unknown> } : {}),
      ...(hasError ? { error: obj.error as JsonRpcError } : {}),
    };
  }
  return undefined;
}
