// components/detail/DetailInfoTab.tsx
// 详情 Tab：元信息（mono 键 + sans 值）+ grant 分色列表 + 脚本级操作（重载/导出）。
// 脚本名已在顶栏 h1 展示，此处不重复（避免与顶栏标题重复渲染）。
import { Check, Download, RotateCw, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { classifyGrants } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

export function DetailInfoTab({ script }: { script: UserScript }) {
  const meta = script.meta ?? {};

  async function reloadActivePage(): Promise<void> {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) await browser.tabs.reload(tab.id);
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
        <Button onClick={() => void reloadActivePage()}><RotateCw size={14} /> 重载当前页</Button>
        <Button onClick={exportFile}><Download size={14} /> 导出 .user.js</Button>
      </div>
    </div>
  );
}
