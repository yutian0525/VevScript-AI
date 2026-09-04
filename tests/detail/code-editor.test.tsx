// tests/detail/code-editor.test.tsx
// CodeEditor 挂载契约：真实 CM6 挂于 jsdom（官方支持基础挂载，无布局断言）。
// 交互细节（行号/高亮/自动缩进/Ctrl+S）依赖真实布局，由构建后手动核对兜底。
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CodeEditor } from '../../components/detail/CodeEditor';

afterEach(cleanup);

describe('CodeEditor（真实 CM6 挂载于 jsdom）', () => {
  it('挂载：host 内出现 .cm-editor，host 带 role=textbox + aria-label', () => {
    const { container } = render(
      <CodeEditor value="let a = 1;" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />,
    );
    const host = screen.getByLabelText('脚本源码');
    expect(host.getAttribute('role')).toBe('textbox');
    expect(container.querySelector('.cm-editor')).toBeTruthy();
    expect(container.querySelector('.cm-content')?.textContent).toBe('let a = 1;');
  });

  it('value 变化 rerender：doc 同步且视图存活', () => {
    const { container, rerender } = render(
      <CodeEditor value="v1" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />,
    );
    rerender(<CodeEditor value="v2" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />);
    expect(container.querySelector('.cm-content')?.textContent).toBe('v2');
  });

  it('卸载不抛错（EditorView.destroy 清理）', () => {
    const { unmount } = render(
      <CodeEditor value="x" onChange={() => {}} onSave={() => {}} ariaLabel="脚本源码" />,
    );
    expect(() => unmount()).not.toThrow();
  });
});
