// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResultPanel } from '../../components/debug/ResultPanel';

afterEach(cleanup);

describe('ResultPanel', () => {
  it('工具成功：OK + ms + 数据', () => {
    render(<ResultPanel outcome={{ kind: 'result', resp: { dispatched: true, ms: 12, result: { ok: true, data: { a: 1 } } } }} />);
    expect(screen.getByText('OK')).toBeTruthy();
    expect(screen.getByText('12 ms')).toBeTruthy();
    expect(screen.getByText(/"a": 1/)).toBeTruthy();
  });

  it('工具失败：ERR + 错误文案', () => {
    render(<ResultPanel outcome={{ kind: 'result', resp: { dispatched: true, ms: 3, result: { ok: false, error: '炸了' } } }} />);
    expect(screen.getByText('ERR')).toBeTruthy();
    expect(screen.getByText('炸了')).toBeTruthy();
  });

  it('参数解析失败：ERR + 参数文案', () => {
    render(<ResultPanel outcome={{ kind: 'bad-args', message: '不是对象' }} />);
    expect(screen.getByText('ERR')).toBeTruthy();
    expect(screen.getByText(/参数解析失败：不是对象/)).toBeTruthy();
  });

  it('链路异常：ERR + 链路文案', () => {
    render(<ResultPanel outcome={{ kind: 'link-error', message: '断了' }} />);
    expect(screen.getByText(/链路异常：断了/)).toBeTruthy();
  });
});
