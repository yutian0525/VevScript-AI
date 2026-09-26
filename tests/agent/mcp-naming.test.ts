// tests/agent/mcp-naming.test.ts
// 工具名净化：MCP 服务名/工具名是自由文本（可含空格、点、斜杠、中文），
// 而 OpenAI function name 只接受 ^[a-zA-Z0-9_-]{1,64}$。净化必须可预期且尽可能可还原。
import { describe, it, expect } from 'vitest';
import { MCP_PREFIX, sanitizeSlug, exposeToolName, isMcpToolName } from '../../agent/mcp/naming';

describe('sanitizeSlug', () => {
  it('空白与非法字符 → 下划线', () => {
    expect(sanitizeSlug('My File Server')).toBe('My_File_Server');
    expect(sanitizeSlug('github.com/mcp')).toBe('github_com_mcp');
  });

  it('合法字符原样保留', () => {
    expect(sanitizeSlug('fs-local_2')).toBe('fs-local_2');
  });

  it('首尾下划线削掉（避免 mcp___x__ 这类空段）', () => {
    expect(sanitizeSlug('  本地服务  ')).toBe('');
  });

  it('纯中文名 → 空串，由调用方回落到 id', () => {
    expect(sanitizeSlug('文件系统')).toBe('');
  });
});

describe('exposeToolName', () => {
  it('常规拼接：mcp__<slug>__<tool>', () => {
    expect(exposeToolName('fs', 'read_file')).toBe('mcp__fs__read_file');
  });

  it('工具名里的非法字符一并净化', () => {
    expect(exposeToolName('fs', 'read/file.v2')).toBe('mcp__fs__read_file_v2');
  });

  it('长名截断后总长不超过 64 且带哈希尾巴', () => {
    const long = 'a'.repeat(80);
    const out = exposeToolName('server', long);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.startsWith(`${MCP_PREFIX}server__`)).toBe(true);
    expect(out).toMatch(/_[a-z0-9]{4}$/);
  });

  it('截断对不同长名给出不同结果（哈希防撞）', () => {
    const a = exposeToolName('server', 'x'.repeat(70));
    const b = exposeToolName('server', 'y'.repeat(70));
    expect(a).not.toBe(b);
  });

  it('同一输入稳定（幂等）', () => {
    expect(exposeToolName('server', 'z'.repeat(70))).toBe(exposeToolName('server', 'z'.repeat(70)));
  });

  it('超长 slug 也会被削，总长仍 <= 64', () => {
    const out = exposeToolName('s'.repeat(80), 'some_tool_name');
    expect(out.length).toBeLessThanOrEqual(64);
  });

  it('短名不追加哈希', () => {
    expect(exposeToolName('fs', 'list')).toBe('mcp__fs__list');
  });
});

describe('isMcpToolName', () => {
  it('认 MCP 前缀', () => {
    expect(isMcpToolName('mcp__fs__read_file')).toBe(true);
  });

  it('内置工具不是 MCP 工具', () => {
    expect(isMcpToolName('take_snapshot')).toBe(false);
    expect(isMcpToolName('http_request')).toBe(false);
  });

  it('mcp__ 开头但只有一段的不算（防误吞）', () => {
    expect(isMcpToolName('mcp__')).toBe(false);
  });
});
