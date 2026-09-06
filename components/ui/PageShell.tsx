// components/ui/PageShell.tsx
import type { ReactNode } from 'react';
import { useTruncated } from './useTruncated';

export function PageShell({
  title,
  eyebrow,
  right,
  actions,
  children,
}: {
  title: string;
  /** 页眉标题上方的机器标签（mono 大写），如 AGENT / TOOLBENCH */
  eyebrow?: string;
  /** 页眉右侧状态槽（如 Live 仪表条） */
  right?: ReactNode;
  /** 页眉右侧操作按钮 */
  actions?: ReactNode;
  children: ReactNode;
}) {
  // 只有真被截断才挂 title：否则短标题也会弹一个和眼前一模一样的 tooltip
  const [titleRef, titleTruncated] = useTruncated<HTMLHeadingElement>(title);
  return (
    <div className="shell">
      <header className="shell__head">
        <div className="shell__titles">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1 className="shell__title" ref={titleRef} title={titleTruncated ? title : undefined}>{title}</h1>
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
