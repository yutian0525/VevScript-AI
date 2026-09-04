// components/detail/DetailInfoTab.tsx
// 详情 Tab（2026-09-04 重写）：中文字段（title 保留原键名）+ URL 可点链接 + 底部操作区（启停/删除）。
// 双声道：标签 sans 人话；match/grant/run-at 等机器值 mono。
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { classifyGrants } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

interface Props {
  script: UserScript;
  /** 启停成功后回传新脚本 + 提示语（DetailApp 同步 header/横幅） */
  onChanged: (next: UserScript, note: string) => void;
  /** 删除（confirm 与 window.close 在 DetailApp） */
  onDelete: () => void | Promise<void>;
}

/** URL 形态值：渲染为可点链接（新标签打开），显示文本 = URL 本身 */
function UrlValue({ url }: { url: string }) {
  return (
    <Button variant="ghost" className="detail__link" title={url} onClick={() => void browser.tabs.create({ url })}>
      {url}
    </Button>
  );
}

export function DetailInfoTab({ script, onChanged, onDelete }: Props) {
  const meta = script.meta ?? {};
  const [busy, setBusy] = useState(false);

  async function toggleEnabled(): Promise<void> {
    setBusy(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
        type: 'SCRIPTS_SET_ENABLED', id: script.id, enabled: !script.enabled,
      });
      if (resp.ok && resp.data) {
        onChanged(resp.data.script, resp.data.script.enabled ? '已启用，刷新页面生效' : '已禁用，刷新页面生效');
      } else {
        onChanged(script, resp.error ?? '操作失败');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail__info">
      {meta.version && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="version">版本</span>
          <span>{meta.version}</span>
        </div>
      )}
      {meta.author && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="author">作者</span>
          <span>{meta.author}</span>
        </div>
      )}
      {meta.description && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="description">描述</span>
          <span>{meta.description}</span>
        </div>
      )}
      {meta.namespace && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="namespace">命名空间</span>
          <UrlValue url={meta.namespace} />
        </div>
      )}
      {meta.homepage && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="homepage">主页</span>
          <UrlValue url={meta.homepage} />
        </div>
      )}
      {meta.supportURL && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="supportURL">支持页</span>
          <UrlValue url={meta.supportURL} />
        </div>
      )}
      <div className="detail__inforow">
        <span className="detail__infokey" title="match">匹配规则</span>
        <span className="mono detail__infoval">{script.matches.length > 0 ? script.matches.join('  ') : '（无——脚本不会运行）'}</span>
      </div>
      <div className="detail__inforow">
        <span className="detail__infokey" title="run-at · world">注入时机 · 沙箱</span>
        <span className="mono detail__infoval">{script.runAt} · {script.world}</span>
      </div>
      {meta.grants && meta.grants.length > 0 && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="grant">权限申请</span>
          <span className="detail__grants">
            {meta.grants.map((g) => {
              const ok = classifyGrants([g]).supported.length > 0;
              return (
                <span key={g} className={`detail__grant mono${ok ? '' : ' detail__grant--bad'}`}>
                  {ok ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />} {g}
                </span>
              );
            })}
          </span>
        </div>
      )}
      <div className="detail__actions">
        <Button variant="signal" disabled={busy} onClick={() => void toggleEnabled()}>
          {script.enabled ? '禁用脚本' : '启用脚本'}
        </Button>
        <Button variant="danger" onClick={() => void onDelete()}>删除脚本</Button>
      </div>
    </div>
  );
}
