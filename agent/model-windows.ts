// 模型名 → 上下文窗口（token）映射 + 取值优先级（设计 §4.5 / D3）。
// 优先级：用户在设置页覆盖值 > 映射表子串匹配 > 默认 128k。

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 子串匹配表（大小写不敏感）：命中第一个即返回。顺序上把更具体的放前面。 */
const WINDOW_TABLE: Array<[pattern: string, window: number]> = [
  ['gpt-4o', 128_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 8_192],
  ['gpt-3.5', 16_385],
  ['o1', 128_000],
  ['o3', 200_000],
  ['deepseek', 64_000],
  ['claude', 200_000],
  ['qwen', 32_768],
  ['gemini', 1_000_000],
  ['llama', 128_000],
  ['moonshot', 128_000],
  ['kimi', 128_000],
];

/** 解析上下文窗口。override 为正数时优先；否则按 model 子串匹配；再否则默认。 */
export function resolveContextWindow(model: string | undefined, override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const name = (model ?? '').toLowerCase();
  if (name) {
    for (const [pattern, window] of WINDOW_TABLE) {
      if (name.includes(pattern)) return window;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}
