// components/ui/Input.tsx
import type { InputHTMLAttributes } from 'react';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '6px 10px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        fontSize: 13,
        outline: 'none',
        ...props.style,
      }}
    />
  );
}
