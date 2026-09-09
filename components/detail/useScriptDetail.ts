// components/detail/useScriptDetail.ts
// 详情页数据加载：SCRIPTS_GET 拉脚本 + 错误订阅 + 不存在检测。
import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { sendScriptsRequest, useScripts } from '../../stores/scripts';
import type { GmErrorItem } from '../../stores/scripts';
import type { UserScript } from '../../shared/types';

export interface ScriptDetailData {
  script: UserScript | null;
  /** 顶栏启停成功后本地同步（避免整页重拉） */
  setScript: Dispatch<SetStateAction<UserScript | null>>;
  errors: GmErrorItem[];
  notFound: boolean;
  /** 别处删除该脚本时置真（详情页跳「已删除」空态，消 ghost） */
  setNotFound: Dispatch<SetStateAction<boolean>>;
  loading: boolean;
  /** 重新拉取脚本（别处改动后同步）；按 updatedAt 去重，自触发的相同数据不重置本地态 */
  reload: () => Promise<void>;
}

export function useScriptDetail(id: string): ScriptDetailData {
  const [script, setScript] = useState<UserScript | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  // 选择器不新建引用（React #185 教训）：errorsRecord 可能 undefined，`?? []` 在选择器外
  const errorsRecord = useScripts((s) => s.errors[id]);
  const errors = errorsRecord ?? [];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
          type: 'SCRIPTS_GET', id,
        });
        if (cancelled) return;
        if (resp.ok && resp.data) { setScript(resp.data.script); setNotFound(false); }
        else setNotFound(true);
      } catch {
        if (!cancelled) setNotFound(true); // SW 死亡等传输异常兜底
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // 别处改动后重拉：按 updatedAt 去重——自己刚保存触发的广播拿到相同数据，不重置本地态（防闪烁）
  const reload = useCallback(async () => {
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
        type: 'SCRIPTS_GET', id,
      });
      if (resp.ok && resp.data) {
        setScript((prev) => (prev && prev.updatedAt === resp.data!.script.updatedAt ? prev : resp.data!.script));
        setNotFound(false);
      } else {
        setNotFound(true); // 已被删
      }
    } catch { /* 传输异常：保持当前态，不误判删除 */ }
  }, [id]);

  // 订阅脚本错误广播（实时增行）+ 冷读复水（refresh 拉全量 GM 状态含 errors）
  useEffect(() => {
    void useScripts.getState().refresh();
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'SCRIPTS_ERROR') {
        useScripts.getState().applyErrorEvent(msg as { scriptId: string; error: GmErrorItem });
      }
      if (m?.type === 'SCRIPTS_ERROR_CLEARED') {
        useScripts.getState().applyErrorCleared((msg as { scriptId: string }).scriptId);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => { browser.runtime.onMessage.removeListener(onMessage); };
  }, []);

  return { script, setScript, errors, notFound, setNotFound, loading, reload };
}
