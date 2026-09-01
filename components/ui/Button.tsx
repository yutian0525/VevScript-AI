// components/ui/Button.tsx
import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'signal' | 'danger' | 'ghost';
}

const CLASS: Record<NonNullable<Props['variant']>, string> = {
  primary: 'btn btn--primary',
  secondary: 'btn',
  signal: 'btn btn--signal',
  danger: 'btn btn--danger',
  ghost: 'btn btn--ghost',
};

export function Button({ variant = 'secondary', className, ...rest }: Props) {
  return <button className={`${CLASS[variant]}${className ? ` ${className}` : ''}`} {...rest} />;
}
