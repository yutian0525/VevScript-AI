// components/detail/DetailLogsTab.tsx
// 日志 Tab：脚本错误环形缓冲（时间 · line · 消息 + 可展开 stack）+ 清空；.well 井视觉。
import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import type { GmErrorItem } from '../../stores/scripts';
import { DetailTabHeader } from './DetailTabHeader';
import { DetailEmptyCard } from './DetailEmptyCard';

export function DetailLogsTab({ id, errors }: { id: string; errors: GmErrorItem[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div className="detail__info">
      <DetailTabHeader
        title="错误日志"
        suffix={`${errors.length} 条`}
        hint="脚本运行抛错将记录在此（环形缓冲，最近 20 条）。"
      />
      <div className="detail__toolbar">
        <Button
          variant="ghost"
          disabled={errors.length === 0}
          onClick={() => void sendScriptsRequest({ type: 'SCRIPTS_CLEAR_ERRORS', scriptId: id })}
        >
          清空
        </Button>
      </div>
      {errors.length === 0 ? (
        <DetailEmptyCard icon={CircleCheck} title="暂无错误" hint="脚本运行正常" />
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
