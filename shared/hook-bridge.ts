// shared/hook-bridge.ts
// MAIN world hook ↔ ISOLATED content.ts 的 window 桥协议 + 三方共享数据形状（设计 §7.1）。
// 注意：这是同页 window.postMessage 协议，不是 cs→bg runtime 通知（那在 shared/messages.ts）。

/** MAIN→ISOLATED：一条 console/network 观测消息的 tag。 */
export const HOOK_MSG = '__ai_ext_hook__';
/** ISOLATED→MAIN：中继监听已就绪，请 flush backlog 的 tag。 */
export const RELAY_READY = '__ai_ext_relay_ready__';

import type { ConsoleEntry } from './observe';
export type { ConsoleEntry } from './observe';

/** 一条 hook 捕获的网络观测（fetch/XHR）。 */
export interface HookNetEntry {
  loadNonce: string;       // 每次页面加载随机重置（配合 seq 组成 SW 去重键 + 独立条目 id）
  seq: number;             // 页面内单调序号
  method: string;
  url: string;
  ts: number;              // 发起时间
  endTs?: number;          // 完成时间
  status?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;    // 已长度截断（未脱敏）
  responseBody?: string;   // 已长度截断（未脱敏）
  truncated?: boolean;
}

/** MAIN→ISOLATED 的 window 消息信封。 */
export type HookWindowMsg =
  | { source: typeof HOOK_MSG; kind: 'console'; entry: ConsoleEntry }
  | { source: typeof HOOK_MSG; kind: 'network'; entry: HookNetEntry };
