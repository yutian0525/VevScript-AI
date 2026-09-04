// tests/detail/detail-tab-parts.test.tsx
// DetailTabHeader（主标题+后缀+副题）与 DetailEmptyCard（空态卡）纯渲染。
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ShieldOff } from 'lucide-react';
import { DetailTabHeader } from '../../components/detail/DetailTabHeader';
import { DetailEmptyCard } from '../../components/detail/DetailEmptyCard';

afterEach(cleanup);

describe('DetailTabHeader', () => {
  it('渲染 h2 主标题 + p 副题', () => {
    render(<DetailTabHeader title="XHR 安全" hint="副题说明" />);
    expect(screen.getByRole('heading', { level: 2, name: 'XHR 安全' })).toBeTruthy();
    expect(screen.getByText('副题说明')).toBeTruthy();
  });
  it('suffix 渲染为标题内 mono 后缀；缺省不渲染', () => {
    const { rerender } = render(<DetailTabHeader title="错误日志" suffix="0 条" hint="副题" />);
    expect(screen.getByText('0 条')).toBeTruthy();
    rerender(<DetailTabHeader title="错误日志" hint="副题" />);
    expect(screen.queryByText('0 条')).toBeNull();
  });
});

describe('DetailEmptyCard', () => {
  it('渲染图标 + 主文案 + 副文案', () => {
    render(<DetailEmptyCard icon={ShieldOff} title="无已授权域名" hint="脚本请求跨域时将逐次询问" />);
    expect(screen.getByText('无已授权域名')).toBeTruthy();
    expect(screen.getByText('脚本请求跨域时将逐次询问')).toBeTruthy();
    expect(document.querySelector('.detail__empty-icon svg')).toBeTruthy(); // lucide 图标已渲染
  });
});
