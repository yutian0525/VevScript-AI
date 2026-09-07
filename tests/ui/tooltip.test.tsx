// tests/ui/tooltip.test.tsx
// 全局 Tooltip：默认不渲染气泡、hover 显示、disabled 恒不显示、保留子元素事件、aria-describedby 关联。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { Tooltip } from '../../components/ui/Tooltip';

afterEach(cleanup);

describe('Tooltip', () => {
  it('默认不渲染气泡；hover 后显示 label', async () => {
    render(
      <Tooltip label="提示文案">
        <button>触发</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button'));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('提示文案');
    // 移出立即隐藏
    fireEvent.mouseLeave(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('disabled=true：hover 也不显示气泡（如短文本未截断）', async () => {
    render(
      <Tooltip label="不该出现" disabled>
        <button>触发</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByRole('button'));
    // 等一拍确保不是时序假阴
    await new Promise((r) => setTimeout(r, 160));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('label 为空：不挂 tooltip，子元素照常渲染', () => {
    render(
      <Tooltip label="">
        <button>纯按钮</button>
      </Tooltip>,
    );
    expect(screen.getByRole('button', { name: '纯按钮' })).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('保留子元素自身的 onClick（Tooltip 只叠加 hover/focus）', () => {
    const onClick = vi.fn();
    render(
      <Tooltip label="提示">
        <button onClick={onClick}>点我</button>
      </Tooltip>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('打开时子元素经 aria-describedby 关联气泡 id', async () => {
    render(
      <Tooltip label="无障碍描述">
        <button>触发</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button');
    fireEvent.focus(btn);
    const tip = await screen.findByRole('tooltip');
    expect(btn.getAttribute('aria-describedby')).toBe(tip.id);
  });
});
