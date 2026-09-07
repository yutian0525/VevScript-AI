// components/ui/PageShell.tsx
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTruncated } from './useTruncated';
import { Tooltip } from './Tooltip';

export function PageShell({
  title,
  eyebrow,
  right,
  actions,
  onBack,
  backLabel = '返回',
  children,
}: {
  title: string;
  /** 页眉标题上方的机器标签（mono 大写），如 AGENT / TOOLBENCH */
  eyebrow?: string;
  /** 页眉右侧状态槽（如 Live 仪表条） */
  right?: ReactNode;
  /** 页眉右侧操作按钮 */
  actions?: ReactNode;
  /** 传入则在标题左侧渲染统一的方形返回钮（二级页/详情页） */
  onBack?: () => void;
  /** 返回钮的无障碍标签与 tooltip 文案 */
  backLabel?: string;
  children: ReactNode;
}) {
  // 只有真被截断才挂 tooltip：否则短标题也会弹一个和眼前一模一样的提示
  const [titleRef, titleTruncated] = useTruncated<HTMLHeadingElement>(title);
  return (
    <div className="shell">
      <header className="shell__head">
        <div className="shell__lead">
          {onBack && (
            <Tooltip label={backLabel}>
              <button type="button" className="shell__back" aria-label={backLabel} onClick={onBack}>
                <ArrowLeft size={16} />
              </button>
            </Tooltip>
          )}
          <div className="shell__titles">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <Tooltip label={title} disabled={!titleTruncated}>
              <h1 className="shell__title" ref={titleRef}>{title}</h1>
            </Tooltip>
          </div>
        </div>
        <div className="shell__actions">
          {right}
          {actions}
        </div>
      </header>
      <div className="shell__body">{children}</div>
    </div>
  );
}
