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
  // fake-browser 未实现 getManifest；关于页读版本号需桩掉
  (browser.runtime as unknown as { getManifest: () => { version: string } }).getManifest = () => ({ version: '1.0.0' });
});
afterEach(cleanup);

describe('SettingsView 壳', () => {
  it('默认渲染列表页各入口', async () => {
    render(<SettingsView />);
    expect(await screen.findByText('模型设置')).toBeTruthy();
    expect(screen.getByText('系统提示词')).toBeTruthy();
    expect(screen.getByText('AI 记忆')).toBeTruthy();
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

  it('点「AI 记忆」入口进二级页（MEMORY），返回回列表', async () => {
    render(<SettingsView />);
    fireEvent.click(await screen.findByText('AI 记忆'));
    expect(await screen.findByText('MEMORY')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('返回设置'));
    expect(await screen.findByText('模型设置')).toBeTruthy();
  });

  it('点「关于软件」入口进二级页（ABOUT），含官网/开源仓库/问题反馈链接，返回回列表', async () => {
    render(<SettingsView />);
    fireEvent.click(await screen.findByText('关于软件'));
    expect(await screen.findByText('ABOUT')).toBeTruthy();
    expect(screen.getByText('官方网站')).toBeTruthy();
    expect(screen.getByText('开源仓库')).toBeTruthy();
    expect(screen.getByText('问题反馈')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('返回设置'));
    expect(await screen.findByText('模型设置')).toBeTruthy();
  });

  it('关于页官网链接点击开新标签页到 vevscript.yutkit.com', async () => {
    const createSpy = vi.fn().mockResolvedValue({});
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    render(<SettingsView />);
    fireEvent.click(await screen.findByText('关于软件'));
    fireEvent.click(await screen.findByText('官方网站'));
    expect(createSpy).toHaveBeenCalledWith({ url: 'https://vevscript.yutkit.com' });
  });
});
