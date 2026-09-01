// observe/redact.ts
// headers 脱敏 + 截断（设计 §4.3）。纯函数：脱敏开关由调用方（get_network_request 执行器读 settings）传入。
// 入缓冲不调此函数（store 存原文），仅读取时按当前设置脱敏，保证 full 档可逆。

/** 敏感头名（小写）：命中即在 redacted 模式替换为 [REDACTED]。 */
export const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'api-key', 'x-auth-token', 'x-csrf-token',
]);

const REDACTED = '[REDACTED]';
const MAX_VAL = 2048;
const MAX_COUNT = 50;

function capVal(v: string): string {
  return v.length > MAX_VAL ? `${v.slice(0, MAX_VAL)}…` : v;
}

/** 归一化小写 key + 按 mode 脱敏敏感头 + 值截断 + 条数上限。 */
export function redactHeaders(
  headers: Record<string, string> | undefined,
  mode: 'redacted' | 'full',
  maxCount = MAX_COUNT,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  let count = 0;
  let over = 0;
  for (const [rawK, rawV] of Object.entries(headers)) {
    const k = rawK.toLowerCase();
    if (count >= maxCount) { over += 1; continue; }
    if (mode === 'redacted' && SENSITIVE_HEADERS.has(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = capVal(String(rawV));
    }
    count += 1;
  }
  if (over > 0) out.__truncated__ = `头过多，省略 ${over} 条`;
  return out;
}
