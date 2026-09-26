// tests/background/mcp.test.ts
// MCP 后台管理器的编排：状态机流转、工具清单投影、调用派发、路由 handler。
// 真实 client 用 mock 顶掉——这里只验证「谁在什么时候连/断/广播」，协议本身另有单测。
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../background/router';
import { initMcpModule } from '../../background/mcp';
import { newMcpServer, listMcpServers, removeMcpServer } from '../../storage/mcp';
import { getMcpBridge, setMcpBridge } from '../../agent/mcp/bridge';
import type { McpToolDef } from '../../shared/mcp';

const createMcpClient = vi.fn();
vi.mock('../../agent/mcp/client', () => ({ createMcpClient: (...a: unknown[]) => createMcpClient(...a) }));

let router: MessageRouter;
const send = (msg: Record<string, unknown>): Promise<any> =>
  router.dispatch({ type: 'X', ...msg } as never);

function fakeClient(tools: McpToolDef[], opts?: { failConnect?: boolean; failCall?: boolean }) {
  return {
    transport: 'streamable' as const,
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'demo', version: '1.0.0' },
    connect: async () => { if (opts?.failConnect) throw new Error('连接被拒绝'); },
    listTools: async () => tools,
    callTool: async (name: string, args: Record<string, unknown>) => {
      if (opts?.failCall) throw new Error('连接已断开');
      return { content: [{ type: 'text', text: `${name}(${JSON.stringify(args)})` }] };
    },
    close: () => {},
  };
}

const TOOLS: McpToolDef[] = [{ name: 'read_file', description: '读文件', inputSchema: { type: 'object' } }];

async function resetAll(): Promise<void> {
  for (const s of await listMcpServers()) await removeMcpServer(s.id);
  createMcpClient.mockReset();
  await send({ type: 'MCP_LIST' }); // 触发 syncFromStorage，清掉内存表
}

beforeEach(async () => {
  router = new MessageRouter();
  setMcpBridge(null);
  initMcpModule(router);
  await resetAll();
});

async function addServer(name: string, url: string) {
  return send({ type: 'MCP_SAVE', server: newMcpServer({ name, url }) }) as Promise<{ data: any[] }>;
}

describe('连接与状态机', () => {
  it('保存后自动连接：状态 connected，工具数正确', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    const { data } = await addServer('fs', 'https://mcp.example.com/mcp');
    expect(data[0]!.status).toBe('connected');
    expect(data[0]!.tools).toHaveLength(1);
    expect(data[0]!.tools[0]!.exposedName).toBe('mcp__fs__read_file');
    expect(data[0]!.protocolVersion).toBe('2025-06-18');
  });

  it('连接失败 → error 态并带原因，不连第二次（等用户重连）', async () => {
    createMcpClient.mockReturnValue(fakeClient([], { failConnect: true }));
    const { data } = await addServer('bad', 'https://bad.example.com/mcp');
    expect(data[0]!.status).toBe('error');
    expect(data[0]!.error).toContain('连接被拒绝');
  });

  it('error 态不会在拉工具时反复重试（避免每轮打挂外部服务）', async () => {
    createMcpClient.mockReturnValue(fakeClient([], { failConnect: true }));
    await addServer('bad', 'https://bad.example.com/mcp');
    const before = createMcpClient.mock.calls.length;
    const schemas = await getMcpBridge()!.toolSchemas();
    expect(schemas).toEqual([]);
    expect(createMcpClient.mock.calls.length).toBe(before);
  });

  it('error 态下显式重连可以恢复', async () => {
    createMcpClient.mockReturnValue(fakeClient([], { failConnect: true }));
    const first = await addServer('bad', 'https://bad.example.com/mcp');
    expect(first.data[0]!.status).toBe('error');
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    const r = await send({ type: 'MCP_CONNECT', id: first.data[0]!.id });
    expect(r.ok).toBe(true);
    expect(r.data[0]!.status).toBe('connected');
  });

  it('禁用的服务不建客户端', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    const r = await send({
      type: 'MCP_SAVE',
      server: newMcpServer({ name: 'off', url: 'https://off.example.com', enabled: false }),
    });
    expect(r.data[0]!.status).toBe('disabled');
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  it('禁用已连的服务 → 断开并回到 disabled', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    const saved = await addServer('fs', 'https://mcp.example.com/mcp');
    const id = saved.data[0]!.id;
    const r = await send({ type: 'MCP_SET_ENABLED', id, enabled: false });
    expect(r.data[0]!.status).toBe('disabled');
    expect(r.data[0]!.tools).toHaveLength(0);
  });

  it('改 URL 会断掉旧连接（旧连接指向别处，不能继续用）', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    const saved = await addServer('fs', 'https://a.example.com/mcp');
    const id = saved.data[0]!.id;
    const r = await send({
      type: 'MCP_SAVE',
      server: { ...newMcpServer({ name: 'fs', url: 'https://b.example.com/mcp' }), id },
    });
    expect(r.data[0]!.status).toBe('connected');
    expect(createMcpClient.mock.calls[1]![0].url).toBe('https://b.example.com/mcp');
  });

  it('删除后从状态列表里消失', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    const saved = await addServer('fs', 'https://mcp.example.com/mcp');
    const r = await send({ type: 'MCP_REMOVE', id: saved.data[0]!.id });
    expect(r.data).toHaveLength(0);
  });

  it('MCP_REFRESH 拉齐所有启用服务', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    await addServer('a', 'https://a.example.com/mcp');
    await send({
      type: 'MCP_SAVE',
      server: newMcpServer({ name: 'b', url: 'https://b.example.com/mcp', enabled: false }),
    });
    const r = await send({ type: 'MCP_REFRESH' });
    expect(r.data.map((x: any) => x.status)).toEqual(['connected', 'disabled']);
  });
});

describe('工具下发', () => {
  it('bridge 给出 mcp__ 前缀的 schema，描述带上服务名', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    await addServer('fs', 'https://mcp.example.com/mcp');
    const schemas = await getMcpBridge()!.toolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.function.name).toBe('mcp__fs__read_file');
    expect(schemas[0]!.function.description).toContain('fs');
  });

  it('禁用的服务不下发工具', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    await send({
      type: 'MCP_SAVE',
      server: newMcpServer({ name: 'off', url: 'https://off.example.com', enabled: false }),
    });
    expect(await getMcpBridge()!.toolSchemas()).toEqual([]);
  });

  it('两台服务同名工具各自带自己的 slug，不互相顶掉', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    await addServer('fs1', 'https://a.example.com/mcp');
    await addServer('fs2', 'https://b.example.com/mcp');
    const names = (await getMcpBridge()!.toolSchemas()).map((s) => s.function.name);
    expect(names).toEqual(['mcp__fs1__read_file', 'mcp__fs2__read_file']);
  });
});

describe('工具调用派发', () => {
  it('按暴露名找到服务并调用，返回文本', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    await addServer('fs', 'https://mcp.example.com/mcp');
    const r = await getMcpBridge()!.callTool('mcp__fs__read_file', { path: '/a.txt' });
    expect(r).toEqual({ ok: true, data: 'read_file({"path":"/a.txt"})' });
  });

  it('未托管的名字返回 null（交回 registry 走未知工具分支）', async () => {
    const r = await getMcpBridge()!.callTool('take_snapshot', {});
    expect(r).toBeNull();
  });

  it('调用时连接已死 → ok:false 且状态转 error（下次走重连）', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS, { failCall: true }));
    await addServer('fs', 'https://mcp.example.com/mcp');
    const r = await getMcpBridge()!.callTool('mcp__fs__read_file', {});
    expect(r?.ok).toBe(false);
    const list = await send({ type: 'MCP_LIST' });
    expect(list.data[0]!.status).toBe('error');
  });

  it('isError 的 MCP 结果转成 ok:false（不把错误当成功塞给模型）', async () => {
    createMcpClient.mockReturnValue({
      ...fakeClient(TOOLS),
      callTool: async () => ({ content: [{ type: 'text', text: '权限不足' }], isError: true }),
    });
    await addServer('fs', 'https://mcp.example.com/mcp');
    const r = await getMcpBridge()!.callTool('mcp__fs__read_file', {});
    expect(r).toEqual({ ok: false, error: '权限不足' });
  });
});

describe('试连与导入导出', () => {
  it('MCP_TEST 不落库、连完即关', async () => {
    const client = fakeClient(TOOLS);
    createMcpClient.mockReturnValue(client);
    const r = await send({
      type: 'MCP_TEST',
      server: newMcpServer({ name: 'tmp', url: 'https://tmp.example.com/mcp' }),
    });
    expect(r.data.tools).toBe(1);
    expect(await listMcpServers()).toHaveLength(0);
  });

  it('MCP_IMPORT 只落地 url 条目，stdio 条目进 warnings', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    const r = await send({
      type: 'MCP_IMPORT',
      text: JSON.stringify({
        mcpServers: {
          local: { command: 'npx', args: ['-y', 'x'] },
          remote: { url: 'https://remote.example.com/mcp' },
        },
      }),
    });
    expect(r.data.imported).toBe(1);
    expect(r.data.warnings.join()).toContain('stdio');
  });

  it('MCP_EXPORT 给出可回环的 JSON', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    await addServer('fs', 'https://mcp.example.com/mcp');
    const r = await send({ type: 'MCP_EXPORT' });
    expect(JSON.parse(r.data.text).mcpServers.fs.url).toBe('https://mcp.example.com/mcp');
  });
});

describe('状态广播', () => {
  it('状态变化后广播 MCP_STATE（面板据此实时刷新）', async () => {
    createMcpClient.mockReturnValue(fakeClient(TOOLS));
    const spy = vi.spyOn(browser.runtime, 'sendMessage');
    await addServer('fs', 'https://mcp.example.com/mcp');
    const hits = spy.mock.calls.filter((c) => (c[0] as { type?: string })?.type === 'MCP_STATE');
    expect(hits.length).toBeGreaterThan(0);
    expect((hits[hits.length - 1]![0] as any).states[0].status).toBe('connected');
    spy.mockRestore();
  });
});
