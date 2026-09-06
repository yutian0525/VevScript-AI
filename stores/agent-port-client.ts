// stores/agent-port-client.ts
// 面板 ↔ 后台的 agent 端口客户端（模块级单例）。
//
// 为什么是模块级而不是 ChatView 内的 ref：ChatView 会在切视图时卸载，
// 端口若随组件生命周期就会断开，运行中任务的流式事件全部落空。
// 模块级端口活到面板文档销毁为止（切标签导致面板重建时由 attach 补齐尾巴）。
import type { AgentEvent, PortMsgFromPanel, PortMsgToPanel } from '../shared/messages';
import { useChat } from './chat';

let port: Browser.runtime.Port | null = null;

/** 当前会话 id 的读取器：由 conversations store 注入，避免 store 间循环依赖。 */
let currentConvId: () => string | null = () => null;

export function bindCurrentConvGetter(fn: () => string | null): void {
  currentConvId = fn;
}

function connect(): Browser.runtime.Port {
  if (port) return port;
  const p = browser.runtime.connect({ name: 'agent' });
  p.onMessage.addListener((raw) => {
    const { convId, ...event } = raw as PortMsgToPanel;
    // 非当前会话的事件直接丢弃：多会话并行时不串台（storage 仍是各会话历史的权威源）
    if (convId !== currentConvId()) return;
    useChat.getState().applyEvent(event as AgentEvent);
  });
  p.onDisconnect.addListener(() => {
    void browser.runtime.lastError;
    port = null;
  });
  port = p;
  return p;
}

/** 发消息给后台。返回 false 表示端口不可用（调用方负责回退 UI 状态）。 */
export function postToAgent(msg: PortMsgFromPanel): boolean {
  try {
    connect().postMessage(msg);
    return true;
  } catch {
    port = null;
    return false;
  }
}

/** 附着到某会话：后台回权威运行态（顺带修正残留 running）+ 补发未落库的流式尾巴。 */
export function attachConv(convId: string): boolean {
  return postToAgent({ type: 'agent:attach', convId });
}
