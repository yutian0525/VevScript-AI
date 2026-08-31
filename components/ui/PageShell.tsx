// components/ui/PageShell.tsx
import type { ReactNode } from 'react';

export function PageShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h1>
        <div style={{ display: 'flex', gap: 8 }}>{actions}</div>
      </header>
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>{children}</div>
    </div>
  );
}
