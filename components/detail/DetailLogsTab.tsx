// components/detail/DetailLogsTab.tsx
// 日志 Tab：脚本错误环形缓冲（时间 · line · 消息 + 可展开 stack）+ 清空；.well 井视觉。
import { useState } from 'react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import type { GmErrorItem } from '../../stores/scripts';

export function DetailLogsTab({ id, errors }: { id: string; errors: GmErrorItem[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div className="detail__tabcard">
      <div className="detail-code__bar">
        <span className="mono detail-code__status">{errors.length} 条记录</span>
        <Button
          variant="ghost"
          disabled={errors.length === 0}
          onClick={() => void sendScriptsRequest({ type: 'SCRIPTS_CLEAR_ERRORS', scriptId: id })}
        >
          清空
        </Button>
      </div>
      {errors.length === 0 ? (
        <div className="chat__empty">暂无错误——脚本运行正常</div>
      ) : (
        <div className="well detail__logs">
          {[...errors].reverse().map((e, i) => (
            <div key={i} className="detail__logrow">
              <button
                type="button"
                className="detail__logmain mono"
                onClick={() => setOpenIdx(openIdx === i ? null : i)}
                aria-expanded={openIdx === i}
              >
                {new Date(e.at).toLocaleTimeString()} · line {e.line ?? '?'} · {e.message}
              </button>
              {openIdx === i && e.stack && <pre className="detail__logstack mono">{e.stack}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
