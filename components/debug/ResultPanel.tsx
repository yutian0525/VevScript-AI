// components/debug/ResultPanel.tsx
// 调试结果面板（工具台与脚本运行时调试台共用）：OK/ERR 判定 + 耗时 + 代码井。
// 三态：参数解析失败 / 链路异常 / 工具（或 GM 直调）返回。GM 直调复用 DebugExecResponse 形状。
import type { DebugExecResponse } from '../../shared/messages';

export type Outcome =
  | { kind: 'bad-args'; message: string }
  | { kind: 'link-error'; message: string }
  | { kind: 'result'; resp: DebugExecResponse };

function formatData(data: unknown): string {
  if (data == null) return '(无返回数据)';
  if (typeof data === 'string') return data; // 快照树等长文本直接展示
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function ResultPanel({ outcome }: { outcome: Outcome }) {
  let ok = false;
  let ms: number | null = null;
  let body: string;

  if (outcome.kind === 'bad-args') {
    body = `参数解析失败：${outcome.message}`;
  } else if (outcome.kind === 'link-error') {
    body = `链路异常：${outcome.message}`;
  } else {
    const { resp } = outcome;
    ms = resp.ms;
    if (!resp.dispatched) {
      body = `链路异常：${resp.error ?? '未知错误'}`;
    } else if (resp.result?.ok) {
      ok = true;
      body = formatData(resp.result.data);
    } else {
      body = resp.result?.error ?? '工具返回失败（无错误信息）';
    }
  }

  return (
    <div className="rise" style={{ marginTop: 12 }}>
      <div className="result-head">
        <span className={`dot dot--${ok ? 'ok' : 'err'}`} />
        <span className={`result-verdict ${ok ? 'result-verdict--ok' : 'result-verdict--err'}`}>
          {ok ? 'OK' : 'ERR'}
        </span>
        {ms != null && <span className="result-ms">{ms} ms</span>}
      </div>
      <div className="well" style={{ maxHeight: 260 }}>{body}</div>
    </div>
  );
}
