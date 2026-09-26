// storage/mcp.ts
// MCP 服务器配置的持久化（单键 local:mcp:servers）。与 storage/skills.ts 同构：
// 纯存储 + 校验 + 导入导出，不碰网络（联网在 agent/mcp/client.ts）。
import { storage } from 'wxt/utils/storage';
import { nanoid } from 'nanoid';
import type { McpServerConfig, McpTransport } from '../shared/mcp';

export const MCP_KEY = 'local:mcp:servers' as const;

export const MAX_MCP_SERVERS = 50;
export const MAX_MCP_NAME = 60;
export const MAX_MCP_HEADERS = 20;

const TRANSPORTS: McpTransport[] = ['auto', 'streamable', 'sse'];
/** HTTP 头名（RFC 7230 token）。头值禁换行——否则能注入整段请求。 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export async function listMcpServers(): Promise<McpServerConfig[]> {
  return (await storage.getItem<McpServerConfig[]>(MCP_KEY)) ?? [];
}

export async function getMcpServer(id: string): Promise<McpServerConfig | undefined> {
  return (await listMcpServers()).find((s) => s.id === id);
}

/** 新配置骨架（id 即 slug 回落来源：中文名净化后会空，工具前缀退到 s<id>）。 */
export function newMcpServer(fields: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: nanoid(10),
    name: '',
    url: '',
    transport: 'auto',
    enabled: true,
    headers: {},
    ...fields,
  };
}

/** 校验（throw 中文文案，供保存与导入共用）。 */
export function validateMcpServer(cfg: McpServerConfig): void {
  if (!cfg.name.trim()) throw new Error('名称不能为空');
  if (cfg.name.trim().length > MAX_MCP_NAME) throw new Error(`名称超过上限（${MAX_MCP_NAME} 字符）`);
  let url: URL;
  try {
    url = new URL(cfg.url.trim());
  } catch {
    throw new Error(`URL 不合法：${cfg.url}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('只支持 http/https 协议的 MCP 服务（浏览器扩展无法启动本地 stdio 进程）');
  }
  if (!TRANSPORTS.includes(cfg.transport)) throw new Error(`传输方式非法：${cfg.transport}`);
  const headers = cfg.headers ?? {};
  const keys = Object.keys(headers);
  if (keys.length > MAX_MCP_HEADERS) throw new Error(`自定义请求头超过上限（${MAX_MCP_HEADERS} 个）`);
  for (const k of keys) {
    if (!HEADER_NAME_RE.test(k)) throw new Error(`请求头名非法：${k}`);
    if (/[\r\n]/.test(headers[k] ?? '')) throw new Error(`请求头「${k}」的值含换行符`);
  }
}

/**
 * upsert。id 为空视为新增；名称重名（除自己）拒绝——重名会让工具前缀 slug 撞车，
 * 撞车后两个服务的工具会互相顶掉。
 */
export async function saveMcpServer(input: McpServerConfig): Promise<McpServerConfig> {
  validateMcpServer(input);
  const all = await listMcpServers();
  const exists = all.some((s) => s.id === input.id);
  if (!exists && all.length >= MAX_MCP_SERVERS) {
    throw new Error(`MCP 服务器数量已达上限（${MAX_MCP_SERVERS} 台），请先删除部分配置`);
  }
  const clash = all.find((s) => s.id !== input.id && s.name.trim() === input.name.trim());
  if (clash) throw new Error(`名称「${input.name.trim()}」已被其它服务器使用`);
  const next: McpServerConfig = {
    ...input,
    url: input.url.trim(),
    createdAt: input.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await storage.setItem(MCP_KEY, exists ? all.map((s) => (s.id === next.id ? next : s)) : [...all, next]);
  return next;
}

export async function removeMcpServer(id: string): Promise<void> {
  const all = await listMcpServers();
  await storage.setItem(MCP_KEY, all.filter((s) => s.id !== id));
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerConfig | undefined> {
  const all = await listMcpServers();
  const target = all.find((s) => s.id === id);
  if (!target) return undefined;
  const next = { ...target, enabled, updatedAt: Date.now() };
  await storage.setItem(MCP_KEY, all.map((s) => (s.id === id ? next : s)));
  return next;
}

/** 导出为 Claude Desktop 同款配置（可直接贴进别的客户端）。 */
export function exportMcpJson(servers: McpServerConfig[]): string {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    out[s.name] = {
      url: s.url,
      ...(s.transport !== 'auto' ? { type: s.transport === 'sse' ? 'sse' : 'http' } : {}),
      ...(Object.keys(s.headers ?? {}).length ? { headers: s.headers } : {}),
    };
  }
  return JSON.stringify({ mcpServers: out }, null, 2);
}

export interface McpImportResult {
  servers: McpServerConfig[];
  /** 逐条归属的警告（跳过的条目、修正过的字段）。不抛错——导入应当尽量多拿。 */
  warnings: string[];
}

/**
 * 导入 Claude Desktop 风格的 `{ mcpServers: { name: {...} } }`。
 * 只吃带 `url` 的条目：stdio（command/args）在浏览器里物理跑不了，静默丢弃会让用户
 * 以为导入成功，必须逐条报出来。
 */
export function importMcpJson(text: string): McpImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法 JSON');
  }
  const root = parsed as { mcpServers?: Record<string, unknown> } | null;
  const table = root && typeof root === 'object' ? (root as Record<string, unknown>).mcpServers : undefined;
  if (!table || typeof table !== 'object') {
    throw new Error('缺少 mcpServers 字段（需为对象）');
  }
  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(table)) {
    if (!raw || typeof raw !== 'object') { warnings.push(`「${name}」不是对象，已跳过`); continue; }
    const e = raw as Record<string, unknown>;
    const url = typeof e.url === 'string' ? e.url.trim() : '';
    if (!url) {
      const why = typeof e.command === 'string' ? 'stdio 传输（command）在浏览器扩展里无法运行' : '缺少 url 字段';
      warnings.push(`「${name}」${why}，已跳过`);
      continue;
    }
    const headers: Record<string, string> = {};
    if (e.headers && typeof e.headers === 'object') {
      for (const [k, v] of Object.entries(e.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    const t = typeof e.type === 'string' ? e.type : typeof e.transport === 'string' ? e.transport : 'auto';
    const transport: McpTransport = t === 'sse' || t === 'http-sse' ? 'sse'
      : t === 'streamable' || t === 'streamable-http' || t === 'http' ? 'streamable'
        : 'auto';
    if (transport === 'auto' && t !== 'auto') {
      warnings.push(`「${name}」的传输方式「${t}」未识别，已按 auto 探测处理`);
    }
    const cfg = newMcpServer({ name, url, transport, headers, enabled: true });
    try {
      validateMcpServer(cfg);
    } catch (err) {
      warnings.push(`「${name}」${err instanceof Error ? err.message : String(err)}，已跳过`);
      continue;
    }
    servers.push(cfg);
  }
  return { servers, warnings };
}
