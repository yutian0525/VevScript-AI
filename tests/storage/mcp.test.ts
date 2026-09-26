// tests/storage/mcp.test.ts
// MCP 配置存储：增删改 + 校验 + 导入导出。重点在导入——浏览器跑不了 stdio，
// 那些条目必须被明确报出来，不能静默吞掉。
import { beforeEach, describe, it, expect } from 'vitest';
import {
  listMcpServers, saveMcpServer, removeMcpServer, setMcpServerEnabled,
  newMcpServer, exportMcpJson, importMcpJson,
} from '../../storage/mcp';

const base = () => newMcpServer({ name: 'demo', url: 'https://mcp.example.com/mcp' });

beforeEach(async () => {
  for (const s of await listMcpServers()) await removeMcpServer(s.id);
});

describe('CRUD', () => {
  it('新增后可读回，且带上创建时间', async () => {
    const saved = await saveMcpServer(base());
    const all = await listMcpServers();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('demo');
    expect(saved.createdAt).toBeTypeOf('number');
  });

  it('同 id 再存 = 更新（不产生第二条）', async () => {
    const first = await saveMcpServer(base());
    await saveMcpServer({ ...first, url: 'https://other.example.com/sse', transport: 'sse' });
    const all = await listMcpServers();
    expect(all).toHaveLength(1);
    expect(all[0]!.url).toBe('https://other.example.com/sse');
    expect(all[0]!.transport).toBe('sse');
  });

  it('删除', async () => {
    const s = await saveMcpServer(base());
    await removeMcpServer(s.id);
    expect(await listMcpServers()).toHaveLength(0);
  });

  it('启停只改 enabled，不动其它字段', async () => {
    const s = await saveMcpServer(base());
    const off = await setMcpServerEnabled(s.id, false);
    expect(off?.enabled).toBe(false);
    expect(off?.url).toBe(s.url);
    expect((await setMcpServerEnabled('nope', true))).toBeUndefined();
  });
});

describe('校验', () => {
  it('空名拒绝', async () => {
    await expect(saveMcpServer(newMcpServer({ name: '  ', url: 'https://a.com' }))).rejects.toThrow(/名称/);
  });

  it('URL 不合法 / 非 http(s) 协议拒绝', async () => {
    await expect(saveMcpServer(newMcpServer({ name: 'a', url: 'not-a-url' }))).rejects.toThrow(/URL/);
    await expect(saveMcpServer(newMcpServer({ name: 'a', url: 'ws://a.com/mcp' }))).rejects.toThrow(/http/);
  });

  it('stdio 式 command 配置无法落地（提示浏览器限制）', async () => {
    await expect(saveMcpServer(newMcpServer({ name: 'a', url: 'file:///usr/bin/mcp' }))).rejects.toThrow(/http/);
  });

  it('重名拒绝（工具前缀 slug 会撞车）', async () => {
    await saveMcpServer(base());
    await expect(saveMcpServer(newMcpServer({ name: 'demo', url: 'https://b.com' }))).rejects.toThrow(/已被其它服务器使用/);
  });

  it('非法头名 / 含换行的头值拒绝', async () => {
    await expect(saveMcpServer(newMcpServer({
      name: 'a', url: 'https://a.com', headers: { 'Bad Header': 'x' },
    }))).rejects.toThrow(/请求头名非法/);
    await expect(saveMcpServer(newMcpServer({
      name: 'a', url: 'https://a.com', headers: { Authorization: 'Bearer x\nX-Evil: 1' },
    }))).rejects.toThrow(/换行/);
  });

  it('合法 Bearer 头放行', async () => {
    const s = await saveMcpServer(newMcpServer({
      name: 'a', url: 'https://a.com', headers: { Authorization: 'Bearer sk-1' },
    }));
    expect(s.headers.Authorization).toBe('Bearer sk-1');
  });
});

describe('导入导出', () => {
  it('导出 → 导入回环，字段不丢', async () => {
    await saveMcpServer(newMcpServer({
      name: 'fs', url: 'https://a.com/mcp', transport: 'streamable', headers: { Authorization: 'Bearer k' },
    }));
    const text = exportMcpJson(await listMcpServers());
    const { servers, warnings } = importMcpJson(text);
    expect(warnings).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.url).toBe('https://a.com/mcp');
    expect(servers[0]!.transport).toBe('streamable');
    expect(servers[0]!.headers.Authorization).toBe('Bearer k');
  });

  it('stdio 条目跳过并给出理由（不静默丢弃）', () => {
    const { servers, warnings } = importMcpJson(JSON.stringify({
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'some-mcp'] },
        remote: { url: 'https://b.com/mcp' },
      },
    }));
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('remote');
    expect(warnings.join()).toContain('stdio');
    expect(warnings.join()).toContain('local');
  });

  it('type=sse 映射为 sse 传输，未知 type 回落 auto 并提示', () => {
    const { servers, warnings } = importMcpJson(JSON.stringify({
      mcpServers: {
        a: { url: 'https://a.com', type: 'sse' },
        b: { url: 'https://b.com', type: 'weird' },
      },
    }));
    expect(servers.find((s) => s.name === 'a')!.transport).toBe('sse');
    expect(servers.find((s) => s.name === 'b')!.transport).toBe('auto');
    expect(warnings.join()).toContain('weird');
  });

  it('坏 JSON / 缺 mcpServers 抛错', () => {
    expect(() => importMcpJson('{oops')).toThrow(/合法 JSON/);
    expect(() => importMcpJson('{"servers":{}}')).toThrow(/mcpServers/);
  });
});
