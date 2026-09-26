// tests/shared/mcp-summary.test.ts
// 聚合视图是输入坞状态钮与设置页表头的共同数据源：判定优先级错一位，
// 用户看到的颜色就与真实状态错位（例如「3 台全连上」却显示灰色）。
import { describe, expect, it } from 'vitest';
import { mcpTone, MCP_STATUS_LABEL, summarizeMcp } from '../../shared/mcp';
import type { McpServerState, McpStatus, McpStatusItem } from '../../shared/mcp';

function item(status: McpStatus, opts: { enabled?: boolean; tools?: number } = {}): McpStatusItem {
  const state: McpServerState = {
    id: `${status}-${opts.enabled ?? true}-${opts.tools ?? 0}`,
    status,
    tools: Array.from({ length: opts.tools ?? 0 }, (_, i) => ({ name: `t${i}`, exposedName: `mcp__x__t${i}` })),
  };
  return {
    ...state,
    name: 'demo',
    url: 'https://mcp.example.com/mcp',
    transport: 'auto',
    enabled: opts.enabled ?? true,
  };
}

describe('mcpTone', () => {
  it('状态 → 色档一一对应', () => {
    expect(mcpTone('connected')).toBe('ok');
    expect(mcpTone('connecting')).toBe('busy');
    expect(mcpTone('error')).toBe('warn');
    expect(mcpTone('disabled')).toBe('off');
    expect(mcpTone('idle')).toBe('idle');
  });

  it('每个状态都有中文标签（漏一个界面上就是空白胶囊）', () => {
    for (const s of ['connected', 'connecting', 'idle', 'error', 'disabled'] as McpStatus[]) {
      expect(MCP_STATUS_LABEL[s]).toBeTruthy();
    }
  });
});

describe('summarizeMcp', () => {
  it('空列表 → empty，标签「未配置」', () => {
    const s = summarizeMcp([]);
    expect(s.tone).toBe('empty');
    expect(s.label).toBe('未配置');
    expect(s.total).toBe(0);
  });

  it('全部禁用 → off（不是 idle：禁用是用户的主动选择，不是掉线）', () => {
    const s = summarizeMcp([item('disabled', { enabled: false }), item('disabled', { enabled: false })]);
    expect(s.tone).toBe('off');
    expect(s.live).toBe(0);
    expect(s.total).toBe(2);
  });

  it('有异常就报异常，即使其余都已连接', () => {
    const s = summarizeMcp([item('connected', { tools: 3 }), item('error', { tools: 2 })]);
    expect(s.tone).toBe('warn');
    expect(s.label).toBe('1 台异常');
    expect(s.online).toBe(1);
    // 异常那台的工具数不计入可用（它当前调不动）
    expect(s.tools).toBe(5);
  });

  it('连接中优先于「部分未连接」，且异常优先于连接中', () => {
    expect(summarizeMcp([item('connected'), item('connecting')]).tone).toBe('busy');
    expect(summarizeMcp([item('connecting'), item('error')]).tone).toBe('warn');
  });

  it('全部连上 → ok，工具数只统计启用中的服务', () => {
    const s = summarizeMcp([item('connected', { tools: 2 }), item('connected', { tools: 1 }), item('disabled', { enabled: false, tools: 9 })]);
    expect(s.tone).toBe('ok');
    expect(s.label).toBe('2 台已连接');
    expect(s.tools).toBe(3);
    expect(s.live).toBe(2);
    expect(s.total).toBe(3);
  });

  it('部分未连接 → idle，文案报未连台数', () => {
    const s = summarizeMcp([item('connected'), item('idle')]);
    expect(s.tone).toBe('idle');
    expect(s.label).toBe('1 台未连接');
  });
});
