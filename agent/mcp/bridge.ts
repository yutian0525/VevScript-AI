// agent/mcp/bridge.ts
// agent 层 ↔ 后台连接管理器的唯一接口。
// 存在理由：registry（agent 层）要用 MCP 工具，而连接状态归 background 管；
// 若让 registry 直接 import background 就形成反向依赖（background → agent → background）。
// 后台在 initMcpModule 里 setMcpBridge 注入，未注入时一切安全降级为「没有 MCP 工具」。
import type { ToolSchema } from '../provider/types';
import type { ToolResult } from '../../shared/types';

/** 调用上下文（只取 registry 侧确有的字段，避免与 ToolCtx 互相 import）。 */
export interface McpCallCtx {
  signal?: AbortSignal;
}

export interface McpBridge {
  /** 当前可下发模型的 MCP 工具 schema（只含已启用且已连上的服务）。 */
  toolSchemas(): Promise<ToolSchema[]>;
  /** 按暴露名调用。未托管该名字时返回 null——交回 registry 走它自己的「未知工具」分支。 */
  callTool(name: string, args: Record<string, unknown>, ctx?: McpCallCtx): Promise<ToolResult | null>;
}

let bridge: McpBridge | null = null;

export function setMcpBridge(next: McpBridge | null): void {
  bridge = next;
}

export function getMcpBridge(): McpBridge | null {
  return bridge;
}
