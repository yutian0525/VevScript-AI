// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Markdown } from '../../components/chat/Markdown';

afterEach(cleanup);

describe('Markdown 组件', () => {
  it('标题渲染为对应层级', () => {
    render(<Markdown text={'## 标题二'} />);
    expect(screen.getByRole('heading', { level: 2, name: '标题二' })).toBeTruthy();
  });

  it('粗体渲染为 strong', () => {
    render(<Markdown text={'**加粗**'} />);
    expect(screen.getByText('加粗').tagName).toBe('STRONG');
  });

  it('无序列表渲染 li', () => {
    render(<Markdown text={'- 甲\n- 乙'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('GFM 表格渲染 thead/tbody', () => {
    render(<Markdown text={'| a | b |\n| --- | --- |\n| 1 | 2 |'} />);
    expect(document.querySelector('table thead')).toBeTruthy();
    expect(document.querySelector('table tbody tr')).toBeTruthy();
  });

  it('代码块渲染 pre 且不丢内容', () => {
    render(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toContain('const a = 1;');
  });

  it('行内 code 有 md-code 类', () => {
    render(<Markdown text={'行内 `code` 片段'} />);
    const code = document.querySelector('code.md-code');
    expect(code?.textContent).toBe('code');
    // hast node prop 不得泄漏进 DOM（react-markdown 会注入 node，覆盖组件须解构掉）
    expect(code?.hasAttribute('node')).toBe(false);
  });

  it('原始 HTML 不执行：script/img 均不出现', () => {
    render(<Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>'} />);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('链接 _blank + noreferrer', () => {
    render(<Markdown text={'[点我](https://example.com)'} />);
    const a = screen.getByRole('link', { name: '点我' }) as HTMLAnchorElement;
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noreferrer noopener');
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.hasAttribute('node')).toBe(false);
  });

  it('javascript: 链接被过滤（安全 href 被清空时锚点退化，无链接语义）', () => {
    render(<Markdown text={'[坏链](javascript:alert(1))'} />);
    // react-markdown 默认 urlTransform 已把危险 scheme 的 href 清空（href=""），
    // 此时 role=link 不可达。退而断言：href 不含 javascript、无可用链接角色。
    const a = document.querySelector('a');
    expect(a).toBeTruthy();
    expect(a?.getAttribute('href')).not.toContain('javascript');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('空文本不渲染内容', () => {
    const { container } = render(<Markdown text={''} />);
    expect(container.querySelector('.md')?.textContent ?? '').toBe('');
  });

  it('流式增量：未闭合标记渲染为纯文本，闭合后渲染为 strong', () => {
    const { rerender } = render(<Markdown text={'**bo'} />);
    expect(screen.getByText('**bo')).toBeTruthy();
    rerender(<Markdown text={'**bold**'} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });
});

describe('Markdown 流式状态', () => {
  it('streaming=true 时容器带 md--live 类（caret 由 CSS 伪元素渲染）', () => {
    render(<Markdown text={'回复中'} streaming />);
    expect(document.querySelector('.md.md--live')).toBeTruthy();
  });
  it('streaming 缺省时无 md--live 类', () => {
    render(<Markdown text={'回复完成'} />);
    expect(document.querySelector('.md.md--live')).toBeNull();
  });
});
