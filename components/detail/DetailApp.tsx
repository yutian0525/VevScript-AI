// components/detail/DetailApp.tsx
// 全屏脚本详情页（2026-09-04 重设计）：header = 头像 + 标题/副标题 + 外链 icon 组；
// 左栏纯导航（详情/代码/设置/日志）；启停/删除在详情 Tab 内。
import { useEffect, useRef, useState } from 'react';
import { Download, House, LifeBuoy, RefreshCw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { useTruncated } from '../ui/useTruncated';
import { Brand } from '../ui/Brand';
import { sendScriptsRequest } from '../../stores/scripts';
import type { UserScript } from '../../shared/types';
import type { ScriptsChangedEvent } from '../../shared/messages';
import { useScriptDetail } from './useScriptDetail';
import { DetailInfoTab } from './DetailInfoTab';
import { DetailCodeTab } from './DetailCodeTab';
import { DetailSettingsTab } from './DetailSettingsTab';
import { DetailLogsTab } from './DetailLogsTab';

type TabKey = 'info' | 'code' | 'settings' | 'logs';

export function DetailApp({ id }: { id: string }) {
  const { script, setScript, errors, notFound, setNotFound, loading, reload } = useScriptDetail(id);
  const [tab, setTab] = useState<TabKey>('info');
  const [message, setMessage] = useState('');
  const [iconFailed, setIconFailed] = useState(false);
  // 代码 Tab 未保存标记（提升到此，供外部变更订阅判断是否可安全重拉）
  const dirtyRef = useRef(false);
  // 别处改动了本脚本但本地正在编辑：显横幅让用户主动加载最新，不覆盖 dirty 编辑
  const [staleNotice, setStaleNotice] = useState(false);
  // 切换脚本时重置头像加载失败标记
  useEffect(() => { setIconFailed(false); setStaleNotice(false); }, [id]);
  // 标题过长才挂 tooltip（早返回前声明，保持 hook 顺序稳定）
  const [titleRef, titleTruncated] = useTruncated<HTMLHeadingElement>(script?.name);

  // 跨界面同步：别处（侧栏/popup/AI 工具）改了本脚本 → 重拉；删了 → 跳「已删除」
  useEffect(() => {
    const onMessage = (msg: unknown) => {
      const m = msg as ScriptsChangedEvent;
      if (m?.type !== 'SCRIPTS_CHANGED') return;
      if (m.ids && !m.ids.includes(id)) return; // 无 ids 视为全量，保守也响应
      if (m.reason === 'delete') { setNotFound(true); return; }
      if (dirtyRef.current) setStaleNotice(true); // 有未保存编辑：横幅提示，不覆盖
      else void reload();
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [id, reload, setNotFound]);

  function onScriptChanged(next: UserScript, note: string): void {
    setScript(next);
    setMessage(note);
  }

  async function remove(): Promise<void> {
    if (!script || !window.confirm(`删除脚本「${script.name}」？不可恢复。`)) return;
    const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_DELETE', id: script.id });
    if (resp.ok) window.close();
    else setMessage(resp.error ?? '删除失败');
  }

  if (loading) {
    return <div className="detail detail--empty">加载中…</div>;
  }
  if (notFound || !script) {
    return (
      <div className="detail detail--empty">
        <div className="chat__empty">脚本不存在或已被删除</div>
        <Button variant="ghost" onClick={() => window.close()}><X size={14} /> 关闭</Button>
      </div>
    );
  }

  const meta = script.meta ?? {};
  const avatarChar = script.name.trim()[0] || '未';
  const subtitleParts = [
    meta.author ? `作者 ${meta.author}` : '',
    meta.version ? `v${meta.version}` : '',
  ].filter(Boolean);
  const LINKS: Array<{ url?: string; label: string; icon: ReactNode }> = [
    { url: meta.homepage, label: '脚本主页', icon: <House size={15} /> },
    { url: meta.supportURL, label: '反馈与支持', icon: <LifeBuoy size={15} /> },
    { url: meta.downloadURL, label: '安装源', icon: <Download size={15} /> },
    { url: meta.updateURL, label: '更新源', icon: <RefreshCw size={15} /> },
  ];
  const links = LINKS.filter((l): l is { url: string; label: string; icon: ReactNode } => Boolean(l.url));

  const TABS: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'info', label: '详情' },
    { key: 'code', label: '代码' },
    { key: 'settings', label: '设置' },
    { key: 'logs', label: '日志', count: errors.length },
  ];

  return (
    <div className="detail">
      <div className="detail__brandbar">
        <Brand layout="inline" size={22} id="detail" />
      </div>
      <header className="detail__topbar">
        {meta.iconURL && !iconFailed ? (
          <img className="detail__avatar" src={meta.iconURL} alt="" onError={() => setIconFailed(true)} />
        ) : (
          <span className="detail__avatar detail__avatar--fallback" aria-hidden>{avatarChar}</span>
        )}
        <div className="detail__headtext">
          <Tooltip label={script.name} disabled={!titleTruncated}>
            <h1 className="detail__h1" ref={titleRef}>{script.name || '未命名脚本'}</h1>
          </Tooltip>
          {subtitleParts.length > 0 && <div className="detail__subtitle">{subtitleParts.join(' · ')}</div>}
        </div>
        {links.length > 0 && (
          <div className="detail__links">
            {links.map((l) => (
              <Tooltip key={l.label} label={`${l.label}：${l.url}`}>
                <Button
                  variant="ghost"
                  className="btn--icon"
                  aria-label={l.label}
                  onClick={() => void browser.tabs.create({ url: l.url })}
                >
                  {l.icon}
                </Button>
              </Tooltip>
            ))}
          </div>
        )}
      </header>
      <div className="detail__main">
        <nav className="detail__side" aria-label="详情页分区">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`detail__navitem${tab === t.key ? ' is-active' : ''}`}
              aria-current={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              <span>{t.label}</span>
              {t.count != null && <span className="detail__navcount mono">{t.count}</span>}
            </button>
          ))}
        </nav>
        <div className="detail__content">
          {message && <div className="scripts-warnline" role="status">{message}</div>}
          {staleNotice && (
            <div className="scripts-warnline" role="status" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>该脚本已在别处变更，你有未保存的编辑。</span>
              <Button
                variant="ghost"
                onClick={() => { setStaleNotice(false); void reload(); }}
              >
                放弃编辑并加载最新
              </Button>
            </div>
          )}
          {tab === 'info' && <DetailInfoTab script={script} onChanged={onScriptChanged} onDelete={remove} />}
          {tab === 'code' && <DetailCodeTab script={script} onSaved={(s) => setScript(s)} onDirtyChange={(d) => { dirtyRef.current = d; }} />}
          {tab === 'settings' && <DetailSettingsTab id={script.id} />}
          {tab === 'logs' && <DetailLogsTab id={script.id} errors={errors} />}
        </div>
      </div>
    </div>
  );
}
