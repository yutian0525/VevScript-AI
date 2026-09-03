// components/detail/DetailInfoTab.tsx
// 详情 Tab：元信息（mono 键 + sans 值）+ grant 分色列表 + 脚本级操作（重载/导出）。
// 脚本名已在顶栏 h1 展示，此处不重复（避免与顶栏标题重复渲染）。
import { useEffect, useState } from 'react';
import { Check, Download, RotateCw, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { classifyGrants } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

/** 详情页自身是 active tab，不能只查 active——要找最近的普通网页标签。 */
async function findReloadTarget(): Promise<number | null> {
  // 先试当前窗口的非扩展页（用户大概率想刷的就是刚操作过的页），没有再全量找最近访问的
  const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const inWindow = tabs.find((t) => t.url != null && !t.url.startsWith('chrome-extension://'));
  if (inWindow?.id != null) return inWindow.id;
  const all = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const recent = all
    .filter((t) => t.id != null)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  return recent?.id ?? null;
}

export function DetailInfoTab({ script }: { script: UserScript }) {
  const meta = script.meta ?? {};
  const [reloadTargetId, setReloadTargetId] = useState<number | null>(null);

  // 挂载时查一次目标页：无普通网页标签时禁用「重载当前页」
  useEffect(() => {
    let cancelled = false;
    void findReloadTarget().then((id) => { if (!cancelled) setReloadTargetId(id); });
    return () => { cancelled = true; };
  }, []);

  async function reloadActivePage(): Promise<void> {
    const id = reloadTargetId ?? (await findReloadTarget());
    if (id != null) await browser.tabs.reload(id);
  }

  function exportFile(): void {
    const url = URL.createObjectURL(new Blob([script.text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(script.name || 'script').replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="detail__tabcard">
      {meta.version && <div className="detail__inforow"><span className="mono">version</span><span>{meta.version}</span></div>}
      {meta.author && <div className="detail__inforow"><span className="mono">author</span><span>{meta.author}</span></div>}
      {meta.description && <div className="detail__inforow"><span className="mono">description</span><span>{meta.description}</span></div>}
      <div className="detail__inforow"><span className="mono">match</span><span className="mono">{script.matches.length > 0 ? script.matches.join('  ') : '（无——脚本不会运行）'}</span></div>
      <div className="detail__inforow"><span className="mono">run-at · world</span><span className="mono">{script.runAt} · {script.world}</span></div>
      {meta.grants && meta.grants.length > 0 && (
        <div className="detail__inforow">
          <span className="mono">grant</span>
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
        <Button
          onClick={() => void reloadActivePage()}
          disabled={reloadTargetId == null}
          title={reloadTargetId == null ? '无可重载的网页' : undefined}
        >
          <RotateCw size={14} /> 重载当前页
        </Button>
        <Button onClick={exportFile}><Download size={14} /> 导出 .user.js</Button>
      </div>
    </div>
  );
}
