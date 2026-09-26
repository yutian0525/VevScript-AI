// tests/agent/mcp-registry.test.ts
// MCP 工具接入 registry 的接缝：清单合并规则 + executeTool 派发。
// bridge 用桩替换——这里只验证接缝行为，不牵扯真实连接。
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { buildToolSchemas, executeTool, getToolSchemas } from '../../agent/tools/registry';
import { setMcpBridge } from '../../agent/mcp/bridge';
import type { ToolSchema } from '../../agent/provider/types';
import type { ToolResult } from '../../shared/types';

const MCP_SCHEMA: ToolSchema = {
  type: 'function',
  function: { name: 'mcp__fs__read_file', description: '【MCP · fs】读文件', parameters: { type: 'object' } },
};

let toolSchemas = vi.fn<() => Promise<ToolSchema[]>>();
let callTool = vi.fn<(name: string, args: Record<string, unknown>) => Promise<ToolResult | null>>();

const ctx = { tabId: 1, sessionId: 's', signal: new AbortController().signal };

beforeEach(() => {
  toolSchemas = vi.fn();
  callTool = vi.fn();
  setMcpBridge({ toolSchemas, callTool: callTool as never });
});

describe('buildToolSchemas', () => {
  it('未注入 bridge → 纯内置，安全降级', async () => {
    setMcpBridge(null);
    expect(await buildToolSchemas()).toEqual(getToolSchemas());
  });

  it('内置在前、MCP 在后追加', async () => {
    toolSchemas.mockResolvedValue([MCP_SCHEMA]);
    const all = await buildToolSchemas();
    expect(all.length).toBe(getToolSchemas().length + 1);
    expect(all[all.length - 1]).toEqual(MCP_SCHEMA);
  });

  it('ask 模式不带 MCP 工具（外部服务证明不了只读）', async () => {
    toolSchemas.mockResolvedValue([MCP_SCHEMA]);
    const ask = await buildToolSchemas('ask');
    expect(ask.some((s) => s.function.name.startsWith('mcp__'))).toBe(false);
  });

  it('bridge 抛错 → 降级为纯内置，不让 agent 起不来', async () => {
    toolSchemas.mockRejectedValue(new Error('boom'));
    expect(await buildToolSchemas()).toEqual(getToolSchemas());
  });

  it('重名（极端情况）不会重复下发', async () => {
    toolSchemas.mockResolvedValue([{ type: 'function', function: { name: 'take_snapshot', description: '', parameters: {} } }]);
    const all = await buildToolSchemas();
    expect(all.filter((s) => s.function.name === 'take_snapshot')).toHaveLength(1);
  });
});

describe('executeTool 派发', () => {
  it('mcp__ 前缀交给 bridge，原样返回其结果', async () => {
    callTool.mockResolvedValue({ ok: true, data: '文件内容' });
    const r = await executeTool('mcp__fs__read_file', { path: '/a.txt' }, ctx);
    expect(callTool).toHaveBeenCalledWith('mcp__fs__read_file', { path: '/a.txt' }, { signal: ctx.signal });
    expect(r).toEqual({ ok: true, data: '文件内容' });
  });

  it('bridge 说没托管 → 回落「未知工具」', async () => {
    callTool.mockResolvedValue(null);
    const r = await executeTool('mcp__fs__nope', {}, ctx);
    expect(r).toEqual({ ok: false, error: '未知工具：mcp__fs__nope' });
  });

  it('未注入 bridge → 明确报 MCP 未初始化（不是笼统的未知工具）', async () => {
    setMcpBridge(null);
    const r = await executeTool('mcp__fs__read_file', {}, ctx);
    expect(r).toEqual({ ok: false, error: 'MCP 尚未初始化，工具 mcp__fs__read_file 不可用' });
  });

  it('MCP 工具不经过受限页预检（外部服务与当前页无关）', async () => {
    callTool.mockResolvedValue({ ok: true, data: 'ok' });
    // tabId 999 不存在：若走了预检分支，tabs.get 会 reject 并把 url 置空后落到未知工具分支
    const r = await executeTool('mcp__fs__read_file', {}, { ...ctx, tabId: 999 });
    expect(r).toEqual({ ok: true, data: 'ok' });
  });

  it('内置工具不受影响（不误入 MCP 分支）', async () => {
    const r = await executeTool('nonexistent', {}, ctx);
    expect(callTool).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: false, error: '未知工具：nonexistent' });
  });
});
