// components/detail/DetailApp.tsx
// 全屏脚本详情页（spec §2）：顶栏（switch+关闭）+ 左栏导航（详情/代码/设置/日志 N + 删除）+ 四 Tab。
// Tab 式切换（用户选定）：每 Tab 独占内容区。
import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest, useScripts } from '../../stores/scripts';
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

  async function toggleEnabled(): Promise<void> {
    if (!script) return;
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
      type: 'SCRIPTS_SET_ENABLED', id: script.id, enabled: !script.enabled,
    });
    if (resp.ok && resp.data) {
      setScript(resp.data.script);
      setMessage(resp.data.script.enabled ? '已启用，刷新页面生效' : '已禁用，刷新页面生效');
    } else setMessage(resp.error ?? '操作失败');
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

  const TABS: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'info', label: '详情' },
    { key: 'code', label: '代码' },
    { key: 'settings', label: '设置' },
    { key: 'logs', label: '日志', count: errors.length },
  ];

  return (
    <div className="detail">
      <header className="detail__topbar">
        <span className="eyebrow">SCRIPT</span>
        <h1 className="detail__title" title={script.name}>{script.name || '未命名脚本'}</h1>
        <button
          type="button" role="switch" aria-checked={script.enabled}
          aria-label={`${script.enabled ? '禁用' : '启用'} 脚本`}
          className={`switch${script.enabled ? ' switch--on' : ''}`}
          onClick={() => void toggleEnabled()}
        >
          <span className="switch__thumb" aria-hidden />
        </button>
        <Button variant="ghost" className="btn--icon" aria-label="关闭" onClick={() => window.close()}>
          <X size={16} />
        </Button>
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
          <div className="detail__side-spacer" />
          <button type="button" className="detail__navitem detail__navitem--danger" onClick={() => void remove()}>删除</button>
        </nav>
        <div className="detail__content">
          {message && <div className="scripts-warnline" role="status">{message}</div>}
          {tab === 'info' && <DetailInfoTab script={script} />}
          {tab === 'code' && <DetailCodeTab script={script} onSaved={async () => { await useScripts.getState().refresh(); }} />}
          {tab === 'settings' && <DetailSettingsTab id={script.id} />}
          {tab === 'logs' && <DetailLogsTab id={script.id} errors={errors} />}
        </div>
      </div>
    </div>
  );
}
