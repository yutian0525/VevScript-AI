// components/detail/DetailInfoTab.tsx
// 详情 Tab（2026-09-04 重写）：中文字段（title 保留原键名）+ URL 可点链接 + 底部操作区（启停/删除）。
// 双声道：标签 sans 人话；match/grant/run-at 等机器值 mono。
import { useEffect, useState, type ReactNode } from 'react';
import { Check, RefreshCw, X } from 'lucide-react';
import { storage } from 'wxt/utils/storage';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { sendScriptsRequest } from '../../stores/scripts';
import { classifyGrants } from '../../shared/gm-apis';
import { UPDATE_STATE_KEY, type ScriptUpdateState, type UserScript } from '../../shared/types';

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
    <Tooltip label={url}>
      <Button variant="ghost" className="detail__link" onClick={() => void browser.tabs.create({ url })}>
        {url}
      </Button>
    </Tooltip>
  );
}

/** 信息键：中文标签 + hover 显示原键名（如 version / match / run-at） */
function InfoKey({ label, keyName }: { label: ReactNode; keyName: string }) {
  return (
    <Tooltip label={keyName}>
      <span className="detail__infokey">{label}</span>
    </Tooltip>
  );
}

export function DetailInfoTab({ script, onChanged, onDelete }: Props) {
  const meta = script.meta ?? {};
  const [busy, setBusy] = useState(false);
  const hasSource = Boolean(meta.updateURL || meta.downloadURL);
  const [checkState, setCheckState] = useState<ScriptUpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  // 复水：上次启动检查的结果直接显示，不用再点（spec §3.2）
  useEffect(() => {
    let alive = true;
    void (async () => {
      const stored = await storage.getItem<Record<string, ScriptUpdateState>>(UPDATE_STATE_KEY);
      if (alive) setCheckState(stored?.[script.id] ?? null);
    })();
    return () => { alive = false; };
  }, [script.id]);

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

  async function checkUpdate(): Promise<void> {
    setChecking(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: ScriptUpdateState; error?: string }>({ type: 'SCRIPTS_CHECK_UPDATE', id: script.id });
      setCheckState(resp.ok && resp.data ? resp.data : { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: resp.error ?? '检查失败' });
    } finally {
      setChecking(false);
    }
  }

  async function doApplyUpdate(): Promise<void> {
    if (!checkState) return;
    if (!window.confirm(`将下载新版本并覆盖本地修改（含代码与设置），确认更新「${script.name}」到 v${checkState.remoteVersion}？`)) return;
    setUpdating(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({ type: 'SCRIPTS_APPLY_UPDATE', id: script.id });
      if (resp.ok && resp.data) {
        setCheckState(null);
        onChanged(resp.data.script, `已更新到 v${resp.data.script.meta?.version ?? checkState.remoteVersion}`);
      } else {
        setCheckState({ ...checkState, status: 'error', message: resp.error ?? '更新失败' });
      }
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="detail__info">
      {meta.version && (
        <div className="detail__inforow">
          <InfoKey label="版本" keyName="version" />
          <span>{meta.version}</span>
        </div>
      )}
      {(hasSource || checkState) && (
        <div className="detail__inforow">
          <InfoKey label="更新检查" keyName="update check" />
          <span className="detail__infoval" role="status">
            {checkState == null && <span style={{ color: 'var(--ink-3)' }}>尚未检查</span>}
            {checkState?.status === 'up-to-date' && <span>已是最新{checkState.remoteVersion ? ` v${checkState.remoteVersion}` : ''}</span>}
            {checkState?.status === 'available' && (
              <>
                <span>有新版本 v{checkState.remoteVersion}</span>
                <Button variant="signal" disabled={updating || checking} onClick={() => void doApplyUpdate()} style={{ marginLeft: 8 }}>
                  更新
                </Button>
              </>
            )}
            {checkState?.status === 'error' && <span style={{ color: 'var(--warn)' }}>{checkState.message}</span>}
          </span>
        </div>
      )}
      {meta.author && (
        <div className="detail__inforow">
          <InfoKey label="作者" keyName="author" />
          <span>{meta.author}</span>
        </div>
      )}
      {meta.description && (
        <div className="detail__inforow">
          <InfoKey label="描述" keyName="description" />
          <span>{meta.description}</span>
        </div>
      )}
      {meta.namespace && (
        <div className="detail__inforow">
          <InfoKey label="命名空间" keyName="namespace" />
          <UrlValue url={meta.namespace} />
        </div>
      )}
      {meta.homepage && (
        <div className="detail__inforow">
          <InfoKey label="主页" keyName="homepage" />
          <UrlValue url={meta.homepage} />
        </div>
      )}
      {meta.supportURL && (
        <div className="detail__inforow">
          <InfoKey label="支持页" keyName="supportURL" />
          <UrlValue url={meta.supportURL} />
        </div>
      )}
      <div className="detail__inforow">
        <InfoKey label="匹配规则" keyName="match" />
        <span className="mono detail__infoval">{script.matches.length > 0 ? script.matches.join('  ') : '（无——脚本不会运行）'}</span>
      </div>
      <div className="detail__inforow">
        <InfoKey label="注入时机 · 沙箱" keyName="run-at · world" />
        <span className="mono detail__infoval">{script.runAt} · {script.world}</span>
      </div>
      {meta.grants && meta.grants.length > 0 && (
        <div className="detail__inforow">
          <InfoKey label="权限申请" keyName="grant" />
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
        {/* disabled 按钮不触发 hover 事件，tooltip 挂外层 span 才能在「无更新源」时提示 */}
        <Tooltip label="无更新源（@updateURL/@downloadURL）" disabled={hasSource}>
          <span className="detail__btnwrap">
            <Button
              variant="ghost"
              disabled={!hasSource || checking || updating}
              onClick={() => void checkUpdate()}
            >
              <RefreshCw size={13} aria-hidden /> {checking ? '检查中…' : '检查更新'}
            </Button>
          </span>
        </Tooltip>
        <Button variant="signal" disabled={busy} onClick={() => void toggleEnabled()}>
          {script.enabled ? '禁用脚本' : '启用脚本'}
        </Button>
        <Button variant="danger" onClick={() => void onDelete()}>删除脚本</Button>
      </div>
    </div>
  );
}
