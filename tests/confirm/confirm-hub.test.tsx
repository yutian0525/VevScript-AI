// tests/confirm/confirm-hub.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { applyConfirmEvent } from '../../components/confirm/confirm-reducer';
import { ConfirmCard } from '../../components/confirm/ConfirmCard';
import type { ConfirmRequest } from '../../shared/confirm';

afterEach(cleanup);

function mk(over: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    confirmId: 'c1', kind: 'connect', title: '跨域请求确认', message: '脚本「S」请求跨域访问',
    rows: [{ label: '主机', value: 'api.example.com', mono: true }],
    actions: [
      { decision: 'allow-once', label: '允许一次', variant: 'primary' },
      { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
    ],
    createdAt: Date.now(), timeoutMs: 60_000, ...over,
  };
}

describe('applyConfirmEvent reducer', () => {
  it('CONFIRM_PENDING 追加', () => {
    const next = applyConfirmEvent([], { type: 'CONFIRM_PENDING', confirm: mk() });
    expect(next).toHaveLength(1);
  });
  it('CONFIRM_PENDING 幂等（同 confirmId 不重复追加）', () => {
    const s1 = applyConfirmEvent([], { type: 'CONFIRM_PENDING', confirm: mk() });
    const s2 = applyConfirmEvent(s1, { type: 'CONFIRM_PENDING', confirm: mk() });
    expect(s2).toHaveLength(1);
  });
  it('CONFIRM_RESOLVED 移除', () => {
    const s1 = applyConfirmEvent([], { type: 'CONFIRM_PENDING', confirm: mk() });
    const s2 = applyConfirmEvent(s1, { type: 'CONFIRM_RESOLVED', confirmId: 'c1' });
    expect(s2).toHaveLength(0);
  });
  it('未知 type 原样返回', () => {
    const s1 = applyConfirmEvent([], { type: 'CONFIRM_PENDING', confirm: mk() });
    const s2 = applyConfirmEvent(s1, { type: 'OTHER' } as never);
    expect(s2).toBe(s1);
  });
});

describe('ConfirmCard', () => {
  it('渲染 title/message/rows + 点按钮回传 decision', () => {
    const onDecide = vi.fn();
    render(<ConfirmCard confirm={mk()} onDecide={onDecide} />);
    expect(screen.getByText('跨域请求确认')).toBeTruthy();
    expect(screen.getByText('api.example.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
    expect(onDecide).toHaveBeenCalledWith('allow-once');
  });
  it('countdown 按钮显示剩余秒数', () => {
    const onDecide = vi.fn();
    render(<ConfirmCard confirm={mk({ createdAt: Date.now(), timeoutMs: 60_000 })} onDecide={onDecide} />);
    const btn = screen.getByRole('button', { name: /拒绝/ });
    expect(/拒绝（\d+s）/.test(btn.textContent ?? '')).toBe(true);
  });
});
