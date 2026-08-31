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
    const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { ok: true, data: json.choices?.[0]?.message?.content ?? '' };
  } catch (err) {
    // 非 Error 拒绝防御（与 openai-compat.ts 同模式）
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `network error: ${errMsg}` };
  }
}
