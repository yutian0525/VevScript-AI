// tests/settings/settings-view.test.tsx
// 设置枢纽壳测试：列表页三入口 → 二级页 → 返回列表。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { SettingsView } from '../../components/settings/SettingsView';

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('SettingsView 壳', () => {
  it('默认渲染列表页各入口', async () => {
    render(<SettingsView />);
    expect(await screen.findByText('模型设置')).toBeTruthy();
    expect(screen.getByText('系统提示词')).toBeTruthy();
    expect(screen.getByText('工具调试台')).toBeTruthy();
    expect(screen.getByText('脚本运行时调试台')).toBeTruthy();
  });

  it('点「工具调试台」入口进二级页（TOOLBENCH），返回回列表', async () => {
    render(<SettingsView />);
    fireEvent.click(await screen.findByText('工具调试台'));
    expect(await screen.findByText('TOOLBENCH')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('返回'));
    expect(await screen.findByText('脚本运行时调试台')).toBeTruthy(); // 回到了列表
  });
});
