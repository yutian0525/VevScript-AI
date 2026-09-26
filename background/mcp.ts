// background/mcp.ts
// MCP 连接管理器（后台权威）：配置同步、按需连接、工具清单投影、状态广播。
//
// 连接模型由 MV3 决定：Service Worker 空闲约 30s 就被回收，SSE 长流活不过一次回收，
// 所以这里**不保活**——连接是「用到才建、断了就废、重连即换客户端」。
// 代价是第一次用到要付握手时间；收益是不会有一堆僵尸连接占着外部服务。
import type { MessageRouter } from './router';
import { createMcpClient, type McpClient } from '../agent/mcp/client';
import { setMcpBridge, type McpBridge } from '../agent/mcp/bridge';
import { exposeToolName, isMcpToolName, sanitizeSlug } from '../agent/mcp/naming';
import {
  exportMcpJson, importMcpJson, listMcpServers, removeMcpServer, saveMcpServer, setMcpServerEnabled,
} from '../storage/mcp';
import type {
  McpCallResult, McpServerConfig, McpServerState, McpStatusItem, McpToolDef, McpToolInfo,
} from '../shared/mcp';
import type { ToolSchema } from '../agent/provider/types';
import type { ToolResult } from '../shared/types';

interface Entry {
  config: McpServerConfig;
  /** 工具名前缀段。改名会换 slug → 暴露名全变，必须断线重连。 */
  slug: string;
  client: McpClient | null;
  state: McpServerState;
  tools: McpToolDef[];
  /** exposedName → MCP 原名。反查不靠切字符串（slug 与工具名都能含 `__`）。 */
  exposed: Map<string, string>;
  /** 并发去重：连接中再来请求就搭同一班车的顺风车。 */
  inflight: Promise<void> | null;
}

const entries = new Map<string, Entry>();

/** slug 在全局唯一（同名服务会被 storage 层拒绝，这里防的是净化后撞车，如「A-B」与「A B」）。 */
function slugFor(cfg: McpServerConfig, taken: Set<string>): string {
  const base = sanitizeSlug(cfg.name) || `s${cfg.id}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) { slug = `${base}_${n}`; n += 1; }
  taken.add(slug);
  return slug;
}

function makeState(id: string, cfg: McpServerConfig): McpServerState {
  return { id, status: cfg.enabled ? 'idle' : 'disabled', tools: [] };
}

function projectTools(e: Entry): McpToolInfo[] {
  return e.tools.map((t) => ({
    name: t.name,
    exposedName: exposeToolName(e.slug, t.name),
    ...(t.description ? { description: t.description } : {}),
  }));
}

function dropClient(e: Entry): void {
  e.client?.close();
  e.client = null;
  e.tools = [];
  e.exposed = new Map();
  e.state = { id: e.config.id, status: e.config.enabled ? 'idle' : 'disabled', tools: [] };
}

/** 把 storage 里的配置投影进内存表：新增/改名改址/删除 各自对应建、断、弃。 */
export async function syncFromStorage(): Promise<void> {
  const configs = await listMcpServers();
  const taken = new Set<string>();
  const seen = new Set<string>();
  for (const cfg of configs) {
    seen.add(cfg.id);
    const slug = slugFor(cfg, taken);
    const existing = entries.get(cfg.id);
    if (!existing) {
      entries.set(cfg.id, {
        config: cfg, slug, client: null, state: makeState(cfg.id, cfg), tools: [], exposed: new Map(), inflight: null,
      });
      continue;
    }
    const critical = existing.config.url !== cfg.url
      || existing.config.name !== cfg.name
      || existing.config.transport !== cfg.transport
      || JSON.stringify(existing.config.headers ?? {}) !== JSON.stringify(cfg.headers ?? {});
    existing.config = cfg;
    existing.slug = slug;
    if (!cfg.enabled || critical) dropClient(existing);
    else if (existing.state.status === 'disabled') {
      existing.state = { ...existing.state, status: 'idle', tools: [] };
    }
  }
  for (const id of [...entries.keys()]) {
    if (seen.has(id)) continue;
    entries.get(id)!.client?.close();
    entries.delete(id);
  }
}

function broadcast(): void {
  const states = [...entries.values()].map((e) => e.state);
  void browser.runtime.sendMessage({ type: 'MCP_STATE', states }).catch(() => {});
}

/** 连接一台。幂等：已在连就复用同一 Promise。 */
export async function connectServer(id: string): Promise<McpServerState> {
  const e = entries.get(id);
  if (!e) throw new Error('MCP 服务器不存在');
  if (!e.config.enabled) {
    e.state = { ...e.state, status: 'disabled', tools: [] };
    return e.state;
  }
  if (e.inflight) { await e.inflight; return e.state; }

  e.client?.close();
  e.client = null;
  e.tools = [];
  e.exposed = new Map();
  e.state = { id, status: 'connecting', tools: [] };
  broadcast();

  const run = (async () => {
    try {
      const client = createMcpClient({
        url: e.config.url,
        transport: e.config.transport,
        headers: e.config.headers ?? {},
        ...(e.config.timeoutMs ? { timeoutMs: e.config.timeoutMs } : {}),
      });
      await client.connect();
      const tools = await client.listTools();
      e.client = client;
      e.tools = tools;
      e.exposed = new Map();
      for (const t of tools) e.exposed.set(exposeToolName(e.slug, t.name), t.name);
      e.state = {
        id,
        status: 'connected',
        tools: projectTools(e),
        connectedAt: Date.now(),
        ...(client.protocolVersion ? { protocolVersion: client.protocolVersion } : {}),
        ...(client.serverInfo ? { serverInfo: client.serverInfo } : {}),
      };
    } catch (err) {
      e.client = null;
      e.tools = [];
      e.exposed = new Map();
      e.state = { id, status: 'error', tools: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      e.inflight = null;
      broadcast();
    }
  })();
  e.inflight = run;
  await run;
  return e.state;
}

export function disconnectServer(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  dropClient(e);
  broadcast();
}

/** 连接全部已启用的服务（面板打开状态列表时用：SW 睡醒后一次拉齐）。 */
export async function connectAll(): Promise<void> {
  await syncFromStorage();
  await Promise.all([...entries.values()].filter((e) => e.config.enabled).map((e) => connectServer(e.config.id)));
}

export function statusItems(): McpStatusItem[] {
  return [...entries.values()].map((e) => ({
    ...e.state,
    name: e.config.name,
    url: e.config.url,
    transport: e.config.transport,
    enabled: e.config.enabled,
  }));
}

/** 按需补连接：只有 idle 才自动尝试，error 态等用户显式重连（避免每轮重试打挂外部服务）。 */
async function ensureConnected(e: Entry): Promise<boolean> {
  if (e.client) return true;
  if (e.state.status === 'error') return false;
  await connectServer(e.config.id);
  return !!e.client;
}

function toolSchemasFor(e: Entry): ToolSchema[] {
  return e.tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: exposeToolName(e.slug, t.name),
      description: t.description
        ? `【MCP · ${e.config.name}】${t.description}`
        : `【MCP · ${e.config.name}】${t.name}`,
      parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    },
  }));
}

async function toolSchemas(): Promise<ToolSchema[]> {
  await syncFromStorage();
  const out: ToolSchema[] = [];
  for (const e of entries.values()) {
    if (!e.config.enabled) continue;
    if (!(await ensureConnected(e))) continue;
    out.push(...toolSchemasFor(e));
  }
  return out;
}

/** MCP 内容块 → ToolResult。多块文本换行拼接；非文本块降级成 JSON 原文（不静默丢弃）。 */
function toToolResult(r: McpCallResult): ToolResult {
  const blocks = r.content ?? [];
  const parts = blocks
    .map((b) => (b.type === 'text' ? (b.text ?? '') : JSON.stringify(b)))
    .filter((s) => s !== '');
  const text = parts.join('\n');
  if (r.isError) return { ok: false, error: text || 'MCP 工具返回错误' };
  return { ok: true, data: text };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  if (!isMcpToolName(name)) return null;
  for (const e of entries.values()) {
    const tool = e.exposed.get(name);
    if (!tool) continue;
    if (!(await ensureConnected(e))) {
      return { ok: false, error: `MCP 服务「${e.config.name}」未连接：${e.state.error ?? '请先连接'}` };
    }
    try {
      return toToolResult(await e.client!.callTool(tool, args ?? {}));
    } catch (err) {
      // 多半是连接已死（SW 回收 / 服务端断开）→ 标 error，下次用到会走重连路径
      e.client?.close();
      e.client = null;
      e.tools = [];
      e.exposed = new Map();
      e.state = {
        id: e.config.id,
        status: 'error',
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      };
      broadcast();
      return { ok: false, error: `MCP 工具 ${name} 调用失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return null;
}

/** 测试连接：建临时客户端，连完即关，不落库也不进连接表。 */
export async function testServer(cfg: McpServerConfig): Promise<{
  tools: number; protocolVersion?: string; serverInfo?: { name?: string; version?: string };
}> {
  const client = createMcpClient({
    url: cfg.url,
    transport: cfg.transport,
    headers: cfg.headers ?? {},
    ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    return {
      tools: tools.length,
      ...(client.protocolVersion ? { protocolVersion: client.protocolVersion } : {}),
      ...(client.serverInfo ? { serverInfo: client.serverInfo } : {}),
    };
  } finally {
    client.close();
  }
}

/** 从 router 的通用消息对象里取字段（router 侧是弱类型，这里集中做一次断言）。 */
function pick<T>(msg: { type: string } & Record<string, unknown>): T {
  return msg as unknown as T;
}

export function initMcpModule(router: MessageRouter): void {
  const bridge: McpBridge = { toolSchemas, callTool };
  setMcpBridge(bridge);

  router.on('MCP_LIST', async () => {
    await syncFromStorage();
    return { ok: true, data: statusItems() };
  });

  router.on('MCP_REFRESH', async () => {
    await connectAll();
    return { ok: true, data: statusItems() };
  });

  router.on('MCP_SAVE', async (msg) => {
    const input = pick<{ server: McpServerConfig }>(msg).server;
    const saved = await saveMcpServer(input);
    await syncFromStorage();
    if (saved.enabled) await connectServer(saved.id);
    else broadcast();
    return { ok: true, data: statusItems() };
  });

  router.on('MCP_REMOVE', async (msg) => {
    const id = pick<{ id: string }>(msg).id;
    await removeMcpServer(id);
    await syncFromStorage();
    broadcast();
    return { ok: true, data: statusItems() };
  });

  router.on('MCP_SET_ENABLED', async (msg) => {
    const { id, enabled } = pick<{ id: string; enabled: boolean }>(msg);
    await setMcpServerEnabled(id, enabled);
    await syncFromStorage();
    if (enabled) await connectServer(id);
    else { disconnectServer(id); broadcast(); }
    return { ok: true, data: statusItems() };
  });

  router.on('MCP_CONNECT', async (msg) => {
    const id = pick<{ id: string }>(msg).id;
    const state = await connectServer(id);
    return { ok: state.status === 'connected', data: statusItems(), ...(state.error ? { error: state.error } : {}) };
  });

  router.on('MCP_DISCONNECT', async (msg) => {
    const id = pick<{ id: string }>(msg).id;
    disconnectServer(id);
    return { ok: true, data: statusItems() };
  });

  router.on('MCP_TEST', async (msg) => {
    const cfg = pick<{ server: McpServerConfig }>(msg).server;
    const r = await testServer(cfg);
    return { ok: true, data: r };
  });

  router.on('MCP_IMPORT', async (msg) => {
    const text = pick<{ text: string }>(msg).text;
    const { servers, warnings } = importMcpJson(text);
    const existing = await listMcpServers();
    let imported = 0;
    for (const s of servers) {
      try {
        await saveMcpServer({ ...s, ...(existing.some((x) => x.name === s.name) ? { name: `${s.name}-import` } : {}) });
        imported += 1;
      } catch (e) {
        warnings.push(`「${s.name}」${e instanceof Error ? e.message : String(e)}，已跳过`);
      }
    }
    await syncFromStorage();
    broadcast();
    return { ok: true, data: { imported, warnings, items: statusItems() } };
  });

  router.on('MCP_EXPORT', async () => {
    await syncFromStorage();
    return { ok: true, data: { text: exportMcpJson([...entries.values()].map((e) => e.config)) } };
  });

  // SW 冷启动：把配置投影进内存（不主动连——见文件头注释）
  void syncFromStorage().catch(() => {});
}
