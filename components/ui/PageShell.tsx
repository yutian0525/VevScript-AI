// components/ui/PageShell.tsx
import type { ReactNode } from 'react';

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
  return (
    <div className="shell">
      <header className="shell__head">
        <div className="shell__titles">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1 className="shell__title">{title}</h1>
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
