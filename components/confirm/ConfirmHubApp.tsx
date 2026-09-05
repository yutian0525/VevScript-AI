// components/confirm/ConfirmHubApp.tsx
// 跨域确认 hub 页容器（spec §8）：挂载复水 CONFIRM_GET_STATE + 订阅 CONFIRM_PENDING/RESOLVED 广播，
// 排队渲染 ConfirmCard。决策经 CONFIRM_RESOLVE 回 SW，本地乐观移除（广播回来的 RESOLVED 幂等收口）。
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ConfirmCard } from './ConfirmCard';
import { applyConfirmEvent } from './confirm-reducer';
import type { ConfirmRequest, ConfirmPendingEvent, ConfirmResolvedEvent } from '../../shared/confirm';

export function ConfirmHubApp() {
  const [confirms, setConfirms] = useState<ConfirmRequest[]>([]);

  useEffect(() => {
    void (async () => {
      const resp = (await browser.runtime.sendMessage({ type: 'CONFIRM_GET_STATE' })) as
        { ok: boolean; data?: { confirms: ConfirmRequest[] } } | undefined;
      const snapshot = resp?.data?.confirms;
      if (!snapshot) return;
      // 以快照为基「合并」而非整体覆盖：监听器已挂但快照未回的窗口内到达的广播（已 resolve 的移除 /
      // 新 pending 的追加）不被覆盖丢失或复活——按 confirmId 去重合并，quhub 与活 map 最终一致。
      setConfirms((cur) => {
        const merged = [...snapshot];
        for (const c of cur) if (!merged.some((m) => m.confirmId === c.confirmId)) merged.push(c);
        return merged;
      });
    })();
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'CONFIRM_PENDING') setConfirms((s) => applyConfirmEvent(s, msg as ConfirmPendingEvent));
      if (m?.type === 'CONFIRM_RESOLVED') setConfirms((s) => applyConfirmEvent(s, msg as ConfirmResolvedEvent));
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  function decide(confirmId: string, decision: string): void {
    void browser.runtime.sendMessage({ type: 'CONFIRM_RESOLVE', confirmId, decision }).catch(() => {});
    setConfirms((s) => s.filter((c) => c.confirmId !== confirmId)); // 乐观移除
  }

  return (
    <div className="confirm-hub">
      <header className="confirm-hub__head">
        <span className="confirm-hub__title">跨域请求确认</span>
        <span className="confirm-hub__count mono">{confirms.length} 个待确认</span>
      </header>
      {confirms.length === 0 ? (
        <div className="confirm-hub__empty">
          <ShieldCheck size={20} aria-hidden />
          <span>暂无待确认请求</span>
        </div>
      ) : (
        <div className="confirm-hub__list">
          {confirms.map((c) => (
            <ConfirmCard key={c.confirmId} confirm={c} onDecide={(d) => decide(c.confirmId, d)} />
          ))}
        </div>
      )}
    </div>
  );
}
