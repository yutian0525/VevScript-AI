// tests/ui/tool-confirm-card.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ToolConfirmCard } from '../../components/chat/ToolConfirmCard';

afterEach(cleanup);

const FUTURE = Date.now() + 120_000;

describe('ToolConfirmCard', () => {
  it('渲染工具名、敏感风险标签与三按钮', () => {
    render(<ToolConfirmCard name="evaluate_script" args="{}" until={FUTURE} onDecide={() => {}} />);
    expect(screen.getByRole('alertdialog', { name: /evaluate_script/ })).toBeInTheDocument();
    expect(screen.getByText('敏感')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许执行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本次会话总是允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
  });

  it('微操工具标签为写入', () => {
    render(<ToolConfirmCard name="fill" args="{}" until={FUTURE} onDecide={() => {}} />);
    expect(screen.getByText('写入')).toBeInTheDocument();
  });

  it('点击决策回传并锁定全部按钮（防双击）', () => {
    const onDecide = vi.fn();
    render(<ToolConfirmCard name="evaluate_script" args="{}" until={FUTURE} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onDecide).toHaveBeenCalledWith('deny');
    expect(screen.getByRole('button', { name: '允许执行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '本次会话总是允许' })).toBeDisabled();
  });

  it('截止时间已过显示已超时（本地不做决策，权威收尾来自后台）', () => {
    render(<ToolConfirmCard name="x" args="{}" until={Date.now() - 1000} onDecide={() => {}} />);
    expect(screen.getByText('已超时')).toBeInTheDocument();
  });
});
