// tests/scripts/ScriptDetailView.test.tsx
// 复现 React #185（Maximum update depth exceeded）：进入无错误记录的脚本详情页时，
// ScriptDetailView 里 `useScripts((s) => s.errors[id] ?? [])` 在 errors[id] 不存在时
// 每次都会新建数组——zustand v5 用原生 useSyncExternalStore，selector 必须返回稳定引用，
// 否则 React 判定快照永远在变 → 无限重渲染。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ScriptDetailView } from '../../components/scripts/ScriptDetailView';
import { useScripts } from '../../stores/scripts';
import type { UserScript } from '../../shared/types';

afterEach(cleanup);

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1',
    text: '// ==UserScript==\n// @name 测试脚本\n// @match *://*/*\n// ==/UserScript==\nconsole.log(1);',
    name: '测试脚本',
    enabled: true,
    matches: ['*://*/*'],
    code: "console.log(1);",
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    source: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('ScriptDetailView', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useScripts.setState({ errors: {} });
  });

  it('该脚本没有错误记录时也能正常渲染（不因 errors 选择器新建数组引发无限重渲染）', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _sender, sendResponse) => {
      if (msg.type === 'SCRIPTS_GET') {
        sendResponse({ ok: true, data: { script: mkScript() } });
        return true;
      }
      sendResponse({ ok: false, error: 'unexpected' });
      return true;
    });

    render(<ScriptDetailView id="s1" />);

    expect(await screen.findByText('测试脚本')).toBeTruthy();
  });
});
