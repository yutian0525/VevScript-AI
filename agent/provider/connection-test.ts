// agent/provider/connection-test.ts
// 设置页"测试连接"按钮的实现：发一个非流式最小请求验证 baseUrl/key/model。

import type { ProviderConfig } from './types';

export interface ConnectionTestResult {
  ok: boolean;
  data?: string;   // 模型回复文本
  error?: string;
}

export async function testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
      // 超时保护：中转站挂起时不能让设置页永远卡在"测试中…"
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        detail = parsed?.error?.message ?? detail;
      } catch { /* 非 JSON */ }
      return { ok: false, error: `HTTP ${resp.status}: ${detail}` };
    }
    let json: { choices?: Array<{ message?: { content?: string } }> };
    try {
      json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      // 200 但 body 非 JSON：网关/中转站异常，别让它落到 network error 分支
      return { ok: false, error: 'HTTP 200: 响应不是有效 JSON（可能是网关/中转站异常）' };
    }
    return { ok: true, data: json.choices?.[0]?.message?.content ?? '' };
  } catch (err) {
    // 超时单独提示（AbortSignal.timeout 抛 DOMException name='TimeoutError'）
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { ok: false, error: '连接超时（15s）——请检查 baseURL 可达性' };
    }
    // 非 Error 拒绝防御（与 openai-compat.ts 同模式）
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `network error: ${errMsg}` };
  }
}
