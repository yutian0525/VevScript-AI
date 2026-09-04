// components/detail/DetailApp.tsx
// 全屏脚本详情页（2026-09-04 重设计）：header = 头像 + 标题/副标题 + 外链 icon 组；
// 左栏纯导航（详情/代码/设置/日志）；启停/删除在详情 Tab 内。
import { useEffect, useState } from 'react';
import { Download, House, LifeBuoy, RefreshCw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import type { UserScript } from '../../shared/types';
import { useScriptDetail } from './useScriptDetail';
import { DetailInfoTab } from './DetailInfoTab';
import { DetailCodeTab } from './DetailCodeTab';
import { DetailSettingsTab } from './DetailSettingsTab';
import { DetailLogsTab } from './DetailLogsTab';

type TabKey = 'info' | 'code' | 'settings' | 'logs';

export function DetailApp({ id }: { id: string }) {
  const { script, setScript, errors, notFound, loading } = useScriptDetail(id);
  const [tab, setTab] = useState<TabKey>('info');
  const [message, setMessage] = useState('');
  const [iconFailed, setIconFailed] = useState(false);
  // 切换脚本时重置头像加载失败标记
  useEffect(() => { setIconFailed(false); }, [id]);

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
      <header className="detail__topbar">
        {meta.iconURL && !iconFailed ? (
          <img className="detail__avatar" src={meta.iconURL} alt="" onError={() => setIconFailed(true)} />
        ) : (
          <span className="detail__avatar detail__avatar--fallback" aria-hidden>{avatarChar}</span>
        )}
        <div className="detail__headtext">
          <h1 className="detail__h1" title={script.name}>{script.name || '未命名脚本'}</h1>
          {subtitleParts.length > 0 && <div className="detail__subtitle">{subtitleParts.join(' · ')}</div>}
        </div>
        {links.length > 0 && (
          <div className="detail__links">
            {links.map((l) => (
              <Button
                key={l.label}
                variant="ghost"
                className="btn--icon"
                aria-label={l.label}
                title={`${l.label}：${l.url}`}
                onClick={() => void browser.tabs.create({ url: l.url })}
              >
                {l.icon}
              </Button>
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
          {tab === 'info' && <DetailInfoTab script={script} onChanged={onScriptChanged} onDelete={remove} />}
          {tab === 'code' && <DetailCodeTab script={script} onSaved={(s) => setScript(s)} />}
          {tab === 'settings' && <DetailSettingsTab id={script.id} />}
          {tab === 'logs' && <DetailLogsTab id={script.id} errors={errors} />}
        </div>
      </div>
    </div>
  );
}
