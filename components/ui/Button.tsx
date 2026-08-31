// components/ui/Button.tsx
import type { ButtonHTMLAttributes, CSSProperties } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
}

const base: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid',
  fontSize: 13,
  cursor: 'pointer',
  background: 'transparent',
};

const variants: Record<NonNullable<Props['variant']>, CSSProperties> = {
  primary: { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' },
  secondary: { background: '#fff', borderColor: 'var(--border)', color: 'var(--fg)' },
  danger: { background: '#fff', borderColor: '#dc2626', color: '#dc2626' },
};

export function Button({ variant = 'secondary', style, ...rest }: Props) {
  return <button style={{ ...base, ...variants[variant], ...style }} {...rest} />;
}
