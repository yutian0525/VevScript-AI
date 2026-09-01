// background/debug-exec.ts
// 调试台通道：绕过 LLM 直接执行单个工具，走与 agent loop 相同的 executeTool 链路（受限页预检、
// 主帧定向、动态注入兜底、navigate 后等待 CS_READY 全部复用），只是不经模型。
import type { DebugExecRequest, DebugExecResponse } from '../shared/messages';
import { executeTool } from '../agent/tools/registry';
import { waitForCsReady } from './agent-port';

export async function handleDebugExec(msg: DebugExecRequest): Promise<DebugExecResponse> {
  const t0 = Date.now();
  const controller = new AbortController();
  try {
    const result = await executeTool(msg.name, msg.args ?? {}, {
      tabId: msg.tabId,
      sessionId: 'debug',
      signal: controller.signal,
      waitForReady: (t) => waitForCsReady(t),
    });
    return { dispatched: true, result, ms: Date.now() - t0 };
  } catch (err) {
    // executeTool 通常自吞错误返回 ToolResult；此处兜住极端抛出，保证始终回带 ms
    return { dispatched: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}
